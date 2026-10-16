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
		req := connect.NewRequest(&golfv1.UpdateExecutionPolicyRequest{Scope: policy.Scope, Repository: key, ScopeId: policy.ScopeId, ExpectedRevision: policy.Revision, ExpectedAuthorityRevision: policy.AuthorityRevision, Mode: golfv1.ExecutionMode_EXECUTION_MODE_ALL, ManualDispatchEnabled: true, PushAllowed: policy.PushAllowed, WorkflowPaths: []string{".github/workflows/check.yml"}})
		req.Header().Set("Cookie", cookie)
		return s.UpdateExecutionPolicy(ctx, req)
	}
	original := get()
	if original.Mode != golfv1.ExecutionMode_EXECUTION_MODE_DISABLED || original.Revision != "0" || original.PushAllowed || !original.CanEdit {
		t.Fatal("initial policy not disabled")
	}
	original.PushAllowed = true
	updated, err := update(original)
	if err != nil || updated.Msg.Policy.Revision != "1" || updated.Msg.Policy.RevocationEpoch != "1" || !updated.Msg.Policy.PushAllowed {
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
	before.PushAllowed = false
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
	var currentPush, auditedPush bool
	if err = db.QueryRowContext(t.Context(), "SELECT push_allowed FROM golf_execution_policies").Scan(&currentPush); err != nil || currentPush {
		t.Fatal("push disable was not persisted", err)
	}
	if err = db.QueryRowContext(t.Context(), "SELECT push_allowed FROM golf_execution_policy_events ORDER BY revision LIMIT 1").Scan(&auditedPush); err != nil || !auditedPush {
		t.Fatal("push enable was not audited", err)
	}
	if err = db.QueryRowContext(t.Context(), "SELECT push_allowed FROM golf_execution_policy_events ORDER BY revision DESC LIMIT 1").Scan(&auditedPush); err != nil || auditedPush {
		t.Fatal("push disable was not audited", err)
	}
	// A policy/epoch change may not survive failure to append its actor event.
	if _, err = db.Exec(`CREATE FUNCTION reject_push_policy_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER reject_push_policy_fixture BEFORE INSERT ON golf_execution_policy_events FOR EACH ROW EXECUTE FUNCTION reject_push_policy_fixture()`); err != nil {
		t.Fatal(err)
	}
	attempted := get()
	attempted.PushAllowed = true
	if _, err = update(attempted); err == nil {
		t.Fatal("unaudited push update succeeded")
	}
	if _, err = db.Exec("DROP TRIGGER reject_push_policy_fixture ON golf_execution_policy_events"); err != nil {
		t.Fatal(err)
	}
	restored := get()
	if restored.PushAllowed || restored.Revision != "2" || restored.RevocationEpoch != "2" {
		t.Fatal("push/audit transaction failed to roll back")
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

func TestExecutionPolicyPushIndependentCeilings(t *testing.T) {
	const path = ".github/workflows/check.yml"
	policies := []executionPolicyState{
		{Scope: "instance", ScopeID: "instance", Mode: "all", ManualDispatchEnabled: true, AllowAllWorkflows: true},
		{Scope: "organization", ScopeID: "42", OwnerID: 42, Mode: "all", ManualDispatchEnabled: true, AllowAllWorkflows: true},
		{Scope: "repository", ScopeID: "99", OwnerID: 42, Mode: "all", ManualDispatchEnabled: true, Workflows: []string{path}},
	}
	if executionPoliciesAllow(policies, 99, 42, true, "push", path) {
		t.Fatal("manual permission enabled push")
	}
	for i := range policies {
		policies[i].PushAllowed = true
		policies[i].ManualDispatchEnabled = false
	}
	if !executionPoliciesAllow(policies, 99, 42, true, "push", path) {
		t.Fatal("explicit push-only ceilings denied")
	}
	if executionPoliciesAllow(policies, 99, 42, true, "manual", path) {
		t.Fatal("push permission enabled manual")
	}
	for i := range policies {
		for _, mode := range []string{"switch", "disabled", "workflow", "selected owner"} {
			changed := append([]executionPolicyState(nil), policies...)
			switch mode {
			case "switch":
				changed[i].PushAllowed = false
			case "disabled":
				changed[i].Mode = "disabled"
			case "workflow":
				changed[i].AllowAllWorkflows = false
				changed[i].Workflows = nil
			case "selected owner":
				if changed[i].Scope == "repository" {
					changed[i].OwnerID = 43
				} else {
					changed[i].Mode = "selected"
					changed[i].Repositories = map[int64]int64{99: 43}
				}
			}
			if executionPoliciesAllow(changed, 99, 42, true, "push", path) {
				t.Fatal("push ceiling bypass", policies[i].Scope, mode)
			}
		}
	}
	for _, kind := range []string{"", "schedule", "pull_request", "PUSH", "manual ", "push "} {
		if executionPoliciesAllow(policies, 99, 42, true, kind, path) {
			t.Fatal("unknown event admitted", kind)
		}
	}
	if executionPoliciesAllow(policies[:2], 99, 42, true, "push", path) || executionPoliciesAllow([]executionPolicyState{policies[0], policies[2]}, 99, 42, true, "push", path) {
		t.Fatal("missing push ceiling bypassed")
	}
	if !executionPoliciesAllow([]executionPolicyState{policies[0], policies[2]}, 99, 42, false, "push", path) {
		t.Fatal("personal push requires nonexistent organization")
	}
}

func TestExecutionPolicyPushAdmissionPostgres(t *testing.T) {
	db := testDatabase(t)
	s, err := New(testConfig("http://forgejo.invalid"), db)
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range []struct {
		name, id string
		owner    int64
	}{{"instance", "instance", 0}, {"organization", "42", 42}, {"repository", "99", 42}} {
		if _, err = db.Exec(`INSERT INTO golf_execution_policies(forge_url,scope,scope_id,owner_id,mode,manual_dispatch_enabled,allow_all_workflows) VALUES($1,$2,$3,$4,'all',true,true)`, s.config.ForgeURL, scope.name, scope.id, scope.owner); err != nil {
			t.Fatal(err)
		}
	}
	check := func(kind string, allowed bool) ExecutionAdmission {
		t.Helper()
		tx, e := db.BeginTx(t.Context(), nil)
		if e != nil {
			t.Fatal(e)
		}
		admission, e := s.readEffectiveExecutionPolicyForEvent(t.Context(), tx, 99, 42, true, kind, ".github/workflows/check.yml")
		tx.Rollback()
		if e != nil || admission.Allowed != allowed || len(admission.Epochs) != 3 {
			t.Fatal("incorrect event admission", kind, e, admission)
		}
		return admission
	}
	check("manual", true)
	check("push", false)
	if _, err = db.Exec(`UPDATE golf_execution_policies SET push_allowed=true,manual_dispatch_enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1`); err != nil {
		t.Fatal(err)
	}
	admitted := check("push", true)
	check("manual", false)
	for _, scope := range []string{"instance", "organization", "repository"} {
		if _, err = db.Exec(`UPDATE golf_execution_policies SET push_allowed=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope=$1`, scope); err != nil {
			t.Fatal(err)
		}
		revoked := check("push", false)
		var changed bool
		for i, epoch := range revoked.Epochs {
			if epoch.Scope == scope {
				changed = epoch.Revision > admitted.Epochs[i].Revision && epoch.RevocationEpoch > admitted.Epochs[i].RevocationEpoch
			}
		}
		if !changed {
			t.Fatal("push revocation stamp unchanged", scope)
		}
		if _, err = db.Exec(`UPDATE golf_execution_policies SET push_allowed=true WHERE scope=$1`, scope); err != nil {
			t.Fatal(err)
		}
	}
	check("schedule", false)
	// The old helper is intentionally manual-only even when push is permitted.
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := s.readEffectiveExecutionPolicy(t.Context(), tx, 99, 42, true, ".github/workflows/check.yml")
	tx.Rollback()
	if err != nil || legacy.Allowed {
		t.Fatal("manual helper inherited push permission", err)
	}
	// Immutable selected bindings and workflow restrictions still constrain push.
	if _, err = db.Exec(`UPDATE golf_execution_policies SET mode='selected' WHERE scope='instance'`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO golf_execution_policy_repositories(forge_url,scope,scope_id,repository_id,owner_id) VALUES($1,'instance','instance',99,43)`, s.config.ForgeURL); err != nil {
		t.Fatal(err)
	}
	check("push", false)
	if _, err = db.Exec(`UPDATE golf_execution_policy_repositories SET owner_id=42`); err != nil {
		t.Fatal(err)
	}
	check("push", true)
}
