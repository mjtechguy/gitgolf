package server

import (
	"crypto/tls"
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestExecutionJobLevelQuarantinePostgres(t *testing.T) {
	f, target := executionEngineFixture(t)
	executionEngineApproval(t, f, target)
	run := executionDispatch(t, f)
	lease := executionLease(t, f)
	job := lease.ActionsPlan.Jobs[0]
	first := map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "text": "prefix abc"}
	for _, version := range []uint16{0, tls.VersionTLS12} {
		if r := executionWorkerCall(f, lease, "logs", first, version); r.Code != 403 {
			t.Fatal("Insecure job frame admitted", r.Code)
		}
	}
	for _, coordinate := range []map[string]any{{"sequence": 1, "jobInstanceId": strings.Repeat("f", 32), "text": "bounded output"}, {"sequence": 1, "jobInstanceId": job.InstanceID, "stepId": "undeclared", "text": "bounded output"}, {"sequence": 1, "text": "bounded output"}} {
		if r := executionWorkerCall(f, lease, "logs", coordinate, tls.VersionTLS13); r.Code != 400 {
			t.Fatal("Unadmitted job/step accepted", r.Code)
		}
	}
	if r := executionWorkerCall(f, lease, "logs", first, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("Actual job-level quarantine ACK refused", r.Code)
	}
	if r := executionWorkerCall(f, lease, "logs", first, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("Exact job-level replay refused", r.Code)
	}
	changed := map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "stepId": job.Steps[0].ID, "text": "prefix abc"}
	if r := executionWorkerCall(f, lease, "logs", changed, tls.VersionTLS13); r.Code != 409 {
		t.Fatal("Changed replay coordinate admitted", r.Code)
	}
	var encrypted, visible int
	var savedStep string
	if e := f.server.db.QueryRow(`SELECT count(*),min(step_id) FROM golf_workflow_quarantined_outputs WHERE run_id=$1`, run.Id).Scan(&encrypted, &savedStep); e != nil || encrypted != 1 || savedStep != "" {
		t.Fatal("Original job coordinate not encrypted exactly")
	}
	if e := f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_run_logs WHERE run_id=$1`, run.Id).Scan(&visible); e != nil || visible != 0 {
		t.Fatal("Job raw output published before trusted completion")
	}
	sequence := 0
	for index, j := range lease.ActionsPlan.Jobs {
		sequence++
		if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": sequence, "jobInstanceId": j.InstanceID, "kind": "job_started"}, tls.VersionTLS13); r.Code != 204 {
			t.Fatal("Job start", r.Code)
		}
		for stepIndex, step := range j.Steps {
			sequence++
			if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": sequence, "jobInstanceId": j.InstanceID, "stepId": step.ID, "kind": "step_started"}, tls.VersionTLS13); r.Code != 204 {
				t.Fatal("Step start", r.Code)
			}
			if index == 0 && stepIndex == 0 {
				if r := executionWorkerCall(f, lease, "logs", map[string]any{"sequence": 2, "jobInstanceId": j.InstanceID, "stepId": step.ID, "text": "defgh suffix"}, tls.VersionTLS13); r.Code != 204 {
					t.Fatal("Step quarantine ACK", r.Code)
				}
			}
			sequence++
			if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": sequence, "jobInstanceId": j.InstanceID, "stepId": step.ID, "kind": "step_finished", "state": "success"}, tls.VersionTLS13); r.Code != 204 {
				t.Fatal("Step finish", r.Code)
			}
		}
		sequence++
		if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": sequence, "jobInstanceId": j.InstanceID, "kind": "job_finished", "state": "success"}, tls.VersionTLS13); r.Code != 204 {
			t.Fatal("Job finish", r.Code)
		}
	}
	sequence++
	if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": sequence, "kind": "complete", "state": "success"}, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("Graph completion", r.Code)
	}
	if r := executionWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "success"}, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("Verified masked release", r.Code)
	}
	logs, e := f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: run.Id, JobInstanceId: job.InstanceID}))
	if e != nil || logs.Msg.OutputState != golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_REDACTED || len(logs.Msg.Logs) != 2 || logs.Msg.Logs[0].Text != "prefix ***" || logs.Msg.Logs[1].Text != "***** suffix" {
		t.Fatal("Cross-coordinate secret masking lost")
	}
	stepLogs, e := f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: run.Id, JobInstanceId: job.InstanceID, StepId: job.Steps[0].ID}))
	if e != nil || len(stepLogs.Msg.Logs) != 1 || stepLogs.Msg.Logs[0].Sequence != 2 {
		t.Fatal("Job output incorrectly attributed to source step")
	}
}
