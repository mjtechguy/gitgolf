package server

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const organizationExecutionValueDomain = "organization_execution_value"
const organizationExecutionSelectedLimit = 20

type organizationExecutionTarget struct {
	name string
	id   int64
}
type organizationExecutionSelection struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
	ID    string `json:"id"`
}
type organizationExecutionRecord struct {
	id, name, kind            string
	version                   int64
	deleted                   bool
	size                      int
	created, updated, expires time.Time
	selected                  []organizationExecutionSelection
	approver, native          int64
	session, cipher, binding  []byte
	key                       string
}

const organizationExecutionColumns = `v.id::text,v.name,v.kind,v.version,v.deleted,h.value_bytes,v.created_at,v.updated_at,h.selected_repositories,h.expires_at,h.approver_user_id,h.approver_native_id,h.approval_session_hash,h.encrypted_content,h.content_binding,h.credential_key_id`

func parseOrganizationExecutionTarget(t *golfv1.OrganizationExecutionValueTarget) (organizationExecutionTarget, error) {
	if t == nil || !validOrganizationName(t.Organization) {
		return organizationExecutionTarget{}, invalid("Select an exact organization execution target.")
	}
	id, e := discussionID(t.OrganizationId)
	if e != nil {
		return organizationExecutionTarget{}, e
	}
	return organizationExecutionTarget{t.Organization, id}, nil
}
func organizationExecutionSelections(values []*golfv1.OrganizationExecutionRepository, org string) ([]organizationExecutionSelection, error) {
	if len(values) > organizationExecutionSelectedLimit {
		return nil, invalid("Select at most 20 exact organization repositories.")
	}
	out := make([]organizationExecutionSelection, 0, len(values))
	ids := map[string]bool{}
	routes := map[string]bool{}
	for _, v := range values {
		if v == nil {
			return nil, invalid("Select complete repository identities.")
		}
		key := keyFrom(v.Repository)
		if _, e := repositoryPath(key); e != nil {
			return nil, e
		}
		if !strings.EqualFold(key.Owner, org) {
			return nil, invalid("Only repositories of the selected organization can receive its values.")
		}
		if _, e := discussionID(v.RepositoryId); e != nil {
			return nil, e
		}
		route := strings.ToLower(key.Owner + "/" + key.Name)
		if ids[v.RepositoryId] || routes[route] {
			return nil, invalid("Select distinct immutable repository identities.")
		}
		ids[v.RepositoryId] = true
		routes[route] = true
		out = append(out, organizationExecutionSelection{key.Owner, key.Name, v.RepositoryId})
	}
	return out, nil
}
func scanOrganizationExecutionValue(row workflowRunScanner) (organizationExecutionRecord, error) {
	var r organizationExecutionRecord
	var selected []byte
	e := row.Scan(&r.id, &r.name, &r.kind, &r.version, &r.deleted, &r.size, &r.created, &r.updated, &selected, &r.expires, &r.approver, &r.native, &r.session, &r.cipher, &r.binding, &r.key)
	if e == nil && json.Unmarshal(selected, &r.selected) != nil {
		e = errStorageUnavailable
	}
	return r, e
}
func wireOrganizationExecutionValue(r organizationExecutionRecord) *golfv1.OrganizationExecutionValue {
	out := &golfv1.OrganizationExecutionValue{Value: &golfv1.RepositoryExecutionValue{Id: r.id, Name: r.name, Kind: golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET, Version: strconv.FormatInt(r.version, 10), Deleted: r.deleted, CreatedAt: r.created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.updated.UTC().Format(time.RFC3339Nano)}, ShareExpiresAt: r.expires.UTC().Format(time.RFC3339Nano), ShareState: "requires_current_authority"}
	if r.kind == "variable" {
		out.Value.Kind = golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE
	}
	for _, v := range r.selected {
		out.SelectedRepositories = append(out.SelectedRepositories, &golfv1.OrganizationExecutionRepository{Repository: &golfv1.RepositoryKey{Owner: v.Owner, Name: v.Name}, RepositoryId: v.ID})
	}
	return out
}

// Positive actual organization ownership is required. Public org metadata,
// effective owner-like repository access and instance administration are not proof.
func (s *Server) checkOrganizationExecutionOwner(ctx context.Context, token forgeCredential, t organizationExecutionTarget, user User) error {
	current, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	if current.ID != user.ID {
		return errUnauthenticated
	}
	if e = s.requireOrganizationMember(ctx, token, t.name, current.Login); e != nil {
		return e
	}
	var org forgeOrganization
	if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+t.name, token, nil, &org); e != nil {
		return e
	}
	if !validOrganization(org) || org.ID != t.id || !strings.EqualFold(org.Name, t.name) {
		return errResourceNotFound
	}
	owner, e := s.organizationOwner(ctx, token, org, current)
	if e != nil {
		return e
	}
	if !owner {
		return forgeError{http.StatusForbidden}
	}
	return nil
}
func (s *Server) withOrganizationExecutionOwner(ctx context.Context, h http.Header, t organizationExecutionTarget, fn func(forgeCredential, User, string) error) error {
	token, session, e := s.reviewDraftCaller(ctx, h)
	if e != nil {
		return e
	}
	return s.withForgeCaller(ctx, session, token, func(user User) error {
		if e := s.checkOrganizationExecutionOwner(ctx, token, t, user); e != nil {
			return e
		}
		if e := fn(token, user, session); e != nil {
			return e
		}
		return s.checkOrganizationExecutionOwner(ctx, token, t, user)
	})
}
func (s *Server) verifyOrganizationExecutionSelections(ctx context.Context, token forgeCredential, t organizationExecutionTarget, selected []organizationExecutionSelection) error {
	for _, v := range selected {
		row, _, e := s.readRepositorySettings(ctx, token, repositoryKey{v.Owner, v.Name})
		if e != nil {
			return e
		}
		if row.Owner == nil || row.ID <= 0 || strconv.FormatInt(row.ID, 10) != v.ID || row.Owner.ID != t.id || !strings.EqualFold(row.Owner.Login, t.name) || row.Archived == nil || row.Mirror == nil || *row.Archived || *row.Mirror {
			return errResourceNotFound
		}
	}
	return nil
}
func lockOrganizationExecutionBroker(ctx context.Context, tx *sql.Tx, forge string, org int64, create bool) (int64, error) {
	if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, forge+":organization-execution:"+strconv.FormatInt(org, 10)); e != nil {
		return 0, errStorageUnavailable
	}
	if create {
		if _, e := tx.ExecContext(ctx, `INSERT INTO golf_organization_execution_brokers(forge_url,organization_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, forge, org); e != nil {
			return 0, errStorageUnavailable
		}
	}
	var revision int64
	e := tx.QueryRowContext(ctx, `SELECT revision FROM golf_organization_execution_brokers WHERE forge_url=$1 AND organization_id=$2 FOR UPDATE`, forge, org).Scan(&revision)
	if !create && errors.Is(e, sql.ErrNoRows) {
		return 0, nil
	}
	if e != nil {
		return 0, errStorageUnavailable
	}
	return revision, nil
}
func (s *Server) openOrganizationExecutionValue(ctx context.Context, tx workflowQueryer, t organizationExecutionTarget, id string, version int64) (organizationExecutionRecord, string, error) {
	// Latest metadata and requested immutable history are deliberately distinct:
	// status replay may inspect a historic accepted version after replacement/delete.
	r, e := scanOrganizationExecutionValue(tx.QueryRowContext(ctx, `SELECT `+organizationExecutionColumns+` FROM golf_organization_execution_values v JOIN golf_organization_execution_versions h ON h.id=v.id AND h.version=$4 WHERE v.id=$1 AND v.forge_url=$2 AND v.organization_id=$3`, id, s.config.ForgeURL, t.id, version))
	if errors.Is(e, sql.ErrNoRows) {
		return r, "", errResourceNotFound
	}
	if e != nil {
		return r, "", errStorageUnavailable
	}
	plain, e := openOrganizationExecutionContent(s.keyring, s.config.ForgeURL, t.id, version, r)
	return r, plain, e
}
func (s *Server) ListOrganizationExecutionValues(ctx context.Context, req *connect.Request[golfv1.ListOrganizationExecutionValuesRequest]) (*connect.Response[golfv1.ListOrganizationExecutionValuesResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	t, e := parseOrganizationExecutionTarget(req.Msg.Target)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	out := &golfv1.ListOrganizationExecutionValuesResponse{Target: req.Msg.Target, BrokerRevision: "0", MaximumValues: 64, MaximumSelectedRepositories: 20, ConsumerProfile: executionConsumerProfile}
	e = s.withOrganizationExecutionOwner(ctx, req.Header(), t, func(token forgeCredential, user User, session string) error {
		return s.workflowTransaction(ctx, session, user.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			if e := s.checkOrganizationExecutionOwner(ctx, token, t, user); e != nil {
				return e
			}
			revision, e := lockOrganizationExecutionBroker(ctx, tx, s.config.ForgeURL, t.id, false)
			if e != nil {
				return e
			}
			out.BrokerRevision = strconv.FormatInt(revision, 10)
			rows, e := tx.QueryContext(ctx, `SELECT `+organizationExecutionColumns+` FROM golf_organization_execution_values v JOIN golf_organization_execution_versions h ON h.id=v.id AND h.version=(SELECT max(version) FROM golf_organization_execution_versions WHERE id=v.id) WHERE v.forge_url=$1 AND v.organization_id=$2 ORDER BY v.name,v.id LIMIT 65`, s.config.ForgeURL, t.id)
			if e != nil {
				return errStorageUnavailable
			}
			for rows.Next() {
				r, e := scanOrganizationExecutionValue(rows)
				if e != nil {
					rows.Close()
					return errStorageUnavailable
				}
				out.Values = append(out.Values, wireOrganizationExecutionValue(r))
			}
			e = rows.Err()
			rows.Close()
			if e != nil || len(out.Values) > 64 {
				return errStorageUnavailable
			}
			return nil
		})
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	return connect.NewResponse(out), nil
}

type organizationExecutionMutation struct {
	target                                   *golfv1.OrganizationExecutionValueTarget
	id, operation, action, version, revision string
	metadata                                 any
	plain                                    *string
	selected                                 []organizationExecutionSelection
}

func (s *Server) mutateOrganizationExecutionValue(ctx context.Context, h http.Header, m organizationExecutionMutation, apply func(*sql.Tx, database.LockManagedSessionRow, []byte, organizationExecutionTarget, int64, User) error) (*golfv1.OrganizationExecutionValueMutation, error) {
	t, e := parseOrganizationExecutionTarget(m.target)
	if e != nil {
		return nil, e
	}
	if !creationKey.MatchString(m.id) || !creationKey.MatchString(m.operation) {
		return nil, invalid("Provide canonical value and original operation identities.")
	}
	version, e := executionNumber(m.version, true)
	if e != nil {
		return nil, e
	}
	revision, e := executionNumber(m.revision, true)
	if e != nil {
		return nil, e
	}
	metadata, e := json.Marshal(m.metadata)
	if e != nil || len(metadata) > 16384 {
		return nil, invalid("Organization execution metadata exceeds its bound.")
	}
	out := &golfv1.OrganizationExecutionValueMutation{Target: m.target, OperationId: m.operation, Action: m.action, ItemId: m.id}
	e = s.withOrganizationExecutionOwner(ctx, h, t, func(token forgeCredential, user User, session string) error {
		err := s.workflowTransaction(ctx, session, user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte) error {
			// Capture retained and proposed IDs while the organization broker is not
			// held; both mutations and release use user -> sorted repository gates ->
			// org broker -> repository broker -> run. Refresh metadata after the wait.
			var oldSelected []byte
			er := tx.QueryRowContext(ctx, `SELECT h.selected_repositories FROM golf_organization_execution_values v JOIN golf_organization_execution_versions h ON h.id=v.id AND h.version=(SELECT max(version) FROM golf_organization_execution_versions WHERE id=v.id) WHERE v.id=$1 AND v.forge_url=$2 AND v.organization_id=$3`, m.id, s.config.ForgeURL, t.id).Scan(&oldSelected)
			if er != nil && !errors.Is(er, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			var old []organizationExecutionSelection
			if len(oldSelected) > 0 && json.Unmarshal(oldSelected, &old) != nil {
				return errStorageUnavailable
			}
			ids := []int64{}
			for _, v := range append(old, m.selected...) {
				id, e := discussionID(v.ID)
				if e != nil {
					return errStorageUnavailable
				}
				ids = append(ids, id)
			}
			slices.Sort(ids)
			ids = slices.Compact(ids)
			for _, id := range ids {
				if e := executionLifecycleGate(ctx, tx, s.config.ForgeURL, id); e != nil {
					return e
				}
			}
			observed, e := lockOrganizationExecutionBroker(ctx, tx, s.config.ForgeURL, t.id, true)
			if e != nil {
				return e
			}
			if e = s.checkOrganizationExecutionOwner(ctx, token, t, user); e != nil {
				return e
			}
			var action, id string
			var accepted, broker int64
			var stored []byte
			var at time.Time
			e = tx.QueryRowContext(ctx, `SELECT action,item_id::text,accepted_version,accepted_broker_revision,request_metadata,created_at FROM golf_organization_execution_operations WHERE forge_url=$1 AND organization_id=$2 AND user_id=$3 AND operation_id=$4`, s.config.ForgeURL, t.id, actor.UserID, m.operation).Scan(&action, &id, &accepted, &broker, &stored, &at)
			if e == nil {
				var a, b any
				if json.Unmarshal(stored, &a) != nil || json.Unmarshal(metadata, &b) != nil || accessRevision(a) != accessRevision(b) || action != m.action || id != m.id {
					return errExecutionValueConflict
				}
				if m.plain != nil {
					_, value, e := s.openOrganizationExecutionValue(ctx, tx, t, id, accepted)
					if e != nil {
						return e
					}
					if subtle.ConstantTimeCompare([]byte(value), []byte(*m.plain)) != 1 {
						return errExecutionValueConflict
					}
				}
				out.AcceptedVersion = strconv.FormatInt(accepted, 10)
				out.AcceptedBrokerRevision = strconv.FormatInt(broker, 10)
				out.CommittedAt = at.UTC().Format(time.RFC3339Nano)
				out.Replayed = true
				return nil
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			if observed != revision {
				return errExecutionValueConflict
			}
			var latestPolicy []byte
			err := tx.QueryRowContext(ctx, `SELECT h.selected_repositories FROM golf_organization_execution_values v JOIN golf_organization_execution_versions h ON h.id=v.id AND h.version=(SELECT max(version) FROM golf_organization_execution_versions WHERE id=v.id) WHERE v.id=$1 AND v.forge_url=$2 AND v.organization_id=$3`, m.id, s.config.ForgeURL, t.id).Scan(&latestPolicy)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			var latest []organizationExecutionSelection
			if len(latestPolicy) > 0 && json.Unmarshal(latestPolicy, &latest) != nil {
				return errStorageUnavailable
			}
			for _, selected := range latest {
				id, err := discussionID(selected.ID)
				if err != nil {
					return errStorageUnavailable
				}
				if !slices.Contains(ids, id) {
					return errExecutionValueConflict
				}
			}
			if e = s.verifyOrganizationExecutionSelections(ctx, token, t, m.selected); e != nil {
				return e
			}
			if e = apply(tx, actor, hash, t, version, user); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `UPDATE golf_organization_execution_brokers SET revision=revision+1 WHERE forge_url=$1 AND organization_id=$2`, s.config.ForgeURL, t.id); e != nil {
				return errStorageUnavailable
			}
			e = tx.QueryRowContext(ctx, `INSERT INTO golf_organization_execution_operations(forge_url,organization_id,user_id,operation_id,action,item_id,accepted_version,accepted_broker_revision,request_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING created_at`, s.config.ForgeURL, t.id, actor.UserID, m.operation, m.action, m.id, version+1, revision+1, metadata).Scan(&at)
			if e != nil {
				return errStorageUnavailable
			}
			out.AcceptedVersion = strconv.FormatInt(version+1, 10)
			out.AcceptedBrokerRevision = strconv.FormatInt(revision+1, 10)
			out.CommittedAt = at.UTC().Format(time.RFC3339Nano)
			return nil
		})
		if err != nil {
			return err
		}
		if !out.Replayed {
			return s.verifyOrganizationExecutionSelections(ctx, token, t, m.selected)
		}
		return nil
	})
	return out, e
}
func (s *Server) SaveOrganizationExecutionValue(ctx context.Context, req *connect.Request[golfv1.SaveOrganizationExecutionValueRequest]) (*connect.Response[golfv1.SaveOrganizationExecutionValueResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	m := req.Msg
	t, e := parseOrganizationExecutionTarget(m.Target)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	kind := executionKind(m.Kind)
	if kind == "" || !runner.ExecutionValueName(m.Name) || m.Value != nil && !runner.ExecutionValueBody(*m.Value, kind == "secret") {
		return nil, executionMutationRPCError(invalid("Provide a safe uppercase name and supported value."), nil)
	}
	selected, e := organizationExecutionSelections(m.SelectedRepositories, t.name)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	expiry, e := time.Parse(time.RFC3339Nano, m.ExpiresAt)
	if e != nil {
		return nil, executionMutationRPCError(invalid("Select a valid share expiry."), nil)
	}
	// PostgreSQL timestamptz is microsecond precision. Bind the exact stored
	// observation; the operation fingerprint retains the original input string.
	expiry = expiry.UTC().Truncate(time.Microsecond)
	metadata := struct {
		ID, Version, Broker, Name, Kind, Expires string
		BodyPresent                              bool
		Repositories                             []organizationExecutionSelection
	}{m.Id, m.ExpectedVersion, m.ExpectedBrokerRevision, m.Name, kind, m.ExpiresAt, m.Value != nil, selected}
	result, e := s.mutateOrganizationExecutionValue(ctx, req.Header(), organizationExecutionMutation{m.Target, m.Id, m.OperationId, "save_value", m.ExpectedVersion, m.ExpectedBrokerRevision, metadata, m.Value, selected}, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte, t organizationExecutionTarget, version int64, approver User) error {
		if !expiry.After(time.Now().Add(time.Minute)) || expiry.After(time.Now().Add(30*24*time.Hour)) || !expiry.Before(actor.ExpiresAt) {
			return invalid("Share expiry must be between one minute and 30 days and before the approving session expires.")
		}
		var current int64
		var name, storedKind string
		var deleted bool
		e := tx.QueryRowContext(ctx, `SELECT version,name,kind,deleted FROM golf_organization_execution_values WHERE id=$1 AND forge_url=$2 AND organization_id=$3 FOR UPDATE`, m.Id, s.config.ForgeURL, t.id).Scan(&current, &name, &storedKind, &deleted)
		if e == nil && (current != version || name != m.Name || storedKind != kind) || errors.Is(e, sql.ErrNoRows) && version != 0 {
			return errExecutionValueConflict
		}
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		for _, selectedRepo := range selected {
			var conflict bool
			if e = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_execution_values WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND name=$4 AND kind<>$5 AND NOT deleted)`, s.config.ForgeURL, selectedRepo.ID, t.id, m.Name, kind).Scan(&conflict); e != nil {
				return errStorageUnavailable
			}
			if conflict {
				return invalid("A selected repository has a different kind for this name.")
			}
		}
		value := ""
		if m.Value != nil {
			value = *m.Value
		} else {
			if version == 0 || deleted {
				return invalid("Provide content when creating or restoring a value.")
			}
			_, plain, e := s.openOrganizationExecutionValue(ctx, tx, t, m.Id, version)
			if e != nil {
				return e
			}
			value = plain
		}
		var names, history, used int
		if e = tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(value_bytes) FILTER(WHERE NOT deleted AND id<>$3),0),(SELECT count(*) FROM golf_organization_execution_versions h JOIN golf_organization_execution_values v ON v.id=h.id WHERE v.forge_url=$1 AND v.organization_id=$2) FROM golf_organization_execution_values WHERE forge_url=$1 AND organization_id=$2`, s.config.ForgeURL, t.id, m.Id).Scan(&names, &used, &history); e != nil {
			return errStorageUnavailable
		}
		if version == 0 && names >= 64 || history >= executionRetainedVersionsLimit || used+len(value) > runner.MaxExecutionEnvironmentBytes {
			return invalid("Organization execution value retention or active quota reached.")
		}
		if version == 0 {
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_organization_execution_values(id,forge_url,organization_id,name,kind,version,value_bytes) VALUES($1,$2,$3,$4,$5,1,$6)`, m.Id, s.config.ForgeURL, t.id, m.Name, kind, len(value))
		} else {
			_, e = tx.ExecContext(ctx, `UPDATE golf_organization_execution_values SET version=version+1,deleted=false,value_bytes=$2,updated_at=clock_timestamp() WHERE id=$1`, m.Id, len(value))
		}
		if e != nil {
			return errExecutionValueConflict
		}
		binding := organizationExecutionBinding(m.Id, version+1, s.config.ForgeURL, t.id, m.Name, kind, len(value), selected, actor.UserID, approver.ID, hash, expiry)
		cipher, key, e := s.keyring.seal(organizationExecutionValueDomain, value, binding)
		if e != nil {
			return e
		}
		policy, _ := json.Marshal(selected)
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_organization_execution_versions(id,version,value_bytes,selected_repositories,approver_user_id,approver_native_id,approval_session_hash,expires_at,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, m.Id, version+1, len(value), policy, actor.UserID, approver.ID, hash, expiry, cipher, binding, key); e != nil {
			return errStorageUnavailable
		}
		return fenceOrganizationExecutionValueRuns(ctx, tx, s.config.ForgeURL, t.id, m.Id)
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	return connect.NewResponse(&golfv1.SaveOrganizationExecutionValueResponse{Operation: result}), nil
}
func (s *Server) DeleteOrganizationExecutionValue(ctx context.Context, req *connect.Request[golfv1.DeleteOrganizationExecutionValueRequest]) (*connect.Response[golfv1.DeleteOrganizationExecutionValueResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	metadata := struct{ ID, Version, Broker string }{m.Id, m.ExpectedVersion, m.ExpectedBrokerRevision}
	result, e := s.mutateOrganizationExecutionValue(ctx, req.Header(), organizationExecutionMutation{m.Target, m.Id, m.OperationId, "delete_value", m.ExpectedVersion, m.ExpectedBrokerRevision, metadata, nil, nil}, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte, t organizationExecutionTarget, version int64, approver User) error {
		r, e := tx.ExecContext(ctx, `UPDATE golf_organization_execution_values SET version=version+1,deleted=true,updated_at=clock_timestamp() WHERE id=$1 AND forge_url=$2 AND organization_id=$3 AND version=$4 AND NOT deleted`, m.Id, s.config.ForgeURL, t.id, version)
		if e != nil {
			return errStorageUnavailable
		}
		n, _ := r.RowsAffected()
		if n != 1 {
			return errExecutionValueConflict
		}
		return fenceOrganizationExecutionValueRuns(ctx, tx, s.config.ForgeURL, t.id, m.Id)
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	return connect.NewResponse(&golfv1.DeleteOrganizationExecutionValueResponse{Operation: result}), nil
}
func (s *Server) GetOrganizationExecutionVariable(ctx context.Context, req *connect.Request[golfv1.GetOrganizationExecutionVariableRequest]) (*connect.Response[golfv1.GetOrganizationExecutionVariableResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	t, e := parseOrganizationExecutionTarget(m.Target)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	version, e := executionNumber(m.Version, false)
	if e != nil || !creationKey.MatchString(m.Id) {
		return nil, executionMutationRPCError(invalid("Select an exact variable version."), nil)
	}
	out := &golfv1.GetOrganizationExecutionVariableResponse{Target: m.Target}
	e = s.withOrganizationExecutionOwner(ctx, req.Header(), t, func(token forgeCredential, user User, session string) error {
		return s.workflowTransaction(ctx, session, user.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			if e := s.checkOrganizationExecutionOwner(ctx, token, t, user); e != nil {
				return e
			}
			r, value, e := s.openOrganizationExecutionValue(ctx, tx, t, m.Id, version)
			if e != nil {
				return e
			}
			if r.deleted || r.version != version || r.kind != "variable" {
				return errResourceNotFound
			}
			out.Variable = wireOrganizationExecutionValue(r)
			out.Value = value
			return nil
		})
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) GetOrganizationExecutionValueOperation(ctx context.Context, req *connect.Request[golfv1.GetOrganizationExecutionValueOperationRequest]) (*connect.Response[golfv1.GetOrganizationExecutionValueOperationResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	t, e := parseOrganizationExecutionTarget(m.Target)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, executionMutationRPCError(invalid("Select the original operation identity."), nil)
	}
	out := &golfv1.OrganizationExecutionValueMutation{Target: m.Target, OperationId: m.OperationId, Replayed: true}
	e = s.withOrganizationExecutionOwner(ctx, req.Header(), t, func(token forgeCredential, user User, session string) error {
		return s.workflowTransaction(ctx, session, user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			if e := s.checkOrganizationExecutionOwner(ctx, token, t, user); e != nil {
				return e
			}
			var version, revision int64
			var at time.Time
			e := tx.QueryRowContext(ctx, `SELECT action,item_id::text,accepted_version,accepted_broker_revision,created_at FROM golf_organization_execution_operations WHERE forge_url=$1 AND organization_id=$2 AND user_id=$3 AND operation_id=$4`, s.config.ForgeURL, t.id, actor.UserID, m.OperationId).Scan(&out.Action, &out.ItemId, &version, &revision, &at)
			if errors.Is(e, sql.ErrNoRows) {
				return errResourceNotFound
			}
			if e != nil {
				return errStorageUnavailable
			}
			out.AcceptedVersion = strconv.FormatInt(version, 10)
			out.AcceptedBrokerRevision = strconv.FormatInt(revision, 10)
			out.CommittedAt = at.UTC().Format(time.RFC3339Nano)
			return nil
		})
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	return connect.NewResponse(&golfv1.GetOrganizationExecutionValueOperationResponse{Operation: out}), nil
}
