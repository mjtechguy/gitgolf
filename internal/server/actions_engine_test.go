package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

const engineGraphFixture = `on: [push, workflow_dispatch]
defaults: {run: {shell: sh}}
jobs:
  build:
    runs-on: linux
    steps: [{id: first, name: First, run: printf-private-source-one}]
  test:
    needs: build
    runs-on: linux
    strategy: {fail-fast: false, max-parallel: 2, matrix: {cell: [a, b]}}
    steps: [{id: second, name: Second, run: printf-private-source-two}]
`

func engineRunFixture(t *testing.T) *workflowRunFixture {
	t.Helper()
	helper := os.Getenv("GOLF_TEST_ACTIONS_HELPER")
	if helper == "" {
		t.Skip("set GOLF_TEST_ACTIONS_HELPER to independently built pinned planner")
	}
	if !filepath.IsAbs(helper) {
		t.Fatal("helper must be absolute")
	}
	f := newWorkflowRunFixture(t)
	f.enable(t)
	f.workflow = []byte(engineGraphFixture)
	f.server.config.ActionsEngineCatalog = runner.ActionsCatalog
	f.server.config.ActionsEngineBinary = helper
	if f.server.validateActionsEngineConfig() != nil {
		t.Fatal("engine fixture enrollment")
	}
	return f
}

type engineLease struct {
	RunID, AttemptID, AttemptToken string
	ActionsPlan                    runner.ActionPlan
}

func engineWorkerCall(f *workflowRunFixture, lease engineLease, action string, body any) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	route := "/internal/ci/poll"
	if action != "poll" {
		route = "/internal/ci/attempt/" + lease.AttemptID + "/" + action
	}
	req := httptest.NewRequest("POST", route, bytes.NewReader(data))
	req.Header.Set("Golf-Runner-ID", "fixture")
	req.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if lease.AttemptToken != "" {
		req.Header.Set("Golf-Attempt-Token", lease.AttemptToken)
	}
	response := httptest.NewRecorder()
	f.server.ServeHTTP(response, req)
	return response
}
func engineAssigned(t *testing.T, f *workflowRunFixture) engineLease {
	t.Helper()
	old := engineWorkerCall(f, engineLease{}, "poll", map[string]any{})
	if old.Code != 204 {
		t.Fatal("legacy worker claimed graph", old.Code)
	}
	response := engineWorkerCall(f, engineLease{}, "poll", map[string]any{"catalogs": []string{runner.ActionsCatalog}, "capabilities": []string{runner.JobLimitsCapability}})
	var lease engineLease
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &lease) != nil || len(lease.ActionsPlan.Jobs) != 3 {
		t.Fatal("upgraded assignment", response.Code)
	}
	return lease
}
func TestActionsEngineGraphReceiptAndExactLogCoordinatesPostgres(t *testing.T) {
	f := engineRunFixture(t)
	dispatched, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	if dispatched.Msg.Run.EngineCatalog != runner.ActionsCatalog {
		t.Fatal("engine admission not visible")
	}
	lease := engineAssigned(t, f)
	seq := 0
	logSeq := 0
	logTexts := map[string]string{}
	post := func(event actionEvent, want int) {
		t.Helper()
		response := engineWorkerCall(f, lease, "graph", map[string]any{"sequence": event.Sequence, "jobInstanceId": event.InstanceID, "stepId": event.StepID, "kind": event.Kind, "state": event.State})
		if response.Code != want {
			t.Fatal("graph event", event.Kind, response.Code, "want", want)
		}
	}
	post(actionEvent{1, lease.ActionsPlan.Jobs[1].InstanceID, "", "job_started", ""}, 409) // unmet genuine needs
	post(actionEvent{1, strings.Repeat("d", 32), "", "job_started", ""}, 400)
	if engineWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "success"}).Code != 409 {
		t.Fatal("empty graph became green")
	}
	for _, job := range lease.ActionsPlan.Jobs {
		seq++
		started := actionEvent{seq, job.InstanceID, "", "job_started", ""}
		post(started, 204)
		post(started, 204)
		changed := started
		changed.Kind = "job_finished"
		changed.State = "success"
		post(changed, 409)
		for _, step := range job.Steps {
			seq++
			post(actionEvent{seq, job.InstanceID, step.ID, "step_started", ""}, 204)
			logSeq++
			text := "owned output " + job.InstanceID + "\n"
			if logSeq == 1 {
				text = `{"kind":"job_finished","state":"success"}` + "\n"
			}
			logTexts[job.InstanceID] = text
			log := engineWorkerCall(f, lease, "logs", map[string]any{"sequence": logSeq, "jobInstanceId": job.InstanceID, "stepId": step.ID, "text": text})
			if log.Code != 204 {
				t.Fatal("exact job log rejected", log.Code)
			}
			seq++
			post(actionEvent{seq, job.InstanceID, step.ID, "step_finished", "success"}, 204)
		}
		seq++
		post(actionEvent{seq, job.InstanceID, "", "job_finished", "success"}, 204)
	}
	seq++
	post(actionEvent{seq, "", "", "complete", "failure"}, 409)
	post(actionEvent{seq, "", "", "complete", "success"}, 204)
	if engineWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "failure"}).Code != 409 {
		t.Fatal("contradictory result accepted")
	}
	if engineWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "success"}).Code != 204 {
		t.Fatal("independent full graph receipt refused")
	}
	detail, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: dispatched.Msg.Run.Id}))
	if err != nil || len(detail.Msg.Run.Jobs) != 3 || detail.Msg.Run.Progress != nil || detail.Msg.Run.ExitCode != nil || detail.Msg.Run.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_SUCCEEDED {
		t.Fatal("graph detail", err)
	}
	if strings.Contains(detail.Msg.String(), "printf-private-source") {
		t.Fatal("source commands in graph metadata")
	}
	for _, job := range detail.Msg.Run.Jobs {
		if job.State != golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_SUCCEEDED || !job.EventsRecorded || job.StartedAt == nil || job.FinishedAt == nil || job.Steps[0].FinishedAt == nil {
			t.Fatal("missing independent graph states")
		}
	}
	var count int
	f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_graph_events WHERE run_id=$1`, lease.RunID).Scan(&count)
	if count != 13 {
		t.Fatal("replay duplicated graph", count)
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_graph_events SET state='failure' WHERE run_id=$1`, lease.RunID); err == nil {
		t.Fatal("immutable receipt edited")
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_job_inventory SET name='different' WHERE run_id=$1`, lease.RunID); err == nil {
		t.Fatal("immutable coordinates edited")
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_runs SET plan='{}'::jsonb WHERE id=$1`, lease.RunID); err == nil {
		t.Fatal("engine/source identity replaced")
	}
	for _, job := range lease.ActionsPlan.Jobs {
		logs, e := f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: lease.RunID, JobInstanceId: job.InstanceID, StepId: job.Steps[0].ID}))
		if e != nil || len(logs.Msg.Logs) != 1 || logs.Msg.Logs[0].Text != logTexts[job.InstanceID] || logs.Msg.RunId != lease.RunID || logs.Msg.AttemptId != lease.AttemptID || logs.Msg.JobInstanceId != job.InstanceID || logs.Msg.StepId != job.Steps[0].ID || logs.Msg.RepositoryId != detail.Msg.Run.RepositoryId || logs.Msg.SourceCommitId != detail.Msg.Run.CommitId {
			t.Fatal("parallel matrix/job log crossed coordinates", e)
		}
	}
	wrongStep := "unknown"
	_, err = f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: lease.RunID, JobInstanceId: lease.ActionsPlan.Jobs[0].InstanceID, StepId: wrongStep}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("unknown coordinates readable", err)
	}
}
func TestActionsEngineRevocationAndMissingReceiptRemainLostPostgres(t *testing.T) {
	f := engineRunFixture(t)
	run, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	lease := engineAssigned(t, f)
	f.mu.Lock()
	f.denied = true
	f.mu.Unlock()
	response := engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 1, "jobInstanceId": lease.ActionsPlan.Jobs[0].InstanceID, "kind": "job_started"})
	if response.Code != 403 {
		t.Fatal("revoked source accepted", response.Code)
	}
	var count int
	f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_graph_events WHERE run_id=$1`, run.Msg.Run.Id).Scan(&count)
	if count != 0 {
		t.Fatal("private revoked graph persisted")
	}
	f.mu.Lock()
	f.denied = false
	f.mu.Unlock()
	if engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 1, "jobInstanceId": lease.ActionsPlan.Jobs[0].InstanceID, "kind": "job_started"}).Code != 403 {
		t.Fatal("revoked attempt replayed")
	}
}

func TestActionsLocalMetadataUsesExactNativeObjects(t *testing.T) {
	const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const name = "actions/owned/action.yml"
	const body = "name: Exact\nruns: {using: composite, steps: [{shell: sh, run: true}]}\n"
	objects := newSourceObjectFixture(commit, map[string]string{name: body}, nil)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !objects.serve(w, r, "/api/v1/repos/a/r") {
			t.Error("mutable/unsupported source read")
			w.WriteHeader(500)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	plan := &runner.ActionPlan{LocalActions: []runner.ActionDependency{{MetadataPath: name, MetadataSHA256: sourceArchiveHash([]byte(body))}}}
	if err = s.verifyActionSources(t.Context(), "/repos/a/r", forgeCredential{Kind: "pat", Token: "source"}, commit, plan); err != nil {
		t.Fatal(err)
	}
	plan.LocalActions[0].MetadataSHA256 = sourceArchiveHash([]byte(body + "export-subst substituted"))
	if !errors.Is(s.verifyActionSources(t.Context(), "/repos/a/r", forgeCredential{Kind: "pat", Token: "source"}, commit, plan), errActionsProfile) {
		t.Fatal("archive replaced native action metadata")
	}
}
func TestActionsEngineLeaseLossRestartCannotReexecutePostgres(t *testing.T) {
	f := engineRunFixture(t)
	run, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	lease := engineAssigned(t, f)
	response := engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 1, "jobInstanceId": lease.ActionsPlan.Jobs[0].InstanceID, "kind": "job_started"})
	if response.Code != 204 {
		t.Fatal("start", response.Code)
	}
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, lease.RunID); err != nil {
		t.Fatal(err)
	}
	if engineWorkerCall(f, engineLease{}, "poll", map[string]any{"catalogs": []string{runner.ActionsCatalog}, "capabilities": []string{runner.JobLimitsCapability}}).Code != 204 {
		t.Fatal("lost run automatically reassigned")
	}
	if engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 2, "jobInstanceId": lease.ActionsPlan.Jobs[0].InstanceID, "stepId": lease.ActionsPlan.Jobs[0].Steps[0].ID, "kind": "step_started"}).Code != 403 {
		t.Fatal("expired writer resumed")
	}
	if engineWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "success"}).Code != 403 {
		t.Fatal("expired run became green")
	}
	detail, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: run.Msg.Run.Id}))
	if err != nil || detail.Msg.Run.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_LOST || detail.Msg.Run.ExitCode != nil || detail.Msg.Run.Jobs[0].State != golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_INTERRUPTED || detail.Msg.Run.Jobs[0].Steps[0].State != golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_UNRECORDED {
		t.Fatal("lost attempt invented results", err)
	}
}
func TestActionsEnginePartialReceiptAndCancellationPostgres(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			f := engineRunFixture(t)
			run, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
			if err != nil {
				t.Fatal(err)
			}
			lease := engineAssigned(t, f)
			job := lease.ActionsPlan.Jobs[0]
			if engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "kind": "job_started"}).Code != 204 {
				t.Fatal("initial observation")
			}
			if engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 2, "jobInstanceId": job.InstanceID, "kind": "job_finished", "state": "success"}).Code != 409 {
				t.Fatal("missing child receipt green")
			}
			if engineWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "success"}).Code != 409 {
				t.Fatal("missing graph green")
			}
			if cancelled {
				before, e := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: run.Msg.Run.Id}))
				if e != nil {
					t.Fatal(e)
				}
				_, err = f.server.CancelWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.CancelWorkflowRunRequest{RunId: run.Msg.Run.Id, ExpectedVersion: before.Msg.Run.Version}))
				if err != nil {
					t.Fatal(err)
				}
			}
			expected := 204
			if cancelled {
				expected = 403
			}
			if engineWorkerCall(f, lease, "finish", map[string]any{"infrastructureError": !cancelled, "cancelled": cancelled}).Code != expected {
				t.Fatal("honest incomplete conclusion refused")
			}
			detail, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: run.Msg.Run.Id}))
			if err != nil || detail.Msg.Run.State == golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_SUCCEEDED || detail.Msg.Run.ExitCode != nil || detail.Msg.Run.Jobs[0].State != golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_INTERRUPTED {
				t.Fatal("partial graph misrepresented", err)
			}
		})
	}
}

func TestActionsEngineConcurrentAckAndSQLFaultPostgres(t *testing.T) {
	f := engineRunFixture(t)
	run, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	lease := engineAssigned(t, f)
	job := lease.ActionsPlan.Jobs[0]
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			statuses <- engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "kind": "job_started"}).Code
		}()
	}
	for i := 0; i < 2; i++ {
		if code := <-statuses; code != 204 {
			t.Fatal("exact concurrent ACK not idempotent", code)
		}
	}
	var count int
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_graph_events WHERE run_id=$1`, run.Msg.Run.Id).Scan(&count); err != nil || count != 1 {
		t.Fatal("concurrent duplicate receipt", err, count)
	}
	if _, err = f.server.db.Exec(`ALTER TABLE golf_workflow_graph_events RENAME TO held_graph_events`); err != nil {
		t.Fatal(err)
	}
	code := engineWorkerCall(f, lease, "graph", map[string]any{"sequence": 2, "jobInstanceId": job.InstanceID, "stepId": job.Steps[0].ID, "kind": "step_started"}).Code
	if _, err = f.server.db.Exec(`ALTER TABLE held_graph_events RENAME TO golf_workflow_graph_events`); err != nil {
		t.Fatal(err)
	}
	if code != 503 {
		t.Fatal("storage fault acknowledged", code)
	}
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_graph_events WHERE run_id=$1`, run.Msg.Run.Id).Scan(&count); err != nil || count != 1 {
		t.Fatal("unacknowledged SQL state persisted", err, count)
	}
	if engineWorkerCall(f, lease, "finish", map[string]any{"infrastructureError": true}).Code != 204 {
		t.Fatal("SQL observation fault not terminal")
	}
	detail, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: run.Msg.Run.Id}))
	if err != nil || detail.Msg.Run.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_LOST || detail.Msg.Run.Jobs[0].Steps[0].StartedAt != nil {
		t.Fatal("SQL fault fabricated execution", err)
	}
}

func TestActionsEngineIndependentPushPreparationPostgres(t *testing.T) {
	f := engineRunFixture(t)
	_, blob, plan, archive, err := f.server.prepareWorkflowRunForEvent(t.Context(), forgeCredential{Kind: "pat", Token: "run-fixture"}, repositoryKey{Owner: "alice", Name: "example"}, f.commit, runWorkflowPath, "refs/heads/main")
	if err != nil || blob == "" || len(archive) == 0 || plan == nil || plan.Actions == nil || plan.Actions.Event != "push" || plan.Actions.Ref != "refs/heads/main" || len(plan.Actions.Jobs) != 3 {
		t.Fatal("push catalog not independently prepared", err)
	}
	if _, err = f.server.executionImage(plan); err != nil {
		t.Fatal(err)
	}
	f.workflow = []byte(strings.Replace(engineGraphFixture, "id: first", "uses: actions/checkout@v4, id: first", 1))
	_, _, plan, archive, err = f.server.prepareWorkflowRunForEvent(t.Context(), forgeCredential{Kind: "pat", Token: "run-fixture"}, repositoryKey{Owner: "alice", Name: "example"}, f.commit, runWorkflowPath, "refs/heads/main")
	if !errors.Is(err, errActionsProfile) || plan != nil || archive != nil {
		t.Fatal("known profile refusal not definitive", err)
	}
	var count int
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatal("preparation dispatched", err, count)
	}
}

func TestActionsManualPlanBinding(t *testing.T) {
	input := runner.ActionPlanInput{Catalog: runner.ActionsInputsCatalog, WorkflowPath: runWorkflowPath, WorkflowBlobID: strings.Repeat("b", 40), Archive: []byte("bounded-source"), Event: "workflow_dispatch", Ref: strings.Repeat("a", 40), Images: map[string]string{"linux": "image@sha256:" + strings.Repeat("c", 64)}, ManualInputsContract: runner.ManualInputsCapability, ManualInputsSchemaSHA256: strings.Repeat("d", 64)}
	deps := []byte("{}")
	plan := runner.ActionPlan{Catalog: input.Catalog, EngineCommit: runner.ActionsEngineCommit, WorkflowPath: input.WorkflowPath, WorkflowBlobID: input.WorkflowBlobID, ArchiveSHA256: sourceArchiveHash(input.Archive), Event: input.Event, Ref: input.Ref, ActionsSHA256: sourceArchiveHash(deps), ManualInputsContract: input.ManualInputsContract, ManualInputsSchemaSHA256: input.ManualInputsSchemaSHA256, Jobs: []runner.ActionJob{{InstanceID: strings.Repeat("e", 32), JobID: "build", Name: "Build", Image: input.Images["linux"], Steps: []runner.ActionStep{{ID: "first", Name: "First"}}}}}
	if err := validateActionPlan(plan, input); err != nil {
		t.Fatal("versioned manual plan rejected", err)
	}
	for _, change := range []func(*runner.ActionPlan){
		func(p *runner.ActionPlan) { p.Catalog = runner.ActionsCatalog },
		func(p *runner.ActionPlan) { p.ManualInputsContract = "" },
		func(p *runner.ActionPlan) { p.ManualInputsSchemaSHA256 = strings.Repeat("f", 64) },
		func(p *runner.ActionPlan) { p.EngineCommit = "different" },
	} {
		changed := plan
		change(&changed)
		if validateActionPlan(changed, input) == nil {
			t.Fatal("manual plan binding downgrade adopted")
		}
	}
	input.Event = "push"
	plan.Event = "push"
	if validateActionPlan(plan, input) == nil {
		t.Fatal("manual inputs adopted by push catalog")
	}
	input.Event = "inspect"
	plan.Event = "inspect"
	if err := validateActionPlan(plan, input); err != nil {
		t.Fatal("read-only manual source planning refused", err)
	}
	input.Catalog = runner.ActionsCatalog
	plan.Catalog = runner.ActionsCatalog
	if validateActionPlan(plan, input) == nil {
		t.Fatal("legacy plan accepted manual contract")
	}
	input.ManualInputsContract = ""
	input.ManualInputsSchemaSHA256 = ""
	plan.ManualInputsContract = ""
	plan.ManualInputsSchemaSHA256 = ""
	if err := validateActionPlan(plan, input); err != nil {
		t.Fatal("legacy plan behavior changed", err)
	}
}

// Use the independently built maintained planner so inspection cannot appear
// supported through an unconditional fake planner response.
func TestActionsManualInspectionPostgres(t *testing.T) {
	f := engineRunFixture(t)
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	f.workflow = []byte(typedDispatchWorkflow)
	f.server.config.ActionsEngineCatalog = runner.ActionsInputsCatalog
	response, err := f.server.InspectWorkflows(f.context(t), workflowRunRequest(f, &golfv1.InspectWorkflowsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: fmt.Sprint(f.row.ID), Ref: f.commit}))
	if err != nil {
		t.Fatal(err)
	}
	schema, err := parseWorkflowDispatchInputs(f.workflow)
	if err != nil {
		t.Fatal(err)
	}
	if response.Msg.ExecutionCatalog != runner.ActionsInputsCatalog || len(response.Msg.Configurations) != 1 {
		t.Fatal("manual inspection catalog/inventory lost")
	}
	c := response.Msg.Configurations[0]
	if c.State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET || c.ManualInputsSchemaSha256 != schema.SHA256 || len(c.ManualInputs) != 4 || c.BlobId != sourceBlobHash(f.workflow, 40) {
		t.Fatal("exact-source manual workflow refused by actual planner or metadata mismatched")
	}
	var count int
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatal("source inspection created work", err)
	}
}
