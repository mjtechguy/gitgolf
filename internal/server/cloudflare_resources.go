package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/cloudflare"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

func cfResourceIntent(m *golfv1.ProvisionCloudflareEnvironmentResourcesRequest) []byte {
	copy := proto.Clone(m).(*golfv1.ProvisionCloudflareEnvironmentResourcesRequest)
	copy.PasswordConfirmation = ""
	raw, _ := proto.MarshalOptions{Deterministic: true}.Marshal(copy)
	h := sha256.Sum256(raw)
	return h[:]
}

func cfResourceName(id string) string { return "golf-env-" + strings.ReplaceAll(id, "-", "") }

type cfResourceRecord struct {
	wire *golfv1.CloudflareEnvironmentResources
	user int64
	hash []byte
}

func (s *Server) cfResourceOwner(ctx context.Context, id string) (*codexRuntime, error) {
	conn, e := s.db.Conn(ctx)
	if e != nil {
		return nil, errStorageUnavailable
	}
	lock := codexLockID("golf-cloudflare-resource/" + s.config.GiteaURL + "/" + id)
	var owns bool
	if e = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, lock).Scan(&owns); e != nil {
		// Cancellation can lose the acknowledgement after acquiring the lock.
		// Unlock or discard the session before returning it to the pool.
		releaseCodexOwner(conn, lock)
		return nil, errEnvironmentCAS
	}
	if !owns {
		conn.Close()
		return nil, errEnvironmentCAS
	}
	// Only the existing database ownership fence is used; no account broker,
	// native harness process or provider login is attached to this owner.
	return &codexRuntime{conn: conn, ownerID: lock}, nil
}

func (s *Server) cfResourceView(ctx context.Context, value string, token forgeCredential, target *golfv1.RepositoryEnvironmentTarget) error {
	if e := s.requireInstanceAdmin(ctx, value, token); e != nil {
		return e
	}
	key, _, _, e := environmentTarget(target)
	if e != nil {
		return e
	}
	caller, e := s.currentUser(ctx, token)
	if e == nil {
		e = s.environmentAuthority(ctx, token, key, caller, target, true, false)
	}
	if e == nil {
		e = s.requireInstanceAdmin(ctx, value, token)
	}
	return e
}

func (s *Server) cfResourceRecord(ctx context.Context, id string, user int64) (*cfResourceRecord, error) {
	if !deploymentUUID(id) {
		return nil, invalid("Provide the original Cloudflare resource operation UUID.")
	}
	var raw, hash []byte
	var state, envID, profileID string
	var repo, owner, native, envVersion, profileVersion int64
	var created, updated time.Time
	e := s.db.QueryRowContext(ctx, `SELECT receipt,input_hash,state,repository_id,owner_id,native_actor_id,environment_id::text,environment_version,connection_id::text,connection_version,created_at,updated_at FROM golf_cloudflare_resource_operations WHERE id=$1 AND forge_url=$2 AND user_id=$3`, id, s.config.GiteaURL, user).Scan(&raw, &hash, &state, &repo, &owner, &native, &envID, &envVersion, &profileID, &profileVersion, &created, &updated)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, errResourceNotFound
	}
	if e != nil {
		return nil, errStorageUnavailable
	}
	v := new(golfv1.CloudflareEnvironmentResources)
	if proto.Unmarshal(raw, v) != nil || v.Target == nil || v.OperationId != id || v.State != state || v.EnvironmentId != envID || v.EnvironmentVersion != strconv.FormatInt(envVersion, 10) || v.ConnectionId != profileID || v.ConnectionVersion != strconv.FormatInt(profileVersion, 10) || v.ActorId != strconv.FormatInt(native, 10) || v.Target.RepositoryId != strconv.FormatInt(repo, 10) || v.Target.OwnerId != strconv.FormatInt(owner, 10) || v.D1Name != cfResourceName(id) || v.R2Bucket != cfResourceName(id) {
		return nil, errStorageUnavailable
	}
	profile, e := s.loadInfrastructureConnection(ctx, profileID, profileVersion)
	if e != nil || profile.Config.Kind != "CLOUDFLARE" || v.AccountId != profile.Config.CloudflareAccountID {
		return nil, errStorageUnavailable
	}
	original := &golfv1.ProvisionCloudflareEnvironmentResourcesRequest{Target: v.Target, EnvironmentId: envID, EnvironmentVersion: v.EnvironmentVersion, ConnectionId: profileID, ConnectionVersion: v.ConnectionVersion, OperationId: id}
	if _, _, _, e = environmentTarget(v.Target); e != nil || !bytes.Equal(hash, cfResourceIntent(original)) {
		return nil, errStorageUnavailable
	}
	v.CreatedAt, v.UpdatedAt = created.UTC().Format(time.RFC3339Nano), updated.UTC().Format(time.RFC3339Nano)
	// RPCs have a 15-second deadline. A process death cannot leave an old
	// dispatch looking active forever; it stays unknown and is never replayed.
	if (state == "PREFLIGHT" || state == "PROVISIONING") && time.Since(updated) > 90*time.Second {
		v.State, v.Reason = "UNKNOWN", "dispatch_owner_expired_no_automatic_retry"
		if e := s.saveCFResource(ctx, v, state); e != nil {
			return nil, e
		}
	}
	return &cfResourceRecord{wire: v, user: user, hash: hash}, nil
}

func (s *Server) cfResourceClient(ctx context.Context, v *golfv1.CloudflareEnvironmentResources) (*cloudflare.ResourceClient, error) {
	version, e := discussionID(v.ConnectionVersion)
	if e != nil {
		return nil, errStorageUnavailable
	}
	profile, e := s.loadInfrastructureConnection(ctx, v.ConnectionId, version)
	if e != nil || profile.Config.Kind != "CLOUDFLARE" || profile.Config.CloudflareAccountID != v.AccountId {
		return nil, errStorageUnavailable
	}
	plain, e := s.keyring.open(profile.CredentialKeyID, infrastructureConnectionDomain, profile.EncryptedCredential, profile.CredentialBinding)
	if e != nil {
		return nil, e
	}
	var secret infrastructureConnectionSecret
	if json.Unmarshal([]byte(plain), &secret) != nil {
		return nil, errCredentialUnavailable
	}
	return cloudflare.NewResourceClient(v.AccountId, secret.CloudflareAPIToken)
}

// Persist a dispatch/acknowledgement and its append-only event atomically. A
// failed journal write stops all subsequent provider effects.
func (s *Server) saveCFResource(ctx context.Context, v *golfv1.CloudflareEnvironmentResources, previous string) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	var state string
	var previousRaw []byte
	if e = tx.QueryRowContext(ctx, `SELECT state,receipt FROM golf_cloudflare_resource_operations WHERE id=$1 AND forge_url=$2 FOR UPDATE`, v.OperationId, s.config.GiteaURL).Scan(&state, &previousRaw); e != nil {
		return errStorageUnavailable
	}
	if state != previous {
		return errEnvironmentCAS
	}
	old := new(golfv1.CloudflareEnvironmentResources)
	if proto.Unmarshal(previousRaw, old) != nil || old.D1Id != "" && old.D1Id != v.D1Id || old.R2CreatedAt != "" && old.R2CreatedAt != v.R2CreatedAt {
		return errStorageUnavailable
	}
	now := time.Now().UTC()
	v.UpdatedAt = now.Format(time.RFC3339Nano)
	raw, e := proto.Marshal(v)
	if e != nil {
		return errStorageUnavailable
	}
	if _, e = tx.ExecContext(ctx, `UPDATE golf_cloudflare_resource_operations SET state=$2,receipt=$3,updated_at=$4 WHERE id=$1`, v.OperationId, v.State, raw, now); e != nil {
		return errStorageUnavailable
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_cloudflare_resource_events(operation_id,state,receipt) VALUES($1,$2,$3)`, v.OperationId, v.State, raw); e != nil || tx.Commit() != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) cfResourceCurrent(ctx context.Context, value string, token forgeCredential, initial database.GetAdminPasswordConfirmationRow, v *golfv1.CloudflareEnvironmentResources) error {
	if e := s.requireInstanceAdmin(ctx, value, token); e != nil {
		return e
	}
	caller, e := s.currentUser(ctx, token)
	key, repo, owner, targetErr := environmentTarget(v.Target)
	if e != nil || targetErr != nil {
		return errUnauthenticated
	}
	return s.infrastructureAdminTransaction(ctx, value, initial, func(tx *sql.Tx) error {
		if e := s.environmentAuthority(ctx, token, key, caller, v.Target, true, true); e != nil {
			return e
		}
		var profileVersion, environmentVersion int64
		var deleted bool
		if e := tx.QueryRowContext(ctx, `SELECT current_version FROM golf_infrastructure_connections WHERE id=$1 FOR SHARE`, v.ConnectionId).Scan(&profileVersion); e != nil {
			return errStorageUnavailable
		}
		if e := tx.QueryRowContext(ctx, `SELECT current_version,deleted FROM golf_repository_environments WHERE forge_url=$1 AND id=$2 AND repository_id=$3 AND owner_id=$4 FOR SHARE`, s.config.GiteaURL, v.EnvironmentId, repo, owner).Scan(&environmentVersion, &deleted); e != nil {
			return errResourceNotFound
		}
		if deleted || v.ConnectionVersion != strconv.FormatInt(profileVersion, 10) || v.EnvironmentVersion != strconv.FormatInt(environmentVersion, 10) {
			return errEnvironmentCAS
		}
		return s.environmentAuthority(ctx, token, key, caller, v.Target, true, true)
	})
}

func (s *Server) ProvisionCloudflareEnvironmentResources(ctx context.Context, r *connect.Request[golfv1.ProvisionCloudflareEnvironmentResourcesRequest]) (*connect.Response[golfv1.ProvisionCloudflareEnvironmentResourcesResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(r.Header())
	initial, e := s.confirmInfrastructureAdmin(ctx, value, token, r.Msg.PasswordConfirmation)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	key, repo, owner, e := environmentTarget(r.Msg.Target)
	if e != nil || len(r.Msg.ProtoReflect().GetUnknown()) != 0 || !deploymentUUID(r.Msg.EnvironmentId) || !deploymentUUID(r.Msg.OperationId) || !creationKey.MatchString(r.Msg.ConnectionId) {
		return nil, environmentRPCError(invalid("Provide the reviewed repository, environment, connection and original operation identities."))
	}
	envVersion, e := discussionID(r.Msg.EnvironmentVersion)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	profileVersion, e := discussionID(r.Msg.ConnectionVersion)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	caller, e := s.currentUser(ctx, token)
	if e == nil {
		e = s.environmentAuthority(ctx, token, key, caller, r.Msg.Target, true, true)
	}
	if e != nil {
		return nil, environmentRPCError(e)
	}
	hash := cfResourceIntent(r.Msg)
	execution, e := s.cfResourceOwner(ctx, r.Msg.OperationId)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	defer releaseCodexOwner(execution.conn, execution.ownerID)
	finish := func(v *golfv1.CloudflareEnvironmentResources) (*connect.Response[golfv1.ProvisionCloudflareEnvironmentResourcesResponse], error) {
		original, e := s.cfResourceRecord(ctx, v.OperationId, initial.UserID)
		if e == nil {
			e = s.cfResourceView(ctx, value, token, original.wire.Target)
		}
		if e != nil {
			return nil, environmentRPCError(e)
		}
		return connect.NewResponse(&golfv1.ProvisionCloudflareEnvironmentResourcesResponse{Resources: original.wire}), nil
	}
	if original, e := s.cfResourceRecord(ctx, r.Msg.OperationId, initial.UserID); e == nil {
		if !bytes.Equal(original.hash, hash) {
			return nil, environmentRPCError(errEnvironmentIntent)
		}
		return finish(original.wire)
	} else if !errors.Is(e, errResourceNotFound) {
		return nil, environmentRPCError(e)
	}
	profile, e := s.loadInfrastructureConnection(ctx, r.Msg.ConnectionId, profileVersion)
	if e != nil || profile.Config.Kind != "CLOUDFLARE" {
		return nil, environmentRPCError(invalid("Select a saved Cloudflare management connection."))
	}
	env, e := database.New(s.db).GetRepositoryEnvironment(ctx, database.GetRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(r.Msg.EnvironmentId), RepositoryID: repo, OwnerID: owner})
	if e != nil || env.Deleted || env.Version != envVersion {
		return nil, environmentRPCError(errEnvironmentCAS)
	}
	if _, e = wireEnvironment(env); e != nil {
		return nil, environmentRPCError(e)
	}
	v := &golfv1.CloudflareEnvironmentResources{OperationId: r.Msg.OperationId, Target: proto.Clone(r.Msg.Target).(*golfv1.RepositoryEnvironmentTarget), EnvironmentId: r.Msg.EnvironmentId, EnvironmentVersion: r.Msg.EnvironmentVersion, ConnectionId: r.Msg.ConnectionId, ConnectionVersion: r.Msg.ConnectionVersion, AccountId: profile.Config.CloudflareAccountID, ActorId: strconv.FormatInt(caller.ID, 10), State: "PREFLIGHT", D1Name: cfResourceName(r.Msg.OperationId), D1State: "PLANNED", R2Bucket: cfResourceName(r.Msg.OperationId), R2State: "PLANNED"}
	if e = s.cfResourceCurrent(ctx, value, token, initial, v); e != nil {
		return nil, environmentRPCError(e)
	}
	e = s.infrastructureAdminTransaction(ctx, value, initial, func(tx *sql.Tx) error {
		// Reuse the environment/lifecycle fence rather than a new scheduler.
		if _, e := tx.ExecContext(ctx, `SELECT golf_repository_environment_lock($1,$2)`, s.config.GiteaURL, repo); e != nil {
			return errStorageUnavailable
		}
		var currentEnv, currentProfile int64
		var deleted bool
		if e := tx.QueryRowContext(ctx, `SELECT current_version,deleted FROM golf_repository_environments WHERE forge_url=$1 AND id=$2`, s.config.GiteaURL, v.EnvironmentId).Scan(&currentEnv, &deleted); e != nil {
			return errStorageUnavailable
		}
		if e := tx.QueryRowContext(ctx, `SELECT current_version FROM golf_infrastructure_connections WHERE id=$1 FOR SHARE`, v.ConnectionId).Scan(&currentProfile); e != nil {
			return errStorageUnavailable
		}
		if deleted || currentEnv != envVersion || currentProfile != profileVersion {
			return errEnvironmentCAS
		}
		// ponytail: ten operator resource pairs per workspace; replace with
		// approved workspace allocations before enabling ordinary-user SaaS.
		if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1||'/cloudflare-resources/'||$2::bigint::text,0))`, s.config.GiteaURL, owner); e != nil {
			return errStorageUnavailable
		}
		var count, historical int
		if e := tx.QueryRowContext(ctx, `SELECT count(*) FILTER(WHERE state NOT IN ('REMOVED','REFUSED')),count(*) FROM golf_cloudflare_resource_operations WHERE forge_url=$1 AND owner_id=$2`, s.config.GiteaURL, owner).Scan(&count, &historical); e != nil {
			return errStorageUnavailable
		}
		if count >= 10 {
			return invalid("Remove an existing workspace resource allocation before creating another pair.")
		}
		if historical >= 1000 {
			return invalid("The workspace resource operation history limit has been reached.")
		}
		if e := s.environmentAuthority(ctx, token, key, caller, v.Target, true, true); e != nil {
			return e
		}
		raw, _ := proto.Marshal(v)
		if _, e := tx.ExecContext(ctx, `INSERT INTO golf_cloudflare_resource_operations(id,forge_url,user_id,native_actor_id,repository_id,owner_id,environment_id,environment_version,connection_id,connection_version,input_hash,receipt,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, v.OperationId, s.config.GiteaURL, initial.UserID, caller.ID, repo, owner, v.EnvironmentId, envVersion, v.ConnectionId, profileVersion, hash, raw, v.State); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, `INSERT INTO golf_cloudflare_resource_events(operation_id,state,receipt) VALUES($1,$2,$3)`, v.OperationId, v.State, raw)
		return e
	})
	if e != nil {
		return nil, environmentRPCError(e)
	}
	client, e := s.cfResourceClient(ctx, v)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	defer client.Close()
	// No automatic redispatch: only the request that admitted this operation
	// can reach this code. Failure before dispatch is distinguishable from an
	// unknown create response; unknown IDs are never adopted by name.
	refuse := func(reason string, uncertain bool) error {
		previous := v.State
		v.State, v.Reason = "REFUSED", reason
		if uncertain {
			v.State = "UNKNOWN"
		}
		write, stop := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer stop()
		return s.saveCFResource(write, v, previous)
	}
	fail := func(reason string, uncertain bool) (*connect.Response[golfv1.ProvisionCloudflareEnvironmentResourcesResponse], error) {
		if e := refuse(reason, uncertain); e != nil {
			return nil, environmentRPCError(e)
		}
		return finish(v)
	}
	absent, e := client.D1NameAbsent(ctx, v.D1Name)
	if e != nil || !absent {
		return fail("d1_preflight_unavailable_or_collision", false)
	}
	if _, e = client.GetR2(ctx, v.R2Bucket); !errors.Is(e, cloudflare.ErrNotFound) {
		return fail("r2_preflight_unavailable_or_collision", false)
	}
	if e = s.cfResourceCurrent(ctx, value, token, initial, v); e != nil {
		_ = refuse("authority_changed_before_dispatch", false)
		return nil, environmentRPCError(e)
	}
	v.State, v.D1State = "PROVISIONING", "DISPATCHING"
	if e = s.saveCFResource(ctx, v, "PREFLIGHT"); e != nil {
		return nil, environmentRPCError(e)
	}
	if !codexOwnerAlive(ctx, execution) {
		v.D1State = "PLANNED"
		return fail("dispatch_owner_lost", false)
	}
	if e = s.cfResourceCurrent(ctx, value, token, initial, v); e != nil {
		v.D1State = "PLANNED"
		_ = refuse("authority_changed_before_d1_dispatch", false)
		return nil, environmentRPCError(e)
	}
	if !codexOwnerAlive(ctx, execution) {
		v.D1State = "PLANNED"
		return fail("dispatch_owner_lost", false)
	}
	d1, e := client.CreateD1(ctx, v.D1Name)
	if e != nil {
		return fail("d1_create_outcome_unknown", true)
	}
	v.D1Id, v.D1State = d1.ID, "CREATED"
	if e = s.saveCFResource(ctx, v, "PROVISIONING"); e != nil {
		return nil, environmentRPCError(e)
	}
	if e = s.cfResourceCurrent(ctx, value, token, initial, v); e != nil {
		_ = refuse("authority_changed_after_d1_create", true)
		return nil, environmentRPCError(e)
	}
	v.R2State = "DISPATCHING"
	if e = s.saveCFResource(ctx, v, "PROVISIONING"); e != nil {
		return nil, environmentRPCError(e)
	}
	if !codexOwnerAlive(ctx, execution) {
		v.R2State = "PLANNED"
		return fail("dispatch_owner_lost", true)
	}
	if e = s.cfResourceCurrent(ctx, value, token, initial, v); e != nil {
		v.R2State = "PLANNED"
		_ = refuse("authority_changed_before_r2_dispatch", true)
		return nil, environmentRPCError(e)
	}
	if !codexOwnerAlive(ctx, execution) {
		v.R2State = "PLANNED"
		return fail("dispatch_owner_lost", true)
	}
	r2, e := client.CreateR2(ctx, v.R2Bucket)
	if e != nil {
		return fail("r2_create_outcome_unknown", true)
	}
	v.R2State, v.R2CreatedAt = "CREATED", r2.CreatedAt
	if e = s.saveCFResource(ctx, v, "PROVISIONING"); e != nil {
		return nil, environmentRPCError(e)
	}
	d1, e = client.GetD1(ctx, v.D1Id)
	r2, r2Err := client.GetR2(ctx, v.R2Bucket)
	if e != nil || d1.Name != v.D1Name || r2Err != nil || r2.CreatedAt != v.R2CreatedAt {
		return fail("created_resources_readback_unavailable", true)
	}
	if private, err := client.R2Private(ctx, v.R2Bucket); err != nil || !private {
		return fail("r2_private_serving_unverified", true)
	}
	if e = s.cfResourceCurrent(ctx, value, token, initial, v); e != nil {
		_ = refuse("authority_changed_after_resource_creation", true)
		return nil, environmentRPCError(e)
	}
	v.State = "READY"
	if e = s.saveCFResource(ctx, v, "PROVISIONING"); e != nil {
		return nil, environmentRPCError(e)
	}
	return finish(v)
}

func (s *Server) GetCloudflareEnvironmentResources(ctx context.Context, r *connect.Request[golfv1.GetCloudflareEnvironmentResourcesRequest]) (*connect.Response[golfv1.GetCloudflareEnvironmentResourcesResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(r.Header())
	if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
		return nil, e
	}
	initial, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	row, e := s.cfResourceRecord(ctx, r.Msg.OperationId, initial.UserID)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	e = s.cfResourceView(ctx, value, token, row.wire.Target)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetCloudflareEnvironmentResourcesResponse{Resources: row.wire}), nil
}

func (s *Server) ListCloudflareEnvironmentResources(ctx context.Context, r *connect.Request[golfv1.ListCloudflareEnvironmentResourcesRequest]) (*connect.Response[golfv1.ListCloudflareEnvironmentResourcesResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(r.Header())
	if e = s.cfResourceView(ctx, value, token, r.Msg.Target); e != nil {
		return nil, environmentRPCError(e)
	}
	_, repo, owner, e := environmentTarget(r.Msg.Target)
	if e != nil || !deploymentUUID(r.Msg.EnvironmentId) {
		return nil, environmentRPCError(invalid("Provide the original environment and repository identities."))
	}
	initial, e := s.ownSecuritySnapshot(ctx, value, token)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	page, limit, e := pagination(pageFrom(r.Msg.Page))
	if e != nil || limit > 20 {
		return nil, environmentRPCError(invalid("Use a resource inventory page size of at most 20."))
	}
	rows, e := s.db.QueryContext(ctx, `SELECT id::text FROM golf_cloudflare_resource_operations WHERE forge_url=$1 AND user_id=$2 AND repository_id=$3 AND owner_id=$4 AND environment_id=$5 ORDER BY created_at DESC,id LIMIT $6 OFFSET $7`, s.config.GiteaURL, initial.UserID, repo, owner, r.Msg.EnvironmentId, limit+1, (page-1)*limit)
	if e != nil {
		return nil, environmentRPCError(errStorageUnavailable)
	}
	var ids []string
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, environmentRPCError(errStorageUnavailable)
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, environmentRPCError(errStorageUnavailable)
	}
	out := &golfv1.ListCloudflareEnvironmentResourcesResponse{Page: &golfv1.PageResponse{}}
	if len(ids) > int(limit) {
		out.Page.NextPage, ids = page+1, ids[:int(limit)]
	}
	for _, id := range ids {
		row, e := s.cfResourceRecord(ctx, id, initial.UserID)
		if e != nil {
			return nil, environmentRPCError(e)
		}
		out.Resources = append(out.Resources, row.wire)
	}
	if e = s.cfResourceView(ctx, value, token, r.Msg.Target); e != nil {
		return nil, environmentRPCError(e)
	}
	return connect.NewResponse(out), nil
}

func (s *Server) RemoveCloudflareEnvironmentResources(ctx context.Context, r *connect.Request[golfv1.RemoveCloudflareEnvironmentResourcesRequest]) (*connect.Response[golfv1.RemoveCloudflareEnvironmentResourcesResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	value := s.cookieValue(r.Header())
	initial, e := s.confirmInfrastructureAdmin(ctx, value, token, r.Msg.PasswordConfirmation)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	execution, e := s.cfResourceOwner(ctx, r.Msg.OperationId)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	defer releaseCodexOwner(execution.conn, execution.ownerID)
	row, e := s.cfResourceRecord(ctx, r.Msg.OperationId, initial.UserID)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	v := row.wire
	if v.State == "REMOVED" || v.State == "REFUSED" {
		return connect.NewResponse(&golfv1.RemoveCloudflareEnvironmentResourcesResponse{Resources: v}), nil
	}
	if v.State != "READY" && v.State != "UNKNOWN" && v.State != "REMOVING" {
		return nil, environmentRPCError(invalid("Inspect the original operation; provisioning may still be in progress."))
	}
	// Cleanup is confined to this operator's acknowledged provider identities,
	// including after repository deletion or policy revocation. It cannot adopt
	// a bucket/database, switch accounts, or reveal application contents.
	client, e := s.cfResourceClient(ctx, v)
	if e != nil {
		return nil, environmentRPCError(e)
	}
	defer client.Close()
	previous := v.State
	v.State = "REMOVING"
	if e = s.saveCFResource(ctx, v, previous); e != nil {
		return nil, environmentRPCError(e)
	}
	for _, kind := range []string{"r2", "d1"} {
		if kind == "r2" && (v.R2State == "PLANNED" || v.R2State == "REMOVED") || kind == "d1" && (v.D1State == "PLANNED" || v.D1State == "REMOVED") {
			continue
		}
		if kind == "r2" && v.R2State == "DISPATCHING" || kind == "d1" && v.D1Id == "" {
			v.Reason = "unknown_creation_identity_requires_operator_inspection"
			continue
		}
		if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
			return nil, e
		}
		if e = s.infrastructureAdminTransaction(ctx, value, initial, func(*sql.Tx) error { return nil }); e != nil {
			return nil, environmentRPCError(e)
		}
		if kind == "r2" {
			var found cloudflare.R2Bucket
			found, e = client.GetR2(ctx, v.R2Bucket)
			if e == nil && (v.R2CreatedAt == "" || found.CreatedAt != v.R2CreatedAt) {
				e = cloudflare.ErrResponse
			}
		} else {
			var found cloudflare.D1Database
			found, e = client.GetD1(ctx, v.D1Id)
			if e == nil && found.Name != v.D1Name {
				e = cloudflare.ErrResponse
			}
		}
		if e == nil {
			// Recheck after the provider read, before its mutation. A revoked
			// session or lost database owner cannot authorize another DELETE.
			if !codexOwnerAlive(ctx, execution) {
				return nil, environmentRPCError(errEnvironmentCAS)
			}
			if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
				return nil, e
			}
			if e = s.infrastructureAdminTransaction(ctx, value, initial, func(*sql.Tx) error { return nil }); e != nil {
				return nil, environmentRPCError(e)
			}
			if !codexOwnerAlive(ctx, execution) {
				return nil, environmentRPCError(errEnvironmentCAS)
			}
			if kind == "r2" {
				e = client.DeleteR2(ctx, v.R2Bucket)
			} else {
				e = client.DeleteD1(ctx, v.D1Id)
			}
			// Within this request, an uncertain DELETE is resolved only by
			// exact absence. An explicit later removal must recheck ownership.
			if kind == "r2" {
				_, e = client.GetR2(ctx, v.R2Bucket)
			} else {
				_, e = client.GetD1(ctx, v.D1Id)
			}
		}
		if !errors.Is(e, cloudflare.ErrNotFound) {
			v.Reason = "owned_resource_removal_unconfirmed"
			continue
		}
		if kind == "r2" {
			v.R2State = "REMOVED"
		} else {
			v.D1State = "REMOVED"
		}
		if e = s.saveCFResource(ctx, v, "REMOVING"); e != nil {
			return nil, environmentRPCError(e)
		}
	}
	if (v.R2State == "REMOVED" || v.R2State == "PLANNED") && (v.D1State == "REMOVED" || v.D1State == "PLANNED") {
		v.State, v.Reason = "REMOVED", ""
	}
	if e = s.saveCFResource(ctx, v, "REMOVING"); e != nil {
		return nil, environmentRPCError(e)
	}
	if e = s.requireInstanceAdmin(ctx, value, token); e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.RemoveCloudflareEnvironmentResourcesResponse{Resources: v}), nil
}
