package server

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"google.golang.org/protobuf/proto"
)

func typedBindingRequest() *golfv1.SaveRepositoryExecutionBindingRequest {
	m := typedDispatchMessage()
	return &golfv1.SaveRepositoryExecutionBindingRequest{Target: &golfv1.RepositoryExecutionValueTarget{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId}, CommitId: m.Ref, WorkflowPath: m.WorkflowPath, Event: golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL, InputContract: m.InputContract, WorkflowBlobId: m.WorkflowBlobId, SchemaSha256: m.SchemaSha256, SubmittedSha256: m.GetSubmittedSha256(), EffectiveSha256: m.EffectiveSha256}
}
func TestExecutionTypedApprovalPresence(t *testing.T) {
	legacy := &golfv1.SaveRepositoryExecutionBindingRequest{CommitId: strings.Repeat("a", 40)}
	if m, e := executionApprovalTypedRequest(legacy); e != nil || m != nil {
		t.Fatal("legacy shape changed", e)
	}
	for name, change := range map[string]func(*golfv1.SaveRepositoryExecutionBindingRequest){
		"contract_absent": func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.InputContract = nil },
		"contract_empty":  func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.InputContract = ptrTypedString("") },
		"schema":          func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.SchemaSha256 = "" },
		"submitted":       func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.SubmittedSha256 = "" },
		"effective":       func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.EffectiveSha256 = "" },
		"blob":            func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.WorkflowBlobId = strings.Repeat("b", 64) },
		"push": func(m *golfv1.SaveRepositoryExecutionBindingRequest) {
			m.Event = golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_PUSH
		},
		"ref":    func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.EventRef = "refs/heads/main" },
		"target": func(m *golfv1.SaveRepositoryExecutionBindingRequest) { m.Target = nil },
	} {
		t.Run(name, func(t *testing.T) {
			m := typedBindingRequest()
			change(m)
			if _, e := executionApprovalTypedRequest(m); e == nil {
				t.Fatal("incomplete approval adopted")
			}
		})
	}
	m := typedBindingRequest()
	m.Inputs = []*golfv1.WorkflowDispatchInputValue{{Name: "flag", Value: &golfv1.WorkflowDispatchInputValue_BooleanValue{BooleanValue: false}}, {Name: "count", Value: &golfv1.WorkflowDispatchInputValue_NumberValue{NumberValue: "0"}}, {Name: "text", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: ""}}}
	r, e := executionApprovalTypedRequest(m)
	if e != nil || len(r.Inputs) != 3 || !proto.Equal(r.Inputs[0], m.Inputs[0]) || !proto.Equal(r.Inputs[1], m.Inputs[1]) || !proto.Equal(r.Inputs[2], m.Inputs[2]) {
		t.Fatal("explicit zero values or type lost", e)
	}
	schema, e := parseWorkflowDispatchInputs([]byte(typedWorkflowFixture))
	if e != nil {
		t.Fatal(e)
	}
	explicit, e := workflowDispatchWireValues(schema, r.Inputs)
	if e != nil {
		t.Fatal(e)
	}
	omitted, e := workflowDispatchWireValues(schema, m.Inputs[2:])
	if e != nil {
		t.Fatal(e)
	}
	if explicit.SubmittedSHA256 == omitted.SubmittedSHA256 || explicit.EffectiveSHA256 == omitted.EffectiveSHA256 {
		t.Fatal("presence/defaults collapsed")
	}
}
func TestExecutionTypedApprovalRunIdentity(t *testing.T) {
	b := &executionBindingRecord{catalog: runner.ActionsInputsCatalog, event: "manual", inputContract: workflowManualInputsContract, schemaSHA: strings.Repeat("a", 64), submittedSHA: strings.Repeat("b", 64), effectiveSHA: strings.Repeat("c", 64)}
	r := workflowRunRecord{EngineCatalog: b.catalog, Origin: "manual", InputContract: b.inputContract, SchemaSHA256: b.schemaSHA, SubmittedSHA256: b.submittedSHA, EffectiveSHA256: b.effectiveSHA}
	if !executionBindingInputsMatch(b, r) {
		t.Fatal("exact typed approval refused")
	}
	for name, change := range map[string]func(*workflowRunRecord){"catalog": func(r *workflowRunRecord) { r.EngineCatalog = runner.ActionsCatalog }, "contract": func(r *workflowRunRecord) { r.InputContract = "" }, "schema": func(r *workflowRunRecord) { r.SchemaSHA256 = strings.Repeat("d", 64) }, "submitted": func(r *workflowRunRecord) { r.SubmittedSHA256 = strings.Repeat("d", 64) }, "effective": func(r *workflowRunRecord) { r.EffectiveSHA256 = strings.Repeat("d", 64) }, "push": func(r *workflowRunRecord) { r.Origin = "push" }} {
		t.Run(name, func(t *testing.T) {
			changed := r
			change(&changed)
			if executionBindingInputsMatch(b, changed) {
				t.Fatal("different typed intent adopted")
			}
		})
	}
	legacy := &executionBindingRecord{catalog: runner.ActionsCatalog}
	if !executionBindingInputsMatch(legacy, workflowRunRecord{EngineCatalog: runner.ActionsCatalog}) || executionBindingInputsMatch(legacy, r) {
		t.Fatal("legacy scope broadened")
	}
	legacy.inputContract = workflowManualInputsContract
	if executionBindingInputsMatch(legacy, workflowRunRecord{EngineCatalog: runner.ActionsCatalog}) {
		t.Fatal("corrupt legacy metadata accepted")
	}
}

// These tests require a disposable GOLF_TEST_DATABASE_URL and independently
// built GOLF_TEST_ACTIONS_HELPER. Without those inputs they explicitly skip.
func typedExecutionBrokerFixture(t *testing.T) (*workflowRunFixture, *golfv1.RepositoryExecutionValueTarget, *golfv1.DispatchWorkflowRequest) {
	t.Helper()
	f, m := typedPreparedFixture(t, true)
	upstream := f.server.client.Transport
	if upstream == nil {
		upstream = http.DefaultTransport
	}
	f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, e := upstream.RoundTrip(r)
		if e != nil {
			return nil, e
		}
		if response.StatusCode == 200 && (r.URL.Path == "/api/v1/repos/alice/example" || strings.HasPrefix(r.URL.Path, "/api/v1/repositories/")) {
			raw, e := io.ReadAll(response.Body)
			response.Body.Close()
			if e != nil {
				return nil, e
			}
			var row map[string]any
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			if e = decoder.Decode(&row); e != nil {
				return nil, e
			}
			row["fork"] = false
			raw, e = json.Marshal(row)
			if e != nil {
				return nil, e
			}
			response.Body = io.NopCloser(bytes.NewReader(raw))
			response.ContentLength = int64(len(raw))
		}
		return response, nil
	})
	access, e := f.server.GetRepositoryAccess(f.context(t), workflowRunRequest(f, &golfv1.GetRepositoryAccessRequest{Repository: m.Repository}))
	if e != nil {
		t.Fatal(e)
	}
	target := &golfv1.RepositoryExecutionValueTarget{Repository: m.Repository, RepositoryId: access.Msg.Access.RepositoryId, OwnerId: access.Msg.Access.OwnerId, AccessRevision: access.Msg.Access.Revision}
	return f, target, m
}
func typedBrokerApproval(t *testing.T, f *workflowRunFixture, target *golfv1.RepositoryExecutionValueTarget, m *golfv1.DispatchWorkflowRequest) (*golfv1.SaveRepositoryExecutionBindingRequest, string) {
	t.Helper()
	id := uuid.NewString()
	if _, e := f.server.SaveRepositoryExecutionValue(f.context(t), workflowRunRequest(f, executionSaveRequest(target, id, "0", "0", "BUILD_CREDENTIAL", "abcdefgh", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET))); e != nil {
		t.Fatal(e)
	}
	approval := &golfv1.SaveRepositoryExecutionBindingRequest{Target: target, Id: uuid.NewString(), ExpectedVersion: "0", ExpectedBrokerRevision: "1", OperationId: uuid.NewString(), WorkflowPath: m.WorkflowPath, CommitId: m.Ref, Event: golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL, ExpiresAt: time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano), Values: []*golfv1.RepositoryExecutionValueReference{{Id: id, Version: "1"}}, Inputs: m.Inputs, InputContract: m.InputContract, WorkflowBlobId: m.WorkflowBlobId, SchemaSha256: m.SchemaSha256, SubmittedSha256: m.GetSubmittedSha256(), EffectiveSha256: m.EffectiveSha256}
	if _, e := f.server.SaveRepositoryExecutionBinding(f.context(t), workflowRunRequest(f, approval)); e != nil {
		t.Fatal("typed approval", e)
	}
	return approval, id
}
func TestExecutionTypedBrokerReleasePostgres(t *testing.T) {
	f, target, m := typedExecutionBrokerFixture(t)
	approval, _ := typedBrokerApproval(t, f, target, m)
	inventory, e := f.server.ListRepositoryExecutionValues(f.context(t), workflowRunRequest(f, &golfv1.ListRepositoryExecutionValuesRequest{Target: target}))
	if e != nil || len(inventory.Msg.Bindings) != 1 {
		t.Fatal("inventory", e)
	}
	binding := inventory.Msg.Bindings[0]
	if binding.InputContract != m.GetInputContract() || binding.SchemaSha256 != m.SchemaSha256 || binding.SubmittedSha256 != m.GetSubmittedSha256() || binding.EffectiveSha256 != m.EffectiveSha256 {
		t.Fatal("input identities missing")
	}
	var metadata string
	if e = f.server.db.QueryRow(`SELECT request_metadata::text FROM golf_execution_value_operations WHERE operation_id=$1`, approval.OperationId).Scan(&metadata); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(metadata, "private <>&") || strings.Contains(metadata, "abcdefgh") {
		t.Fatal("private input or secret escaped approval metadata")
	}
	changed := proto.Clone(approval).(*golfv1.SaveRepositoryExecutionBindingRequest)
	changed.Inputs[0].Value = &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "different literal"}
	if _, e = f.server.SaveRepositoryExecutionBinding(f.context(t), workflowRunRequest(f, changed)); e == nil {
		t.Fatal("changed map reused accepted digest")
	}
	replay, e := f.server.SaveRepositoryExecutionBinding(f.context(t), workflowRunRequest(f, approval))
	if e != nil || !replay.Msg.Operation.Replayed {
		t.Fatal("exact approval replay", e)
	}
	dispatched, e := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, m))
	if e != nil || dispatched.Msg.Run.OutputState != golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_WITHHELD {
		t.Fatal("typed broker dispatch", e)
	}
	caps := map[string]any{"catalogs": []string{runner.ActionsInputsCatalog}, "capabilities": []string{runner.JobLimitsCapability, runner.ExecutionValuesCapability, runner.ManualInputsCapability}}
	for _, version := range []uint16{0, tls.VersionTLS12} {
		if r := executionWorkerCall(f, engineLease{}, "poll", caps, version); r.Code != 204 {
			t.Fatal("insecure receiver obtained payload", r.Code)
		}
	}
	for _, missing := range []string{runner.ExecutionValuesCapability, runner.ManualInputsCapability} {
		filtered := []string{runner.JobLimitsCapability}
		if missing != runner.ExecutionValuesCapability {
			filtered = append(filtered, runner.ExecutionValuesCapability)
		}
		if missing != runner.ManualInputsCapability {
			filtered = append(filtered, runner.ManualInputsCapability)
		}
		if r := executionWorkerCall(f, engineLease{}, "poll", map[string]any{"catalogs": []string{runner.ActionsInputsCatalog}, "capabilities": filtered}, tls.VersionTLS13); r.Code != 204 {
			t.Fatal("incomplete receiver obtained payload", r.Code)
		}
	}
	response := executionWorkerCall(f, engineLease{}, "poll", caps, tls.VersionTLS13)
	var assignment struct {
		engineLease
		EventJSON            []byte
		ExecutionEnvironment *runner.ExecutionEnvironment
		ManualInputs         *runner.ActionManualInputs
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &assignment) != nil || assignment.ManualInputs == nil || assignment.ExecutionEnvironment == nil || assignment.ExecutionEnvironment.Secrets["BUILD_CREDENTIAL"] != "abcdefgh" || assignment.ManualInputs.SubmittedSHA256 != m.GetSubmittedSha256() {
		t.Fatal("exact independent envelopes not released", response.Code)
	}
	if e = runner.ValidateActionManualInputs(assignment.ActionsPlan, assignment.ManualInputs, assignment.EventJSON, f.commit); e != nil {
		t.Fatal("released inputs inconsistent", e)
	}
	// Approval revocation stops further private payload release and leaves raw output withheld.
	if _, e = f.server.DeleteRepositoryExecutionBinding(f.context(t), workflowRunRequest(f, &golfv1.DeleteRepositoryExecutionBindingRequest{Target: target, Id: approval.Id, ExpectedVersion: "1", ExpectedBrokerRevision: "2", OperationId: uuid.NewString()})); e != nil {
		t.Fatal("revoke approval", e)
	}
	if r := executionWorkerCall(f, assignment.engineLease, "heartbeat", map[string]any{}, tls.VersionTLS13); r.Code == 200 {
		t.Fatal("revoked approval released values again")
	}
	var visible int
	f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_run_logs WHERE run_id=$1`, dispatched.Msg.Run.Id).Scan(&visible)
	if visible != 0 {
		t.Fatal("raw private output visible")
	}
}

func TestExecutionTypedApprovalTransportPostgres(t *testing.T) {
	f, target, _ := typedExecutionBrokerFixture(t)
	// Alternate legal JSON escaping expands the wire without changing decoded
	// values or their bounded canonical maps. This is not oversized input data.
	f.workflow = []byte(strings.Replace(typedWorkflowFixture, "text: {type: string, required: true}", "text: {type: string, required: true}\n      other: {type: string, required: true}\n      third: {type: string, required: true}", 1))
	inputs := []*golfv1.WorkflowDispatchInputValue{}
	for _, name := range []string{"text", "other", "third"} {
		inputs = append(inputs, &golfv1.WorkflowDispatchInputValue{Name: name, Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: strings.Repeat(`"`, 1250)}})
	}
	prepared, e := f.server.PrepareWorkflowDispatch(f.context(t), workflowRunRequest(f, &golfv1.PrepareWorkflowDispatchRequest{Repository: target.Repository, RepositoryId: target.RepositoryId, OwnerId: target.OwnerId, CommitId: f.commit, WorkflowPath: runWorkflowPath, Inputs: inputs}))
	if e != nil {
		t.Fatal("bounded maps", e)
	}
	p := prepared.Msg
	m := &golfv1.SaveRepositoryExecutionBindingRequest{Target: target, Id: uuid.NewString(), ExpectedVersion: "0", ExpectedBrokerRevision: "64", OperationId: uuid.NewString(), WorkflowPath: runWorkflowPath, CommitId: f.commit, Event: golfv1.WorkflowRunOrigin_WORKFLOW_RUN_ORIGIN_MANUAL, ExpiresAt: time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano), Inputs: inputs, InputContract: &p.InputContract, WorkflowBlobId: p.WorkflowBlobId, SchemaSha256: p.SchemaSha256, SubmittedSha256: p.SubmittedSha256, EffectiveSha256: p.EffectiveSha256}
	for i := 0; i < 64; i++ {
		id := uuid.NewString()
		if _, e = f.server.SaveRepositoryExecutionValue(f.context(t), workflowRunRequest(f, executionSaveRequest(target, id, "0", strconv.Itoa(i), fmt.Sprintf("BUILD_VALUE_%d", i), "abcdefgh", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET))); e != nil {
			t.Fatal("bounded current versions", e)
		}
		m.Values = append(m.Values, &golfv1.RepositoryExecutionValueReference{Id: id, Version: "1", Scope: golfv1.ExecutionValueScope_EXECUTION_VALUE_SCOPE_REPOSITORY})
	}
	body, e := protojson.Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	body = bytes.ReplaceAll(body, []byte(`\"`), []byte(`\u0022`))
	if len(body) <= 16<<10 || len(body) > 64<<10 {
		t.Fatal("fixture misses transport bounds", len(body))
	}
	var decoded golfv1.SaveRepositoryExecutionBindingRequest
	if e = protojson.Unmarshal(body, &decoded); e != nil || !proto.Equal(m, &decoded) {
		t.Fatal("escaped payload changed intent", e)
	}
	post := func(procedure string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/rpc/golf.v1.RepositoryExecutionValueService/"+procedure, bytes.NewReader(body))
		r.Header.Set("Cookie", cookieName+"="+f.session.Value)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		r.Header.Set("Origin", f.server.config.PublicURL)
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		return w
	}
	result := post("SaveRepositoryExecutionBinding", body)
	if result.Code != 200 {
		t.Fatal("valid escaped maximum-scoped request refused", result.Code)
	}
	// Same exact request with legal insignificant whitespace exceeds the strict
	// read cap. Neighboring status procedures retain the smaller default cap.
	large := append(append([]byte{}, body...), bytes.Repeat([]byte(" "), 64<<10)...)
	for _, procedure := range []string{"SaveRepositoryExecutionBinding", "GetRepositoryExecutionValueOperation"} {
		r := post(procedure, large)
		var problem struct {
			Code string `json:"code"`
		}
		json.Unmarshal(r.Body.Bytes(), &problem)
		if problem.Code != "resource_exhausted" {
			t.Fatal("oversized request reached effect", procedure, r.Code, problem.Code)
		}
	}
	invalid := proto.Clone(m).(*golfv1.SaveRepositoryExecutionBindingRequest)
	invalid.OperationId = uuid.NewString()
	invalid.SubmittedSha256 = strings.Repeat("f", 64)
	raw, _ := protojson.Marshal(invalid)
	result = post("SaveRepositoryExecutionBinding", raw)
	if result.Code == 200 {
		t.Fatal("wrong input digest admitted")
	}
	var count int
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_execution_binding_versions WHERE id=$1`, m.Id).Scan(&count); e != nil || count != 1 {
		t.Fatal("transport/digest refusal mutated approval", count, e)
	}
}

func TestExecutionTypedBrokerQuarantinePostgres(t *testing.T) {
	f, target, m := typedExecutionBrokerFixture(t)
	typedBrokerApproval(t, f, target, m)
	result, e := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, m))
	if e != nil {
		t.Fatal(e)
	}
	run := result.Msg.Run
	response := executionWorkerCall(f, engineLease{}, "poll", map[string]any{"catalogs": []string{runner.ActionsInputsCatalog}, "capabilities": []string{runner.JobLimitsCapability, runner.ExecutionValuesCapability, runner.ManualInputsCapability}}, tls.VersionTLS13)
	var lease engineLease
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &lease) != nil {
		t.Fatal("typed broker lease", response.Code)
	}
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
