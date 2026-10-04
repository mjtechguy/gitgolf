package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var errRuleOutcomeUnresolved = errors.New("repository rule mutation remains unresolved")

func ruleMutationRPCError(err error) error {
	if errors.Is(err, errRuleOutcomeUnresolved) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("An original repository rule operation is unresolved. Inspect its status; no automatic retry is permitted."))
	}
	return infrastructureRPCError(err)
}

type ruleWrite struct {
	method, suffix string
	payload        map[string]any
}

func branchRulePayload(v *golfv1.RepositoryBranchProtection) (map[string]any, error) {
	if v == nil || !ruleText(v.RuleName, 512, false) || strings.TrimSpace(v.RuleName) != v.RuleName || v.CreatedAt != "" || v.UpdatedAt != "" || !ruleText(v.ProtectedFilePatterns, 4096, true) || !ruleText(v.UnprotectedFilePatterns, 4096, true) {
		return nil, invalid("Provide a trimmed branch pattern and complete configuration without native timestamps.")
	}
	priority, e := strconv.ParseInt(v.Priority, 10, 64)
	if e != nil || strconv.FormatInt(priority, 10) != v.Priority {
		return nil, invalid("Priority must be a canonical signed64 decimal.")
	}
	approvals, e := strconv.ParseInt(v.RequiredApprovals, 10, 64)
	if e != nil || approvals < 0 || strconv.FormatInt(approvals, 10) != v.RequiredApprovals {
		return nil, invalid("Required approvals must be a canonical nonnegative signed64 decimal.")
	}
	lists := [][]string{v.StatusCheckContexts, v.PushUsernames, v.PushTeams, v.ForcePushUsernames, v.ForcePushTeams, v.MergeUsernames, v.MergeTeams, v.BypassUsernames, v.BypassTeams, v.ApprovalsUsernames, v.ApprovalsTeams}
	for _, list := range lists {
		if !validRuleList(list) {
			return nil, invalid("Rule lists must contain at most100 bounded nonempty values.")
		}
		seen := map[string]bool{}
		for _, value := range list {
			if strings.TrimSpace(value) != value || seen[value] {
				return nil, invalid("Use trimmed unique rule list values.")
			}
			seen[value] = true
		}
	}
	// Native create normalizes these dependent switches. Reject an unrepresentable
	// request rather than promising the native provider retained the desired flags.
	if (!v.EnablePush && (v.EnablePushWhitelist || v.PushWhitelistDeployKeys || v.EnableForcePush)) || (!v.EnablePushWhitelist && v.PushWhitelistDeployKeys) || (!v.EnableForcePush && (v.EnableForcePushAllowlist || v.ForcePushAllowlistDeployKeys)) || (!v.EnableForcePushAllowlist && v.ForcePushAllowlistDeployKeys) || (!v.EnableBypassAllowlist && (len(v.BypassUsernames) > 0 || len(v.BypassTeams) > 0)) {
		return nil, invalid("Choose consistent push, force-push, deploy-key and bypass switches.")
	}
	list := func(v []string) []string {
		if v == nil {
			return []string{}
		}
		return v
	}
	return map[string]any{
		"rule_name": v.RuleName, "priority": priority, "required_approvals": approvals,
		"status_check_contexts": list(v.StatusCheckContexts), "push_whitelist_usernames": list(v.PushUsernames), "push_whitelist_teams": list(v.PushTeams), "force_push_allowlist_usernames": list(v.ForcePushUsernames), "force_push_allowlist_teams": list(v.ForcePushTeams), "merge_whitelist_usernames": list(v.MergeUsernames), "merge_whitelist_teams": list(v.MergeTeams), "bypass_allowlist_usernames": list(v.BypassUsernames), "bypass_allowlist_teams": list(v.BypassTeams), "approvals_whitelist_username": list(v.ApprovalsUsernames), "approvals_whitelist_teams": list(v.ApprovalsTeams),
		"protected_file_patterns": v.ProtectedFilePatterns, "unprotected_file_patterns": v.UnprotectedFilePatterns,
		"enable_push": v.EnablePush, "enable_push_whitelist": v.EnablePushWhitelist, "push_whitelist_deploy_keys": v.PushWhitelistDeployKeys, "enable_force_push": v.EnableForcePush, "enable_force_push_allowlist": v.EnableForcePushAllowlist, "force_push_allowlist_deploy_keys": v.ForcePushAllowlistDeployKeys, "enable_merge_whitelist": v.EnableMergeWhitelist, "enable_bypass_allowlist": v.EnableBypassAllowlist, "enable_status_check": v.EnableStatusCheck, "enable_approvals_whitelist": v.EnableApprovalsWhitelist, "block_on_rejected_reviews": v.BlockOnRejectedReviews, "block_on_official_review_requests": v.BlockOnOfficialReviewRequests, "block_on_outdated_branch": v.BlockOnOutdatedBranch, "dismiss_stale_approvals": v.DismissStaleApprovals, "ignore_stale_approvals": v.IgnoreStaleApprovals, "require_signed_commits": v.RequireSignedCommits, "block_admin_merge_override": v.BlockAdminMergeOverride,
	}, nil
}
func tagRulePayload(v *golfv1.RepositoryTagProtection) (map[string]any, error) {
	if v == nil || v.Id != "" || v.CreatedAt != "" || v.UpdatedAt != "" || !ruleText(v.NamePattern, 512, false) || strings.TrimSpace(v.NamePattern) != v.NamePattern || !validRuleList(v.AllowedUsernames) || !validRuleList(v.AllowedTeams) || len(v.AllowedUsernames)+len(v.AllowedTeams) == 0 {
		return nil, invalid("Provide a trimmed tag pattern and at least one allowed account or team without native identity/timestamps.")
	}
	for _, list := range [][]string{v.AllowedUsernames, v.AllowedTeams} {
		seen := map[string]bool{}
		for _, s := range list {
			if strings.TrimSpace(s) != s || seen[s] {
				return nil, invalid("Use trimmed unique allowlist values.")
			}
			seen[s] = true
		}
	}
	users, teams := v.AllowedUsernames, v.AllowedTeams
	if users == nil {
		users = []string{}
	}
	if teams == nil {
		teams = []string{}
	}
	return map[string]any{"name_pattern": v.NamePattern, "whitelist_usernames": users, "whitelist_teams": teams}, nil
}
func mergeRulePayload(v *golfv1.RepositoryMergeConfiguration) (map[string]any, error) {
	if v == nil {
		return nil, invalid("Provide complete merge defaults.")
	}
	allowed := map[string]bool{"merge": v.AllowMergeCommits, "rebase": v.AllowRebase, "rebase-merge": v.AllowRebaseExplicit, "squash": v.AllowSquashMerge, "fast-forward-only": v.AllowFastForwardOnlyMerge}
	if _, ok := allowed[v.DefaultMergeStyle]; !ok || !allowed[v.DefaultMergeStyle] || (v.DefaultUpdateStyle != "merge" && v.DefaultUpdateStyle != "rebase") || (v.DefaultUpdateStyle == "merge" && !v.AllowMergeUpdate) || (v.DefaultUpdateStyle == "rebase" && !v.AllowRebaseUpdate) {
		return nil, invalid("Choose enabled default merge and update methods.")
	}
	return map[string]any{"allow_merge_commits": v.AllowMergeCommits, "allow_rebase": v.AllowRebase, "allow_rebase_explicit": v.AllowRebaseExplicit, "allow_squash_merge": v.AllowSquashMerge, "allow_fast_forward_only_merge": v.AllowFastForwardOnlyMerge, "allow_manual_merge": v.AllowManualMerge, "autodetect_manual_merge": v.AutodetectManualMerge, "allow_merge_update": v.AllowMergeUpdate, "allow_rebase_update": v.AllowRebaseUpdate, "default_delete_branch_after_merge": v.DefaultDeleteBranchAfterMerge, "default_allow_maintainer_edit": v.DefaultAllowMaintainerEdit, "default_merge_style": v.DefaultMergeStyle, "default_update_style": v.DefaultUpdateStyle}, nil
}
func parseRuleWrite(m *golfv1.MutateRepositoryRulesRequest) (ruleWrite, error) {
	var w ruleWrite
	if e := validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.ExpectedAccessRevision, ""); e != nil {
		return w, e
	}
	if !creationKey.MatchString(m.OperationId) || !validAccessRevision(m.ExpectedRulesRevision) {
		return w, invalid("Provide the original operation key and current rules revision.")
	}
	count := 0
	for _, present := range []bool{m.DesiredBranch != nil, m.DesiredTag != nil, m.DesiredMerge != nil} {
		if present {
			count++
		}
	}
	var e error
	switch m.Action {
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_BRANCH:
		if count != 1 || m.DesiredBranch == nil || m.TagId != "" || m.RuleName != m.DesiredBranch.RuleName {
			return w, invalid("Bind exactly one complete branch configuration to its immutable pattern.")
		}
		w.payload, e = branchRulePayload(m.DesiredBranch)
		w.method = http.MethodPost
		w.suffix = "/branch_protections"
		if m.Action == golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_BRANCH {
			w.method = http.MethodPatch
			w.suffix += "/" + url.PathEscape(m.RuleName)
			delete(w.payload, "rule_name")
		}
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_BRANCH:
		if count != 0 || m.TagId != "" || !ruleText(m.RuleName, 512, false) {
			return w, invalid("Select the exact branch rule pattern without a replacement configuration.")
		}
		w.method = http.MethodDelete
		w.suffix = "/branch_protections/" + url.PathEscape(m.RuleName)
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_TAG, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG:
		if count != 1 || m.DesiredTag == nil || m.RuleName != "" {
			return w, invalid("Bind exactly one complete tag configuration.")
		}
		w.payload, e = tagRulePayload(m.DesiredTag)
		w.method = http.MethodPost
		w.suffix = "/tag_protections"
		if m.Action == golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG {
			if _, e = discussionID(m.TagId); e != nil {
				return w, e
			}
			w.method = http.MethodPatch
			w.suffix += "/" + m.TagId
		} else if m.TagId != "" {
			return w, invalid("New tag rules have no native ID yet.")
		}
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_TAG:
		if count != 0 || m.RuleName != "" {
			return w, invalid("Select the exact tag protection identity without replacement configuration.")
		}
		if _, e = discussionID(m.TagId); e != nil {
			return w, e
		}
		w.method = http.MethodDelete
		w.suffix = "/tag_protections/" + m.TagId
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_MERGE:
		if count != 1 || m.DesiredMerge == nil || m.RuleName != "" || m.TagId != "" {
			return w, invalid("Select only complete merge defaults.")
		}
		w.method = http.MethodPatch
		w.payload, e = mergeRulePayload(m.DesiredMerge)
	default:
		return w, invalid("Choose a supported configuration action.")
	}
	return w, e
}

func (s *Server) currentRuleInventory(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, ownerID string) (*golfv1.GetRepositoryRulesResponse, error) {
	var result *golfv1.GetRepositoryRulesResponse
	e := s.withForgeCaller(ctx, session, token, func(caller User) error {
		before, e := s.rulesAuthority(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if before.RepositoryId != repoID || before.OwnerId != ownerID {
			return errRepositoryAccessConflict
		}
		result, e = s.readRepositoryRules(ctx, token, key, repoID, ownerID)
		if e != nil {
			return e
		}
		next, e := s.readRepositoryRules(ctx, token, key, repoID, ownerID)
		if e != nil {
			return e
		}
		if !proto.Equal(result, next) {
			return errRepositoryAccessConflict
		}
		after, e := s.rulesAuthority(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if !proto.Equal(before, after) {
			return errRepositoryAccessConflict
		}
		result.AccessRevision = after.Revision
		result.RulesRevision = accessRevision(result)
		return nil
	})
	return result, e
}
func rulePreflight(m *golfv1.MutateRepositoryRulesRequest, r *golfv1.GetRepositoryRulesResponse, org bool) bool {
	if r.AccessRevision != m.ExpectedAccessRevision || r.RulesRevision != m.ExpectedRulesRevision || !ruleProjectedFits(m, r) {
		return false
	}
	branchExists := false
	for _, v := range r.BranchProtections {
		if v.RuleName == m.RuleName {
			branchExists = true
		}
	}
	tagExists := false
	patternExists := false
	for _, v := range r.TagProtections {
		if v.Id == m.TagId {
			tagExists = true
			if m.DesiredTag != nil && v.NamePattern != m.DesiredTag.NamePattern {
				return false
			}
		}
		if m.DesiredTag != nil && v.NamePattern == m.DesiredTag.NamePattern {
			patternExists = true
		}
	}
	if !org && m.DesiredBranch != nil {
		v := m.DesiredBranch
		if len(v.PushTeams)+len(v.ForcePushTeams)+len(v.MergeTeams)+len(v.BypassTeams)+len(v.ApprovalsTeams) > 0 {
			return false
		}
	}
	if !org && m.DesiredTag != nil && len(m.DesiredTag.AllowedTeams) > 0 {
		return false
	}
	switch m.Action {
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH:
		return !branchExists && len(r.BranchProtections) < maxRepositoryRules
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_BRANCH, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_BRANCH:
		return branchExists
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_TAG:
		return !patternExists && len(r.TagProtections) < maxRepositoryRules
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_TAG:
		return tagExists
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_MERGE:
		return true
	}
	return false
}

// Bound the constructed readback, including default native Go JSON HTML
// escaping. The per-row envelope covers pinned native field-name/false/empty
// metadata overhead; arbitrary provider fields or external edits remain unknown.
func ruleProjectedFits(m *golfv1.MutateRepositoryRulesRequest, before *golfv1.GetRepositoryRulesResponse) bool {
	r := proto.Clone(before).(*golfv1.GetRepositoryRulesResponse)
	switch m.Action {
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_BRANCH:
		v := proto.Clone(m.DesiredBranch).(*golfv1.RepositoryBranchProtection)
		v.CreatedAt = strings.Repeat("0", 64)
		v.UpdatedAt = v.CreatedAt
		replaced := false
		for i, old := range r.BranchProtections {
			if old.RuleName == m.RuleName {
				r.BranchProtections[i] = v
				replaced = true
			}
		}
		if !replaced {
			r.BranchProtections = append(r.BranchProtections, v)
		}
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_BRANCH:
		rows := []*golfv1.RepositoryBranchProtection{}
		for _, v := range r.BranchProtections {
			if v.RuleName != m.RuleName {
				rows = append(rows, v)
			}
		}
		r.BranchProtections = rows
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_TAG, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG:
		v := proto.Clone(m.DesiredTag).(*golfv1.RepositoryTagProtection)
		v.Id = "9223372036854775807"
		v.CreatedAt = strings.Repeat("0", 64)
		v.UpdatedAt = v.CreatedAt
		replaced := false
		for i, old := range r.TagProtections {
			if old.Id == m.TagId {
				r.TagProtections[i] = v
				replaced = true
			}
		}
		if !replaced {
			r.TagProtections = append(r.TagProtections, v)
		}
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_TAG:
		rows := []*golfv1.RepositoryTagProtection{}
		for _, v := range r.TagProtections {
			if v.Id != m.TagId {
				rows = append(rows, v)
			}
		}
		r.TagProtections = rows
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_MERGE:
		r.MergeConfiguration = proto.Clone(m.DesiredMerge).(*golfv1.RepositoryMergeConfiguration)
	}
	projected, e := protojson.Marshal(r)
	if e != nil || len(projected) > 1<<20 {
		return false
	}
	branches, e := json.Marshal(r.BranchProtections)
	if e != nil || len(branches)+len(r.BranchProtections)*2048 > maxForgeResponse {
		return false
	}
	tags, e := json.Marshal(r.TagProtections)
	return e == nil && len(tags)+len(r.TagProtections)*512 <= maxForgeResponse
}

func ruleMutationWire(r database.GolfRepositoryRuleMutation) *golfv1.RepositoryRuleMutation {
	v := &golfv1.RepositoryRuleMutation{OperationId: r.OperationID, Repository: &golfv1.RepositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), ActorId: strconv.FormatInt(r.ActorID, 10), Action: golfv1.RepositoryRuleMutationAction(r.Action), Phase: r.Phase, ExpectedAccessRevision: r.ExpectedAccessRevision, ExpectedRulesRevision: r.ExpectedRulesRevision, InputFingerprint: hex.EncodeToString(r.InputFingerprint), CreatedAt: r.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.Format(time.RFC3339Nano), FailureCode: r.FailureCode}
	if r.ObservedRulesRevision != "" {
		v.ObservedRulesRevision = &r.ObservedRulesRevision
	}
	return v
}
func (s *Server) ownRuleMutation(ctx context.Context, session string, token forgeCredential, id string) (database.GolfRepositoryRuleMutation, error) {
	var r database.GolfRepositoryRuleMutation
	e := s.withManagedSession(ctx, session, token, func(q *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = q.GetOwnRepositoryRuleMutation(ctx, database.GetOwnRepositoryRuleMutationParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, OperationID: id})
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return r, e
}
func ruleMutationTarget(r database.GolfRepositoryRuleMutation, key repositoryKey, repoID, ownerID string) bool {
	return strconv.FormatInt(r.RepositoryID, 10) == repoID && strconv.FormatInt(r.OwnerID, 10) == ownerID && r.RepositoryOwner == key.Owner && r.RepositoryName == key.Name
}
func (s *Server) GetRepositoryRuleMutation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryRuleMutationRequest]) (*connect.Response[golfv1.GetRepositoryRuleMutationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, "", ""); e != nil || !creationKey.MatchString(m.OperationId) {
		return nil, ruleMutationRPCError(invalid("Provide the original operation and exact native target."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, e = s.currentRuleInventory(ctx, session, token, key, m.RepositoryId, m.OwnerId); e != nil {
		return nil, ruleMutationRPCError(e)
	}
	r, e := s.ownRuleMutation(ctx, session, token, m.OperationId)
	if e != nil {
		return nil, ruleMutationRPCError(e)
	}
	if !ruleMutationTarget(r, key, m.RepositoryId, m.OwnerId) {
		return nil, ruleMutationRPCError(errRepositoryAccessConflict)
	}
	if _, e = s.currentRuleInventory(ctx, session, token, key, m.RepositoryId, m.OwnerId); e != nil {
		return nil, ruleMutationRPCError(e)
	}
	// Inspection does not adopt matching external configuration or issue a POST.
	return connect.NewResponse(&golfv1.GetRepositoryRuleMutationResponse{Operation: ruleMutationWire(r)}), nil
}
func (s *Server) advanceRuleMutation(ctx context.Context, session string, token forgeCredential, r database.GolfRepositoryRuleMutation, phase, revision string) (database.GolfRepositoryRuleMutation, error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	e = s.withManagedSession(ctx, session, token, func(q *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		if err := q.LockRepositoryRuleMutations(ctx, database.LockRepositoryRuleMutationsParams{ForgeURL: s.config.GiteaURL, RepositoryID: r.RepositoryID}); err != nil {
			return errStorageUnavailable
		}
		if phase != "REJECTED" {
			current, err := s.rulesAuthority(ctx, token, repositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}, actor)
			if err != nil {
				return err
			}
			if !current.CanManage || current.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || current.OwnerId != strconv.FormatInt(r.OwnerID, 10) {
				return errRepositoryAccessConflict
			}
		}
		if phase != "REJECTED" {
			inventory, err := s.currentRuleInventory(ctx, session, token, repositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10))
			if err != nil {
				return err
			}
			if phase == "DISPATCH_UNKNOWN" && (inventory.AccessRevision != r.ExpectedAccessRevision || inventory.RulesRevision != r.ExpectedRulesRevision) {
				phase = "REJECTED"
			}
			if phase == "SUCCEEDED" && inventory.RulesRevision != revision {
				return errRepositoryAccessConflict
			}
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		var e error
		r, e = q.AdvanceRepositoryRuleMutation(ctx, database.AdvanceRepositoryRuleMutationParams{ID: r.ID, UserID: r.UserID, ForgeURL: s.config.GiteaURL, Phase: phase, FailureCode: failure, ObservedRulesRevision: revision})
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return r, e
}

func branchRuleEquivalent(a, b *golfv1.RepositoryBranchProtection) bool {
	aa := proto.Clone(a).(*golfv1.RepositoryBranchProtection)
	bb := proto.Clone(b).(*golfv1.RepositoryBranchProtection)
	aa.CreatedAt = ""
	aa.UpdatedAt = ""
	bb.CreatedAt = ""
	bb.UpdatedAt = ""
	return proto.Equal(aa, bb)
}
func tagRuleEquivalent(a, b *golfv1.RepositoryTagProtection) bool {
	aa := proto.Clone(a).(*golfv1.RepositoryTagProtection)
	bb := proto.Clone(b).(*golfv1.RepositoryTagProtection)
	aa.Id = ""
	aa.CreatedAt = ""
	aa.UpdatedAt = ""
	bb.Id = ""
	bb.CreatedAt = ""
	bb.UpdatedAt = ""
	return proto.Equal(aa, bb)
}

// Whole readback comparison preserves every unrelated configuration field. It
// detects observed drift but does not establish atomicity, ABA or attribution.
func verifyRuleReadback(m *golfv1.MutateRepositoryRulesRequest, before, after *golfv1.GetRepositoryRulesResponse, nativeBranch *golfv1.RepositoryBranchProtection, nativeTag *golfv1.RepositoryTagProtection, nativeMerge *golfv1.RepositoryMergeConfiguration) bool {
	if before.RepositoryId != after.RepositoryId || before.OwnerId != after.OwnerId || before.AccessRevision != after.AccessRevision {
		return false
	}
	branches := map[string]*golfv1.RepositoryBranchProtection{}
	for _, v := range before.BranchProtections {
		branches[v.RuleName] = v
	}
	tags := map[string]*golfv1.RepositoryTagProtection{}
	for _, v := range before.TagProtections {
		tags[v.Id] = v
	}
	switch m.Action {
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_BRANCH:
		if nativeBranch == nil || !branchRuleEquivalent(m.DesiredBranch, nativeBranch) {
			return false
		}
		branches[m.RuleName] = nativeBranch
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_BRANCH:
		delete(branches, m.RuleName)
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_TAG, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG:
		if nativeTag == nil || !tagRuleEquivalent(m.DesiredTag, nativeTag) || (m.Action == golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG && nativeTag.Id != m.TagId) {
			return false
		}
		if m.Action == golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_TAG {
			if _, exists := tags[nativeTag.Id]; exists {
				return false
			}
		}
		tags[nativeTag.Id] = nativeTag
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_TAG:
		delete(tags, m.TagId)
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_MERGE:
		if nativeMerge == nil || !proto.Equal(m.DesiredMerge, nativeMerge) || !proto.Equal(nativeMerge, after.MergeConfiguration) {
			return false
		}
	}
	if len(branches) != len(after.BranchProtections) || len(tags) != len(after.TagProtections) {
		return false
	}
	for _, v := range after.BranchProtections {
		if !proto.Equal(branches[v.RuleName], v) {
			return false
		}
	}
	for _, v := range after.TagProtections {
		if !proto.Equal(tags[v.Id], v) {
			return false
		}
	}
	return m.Action == golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_MERGE || proto.Equal(before.MergeConfiguration, after.MergeConfiguration)
}

func (s *Server) MutateRepositoryRules(ctx context.Context, req *connect.Request[golfv1.MutateRepositoryRulesRequest]) (*connect.Response[golfv1.MutateRepositoryRulesResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	write, e := parseRuleWrite(m)
	if e != nil {
		return nil, ruleMutationRPCError(e)
	}
	key := keyFrom(m.Repository)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	before, e := s.currentRuleInventory(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, ruleMutationRPCError(e)
	}
	input, e := proto.MarshalOptions{Deterministic: true}.Marshal(m)
	if e != nil {
		return nil, ruleMutationRPCError(errInvalidForgeResponse)
	}
	fingerprint := sha256.Sum256(input)
	existing, e := s.ownRuleMutation(ctx, session, token, m.OperationId)
	if e == nil {
		if !ruleMutationTarget(existing, key, m.RepositoryId, m.OwnerId) || !bytes.Equal(existing.InputFingerprint, fingerprint[:]) {
			return nil, ruleMutationRPCError(errRepositoryAccessConflict)
		}
		if _, e = s.currentRuleInventory(ctx, session, token, key, m.RepositoryId, m.OwnerId); e != nil {
			return nil, ruleMutationRPCError(e)
		}
		return connect.NewResponse(&golfv1.MutateRepositoryRulesResponse{Operation: ruleMutationWire(existing)}), nil
	}
	if !errors.Is(e, errResourceNotFound) {
		return nil, ruleMutationRPCError(e)
	}
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, ruleMutationRPCError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	var r database.GolfRepositoryRuleMutation
	dispatch := false
	e = s.withManagedSession(ctx, session, token, func(q *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var err error
		r, err = q.ReserveRepositoryRuleMutation(ctx, database.ReserveRepositoryRuleMutationParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, ActorID: actor.ID, OperationID: m.OperationId, RepositoryID: repoID, OwnerID: ownerID, RepositoryOwner: key.Owner, RepositoryName: key.Name, Action: int32(m.Action), ExpectedAccessRevision: m.ExpectedAccessRevision, ExpectedRulesRevision: m.ExpectedRulesRevision, InputFingerprint: fingerprint[:]})
		if errors.Is(err, sql.ErrNoRows) {
			r, err = q.GetOwnRepositoryRuleMutation(ctx, database.GetOwnRepositoryRuleMutationParams{UserID: c.UserID, ForgeURL: s.config.GiteaURL, OperationID: m.OperationId})
			if err != nil {
				return errStorageUnavailable
			}
			if !bytes.Equal(r.InputFingerprint, fingerprint[:]) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if err != nil {
			var state interface{ SQLState() string }
			if errors.As(err, &state) && state.SQLState() == "55000" {
				return errRuleOutcomeUnresolved
			}
			return errStorageUnavailable
		}
		dispatch = true
		return nil
	})
	if e != nil {
		return nil, ruleMutationRPCError(e)
	}
	if !dispatch {
		return connect.NewResponse(&golfv1.MutateRepositoryRulesResponse{Operation: ruleMutationWire(r)}), nil
	}
	// Check positive ordinary administration, write eligibility and the entire
	// configuration again after reservation waits. This remains a preflight fence.
	var access *golfv1.RepositoryAccess
	e = s.withForgeCaller(ctx, session, token, func(caller User) error {
		var err error
		access, err = s.rulesAuthority(ctx, token, key, caller)
		if err != nil {
			return err
		}
		row, _, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if access.RepositoryId != m.RepositoryId || access.OwnerId != m.OwnerId || !access.CanManage || *row.Archived || *row.Mirror || (m.Action == golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_MERGE && !*row.HasPullRequests) {
			return errRepositoryAccessConflict
		}
		return nil
	})
	fresh, readErr := s.currentRuleInventory(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil || readErr != nil || access == nil || !rulePreflight(m, fresh, access.OrganizationOwned) {
		r, reject := s.advanceRuleMutation(ctx, session, token, r, "REJECTED", "")
		if reject != nil {
			return nil, ruleMutationRPCError(reject)
		}
		if e != nil {
			return nil, ruleMutationRPCError(e)
		}
		if readErr != nil {
			return nil, ruleMutationRPCError(readErr)
		}
		return connect.NewResponse(&golfv1.MutateRepositoryRulesResponse{Operation: ruleMutationWire(r)}), nil
	}
	before = fresh
	r, e = s.advanceRuleMutation(ctx, session, token, r, "DISPATCH_UNKNOWN", "")
	if e != nil {
		return nil, ruleMutationRPCError(e)
	}
	if r.Phase != "DISPATCH_UNKNOWN" {
		return connect.NewResponse(&golfv1.MutateRepositoryRulesResponse{Operation: ruleMutationWire(r)}), nil
	}
	// Reuse the existing held lifecycle target fence: its final native metadata
	// GET must still resolve the expected ID before issuing the supported write.
	// This is not an atomic name/owner fence inside the native handler.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, ruleMutationRPCError(errStorageUnavailable)
	}
	defer tx.Rollback()
	writeCtx, err := s.lockRepositoryLifecycleTransaction(ctx, tx, repoID)
	if err != nil {
		return nil, ruleMutationRPCError(err)
	}
	guarded, err := s.currentRuleInventory(writeCtx, session, token, key, m.RepositoryId, m.OwnerId)
	if err != nil {
		return nil, ruleMutationRPCError(err)
	}
	if guarded.RulesRevision != m.ExpectedRulesRevision || guarded.AccessRevision != m.ExpectedAccessRevision {
		return connect.NewResponse(&golfv1.MutateRepositoryRulesResponse{Operation: ruleMutationWire(r)}), nil
	}
	base, _ := repositoryPath(key)
	var nativeBranch *golfv1.RepositoryBranchProtection
	var nativeTag *golfv1.RepositoryTagProtection
	var nativeMerge *golfv1.RepositoryMergeConfiguration
	switch m.Action {
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_BRANCH:
		var native forgeBranchProtection
		status := http.StatusOK
		if write.method == http.MethodPost {
			status = http.StatusCreated
		}
		_, e = s.forgeJSON(writeCtx, write.method, base+write.suffix, token, write.payload, &native, status)
		if e == nil {
			nativeBranch, e = wireBranchProtection(native)
		}
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_TAG, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG:
		var native forgeTagProtection
		status := http.StatusOK
		if write.method == http.MethodPost {
			status = http.StatusCreated
		}
		_, e = s.forgeJSON(writeCtx, write.method, base+write.suffix, token, write.payload, &native, status)
		if e == nil {
			nativeTag, e = wireTagProtection(native)
		}
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_BRANCH, golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_TAG:
		_, e = s.forgeJSON(writeCtx, write.method, base+write.suffix, token, nil, nil, http.StatusNoContent)
	case golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_MERGE:
		var native forgeRulesRepository
		_, e = s.forgeJSON(writeCtx, write.method, base, token, write.payload, &native, http.StatusOK)
		if e == nil {
			if strconv.FormatInt(native.ID, 10) != m.RepositoryId || native.Owner == nil || strconv.FormatInt(native.Owner.ID, 10) != m.OwnerId {
				e = errInvalidForgeResponse
			} else {
				nativeMerge, e = wireMergeConfiguration(native)
			}
		}
	}
	after, readErr := s.currentRuleInventory(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if readErr != nil {
		return nil, ruleMutationRPCError(readErr)
	} // No private metadata survives lost current authority.
	if e != nil || !verifyRuleReadback(m, before, after, nativeBranch, nativeTag, nativeMerge) {
		return connect.NewResponse(&golfv1.MutateRepositoryRulesResponse{Operation: ruleMutationWire(r)}), nil
	}
	r, e = s.advanceRuleMutation(ctx, session, token, r, "SUCCEEDED", after.RulesRevision)
	if e != nil {
		return nil, ruleMutationRPCError(e)
	}
	return connect.NewResponse(&golfv1.MutateRepositoryRulesResponse{Operation: ruleMutationWire(r), CurrentRules: after}), nil
}
