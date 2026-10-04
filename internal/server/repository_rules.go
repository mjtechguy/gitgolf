package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

const maxRepositoryRules = 100

// These supported native list endpoints return the whole array, not pages.
// Pointers distinguish an observed false/zero from missing native metadata.
type forgeBranchProtection struct {
	RuleName                      string   `json:"rule_name"`
	Priority                      *int64   `json:"priority"`
	RequiredApprovals             *int64   `json:"required_approvals"`
	ProtectedFilePatterns         string   `json:"protected_file_patterns"`
	UnprotectedFilePatterns       string   `json:"unprotected_file_patterns"`
	CreatedAt                     string   `json:"created_at"`
	UpdatedAt                     string   `json:"updated_at"`
	EnablePush                    *bool    `json:"enable_push"`
	EnablePushWhitelist           *bool    `json:"enable_push_whitelist"`
	PushWhitelistDeployKeys       *bool    `json:"push_whitelist_deploy_keys"`
	EnableForcePush               *bool    `json:"enable_force_push"`
	EnableForcePushAllowlist      *bool    `json:"enable_force_push_allowlist"`
	ForcePushAllowlistDeployKeys  *bool    `json:"force_push_allowlist_deploy_keys"`
	EnableMergeWhitelist          *bool    `json:"enable_merge_whitelist"`
	EnableBypassAllowlist         *bool    `json:"enable_bypass_allowlist"`
	EnableStatusCheck             *bool    `json:"enable_status_check"`
	EnableApprovalsWhitelist      *bool    `json:"enable_approvals_whitelist"`
	BlockOnRejectedReviews        *bool    `json:"block_on_rejected_reviews"`
	BlockOnOfficialReviewRequests *bool    `json:"block_on_official_review_requests"`
	BlockOnOutdatedBranch         *bool    `json:"block_on_outdated_branch"`
	DismissStaleApprovals         *bool    `json:"dismiss_stale_approvals"`
	IgnoreStaleApprovals          *bool    `json:"ignore_stale_approvals"`
	RequireSignedCommits          *bool    `json:"require_signed_commits"`
	BlockAdminMergeOverride       *bool    `json:"block_admin_merge_override"`
	PushUsernames                 []string `json:"push_whitelist_usernames"`
	PushTeams                     []string `json:"push_whitelist_teams"`
	ForcePushUsernames            []string `json:"force_push_allowlist_usernames"`
	ForcePushTeams                []string `json:"force_push_allowlist_teams"`
	MergeUsernames                []string `json:"merge_whitelist_usernames"`
	MergeTeams                    []string `json:"merge_whitelist_teams"`
	BypassUsernames               []string `json:"bypass_allowlist_usernames"`
	BypassTeams                   []string `json:"bypass_allowlist_teams"`
	ApprovalsUsernames            []string `json:"approvals_whitelist_username"`
	ApprovalsTeams                []string `json:"approvals_whitelist_teams"`
	StatusCheckContexts           []string `json:"status_check_contexts"`
}
type forgeTagProtection struct {
	ID               int64    `json:"id"`
	NamePattern      string   `json:"name_pattern"`
	AllowedUsernames []string `json:"whitelist_usernames"`
	AllowedTeams     []string `json:"whitelist_teams"`
	CreatedAt        string   `json:"created_at"`
	UpdatedAt        string   `json:"updated_at"`
}
type forgeRulesRepository struct {
	forgeRepositorySettings
	AllowMergeCommits             *bool   `json:"allow_merge_commits"`
	AllowRebase                   *bool   `json:"allow_rebase"`
	AllowRebaseExplicit           *bool   `json:"allow_rebase_explicit"`
	AllowSquashMerge              *bool   `json:"allow_squash_merge"`
	AllowFastForwardOnlyMerge     *bool   `json:"allow_fast_forward_only_merge"`
	AllowManualMerge              *bool   `json:"allow_manual_merge"`
	AutodetectManualMerge         *bool   `json:"autodetect_manual_merge"`
	AllowMergeUpdate              *bool   `json:"allow_merge_update"`
	AllowRebaseUpdate             *bool   `json:"allow_rebase_update"`
	DefaultDeleteBranchAfterMerge *bool   `json:"default_delete_branch_after_merge"`
	DefaultAllowMaintainerEdit    *bool   `json:"default_allow_maintainer_edit"`
	DefaultMergeStyle             *string `json:"default_merge_style"`
	DefaultUpdateStyle            *string `json:"default_update_style"`
}

func ruleText(s string, limit int, empty bool) bool {
	return (empty || s != "") && len(s) <= limit && utf8.ValidString(s) && !strings.ContainsFunc(s, unicode.IsControl)
}
func validRuleList(values []string) bool {
	if len(values) > 100 {
		return false
	}
	for _, value := range values {
		if !ruleText(value, 512, false) {
			return false
		}
	}
	return true
}
func validRuleTime(value string) bool { return value != "" && len(value) <= 64 && validPullTime(value) }
func wireBranchProtection(r forgeBranchProtection) (*golfv1.RepositoryBranchProtection, error) {
	if !ruleText(r.RuleName, 512, false) || r.Priority == nil || r.RequiredApprovals == nil || *r.RequiredApprovals < 0 || !ruleText(r.ProtectedFilePatterns, 4096, true) || !ruleText(r.UnprotectedFilePatterns, 4096, true) || !validRuleTime(r.CreatedAt) || !validRuleTime(r.UpdatedAt) {
		return nil, errInvalidForgeResponse
	}
	if r.EnablePush == nil || r.EnablePushWhitelist == nil || r.PushWhitelistDeployKeys == nil || r.EnableForcePush == nil || r.EnableForcePushAllowlist == nil || r.ForcePushAllowlistDeployKeys == nil || r.EnableMergeWhitelist == nil || r.EnableBypassAllowlist == nil || r.EnableStatusCheck == nil || r.EnableApprovalsWhitelist == nil || r.BlockOnRejectedReviews == nil || r.BlockOnOfficialReviewRequests == nil || r.BlockOnOutdatedBranch == nil || r.DismissStaleApprovals == nil || r.IgnoreStaleApprovals == nil || r.RequireSignedCommits == nil || r.BlockAdminMergeOverride == nil {
		return nil, errInvalidForgeResponse
	}
	if !validRuleList(r.PushUsernames) || !validRuleList(r.PushTeams) || !validRuleList(r.ForcePushUsernames) || !validRuleList(r.ForcePushTeams) || !validRuleList(r.MergeUsernames) || !validRuleList(r.MergeTeams) || !validRuleList(r.BypassUsernames) || !validRuleList(r.BypassTeams) || !validRuleList(r.ApprovalsUsernames) || !validRuleList(r.ApprovalsTeams) || !validRuleList(r.StatusCheckContexts) {
		return nil, errInvalidForgeResponse
	}
	v := &golfv1.RepositoryBranchProtection{RuleName: r.RuleName, Priority: strconv.FormatInt(*r.Priority, 10), RequiredApprovals: strconv.FormatInt(*r.RequiredApprovals, 10), ProtectedFilePatterns: r.ProtectedFilePatterns, UnprotectedFilePatterns: r.UnprotectedFilePatterns, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		EnablePush:                    *r.EnablePush,
		EnablePushWhitelist:           *r.EnablePushWhitelist,
		PushWhitelistDeployKeys:       *r.PushWhitelistDeployKeys,
		EnableForcePush:               *r.EnableForcePush,
		EnableForcePushAllowlist:      *r.EnableForcePushAllowlist,
		ForcePushAllowlistDeployKeys:  *r.ForcePushAllowlistDeployKeys,
		EnableMergeWhitelist:          *r.EnableMergeWhitelist,
		EnableBypassAllowlist:         *r.EnableBypassAllowlist,
		EnableStatusCheck:             *r.EnableStatusCheck,
		EnableApprovalsWhitelist:      *r.EnableApprovalsWhitelist,
		BlockOnRejectedReviews:        *r.BlockOnRejectedReviews,
		BlockOnOfficialReviewRequests: *r.BlockOnOfficialReviewRequests,
		BlockOnOutdatedBranch:         *r.BlockOnOutdatedBranch,
		DismissStaleApprovals:         *r.DismissStaleApprovals,
		IgnoreStaleApprovals:          *r.IgnoreStaleApprovals,
		RequireSignedCommits:          *r.RequireSignedCommits,
		BlockAdminMergeOverride:       *r.BlockAdminMergeOverride,
		PushUsernames:                 r.PushUsernames,
		PushTeams:                     r.PushTeams,
		ForcePushUsernames:            r.ForcePushUsernames,
		ForcePushTeams:                r.ForcePushTeams,
		MergeUsernames:                r.MergeUsernames,
		MergeTeams:                    r.MergeTeams,
		BypassUsernames:               r.BypassUsernames,
		BypassTeams:                   r.BypassTeams,
		ApprovalsUsernames:            r.ApprovalsUsernames,
		ApprovalsTeams:                r.ApprovalsTeams,
		StatusCheckContexts:           r.StatusCheckContexts,
	}
	return v, nil
}
func wireTagProtection(r forgeTagProtection) (*golfv1.RepositoryTagProtection, error) {
	if r.ID <= 0 || !ruleText(r.NamePattern, 512, false) || !validRuleList(r.AllowedUsernames) || !validRuleList(r.AllowedTeams) || !validRuleTime(r.CreatedAt) || !validRuleTime(r.UpdatedAt) {
		return nil, errInvalidForgeResponse
	}
	return &golfv1.RepositoryTagProtection{Id: strconv.FormatInt(r.ID, 10), NamePattern: r.NamePattern, AllowedUsernames: r.AllowedUsernames, AllowedTeams: r.AllowedTeams, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}, nil
}
func wireMergeConfiguration(r forgeRulesRepository) (*golfv1.RepositoryMergeConfiguration, error) {
	if r.AllowMergeCommits == nil || r.AllowRebase == nil || r.AllowRebaseExplicit == nil || r.AllowSquashMerge == nil || r.AllowFastForwardOnlyMerge == nil || r.AllowManualMerge == nil || r.AutodetectManualMerge == nil || r.AllowMergeUpdate == nil || r.AllowRebaseUpdate == nil || r.DefaultDeleteBranchAfterMerge == nil || r.DefaultAllowMaintainerEdit == nil || r.DefaultMergeStyle == nil || r.DefaultUpdateStyle == nil {
		return nil, errInvalidForgeResponse
	}
	switch *r.DefaultMergeStyle {
	case "merge", "rebase", "rebase-merge", "squash", "fast-forward-only":
	default:
		return nil, errInvalidForgeResponse
	}
	if *r.DefaultUpdateStyle != "merge" && *r.DefaultUpdateStyle != "rebase" {
		return nil, errInvalidForgeResponse
	}
	return &golfv1.RepositoryMergeConfiguration{DefaultMergeStyle: *r.DefaultMergeStyle, DefaultUpdateStyle: *r.DefaultUpdateStyle,
		AllowMergeCommits:             *r.AllowMergeCommits,
		AllowRebase:                   *r.AllowRebase,
		AllowRebaseExplicit:           *r.AllowRebaseExplicit,
		AllowSquashMerge:              *r.AllowSquashMerge,
		AllowFastForwardOnlyMerge:     *r.AllowFastForwardOnlyMerge,
		AllowManualMerge:              *r.AllowManualMerge,
		AutodetectManualMerge:         *r.AutodetectManualMerge,
		AllowMergeUpdate:              *r.AllowMergeUpdate,
		AllowRebaseUpdate:             *r.AllowRebaseUpdate,
		DefaultDeleteBranchAfterMerge: *r.DefaultDeleteBranchAfterMerge,
		DefaultAllowMaintainerEdit:    *r.DefaultAllowMaintainerEdit,
	}, nil
}

// A read observes actual native repository admin plus positive personal/direct
// or member/org-owner authority. Global/site-admin exceptional permission alone
// is not authority. Archived/mirror configurations remain readable; no writes.
func (s *Server) rulesAuthority(ctx context.Context, token forgeCredential, key repositoryKey, caller User) (*golfv1.RepositoryAccess, error) {
	a, e := s.readRepositoryAccess(ctx, token, key, caller)
	if e != nil {
		return nil, e
	}
	row, _, e := s.readRepositorySettings(ctx, token, key)
	if e != nil {
		return nil, e
	}
	if a.RepositoryId != strconv.FormatInt(row.ID, 10) || a.OwnerId != strconv.FormatInt(row.Owner.ID, 10) {
		return nil, errRepositoryAccessConflict
	}
	if !row.Permissions.Admin {
		return nil, forgeError{http.StatusForbidden}
	}
	base, _ := repositoryPath(key)
	if !a.OrganizationOwned {
		if caller.ID == row.Owner.ID && a.CurrentPermission == "owner" {
			return a, nil
		}
		if a.CurrentPermission == "admin" {
			direct, e := s.directCollaborator(ctx, token, base, caller)
			if e != nil {
				return nil, e
			}
			if direct {
				return a, nil
			}
		}
	} else {
		var org forgeOrganization
		if _, e = s.forge(ctx, http.MethodGet, "/orgs/"+key.Owner, token, nil, &org); e != nil {
			return nil, e
		}
		if !validOrganization(org) || strconv.FormatInt(org.ID, 10) != a.OwnerId {
			return nil, errRepositoryAccessConflict
		}
		if _, e = s.forgeJSON(ctx, http.MethodGet, "/orgs/"+org.Name+"/members/"+caller.Login, token, nil, nil, http.StatusNoContent); e != nil {
			return nil, e
		}
		own, e := s.organizationOwner(ctx, token, org, caller)
		if e != nil {
			return nil, e
		}
		if own && (a.CurrentPermission == "owner" || a.CurrentPermission == "admin") {
			return a, nil
		}
		if a.CurrentPermission == "admin" {
			direct, e := s.directCollaborator(ctx, token, base, caller)
			if e != nil {
				return nil, e
			}
			if direct {
				return a, nil
			}
		}
	}
	return nil, forgeError{http.StatusForbidden}
}
func (s *Server) readRepositoryRules(ctx context.Context, token forgeCredential, key repositoryKey, repoID, ownerID string) (*golfv1.GetRepositoryRulesResponse, error) {
	base, _ := repositoryPath(key)
	var native forgeRulesRepository
	if _, e := s.forge(ctx, http.MethodGet, base, token, nil, &native); e != nil {
		return nil, e
	}
	if _, e := wireRepositorySettings(native.forgeRepositorySettings, key); e != nil {
		return nil, e
	}
	if strconv.FormatInt(native.ID, 10) != repoID || strconv.FormatInt(native.Owner.ID, 10) != ownerID {
		return nil, errRepositoryAccessConflict
	}
	merge, e := wireMergeConfiguration(native)
	if e != nil {
		return nil, e
	}
	var branches []forgeBranchProtection
	if _, e = s.forge(ctx, http.MethodGet, base+"/branch_protections", token, nil, &branches); e != nil {
		return nil, e
	}
	var tags []forgeTagProtection
	if _, e = s.forge(ctx, http.MethodGet, base+"/tag_protections", token, nil, &tags); e != nil {
		return nil, e
	}
	if branches == nil || tags == nil || len(branches) > maxRepositoryRules || len(tags) > maxRepositoryRules {
		return nil, errInvalidForgeResponse
	}
	result := &golfv1.GetRepositoryRulesResponse{RepositoryId: repoID, OwnerId: ownerID, MergeConfiguration: merge}
	seen := map[string]bool{}
	for _, r := range branches {
		v, e := wireBranchProtection(r)
		if e != nil {
			return nil, e
		}
		if seen[v.RuleName] {
			return nil, errInvalidForgeResponse
		}
		seen[v.RuleName] = true
		result.BranchProtections = append(result.BranchProtections, v)
	}
	tagIDs := map[int64]bool{}
	patterns := map[string]bool{}
	for _, r := range tags {
		v, e := wireTagProtection(r)
		if e != nil {
			return nil, e
		}
		if tagIDs[r.ID] || patterns[r.NamePattern] {
			return nil, errInvalidForgeResponse
		}
		tagIDs[r.ID] = true
		patterns[r.NamePattern] = true
		result.TagProtections = append(result.TagProtections, v)
	}
	encoded, e := protojson.Marshal(result)
	if e != nil || len(encoded) > 1<<20 {
		return nil, errForgeResponseTooLarge
	}
	return result, nil
}
func (s *Server) GetRepositoryRules(ctx context.Context, req *connect.Request[golfv1.GetRepositoryRulesRequest]) (*connect.Response[golfv1.GetRepositoryRulesResponse], error) {
	token, value, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if e = validateRepositoryAccess(key, m.RepositoryId, m.OwnerId, m.ExpectedRevision, ""); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetRepositoryRulesResponse
	e = s.withForgeCaller(ctx, value, token, func(caller User) error {
		before, e := s.rulesAuthority(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if before.RepositoryId != m.RepositoryId || before.OwnerId != m.OwnerId || before.Revision != m.ExpectedRevision {
			return errRepositoryAccessConflict
		}
		result, e = s.readRepositoryRules(ctx, token, key, m.RepositoryId, m.OwnerId)
		if e != nil {
			return e
		}
		afterRead, e := s.readRepositoryRules(ctx, token, key, m.RepositoryId, m.OwnerId)
		if e != nil {
			return e
		}
		a, _ := json.Marshal(result)
		b, _ := json.Marshal(afterRead)
		if !bytes.Equal(a, b) {
			return errRepositoryAccessConflict
		}
		after, e := s.rulesAuthority(ctx, token, key, caller)
		if e != nil {
			return e
		}
		if before.RepositoryId != after.RepositoryId || before.OwnerId != after.OwnerId || before.Revision != after.Revision || before.OrganizationOwned != after.OrganizationOwned {
			return errRepositoryAccessConflict
		}
		result.AccessRevision = m.ExpectedRevision
		result.RulesRevision = accessRevision(result)
		encoded, err := protojson.Marshal(result)
		if err != nil || len(encoded) > 1<<20 {
			return errForgeResponseTooLarge
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}
