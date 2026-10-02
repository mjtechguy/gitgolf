package server

import (
	"connectrpc.com/connect"
	"context"
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestExecutionPolicyDenyDominance(t *testing.T) {
	instance := executionPolicyState{Scope: "instance", ScopeID: "instance", Mode: "all", ManualDispatchEnabled: true, AllowAllWorkflows: true}
	repository := executionPolicyState{Scope: "repository", ScopeID: "99", OwnerID: 42, Mode: "all", ManualDispatchEnabled: true, Workflows: []string{".github/workflows/check.yml"}}
	org := executionPolicyState{Scope: "organization", ScopeID: "42", OwnerID: 42, Mode: "all", ManualDispatchEnabled: true, AllowAllWorkflows: true}
	for _, test := range []struct {
		name         string
		policies     []executionPolicyState
		repo, owner  int64
		organization bool
		event, path  string
		allowed      bool
	}{
		{"personal grant", []executionPolicyState{instance, repository}, 99, 42, false, "manual", ".github/workflows/check.yml", true},
		{"organization grant", []executionPolicyState{instance, org, repository}, 99, 42, true, "manual", ".github/workflows/check.yml", true},
		{"missing instance", []executionPolicyState{repository}, 99, 42, false, "manual", ".github/workflows/check.yml", false},
		{"missing organization", []executionPolicyState{instance, repository}, 99, 42, true, "manual", ".github/workflows/check.yml", false},
		{"new repository disabled", []executionPolicyState{instance, repository}, 100, 42, false, "manual", ".github/workflows/check.yml", false},
		{"transfer disabled", []executionPolicyState{instance, repository}, 99, 43, false, "manual", ".github/workflows/check.yml", false},
		{"unsupported event", []executionPolicyState{instance, repository}, 99, 42, false, "push", ".github/workflows/check.yml", false},
		{"workflow cannot expand", []executionPolicyState{instance, repository}, 99, 42, false, "manual", ".github/workflows/other.yml", false},
		{"duplicate ceiling", []executionPolicyState{instance, instance, repository}, 99, 42, false, "manual", ".github/workflows/check.yml", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if executionPoliciesAllow(test.policies, test.repo, test.owner, test.organization, test.event, test.path) != test.allowed {
				t.Fatal("incorrect effective policy")
			}
		})
	}
	for _, scope := range []string{"instance", "organization", "repository"} {
		policies := []executionPolicyState{instance, org, repository}
		for i := range policies {
			if policies[i].Scope == scope {
				policies[i].Mode = "disabled"
			}
		}
		if executionPoliciesAllow(policies, 99, 42, true, "manual", ".github/workflows/check.yml") {
			t.Fatal("deny overridden", scope)
		}
	}
	instance.Mode = "selected"
	instance.Repositories = map[int64]int64{99: 42}
	if !executionPoliciesAllow([]executionPolicyState{instance, repository}, 99, 42, false, "manual", ".github/workflows/check.yml") {
		t.Fatal("selected immutable grant denied")
	}
	instance.Repositories[99] = 43
	if executionPoliciesAllow([]executionPolicyState{instance, repository}, 99, 42, false, "manual", ".github/workflows/check.yml") {
		t.Fatal("selected owner mismatch allowed")
	}
	instance.Mode = "all"
	instance.AllowAllWorkflows = false
	instance.Workflows = nil
	if executionPoliciesAllow([]executionPolicyState{instance, repository}, 99, 42, false, "manual", ".github/workflows/check.yml") {
		t.Fatal("empty workflow list allowed")
	}
}
func TestExecutionWorkflowPath(t *testing.T) {
	for _, path := range []string{".github/workflows/check.yml", ".github/workflows/golf-test.yaml", ".gitlab-ci.yml"} {
		if !executionWorkflowPath(path) {
			t.Fatal("valid path rejected", path)
		}
	}
	for _, path := range []string{".github/workflows/*.yml", ".github/workflows/a/b.yml", ".github/workflows/../check.yml", ".github/workflows/check.yaml\n", ".gitlab-ci.yaml", ".github/workflows/check.yml?next"} {
		if executionWorkflowPath(path) {
			t.Fatal("invalid path accepted", path)
		}
	}
}

func TestExecutionPolicyPostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	row := settingsFixtureRow()
	row.Private = true
	var onRepository func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
		case "/api/v1/repos/alice/example":
			if onRepository != nil {
				onRepository()
			}
			json.NewEncoder(w).Encode(row)
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{*row.Owner}})
		case "/api/v1/repos/alice/example/collaborators/alice/permission":
			json.NewEncoder(w).Encode(map[string]any{"permission": "owner", "user": *row.Owner})
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "policy-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "policy-fixture"})
	cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
	key := &golfv1.RepositoryKey{Owner: "alice", Name: "example"}
	get := func() *golfv1.ExecutionPolicy {
		req := connect.NewRequest(&golfv1.GetExecutionPolicyRequest{Scope: golfv1.ExecutionScope_EXECUTION_SCOPE_REPOSITORY, Repository: key})
		req.Header().Set("Cookie", cookie)
		got, err := s.GetExecutionPolicy(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return got.Msg.Policy
	}
	update := func(policy *golfv1.ExecutionPolicy) (*connect.Response[golfv1.UpdateExecutionPolicyResponse], error) {
		req := connect.NewRequest(&golfv1.UpdateExecutionPolicyRequest{Scope: policy.Scope, Repository: key, ScopeId: policy.ScopeId, ExpectedRevision: policy.Revision, ExpectedAuthorityRevision: policy.AuthorityRevision, Mode: golfv1.ExecutionMode_EXECUTION_MODE_ALL, ManualDispatchEnabled: true, WorkflowPaths: []string{".github/workflows/check.yml"}})
		req.Header().Set("Cookie", cookie)
		return s.UpdateExecutionPolicy(ctx, req)
	}
	original := get()
	if original.Mode != golfv1.ExecutionMode_EXECUTION_MODE_DISABLED || original.Revision != "0" || !original.CanEdit {
		t.Fatal("initial policy not disabled")
	}
	updated, err := update(original)
	if err != nil || updated.Msg.Policy.Revision != "1" || updated.Msg.Policy.RevocationEpoch != "1" {
		t.Fatal("first update", err)
	}
	if _, err = update(original); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale update", err)
	}
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	admission, err := s.readEffectiveExecutionPolicy(t.Context(), tx, row.ID, row.Owner.ID, false, ".github/workflows/check.yml")
	tx.Rollback()
	if err != nil || admission.Allowed || len(admission.Epochs) != 2 {
		t.Fatal("repository bypassed missing instance ceiling", err)
	}
	before := get()
	var wait sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() { defer wait.Done(); _, err := update(before); results <- err }()
	}
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if connect.CodeOf(err) == connect.CodeFailedPrecondition {
			conflicts++
		} else {
			t.Fatal("concurrent save", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("CAS did not serialize", successes, conflicts)
	}
	var events int
	var revision, epoch int64
	if err = db.QueryRowContext(t.Context(), "SELECT count(*) FROM golf_execution_policy_events").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRowContext(t.Context(), "SELECT revision,revocation_epoch FROM golf_execution_policies").Scan(&revision, &epoch); err != nil {
		t.Fatal(err)
	}
	if events != 2 || revision != 2 || epoch != 2 {
		t.Fatal("audit/revision/epoch not atomic", events, revision, epoch)
	}
	var actorID, actorSession int64
	if err = db.QueryRowContext(t.Context(), "SELECT actor_user_id,actor_session_id FROM golf_execution_policy_events ORDER BY id LIMIT 1").Scan(&actorID, &actorSession); err != nil || actorID <= 0 || actorSession <= 0 {
		t.Fatal("missing actor", err)
	}
	current := get()
	mu.Lock()
	row.Permissions.Admin = false
	mu.Unlock()
	if _, err = update(current); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("revoked native authority saved", err)
	}
	mu.Lock()
	row.Permissions.Admin = true
	mu.Unlock()
	current = get()
	onRepository = func() {
		onRepository = nil
		if err := s.logoutSession(t.Context(), session.Value); err != nil {
			t.Error(err)
		}
	}
	if _, err = update(current); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("revoked local session saved", err)
	}
	if err = db.QueryRowContext(t.Context(), "SELECT count(*) FROM golf_execution_policy_events").Scan(&events); err != nil || events != 2 {
		t.Fatal("denied save audited as success", err)
	}
}
