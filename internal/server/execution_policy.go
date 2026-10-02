package server

import (
	"connectrpc.com/connect"
	"context"
	"database/sql"
	"errors"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

var errExecutionPolicyConflict = errors.New("execution policy changed")

type executionPolicyState struct {
	Scope, ScopeID, Mode                                  string
	OwnerID                                               int64
	Revision, RevocationEpoch                             int64
	ManualDispatchEnabled, PushAllowed, AllowAllWorkflows bool
	Repositories                                          map[int64]int64
	Workflows                                             []string
}

// A workflow source is an exact path, not a glob or a policy program. Selection
// of every workflow is a distinct explicit boolean; an empty list denies all.
func executionWorkflowPath(path string) bool {
	if len(path) > 255 {
		return false
	}
	if path == ".gitlab-ci.yml" {
		return true
	}
	const prefix = ".github/workflows/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	name := strings.TrimPrefix(path, prefix)
	if name == "" || strings.ContainsAny(name, "/\\\x00\r\n\t") || strings.Contains(name, "..") || strings.ContainsAny(name, "*?[]{}") {
		return false
	}
	if !strings.HasSuffix(name, ".yml") && !strings.HasSuffix(name, ".yaml") {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}

func executionPolicyAllows(policy executionPolicyState, repositoryID, ownerID int64, event, path string) bool {
	if repositoryID <= 0 || ownerID <= 0 || !executionWorkflowPath(path) {
		return false
	}
	switch event {
	case "manual":
		if !policy.ManualDispatchEnabled {
			return false
		}
	case "push":
		if !policy.PushAllowed {
			return false
		}
	default:
		return false
	}
	if policy.Scope == "repository" && (policy.ScopeID != strconv.FormatInt(repositoryID, 10) || policy.OwnerID != ownerID) {
		return false
	}
	if policy.Scope == "organization" && (policy.ScopeID != strconv.FormatInt(ownerID, 10) || policy.OwnerID != ownerID) {
		return false
	}
	switch policy.Mode {
	case "all":
	case "selected":
		if selectedOwner, ok := policy.Repositories[repositoryID]; !ok || selectedOwner != ownerID {
			return false
		}
	default:
		return false
	}
	if policy.AllowAllWorkflows {
		return true
	}
	for _, selected := range policy.Workflows {
		if selected == path {
			return true
		}
	}
	return false
}

// Every required ceiling must exist and allow the exact current immutable
// repository/owner binding. Missing policy is disabled; repository input and
// user preferences cannot create or weaken a higher-scope grant.
func executionPoliciesAllow(policies []executionPolicyState, repositoryID, ownerID int64, organizationOwned bool, event, path string) bool {
	required := map[string]bool{"instance": false, "repository": false}
	if organizationOwned {
		required["organization"] = false
	}
	for _, policy := range policies {
		if _, ok := required[policy.Scope]; !ok {
			return false
		}
		if required[policy.Scope] || !executionPolicyAllows(policy, repositoryID, ownerID, event, path) {
			return false
		}
		if policy.Scope == "instance" && (policy.ScopeID != "instance" || policy.OwnerID != 0) {
			return false
		}
		required[policy.Scope] = true
	}
	for _, allowed := range required {
		if !allowed {
			return false
		}
	}
	return true
}

func (s *Server) executionSelectedRepository(ctx context.Context, token forgeCredential, id int64) (forgeRepositorySettings, error) {
	var row forgeRepositorySettings
	_, err := s.forgeJSON(ctx, http.MethodGet, "/repositories/"+strconv.FormatInt(id, 10), token, nil, &row, http.StatusOK)
	if err != nil {
		return row, err
	}
	if row.ID != id || row.Owner == nil || row.Owner.ID <= 0 || !validOrganizationName(row.Owner.Login) || !validOrganizationName(row.Name) {
		return row, errInvalidForgeResponse
	}
	if _, err := wireRepositorySettings(row, repositoryKey{row.Owner.Login, row.Name}); err != nil {
		return row, err
	}
	return row, nil
}

func executionScopeName(scope golfv1.ExecutionScope) string {
	switch scope {
	case golfv1.ExecutionScope_EXECUTION_SCOPE_INSTANCE:
		return "instance"
	case golfv1.ExecutionScope_EXECUTION_SCOPE_ORGANIZATION:
		return "organization"
	case golfv1.ExecutionScope_EXECUTION_SCOPE_REPOSITORY:
		return "repository"
	}
	return ""
}
func executionModeName(mode golfv1.ExecutionMode) string {
	switch mode {
	case golfv1.ExecutionMode_EXECUTION_MODE_DISABLED:
		return "disabled"
	case golfv1.ExecutionMode_EXECUTION_MODE_ALL:
		return "all"
	case golfv1.ExecutionMode_EXECUTION_MODE_SELECTED:
		return "selected"
	}
	return ""
}
func executionWireMode(mode string) golfv1.ExecutionMode {
	switch mode {
	case "all":
		return golfv1.ExecutionMode_EXECUTION_MODE_ALL
	case "selected":
		return golfv1.ExecutionMode_EXECUTION_MODE_SELECTED
	}
	return golfv1.ExecutionMode_EXECUTION_MODE_DISABLED
}

type executionAuthority struct {
	Scope, ID string
	OwnerID   int64
	CanEdit   bool
	Revision  string
}

func (s *Server) executionAuthority(ctx context.Context, value string, token forgeCredential, scope golfv1.ExecutionScope, organization string, key repositoryKey, caller User) (executionAuthority, error) {
	a := executionAuthority{Scope: executionScopeName(scope)}
	switch a.Scope {
	case "instance":
		if err := s.requireInstanceAdmin(ctx, value, token); err != nil {
			return a, err
		}
		a.ID = "instance"
		a.CanEdit = true
	case "organization":
		if !validOrganizationName(organization) {
			return a, invalid("Organization must be a valid name component.")
		}
		if err := s.requireOrganizationMember(ctx, token, organization, caller.Login); err != nil {
			return a, err
		}
		var org forgeOrganization
		if _, err := s.forge(ctx, http.MethodGet, "/orgs/"+organization, token, nil, &org); err != nil {
			return a, err
		}
		if !validOrganization(org) || !strings.EqualFold(org.Name, organization) {
			return a, errInvalidForgeResponse
		}
		owner, err := s.organizationOwner(ctx, token, org, caller)
		if err != nil {
			return a, err
		}
		// Organization policy metadata contains selected private repository IDs.
		if !owner {
			return a, forgeError{http.StatusForbidden}
		}
		a.ID = strconv.FormatInt(org.ID, 10)
		a.OwnerID = org.ID
		a.CanEdit = true
		a.Revision = accessRevision(struct {
			Org    forgeOrganization
			Caller int64
			Owner  bool
		}{org, caller.ID, owner})
	case "repository":
		row, _, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return a, err
		}
		org, err := s.repositoryOwnerKind(ctx, token, *row.Owner)
		if err != nil {
			return a, err
		}
		base, _ := repositoryPath(key)
		permission, err := s.repositoryPermission(ctx, token, base, caller)
		if err != nil {
			return a, err
		}
		allowed := false
		if row.Permissions.Admin && !*row.Archived && !*row.Mirror {
			if !org && row.Owner.ID == caller.ID && permission == "owner" {
				allowed = true
			} else if permission == "admin" {
				allowed, err = s.directCollaborator(ctx, token, base, caller)
				if err != nil {
					return a, err
				}
			}
			if org && !allowed {
				orgRow := forgeOrganization{ID: row.Owner.ID, Name: row.Owner.Login}
				allowed, err = s.organizationOwner(ctx, token, orgRow, caller)
				if err != nil {
					return a, err
				}
			}
		}
		a.ID = strconv.FormatInt(row.ID, 10)
		a.OwnerID = row.Owner.ID
		a.CanEdit = allowed
		a.Revision = accessRevision(struct {
			Repo, Owner, Caller                  int64
			Name, Permission                     string
			Private, Archived, Mirror, Org, Edit bool
		}{row.ID, row.Owner.ID, caller.ID, strings.ToLower(row.FullName), permission, row.Private, *row.Archived, *row.Mirror, org, allowed})
	default:
		return a, invalid("Select an execution policy scope.")
	}
	if a.Revision == "" {
		a.Revision = accessRevision(struct {
			Scope, ID string
			Caller    int64
			Edit      bool
		}{a.Scope, a.ID, caller.ID, a.CanEdit})
	}
	return a, nil
}

func (s *Server) loadExecutionPolicy(ctx context.Context, q *database.Queries, a executionAuthority, lock bool) (executionPolicyState, error) {
	var row database.GolfExecutionPolicy
	var err error
	if lock {
		row, err = q.LockExecutionPolicy(ctx, database.LockExecutionPolicyParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID})
	} else {
		row, err = q.GetExecutionPolicy(ctx, database.GetExecutionPolicyParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID})
	}
	state := executionPolicyState{Scope: a.Scope, ScopeID: a.ID, OwnerID: a.OwnerID, Mode: "disabled", Repositories: map[int64]int64{}}
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, errStorageUnavailable
	}
	state.OwnerID = row.OwnerID
	state.Mode = row.Mode
	state.Revision = row.Revision
	state.RevocationEpoch = row.RevocationEpoch
	state.ManualDispatchEnabled = row.ManualDispatchEnabled
	state.PushAllowed = row.PushAllowed
	state.AllowAllWorkflows = row.AllowAllWorkflows
	selected, err := q.ListExecutionPolicyRepositories(ctx, database.ListExecutionPolicyRepositoriesParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID})
	if err != nil {
		return state, errStorageUnavailable
	}
	for _, repo := range selected {
		state.Repositories[repo.RepositoryID] = repo.OwnerID
	}
	state.Workflows, err = q.ListExecutionPolicyWorkflows(ctx, database.ListExecutionPolicyWorkflowsParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID})
	if err != nil {
		return state, errStorageUnavailable
	}
	return state, nil
}
func wireExecutionPolicy(state executionPolicyState, a executionAuthority, scope golfv1.ExecutionScope) *golfv1.ExecutionPolicy {
	result := &golfv1.ExecutionPolicy{Scope: scope, ScopeId: state.ScopeID, OwnerId: strconv.FormatInt(state.OwnerID, 10), Mode: executionWireMode(state.Mode), ManualDispatchEnabled: state.ManualDispatchEnabled, PushAllowed: state.PushAllowed, AllowAllWorkflows: state.AllowAllWorkflows, WorkflowPaths: state.Workflows, Revision: strconv.FormatInt(state.Revision, 10), RevocationEpoch: strconv.FormatInt(state.RevocationEpoch, 10), CanEdit: a.CanEdit, AuthorityRevision: a.Revision}
	for id := range state.Repositories {
		result.SelectedRepositoryIds = append(result.SelectedRepositoryIds, strconv.FormatInt(id, 10))
	}
	sort.Slice(result.SelectedRepositoryIds, func(i, j int) bool {
		return len(result.SelectedRepositoryIds[i]) < len(result.SelectedRepositoryIds[j]) || len(result.SelectedRepositoryIds[i]) == len(result.SelectedRepositoryIds[j]) && result.SelectedRepositoryIds[i] < result.SelectedRepositoryIds[j]
	})
	return result
}
func (s *Server) GetExecutionPolicy(ctx context.Context, req *connect.Request[golfv1.GetExecutionPolicyRequest]) (*connect.Response[golfv1.GetExecutionPolicyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	result := &golfv1.GetExecutionPolicyResponse{}
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		a, err := s.executionAuthority(ctx, value, token, req.Msg.Scope, req.Msg.Organization, keyFrom(req.Msg.Repository), caller)
		if err != nil {
			return err
		}
		err = s.withManagedSession(ctx, value, token, func(q *database.Queries, _ database.LockManagedSessionRow, _ []byte) error {
			state, err := s.loadExecutionPolicy(ctx, q, a, true)
			if err == nil {
				result.Policy = wireExecutionPolicy(state, a, req.Msg.Scope)
			}
			return err
		})
		if err != nil {
			return err
		}
		after, err := s.executionAuthority(ctx, value, token, req.Msg.Scope, req.Msg.Organization, keyFrom(req.Msg.Repository), caller)
		if err != nil {
			return err
		}
		if after.Revision != a.Revision {
			return errExecutionPolicyConflict
		}
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) UpdateExecutionPolicy(ctx context.Context, req *connect.Request[golfv1.UpdateExecutionPolicyRequest]) (*connect.Response[golfv1.UpdateExecutionPolicyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	mode := executionModeName(m.Mode)
	expected, err := strconv.ParseInt(m.ExpectedRevision, 10, 64)
	if err != nil || expected < 0 || strconv.FormatInt(expected, 10) != m.ExpectedRevision || !validAccessRevision(m.ExpectedAuthorityRevision) || mode == "" {
		return nil, rpcError(invalid("Provide current policy and authority revisions and a supported mode."))
	}
	if len(m.SelectedRepositoryIds) > 100 || len(m.WorkflowPaths) > 100 || mode != "selected" && len(m.SelectedRepositoryIds) > 0 || m.AllowAllWorkflows && len(m.WorkflowPaths) > 0 || m.Scope == golfv1.ExecutionScope_EXECUTION_SCOPE_REPOSITORY && mode == "selected" {
		return nil, rpcError(invalid("Invalid repository/workflow selection for this policy scope."))
	}
	workflows := map[string]bool{}
	for _, path := range m.WorkflowPaths {
		if !executionWorkflowPath(path) || workflows[path] {
			return nil, rpcError(invalid("Workflow paths must be unique direct Actions YAML paths or .gitlab-ci.yml."))
		}
		workflows[path] = true
	}
	ids := map[int64]bool{}
	for _, raw := range m.SelectedRepositoryIds {
		id, err := discussionID(raw)
		if err != nil || ids[id] {
			return nil, rpcError(invalid("Selected repository IDs must be unique canonical identifiers."))
		}
		ids[id] = true
	}
	value := s.cookieValue(req.Header())
	result := &golfv1.UpdateExecutionPolicyResponse{}
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		a, err := s.executionAuthority(ctx, value, token, m.Scope, m.Organization, keyFrom(m.Repository), caller)
		if err != nil {
			return err
		}
		if !a.CanEdit {
			return forgeError{http.StatusForbidden}
		}
		if a.ID != m.ScopeId || a.Revision != m.ExpectedAuthorityRevision {
			return errExecutionPolicyConflict
		}
		selected := map[int64]int64{}
		for id := range ids {
			row, err := s.executionSelectedRepository(ctx, token, id)
			if err != nil {
				return err
			}
			if a.Scope == "organization" && row.Owner.ID != a.OwnerID {
				return forgeError{http.StatusForbidden}
			}
			selected[id] = row.Owner.ID
		}
		after, err := s.executionAuthority(ctx, value, token, m.Scope, m.Organization, keyFrom(m.Repository), caller)
		if err != nil {
			return err
		}
		if !after.CanEdit {
			return forgeError{http.StatusForbidden}
		}
		if after.Revision != a.Revision {
			return errExecutionPolicyConflict
		}
		for id, owner := range selected {
			row, err := s.executionSelectedRepository(ctx, token, id)
			if err != nil {
				return err
			}
			if row.Owner.ID != owner {
				return errExecutionPolicyConflict
			}
		}
		final, err := s.executionAuthority(ctx, value, token, m.Scope, m.Organization, keyFrom(m.Repository), caller)
		if err != nil {
			return err
		}
		if !final.CanEdit {
			return forgeError{http.StatusForbidden}
		}
		if final.Revision != a.Revision {
			return errExecutionPolicyConflict
		}
		if token.Local {
			if _, err = s.localSessionUser(ctx, value, caller); err != nil {
				return err
			}
		}
		return s.withManagedSession(ctx, value, token, func(q *database.Queries, actor database.LockManagedSessionRow, hash []byte) error {
			if a.Scope == "instance" {
				if _, err = q.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.GiteaURL}); err != nil {
					if errors.Is(err, sql.ErrNoRows) {
						return errUnauthenticated
					}
					return errStorageUnavailable
				}
			}
			if err = q.EnsureExecutionPolicy(ctx, database.EnsureExecutionPolicyParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID, OwnerID: a.OwnerID}); err != nil {
				return errStorageUnavailable
			}
			old, err := s.loadExecutionPolicy(ctx, q, a, true)
			if err != nil {
				return err
			}
			if old.Revision != expected {
				return errExecutionPolicyConflict
			}
			updated, err := q.UpdateExecutionPolicy(ctx, database.UpdateExecutionPolicyParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID, ExpectedRevision: expected, OwnerID: a.OwnerID, Mode: mode, ManualDispatchEnabled: m.ManualDispatchEnabled, PushAllowed: m.PushAllowed, AllowAllWorkflows: m.AllowAllWorkflows})
			if err != nil {
				return errStorageUnavailable
			}
			if err = q.DeleteExecutionPolicyRepositories(ctx, database.DeleteExecutionPolicyRepositoriesParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID}); err != nil {
				return errStorageUnavailable
			}
			if err = q.DeleteExecutionPolicyWorkflows(ctx, database.DeleteExecutionPolicyWorkflowsParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID}); err != nil {
				return errStorageUnavailable
			}
			for id, owner := range selected {
				if err = q.AddExecutionPolicyRepository(ctx, database.AddExecutionPolicyRepositoryParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID, RepositoryID: id, OwnerID: owner}); err != nil {
					return errStorageUnavailable
				}
			}
			for _, path := range m.WorkflowPaths {
				if err = q.AddExecutionPolicyWorkflow(ctx, database.AddExecutionPolicyWorkflowParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID, WorkflowPath: path}); err != nil {
					return errStorageUnavailable
				}
			}
			if err = q.AppendExecutionPolicyEvent(ctx, database.AppendExecutionPolicyEventParams{ForgeURL: s.config.GiteaURL, Scope: a.Scope, ScopeID: a.ID, Revision: updated.Revision, RevocationEpoch: updated.RevocationEpoch, ActorUserID: actor.UserID, ActorSessionID: actor.SessionID, Mode: mode, ManualDispatchEnabled: m.ManualDispatchEnabled, PushAllowed: m.PushAllowed, AllowAllWorkflows: m.AllowAllWorkflows, SelectedRepositoryCount: int32(len(selected)), WorkflowCount: int32(len(m.WorkflowPaths))}); err != nil {
				return errStorageUnavailable
			}
			state, err := s.loadExecutionPolicy(ctx, q, a, false)
			if err != nil {
				return err
			}
			result.Policy = wireExecutionPolicy(state, a, m.Scope)
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

// Scheduler callers hold this transaction through policy admission/assignment.
// Stamps must be re-read before retries, credentials and trusted result acceptance.
type ExecutionPolicyEpoch struct {
	Scope, ScopeID            string
	Revision, RevocationEpoch int64
}
type ExecutionAdmission struct {
	Allowed       bool
	SourceOwnerID int64
	Epochs        []ExecutionPolicyEpoch
}

func (s *Server) readEffectiveExecutionPolicy(ctx context.Context, tx *sql.Tx, repositoryID, ownerID int64, organizationOwned bool, workflowPath string) (ExecutionAdmission, error) {
	return s.readEffectiveExecutionPolicyForEvent(ctx, tx, repositoryID, ownerID, organizationOwned, "manual", workflowPath)
}

// Event kind is explicit at admission and every later authority fence. A manual
// grant never implies push authority, and unsupported event kinds fail closed.
func (s *Server) readEffectiveExecutionPolicyForEvent(ctx context.Context, tx *sql.Tx, repositoryID, ownerID int64, organizationOwned bool, event, workflowPath string) (ExecutionAdmission, error) {
	result := ExecutionAdmission{SourceOwnerID: ownerID}
	if tx == nil {
		return result, errStorageUnavailable
	}
	q := database.New(s.db).WithTx(tx)
	authorities := []executionAuthority{{Scope: "instance", ID: "instance"}, {Scope: "repository", ID: strconv.FormatInt(repositoryID, 10), OwnerID: ownerID}}
	if organizationOwned {
		authorities = []executionAuthority{{Scope: "instance", ID: "instance"}, {Scope: "organization", ID: strconv.FormatInt(ownerID, 10), OwnerID: ownerID}, authorities[1]}
	}
	states := []executionPolicyState{}
	for _, a := range authorities {
		state, err := s.loadExecutionPolicy(ctx, q, a, true)
		if err != nil {
			return result, err
		}
		states = append(states, state)
		result.Epochs = append(result.Epochs, ExecutionPolicyEpoch{a.Scope, a.ID, state.Revision, state.RevocationEpoch})
	}
	result.Allowed = executionPoliciesAllow(states, repositoryID, ownerID, organizationOwned, event, workflowPath)
	return result, nil
}
