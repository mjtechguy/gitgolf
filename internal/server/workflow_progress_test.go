package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestWorkflowProgressBoundariesPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	f.workflow = []byte("on: workflow_dispatch\njobs:\n  test:\n    name: <literal job>\n    runs-on: linux\n    steps:\n      - name: First\n        run: printf private-script-one\n      - name: Second\n        run: printf private-script-two\n")
	dispatched, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	call := func(path, capability, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Golf-Runner-ID", "fixture")
		req.Header.Set("Authorization", "Bearer "+key)
		if capability != "" {
			req.Header.Set("Golf-Attempt-Token", capability)
		}
		rec := httptest.NewRecorder()
		f.server.ServeHTTP(rec, req)
		return rec
	}
	var lease struct {
		RunID        string `json:"runId"`
		AttemptID    string `json:"attemptId"`
		AttemptToken string `json:"attemptToken"`
	}
	poll := call("/internal/ci/poll", "", "{}")
	if poll.Code != 200 || json.Unmarshal(poll.Body.Bytes(), &lease) != nil {
		t.Fatal("poll failed", poll.Code)
	}
	prefix := "/internal/ci/attempt/" + lease.AttemptID
	post := func(action, body string, want int) {
		t.Helper()
		r := call(prefix+"/"+action, lease.AttemptToken, body)
		if r.Code != want {
			t.Fatal(action, "got", r.Code, "want", want)
		}
	}
	post("progress", `{"sequence":2,"stepIndex":0,"kind":"finished","exitCode":0}`, 409)
	post("progress", `{"sequence":4294967297,"stepIndex":0,"kind":"started"}`, 400)
	post("progress", `{"sequence":1,"stepIndex":2,"kind":"started"}`, 400)
	post("progress", `{"sequence":1,"stepIndex":0,"kind":"started"}`, 204)
	post("progress", `{"sequence":1,"stepIndex":0,"kind":"started"}`, 204)
	post("finish", `{"exitCode":0}`, 409)
	post("logs", `{"sequence":1,"text":"first-output\n"}`, 204)
	post("progress", `{"sequence":2,"stepIndex":0,"kind":"finished","exitCode":0}`, 204)
	post("progress", `{"sequence":2,"stepIndex":0,"kind":"finished","exitCode":7}`, 409)
	post("finish", `{"exitCode":0}`, 409)
	post("progress", `{"sequence":3,"stepIndex":1,"kind":"started"}`, 204)
	post("logs", `{"sequence":2,"text":"second-output\n"}`, 204)
	post("progress", `{"sequence":4,"stepIndex":1,"kind":"finished","exitCode":7}`, 204)
	post("finish", `{"exitCode":0}`, 409)
	post("finish", `{"exitCode":7}`, 204)
	post("progress", `{"sequence":4,"stepIndex":1,"kind":"finished","exitCode":7}`, 403)
	detail, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: dispatched.Msg.Run.Id}))
	if err != nil || detail.Msg.Run.Progress == nil || !detail.Msg.Run.Progress.EventsRecorded {
		t.Fatal("missing progress", err)
	}
	steps := detail.Msg.Run.Progress.Steps
	if len(steps) != 2 || steps[0].State != golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_SUCCEEDED || steps[1].State != golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_FAILED || steps[1].GetExitCode() != 7 || steps[0].StartedAt == nil || steps[0].FinishedAt == nil {
		t.Fatal("wrong states", steps)
	}
	if strings.Contains(detail.Msg.String(), "private-script") {
		t.Fatal("private script leaked through metadata")
	}
	for index, want := range []string{"first-output\n", "second-output\n"} {
		n := uint32(index)
		logs, err := f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: dispatched.Msg.Run.Id, StepIndex: &n}))
		if err != nil || len(logs.Msg.Logs) != 1 || logs.Msg.Logs[0].Text != want {
			t.Fatal("step log boundary crossed", index, err)
		}
	}
	invalidIndex := uint32(2)
	if _, err = f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: dispatched.Msg.Run.Id, StepIndex: &invalidIndex})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("unknown step accepted", err)
	}
	if _, err = f.server.db.ExecContext(t.Context(), `UPDATE golf_workflow_run_progress SET log_sequence=999 WHERE run_id=$1`, lease.RunID); err == nil {
		t.Fatal("append-only progress mutated")
	}
	var count int
	f.server.db.QueryRowContext(t.Context(), `SELECT count(*) FROM golf_workflow_run_progress WHERE run_id=$1`, lease.RunID).Scan(&count)
	if count != 4 {
		t.Fatal("duplicate/rejected progress persisted", count)
	}
	f.mu.Lock()
	f.denied = true
	f.mu.Unlock()
	if _, err = f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: lease.RunID})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("revoked detail returned", err)
	}
	zero := uint32(0)
	if _, err = f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: lease.RunID, StepIndex: &zero})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("revoked step logs returned", err)
	}
}

func TestWorkflowProgressLegacyAndUnstartedPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	run, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	zero := uint32(0)
	if _, err = f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: run.Msg.Run.Id, StepIndex: &zero})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("unstarted step had output", err)
	}
	if _, err = f.server.db.ExecContext(t.Context(), `UPDATE golf_workflow_runs SET state='succeeded',version=version+1,finished_at=clock_timestamp() WHERE id=$1`, run.Msg.Run.Id); err != nil {
		t.Fatal(err)
	}
	detail, err := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: run.Msg.Run.Id}))
	if err != nil || detail.Msg.Run.Progress.EventsRecorded || detail.Msg.Run.Progress.Steps[0].State != golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_UNRECORDED {
		t.Fatal("legacy success invented step success", err)
	}
}
