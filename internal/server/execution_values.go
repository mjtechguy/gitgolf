package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const executionValueDomain = "repository_execution_value"
const quarantinedOutputDomain = "workflow_quarantined_output"
const executionConsumerProfile = "golf.repository-env.v1"
const executionBindingsLimit = 20
const executionRetainedVersionsLimit = 256

var errExecutionValueConflict = errors.New("repository execution value observation changed")
var errExecutionApproval = errors.New("repository execution approval is unavailable")

type executionTarget struct {
	key         repositoryKey
	repo, owner int64
}

func parseExecutionTarget(t *golfv1.RepositoryExecutionValueTarget) (executionTarget, error) {
	if t == nil {
		return executionTarget{}, invalid("Select an exact repository execution target.")
	}
	key := keyFrom(t.Repository)
	if _, e := repositoryPath(key); e != nil {
		return executionTarget{}, e
	}
	repo, e := discussionID(t.RepositoryId)
	if e != nil {
		return executionTarget{}, e
	}
	owner, e := discussionID(t.OwnerId)
	if e != nil {
		return executionTarget{}, e
	}
	if !validAccessRevision(t.AccessRevision) {
		return executionTarget{}, invalid("Provide the current native access revision.")
	}
	return executionTarget{key, repo, owner}, nil
}
func executionNumber(value string, zero bool) (int64, error) {
	n, e := strconv.ParseInt(value, 10, 64)
	if e != nil || n < 0 || !zero && n == 0 || strconv.FormatInt(n, 10) != value {
		return 0, invalid("Provide a canonical supported version.")
	}
	return n, nil
}
func executionKind(kind golfv1.RepositoryExecutionValueKind) string {
	switch kind {
	case golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET:
		return "secret"
	case golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE:
		return "variable"
	}
	return ""
}
func executionValueBinding(id string, version int64, forge string, repo, owner int64, name, kind string, size int) []byte {
	data, _ := json.Marshal([]any{executionValueDomain, id, version, forge, repo, owner, name, kind, size})
	h := sha256.Sum256(data)
	return h[:]
}
func quarantineBinding(run workflowRunRecord, attempt string, sequence int64, job, step string, size int) []byte {
	data, _ := json.Marshal([]any{quarantinedOutputDomain, run.ID, attempt, run.ForgeURL, run.RepositoryID, run.OwnerID, sequence, job, step, size})
	h := sha256.Sum256(data)
	return h[:]
}
func (s *Server) withExecutionAdmin(ctx context.Context, header http.Header, target *golfv1.RepositoryExecutionValueTarget, fn func(forgeCredential, User, *golfv1.RepositoryAccess) error) error {
	t, e := parseExecutionTarget(target)
	if e != nil {
		return e
	}
	token, e := workflowBrowserToken(ctx)
	if e != nil {
		return e
	}
	return s.withAutomationRepository(ctx, s.cookieValue(header), token, t.key, t.repo, t.owner, true, func(user User, a *golfv1.RepositoryAccess) error {
		if a.Revision != target.AccessRevision {
			return errRepositoryAccessConflict
		}
		row, _, e := s.readRepositorySettings(ctx, token, t.key)
		if e != nil {
			return e
		}
		if row.ID != t.repo || row.Owner.ID != t.owner || *row.Archived || *row.Mirror {
			return errResourceNotFound
		}
		if e = fn(token, user, a); e != nil {
			return e
		}
		after, e := s.readRepositoryAccess(ctx, token, t.key, user)
		if e != nil {
			return e
		}
		if after.Revision != target.AccessRevision {
			return errRepositoryAccessConflict
		}
		return nil
	})
}

// The 041 lifecycle guard is intentionally shared with dangerous operations.
// This gate is an actual SQL primitive, not a permissive missing-feature fallback.
func executionLifecycleGate(ctx context.Context, tx *sql.Tx, forge string, repo int64) error {
	if _, e := tx.ExecContext(ctx, `SELECT golf_repository_lifecycle_lock($1,$2,false)`, forge, repo); e != nil {
		return errStorageUnavailable
	}
	var blocked bool
	if e := tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked($1,$2)`, forge, repo).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errExecutionApproval
	}
	return nil
}
func lockExecutionBroker(ctx context.Context, tx *sql.Tx, forge string, t executionTarget, create bool) (int64, error) {
	if e := lockExecutionBrokerAbsence(ctx, tx, forge, t.repo, t.owner); e != nil {
		return 0, e
	}
	if create {
		if _, e := tx.ExecContext(ctx, `INSERT INTO golf_execution_value_brokers(forge_url,repository_id,owner_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, forge, t.repo, t.owner); e != nil {
			return 0, errStorageUnavailable
		}
	}
	var revision int64
	e := tx.QueryRowContext(ctx, `SELECT revision FROM golf_execution_value_brokers WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 FOR UPDATE`, forge, t.repo, t.owner).Scan(&revision)
	if errors.Is(e, sql.ErrNoRows) {
		return 0, errResourceNotFound
	}
	if e != nil {
		return 0, errStorageUnavailable
	}
	return revision, nil
}

// Serialize first-row creation and absence admission without treating a missing
// broker row as a stable observation. Existing release uses the broker row lock.
func lockExecutionBrokerAbsence(ctx context.Context, tx *sql.Tx, forge string, repo, owner int64) error {
	_, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fmt.Sprintf("execution-broker/%s/%d/%d", forge, repo, owner))
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

type executionValueRecord struct {
	id, name, kind   string
	version          int64
	deleted          bool
	size             int
	created, updated time.Time
}

const executionValueColumns = `id::text,name,kind,version,deleted,value_bytes,created_at,updated_at`

func scanExecutionValue(row workflowRunScanner) (executionValueRecord, error) {
	var r executionValueRecord
	e := row.Scan(&r.id, &r.name, &r.kind, &r.version, &r.deleted, &r.size, &r.created, &r.updated)
	return r, e
}
func wireExecutionValue(r executionValueRecord) *golfv1.RepositoryExecutionValue {
	kind := golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE
	if r.kind == "secret" {
		kind = golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET
	}
	return &golfv1.RepositoryExecutionValue{Id: r.id, Name: r.name, Kind: kind, Version: strconv.FormatInt(r.version, 10), Deleted: r.deleted, CreatedAt: r.created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.updated.UTC().Format(time.RFC3339Nano)}
}
func (s *Server) openExecutionValue(ctx context.Context, tx workflowQueryer, t executionTarget, id string, version int64) (executionValueRecord, string, error) {
	r, e := scanExecutionValue(tx.QueryRowContext(ctx, `SELECT `+executionValueColumns+` FROM golf_execution_values WHERE id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4`, id, s.config.GiteaURL, t.repo, t.owner))
	if errors.Is(e, sql.ErrNoRows) {
		return r, "", errResourceNotFound
	}
	if e != nil {
		return r, "", errStorageUnavailable
	}
	var encrypted, binding []byte
	var key string
	var size int
	if e = tx.QueryRowContext(ctx, `SELECT encrypted_content,content_binding,credential_key_id,value_bytes FROM golf_execution_value_versions WHERE id=$1 AND version=$2`, id, version).Scan(&encrypted, &binding, &key, &size); e != nil {
		return r, "", errCredentialUnavailable
	}
	if !bytes.Equal(binding, executionValueBinding(id, version, s.config.GiteaURL, t.repo, t.owner, r.name, r.kind, size)) {
		return r, "", errCredentialUnavailable
	}
	plain, e := s.keyring.open(key, executionValueDomain, encrypted, binding)
	if e != nil || len(plain) != size || !runner.ExecutionValueBody(plain, r.kind == "secret") {
		return r, "", errCredentialUnavailable
	}
	return r, plain, nil
}

// PostgreSQL and the existing source-store readers use this concrete bounded
// QueryRow seam; it is not a second repository storage abstraction.
type workflowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Server) ListRepositoryExecutionValues(ctx context.Context, req *connect.Request[golfv1.ListRepositoryExecutionValuesRequest]) (*connect.Response[golfv1.ListRepositoryExecutionValuesResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	t, e := parseExecutionTarget(req.Msg.Target)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	out := &golfv1.ListRepositoryExecutionValuesResponse{Target: req.Msg.Target, BrokerRevision: "0", ConsumerProfile: executionConsumerProfile, MaximumValues: 64, MaximumBindings: 20}
	e = s.withExecutionAdmin(ctx, req.Header(), req.Msg.Target, func(token forgeCredential, u User, a *golfv1.RepositoryAccess) error {
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), u.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			// Inventory may remain visible to its current administrator while lifecycle
			// blocks execution. An inventory read does not acquire execution authority.
			e := tx.QueryRowContext(ctx, `SELECT revision FROM golf_execution_value_brokers WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3`, s.config.GiteaURL, t.repo, t.owner).Scan(&out.BrokerRevision)
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			rows, e := tx.QueryContext(ctx, `SELECT `+executionValueColumns+` FROM golf_execution_values WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 ORDER BY name,id LIMIT 65`, s.config.GiteaURL, t.repo, t.owner)
			if e != nil {
				return errStorageUnavailable
			}
			for rows.Next() {
				r, e := scanExecutionValue(rows)
				if e != nil {
					rows.Close()
					return errStorageUnavailable
				}
				out.Values = append(out.Values, wireExecutionValue(r))
			}
			e = rows.Err()
			rows.Close()
			if e != nil || len(out.Values) > 64 {
				return errStorageUnavailable
			}
			bindings, e := listExecutionBindings(ctx, tx, s.config.GiteaURL, t)
			if e != nil {
				return e
			}
			out.Bindings = bindings
			return nil
		})
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	return connect.NewResponse(out), nil
}

type executionMutation struct {
	target                                                 *golfv1.RepositoryExecutionValueTarget
	id, operation, action, expectedVersion, expectedBroker string
	metadata                                               any
	plain                                                  string
}

func executionMutationNumbers(m executionMutation) (int64, int64, error) {
	if !creationKey.MatchString(m.id) || !creationKey.MatchString(m.operation) {
		return 0, 0, invalid("Provide canonical operation and item UUIDs.")
	}
	version, e := executionNumber(m.expectedVersion, true)
	if e != nil {
		return 0, 0, e
	}
	revision, e := executionNumber(m.expectedBroker, true)
	return version, revision, e
}
func (s *Server) executionMutation(ctx context.Context, header http.Header, m executionMutation, apply func(*sql.Tx, database.LockManagedSessionRow, []byte, executionTarget, int64) error) (*golfv1.RepositoryExecutionValueMutationResponse, error) {
	t, e := parseExecutionTarget(m.target)
	if e != nil {
		return nil, e
	}
	version, revision, e := executionMutationNumbers(m)
	if e != nil {
		return nil, e
	}
	metadata, e := json.Marshal(m.metadata)
	if e != nil || len(metadata) > 16384 {
		return nil, invalid("Execution operation metadata exceeds its bound.")
	}
	out := &golfv1.RepositoryExecutionValueMutationResponse{Target: m.target, OperationId: m.operation, Action: m.action, ItemId: m.id}
	e = s.withExecutionAdmin(ctx, header, m.target, func(_ forgeCredential, user User, _ *golfv1.RepositoryAccess) error {
		return s.workflowTransaction(ctx, s.cookieValue(header), user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte) error {
			if e := executionLifecycleGate(ctx, tx, s.config.GiteaURL, t.repo); e != nil {
				return e
			}
			observed, e := lockExecutionBroker(ctx, tx, s.config.GiteaURL, t, true)
			if e != nil {
				return e
			}
			var old []byte
			var action, id string
			var accepted, broker int64
			var at time.Time
			e = tx.QueryRowContext(ctx, `SELECT action,item_id::text,accepted_version,accepted_broker_revision,request_metadata,created_at FROM golf_execution_value_operations WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND user_id=$4 AND operation_id=$5`, s.config.GiteaURL, t.repo, t.owner, actor.UserID, m.operation).Scan(&action, &id, &accepted, &broker, &old, &at)
			if e == nil {
				var oldMeta any
				var newMeta any
				if json.Unmarshal(old, &oldMeta) != nil || json.Unmarshal(metadata, &newMeta) != nil || accessRevision(oldMeta) != accessRevision(newMeta) || action != m.action || id != m.id {
					return errExecutionValueConflict
				}
				if m.action == "save_value" {
					_, oldValue, e := s.openExecutionValue(ctx, tx, t, id, accepted)
					if e != nil {
						return e
					}
					if subtle.ConstantTimeCompare([]byte(oldValue), []byte(m.plain)) != 1 {
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
			if e = apply(tx, actor, hash, t, version); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `UPDATE golf_execution_value_brokers SET revision=revision+1 WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3`, s.config.GiteaURL, t.repo, t.owner); e != nil {
				return errStorageUnavailable
			}
			e = tx.QueryRowContext(ctx, `INSERT INTO golf_execution_value_operations(forge_url,repository_id,owner_id,user_id,operation_id,action,item_id,accepted_version,accepted_broker_revision,request_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at`, s.config.GiteaURL, t.repo, t.owner, actor.UserID, m.operation, m.action, m.id, version+1, revision+1, metadata).Scan(&at)
			if e != nil {
				return errStorageUnavailable
			}
			out.AcceptedVersion = strconv.FormatInt(version+1, 10)
			out.AcceptedBrokerRevision = strconv.FormatInt(revision+1, 10)
			out.CommittedAt = at.UTC().Format(time.RFC3339Nano)
			return nil
		})
	})
	return out, e
}
func (s *Server) SaveRepositoryExecutionValue(ctx context.Context, req *connect.Request[golfv1.SaveRepositoryExecutionValueRequest]) (*connect.Response[golfv1.SaveRepositoryExecutionValueResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	kind := executionKind(m.Kind)
	if kind == "" || !runner.ExecutionValueName(m.Name) || !runner.ExecutionValueBody(m.Value, kind == "secret") {
		return nil, executionMutationRPCError(invalid("Provide a safe uppercase name and a supported bounded single-line value."), nil)
	}
	metadata := struct{ ID, Version, Broker, Name, Kind string }{m.Id, m.ExpectedVersion, m.ExpectedBrokerRevision, m.Name, kind}
	result, e := s.executionMutation(ctx, req.Header(), executionMutation{m.Target, m.Id, m.OperationId, "save_value", m.ExpectedVersion, m.ExpectedBrokerRevision, metadata, m.Value}, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte, t executionTarget, version int64) error {
		r, e := scanExecutionValue(tx.QueryRowContext(ctx, `SELECT `+executionValueColumns+` FROM golf_execution_values WHERE id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4 FOR UPDATE`, m.Id, s.config.GiteaURL, t.repo, t.owner))
		if e == nil && (r.version != version || r.name != m.Name || r.kind != kind) {
			return errExecutionValueConflict
		}
		if errors.Is(e, sql.ErrNoRows) && version != 0 {
			return errExecutionValueConflict
		}
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		var names, history, activeBytes int
		if e = tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(value_bytes) FILTER(WHERE NOT deleted AND id<>$4),0),(SELECT count(*) FROM golf_execution_value_versions vv JOIN golf_execution_values v ON v.id=vv.id WHERE v.forge_url=$1 AND v.repository_id=$2 AND v.owner_id=$3) FROM golf_execution_values WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3`, s.config.GiteaURL, t.repo, t.owner, m.Id).Scan(&names, &activeBytes, &history); e != nil {
			return errStorageUnavailable
		}
		if version == 0 && names >= 64 || history >= executionRetainedVersionsLimit || activeBytes+len(m.Value) > runner.MaxExecutionEnvironmentBytes {
			return invalid("Repository execution value retention or active-value quota reached.")
		}
		if version == 0 {
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_execution_values(id,forge_url,repository_id,owner_id,name,kind,version,value_bytes) VALUES($1,$2,$3,$4,$5,$6,1,$7)`, m.Id, s.config.GiteaURL, t.repo, t.owner, m.Name, kind, len(m.Value))
		} else {
			_, e = tx.ExecContext(ctx, `UPDATE golf_execution_values SET version=version+1,deleted=false,value_bytes=$2,updated_at=clock_timestamp() WHERE id=$1`, m.Id, len(m.Value))
		}
		if e != nil {
			return errExecutionValueConflict
		}
		binding := executionValueBinding(m.Id, version+1, s.config.GiteaURL, t.repo, t.owner, m.Name, kind, len(m.Value))
		encrypted, key, e := s.keyring.seal(executionValueDomain, m.Value, binding)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_execution_value_versions(id,version,value_bytes,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6)`, m.Id, version+1, len(m.Value), encrypted, binding, key); e != nil {
			return errStorageUnavailable
		}
		return fenceExecutionValueRuns(ctx, tx, s.config.GiteaURL, m.Id)
	})
	if e != nil {
		return nil, executionMutationRPCError(e, result)
	}
	return connect.NewResponse(&golfv1.SaveRepositoryExecutionValueResponse{Operation: result}), nil
}
func (s *Server) DeleteRepositoryExecutionValue(ctx context.Context, req *connect.Request[golfv1.DeleteRepositoryExecutionValueRequest]) (*connect.Response[golfv1.DeleteRepositoryExecutionValueResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	metadata := struct{ ID, Version, Broker string }{m.Id, m.ExpectedVersion, m.ExpectedBrokerRevision}
	result, e := s.executionMutation(ctx, req.Header(), executionMutation{m.Target, m.Id, m.OperationId, "delete_value", m.ExpectedVersion, m.ExpectedBrokerRevision, metadata, ""}, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte, t executionTarget, version int64) error {
		// Deletion consumes a metadata version but stores no second plaintext/cipher.
		r, e := tx.ExecContext(ctx, `UPDATE golf_execution_values SET version=version+1,deleted=true,updated_at=clock_timestamp() WHERE id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4 AND version=$5 AND NOT deleted`, m.Id, s.config.GiteaURL, t.repo, t.owner, version)
		if e != nil {
			return errStorageUnavailable
		}
		n, _ := r.RowsAffected()
		if n != 1 {
			return errExecutionValueConflict
		}
		return fenceExecutionValueRuns(ctx, tx, s.config.GiteaURL, m.Id)
	})
	if e != nil {
		return nil, executionMutationRPCError(e, result)
	}
	return connect.NewResponse(&golfv1.DeleteRepositoryExecutionValueResponse{Operation: result}), nil
}
func fenceExecutionValueRuns(ctx context.Context, tx *sql.Tx, forge, id string) error {
	_, e := tx.ExecContext(ctx, `UPDATE golf_workflow_runs r SET state='cancelled',version=r.version+1,finished_at=clock_timestamp(),reason='Execution value approval or version changed.',lease_token_hash=NULL FROM golf_workflow_execution_bindings rb JOIN golf_execution_binding_versions b ON b.id=rb.binding_id AND b.version=rb.binding_version WHERE r.id=rb.run_id AND r.forge_url=$1 AND r.state IN ('queued','running') AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.value_refs) x WHERE x->>'id'=$2)`, forge, id)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}
func (s *Server) GetRepositoryExecutionVariable(ctx context.Context, req *connect.Request[golfv1.GetRepositoryExecutionVariableRequest]) (*connect.Response[golfv1.GetRepositoryExecutionVariableResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	t, e := parseExecutionTarget(req.Msg.Target)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	version, e := executionNumber(req.Msg.Version, false)
	if e != nil || !creationKey.MatchString(req.Msg.Id) {
		return nil, executionMutationRPCError(invalid("Select the exact current variable version."), nil)
	}
	out := &golfv1.GetRepositoryExecutionVariableResponse{Target: req.Msg.Target}
	e = s.withExecutionAdmin(ctx, req.Header(), req.Msg.Target, func(_ forgeCredential, u User, _ *golfv1.RepositoryAccess) error {
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), u.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			r, value, e := s.openExecutionValue(ctx, tx, t, req.Msg.Id, version)
			if e != nil {
				return e
			}
			if r.kind != "variable" || r.deleted || r.version != version {
				return errResourceNotFound
			}
			out.Variable = wireExecutionValue(r)
			out.Value = value
			return nil
		})
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	response := connect.NewResponse(out)
	response.Header().Set("Cache-Control", "no-store")
	return response, nil
}
func (s *Server) GetRepositoryExecutionValueOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryExecutionValueOperationRequest]) (*connect.Response[golfv1.GetRepositoryExecutionValueOperationResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	t, e := parseExecutionTarget(req.Msg.Target)
	if e != nil || !creationKey.MatchString(req.Msg.OperationId) {
		return nil, executionMutationRPCError(invalid("Select the exact operation and target."), nil)
	}
	out := &golfv1.RepositoryExecutionValueMutationResponse{Target: req.Msg.Target, OperationId: req.Msg.OperationId}
	e = s.withExecutionAdmin(ctx, req.Header(), req.Msg.Target, func(_ forgeCredential, u User, _ *golfv1.RepositoryAccess) error {
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), u.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			var version, revision int64
			var at time.Time
			e := tx.QueryRowContext(ctx, `SELECT action,item_id::text,accepted_version,accepted_broker_revision,created_at FROM golf_execution_value_operations WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND user_id=$4 AND operation_id=$5`, s.config.GiteaURL, t.repo, t.owner, actor.UserID, req.Msg.OperationId).Scan(&out.Action, &out.ItemId, &version, &revision, &at)
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
	return connect.NewResponse(&golfv1.GetRepositoryExecutionValueOperationResponse{Operation: out}), nil
}

// No-effect metadata is emitted only before a durable operation receipt could
// have been committed. A lost SQL/native acknowledgement stays inspect-only.
func executionMutationRPCError(e error, receipt *golfv1.RepositoryExecutionValueMutationResponse) error {
	if e == nil {
		return nil
	}
	wire := rpcError(e)
	if errors.Is(e, errExecutionValueConflict) {
		wire = connect.NewError(connect.CodeAborted, errors.New("Execution values or operation intent changed. Refresh and inspect the original operation."))
	}
	if errors.Is(e, errExecutionApproval) {
		wire = connect.NewError(connect.CodeFailedPrecondition, errors.New("The execution source approval or its authority is unavailable."))
	}
	var input inputError
	if (receipt == nil || receipt.CommittedAt == "") && (errors.Is(e, errExecutionValueConflict) || errors.Is(e, errExecutionApproval) || errors.As(e, &input)) {
		var ce *connect.Error
		if errors.As(wire, &ce) {
			ce.Meta().Set("Golf-Execution-Effect", "none")
		}
	}
	return wire
}
