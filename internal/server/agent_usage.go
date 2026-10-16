package server

import (
	"connectrpc.com/connect"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/codexaccount"
	"google.golang.org/protobuf/proto"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const agentSpendUnavailable = "Monetary spend caps cannot be enforced by the current agent executors. Set 0 for subscription execution with time and reported-token limits; paid API billing remains unavailable."

func agentDefaults() *golfv1.AgentUsageConfig {
	return &golfv1.AgentUsageConfig{TimeoutSeconds: 600, TokenBudget: 64000, MaxConcurrent: 1}
}
func (s *Server) agentAuthority(ctx context.Context, a codexActor, scope golfv1.AgentUsageScope, org string, repo *golfv1.RepositoryKey) (executionAuthority, error) {
	if scope == golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_PERSONAL {
		return executionAuthority{Scope: "personal", ID: strconv.FormatInt(a.UserID, 10), OwnerID: a.UserID, CanEdit: true, Revision: accessRevision(struct{ ID int64 }{a.UserID})}, nil
	}
	v := golfv1.ExecutionScope_EXECUTION_SCOPE_UNSPECIFIED
	switch scope {
	case golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_INSTANCE:
		v = golfv1.ExecutionScope_EXECUTION_SCOPE_INSTANCE
	case golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_ORGANIZATION:
		v = golfv1.ExecutionScope_EXECUTION_SCOPE_ORGANIZATION
	case golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_REPOSITORY:
		v = golfv1.ExecutionScope_EXECUTION_SCOPE_REPOSITORY
	}
	caller, e := s.currentUser(ctx, a.Credential)
	if e != nil {
		return executionAuthority{}, e
	}
	if v == golfv1.ExecutionScope_EXECUTION_SCOPE_INSTANCE {
		if !a.Admin {
			return executionAuthority{}, errCodexPermission
		}
		return executionAuthority{Scope: "instance", ID: "instance", CanEdit: true, Revision: accessRevision(struct {
			ID    int64
			Admin bool
		}{a.UserID, true})}, nil
	}
	auth, e := s.executionAuthority(ctx, "", a.Credential, v, org, keyFrom(repo), caller)
	if e == nil && !auth.CanEdit {
		return auth, errCodexPermission
	}
	return auth, e
}
func (s *Server) loadAgentConfig(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, scope, id string) (*golfv1.AgentUsageConfig, int64, int64, error) {
	var raw []byte
	var rev, owner int64
	e := q.QueryRowContext(ctx, `SELECT config,revision,owner_id FROM golf_agent_usage_settings WHERE forge_url=$1 AND scope=$2 AND scope_id=$3`, s.config.ForgeURL, scope, id).Scan(&raw, &rev, &owner)
	if errors.Is(e, sql.ErrNoRows) {
		return agentDefaults(), 0, 0, nil
	}
	if e != nil {
		return nil, 0, 0, errStorageUnavailable
	}
	c := new(golfv1.AgentUsageConfig)
	if json.Unmarshal(raw, c) != nil {
		return nil, 0, 0, errStorageUnavailable
	}
	return c, rev, owner, nil
}
func agentConfigValid(c *golfv1.AgentUsageConfig) error {
	if c != nil && c.SpendLimitCents != 0 {
		return invalid(agentSpendUnavailable)
	}
	if c == nil || c.TimeoutSeconds < 30 || c.TimeoutSeconds > 7200 || c.TokenBudget < 1000 || c.TokenBudget > 2000000 || c.SpendLimitCents > 100000 || c.MaxConcurrent < 1 || c.MaxConcurrent > 32 || len(c.Instructions) > 8192 || !utf8.ValidString(c.Instructions) || strings.ContainsRune(c.Instructions, 0) || len(c.AllowedModels) > 100 || len(c.Triggers) > 5 || c.AllowAllModels && len(c.AllowedModels) > 0 {
		return invalid("Provide bounded agent limits, instructions and model/trigger selections.")
	}
	seen := map[string]bool{}
	for _, t := range c.Triggers {
		if seen[t] || !(t == "manual" || t == "push" || t == "pr_open" || t == "pr_comment" || t == "issue_comment") {
			return invalid("Select unique supported task triggers.")
		}
		seen[t] = true
	}
	seen = map[string]bool{}
	for _, m := range c.AllowedModels {
		if !codexaccount.ModelToken(m) || seen[m] {
			return invalid("Allowed models must be unique catalog identifiers.")
		}
		seen[m] = true
	}
	if c.ConnectionId != "" {
		id, e := uuid.Parse(c.ConnectionId)
		if e != nil || id.String() != c.ConnectionId {
			return invalid("Select an existing agent connection.")
		}
	}
	if c.ModelId != "" && !codexaccount.ModelToken(c.ModelId) || c.Reasoning != "" && !codexaccount.ModelToken(c.Reasoning) {
		return invalid("Select a supported model and reasoning option.")
	}
	if (c.ConnectionId == "") != (c.ModelId == "") {
		return invalid("Enabled defaults need a connected account and model.")
	}
	return nil
}
func agentModelAllowed(c *golfv1.AgentUsageConfig, key string) bool {
	if c.AllowAllModels {
		return true
	}
	for _, m := range c.AllowedModels {
		if m == key {
			return true
		}
	}
	return false
}
func agentInherit(e, parent *golfv1.AgentUsageConfig) {
	if e.ConnectionId == "" {
		e.ConnectionId = parent.ConnectionId
		e.ModelId = parent.ModelId
		e.Reasoning = parent.Reasoning
	}
	if parent.Instructions != "" {
		e.Instructions = parent.Instructions + "\n\n" + e.Instructions
	}
}
func agentIntersect(e, c *golfv1.AgentUsageConfig, key string) {
	e.Enabled = e.Enabled && c.Enabled && agentModelAllowed(c, key)
	e.TimeoutSeconds = min(e.TimeoutSeconds, c.TimeoutSeconds)
	e.TokenBudget = min(e.TokenBudget, c.TokenBudget)
	// Zero cannot erase a positive inherited cap that this executor cannot honor.
	if e.SpendLimitCents == 0 {
		e.SpendLimitCents = c.SpendLimitCents
	} else if c.SpendLimitCents != 0 {
		e.SpendLimitCents = min(e.SpendLimitCents, c.SpendLimitCents)
	}
	e.MaxConcurrent = min(e.MaxConcurrent, c.MaxConcurrent)
	e.AllowTaskOverrides = e.AllowTaskOverrides && c.AllowTaskOverrides
	var ts []string
	for _, t := range e.Triggers {
		for _, v := range c.Triggers {
			if t == v {
				ts = append(ts, t)
				break
			}
		}
	}
	e.Triggers = ts
}
func (s *Server) agentSettings(ctx context.Context, a codexActor, auth executionAuthority, scope golfv1.AgentUsageScope, repo *golfv1.RepositoryKey, overrides ...*golfv1.AgentTaskSelection) (*golfv1.AgentUsageSettings, error) {
	c, rev, owner, e := s.loadAgentConfig(ctx, s.db, auth.Scope, auth.ID)
	if e != nil {
		return nil, e
	}
	if rev > 0 && owner != auth.OwnerID {
		return nil, errExecutionPolicyConflict
	}
	v := &golfv1.AgentUsageSettings{Scope: scope, ScopeId: auth.ID, Revision: strconv.FormatInt(rev, 10), AuthorityRevision: auth.Revision, CanEdit: auth.CanEdit, Config: c, Effective: proto.Clone(c).(*golfv1.AgentUsageConfig), BlockedReasons: []string{"Managed Codex tasks and configured OpenCode Go PR reviewers use the local worker. OpenCode conversation and workflow steps require separate exact ACP image/version/policy receipts; other automatic agent triggers remain unavailable."}}
	if len(overrides) > 0 && overrides[0] != nil {
		o := overrides[0]
		if o.ConnectionId != "" {
			v.Effective.ConnectionId = o.ConnectionId
			v.Effective.ModelId = o.ModelId
			v.Effective.Reasoning = o.Reasoning
		}
		v.Effective.Instructions += "\n\n" + o.Instructions
		if o.TimeoutSeconds != nil {
			v.Effective.TimeoutSeconds = *o.TimeoutSeconds
		}
		if o.TokenBudget != nil {
			v.Effective.TokenBudget = *o.TokenBudget
		}
		if o.SpendLimitCents != nil {
			v.Effective.SpendLimitCents = *o.SpendLimitCents
		}
		if o.MaxConcurrent != nil {
			v.Effective.MaxConcurrent = *o.MaxConcurrent
		}
	}
	if scope == golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_REPOSITORY {
		row, _, e := s.readRepositorySettings(ctx, a.Credential, keyFrom(repo))
		if e != nil {
			return nil, e
		}
		org, e := s.repositoryOwnerKind(ctx, a.Credential, *row.Owner)
		if e != nil {
			return nil, e
		}
		if org {
			parent, _, owner, e := s.loadAgentConfig(ctx, s.db, "organization", strconv.FormatInt(row.Owner.ID, 10))
			if e != nil {
				return nil, e
			}
			if owner != 0 && owner != row.Owner.ID {
				return nil, errExecutionPolicyConflict
			}
			agentInherit(v.Effective, parent)
			agentIntersect(v.Effective, parent, v.Effective.ModelId)
		}
	}
	if scope != golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_INSTANCE {
		parent, _, _, e := s.loadAgentConfig(ctx, s.db, "instance", "instance")
		if e != nil {
			return nil, e
		}
		agentInherit(v.Effective, parent)
		agentIntersect(v.Effective, parent, v.Effective.ModelId)
	}
	if v.Effective.ModelId != "" {
		agentIntersect(v.Effective, c, v.Effective.ModelId)
	}
	if !v.Effective.Enabled {
		v.BlockedReasons = append(v.BlockedReasons, "Disabled or denied by a required model/scope ceiling.")
	}
	if v.Effective.ConnectionId != "" {
		r, e := s.codexAuthorized(ctx, a, v.Effective.ConnectionId, false)
		if e != nil || r.State != "CONNECTED" || !r.Use && r.Scope == "INSTANCE" {
			v.Effective.Enabled = false
			v.BlockedReasons = append(v.BlockedReasons, "Selected connection is not connected or not permitted for this user.")
		} else if r.Scope == "PERSONAL" && scope != golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_PERSONAL {
			personal, _, owner, e := s.loadAgentConfig(ctx, s.db, "personal", strconv.FormatInt(a.UserID, 10))
			if e != nil {
				return nil, e
			}
			if owner != 0 && owner != a.UserID {
				return nil, errCodexPermission
			}
			if personal.SpendLimitCents != 0 && (v.Effective.SpendLimitCents == 0 || personal.SpendLimitCents < v.Effective.SpendLimitCents) {
				v.Effective.SpendLimitCents = personal.SpendLimitCents
			}
		}
	}
	if v.Effective.SpendLimitCents != 0 {
		v.Effective.Enabled = false
		v.BlockedReasons = append(v.BlockedReasons, agentSpendUnavailable)
	}
	if v.Effective.Enabled && (v.Effective.ConnectionId == "" || v.Effective.ModelId == "") {
		v.Effective.Enabled = false
		v.BlockedReasons = append(v.BlockedReasons, "No account/model default selected.")
	}
	v.ExecutionAvailable = s.agentAvailable(ctx)
	if !v.ExecutionAvailable {
		v.BlockedReasons = append(v.BlockedReasons, "Managed agent worker is not connected.")
	}
	return v, nil
}
func (s *Server) GetAgentUsage(ctx context.Context, req *connect.Request[golfv1.GetAgentUsageRequest]) (*connect.Response[golfv1.GetAgentUsageResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	auth, e := s.agentAuthority(ctx, a, req.Msg.Scope, req.Msg.Organization, req.Msg.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	v, e := s.agentSettings(ctx, a, auth, req.Msg.Scope, req.Msg.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	final, e := s.agentAuthority(ctx, a, req.Msg.Scope, req.Msg.Organization, req.Msg.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	if final.Revision != auth.Revision {
		return nil, rpcError(errExecutionPolicyConflict)
	}
	if e = s.codexGuard(ctx, a, func(*sql.Tx, int64) error { return nil }); e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetAgentUsageResponse{Settings: v}), nil
}
func (s *Server) SaveAgentUsage(ctx context.Context, req *connect.Request[golfv1.SaveAgentUsageRequest]) (*connect.Response[golfv1.SaveAgentUsageResponse], error) {
	m := req.Msg
	if e := agentConfigValid(m.Config); e != nil {
		return nil, rpcError(e)
	}
	rev, e := strconv.ParseInt(m.ExpectedRevision, 10, 64)
	if e != nil || rev < 0 || strconv.FormatInt(rev, 10) != m.ExpectedRevision {
		return nil, rpcError(invalid("Provide the observed revision."))
	}
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	auth, e := s.agentAuthority(ctx, a, m.Scope, m.Organization, m.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	if auth.ID != m.ScopeId || auth.Revision != m.ExpectedAuthorityRevision {
		return nil, rpcError(errExecutionPolicyConflict)
	}
	if m.Config.ConnectionId != "" {
		r, e := s.codexAuthorized(ctx, a, m.Config.ConnectionId, false)
		if e != nil {
			return nil, rpcError(e)
		}
		if r.State != "CONNECTED" || r.Scope == "INSTANCE" && !r.Use || auth.Scope != "personal" && r.Scope != "INSTANCE" {
			return nil, rpcError(invalid("Select a connected permitted account; shared scope defaults require an instance account."))
		}
		var raw []byte
		e = s.db.QueryRowContext(ctx, `SELECT models FROM golf_agent_model_catalogs WHERE connection_id=$1 AND connection_version=$2`, r.ID, r.Version).Scan(&raw)
		var models []codexaccount.Model
		if e != nil || json.Unmarshal(raw, &models) != nil {
			return nil, rpcError(invalid("Refresh this connection's model catalog before saving."))
		}
		found := false
		for _, model := range models {
			if model.ID == m.Config.ModelId {
				found = m.Config.Reasoning == ""
				for _, eff := range model.Reasoning {
					if eff == m.Config.Reasoning {
						found = true
					}
				}
			}
		}
		if !found {
			return nil, rpcError(invalid("Select a model and reasoning option from this connection's catalog."))
		}
	}
	final, e := s.agentAuthority(ctx, a, m.Scope, m.Organization, m.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	if final.Revision != auth.Revision {
		return nil, rpcError(errExecutionPolicyConflict)
	}
	a.RequireAdmin = auth.Scope == "instance"
	raw, _ := json.Marshal(m.Config)
	e = s.codexGuard(ctx, a, func(tx *sql.Tx, user int64) error {
		if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.config.ForgeURL+"/agent-policy/"+auth.Scope+"/"+auth.ID); e != nil {
			return errStorageUnavailable
		}
		if m.Config.ConnectionId != "" {
			var permitted bool
			e := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_codex_connections c WHERE c.id=$1 AND c.forge_url=$2 AND c.state='CONNECTED' AND EXISTS(SELECT 1 FROM golf_agent_model_catalogs mc WHERE mc.connection_id=c.id AND mc.connection_version=c.version AND EXISTS(SELECT 1 FROM jsonb_array_elements(mc.models) m WHERE m->>'id'=$5::text AND ($6::text='' OR COALESCE(m->'reasoning','[]'::jsonb) @> to_jsonb(ARRAY[$6::text])))) AND ((c.scope='PERSONAL' AND c.user_id=$3 AND $4='personal') OR (c.scope='INSTANCE' AND EXISTS(SELECT 1 FROM golf_codex_connection_access x JOIN golf_local_accounts l ON l.user_id=x.user_id WHERE x.connection_id=c.id AND x.user_id=$3 AND l.disabled_at IS NULL))))`, m.Config.ConnectionId, s.config.ForgeURL, user, auth.Scope, m.Config.ModelId, m.Config.Reasoning).Scan(&permitted)
			if e != nil {
				return errStorageUnavailable
			}
			if !permitted {
				return errCodexPermission
			}
		}
		if _, e := tx.ExecContext(ctx, `INSERT INTO golf_agent_usage_settings(forge_url,scope,scope_id,owner_id,config) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, s.config.ForgeURL, auth.Scope, auth.ID, auth.OwnerID, raw); e != nil {
			return errStorageUnavailable
		}
		result, e := tx.ExecContext(ctx, `UPDATE golf_agent_usage_settings SET config=$1,revision=revision+1,updated_at=now() WHERE forge_url=$2 AND scope=$3 AND scope_id=$4 AND revision=$5 AND owner_id=$6`, raw, s.config.ForgeURL, auth.Scope, auth.ID, rev, auth.OwnerID)
		if e != nil {
			return errStorageUnavailable
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			return errExecutionPolicyConflict
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_agent_usage_events(forge_url,scope,scope_id,revision,actor_user_id) VALUES($1,$2,$3,$4,$5)`, s.config.ForgeURL, auth.Scope, auth.ID, rev+1, user)
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	v, e := s.agentSettings(ctx, a, auth, m.Scope, m.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.SaveAgentUsageResponse{Settings: v}), nil
}
func (s *Server) ListAgentModels(ctx context.Context, req *connect.Request[golfv1.ListAgentModelsRequest]) (*connect.Response[golfv1.ListAgentModelsResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	r, e := s.codexAuthorized(ctx, a, req.Msg.ConnectionId, false)
	if e != nil {
		return nil, rpcError(e)
	}
	if r.ID == "" || r.State != "CONNECTED" || r.Scope == "INSTANCE" && !r.Use {
		return nil, rpcError(errCodexPermission)
	}
	var models []codexaccount.Model
	var raw []byte
	var checked time.Time
	cached := s.db.QueryRowContext(ctx, `SELECT models,checked_at FROM golf_agent_model_catalogs WHERE connection_id=$1 AND connection_version=$2`, r.ID, r.Version).Scan(&raw, &checked) == nil && json.Unmarshal(raw, &models) == nil
	if !cached || req.Msg.Refresh {
		if r.Scope == "INSTANCE" && !a.Admin {
			return connect.NewResponse(&golfv1.ListAgentModelsResponse{Reason: "Ask an authentication manager to refresh this connection's native model catalog."}), nil
		}
		a.RequireAdmin = r.Scope == "INSTANCE"
		rt, e := s.codexOpen(ctx, a, r)
		if e != nil {
			return nil, rpcError(e)
		}
		rt.mu.Lock()
		defer rt.mu.Unlock()
		if rt.closed || rt.record.Version != r.Version || !codexOwnerAlive(ctx, rt) {
			return nil, rpcError(errCodexConflict)
		}
		source, ok := rt.process.(interface {
			Models(context.Context) ([]codexaccount.Model, error)
		})
		if !ok {
			return nil, rpcError(errCodexUnavailable)
		}
		models, e = source.Models(ctx)
		if e != nil {
			return connect.NewResponse(&golfv1.ListAgentModelsResponse{Reason: "Native model discovery is unavailable. No model access was verified."}), nil
		}
		rt.actor = a
		next := rt.record
		next.Action = "CODEX_CONNECTION_REFRESHED"
		if e = s.codexSave(ctx, rt, next); e != nil {
			s.closeCodexLocked(rt)
			return nil, rpcError(e)
		}
		r = rt.record
		raw, _ = json.Marshal(models)
		checked = time.Now().UTC()
		e = s.codexGuard(ctx, a, func(tx *sql.Tx, _ int64) error {
			var version int64
			if e := tx.QueryRowContext(ctx, `SELECT version FROM golf_codex_connections WHERE id=$1 FOR SHARE`, r.ID).Scan(&version); e != nil || version != r.Version {
				return errCodexConflict
			}
			_, e := tx.ExecContext(ctx, `INSERT INTO golf_agent_model_catalogs(connection_id,connection_version,models,checked_at) VALUES($1,$2,$3,$4) ON CONFLICT(connection_id) DO UPDATE SET connection_version=EXCLUDED.connection_version,models=EXCLUDED.models,checked_at=EXCLUDED.checked_at`, r.ID, r.Version, raw, checked)
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		})
		if e != nil {
			return nil, rpcError(e)
		}
	}
	// A second current authorization check denies grants revoked during discovery.
	fresh, e := s.codexAuthorized(ctx, a, r.ID, false)
	if e != nil {
		return nil, rpcError(e)
	}
	if fresh.State != "CONNECTED" || fresh.Version != r.Version || fresh.Scope == "INSTANCE" && !fresh.Use {
		return nil, rpcError(errCodexConflict)
	}
	out := &golfv1.ListAgentModelsResponse{CheckedAt: checked.UTC().Format(time.RFC3339Nano)}
	for _, m := range models {
		out.Models = append(out.Models, &golfv1.AgentModel{Id: m.ID, Name: m.Name, Reasoning: m.Reasoning, Source: m.Source})
	}
	return connect.NewResponse(out), nil
}

// Preview resolves permitted choices without a queue entry, model request or write.
func (s *Server) PreviewAgentTask(ctx context.Context, req *connect.Request[golfv1.PreviewAgentTaskRequest]) (*connect.Response[golfv1.PreviewAgentTaskResponse], error) {
	if o := req.Msg.Selection; o != nil && o.SpendLimitCents != nil && *o.SpendLimitCents != 0 {
		return nil, rpcError(invalid(agentSpendUnavailable))
	}
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	auth, e := s.agentAuthority(ctx, a, req.Msg.Scope, req.Msg.Organization, req.Msg.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	baseline, e := s.agentSettings(ctx, a, auth, req.Msg.Scope, req.Msg.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	o := req.Msg.Selection
	if o != nil && o.Trigger != "" {
		valid := false
		for _, t := range []string{"manual", "push", "pr_open", "pr_comment", "issue_comment"} {
			if t == o.Trigger {
				valid = true
			}
		}
		if !valid {
			return nil, rpcError(invalid("Select a supported task trigger."))
		}
	}
	if o == nil {
		return connect.NewResponse(&golfv1.PreviewAgentTaskResponse{Settings: baseline}), nil
	}
	if !baseline.Effective.AllowTaskOverrides {
		return nil, rpcError(invalid("Per-task overrides are denied by a required scope."))
	}
	candidate := proto.Clone(baseline.Effective).(*golfv1.AgentUsageConfig)
	if o.ConnectionId != "" {
		candidate.ConnectionId = o.ConnectionId
		candidate.ModelId = o.ModelId
		candidate.Reasoning = o.Reasoning
	} else if o.ModelId != "" || o.Reasoning != "" {
		return nil, rpcError(invalid("Bind a model choice to its account connection."))
	}
	candidate.Instructions = o.Instructions
	if o.TimeoutSeconds != nil {
		candidate.TimeoutSeconds = *o.TimeoutSeconds
	}
	if o.TokenBudget != nil {
		candidate.TokenBudget = *o.TokenBudget
	}
	if o.SpendLimitCents != nil {
		candidate.SpendLimitCents = *o.SpendLimitCents
	}
	if o.MaxConcurrent != nil {
		candidate.MaxConcurrent = *o.MaxConcurrent
	}
	if e = agentConfigValid(candidate); e != nil {
		return nil, rpcError(e)
	}
	if candidate.ConnectionId != "" {
		r, e := s.codexAuthorized(ctx, a, candidate.ConnectionId, false)
		if e != nil {
			return nil, rpcError(e)
		}
		if r.State != "CONNECTED" || r.Scope == "INSTANCE" && !r.Use {
			return nil, rpcError(errCodexPermission)
		}
		var raw []byte
		var models []codexaccount.Model
		e = s.db.QueryRowContext(ctx, `SELECT models FROM golf_agent_model_catalogs WHERE connection_id=$1 AND connection_version=$2`, r.ID, r.Version).Scan(&raw)
		if e != nil || json.Unmarshal(raw, &models) != nil {
			return nil, rpcError(invalid("Refresh the selected connection catalog."))
		}
		found := false
		for _, m := range models {
			if m.ID == candidate.ModelId {
				found = candidate.Reasoning == ""
				for _, eff := range m.Reasoning {
					if eff == candidate.Reasoning {
						found = true
					}
				}
			}
		}
		if !found {
			return nil, rpcError(invalid("The selected model/variant is not in this connection catalog."))
		}
	}
	v, e := s.agentSettings(ctx, a, auth, req.Msg.Scope, req.Msg.Repository, o)
	if e != nil {
		return nil, rpcError(e)
	}
	if o.Trigger != "" {
		allowed := false
		for _, t := range v.Effective.Triggers {
			if t == o.Trigger {
				allowed = true
			}
		}
		if !allowed {
			v.Effective.Enabled = false
			v.BlockedReasons = append(v.BlockedReasons, "Selected trigger is denied by a required scope.")
		}
		v.Effective.Triggers = []string{o.Trigger}
	}
	final, e := s.agentAuthority(ctx, a, req.Msg.Scope, req.Msg.Organization, req.Msg.Repository)
	if e != nil {
		return nil, rpcError(e)
	}
	if final.Revision != auth.Revision {
		return nil, rpcError(errExecutionPolicyConflict)
	}
	if e = s.codexGuard(ctx, a, func(*sql.Tx, int64) error { return nil }); e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.PreviewAgentTaskResponse{Settings: v}), nil
}
