package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func rulesBranchFixture() forgeBranchProtection {
	var row forgeBranchProtection
	raw := `{"rule_name":"release/**","priority":-2,"required_approvals":9007199254740993,"created_at":"2026-10-04T00:00:00Z","updated_at":"2026-10-04T00:00:00Z","enable_push":false,"enable_push_whitelist":true,"push_whitelist_deploy_keys":false,"enable_force_push":false,"enable_force_push_allowlist":false,"force_push_allowlist_deploy_keys":false,"enable_merge_whitelist":true,"enable_bypass_allowlist":false,"enable_status_check":true,"enable_approvals_whitelist":false,"block_on_rejected_reviews":true,"block_on_official_review_requests":false,"block_on_outdated_branch":true,"dismiss_stale_approvals":true,"ignore_stale_approvals":false,"require_signed_commits":true,"block_admin_merge_override":true,"status_check_contexts":["test / matrix-a"],"push_whitelist_usernames":["alice"],"merge_whitelist_teams":["Maintainers"],"protected_file_patterns":".github/workflows/**"}`
	if e := json.Unmarshal([]byte(raw), &row); e != nil {
		panic(e)
	}
	return row
}
func rulesRepositoryFixture() forgeRulesRepository {
	yes, no := true, false
	merge, update := "squash", "merge"
	return forgeRulesRepository{forgeRepositorySettings: settingsFixtureRow(), AllowMergeCommits: &yes, AllowRebase: &no, AllowRebaseExplicit: &no, AllowSquashMerge: &yes, AllowFastForwardOnlyMerge: &no, AllowManualMerge: &no, AutodetectManualMerge: &no, AllowMergeUpdate: &yes, AllowRebaseUpdate: &no, DefaultDeleteBranchAfterMerge: &yes, DefaultAllowMaintainerEdit: &no, DefaultMergeStyle: &merge, DefaultUpdateStyle: &update}
}
func rulesTagFixture() forgeTagProtection {
	return forgeTagProtection{ID: 9007199254740993, NamePattern: "v*", AllowedUsernames: []string{"alice"}, AllowedTeams: []string{}, CreatedAt: "2026-10-04T00:00:00Z", UpdatedAt: "2026-10-04T00:00:00Z"}
}
func TestRepositoryRulesProjection(t *testing.T) {
	v, e := wireBranchProtection(rulesBranchFixture())
	if e != nil || v.RuleName != "release/**" || v.Priority != "-2" || v.RequiredApprovals != "9007199254740993" || v.EnablePush || !v.EnablePushWhitelist || !v.RequireSignedCommits || v.StatusCheckContexts[0] != "test / matrix-a" {
		t.Fatal("exact native flags/integers/context", e)
	}
	for _, mutate := range []func(*forgeBranchProtection){func(r *forgeBranchProtection) { r.EnablePush = nil }, func(r *forgeBranchProtection) { r.RequiredApprovals = nil }, func(r *forgeBranchProtection) { n := int64(-1); r.RequiredApprovals = &n }, func(r *forgeBranchProtection) { r.RuleName = "" }, func(r *forgeBranchProtection) { r.ProtectedFilePatterns = "bad\x00pattern" }, func(r *forgeBranchProtection) { r.UpdatedAt = "invalid" }, func(r *forgeBranchProtection) { r.PushUsernames = []string{strings.Repeat("a", 513)} }, func(r *forgeBranchProtection) { r.StatusCheckContexts = make([]string, 101) }} {
		r := rulesBranchFixture()
		mutate(&r)
		if _, e := wireBranchProtection(r); e == nil {
			t.Fatal("missing/malformed native protection accepted")
		}
	}
	tag, e := wireTagProtection(rulesTagFixture())
	if e != nil || tag.Id != "9007199254740993" || tag.NamePattern != "v*" {
		t.Fatal("exact tag ID", e)
	}
	merge, e := wireMergeConfiguration(rulesRepositoryFixture())
	if e != nil || !merge.AllowSquashMerge || merge.AllowRebase || merge.DefaultMergeStyle != "squash" {
		t.Fatal("actual native merge configuration", e)
	}
	for _, mutate := range []func(*forgeRulesRepository){func(r *forgeRulesRepository) { r.AllowSquashMerge = nil }, func(r *forgeRulesRepository) { v := "unqualified"; r.DefaultMergeStyle = &v }, func(r *forgeRulesRepository) { r.DefaultUpdateStyle = nil }} {
		r := rulesRepositoryFixture()
		mutate(&r)
		if _, e := wireMergeConfiguration(r); e == nil {
			t.Fatal("missing/unknown merge configuration accepted")
		}
	}
	n := int64(math.MaxInt64)
	r := rulesBranchFixture()
	r.RequiredApprovals = &n
	got, e := wireBranchProtection(r)
	if e != nil || got.RequiredApprovals != strconv.FormatInt(n, 10) {
		t.Fatal("signed64 exact approvals", e)
	}
}

type rulesFixture struct {
	mu                    sync.Mutex
	row                   forgeRulesRepository
	branches              []forgeBranchProtection
	tags                  []forgeTagProtection
	mode                  string
	branchReads, tagReads int
	provider              *httptest.Server
}

func newRulesFixture(t *testing.T) *rulesFixture {
	f := &rulesFixture{row: rulesRepositoryFixture(), branches: []forgeBranchProtection{rulesBranchFixture()}, tags: []forgeTagProtection{rulesTagFixture()}}
	f.provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != "GET" {
			t.Error("read inventory attempted native write")
			w.WriteHeader(405)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{{ID: 42, Login: "alice"}}})
		case "/api/v1/repos/alice/example":
			if f.mode == "denied" {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(f.row)
		case "/api/v1/repos/alice/example/collaborators/alice/permission":
			p := "owner"
			if f.mode == "reader" {
				p = "read"
			}
			json.NewEncoder(w).Encode(map[string]any{"permission": p, "user": User{ID: 42, Login: "alice"}})
		case "/api/v1/repos/alice/example/branch_protections":
			f.branchReads++
			rows := f.branches
			if f.mode == "drift" && f.branchReads > 1 {
				n := int64(8)
				rows = []forgeBranchProtection{rulesBranchFixture()}
				rows[0].RequiredApprovals = &n
			}
			json.NewEncoder(w).Encode(rows)
		case "/api/v1/repos/alice/example/tag_protections":
			f.tagReads++
			json.NewEncoder(w).Encode(f.tags)
			if f.mode == "revoke-final" && f.tagReads == 2 {
				f.mode = "denied"
			}
			if f.mode == "replace-final" && f.tagReads == 2 {
				f.row.ID++
			}
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.provider.Close)
	return f
}
func TestRepositoryRulesWholeNativeArray(t *testing.T) {
	for _, mode := range []string{"valid", "empty", "null", "duplicate branch", "duplicate tag", "overbound", "wrong ID", "missing merge"} {
		t.Run(mode, func(t *testing.T) {
			f := newRulesFixture(t)
			s := &Server{config: testConfig(f.provider.URL), client: f.provider.Client()}
			switch mode {
			case "empty":
				f.branches = []forgeBranchProtection{}
				f.tags = []forgeTagProtection{}
			case "null":
				f.branches = nil
			case "duplicate branch":
				f.branches = append(f.branches, f.branches[0])
			case "duplicate tag":
				f.tags = append(f.tags, f.tags[0])
			case "overbound":
				f.tags = make([]forgeTagProtection, 101)
			case "wrong ID":
				f.row.ID++
			case "missing merge":
				f.row.AllowManualMerge = nil
			}
			got, e := s.readRepositoryRules(t.Context(), forgeCredential{Kind: "pat", Token: "source-only"}, repositoryKey{"alice", "example"}, "9007199254740993", "42")
			if (e == nil) != (mode == "valid" || mode == "empty") {
				t.Fatal("whole-array contract", mode, e)
			}
			if mode == "empty" && (len(got.BranchProtections) != 0 || len(got.TagProtections) != 0) {
				t.Fatal("invented rules")
			}
		})
	}
}
func TestRepositoryRulesIndividualAuthority(t *testing.T) {
	for _, mode := range []string{"owner", "reader", "archived", "mirror"} {
		t.Run(mode, func(t *testing.T) {
			f := newRulesFixture(t)
			if mode == "reader" {
				f.mode = "reader"
				f.row.Permissions.Admin = false
			}
			if mode == "archived" {
				v := true
				f.row.Archived = &v
			}
			if mode == "mirror" {
				v := true
				f.row.Mirror = &v
			}
			s := &Server{config: testConfig(f.provider.URL), client: f.provider.Client()}
			_, e := s.rulesAuthority(t.Context(), forgeCredential{Kind: "pat", Token: "source-only"}, repositoryKey{"alice", "example"}, User{ID: 42, Login: "alice"})
			if (e == nil) != (mode != "reader") {
				t.Fatal("native read authority", e)
			}
		})
	}
}
func TestRepositoryRulesManagedReadPostgres(t *testing.T) {
	for _, mode := range []string{"valid", "drift", "revoke-final", "replace-final", "reader", "wrong target", "wrong owner", "stale revision", "foreign origin", "bearer", "missing cookie"} {
		t.Run(mode, func(t *testing.T) {
			db := testDatabase(t)
			f := newRulesFixture(t)
			s, e := New(testConfig(f.provider.URL), db)
			if e != nil {
				t.Fatal(e)
			}
			session, e := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "source-only-rules", "")
			if e != nil {
				t.Fatal(e)
			}
			token := forgeCredential{Kind: "pat", Token: "source-only-rules"}
			a, e := s.readRepositoryAccess(t.Context(), token, repositoryKey{"alice", "example"}, User{ID: 42, Login: "alice"})
			if e != nil {
				t.Fatal(e)
			}
			msg := &golfv1.GetRepositoryRulesRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision}
			req := connect.NewRequest(msg)
			req.Header().Set("Origin", s.config.PublicURL)
			req.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
			switch mode {
			case "wrong target":
				msg.RepositoryId = "13"
			case "wrong owner":
				msg.OwnerId = "13"
			case "stale revision":
				msg.ExpectedRevision = strings.Repeat("a", 64)
			case "foreign origin":
				req.Header().Set("Origin", "https://elsewhere.invalid")
			case "bearer":
				req.Header().Set("Authorization", "Bearer not-authorized")
			case "missing cookie":
				req.Header().Del("Cookie")
			default:
				f.mode = mode
			}
			ctx := context.WithValue(t.Context(), sessionTokenKey{}, token)
			got, e := s.GetRepositoryRules(ctx, req)
			if mode == "valid" {
				if e != nil || got.Msg.AccessRevision != a.Revision || !validAccessRevision(got.Msg.RulesRevision) || len(got.Msg.BranchProtections) != 1 || got.Msg.MergeConfiguration.DefaultMergeStyle != "squash" {
					t.Fatal("exact managed inventory", e)
				}
				return
			}
			if e == nil || got != nil {
				t.Fatal("denied or stale private inventory released", mode)
			}
			if mode == "wrong target" || mode == "wrong owner" || mode == "stale revision" || mode == "foreign origin" || mode == "bearer" || mode == "missing cookie" || mode == "reader" {
				if f.branchReads != 0 || f.tagReads != 0 {
					t.Fatal("read private rules before exact authority", mode)
				}
			}
		})
	}
}

func TestRepositoryRulesOrganizationAndExceptionalAuthority(t *testing.T) {
	for _, tc := range []struct {
		name                       string
		org, owner, member, direct bool
		permission                 string
		allowed                    bool
	}{
		{"personal direct admin", false, false, false, true, "admin", true},
		{"personal exceptional owner", false, false, false, true, "owner", false},
		{"personal reader global admin", false, false, false, true, "read", false},
		{"organization owner", true, true, true, false, "admin", true},
		{"organization individual direct admin", true, false, true, true, "admin", true},
		{"organization team admin", true, false, true, false, "admin", false},
		{"organization nonmember direct admin", true, false, false, true, "admin", false},
		{"organization exceptional owner", true, false, true, false, "owner", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := rulesRepositoryFixture()
			caller := User{ID: 43, Login: "bob", IsInstanceAdmin: true}
			ownerName := "alice"
			if tc.org {
				ownerName = "workshop"
				row.Owner.Login = ownerName
				row.FullName = ownerName + "/example"
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				base := "/api/v1/repos/" + ownerName + "/example"
				switch r.URL.Path {
				case base:
					json.NewEncoder(w).Encode(row)
				case "/api/v1/users/search":
					users := []User{}
					if !tc.org {
						users = append(users, *row.Owner)
					}
					json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": users})
				case "/api/v1/orgs/workshop":
					json.NewEncoder(w).Encode(forgeOrganization{ID: 42, Name: "workshop", Visibility: "private"})
				case "/api/v1/orgs/workshop/members/bob":
					if tc.member {
						w.WriteHeader(204)
					} else {
						w.WriteHeader(404)
					}
				case "/api/v1/users/bob/orgs/workshop/permissions":
					json.NewEncoder(w).Encode(map[string]bool{"is_owner": tc.owner})
				case base + "/collaborators/bob/permission":
					json.NewEncoder(w).Encode(map[string]any{"permission": tc.permission, "user": caller})
				case base + "/collaborators/bob":
					if tc.direct {
						w.WriteHeader(204)
					} else {
						w.WriteHeader(404)
					}
				default:
					t.Errorf("unexpected native read %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer provider.Close()
			s := &Server{config: testConfig(provider.URL), client: provider.Client()}
			_, e := s.rulesAuthority(t.Context(), forgeCredential{Kind: "oauth", Token: "source-only"}, repositoryKey{ownerName, "example"}, caller)
			if (e == nil) != tc.allowed {
				t.Fatal("individual native authority/OAuth distinction", e)
			}
		})
	}
}

func TestRepositoryRulesProjectedAggregateBound(t *testing.T) {
	f := newRulesFixture(t)
	values := make([]string, 100)
	for i := range values {
		values[i] = strconv.Itoa(i) + strings.Repeat("x", 509)
	}
	row := rulesBranchFixture()
	row.StatusCheckContexts = values
	row.PushUsernames = values
	row.PushTeams = values
	row.ForcePushUsernames = values
	row.ForcePushTeams = values
	row.MergeUsernames = values
	row.MergeTeams = values
	row.BypassUsernames = values
	row.BypassTeams = values
	row.ApprovalsUsernames = values
	row.ApprovalsTeams = values
	second := row
	second.RuleName = "other/**"
	f.branches = []forgeBranchProtection{row, second}
	s := &Server{config: testConfig(f.provider.URL), client: f.provider.Client()}
	got, e := s.readRepositoryRules(t.Context(), forgeCredential{Kind: "pat", Token: "source-only"}, repositoryKey{"alice", "example"}, "9007199254740993", "42")
	if got != nil || e != errForgeResponseTooLarge {
		t.Fatal("aggregate bounded payload must refuse rather than truncate", e)
	}
}
