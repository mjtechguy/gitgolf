package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"sort"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

type deploymentReview struct {
	user, native     int64
	session          []byte
	approved         bool
	expires, created time.Time
}

func (s *Server) deploymentReviews(ctx context.Context, id string) ([]deploymentReview, error) {
	rows, e := s.db.QueryContext(ctx, `SELECT user_id,native_actor_id,session_hash,approved,expires_at,created_at FROM (SELECT DISTINCT ON(native_actor_id) user_id,native_actor_id,session_hash,approved,expires_at,created_at,sequence FROM golf_deployment_reviews WHERE deployment_id=$1 ORDER BY native_actor_id,sequence DESC) r ORDER BY native_actor_id LIMIT 7`, id)
	if e != nil {
		return nil, errStorageUnavailable
	}
	defer rows.Close()
	var out []deploymentReview
	for rows.Next() {
		var v deploymentReview
		if rows.Scan(&v.user, &v.native, &v.session, &v.approved, &v.expires, &v.created) != nil {
			return nil, errStorageUnavailable
		}
		out = append(out, v)
	}
	if rows.Err() != nil || len(out) > 6 {
		return nil, errStorageUnavailable
	}
	return out, nil
}
func deploymentReviewer(d *golfv1.RepositoryDeployment, id int64) bool {
	if strconv.FormatInt(id, 10) == d.ActorId {
		return false
	}
	for _, r := range d.Policy.Reviewers {
		if r.Id == strconv.FormatInt(id, 10) {
			return true
		}
	}
	return false
}
func (s *Server) deploymentRead(ctx context.Context, token forgeCredential, d *golfv1.RepositoryDeployment, id int64) error {
	u, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	if u.ID != id {
		return errUnauthenticated
	}
	for _, reviewer := range d.Policy.Reviewers {
		if reviewer.Id == strconv.FormatInt(id, 10) && reviewer.Login != u.Login {
			return errDeployment
		}
	}
	a, e := s.readRepositoryAccess(ctx, token, keyFrom(d.Target.Repository), u)
	if e != nil {
		return e
	}
	if a.RepositoryId != d.Target.RepositoryId || a.OwnerId != d.Target.OwnerId {
		return errResourceNotFound
	}
	return nil
}

// Resolve encrypted parent credentials before SQL locks; no credential enters a
// project. Local account/CV and absolute expiry are repeated under ordered locks.
func (s *Server) deploymentSession(ctx context.Context, hash []byte, native int64) (forgeCredential, time.Time, int64, error) {
	q := database.New(s.db)
	v, e := q.GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if e != nil || v.ForgeUserID != native {
		return forgeCredential{}, time.Time{}, 0, errUnauthenticated
	}
	token, e := s.sessionCredentialHash(ctx, hash)
	if e != nil {
		return token, time.Time{}, 0, e
	}
	u, e := s.currentUser(ctx, token)
	if e != nil || u.ID != native {
		return token, time.Time{}, 0, errUnauthenticated
	}
	var uid int64
	e = s.db.QueryRowContext(ctx, "SELECT user_id FROM golf_sessions WHERE token_hash=$1", hash).Scan(&uid)
	if e != nil {
		return token, time.Time{}, 0, errUnauthenticated
	}
	return token, v.ExpiresAt, uid, nil
}
func (s *Server) deploymentFence(ctx context.Context, d *deploymentRecord, viewer []byte, viewerNative int64, operation func(*sql.Tx, *deploymentRecord, time.Time) error) error {
	if !s.previewAvailable() || d.wire.TargetFingerprint != s.preview.fingerprint {
		return errDeployment
	}
	reviews, e := s.deploymentReviews(ctx, d.wire.Id)
	if e != nil {
		return e
	}
	type participant struct {
		hash         []byte
		native, user int64
		token        forgeCredential
		expires      time.Time
	}
	parentID, e := discussionID(d.wire.ActorId)
	if e != nil {
		return errStorageUnavailable
	}
	people := []participant{{hash: d.session, native: parentID}}
	if len(viewer) > 0 && !bytes.Equal(viewer, d.session) {
		people = append(people, participant{hash: viewer, native: viewerNative})
	}
	count := 0
	for _, r := range reviews {
		if r.approved {
			if !deploymentReviewer(d.wire, r.native) || !r.expires.After(time.Now()) {
				return errDeployment
			}
			people = append(people, participant{hash: r.session, native: r.native})
			count++
		}
	}
	if count < int(d.wire.Policy.RequiredApprovals) {
		return errDeployment
	}
	users := []int64{}
	for i := range people {
		p := &people[i]
		p.token, p.expires, p.user, e = s.deploymentSession(ctx, p.hash, p.native)
		if e != nil {
			return e
		}
		users = append(users, p.user)
	}
	sort.Slice(people, func(i, j int) bool { return bytes.Compare(people[i].hash, people[j].hash) < 0 })
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	rows, e := tx.QueryContext(ctx, "SELECT id FROM golf_users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", users)
	if e != nil {
		return errStorageUnavailable
	}
	for rows.Next() {
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return errStorageUnavailable
	}
	q := database.New(s.db).WithTx(tx)
	deadline := time.Now().Add(7 * 24 * time.Hour)
	seen := map[string]bool{}
	for _, p := range people {
		h := hex.EncodeToString(p.hash)
		if !seen[h] {
			var uid int64
			if tx.QueryRowContext(ctx, "SELECT user_id FROM golf_sessions WHERE token_hash=$1 ORDER BY token_hash FOR UPDATE", p.hash).Scan(&uid) != nil || uid != p.user {
				return errUnauthenticated
			}
			seen[h] = true
		}
		v, e := q.GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: p.hash, ForgeURL: s.config.GiteaURL})
		if e != nil || v.ForgeUserID != p.native {
			return errUnauthenticated
		}
		if v.ExpiresAt.Before(deadline) {
			deadline = v.ExpiresAt
		}
	}
	repo, _ := discussionID(d.wire.Target.RepositoryId)
	owner, _ := discussionID(d.wire.Target.OwnerId)
	if _, e = tx.ExecContext(ctx, "SELECT golf_deployment_lock($1,$2)", s.config.GiteaURL, repo); e != nil {
		return errStorageUnavailable
	}
	current, e := scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1 FOR UPDATE", d.wire.Id))
	if e != nil {
		return e
	}
	if !bytes.Equal(current.inputHash, d.inputHash) || current.wire.State == "REVOKED" || current.wire.State == "EXPIRED" || current.expires.Valid && !current.expires.Time.After(time.Now()) {
		return errDeployment
	}
	env, e := q.GetRepositoryEnvironment(ctx, database.GetRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(d.wire.EnvironmentId), RepositoryID: repo, OwnerID: owner})
	if e != nil || env.Deleted || strconv.FormatInt(env.Version, 10) != d.wire.EnvironmentVersion {
		return errDeployment
	}
	for _, p := range people {
		if p.native == parentID {
			u, e := s.currentUser(ctx, p.token)
			if e != nil {
				return e
			}
			if e = s.environmentAuthority(ctx, p.token, keyFrom(d.wire.Target.Repository), u, d.wire.Target, true, false); e != nil {
				return e
			}
		} else if e = s.deploymentRead(ctx, p.token, d.wire, p.native); e != nil {
			return e
		}
	}
	// Compare each preobserved latest decision after all waits. No unchecked new
	// approval is used and a concurrently withdrawn approval cannot be reused.
	var currentApprovals int
	if tx.QueryRowContext(ctx, "SELECT count(*) FROM (SELECT DISTINCT ON(native_actor_id) approved FROM golf_deployment_reviews WHERE deployment_id=$1 ORDER BY native_actor_id,sequence DESC) r WHERE approved", d.wire.Id).Scan(&currentApprovals) != nil {
		return errStorageUnavailable
	}
	// The individual comparisons below reject replacements/withdrawals. Equal
	// cardinality also excludes newly affirmative sessions absent from people.
	if currentApprovals != count {
		return errDeployment
	}
	for _, r := range reviews {
		if r.approved {
			var approved bool
			var hash []byte
			var expires time.Time
			if tx.QueryRowContext(ctx, "SELECT approved,session_hash,expires_at FROM golf_deployment_reviews WHERE deployment_id=$1 AND native_actor_id=$2 ORDER BY sequence DESC LIMIT 1", d.wire.Id, r.native).Scan(&approved, &hash, &expires) != nil || !approved || !bytes.Equal(hash, r.session) || !expires.After(time.Now()) {
				return errDeployment
			}
			if expires.Before(deadline) {
				deadline = expires
			}
		}
	}
	if current.expires.Valid && current.expires.Time.Before(deadline) {
		deadline = current.expires.Time
	}
	if !deadline.After(time.Now()) {
		return errDeployment
	}
	if e = operation(tx, current, deadline); e != nil {
		return e
	}
	for _, p := range people {
		v, e := q.GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: p.hash, ForgeURL: s.config.GiteaURL})
		if e != nil || v.ForgeUserID != p.native || !v.ExpiresAt.After(time.Now()) {
			return errUnauthenticated
		}
		if p.native == parentID {
			u, e := s.currentUser(ctx, p.token)
			if e != nil {
				return e
			}
			if e = s.environmentAuthority(ctx, p.token, keyFrom(d.wire.Target.Repository), u, d.wire.Target, true, false); e != nil {
				return e
			}
		} else if e = s.deploymentRead(ctx, p.token, d.wire, p.native); e != nil {
			return e
		}
	}
	if !deadline.After(time.Now()) {
		return errDeployment
	}
	if tx.Commit() != nil {
		return errStorageUnavailable
	}
	return nil
}
func (s *Server) deploymentResponse(ctx context.Context, session string, token forgeCredential, target *golfv1.RepositoryEnvironmentTarget, d *deploymentRecord) (*connect.Response[golfv1.RepositoryDeploymentResponse], error) {
	key, repo, owner, e := environmentTarget(target)
	if e != nil {
		return nil, deploymentError(e)
	}
	if d.wire.Target.RepositoryId != target.RepositoryId || d.wire.Target.OwnerId != target.OwnerId {
		return nil, errResourceNotFound
	}
	e = s.withWorkflowRepository(ctx, session, token, key, repo, owner, false, func(user User, _ *golfv1.RepositoryAccess) error {
		reviews, e := s.deploymentReviews(ctx, d.wire.Id)
		if e != nil {
			return e
		}
		for _, r := range reviews {
			d.wire.Approvals = append(d.wire.Approvals, &golfv1.DeploymentApproval{ActorId: strconv.FormatInt(r.native, 10), Approved: r.approved, CreatedAt: r.created.UTC().Format(time.RFC3339Nano), ExpiresAt: r.expires.UTC().Format(time.RFC3339Nano)})
		}
		terminal := d.wire.State == "REVOKED" || d.wire.State == "EXPIRED"
		if !terminal && d.wire.State != "READY" && deploymentReviewer(d.wire, user.ID) {
			env, e := database.New(s.db).GetRepositoryEnvironment(ctx, database.GetRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(d.wire.EnvironmentId), RepositoryID: repo, OwnerID: owner})
			d.wire.CanApprove = e == nil && !env.Deleted && strconv.FormatInt(env.Version, 10) == d.wire.EnvironmentVersion && s.deploymentRead(ctx, token, d.wire, user.ID) == nil
		}
		admin := s.environmentAuthority(ctx, token, key, user, target, true, false) == nil
		d.wire.CanRevoke = !terminal && admin
		d.wire.Reason = "authority_changed"
		if d.wire.State == "REVOKED" {
			d.wire.Reason = "revoked"
			return nil
		}
		if d.expires.Valid && !d.expires.Time.After(time.Now()) {
			d.wire.Reason = "expired"
			return nil
		}
		if !s.previewAvailable() {
			d.wire.Reason = "target_unavailable"
			return nil
		}
		h, _ := sessionHash(session)
		canOpen, canActivate, reason := false, false, ""
		e = s.deploymentFence(ctx, d, h, user.ID, func(tx *sql.Tx, current *deploymentRecord, _ time.Time) error {
			if current.wire.State == "READY" {
				canOpen = true
			} else if admin && d.wire.ActorId == strconv.FormatInt(user.ID, 10) {
				if time.Now().Before(d.created.Add(time.Duration(d.wire.Policy.WaitSeconds) * time.Second)) {
					reason = "wait_required"
					return nil
				}
				if e := s.deploymentSource(ctx, token, current.wire); e != nil {
					return e
				}
				var active int
				if tx.QueryRowContext(ctx, "SELECT count(*) FROM golf_repository_deployments WHERE environment_id=$1 AND state='READY' AND expires_at>clock_timestamp()", d.wire.EnvironmentId).Scan(&active) != nil {
					return errStorageUnavailable
				}
				if active >= int(d.wire.Policy.MaxConcurrency) {
					reason = "capacity_unavailable"
				} else {
					canActivate = true
				}
			}
			return nil
		})
		// The callback is provisional: a late native/session denial or failed
		// commit must not leave executable eligibility in a successful response.
		if e == nil {
			d.wire.CanOpen, d.wire.CanActivate, d.wire.Reason = canOpen, canActivate, reason
			if canOpen {
				d.wire.OpenPath = "/api/deployments/" + d.wire.Id + "/open"
			}
		}
		return nil
	})
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(&golfv1.RepositoryDeploymentResponse{Deployment: d.wire}), nil
}
func (s *Server) getRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.RepositoryDeploymentRequest]) (*connect.Response[golfv1.RepositoryDeploymentResponse], error) {
	token, _, e := s.reviewDraftCaller(ctx, r.Header())
	if e != nil {
		return nil, deploymentError(e)
	}
	d, e := s.deploymentRecord(ctx, r.Msg.DeploymentId)
	if e != nil {
		return nil, deploymentError(e)
	}
	return s.deploymentResponse(ctx, s.cookieValue(r.Header()), token, r.Msg.Target, d)
}
func (s *Server) ListRepositoryDeployments(ctx context.Context, r *connect.Request[golfv1.ListRepositoryDeploymentsRequest]) (*connect.Response[golfv1.ListRepositoryDeploymentsResponse], error) {
	token, _, e := s.reviewDraftCaller(ctx, r.Header())
	if e != nil {
		return nil, deploymentError(e)
	}
	key, repo, owner, e := environmentTarget(r.Msg.Target)
	if e != nil {
		return nil, deploymentError(e)
	}
	page, size := r.Msg.Page, r.Msg.PageSize
	if page == 0 {
		page = 1
	}
	if size == 0 {
		size = 20
	}
	if page > 100 || size > 20 {
		return nil, invalid("Use bounded deployment pagination.")
	}
	out := &golfv1.ListRepositoryDeploymentsResponse{}
	e = s.withWorkflowRepository(ctx, s.cookieValue(r.Header()), token, key, repo, owner, false, func(_ User, _ *golfv1.RepositoryAccess) error {
		rows, e := s.db.QueryContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 ORDER BY created_at DESC,id LIMIT $4 OFFSET $5", s.config.GiteaURL, repo, owner, size+1, (page-1)*size)
		if e != nil {
			return errStorageUnavailable
		}
		var records []*deploymentRecord
		for rows.Next() {
			d, e := scanDeployment(rows)
			if e != nil {
				rows.Close()
				return e
			}
			records = append(records, d)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return errStorageUnavailable
		}
		if len(records) > int(size) {
			out.NextPage = page + 1
			records = records[:size]
		}
		for _, d := range records {
			v, e := s.deploymentResponse(ctx, s.cookieValue(r.Header()), token, r.Msg.Target, d)
			if e != nil {
				return e
			}
			out.Deployments = append(out.Deployments, v.Msg.Deployment)
		}
		return nil
	})
	if e != nil {
		return nil, deploymentError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) reviewRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.ReviewRepositoryDeploymentRequest]) (*connect.Response[golfv1.RepositoryDeploymentResponse], error) {
	token, _, e := s.reviewDraftCaller(ctx, r.Header())
	if e != nil {
		return nil, deploymentError(e)
	}
	if !deploymentUUID(r.Msg.OperationId) {
		return nil, invalid("Provide the original review operation identity.")
	}
	d, e := s.deploymentRecord(ctx, r.Msg.DeploymentId)
	if e != nil {
		return nil, deploymentError(e)
	}
	key, repo, owner, e := environmentTarget(r.Msg.Target)
	if e != nil {
		return nil, deploymentError(e)
	}
	if d.wire.Target.RepositoryId != r.Msg.Target.RepositoryId || d.wire.Target.OwnerId != r.Msg.Target.OwnerId {
		return nil, errResourceNotFound
	}
	u, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, deploymentError(e)
	}
	if !deploymentReviewer(d.wire, u.ID) {
		return nil, deploymentError(forgeError{403})
	}
	e = s.workflowTransaction(ctx, s.cookieValue(r.Header()), u.ID, func(tx *sql.Tx, a database.LockManagedSessionRow, h []byte) error {
		if _, e := tx.ExecContext(ctx, "SELECT golf_deployment_lock($1,$2)", s.config.GiteaURL, repo); e != nil {
			return errStorageUnavailable
		}
		var priorID string
		var priorDecision bool
		e := tx.QueryRowContext(ctx, "SELECT deployment_id::text,approved FROM golf_deployment_reviews WHERE user_id=$1 AND operation_id=$2", a.UserID, r.Msg.OperationId).Scan(&priorID, &priorDecision)
		if e == nil {
			if priorID != d.wire.Id || priorDecision != r.Msg.Approve {
				return errDeployment
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		current, e := scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1 FOR UPDATE", d.wire.Id))
		if e != nil {
			return e
		}
		if current.wire.State == "REVOKED" || current.wire.State == "EXPIRED" || current.wire.State == "READY" && r.Msg.Approve {
			return errDeployment
		}
		v, e := database.New(s.db).WithTx(tx).GetRepositoryEnvironment(ctx, database.GetRepositoryEnvironmentParams{ForgeURL: s.config.GiteaURL, ID: uuid.MustParse(d.wire.EnvironmentId), RepositoryID: repo, OwnerID: owner})
		if e != nil || v.Deleted || strconv.FormatInt(v.Version, 10) != d.wire.EnvironmentVersion {
			return errDeployment
		}
		if e = s.deploymentRead(ctx, token, d.wire, u.ID); e != nil {
			return e
		}
		if key != keyFrom(d.wire.Target.Repository) {
			return errResourceNotFound
		}
		var count int
		if tx.QueryRowContext(ctx, "SELECT count(*) FROM golf_deployment_reviews WHERE deployment_id=$1", d.wire.Id).Scan(&count) != nil || count >= 100 {
			return errDeployment
		}
		_, e = tx.ExecContext(ctx, "INSERT INTO golf_deployment_reviews(deployment_id,user_id,operation_id,native_actor_id,session_hash,approved,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", d.wire.Id, a.UserID, r.Msg.OperationId, u.ID, h, r.Msg.Approve, a.ExpiresAt)
		if e != nil {
			return errStorageUnavailable
		}
		if current.wire.State == "READY" && !r.Msg.Approve {
			_, e = tx.ExecContext(ctx, "UPDATE golf_repository_deployments SET state='REVOKED',version=version+1,updated_at=clock_timestamp() WHERE id=$1", d.wire.Id)
			if e != nil {
				return errStorageUnavailable
			}
			current, e = scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1", d.wire.Id))
			if e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, "DELETE FROM golf_preview_credentials WHERE deployment_id=$1", current.wire.Id); e != nil {
				return errStorageUnavailable
			}
			if e = deploymentEvent(ctx, tx, current, a.UserID); e != nil {
				return e
			}
		}
		return s.deploymentRead(ctx, token, d.wire, u.ID)
	})
	if e != nil {
		return nil, deploymentError(e)
	}
	d, e = s.deploymentRecord(ctx, d.wire.Id)
	if e != nil {
		return nil, deploymentError(e)
	}
	return s.deploymentResponse(ctx, s.cookieValue(r.Header()), token, r.Msg.Target, d)
}
func (s *Server) activateRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.RepositoryDeploymentRequest]) (*connect.Response[golfv1.RepositoryDeploymentResponse], error) {
	token, _, e := s.reviewDraftCaller(ctx, r.Header())
	if e != nil {
		return nil, deploymentError(e)
	}
	d, e := s.deploymentRecord(ctx, r.Msg.DeploymentId)
	if e != nil {
		return nil, deploymentError(e)
	}
	u, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, deploymentError(e)
	}
	if d.wire.ActorId != strconv.FormatInt(u.ID, 10) || d.wire.Target.RepositoryId != r.Msg.Target.GetRepositoryId() || d.wire.Target.OwnerId != r.Msg.Target.GetOwnerId() {
		return nil, errResourceNotFound
	}
	key, _, _, e := environmentTarget(r.Msg.Target)
	if e != nil {
		return nil, deploymentError(e)
	}
	if key != keyFrom(d.wire.Target.Repository) {
		return nil, errResourceNotFound
	}
	if e = s.environmentAuthority(ctx, token, key, u, r.Msg.Target, true, true); e != nil {
		return nil, deploymentError(e)
	}
	a, site, e := s.deploymentArtifact(ctx, s.cookieValue(r.Header()), token, d.wire.Target, d.wire.Artifact.RunId)
	if e != nil {
		return nil, deploymentError(e)
	}
	if !proto.Equal(a, d.wire.Artifact) || site.ManifestSHA256 != d.wire.ManifestSha256 {
		return nil, errDeployment
	}
	h, _ := sessionHash(s.cookieValue(r.Header()))
	e = s.deploymentFence(ctx, d, h, u.ID, func(tx *sql.Tx, current *deploymentRecord, deadline time.Time) error {
		if current.wire.State == "READY" {
			return nil
		}
		if time.Now().Before(current.created.Add(time.Duration(d.wire.Policy.WaitSeconds) * time.Second)) {
			return errDeployment
		}
		if e = s.deploymentSource(ctx, token, d.wire); e != nil {
			return e
		}
		var active int
		if tx.QueryRowContext(ctx, "SELECT count(*) FROM golf_repository_deployments WHERE environment_id=$1 AND state='READY' AND expires_at>clock_timestamp()", d.wire.EnvironmentId).Scan(&active) != nil {
			return errStorageUnavailable
		}
		if active >= int(d.wire.Policy.MaxConcurrency) {
			return errDeployment
		}
		expiry := time.Now().Add(time.Duration(d.wire.Policy.PreviewTtlSeconds) * time.Second)
		if deadline.Before(expiry) {
			expiry = deadline
		}
		_, e = tx.ExecContext(ctx, "UPDATE golf_repository_deployments SET state='READY',version=version+1,updated_at=clock_timestamp(),expires_at=$2 WHERE id=$1", d.wire.Id, expiry)
		if e != nil {
			return errStorageUnavailable
		}
		current, e = scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1", d.wire.Id))
		if e != nil {
			return e
		}
		if e = deploymentEvent(ctx, tx, current, d.user); e != nil {
			return e
		}
		return s.environmentAuthority(ctx, token, key, u, r.Msg.Target, true, true)
	})
	if e != nil {
		return nil, deploymentError(e)
	}
	d, e = s.deploymentRecord(ctx, d.wire.Id)
	if e != nil {
		return nil, deploymentError(e)
	}
	return s.deploymentResponse(ctx, s.cookieValue(r.Header()), token, r.Msg.Target, d)
}
func (s *Server) revokeRepositoryDeployment(ctx context.Context, r *connect.Request[golfv1.RepositoryDeploymentRequest]) (*connect.Response[golfv1.RepositoryDeploymentResponse], error) {
	token, _, e := s.reviewDraftCaller(ctx, r.Header())
	if e != nil {
		return nil, deploymentError(e)
	}
	key, repo, _, e := environmentTarget(r.Msg.Target)
	if e != nil {
		return nil, deploymentError(e)
	}
	d, e := s.deploymentRecord(ctx, r.Msg.DeploymentId)
	if e != nil {
		return nil, deploymentError(e)
	}
	u, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, deploymentError(e)
	}
	if d.wire.Target.RepositoryId != r.Msg.Target.RepositoryId || d.wire.Target.OwnerId != r.Msg.Target.OwnerId {
		return nil, errResourceNotFound
	}
	e = s.workflowTransaction(ctx, s.cookieValue(r.Header()), u.ID, func(tx *sql.Tx, a database.LockManagedSessionRow, _ []byte) error {
		if _, e := tx.ExecContext(ctx, "SELECT golf_deployment_lock($1,$2)", s.config.GiteaURL, repo); e != nil {
			return errStorageUnavailable
		}
		if e = s.environmentAuthority(ctx, token, key, u, r.Msg.Target, true, true); e != nil {
			return e
		}
		current, e := scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1 FOR UPDATE", d.wire.Id))
		if e != nil {
			return e
		}
		if current.wire.State == "REVOKED" || current.wire.State == "EXPIRED" {
			return nil
		}
		_, e = tx.ExecContext(ctx, "UPDATE golf_repository_deployments SET state='REVOKED',version=version+1,updated_at=clock_timestamp() WHERE id=$1", d.wire.Id)
		if e != nil {
			return errStorageUnavailable
		}
		current, e = scanDeployment(tx.QueryRowContext(ctx, "SELECT "+deploymentColumns+" FROM golf_repository_deployments WHERE id=$1", d.wire.Id))
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, "DELETE FROM golf_preview_credentials WHERE deployment_id=$1", current.wire.Id); e != nil {
			return errStorageUnavailable
		}
		if e := deploymentEvent(ctx, tx, current, a.UserID); e != nil {
			return e
		}
		return s.environmentAuthority(ctx, token, key, u, r.Msg.Target, true, true)
	})
	if e != nil {
		return nil, deploymentError(e)
	}
	d, e = s.deploymentRecord(ctx, d.wire.Id)
	if e != nil {
		return nil, deploymentError(e)
	}
	return s.deploymentResponse(ctx, s.cookieValue(r.Header()), token, r.Msg.Target, d)
}
