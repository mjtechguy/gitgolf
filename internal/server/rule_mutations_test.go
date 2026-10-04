package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

const rulesOperationTestKey = "a44a6444-4444-4444-8444-444444444444"

func writableBranchFixture() *golfv1.RepositoryBranchProtection {
	v, e := wireBranchProtection(rulesBranchFixture())
	if e != nil {
		panic(e)
	}
	v.CreatedAt = ""
	v.UpdatedAt = ""
	v.EnablePushWhitelist = false
	v.PushTeams = nil
	v.MergeTeams = nil
	return v
}
func ruleRequestFixture() *golfv1.MutateRepositoryRulesRequest {
	return &golfv1.MutateRepositoryRulesRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "9007199254740993", OwnerId: "42", ExpectedAccessRevision: strings.Repeat("a", 64), ExpectedRulesRevision: strings.Repeat("b", 64), OperationId: rulesOperationTestKey, Action: golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_BRANCH, RuleName: "release/**", DesiredBranch: writableBranchFixture()}
}
func TestRuleMutationPayloadAdmission(t *testing.T) {
	good := ruleRequestFixture()
	w, e := parseRuleWrite(good)
	if e != nil || w.method != "PATCH" || w.suffix != "/branch_protections/release%2F%2A%2A" {
		t.Fatal("exact wildcard path", w, e)
	}
	if _, ok := w.payload["rule_name"]; ok {
		t.Fatal("branch PATCH cannot rename")
	}
	if w.payload["priority"] != int64(-2) || w.payload["required_approvals"] != int64(9007199254740993) {
		t.Fatal("signed64 integers lost")
	}
	for _, field := range []string{"push_whitelist_teams", "bypass_allowlist_usernames"} {
		b, _ := json.Marshal(w.payload[field])
		if string(b) != "[]" {
			t.Fatal("empty full replacement must not become null", field)
		}
	}
	for _, mutate := range []func(*golfv1.MutateRepositoryRulesRequest){
		func(m *golfv1.MutateRepositoryRulesRequest) { m.RepositoryId = "017" }, func(m *golfv1.MutateRepositoryRulesRequest) { m.ExpectedRulesRevision = "bad" }, func(m *golfv1.MutateRepositoryRulesRequest) { m.OperationId = "same-key" }, func(m *golfv1.MutateRepositoryRulesRequest) { m.Action = 0 }, func(m *golfv1.MutateRepositoryRulesRequest) { m.RuleName = "other" }, func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredTag = &golfv1.RepositoryTagProtection{} },
		func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredBranch.Priority = "-0" }, func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredBranch.RequiredApprovals = "-1" }, func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredBranch.CreatedAt = "2026-10-04T00:00:00Z" }, func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredBranch.EnableForcePush = true }, func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredBranch.BypassUsernames = []string{"alice"} }, func(m *golfv1.MutateRepositoryRulesRequest) {
			m.DesiredBranch.PushUsernames = []string{"alice", "alice"}
		}, func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredBranch.PushUsernames = []string{" alice"} }, func(m *golfv1.MutateRepositoryRulesRequest) { m.DesiredBranch.ProtectedFilePatterns = "unsafe\x00" },
	} {
		m := proto.Clone(good).(*golfv1.MutateRepositoryRulesRequest)
		mutate(m)
		if _, e := parseRuleWrite(m); e == nil {
			t.Fatal("invalid rule intent admitted", m.Action)
		}
	}
	tag := proto.Clone(good).(*golfv1.MutateRepositoryRulesRequest)
	tag.Action = golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_TAG
	tag.RuleName = ""
	tag.DesiredBranch = nil
	tag.DesiredTag = &golfv1.RepositoryTagProtection{NamePattern: "v*", AllowedUsernames: []string{"alice"}}
	if _, e := parseRuleWrite(tag); e != nil {
		t.Fatal(e)
	}
	tag.DesiredTag.AllowedUsernames = nil
	if _, e := parseRuleWrite(tag); e == nil {
		t.Fatal("native rejects empty tag allowlist")
	}
	// Native tag creation requires an allowlist, but editing can explicitly
	// clear both lists while preserving the exact existing protected tag ID.
	tag.Action = golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG
	tag.TagId = "21"
	if write, err := parseRuleWrite(tag); err != nil || write.method != "PATCH" {
		t.Fatal("native tag edit must accept explicit empty lists", err)
	} else {
		for _, field := range []string{"whitelist_usernames", "whitelist_teams"} {
			encoded, err := json.Marshal(write.payload[field])
			if err != nil || string(encoded) != "[]" {
				t.Fatal("empty tag edit list must not become null", field, err)
			}
		}
	}
	merge, e := wireMergeConfiguration(rulesRepositoryFixture())
	if e != nil {
		t.Fatal(e)
	}
	if _, e = mergeRulePayload(merge); e != nil {
		t.Fatal(e)
	}
	merge.DefaultMergeStyle = "rebase"
	if _, e = mergeRulePayload(merge); e == nil {
		t.Fatal("disabled default method admitted")
	}
}

func TestRuleMutationZeroPriorityCreateRefusedEditRetained(t *testing.T) {
	m := ruleRequestFixture()
	m.DesiredBranch.Priority = "0"
	if w, e := parseRuleWrite(m); e != nil || w.method != http.MethodPatch || w.payload["priority"] != int64(0) {
		t.Fatal("existing zero priority must remain explicitly editable", e)
	}
	m.Action = golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH
	if _, e := parseRuleWrite(m); e == nil {
		t.Fatal("native automatic priority cannot satisfy exact creation intent")
	}
	for _, priority := range []string{"1", "-1", "9223372036854775807"} {
		m.DesiredBranch.Priority = priority
		if w, e := parseRuleWrite(m); e != nil || w.method != http.MethodPost {
			t.Fatal("explicit nonzero priority should remain supported", priority, e)
		}
	}
}
func TestRuleMutationPreflightAndWholeReadback(t *testing.T) {
	m := ruleRequestFixture()
	branch := proto.Clone(m.DesiredBranch).(*golfv1.RepositoryBranchProtection)
	branch.CreatedAt = "2026-10-04T00:00:00Z"
	branch.UpdatedAt = branch.CreatedAt
	merge, _ := wireMergeConfiguration(rulesRepositoryFixture())
	before := &golfv1.GetRepositoryRulesResponse{RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.ExpectedAccessRevision, RulesRevision: m.ExpectedRulesRevision, BranchProtections: []*golfv1.RepositoryBranchProtection{branch}, MergeConfiguration: merge}
	if !rulePreflight(m, before, false) {
		t.Fatal("ordinary selected rule refused")
	}
	m.DesiredBranch.MergeTeams = []string{"Maintainers"}
	if rulePreflight(m, before, false) || !rulePreflight(m, before, true) {
		t.Fatal("personal teams silently dropped")
	}
	m.DesiredBranch.MergeTeams = nil
	m.DesiredBranch.RequiredApprovals = "3"
	receipt := proto.Clone(m.DesiredBranch).(*golfv1.RepositoryBranchProtection)
	receipt.CreatedAt = branch.CreatedAt
	receipt.UpdatedAt = "2026-10-04T01:00:00Z"
	after := proto.Clone(before).(*golfv1.GetRepositoryRulesResponse)
	after.BranchProtections = []*golfv1.RepositoryBranchProtection{receipt}
	if !verifyRuleReadback(m, before, after, receipt, nil, nil) {
		t.Fatal("exact independent branch readback refused")
	}
	for _, mutate := range []func(*golfv1.GetRepositoryRulesResponse){func(r *golfv1.GetRepositoryRulesResponse) { r.RepositoryId = "18" }, func(r *golfv1.GetRepositoryRulesResponse) { r.AccessRevision = strings.Repeat("c", 64) }, func(r *golfv1.GetRepositoryRulesResponse) { r.MergeConfiguration.AllowManualMerge = true }, func(r *golfv1.GetRepositoryRulesResponse) { r.BranchProtections[0].EnablePush = true }, func(r *golfv1.GetRepositoryRulesResponse) { r.BranchProtections[0].RequiredApprovals = "4" }} {
		bad := proto.Clone(after).(*golfv1.GetRepositoryRulesResponse)
		mutate(bad)
		if verifyRuleReadback(m, before, bad, receipt, nil, nil) {
			t.Fatal("unrelated movement/normalization accepted")
		}
	}
	removed := proto.Clone(before).(*golfv1.GetRepositoryRulesResponse)
	removed.BranchProtections = nil
	m.Action = golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_REMOVE_BRANCH
	m.DesiredBranch = nil
	if !verifyRuleReadback(m, before, removed, nil, nil, nil) {
		t.Fatal("actual complete absence refused")
	}
	if verifyRuleReadback(m, before, before, nil, nil, nil) {
		t.Fatal("delete receipt without observed absence")
	}
}

func TestRuleMutationEncodedReadbackBound(t *testing.T) {
	m := ruleRequestFixture()
	m.DesiredBranch.EnablePush = true
	m.DesiredBranch.EnablePushWhitelist = true
	m.DesiredBranch.EnableForcePush = true
	m.DesiredBranch.EnableForcePushAllowlist = true
	m.DesiredBranch.EnableBypassAllowlist = true
	list := make([]string, 100)
	for i := range list {
		list[i] = strconv.Itoa(i) + strings.Repeat("<", 508)
	}
	b := m.DesiredBranch
	b.StatusCheckContexts = list
	b.PushUsernames = list
	b.PushTeams = list
	b.ForcePushUsernames = list
	b.ForcePushTeams = list
	b.MergeUsernames = list
	b.MergeTeams = list
	b.BypassUsernames = list
	b.BypassTeams = list
	b.ApprovalsUsernames = list
	b.ApprovalsTeams = list
	if _, e := parseRuleWrite(m); e != nil {
		t.Fatal("bounded individual input unexpectedly malformed", e)
	}
	merge, _ := wireMergeConfiguration(rulesRepositoryFixture())
	before := &golfv1.GetRepositoryRulesResponse{RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.ExpectedAccessRevision, RulesRevision: m.ExpectedRulesRevision, BranchProtections: []*golfv1.RepositoryBranchProtection{writableBranchFixture()}, MergeConfiguration: merge}
	if rulePreflight(m, before, true) {
		t.Fatal("known escaped native response over2MiB admitted")
	}
	if ruleMutationRPCError(connect.NewError(connect.CodePermissionDenied, errors.New("fixed refusal"))).(*connect.Error).Code() != connect.CodePermissionDenied {
		t.Fatal("known403 became generic500")
	}
	if ruleMutationRPCError(errRuleOutcomeUnresolved).(*connect.Error).Code() != connect.CodeFailedPrecondition {
		t.Fatal("unknown exclusion mapping")
	}
}

func TestRuleMutationTagAllowlistEquivalence(t *testing.T) {
	desired := &golfv1.RepositoryTagProtection{NamePattern: "v*", AllowedUsernames: []string{"owner", "direct"}, AllowedTeams: []string{"Writers", "Readers"}}
	native := proto.Clone(desired).(*golfv1.RepositoryTagProtection)
	native.Id, native.CreatedAt, native.UpdatedAt = "21", "2026-10-04T00:00:00Z", "2026-10-04T01:00:00Z"
	slices.Reverse(native.AllowedUsernames)
	slices.Reverse(native.AllowedTeams)
	originalDesired, originalNative := proto.Clone(desired), proto.Clone(native)
	if !tagRuleEquivalent(desired, native) || !proto.Equal(desired, originalDesired) || !proto.Equal(native, originalNative) {
		t.Fatal("unordered native membership should match without mutating intent or receipt")
	}
	for name, change := range map[string]func(*golfv1.RepositoryTagProtection){
		"added user":        func(v *golfv1.RepositoryTagProtection) { v.AllowedUsernames = append(v.AllowedUsernames, "extra") },
		"removed user":      func(v *golfv1.RepositoryTagProtection) { v.AllowedUsernames = v.AllowedUsernames[:1] },
		"duplicate user":    func(v *golfv1.RepositoryTagProtection) { v.AllowedUsernames = []string{"owner", "owner"} },
		"duplicate team":    func(v *golfv1.RepositoryTagProtection) { v.AllowedTeams = []string{"Writers", "Writers"} },
		"changed user case": func(v *golfv1.RepositoryTagProtection) { v.AllowedUsernames[0] = "Direct" },
		"changed team case": func(v *golfv1.RepositoryTagProtection) { v.AllowedTeams[0] = "readers" },
		"changed pattern":   func(v *golfv1.RepositoryTagProtection) { v.NamePattern = "v2*" },
		"unknown field":     func(v *golfv1.RepositoryTagProtection) { v.ProtoReflect().SetUnknown([]byte{0xa0, 0x06, 0x01}) },
	} {
		t.Run(name, func(t *testing.T) {
			bad := proto.Clone(native).(*golfv1.RepositoryTagProtection)
			change(bad)
			if tagRuleEquivalent(desired, bad) {
				t.Fatal("changed exact membership/configuration accepted")
			}
		})
	}
	duplicate := proto.Clone(desired).(*golfv1.RepositoryTagProtection)
	duplicate.AllowedUsernames = []string{"owner", "owner"}
	if tagRuleEquivalent(duplicate, duplicate) {
		t.Fatal("duplicates must not become a valid set even on both sides")
	}
	empty := &golfv1.RepositoryTagProtection{NamePattern: "v*"}
	if !tagRuleEquivalent(empty, &golfv1.RepositoryTagProtection{Id: "21", NamePattern: "v*", AllowedUsernames: []string{}, AllowedTeams: []string{}}) {
		t.Fatal("explicit empty tag edit should remain equivalent")
	}
}

func TestRuleMutationTagAllowlistWholeReadback(t *testing.T) {
	m := ruleRequestFixture()
	m.Action, m.RuleName, m.DesiredBranch, m.TagId = golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG, "", nil, "21"
	m.DesiredTag = &golfv1.RepositoryTagProtection{NamePattern: "v*", AllowedUsernames: []string{"owner", "direct"}, AllowedTeams: []string{"Writers", "Readers"}}
	merge, _ := wireMergeConfiguration(rulesRepositoryFixture())
	before := &golfv1.GetRepositoryRulesResponse{RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.ExpectedAccessRevision, BranchProtections: []*golfv1.RepositoryBranchProtection{writableBranchFixture()}, TagProtections: []*golfv1.RepositoryTagProtection{{Id: "21", NamePattern: "v*"}, {Id: "22", NamePattern: "release*", AllowedUsernames: []string{"other"}}}, MergeConfiguration: merge}
	receipt := proto.Clone(m.DesiredTag).(*golfv1.RepositoryTagProtection)
	receipt.Id, receipt.CreatedAt, receipt.UpdatedAt = "21", "2026-10-04T00:00:00Z", "2026-10-04T01:00:00Z"
	slices.Reverse(receipt.AllowedUsernames)
	slices.Reverse(receipt.AllowedTeams)
	after := proto.Clone(before).(*golfv1.GetRepositoryRulesResponse)
	after.TagProtections[0] = receipt
	if !verifyRuleReadback(m, before, after, nil, receipt, nil) {
		t.Fatal("native reordered selected allowlist refused")
	}
	for name, change := range map[string]func(*golfv1.GetRepositoryRulesResponse){
		"selected membership": func(v *golfv1.GetRepositoryRulesResponse) { v.TagProtections[0].AllowedUsernames[0] = "extra" },
		"selected ID":         func(v *golfv1.GetRepositoryRulesResponse) { v.TagProtections[0].Id = "23" },
		"selected timestamp":  func(v *golfv1.GetRepositoryRulesResponse) { v.TagProtections[0].UpdatedAt = "2026-10-04T02:00:00Z" },
		"unrelated tag":       func(v *golfv1.GetRepositoryRulesResponse) { v.TagProtections[1].AllowedUsernames = []string{"extra"} },
		"unrelated branch":    func(v *golfv1.GetRepositoryRulesResponse) { v.BranchProtections[0].RequiredApprovals = "0" },
		"merge settings":      func(v *golfv1.GetRepositoryRulesResponse) { v.MergeConfiguration.AllowManualMerge = true },
		"authority":           func(v *golfv1.GetRepositoryRulesResponse) { v.AccessRevision = strings.Repeat("c", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			bad := proto.Clone(after).(*golfv1.GetRepositoryRulesResponse)
			change(bad)
			if verifyRuleReadback(m, before, bad, nil, receipt, nil) {
				t.Fatal("independent receipt or unrelated drift accepted")
			}
		})
	}
}

type ruleMutationFixture struct {
	*rulesFixture
	writes atomic.Int64
	fault  string
}

func newRuleMutationFixture(t *testing.T) *ruleMutationFixture {
	f := &ruleMutationFixture{rulesFixture: newRulesFixture(t)}
	original := f.provider.Config.Handler
	f.provider.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			switch r.URL.Path {
			case "/api/v1/users/alice":
				json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
				return
			case "/api/v1/users/direct":
				json.NewEncoder(w).Encode(User{ID: 43, Login: "direct"})
				return
			case "/api/v1/repos/alice/example/collaborators/direct":
				w.WriteHeader(204)
				return
			case "/api/v1/repos/alice/example/collaborators/direct/permission":
				json.NewEncoder(w).Encode(map[string]any{"permission": "write", "user": User{ID: 43, Login: "direct"}})
				return
			}
			original.ServeHTTP(w, r)
			return
		}
		f.writes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case strings.Contains(r.URL.Path, "/branch_protections"):
			name := strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alice/example/branch_protections/")
			if r.Method == "DELETE" {
				rows := []forgeBranchProtection{}
				for _, v := range f.branches {
					if v.RuleName != name {
						rows = append(rows, v)
					}
				}
				f.branches = rows
				w.WriteHeader(204)
				return
			}
			var v forgeBranchProtection
			if json.Unmarshal(raw, &v) != nil {
				w.WriteHeader(400)
				return
			}
			if r.Method == "PATCH" {
				v.RuleName = name
			}
			if f.fault == "branch-inventory-order" {
				for _, list := range [][]string{v.PushUsernames, v.PushTeams, v.ForcePushUsernames, v.ForcePushTeams, v.MergeUsernames, v.MergeTeams, v.BypassUsernames, v.BypassTeams, v.ApprovalsUsernames, v.ApprovalsTeams} {
					slices.Reverse(list)
				}
			}
			v.CreatedAt = "2026-10-04T00:00:00Z"
			v.UpdatedAt = "2026-10-04T01:00:00Z"
			if r.Method == "POST" {
				f.branches = append(f.branches, v)
			} else {
				for i := range f.branches {
					if f.branches[i].RuleName == name {
						f.branches[i] = v
					}
				}
			}
			if f.fault == "accepted500" {
				w.WriteHeader(500)
				return
			}
			if f.fault == "revoke-after" {
				f.mode = "reader"
				f.row.Permissions.Admin = false
			}
			if f.fault == "changed-readback" {
				f.branches[0].RequiredApprovals = new(int64)
			}
			if r.Method == "POST" {
				w.WriteHeader(201)
			}
			json.NewEncoder(w).Encode(v)
		case strings.Contains(r.URL.Path, "/tag_protections"):
			id := strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alice/example/tag_protections/")
			if r.Method == "DELETE" {
				rows := []forgeTagProtection{}
				for _, v := range f.tags {
					if fmtID(v.ID) != id {
						rows = append(rows, v)
					}
				}
				f.tags = rows
				w.WriteHeader(204)
				return
			}
			var v forgeTagProtection
			json.Unmarshal(raw, &v)
			if f.fault == "tag-inventory-order" {
				slices.Reverse(v.AllowedUsernames)
				slices.Reverse(v.AllowedTeams)
			}
			v.CreatedAt = "2026-10-04T00:00:00Z"
			v.UpdatedAt = "2026-10-04T01:00:00Z"
			if r.Method == "POST" {
				v.ID = 21
				f.tags = append(f.tags, v)
				w.WriteHeader(201)
			} else {
				for i := range f.tags {
					if fmtID(f.tags[i].ID) == id {
						v.ID = f.tags[i].ID
						f.tags[i] = v
					}
				}
			}
			json.NewEncoder(w).Encode(v)
		default:
			json.Unmarshal(raw, &f.row)
			json.NewEncoder(w).Encode(f.row)
		}
	})
	return f
}
func fmtID(id int64) string { return strconv.FormatInt(id, 10) }

func TestRuleMutationsManagedPostgres(t *testing.T) {
	for _, fault := range []string{"success", "accepted500", "changed-readback", "revoke-after", "stale", "archived", "mirror", "personal teams", "foreign origin", "bearer"} {
		t.Run(fault, func(t *testing.T) {
			db := testDatabase(t)
			f := newRuleMutationFixture(t)
			s, e := New(testConfig(f.provider.URL), db)
			if e != nil {
				t.Fatal(e)
			}
			session, e := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "rules-source-only", "")
			if e != nil {
				t.Fatal(e)
			}
			credential := forgeCredential{Kind: "pat", Token: "rules-source-only"}
			ctx := context.WithValue(t.Context(), sessionTokenKey{}, credential)
			before, e := s.currentRuleInventory(ctx, session.Value, credential, repositoryKey{"alice", "example"}, "9007199254740993", "42")
			if e != nil {
				t.Fatal(e)
			}
			m := ruleRequestFixture()
			m.ExpectedAccessRevision = before.AccessRevision
			m.ExpectedRulesRevision = before.RulesRevision
			m.DesiredBranch.RequiredApprovals = "3"
			f.fault = fault
			request := connect.NewRequest(m)
			request.Header().Set("Origin", s.config.PublicURL)
			request.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
			switch fault {
			case "stale":
				m.ExpectedRulesRevision = strings.Repeat("c", 64)
			case "archived":
				*f.row.Archived = true
			case "mirror":
				*f.row.Mirror = true
			case "personal teams":
				m.DesiredBranch.PushTeams = []string{"Maintainers"}
			case "foreign origin":
				request.Header().Set("Origin", "https://elsewhere.invalid")
			case "bearer":
				request.Header().Set("Authorization", "Bearer not-authorized")
			}
			got, e := s.MutateRepositoryRules(ctx, request)
			if fault == "success" || fault == "accepted500" || fault == "changed-readback" {
				if e != nil || got == nil {
					t.Fatal("original outcome missing", e)
				}
				statusRequest := connect.NewRequest(&golfv1.GetRepositoryRuleMutationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
				statusRequest.Header().Set("Origin", s.config.PublicURL)
				statusRequest.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
				status, statusErr := s.GetRepositoryRuleMutation(ctx, statusRequest)
				if statusErr != nil || status.Msg.Operation.Phase != got.Msg.Operation.Phase || f.writes.Load() != 1 {
					t.Fatal("original status lookup changed outcome or resent", statusErr)
				}
			}
			if fault == "success" {
				if e != nil || got.Msg.Operation.Phase != "SUCCEEDED" || got.Msg.CurrentRules == nil || f.writes.Load() != 1 {
					t.Fatal("verified once-only effect", e)
				}
				again, e := s.MutateRepositoryRules(ctx, request)
				if e != nil || again.Msg.Operation.Phase != "SUCCEEDED" || again.Msg.CurrentRules != nil || f.writes.Load() != 1 {
					t.Fatal("replay redispatched", e)
				}
				m.DesiredBranch.RequiredApprovals = "4"
				if _, e = s.MutateRepositoryRules(ctx, request); e == nil {
					t.Fatal("changed original key intent accepted")
				}
				return
			}
			if fault == "accepted500" || fault == "changed-readback" {
				if e != nil || got.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || got.Msg.CurrentRules != nil || f.writes.Load() != 1 {
					t.Fatal("accepted uncertain write forged success", e)
				}
				again, e := s.MutateRepositoryRules(ctx, request)
				if e != nil || again.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || f.writes.Load() != 1 {
					t.Fatal("unknown replay redispatched", e)
				}
				m.OperationId = "b44a6444-4444-4444-8444-444444444444"
				if _, e = s.MutateRepositoryRules(ctx, request); e == nil || f.writes.Load() != 1 {
					t.Fatal("fresh-key unknown bypass")
				}
				return
			}
			if fault == "revoke-after" {
				if e == nil || got != nil || f.writes.Load() != 1 {
					t.Fatal("private receipt after current revocation")
				}
				return
			}
			if f.writes.Load() != 0 {
				t.Fatal("denied/stale preflight dispatched", fault)
			}
			if fault == "stale" || fault == "personal teams" {
				if e != nil || got.Msg.Operation.Phase != "REJECTED" {
					t.Fatal("known no-dispatch refusal not retained", e)
				}
			} else if e == nil {
				t.Fatal("invalid authority released receipt", fault)
			}
		})
	}
}

func TestRuleMutationsTagAllowlistOrderPostgres(t *testing.T) {
	db := testDatabase(t)
	f := newRuleMutationFixture(t)
	s, err := New(testConfig(f.provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "rules-source-only", "")
	if err != nil {
		t.Fatal(err)
	}
	credential := forgeCredential{Kind: "pat", Token: "rules-source-only"}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, credential)
	before, err := s.currentRuleInventory(ctx, session.Value, credential, repositoryKey{"alice", "example"}, "9007199254740993", "42")
	if err != nil {
		t.Fatal(err)
	}
	m := ruleRequestFixture()
	m.Action, m.RuleName, m.DesiredBranch = golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG, "", nil
	m.TagId = before.TagProtections[0].Id
	m.ExpectedAccessRevision, m.ExpectedRulesRevision = before.AccessRevision, before.RulesRevision
	m.DesiredTag = &golfv1.RepositoryTagProtection{NamePattern: before.TagProtections[0].NamePattern, AllowedUsernames: []string{"alice", "direct"}}
	f.fault = "tag-inventory-order"
	request := connect.NewRequest(m)
	request.Header().Set("Origin", s.config.PublicURL)
	request.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
	result, err := s.MutateRepositoryRules(ctx, request)
	if err != nil || result == nil || result.Msg.Operation.Phase != "SUCCEEDED" || result.Msg.CurrentRules == nil || f.writes.Load() != 1 {
		t.Fatal("reordered native tag acknowledgement/readback must succeed exactly once", err)
	}
	if !slices.Equal(result.Msg.CurrentRules.TagProtections[0].AllowedUsernames, []string{"direct", "alice"}) || !slices.Equal(m.DesiredTag.AllowedUsernames, []string{"alice", "direct"}) {
		t.Fatal("native receipt order or original request was rewritten")
	}
	statusRequest := connect.NewRequest(&golfv1.GetRepositoryRuleMutationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
	statusRequest.Header().Set("Origin", s.config.PublicURL)
	statusRequest.Header().Set("Cookie", request.Header().Get("Cookie"))
	status, err := s.GetRepositoryRuleMutation(ctx, statusRequest)
	if err != nil || status.Msg.Operation.Phase != "SUCCEEDED" || f.writes.Load() != 1 {
		t.Fatal("original status changed or resent", err)
	}
	replayed, err := s.MutateRepositoryRules(ctx, request)
	if err != nil || replayed.Msg.Operation.Phase != "SUCCEEDED" || replayed.Msg.CurrentRules != nil || f.writes.Load() != 1 {
		t.Fatal("exact key replay redispatched", err)
	}
	slices.Reverse(m.DesiredTag.AllowedUsernames)
	if _, err = s.MutateRepositoryRules(ctx, request); connect.CodeOf(err) != connect.CodeFailedPrecondition || f.writes.Load() != 1 {
		t.Fatal("equivalent membership must not weaken original intent fingerprint", err)
	}
}

func TestRuleMutationBranchAllowlistEquivalence(t *testing.T) {
	fields := map[string]func(*golfv1.RepositoryBranchProtection, []string){
		"push users":     func(v *golfv1.RepositoryBranchProtection, s []string) { v.PushUsernames = s },
		"push teams":     func(v *golfv1.RepositoryBranchProtection, s []string) { v.PushTeams = s },
		"force users":    func(v *golfv1.RepositoryBranchProtection, s []string) { v.ForcePushUsernames = s },
		"force teams":    func(v *golfv1.RepositoryBranchProtection, s []string) { v.ForcePushTeams = s },
		"merge users":    func(v *golfv1.RepositoryBranchProtection, s []string) { v.MergeUsernames = s },
		"merge teams":    func(v *golfv1.RepositoryBranchProtection, s []string) { v.MergeTeams = s },
		"bypass users":   func(v *golfv1.RepositoryBranchProtection, s []string) { v.BypassUsernames = s },
		"bypass teams":   func(v *golfv1.RepositoryBranchProtection, s []string) { v.BypassTeams = s },
		"approval users": func(v *golfv1.RepositoryBranchProtection, s []string) { v.ApprovalsUsernames = s },
		"approval teams": func(v *golfv1.RepositoryBranchProtection, s []string) { v.ApprovalsTeams = s },
	}
	for name, set := range fields {
		t.Run(name, func(t *testing.T) {
			desired := writableBranchFixture()
			set(desired, []string{"zeta", "Alpha"})
			native := proto.Clone(desired).(*golfv1.RepositoryBranchProtection)
			set(native, []string{"Alpha", "zeta"})
			native.CreatedAt, native.UpdatedAt = "2026-10-04T00:00:00Z", "2026-10-04T01:00:00Z"
			originalDesired, originalNative := proto.Clone(desired), proto.Clone(native)
			if !branchRuleEquivalent(desired, native) || !proto.Equal(desired, originalDesired) || !proto.Equal(native, originalNative) {
				t.Fatal("inventory ordering must match without changing the original intent or receipt")
			}
			for _, badList := range [][]string{{"Alpha"}, {"Alpha", "zeta", "extra"}, {"Alpha", "Alpha"}, {"alpha", "zeta"}} {
				bad := proto.Clone(native).(*golfv1.RepositoryBranchProtection)
				set(bad, badList)
				if branchRuleEquivalent(desired, bad) {
					t.Fatal("changed exact membership accepted")
				}
			}
			duplicate := proto.Clone(desired).(*golfv1.RepositoryBranchProtection)
			set(duplicate, []string{"Alpha", "Alpha"})
			if branchRuleEquivalent(duplicate, duplicate) {
				t.Fatal("matching duplicate lists must not become valid sets")
			}
		})
	}
	desired := writableBranchFixture()
	desired.StatusCheckContexts = []string{"test-a", "test-b"}
	for name, change := range map[string]func(*golfv1.RepositoryBranchProtection){
		"context order": func(v *golfv1.RepositoryBranchProtection) { slices.Reverse(v.StatusCheckContexts) },
		"priority":      func(v *golfv1.RepositoryBranchProtection) { v.Priority = "4" },
		"pattern":       func(v *golfv1.RepositoryBranchProtection) { v.RuleName = "other/**" },
		"flags":         func(v *golfv1.RepositoryBranchProtection) { v.EnablePush = !v.EnablePush },
		"files":         func(v *golfv1.RepositoryBranchProtection) { v.ProtectedFilePatterns = "other/**" },
		"unknown field": func(v *golfv1.RepositoryBranchProtection) { v.ProtoReflect().SetUnknown([]byte{0xa0, 0x06, 0x01}) },
	} {
		t.Run(name, func(t *testing.T) {
			bad := proto.Clone(desired).(*golfv1.RepositoryBranchProtection)
			change(bad)
			if branchRuleEquivalent(desired, bad) {
				t.Fatal("non-membership configuration changed")
			}
		})
	}
}

func TestRuleMutationBranchAllowlistWholeReadback(t *testing.T) {
	m := ruleRequestFixture()
	m.DesiredBranch.PushUsernames = []string{"zeta", "alice"}
	merge, _ := wireMergeConfiguration(rulesRepositoryFixture())
	unrelated := writableBranchFixture()
	unrelated.RuleName = "other/**"
	unrelated.MergeUsernames = []string{"other-b", "other-a"}
	before := &golfv1.GetRepositoryRulesResponse{RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.ExpectedAccessRevision, BranchProtections: []*golfv1.RepositoryBranchProtection{writableBranchFixture(), unrelated}, TagProtections: []*golfv1.RepositoryTagProtection{{Id: "21", NamePattern: "v*", AllowedUsernames: []string{"other-b", "other-a"}}}, MergeConfiguration: merge}
	receipt := proto.Clone(m.DesiredBranch).(*golfv1.RepositoryBranchProtection)
	slices.Reverse(receipt.PushUsernames)
	receipt.CreatedAt, receipt.UpdatedAt = "2026-10-04T00:00:00Z", "2026-10-04T01:00:00Z"
	after := proto.Clone(before).(*golfv1.GetRepositoryRulesResponse)
	after.BranchProtections[0] = receipt
	if !verifyRuleReadback(m, before, after, receipt, nil, nil) {
		t.Fatal("selected branch inventory ordering refused")
	}
	for name, change := range map[string]func(*golfv1.GetRepositoryRulesResponse){
		"selected independent order": func(v *golfv1.GetRepositoryRulesResponse) { slices.Reverse(v.BranchProtections[0].PushUsernames) },
		"selected timestamp":         func(v *golfv1.GetRepositoryRulesResponse) { v.BranchProtections[0].UpdatedAt = "2026-10-04T02:00:00Z" },
		"unrelated branch order":     func(v *golfv1.GetRepositoryRulesResponse) { slices.Reverse(v.BranchProtections[1].MergeUsernames) },
		"unrelated tag order":        func(v *golfv1.GetRepositoryRulesResponse) { slices.Reverse(v.TagProtections[0].AllowedUsernames) },
		"authority":                  func(v *golfv1.GetRepositoryRulesResponse) { v.AccessRevision = strings.Repeat("c", 64) },
		"merge": func(v *golfv1.GetRepositoryRulesResponse) {
			v.MergeConfiguration.AllowManualMerge = !v.MergeConfiguration.AllowManualMerge
		},
	} {
		t.Run(name, func(t *testing.T) {
			bad := proto.Clone(after).(*golfv1.GetRepositoryRulesResponse)
			change(bad)
			if verifyRuleReadback(m, before, bad, receipt, nil, nil) {
				t.Fatal("strict independent whole-inventory comparison weakened")
			}
		})
	}
}

// Requires the owned source-only PostgreSQL harness. This is not native API qualification.
func TestRuleMutationsBranchAllowlistOrderPostgres(t *testing.T) {
	db := testDatabase(t)
	f := newRuleMutationFixture(t)
	s, err := New(testConfig(f.provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "rules-source-only", "")
	if err != nil {
		t.Fatal(err)
	}
	credential := forgeCredential{Kind: "pat", Token: "rules-source-only"}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, credential)
	before, err := s.currentRuleInventory(ctx, session.Value, credential, repositoryKey{"alice", "example"}, "9007199254740993", "42")
	if err != nil {
		t.Fatal(err)
	}
	m := ruleRequestFixture()
	m.ExpectedAccessRevision, m.ExpectedRulesRevision = before.AccessRevision, before.RulesRevision
	m.DesiredBranch.EnablePush = true
	m.DesiredBranch.EnablePushWhitelist = true
	m.DesiredBranch.EnableForcePush = true
	m.DesiredBranch.EnableForcePushAllowlist = true
	m.DesiredBranch.EnableBypassAllowlist = true
	m.DesiredBranch.PushUsernames = []string{"alice", "direct"}
	m.DesiredBranch.ForcePushUsernames = []string{"alice", "direct"}
	m.DesiredBranch.MergeUsernames = []string{"alice", "direct"}
	m.DesiredBranch.BypassUsernames = []string{"alice", "direct"}
	m.DesiredBranch.ApprovalsUsernames = []string{"alice", "direct"}
	f.fault = "branch-inventory-order"
	request := connect.NewRequest(m)
	request.Header().Set("Origin", s.config.PublicURL)
	request.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
	result, err := s.MutateRepositoryRules(ctx, request)
	if err != nil || result == nil || result.Msg.Operation.Phase != "SUCCEEDED" || result.Msg.CurrentRules == nil || f.writes.Load() != 1 {
		t.Fatal("reordered native branch acknowledgement/readback must succeed once", err)
	}
	got := result.Msg.CurrentRules.BranchProtections[0]
	for _, list := range [][]string{got.PushUsernames, got.ForcePushUsernames, got.MergeUsernames, got.BypassUsernames, got.ApprovalsUsernames} {
		if !slices.Equal(list, []string{"direct", "alice"}) {
			t.Fatal("native inventory order was rewritten")
		}
	}
	if !slices.Equal(m.DesiredBranch.PushUsernames, []string{"alice", "direct"}) {
		t.Fatal("original fingerprint input rewritten")
	}
	statusRequest := connect.NewRequest(&golfv1.GetRepositoryRuleMutationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
	statusRequest.Header().Set("Origin", s.config.PublicURL)
	statusRequest.Header().Set("Cookie", request.Header().Get("Cookie"))
	status, err := s.GetRepositoryRuleMutation(ctx, statusRequest)
	if err != nil || status == nil || status.Msg.Operation.Phase != "SUCCEEDED" || f.writes.Load() != 1 {
		t.Fatal("status inspection changed outcome or resent", err)
	}
	replay, err := s.MutateRepositoryRules(ctx, request)
	if err != nil || replay == nil || replay.Msg.Operation.Phase != "SUCCEEDED" || replay.Msg.CurrentRules != nil || f.writes.Load() != 1 {
		t.Fatal("original replay redispatched", err)
	}
	slices.Reverse(m.DesiredBranch.PushUsernames)
	if _, err = s.MutateRepositoryRules(ctx, request); connect.CodeOf(err) != connect.CodeFailedPrecondition || f.writes.Load() != 1 {
		t.Fatal("set-equivalent input cannot change original key fingerprint", err)
	}
}

// Requires the owned disposable Golf database harness. No live/native resources.
func TestRuleMutationsTagPreflightRefusalPostgres(t *testing.T) {
	for _, fault := range []string{"unrepresentable public read", "lost held direct membership", "replaced held user identity"} {
		t.Run(fault, func(t *testing.T) {
			db := testDatabase(t)
			f := newRuleMutationFixture(t)
			original := f.provider.Config.Handler
			var userReads, collaborationReads atomic.Int64
			f.provider.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					switch r.URL.Path {
					case "/api/v1/users/direct":
						id := int64(43)
						if userReads.Add(1) > 1 && fault == "replaced held user identity" {
							id = 44
						}
						json.NewEncoder(w).Encode(User{ID: id, Login: "direct"})
						return
					case "/api/v1/repos/alice/example/collaborators/direct":
						if collaborationReads.Add(1) > 1 && fault == "lost held direct membership" {
							w.WriteHeader(404)
							return
						}
						w.WriteHeader(204)
						return
					case "/api/v1/repos/alice/example/collaborators/direct/permission":
						permission := "write"
						if fault == "unrepresentable public read" {
							permission = "read"
						}
						id := int64(43)
						if userReads.Load() > 1 && fault == "replaced held user identity" {
							id = 44
						}
						json.NewEncoder(w).Encode(map[string]any{"permission": permission, "user": User{ID: id, Login: "direct"}})
						return
					}
				}
				original.ServeHTTP(w, r)
			})
			s, err := New(testConfig(f.provider.URL), db)
			if err != nil {
				t.Fatal(err)
			}
			session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "rules-source-only", "")
			if err != nil {
				t.Fatal(err)
			}
			credential := forgeCredential{Kind: "pat", Token: "rules-source-only"}
			ctx := context.WithValue(t.Context(), sessionTokenKey{}, credential)
			before, err := s.currentRuleInventory(ctx, session.Value, credential, repositoryKey{"alice", "example"}, "9007199254740993", "42")
			if err != nil {
				t.Fatal(err)
			}
			m := ruleRequestFixture()
			m.Action, m.RuleName, m.DesiredBranch = golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_EDIT_TAG, "", nil
			m.TagId = before.TagProtections[0].Id
			m.DesiredTag = &golfv1.RepositoryTagProtection{NamePattern: before.TagProtections[0].NamePattern, AllowedUsernames: []string{"direct"}}
			m.ExpectedAccessRevision, m.ExpectedRulesRevision = before.AccessRevision, before.RulesRevision
			request := connect.NewRequest(m)
			request.Header().Set("Origin", s.config.PublicURL)
			request.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
			result, err := s.MutateRepositoryRules(ctx, request)
			phase := "DISPATCH_UNKNOWN"
			if fault == "unrepresentable public read" {
				phase = "REJECTED"
				if err != nil || result == nil || result.Msg.Operation.Phase != phase {
					t.Fatal("early complete unsupported proof must durably reject", err)
				}
			} else if connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("held positive-proof loss must fail closed", err)
			}
			if f.writes.Load() != 0 {
				t.Fatal("refused selection sent native write")
			}
			status := connect.NewRequest(&golfv1.GetRepositoryRuleMutationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
			status.Header().Set("Origin", s.config.PublicURL)
			status.Header().Set("Cookie", request.Header().Get("Cookie"))
			inspected, err := s.GetRepositoryRuleMutation(ctx, status)
			if err != nil || inspected.Msg.Operation.Phase != phase {
				t.Fatal("original phase must remain inspectable", err)
			}
			// Restore source evidence; neither original replay nor UNKNOWN's new key
			// may bypass the original once-only outcome boundary.
			f.provider.Config.Handler = original
			replay, err := s.MutateRepositoryRules(ctx, request)
			if err != nil || replay.Msg.Operation.Phase != phase || f.writes.Load() != 0 {
				t.Fatal("original inspection/replay changed effect", err)
			}
			if phase == "DISPATCH_UNKNOWN" {
				m.OperationId = "54e788c6-7be6-4dd6-a71a-1a329fd7a4c6"
				if _, err = s.MutateRepositoryRules(ctx, request); connect.CodeOf(err) != connect.CodeFailedPrecondition || f.writes.Load() != 0 {
					t.Fatal("fresh key bypassed unknown exclusion", err)
				}
			}
		})
	}
}
