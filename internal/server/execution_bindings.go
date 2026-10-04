package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type executionReference struct {
	ID             string `json:"id"`
	Version        string `json:"version"`
	Scope          string `json:"scope,omitempty"`
	OrganizationID string `json:"organizationId,omitempty"`
}

func executionReferences(values []*golfv1.RepositoryExecutionValueReference) ([]executionReference, error) {
	if len(values) < 1 || len(values) > 64 {
		return nil, invalid("Select one to 64 distinct immutable value versions.")
	}
	seen := map[string]bool{}
	out := make([]executionReference, 0, len(values))
	for _, v := range values {
		if v == nil || !creationKey.MatchString(v.Id) {
			return nil, invalid("Select distinct canonical value IDs.")
		}
		if _, e := executionNumber(v.Version, false); e != nil {
			return nil, e
		}
		ref := executionReference{ID: v.Id, Version: v.Version}
		switch v.Scope {
		case golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_UNSPECIFIED:
			if v.OrganizationId != "" {
				return nil, invalid("Repository values cannot select an organization scope.")
			}
		case golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_REPOSITORY:
			if v.OrganizationId != "" {
				return nil, invalid("Repository values cannot select an organization scope.")
			}
			ref.Scope = "repository"
		case golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_ORGANIZATION:
			if _, e := discussionID(v.OrganizationId); e != nil {
				return nil, e
			}
			ref.Scope = "organization"
			ref.OrganizationID = v.OrganizationId
		default:
			return nil, invalid("Select a supported explicit execution value scope.")
		}
		scope := ref.Scope
		if scope == "" {
			scope = "repository"
		}
		identity := scope + "/" + ref.OrganizationID + "/" + ref.ID
		if seen[identity] {
			return nil, invalid("Select distinct scoped immutable value IDs.")
		}
		seen[identity] = true
		out = append(out, ref)
	}
	// jsonb adds whitespace around separators; reserve its worst-case overhead.
	encoded, _ := json.Marshal(out)
	if len(encoded)+8*len(out) > 8192 {
		return nil, invalid("Selected value references exceed their retained metadata bound.")
	}
	return out, nil
}

type executionBindingRecord struct {
	id                                              string
	version                                         int64
	deleted                                         bool
	created, updated                                time.Time
	path, commit, blob, source, catalog, event, ref string
	values                                          []executionReference
	expires                                         time.Time
	approverUser, approverNative                    int64
	session                                         []byte
	organizations                                   []organizationExecutionApproval
}

const executionBindingColumns = `b.id::text,b.version,b.deleted,b.created_at,b.updated_at,v.workflow_path,v.commit_id,v.blob_id,v.source_sha256,v.engine_catalog,v.event,v.event_ref,v.value_refs,v.expires_at,v.approver_user_id,v.approver_native_id,v.approval_session_hash`

func scanExecutionBinding(row workflowRunScanner) (executionBindingRecord, error) {
	var b executionBindingRecord
	var values []byte
	e := row.Scan(&b.id, &b.version, &b.deleted, &b.created, &b.updated, &b.path, &b.commit, &b.blob, &b.source, &b.catalog, &b.event, &b.ref, &values, &b.expires, &b.approverUser, &b.approverNative, &b.session)
	if e == nil && json.Unmarshal(values, &b.values) != nil {
		e = errStorageUnavailable
	}
	return b, e
}
func wireExecutionBinding(b executionBindingRecord) *golfv1.RepositoryExecutionBinding {
	event := golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL
	if b.event == "push" {
		event = golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_PUSH
	}
	out := &golfv1.RepositoryExecutionBinding{Id: b.id, Version: strconv.FormatInt(b.version, 10), Deleted: b.deleted, CreatedAt: b.created.UTC().Format(time.RFC3339Nano), UpdatedAt: b.updated.UTC().Format(time.RFC3339Nano), WorkflowPath: b.path, CommitId: b.commit, WorkflowBlobId: b.blob, SourceSha256: b.source, EngineCatalog: b.catalog, Event: event, EventRef: b.ref, ExpiresAt: b.expires.UTC().Format(time.RFC3339Nano), ApprovalState: "requires_current_authority"}
	for _, r := range b.values {
		v := &golfv1.RepositoryExecutionValueReference{Id: r.ID, Version: r.Version}
		if r.Scope == "repository" {
			v.Scope = golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_REPOSITORY
		}
		if r.Scope == "organization" {
			v.Scope = golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_ORGANIZATION
			v.OrganizationId = r.OrganizationID
		}
		out.Values = append(out.Values, v)
	}
	return out
}
func listExecutionBindings(ctx context.Context, tx *sql.Tx, forge string, t executionTarget) ([]*golfv1.RepositoryExecutionBinding, error) {
	// A tombstone still displays its last immutable approval, with Deleted=true;
	// its incremented metadata version never revives that former release grant.
	rows, e := tx.QueryContext(ctx, `SELECT `+executionBindingColumns+` FROM golf_execution_bindings b JOIN golf_execution_binding_versions v ON v.id=b.id AND v.version=(SELECT max(version) FROM golf_execution_binding_versions WHERE id=b.id) WHERE b.forge_url=$1 AND b.repository_id=$2 AND b.owner_id=$3 ORDER BY b.created_at,b.id LIMIT 21`, forge, t.repo, t.owner)
	if e != nil {
		return nil, errStorageUnavailable
	}
	defer rows.Close()
	out := []*golfv1.RepositoryExecutionBinding{}
	for rows.Next() {
		b, e := scanExecutionBinding(rows)
		if e != nil {
			return nil, errStorageUnavailable
		}
		out = append(out, wireExecutionBinding(b))
	}
	if rows.Err() != nil || len(out) > 20 {
		return nil, errStorageUnavailable
	}
	return out, nil
}

// A native fork is not admitted by this initial source approval profile, even
// when the administrator also owns the fork. No PR/event payload is a trust grant.
func (s *Server) executionApprovalSource(ctx context.Context, token forgeCredential, t executionTarget, m *golfv1.SaveRepositoryExecutionBindingRequest) (string, string, *workflowExecutionPlan, []byte, error) {
	if !objectID.MatchString(m.CommitId) || !executionWorkflowPath(m.WorkflowPath) || m.WorkflowPath == ".gitlab-ci.yml" {
		return "", "", nil, nil, invalid("Select an exact commit and maintained Actions workflow.")
	}
	base, _ := repositoryPath(t.key)
	var native struct {
		ID       int64 `json:"id"`
		Owner    *User `json:"owner"`
		Fork     *bool `json:"fork"`
		Archived *bool `json:"archived"`
		Mirror   *bool `json:"mirror"`
	}
	_, e := s.forgeJSON(ctx, http.MethodGet, base, token, nil, &native, http.StatusOK)
	if e != nil {
		return "", "", nil, nil, e
	}
	if native.ID != t.repo || native.Owner == nil || native.Owner.ID != t.owner || native.Fork == nil || native.Archived == nil || native.Mirror == nil {
		return "", "", nil, nil, errInvalidForgeResponse
	}
	if *native.Fork || *native.Archived || *native.Mirror {
		return "", "", nil, nil, errExecutionApproval
	}
	pushRef := ""
	switch m.Event {
	case golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL:
		if m.EventRef != "" {
			return "", "", nil, nil, invalid("Manual source approvals do not take an event ref.")
		}
	case golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_PUSH:
		if !strings.HasPrefix(m.EventRef, "refs/heads/") || !validRef(m.EventRef) {
			return "", "", nil, nil, invalid("Push approvals require an exact heads ref.")
		}
		pushRef = m.EventRef
	default:
		return "", "", nil, nil, invalid("Select manual or push source approval.")
	}
	commit, blob, plan, source, e := s.prepareWorkflowRunForEvent(ctx, token, t.key, m.CommitId, m.WorkflowPath, pushRef)
	if e != nil {
		return "", "", nil, nil, e
	}
	if commit != m.CommitId || plan.Actions == nil || plan.Actions.Catalog != runner.ActionsCatalog {
		return "", "", nil, nil, errExecutionApproval
	}
	return commit, blob, plan, source, nil
}
func (s *Server) SaveRepositoryExecutionBinding(ctx context.Context, req *connect.Request[golfv1.SaveRepositoryExecutionBindingRequest]) (*connect.Response[golfv1.SaveRepositoryExecutionBindingResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	m := req.Msg
	t, e := parseExecutionTarget(m.Target)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	values, e := executionReferences(m.Values)
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	expiry, e := time.Parse(time.RFC3339Nano, m.ExpiresAt)
	if e != nil || !expiry.After(time.Now().Add(time.Minute)) || expiry.After(time.Now().Add(30*24*time.Hour)) {
		return nil, executionMutationRPCError(invalid("Select an approval expiry between one minute and 30 days."), nil)
	}
	// Native reads/planning precede all SQL locks. They cannot be made atomic
	// with native permission/ref edits; final native authority is independently read.
	var approverNative int64
	var commit, blob string
	var plan *workflowExecutionPlan
	var source []byte
	e = s.withExecutionAdmin(ctx, req.Header(), m.Target, func(token forgeCredential, user User, _ *golfv1.RepositoryAccess) error {
		approverNative = user.ID
		var err error
		commit, blob, plan, source, err = s.executionApprovalSource(ctx, token, t, m)
		return err
	})
	if e != nil {
		return nil, executionMutationRPCError(e, nil)
	}
	metadata := struct {
		ID, Version, Broker, Path, Commit, Event, Ref, Expires string
		Values                                                 []executionReference
	}{m.Id, m.ExpectedVersion, m.ExpectedBrokerRevision, m.WorkflowPath, m.CommitId, m.Event.String(), m.EventRef, m.ExpiresAt, values}
	result, e := s.executionMutation(ctx, req.Header(), executionMutation{m.Target, m.Id, m.OperationId, "save_binding", m.ExpectedVersion, m.ExpectedBrokerRevision, metadata, "", values}, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte, t executionTarget, version int64) error {
		if !expiry.Before(actor.ExpiresAt) || !expiry.After(time.Now()) {
			return invalid("Source approval must expire before the approving session.")
		}
		var current int64
		e := tx.QueryRowContext(ctx, `SELECT version FROM golf_execution_bindings WHERE id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4 FOR UPDATE`, m.Id, s.config.GiteaURL, t.repo, t.owner).Scan(&current)
		if e == nil && current != version || errors.Is(e, sql.ErrNoRows) && version != 0 {
			return errExecutionValueConflict
		}
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		var names, history int
		if e = tx.QueryRowContext(ctx, `SELECT count(*),(SELECT count(*) FROM golf_execution_binding_versions vv JOIN golf_execution_bindings b ON b.id=vv.id WHERE b.forge_url=$1 AND b.repository_id=$2 AND b.owner_id=$3) FROM golf_execution_bindings WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3`, s.config.GiteaURL, t.repo, t.owner).Scan(&names, &history); e != nil {
			return errStorageUnavailable
		}
		if version == 0 && names >= 20 || history >= 256 {
			return invalid("Source approval retention quota reached.")
		}
		total := 0
		namesSeen := map[string]bool{}
		for _, ref := range values {
			name, _, value, e := s.openExecutionReference(ctx, tx, t, ref)
			if e != nil {
				return e
			}
			if namesSeen[name] {
				return errExecutionApproval
			}
			namesSeen[name] = true
			total += len(value)
		}
		if total > runner.MaxExecutionEnvironmentBytes {
			return invalid("Approved value aggregate exceeds its bound.")
		}
		if version == 0 {
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_execution_bindings(id,forge_url,repository_id,owner_id,version) VALUES($1,$2,$3,$4,1)`, m.Id, s.config.GiteaURL, t.repo, t.owner)
		} else {
			_, e = tx.ExecContext(ctx, `UPDATE golf_execution_bindings SET version=version+1,deleted=false,updated_at=clock_timestamp() WHERE id=$1`, m.Id)
		}
		if e != nil {
			return errExecutionValueConflict
		}
		refs, _ := json.Marshal(values)
		event := "manual"
		if m.Event == golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_PUSH {
			event = "push"
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_execution_binding_versions(id,version,workflow_path,commit_id,blob_id,source_sha256,engine_catalog,event,event_ref,value_refs,approver_user_id,approver_native_id,approval_session_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, m.Id, version+1, m.WorkflowPath, commit, blob, sourceArchiveHash(source), plan.Actions.Catalog, event, m.EventRef, refs, actor.UserID, approverNative, hash, expiry)
		if e != nil {
			return errStorageUnavailable
		}
		return fenceExecutionBindingRuns(ctx, tx, s.config.GiteaURL, m.Id)
	})
	if e != nil {
		return nil, executionMutationRPCError(e, result)
	}
	return connect.NewResponse(&golfv1.SaveRepositoryExecutionBindingResponse{Operation: result}), nil
}
func (s *Server) DeleteRepositoryExecutionBinding(ctx context.Context, req *connect.Request[golfv1.DeleteRepositoryExecutionBindingRequest]) (*connect.Response[golfv1.DeleteRepositoryExecutionBindingResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	metadata := struct{ ID, Version, Broker string }{m.Id, m.ExpectedVersion, m.ExpectedBrokerRevision}
	result, e := s.executionMutation(ctx, req.Header(), executionMutation{m.Target, m.Id, m.OperationId, "delete_binding", m.ExpectedVersion, m.ExpectedBrokerRevision, metadata, "", nil}, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte, t executionTarget, version int64) error {
		r, e := tx.ExecContext(ctx, `UPDATE golf_execution_bindings SET version=version+1,deleted=true,updated_at=clock_timestamp() WHERE id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4 AND version=$5 AND NOT deleted`, m.Id, s.config.GiteaURL, t.repo, t.owner, version)
		if e != nil {
			return errStorageUnavailable
		}
		n, _ := r.RowsAffected()
		if n != 1 {
			return errExecutionValueConflict
		}
		return fenceExecutionBindingRuns(ctx, tx, s.config.GiteaURL, m.Id)
	})
	if e != nil {
		return nil, executionMutationRPCError(e, result)
	}
	return connect.NewResponse(&golfv1.DeleteRepositoryExecutionBindingResponse{Operation: result}), nil
}
func fenceExecutionBindingRuns(ctx context.Context, tx *sql.Tx, forge, id string) error {
	_, e := tx.ExecContext(ctx, `UPDATE golf_workflow_runs r SET state='cancelled',version=r.version+1,finished_at=clock_timestamp(),reason='Execution source approval changed.',lease_token_hash=NULL FROM golf_workflow_execution_bindings b WHERE r.id=b.run_id AND r.forge_url=$1 AND b.binding_id=$2 AND r.state IN ('queued','running')`, forge, id)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}
