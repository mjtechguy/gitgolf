package server

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"google.golang.org/protobuf/proto"
)

func executionWebhookTarget(t *testing.T, f *webhookFixture) *golfv1.RepositoryExecutionValueTarget {
	t.Helper()
	r, e := f.s.GetRepositoryAccess(f.ctx, webhookRequest(f, &golfv1.GetRepositoryAccessRequest{Repository: f.target.Repository}))
	if e != nil {
		t.Fatal(e)
	}
	return &golfv1.RepositoryExecutionValueTarget{Repository: f.target.Repository, RepositoryId: r.Msg.Access.RepositoryId, OwnerId: r.Msg.Access.OwnerId, AccessRevision: r.Msg.Access.Revision}
}
func executionSaveRequest(target *golfv1.RepositoryExecutionValueTarget, id, version, broker, name, value string, kind golfv1.RepositoryExecutionValueKind) *golfv1.SaveRepositoryExecutionValueRequest {
	return &golfv1.SaveRepositoryExecutionValueRequest{Target: target, Id: id, ExpectedVersion: version, ExpectedBrokerRevision: broker, OperationId: uuid.NewString(), Name: name, Value: value, Kind: kind}
}
func TestExecutionValuesCRUDReplayAndCASPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	target := executionWebhookTarget(t, f)
	id := uuid.NewString()
	secret := "private-fixture-secret"
	m := executionSaveRequest(target, id, "0", "0", "BUILD_CREDENTIAL", secret, golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET)
	save, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, m))
	if e != nil || save.Msg.Operation.AcceptedVersion != "1" || save.Msg.Operation.AcceptedBrokerRevision != "1" {
		t.Fatal("create receipt", e)
	}
	replay, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, m))
	if e != nil || !replay.Msg.Operation.Replayed {
		t.Fatal("lost-ack replay", e)
	}
	changed := proto.Clone(m).(*golfv1.SaveRepositoryExecutionValueRequest)
	changed.Value = "different-private-secret"
	if _, e = f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, changed)); e == nil {
		t.Fatal("same operation accepted changed value")
	}
	status, e := f.s.GetRepositoryExecutionValueOperation(f.ctx, webhookRequest(f, &golfv1.GetRepositoryExecutionValueOperationRequest{Target: target, OperationId: m.OperationId}))
	if e != nil || status.Msg.Operation.ItemId != id || status.Msg.Operation.AcceptedVersion != "1" {
		t.Fatal("operation status", e)
	}
	inventory, e := f.s.ListRepositoryExecutionValues(f.ctx, webhookRequest(f, &golfv1.ListRepositoryExecutionValuesRequest{Target: target}))
	if e != nil || len(inventory.Msg.Values) != 1 || inventory.Msg.BrokerRevision != "1" {
		t.Fatal("inventory", e)
	}
	encoded, _ := json.Marshal(inventory.Msg)
	var cipher, metadata []byte
	if e = f.db.QueryRow(`SELECT encrypted_content FROM golf_execution_value_versions WHERE id=$1`, id).Scan(&cipher); e != nil {
		t.Fatal(e)
	}
	if e = f.db.QueryRow(`SELECT request_metadata::text FROM golf_execution_value_operations WHERE operation_id=$1`, m.OperationId).Scan(&metadata); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(cipher, []byte(secret)) || bytes.Contains(encoded, []byte(secret)) || bytes.Contains(metadata, []byte(secret)) {
		t.Fatal("plaintext escaped retained metadata/inventory")
	}
	if _, e = f.s.GetRepositoryExecutionVariable(f.ctx, webhookRequest(f, &golfv1.GetRepositoryExecutionVariableRequest{Target: target, Id: id, Version: "1"})); e == nil {
		t.Fatal("secret readback exposed")
	}
	// Independent concurrent changes compete on one broker revision. Neither silently overwrites.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, name := range []string{"BUILD_REGION", "BUILD_CHANNEL"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			_, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, executionSaveRequest(target, uuid.NewString(), "0", "1", name, "ordinary", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE)))
			results <- e
		}(name)
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatal("broker CAS admitted concurrent stale revisions", success)
	}
	deletion := &golfv1.DeleteRepositoryExecutionValueRequest{Target: target, Id: id, ExpectedVersion: "1", ExpectedBrokerRevision: "2", OperationId: uuid.NewString()}
	d, e := f.s.DeleteRepositoryExecutionValue(f.ctx, webhookRequest(f, deletion))
	if e != nil || d.Msg.Operation.AcceptedVersion != "2" {
		t.Fatal("tombstone", e)
	}
	if _, e = f.s.DeleteRepositoryExecutionValue(f.ctx, webhookRequest(f, deletion)); e != nil {
		t.Fatal("delete replay", e)
	}
	restore := executionSaveRequest(target, id, "2", "3", m.Name, "replacement-private-secret", m.Kind)
	r, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, restore))
	if e != nil || r.Msg.Operation.AcceptedVersion != "3" {
		t.Fatal("same identity restoration", e)
	}
	var history int
	f.db.QueryRow(`SELECT count(*) FROM golf_execution_value_versions WHERE id=$1`, id).Scan(&history)
	if history != 2 {
		t.Fatal("retained immutable versions lost")
	}
}
func TestExecutionValuesAuthorityAndRollbackPostgres(t *testing.T) {
	f := newWebhookFixture(t, true)
	target := executionWebhookTarget(t, f)
	save := func() *golfv1.SaveRepositoryExecutionValueRequest {
		return executionSaveRequest(target, uuid.NewString(), "0", "0", "BUILD_REGION", "ordinary", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE)
	}
	for _, change := range []struct {
		name string
		set  func(bool)
	}{{"global admin not native admin", f.downgrade.Store}, {"replacement", f.replacement.Store}, {"foreign current actor", f.foreignActor.Store}, {"revocation", f.revoked.Store}} {
		t.Run(change.name, func(t *testing.T) {
			change.set(true)
			defer change.set(false)
			if _, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, save())); e == nil {
				t.Fatal("invalid current authority admitted")
			}
		})
	}
	if _, e := f.db.Exec(`CREATE FUNCTION execution_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned fixture rollback'; END $$; CREATE TRIGGER execution_test_fault BEFORE INSERT ON golf_execution_value_operations FOR EACH ROW EXECUTE FUNCTION execution_test_fault()`); e != nil {
		t.Fatal(e)
	}
	m := save()
	if _, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, m)); e == nil {
		t.Fatal("operation SQL failure reported success")
	}
	var count int
	f.db.QueryRow(`SELECT count(*) FROM golf_execution_values`).Scan(&count)
	if count != 0 {
		t.Fatal("failed receipt left an unjournaled value")
	}
	f.db.Exec(`DROP TRIGGER execution_test_fault ON golf_execution_value_operations`)
	r, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, m))
	if e != nil || r.Msg.Operation.AcceptedBrokerRevision != "1" {
		t.Fatal("rolled-back original intent cannot retry", e)
	}
	// A native authority loss after commit is uncertainty, not an invented no-effect receipt.
	f.permissionReads.Store(0)
	f.denyPermissionAt.Store(2)
	late := executionSaveRequest(target, uuid.NewString(), "0", "1", "BUILD_CHANNEL", "ordinary", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE)
	_, e = f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, late))
	if e == nil {
		t.Fatal("late native role loss leaked receipt")
	}
	f.denyPermissionAt.Store(0)
	status, e := f.s.GetRepositoryExecutionValueOperation(f.ctx, webhookRequest(f, &golfv1.GetRepositoryExecutionValueOperationRequest{Target: target, OperationId: late.OperationId}))
	if e != nil || status.Msg.Operation.AcceptedBrokerRevision != "2" {
		t.Fatal("committed lost acknowledgement missing durable status", e)
	}
}

func executionEngineFixture(t *testing.T) (*workflowRunFixture, *golfv1.RepositoryExecutionValueTarget) {
	t.Helper()
	f := engineRunFixture(t)
	transport := f.server.client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, e := transport.RoundTrip(r)
		if e != nil {
			return nil, e
		}
		if response.StatusCode == 200 && (r.URL.Path == "/api/v1/repos/alice/example" || strings.HasPrefix(r.URL.Path, "/api/v1/repositories/")) {
			var v map[string]any
			raw, e := io.ReadAll(response.Body)
			response.Body.Close()
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			if e != nil || decoder.Decode(&v) != nil {
				return nil, fmt.Errorf("owned fixture envelope")
			}
			v["fork"] = false
			raw, _ = json.Marshal(v)
			response.Body = io.NopCloser(bytes.NewReader(raw))
			response.ContentLength = int64(len(raw))
		}
		return response, nil
	})
	access, e := f.server.GetRepositoryAccess(f.context(t), workflowRunRequest(f, &golfv1.GetRepositoryAccessRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}}))
	if e != nil {
		t.Fatal(e)
	}
	return f, &golfv1.RepositoryExecutionValueTarget{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: access.Msg.Access.RepositoryId, OwnerId: access.Msg.Access.OwnerId, AccessRevision: access.Msg.Access.Revision}
}
func executionEngineApproval(t *testing.T, f *workflowRunFixture, target *golfv1.RepositoryExecutionValueTarget) (string, string) {
	t.Helper()
	id := uuid.NewString()
	r, e := f.server.SaveRepositoryExecutionValue(f.context(t), workflowRunRequest(f, executionSaveRequest(target, id, "0", "0", "BUILD_CREDENTIAL", "abcdefgh", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET)))
	if e != nil || r.Msg.Operation.AcceptedVersion != "1" {
		t.Fatal("save engine value", e)
	}
	binding := uuid.NewString()
	b, e := f.server.SaveRepositoryExecutionBinding(f.context(t), workflowRunRequest(f, &golfv1.SaveRepositoryExecutionBindingRequest{Target: target, Id: binding, ExpectedVersion: "0", ExpectedBrokerRevision: "1", OperationId: uuid.NewString(), WorkflowPath: runWorkflowPath, CommitId: f.commit, Event: golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL, ExpiresAt: time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano), Values: []*golfv1.RepositoryExecutionValueReference{{Id: id, Version: "1"}}}))
	if e != nil || b.Msg.Operation.AcceptedBrokerRevision != "2" {
		t.Fatal("exact source approval", e)
	}
	return id, binding
}
func executionWorkerCall(f *workflowRunFixture, lease engineLease, action string, body any, version uint16) *httptest.ResponseRecorder {
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
	if version > 0 {
		req.TLS = &tls.ConnectionState{Version: version}
	}
	response := httptest.NewRecorder()
	f.server.ServeHTTP(response, req)
	return response
}
func executionDispatch(t *testing.T, f *workflowRunFixture) *golfv1.WorkflowRun {
	t.Helper()
	tx, _ := f.server.db.BeginTx(t.Context(), nil)
	states, _, err := f.server.readExecutionPolicyStates(t.Context(), tx, f.row.ID, f.row.Owner.ID, false, false)
	tx.Rollback()
	if err != nil || !executionPoliciesAllow(states, f.row.ID, f.row.Owner.ID, false, "manual", runWorkflowPath) {
		t.Fatalf("fixture policy before dispatch: %+v / %v", states, err)
	}
	r, e := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, &golfv1.DispatchWorkflowRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, WorkflowPath: runWorkflowPath, Ref: f.commit, IdempotencyKey: uuid.NewString()}))
	if e != nil {
		t.Fatal("exact dispatch", e)
	}
	return r.Msg.Run
}
func executionLease(t *testing.T, f *workflowRunFixture) engineLease {
	t.Helper()
	body := map[string]any{"catalogs": []string{runner.ActionsCatalog}, "capabilities": []string{runner.JobLimitsCapability, runner.ExecutionValuesCapability}}
	for _, version := range []uint16{0, tls.VersionTLS12} {
		if r := executionWorkerCall(f, engineLease{}, "poll", body, version); r.Code != 204 {
			t.Fatal("insecure worker obtained value assignment", r.Code)
		}
	}
	if r := executionWorkerCall(f, engineLease{}, "poll", map[string]any{"catalogs": []string{runner.ActionsCatalog}, "capabilities": []string{runner.JobLimitsCapability}}, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("old worker obtained broker assignment")
	}
	response := executionWorkerCall(f, engineLease{}, "poll", body, tls.VersionTLS13)
	var assignment struct {
		engineLease
		ExecutionEnvironment *runner.ExecutionEnvironment
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &assignment) != nil || assignment.ExecutionEnvironment == nil || assignment.ExecutionEnvironment.Secrets["BUILD_CREDENTIAL"] != "abcdefgh" {
		t.Fatal("qualified receiver assignment", response.Code)
	}
	return assignment.engineLease
}
func TestExecutionBrokerQuarantineAndVerifiedRedactionPostgres(t *testing.T) {
	f, target := executionEngineFixture(t)
	executionEngineApproval(t, f, target)
	if _, e := f.dispatch(t, uuid.NewString()); e == nil {
		t.Fatal("mutable default ref received approved values")
	}
	run := executionDispatch(t, f)
	if run.OutputState != golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_WITHHELD {
		t.Fatal("secret output not withheld")
	}
	lease := executionLease(t, f)
	seq, logSeq := 0, 0
	for _, job := range lease.ActionsPlan.Jobs {
		seq++
		if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": seq, "jobInstanceId": job.InstanceID, "kind": "job_started"}, tls.VersionTLS13); r.Code != 204 {
			t.Fatal("job start", r.Code)
		}
		for _, step := range job.Steps {
			seq++
			if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": seq, "jobInstanceId": job.InstanceID, "stepId": step.ID, "kind": "step_started"}, tls.VersionTLS13); r.Code != 204 {
				t.Fatal("step start", r.Code)
			}
			for _, text := range []string{"prefix abc", "defgh suffix"} {
				logSeq++
				r := executionWorkerCall(f, lease, "logs", map[string]any{"sequence": logSeq, "jobInstanceId": job.InstanceID, "stepId": step.ID, "text": text}, tls.VersionTLS13)
				if r.Code != 204 {
					t.Fatal("quarantine ACK", r.Code)
				}
			}
			seq++
			if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": seq, "jobInstanceId": job.InstanceID, "stepId": step.ID, "kind": "step_finished", "state": "success"}, tls.VersionTLS13); r.Code != 204 {
				t.Fatal("step finish", r.Code)
			}
		}
		seq++
		if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": seq, "jobInstanceId": job.InstanceID, "kind": "job_finished", "state": "success"}, tls.VersionTLS13); r.Code != 204 {
			t.Fatal("job finish", r.Code)
		}
	}
	seq++
	if r := executionWorkerCall(f, lease, "graph", map[string]any{"sequence": seq, "kind": "complete", "state": "success"}, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("complete graph receipt", r.Code)
	}
	var visible, encrypted int
	f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_run_logs WHERE run_id=$1`, run.Id).Scan(&visible)
	f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_quarantined_outputs WHERE run_id=$1`, run.Id).Scan(&encrypted)
	if visible != 0 || encrypted != logSeq {
		t.Fatal("raw secret logs were published before trusted completion")
	}
	logs, e := f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: run.Id}))
	if e != nil || len(logs.Msg.Logs) != 0 || logs.Msg.OutputState != golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_WITHHELD {
		t.Fatal("private logs API withheld state", e)
	}
	if r := executionWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "success"}, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("verified graph completion", r.Code)
	}
	logs, e = f.server.GetWorkflowRunLogs(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunLogsRequest{RunId: run.Id}))
	if e != nil || len(logs.Msg.Logs) != logSeq || logs.Msg.OutputState != golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_REDACTED {
		t.Fatal("verified redacted output", e)
	}
	for i, c := range logs.Msg.Logs {
		want := "prefix ***"
		if i%2 == 1 {
			want = "***** suffix"
		}
		if c.Text != want {
			t.Fatal("exact cross-chunk secret masking/receipt boundaries")
		}
	}
}
func TestExecutionBrokerRotationAndRevocationRemainWithheldPostgres(t *testing.T) {
	for _, scenario := range []string{"value replaced", "native admin revoked", "lease lost", "SQL log fault"} {
		t.Run(scenario, func(t *testing.T) {
			f, target := executionEngineFixture(t)
			id, _ := executionEngineApproval(t, f, target)
			run := executionDispatch(t, f)
			lease := executionLease(t, f)
			job := lease.ActionsPlan.Jobs[0]
			step := job.Steps[0]
			for seq, kind := range []string{"job_started", "step_started"} {
				body := map[string]any{"sequence": seq + 1, "jobInstanceId": job.InstanceID, "kind": kind}
				if seq == 1 {
					body["stepId"] = step.ID
				}
				if r := executionWorkerCall(f, lease, "graph", body, tls.VersionTLS13); r.Code != 204 {
					t.Fatal("start", r.Code)
				}
			}
			if scenario == "SQL log fault" {
				f.server.db.Exec(`CREATE FUNCTION execution_output_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned fault';END$$;CREATE TRIGGER execution_output_fault BEFORE INSERT ON golf_workflow_quarantined_outputs FOR EACH ROW EXECUTE FUNCTION execution_output_fault()`)
			}
			r := executionWorkerCall(f, lease, "logs", map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "stepId": step.ID, "text": "abcdefgh"}, tls.VersionTLS13)
			if scenario == "SQL log fault" {
				if r.Code == 204 {
					t.Fatal("nondurable secret output acknowledged")
				}
				var count int
				f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_quarantined_outputs`).Scan(&count)
				if count != 0 {
					t.Fatal("failed append escaped rollback")
				}
				return
			}
			if r.Code != 204 {
				t.Fatal("private append", r.Code)
			}
			switch scenario {
			case "value replaced":
				_, e := f.server.SaveRepositoryExecutionValue(f.context(t), workflowRunRequest(f, executionSaveRequest(target, id, "1", "2", "BUILD_CREDENTIAL", "replacement-secret", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET)))
				if e != nil {
					t.Fatal(e)
				}
			case "native admin revoked":
				f.mu.Lock()
				f.permission = "write"
				f.mu.Unlock()
			case "lease lost":
				f.server.db.Exec(`UPDATE golf_workflow_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, run.Id)
			}
			if r = executionWorkerCall(f, lease, "finish", map[string]any{"engineConclusion": "success"}, tls.VersionTLS13); r.Code == 204 {
				t.Fatal("revoked/unknown attempt published secret output")
			}
			var visible int
			f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_run_logs WHERE run_id=$1`, run.Id).Scan(&visible)
			state, _, _, e := observeExecutionOutput(t.Context(), f.server.db, run.Id)
			if e != nil || visible != 0 || state != golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_WITHHELD {
				t.Fatal("output released without current verified authority")
			}
		})
	}
}
func TestExecutionValueKeyLifecyclePostgres(t *testing.T) {
	f := newWebhookFixture(t)
	target := executionWebhookTarget(t, f)
	id := uuid.NewString()
	m := executionSaveRequest(target, id, "0", "0", "BUILD_CREDENTIAL", "private-fixture-secret", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET)
	if _, e := f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, m)); e != nil {
		t.Fatal(e)
	}
	d := &golfv1.DeleteRepositoryExecutionValueRequest{Target: target, Id: id, ExpectedVersion: "1", ExpectedBrokerRevision: "1", OperationId: uuid.NewString()}
	if _, e := f.s.DeleteRepositoryExecutionValue(f.ctx, webhookRequest(f, d)); e != nil {
		t.Fatal(e)
	}
	keys := parseTestKeys(t, f.s.config.EncryptionKey, map[string]string{"next": keyFixture(9)}, "next")
	if _, e := ActivateKey(t.Context(), f.db, keys); e != nil {
		t.Fatal(e)
	}
	if _, e := CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); e == nil {
		t.Fatal("deleted encrypted value omitted from retirement")
	}
	op, e := RotateCredentials(t.Context(), f.db, keys, 1, 20)
	if e != nil || !op.Complete || op.RotatedRepositoryExecutionValues != 1 {
		t.Fatal("bounded rotation missed tombstone history", e)
	}
	if _, e = CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); e != nil {
		t.Fatal("rotated historical value still blocks retirement", e)
	}
	var valueBytes, outputBytes int
	f.db.QueryRow(`SELECT coalesce(sum(execution_values_count),0),coalesce(sum(quarantined_outputs_count),0) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'`).Scan(&valueBytes, &outputBytes)
	if valueBytes != 1 || outputBytes != 0 {
		t.Fatal("named crypto audit dropped execution family counts")
	}
	var cipher []byte
	f.db.QueryRow(`SELECT encrypted_content FROM golf_execution_value_versions WHERE id=$1`, id).Scan(&cipher)
	if bytes.Contains(cipher, []byte(m.Value)) {
		t.Fatal("rotation exposed plaintext")
	}
	// Metadata cannot be rebound or historical values erased even by direct owned fixture SQL.
	if _, e = f.db.Exec(`UPDATE golf_execution_value_versions SET content_binding=$2 WHERE id=$1`, id, bytes.Repeat([]byte{1}, 32)); e == nil {
		t.Fatal("content binding mutated")
	}
	if _, e = f.db.Exec(`DELETE FROM golf_execution_value_versions WHERE id=$1`, id); e == nil {
		t.Fatal("historical execution value deleted")
	}
}

func TestExecutionQuarantinedOutputKeyLifecyclePostgres(t *testing.T) {
	f, target := executionEngineFixture(t)
	executionEngineApproval(t, f, target)
	run := executionDispatch(t, f)
	lease := executionLease(t, f)
	job := lease.ActionsPlan.Jobs[0]
	step := job.Steps[0]
	for i, kind := range []string{"job_started", "step_started"} {
		body := map[string]any{"sequence": i + 1, "jobInstanceId": job.InstanceID, "kind": kind}
		if i == 1 {
			body["stepId"] = step.ID
		}
		if r := executionWorkerCall(f, lease, "graph", body, tls.VersionTLS13); r.Code != 204 {
			t.Fatal("graph start", r.Code)
		}
	}
	log := map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "stepId": step.ID, "text": "abcdefgh private quarantined output"}
	if r := executionWorkerCall(f, lease, "logs", log, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("private ACK", r.Code)
	}
	if r := executionWorkerCall(f, lease, "logs", log, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("same encrypted log replay", r.Code)
	}
	changed := map[string]any{"sequence": 1, "jobInstanceId": job.InstanceID, "stepId": step.ID, "text": "changed private output"}
	if r := executionWorkerCall(f, lease, "logs", changed, tls.VersionTLS13); r.Code != 409 {
		t.Fatal("changed encrypted log replay admitted", r.Code)
	}
	keys := parseTestKeys(t, f.server.config.EncryptionKey, map[string]string{"next": keyFixture(9)}, "next")
	if _, e := ActivateKey(t.Context(), f.server.db, keys); e != nil {
		t.Fatal(e)
	}
	status, e := KeyStatus(t.Context(), f.server.db, keys)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, key := range status.Keys {
		if key.KeyID == "legacy" && key.WorkflowQuarantinedOutputs == 1 && key.RepositoryExecutionValues == 1 {
			found = true
		}
	}
	if !found {
		t.Fatal("retained withheld output missing startup inventory")
	}
	if _, e = CheckKeyRetirement(t.Context(), f.server.db, keys, "legacy"); e == nil {
		t.Fatal("withheld output key retired")
	}
	op, e := RotateCredentials(t.Context(), f.server.db, keys, 1, 20)
	if e != nil || !op.Complete || op.RotatedWorkflowQuarantinedOutputs != 1 || op.RotatedRepositoryExecutionValues != 1 {
		t.Fatal("aggregate bounded rotation omitted output", e)
	}
	var values, outputs int
	if e = f.server.db.QueryRow(`SELECT coalesce(sum(execution_values_count),0),coalesce(sum(quarantined_outputs_count),0) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'`).Scan(&values, &outputs); e != nil || values != 1 || outputs != 1 {
		t.Fatal("named audit counts", e)
	}
	tx, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	rows, e := executionContentRows(t.Context(), tx, true, "next", "", 0, 2, false)
	tx.Rollback()
	if e != nil || len(rows) != 1 {
		t.Fatal("retained encrypted output", e)
	}
	if plain, e := openExecutionContent(keys, rows[0], true); e != nil || plain != log["text"] {
		t.Fatal("rotated output lost exact attempt/context binding", e)
	}
	f.server.keyring = keys
	if r := executionWorkerCall(f, lease, "logs", log, tls.VersionTLS13); r.Code != 204 {
		t.Fatal("old receipt replay after key rotation", r.Code)
	}
	if _, e = f.server.db.Exec(`UPDATE golf_workflow_quarantined_outputs SET step_id='other' WHERE run_id=$1`, run.Id); e == nil {
		t.Fatal("output context mutable")
	}
	if _, e = f.server.db.Exec(`DELETE FROM golf_workflow_quarantined_outputs WHERE run_id=$1`, run.Id); e == nil {
		t.Fatal("withheld history erased")
	}
}

func TestExecutionBrokerSourceAndLifecycleFencesPostgres(t *testing.T) {
	f, target := executionEngineFixture(t)
	_, binding := executionEngineApproval(t, f, target)
	// Wrong source cannot inherit approval; no credential-bearing task is queued.
	f.mu.Lock()
	original := f.commit
	f.commit = strings.Repeat("c", 40)
	f.mu.Unlock()
	if _, e := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, &golfv1.DispatchWorkflowRequest{Repository: target.Repository, WorkflowPath: runWorkflowPath, Ref: f.commit, IdempotencyKey: uuid.NewString()})); e == nil {
		t.Fatal("different source inherited execution values")
	}
	f.mu.Lock()
	f.commit = original
	f.mu.Unlock()
	// Deleting the immutable source approval cancels its bound live run and cannot
	// turn withheld output into ordinary/public output.
	run := executionDispatch(t, f)
	lease := executionLease(t, f)
	_, e := f.server.DeleteRepositoryExecutionBinding(f.context(t), workflowRunRequest(f, &golfv1.DeleteRepositoryExecutionBindingRequest{Target: target, Id: binding, ExpectedVersion: "1", ExpectedBrokerRevision: "2", OperationId: uuid.NewString()}))
	if e != nil {
		t.Fatal(e)
	}
	if r := executionWorkerCall(f, lease, "heartbeat", map[string]any{}, tls.VersionTLS13); r.Code == 204 {
		t.Fatal("deleted approval retained live release")
	}
	state, _, _, e := observeExecutionOutput(t.Context(), f.server.db, run.Id)
	if e != nil || state != golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_WITHHELD {
		t.Fatal("deleted approval erased output withholding")
	}
}

func TestExecutionValueLifecycleLatchPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	target := executionWebhookTarget(t, f)
	key := uuid.NewString()
	var operation int64
	e := f.db.QueryRow(`INSERT INTO golf_repository_lifecycle_operations(user_id,forge_url,actor_id,idempotency_key,repository_id,owner_id,repository_owner,repository_name,expected_revision,from_archived,to_archived,fingerprint) SELECT id,$1,forge_user_id,$2,$3,$4,'alice','example',$5,false,true,$6 FROM golf_users WHERE forge_url=$1 RETURNING id`, f.s.config.GiteaURL, key, target.RepositoryId, target.OwnerId, target.AccessRevision, bytes.Repeat([]byte{2}, 32)).Scan(&operation)
	if e != nil {
		t.Fatal("actual lifecycle latch", e)
	}
	m := executionSaveRequest(target, uuid.NewString(), "0", "0", "BUILD_CREDENTIAL", "private-fixture-secret", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET)
	if _, e = f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, m)); e == nil {
		t.Fatal("repository lifecycle latch admitted a value mutation")
	}
	var count int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_execution_values`).Scan(&count); e != nil || count != 0 {
		t.Fatal("blocked mutation left a value", e)
	}
	if _, e = f.db.Exec(`UPDATE golf_repository_lifecycle_operations SET phase='REJECTED',failure_code='preflight_refused' WHERE id=$1`, operation); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.SaveRepositoryExecutionValue(f.ctx, webhookRequest(f, m)); e != nil {
		t.Fatal("explicit known no-dispatch latch release did not restore eligibility", e)
	}
}

func TestExecutionRetainedBootstrapLaterPagePostgres(t *testing.T) {
	f := newWebhookFixture(t)
	ids := []string{"10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"}
	tx, e := f.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	var last []byte
	for index, id := range ids {
		repo := int64(500 + index)
		if _, e = tx.Exec(`INSERT INTO golf_execution_value_brokers(forge_url,repository_id,owner_id) VALUES($1,$2,42)`, f.s.config.GiteaURL, repo); e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(`INSERT INTO golf_execution_values(id,forge_url,repository_id,owner_id,name,kind,version,value_bytes) VALUES($1,$2,$3,42,'BUILD_CREDENTIAL','secret',1,8)`, id, f.s.config.GiteaURL, repo); e != nil {
			t.Fatal(e)
		}
		for version := int64(1); version <= 256; version++ {
			binding := executionValueBinding(id, version, f.s.config.GiteaURL, repo, 42, "BUILD_CREDENTIAL", "secret", 8)
			cipher, key, e := f.s.keyring.seal(executionValueDomain, "abcdefgh", binding)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = tx.Exec(`INSERT INTO golf_execution_value_versions(id,version,value_bytes,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,8,$3,$4,$5)`, id, version, cipher, binding, key); e != nil {
				t.Fatal(e)
			}
			if version > 1 {
				if _, e = tx.Exec(`UPDATE golf_execution_values SET version=version+1 WHERE id=$1`, id); e != nil {
					t.Fatal(e)
				}
			}
			if index == 1 && version == 256 {
				last = cipher
			}
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	// Both repos respect the production256-version retention bound, but the key
	// family crosses the500-row cursor. Corruption only on row512 must refuse.
	bad := append([]byte{}, last...)
	bad[len(bad)-1] ^= 1
	if _, e = f.db.Exec(`UPDATE golf_execution_value_versions SET encrypted_content=$2 WHERE id=$1 AND version=256`, ids[1], bad); e != nil {
		t.Fatal(e)
	}
	check := func() error {
		tx, e := f.db.BeginTx(t.Context(), nil)
		if e != nil {
			return e
		}
		defer tx.Rollback()
		return bootstrapExecutionContents(t.Context(), tx, f.s.keyring)
	}
	if e = check(); e != errKeyBootstrap {
		t.Fatal("late retained ciphertext escaped authenticated bootstrap", e)
	}
	if _, e = f.db.Exec(`UPDATE golf_execution_value_versions SET encrypted_content=$2 WHERE id=$1 AND version=256`, ids[1], last); e != nil {
		t.Fatal(e)
	}
	if e = check(); e != nil {
		t.Fatal("valid late retained encrypted history failed bootstrap", e)
	}
}
