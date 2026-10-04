package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func policyInspection(t *testing.T, f *workflowFixture, session loginResult, id string, expected int) *golfv1.InspectWorkflowsResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"repository": map[string]string{"owner": "alice", "name": "private"}, "ref": "main", "repositoryId": id})
	req := httptest.NewRequest("POST", "/rpc"+golfv1connect.WorkflowServiceInspectWorkflowsProcedure, strings.NewReader(string(body)))
	req.Header.Set("Origin", f.s.config.PublicURL)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.AddCookie(f.s.sessionCookie(session.Value, session.Expires, 3600))
	response := httptest.NewRecorder()
	f.s.ServeHTTP(response, req)
	if response.Code != expected {
		t.Fatalf("inspection status %d, expected %d", response.Code, expected)
	}
	if expected != 200 {
		if strings.Contains(response.Body.String(), "configurations") || strings.Contains(response.Body.String(), "untrusted-script") {
			t.Fatal("refusal disclosed source")
		}
		return nil
	}
	var result golfv1.InspectWorkflowsResponse
	if err := protojson.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return &result
}

func seedObservationPolicies(t *testing.T, s *Server) {
	t.Helper()
	for _, statement := range []string{
		`INSERT INTO golf_execution_policies(forge_url,scope,scope_id,owner_id,mode,manual_dispatch_enabled,push_allowed,allow_all_workflows,revision,revocation_epoch) VALUES($1,'instance','instance',0,'selected',false,true,false,3,2),($1,'repository','11',42,'all',true,true,true,5,4)`,
		`INSERT INTO golf_execution_policy_repositories(forge_url,scope,scope_id,repository_id,owner_id) VALUES($1,'instance','instance',11,42),($1,'instance','instance',999,55)`,
		`INSERT INTO golf_execution_policy_workflows(forge_url,scope,scope_id,workflow_path) VALUES($1,'instance','instance','.github/workflows/check.yml')`,
	} {
		if _, err := s.db.Exec(statement, s.config.GiteaURL); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWorkflowPolicyObservationPostgres(t *testing.T) {
	f, session := newWorkflowFixture(t)
	// Configured runner keys/images are independent of denied policy ceilings.
	f.s.runnerKeys = map[string][32]byte{"configured-not-live": {}}
	f.s.runnerImages = map[string]string{"linux": "configured-not-live"}
	result := policyInspection(t, f, session, "11", 200)
	if !result.ExecutionAvailable || !validAccessRevision(result.PolicyRevision) || len(result.Configurations) != 2 {
		t.Fatal("missing configuration/epoch observation")
	}
	for _, row := range result.Configurations {
		if row.ManualPolicyAllowed == nil || row.PushPolicyAllowed == nil || *row.ManualPolicyAllowed || *row.PushPolicyAllowed {
			t.Fatal("missing policy was not known denial")
		}
	}
	var count int
	if err := f.s.db.QueryRow(`SELECT count(*) FROM golf_execution_policies`).Scan(&count); err != nil || count != 0 {
		t.Fatal("inspection created missing policies", err)
	}
	initial := result.PolicyRevision
	f.contentReads.Store(0)
	for _, id := range []string{"12", "011", "-1", "9223372036854775808"} {
		policyInspection(t, f, session, id, 400)
	}
	if f.contentReads.Load() != 0 {
		t.Fatal("invalid/wrong target read source blobs")
	}
	seedObservationPolicies(t, f.s)
	result = policyInspection(t, f, session, "", 200) // bounded legacy call retains native receipt
	if result.RepositoryId != "11" || result.PolicyRevision == initial || !validAccessRevision(result.PolicyRevision) {
		t.Fatal("legacy identity or policy epoch observation missing")
	}
	check, gitlab := result.Configurations[0], result.Configurations[1]
	if check.ManualPolicyAllowed == nil || *check.ManualPolicyAllowed || check.PushPolicyAllowed == nil || !*check.PushPolicyAllowed || gitlab.ManualPolicyAllowed == nil || *gitlab.ManualPolicyAllowed || gitlab.PushPolicyAllowed == nil || *gitlab.PushPolicyAllowed {
		t.Fatal("event and exact-path ceilings were conflated")
	}
	prior := result.PolicyRevision
	if _, err := f.s.db.Exec(`UPDATE golf_execution_policies SET manual_dispatch_enabled=true,push_allowed=false,allow_all_workflows=true,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope='instance'`); err != nil {
		t.Fatal(err)
	}
	result = policyInspection(t, f, session, "11", 200)
	if result.PolicyRevision == prior || result.Configurations[1].State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_UNSUPPORTED {
		t.Fatal("policy epoch/source compatibility lost")
	}
	for _, row := range result.Configurations {
		if row.ManualPolicyAllowed == nil || !*row.ManualPolicyAllowed || row.PushPolicyAllowed == nil || *row.PushPolicyAllowed {
			t.Fatal("policy observation was treated as executable compatibility or inherited push")
		}
	}
	// No active grant or run is fabricated by a permitted policy observation.
	for _, table := range []string{"golf_automation_grants", "golf_workflow_runs", "golf_execution_policy_events"} {
		if err := f.s.db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatal("read inspection created execution authority/history", table, err)
		}
	}
}

func TestWorkflowPolicyUnavailablePostgres(t *testing.T) {
	f, session := newWorkflowFixture(t)
	seedObservationPolicies(t, f.s)
	if _, err := f.s.db.Exec(`ALTER TABLE golf_execution_policies RENAME TO policy_unavailable_fixture`); err != nil {
		t.Fatal(err)
	}
	defer f.s.db.Exec(`ALTER TABLE policy_unavailable_fixture RENAME TO golf_execution_policies`)
	result := policyInspection(t, f, session, "11", 200)
	if result.PolicyRevision != "" || len(result.Diagnostics) != 1 || result.Diagnostics[0].Code != "policy_unavailable" || len(result.Configurations) != 2 {
		t.Fatal("unavailable policy observation was not isolated from exact source inspection")
	}
	for _, row := range result.Configurations {
		if row.ManualPolicyAllowed != nil || row.PushPolicyAllowed != nil {
			t.Fatal("failed policy read became definitive denial/allow")
		}
	}
	if strings.Contains(result.Diagnostics[0].Message, "999") || strings.Contains(result.Diagnostics[0].Message, "55") || strings.Contains(result.Diagnostics[0].Message, "policy_unavailable_fixture") {
		t.Fatal("diagnostic exposed other selected targets or storage detail")
	}
}

func TestWorkflowPolicyReadSnapshotPostgres(t *testing.T) {
	f, _ := newWorkflowFixture(t)
	seedObservationPolicies(t, f.s)
	tx, err := f.s.db.BeginTx(t.Context(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// Establish the snapshot independently before an atomic policy change.
	var revision int64
	if err = tx.QueryRow(`SELECT revision FROM golf_execution_policies WHERE scope='instance'`).Scan(&revision); err != nil || revision != 3 {
		t.Fatal("initial policy revision", err)
	}
	if _, err = f.s.db.Exec(`UPDATE golf_execution_policies SET push_allowed=false,revision=revision+1,revocation_epoch=revocation_epoch+1`); err != nil {
		t.Fatal(err)
	}
	states, epochs, err := f.s.readExecutionPolicyStates(t.Context(), tx, 11, 42, false, false)
	if err != nil || len(epochs) != 2 || epochs[0].Revision != 3 || epochs[1].Revision != 5 || !executionPoliciesAllow(states, 11, 42, false, "push", ".github/workflows/check.yml") {
		t.Fatal("one snapshot mixed policy epochs", err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	result := &golfv1.InspectWorkflowsResponse{Configurations: []*golfv1.WorkflowConfiguration{{Path: ".github/workflows/check.yml"}}}
	if err = f.s.observeWorkflowPolicies(t.Context(), 11, workflowOwnerBinding{42, false}, result); err != nil || result.Configurations[0].PushPolicyAllowed == nil || *result.Configurations[0].PushPolicyAllowed {
		t.Fatal("new observation did not see committed policy revocation", err)
	}
	// Ordinary snapshot reads must not wait for dispatch/writer row locks.
	held, err := f.s.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err = held.Exec(`SELECT 1 FROM golf_execution_policies FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err = f.s.observeWorkflowPolicies(ctx, 11, workflowOwnerBinding{42, false}, result); err != nil {
		t.Fatal("inspection acquired mutation locks", err)
	}
}

func TestWorkflowPolicyRequiredScopePostgres(t *testing.T) {
	f, _ := newWorkflowFixture(t)
	seedObservationPolicies(t, f.s)
	observe := func() *golfv1.InspectWorkflowsResponse {
		t.Helper()
		result := &golfv1.InspectWorkflowsResponse{Configurations: []*golfv1.WorkflowConfiguration{{Path: ".github/workflows/check.yml"}}}
		if err := f.s.observeWorkflowPolicies(t.Context(), 11, workflowOwnerBinding{42, true}, result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	missing := observe()
	if missing.Configurations[0].PushPolicyAllowed == nil || *missing.Configurations[0].PushPolicyAllowed {
		t.Fatal("organization ceiling bypassed by repository/instance policy")
	}
	if _, err := f.s.db.Exec(`INSERT INTO golf_execution_policies(forge_url,scope,scope_id,owner_id,mode,manual_dispatch_enabled,push_allowed,allow_all_workflows,revision,revocation_epoch) VALUES($1,'organization','42',42,'all',true,true,true,1,1)`, f.s.config.GiteaURL); err != nil {
		t.Fatal(err)
	}
	allowed := observe()
	if !*allowed.Configurations[0].PushPolicyAllowed || *allowed.Configurations[0].ManualPolicyAllowed || allowed.PolicyRevision == missing.PolicyRevision {
		t.Fatal("three required ceilings or event independence lost")
	}
	if _, err := f.s.db.Exec(`UPDATE golf_execution_policy_repositories SET owner_id=55 WHERE repository_id=11`); err != nil {
		t.Fatal(err)
	}
	if *observe().Configurations[0].PushPolicyAllowed {
		t.Fatal("selected repository permission inherited from a different owner")
	}
}
