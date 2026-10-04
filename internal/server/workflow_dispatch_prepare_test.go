package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const typedDispatchWorkflow = `name: Parameters
on:
  workflow_dispatch:
    inputs:
      text:
        type: string
        default: fallback
      enabled:
        type: boolean
        default: true
      count:
        type: number
        default: 2
      mode:
        type: choice
        options: [fast, thorough]
        default: thorough
jobs:
  inspect:
    runs-on: linux
    steps:
      - run: echo ordinary
`

func typedDispatchWireValues() []*golfv1.WorkflowDispatchInputValue {
	return []*golfv1.WorkflowDispatchInputValue{
		{Name: "text", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: ""}},
		{Name: "enabled", Value: &golfv1.WorkflowDispatchInputValue_BooleanValue{BooleanValue: false}},
		{Name: "count", Value: &golfv1.WorkflowDispatchInputValue_NumberValue{NumberValue: "-0"}},
		{Name: "mode", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "fast"}},
	}
}

func TestWorkflowDispatchPrepareWirePresence(t *testing.T) {
	schema, err := parseWorkflowDispatchInputs([]byte(typedDispatchWorkflow))
	if err != nil {
		t.Fatal(err)
	}
	values, err := workflowDispatchWireValues(schema, typedDispatchWireValues())
	if err != nil || len(values.Submitted) != 4 || values.Effective[0].Number != "0" || values.Effective[1].Boolean || values.Effective[3].String != "" {
		t.Fatal("explicit zero/false/empty lost", err)
	}
	defaults, err := workflowDispatchWireValues(schema, nil)
	if err != nil || defaults.SubmittedSHA256 == values.SubmittedSHA256 || defaults.EffectiveSHA256 == values.EffectiveSHA256 {
		t.Fatal("omission adopted explicit values", err)
	}
	for _, d := range workflowDispatchDefinitionsWire(schema) {
		if d.DefaultValue == nil || d.DefaultValue.Value == nil {
			t.Fatal("default presence lost")
		}
	}
	for _, input := range []*golfv1.WorkflowDispatchInputValue{
		nil, {Name: "text"}, {Name: "unknown", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "private-marker"}},
		{Name: "count", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "0"}},
		{Name: "enabled", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "false"}},
		{Name: "count", Value: &golfv1.WorkflowDispatchInputValue_NumberValue{NumberValue: "9007199254740993"}},
		{Name: "mode", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "private-marker"}},
	} {
		if _, err = workflowDispatchWireValues(schema, []*golfv1.WorkflowDispatchInputValue{input}); err == nil || strings.Contains(err.Error(), "private-marker") {
			t.Fatal("untyped/invalid value accepted or disclosed", err)
		}
	}
	unknown := &golfv1.WorkflowDispatchInputValue{Name: "text", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "hidden"}}
	unknown.ProtoReflect().SetUnknown([]byte{0x98, 0x06, 0x01})
	if _, err = workflowDispatchWireValues(schema, []*golfv1.WorkflowDispatchInputValue{unknown}); err == nil {
		t.Fatal("unknown value extension accepted")
	}
	if _, err = workflowDispatchWireValues(schema, []*golfv1.WorkflowDispatchInputValue{typedDispatchWireValues()[0], typedDispatchWireValues()[0]}); err == nil {
		t.Fatal("duplicate accepted")
	}
}

func TestWorkflowDispatchPrepareBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid", ""} {
		r := httptest.NewRequest(http.MethodPost, "/rpc/golf.v1.WorkflowRunService/PrepareWorkflowDispatch", strings.NewReader("{}"))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		want := 403
		if origin == s.config.PublicURL {
			want = 401
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("preparation outer boundary", w.Code)
		}
	}
	if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), "/golf.v1.WorkflowRunService/PrepareWorkflowDispatch", "{}"); w.Code != 403 {
		t.Fatal("bearer preparation admitted", w.Code)
	}
}

func prepareTypedDispatchInput(f *workflowRunFixture) *golfv1.PrepareWorkflowDispatchRequest {
	return &golfv1.PrepareWorkflowDispatchRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: strconv.FormatInt(f.row.ID, 10), OwnerId: strconv.FormatInt(f.row.Owner.ID, 10), CommitId: f.commit, WorkflowPath: runWorkflowPath, Inputs: typedDispatchWireValues()}
}

func TestWorkflowDispatchPreparePostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.workflow = []byte(typedDispatchWorkflow)
	m := prepareTypedDispatchInput(f)
	// Preparation is permitted with execution disabled and no maintained engine.
	// Its response must not claim run eligibility or reserve any work.
	var mutations, archives atomic.Int32
	f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet {
			mutations.Add(1)
		}
		if strings.Contains(r.URL.Path, "/archive/") {
			archives.Add(1)
		}
		return http.DefaultTransport.RoundTrip(r)
	})
	response, err := f.server.PrepareWorkflowDispatch(f.context(t), workflowRunRequest(f, m))
	if err != nil {
		t.Fatal(err)
	}
	schema, _ := parseWorkflowDispatchInputs(f.workflow)
	values, _ := workflowDispatchWireValues(schema, m.Inputs)
	w := response.Msg
	if w.CommitId != m.CommitId || w.WorkflowBlobId != sourceBlobHash(f.workflow, 40) || w.NativeActorId != "42" || w.SchemaSha256 != schema.SHA256 || w.SubmittedSha256 != values.SubmittedSHA256 || w.EffectiveSha256 != values.EffectiveSHA256 || len(w.Definitions) != 4 || w.InputContract != workflowManualInputsContract {
		t.Fatal("preparation lost exact source/actor/typed-map binding")
	}
	// Submitted values never appear in the metadata response. Explicit empty is
	// tested above; use a unique non-default literal for disclosure inspection.
	m.Inputs[0].Value = &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "private-submitted-marker $() ${{ secrets.KEY }}"}
	body, _ := protojson.Marshal(m)
	r := httptest.NewRequest(http.MethodPost, "/rpc/golf.v1.WorkflowRunService/PrepareWorkflowDispatch", bytes.NewReader(body))
	r.Header.Set("Origin", f.server.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	r.Header.Set("Cookie", cookieName+"="+f.session.Value)
	served := httptest.NewRecorder()
	f.server.ServeHTTP(served, r)
	var metadata golfv1.PrepareWorkflowDispatchResponse
	if served.Code != 200 || served.Header().Get("Cache-Control") != "no-store" || protojson.Unmarshal(served.Body.Bytes(), &metadata) != nil || bytes.Contains(served.Body.Bytes(), []byte("private-submitted-marker")) {
		t.Fatal("served preparation failed or disclosed submitted values", served.Code)
	}
	var count int
	if err = f.server.db.QueryRowContext(t.Context(), `SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 0 || archives.Load() != 0 || mutations.Load() != 0 || f.archives != 0 {
		t.Fatal("preparation created work or requested mutation/archive", count, err)
	}
}

func TestWorkflowDispatchPrepareTargetPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.workflow = []byte(typedDispatchWorkflow)
	valid := prepareTypedDispatchInput(f)
	for _, change := range []func(*golfv1.PrepareWorkflowDispatchRequest){
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.CommitId = "main" },
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.RepositoryId = "01" },
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.OwnerId = "0" },
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.WorkflowPath = ".gitlab-ci.yml" },
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.WorkflowPath = "../workflow.yml" },
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.ProtoReflect().SetUnknown([]byte{0x98, 0x06, 0x01}) },
	} {
		m := proto.Clone(valid).(*golfv1.PrepareWorkflowDispatchRequest)
		change(m)
		if _, err := f.server.PrepareWorkflowDispatch(f.context(t), workflowRunRequest(f, m)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("unbound preparation accepted", err)
		}
	}
	for _, change := range []func(*golfv1.PrepareWorkflowDispatchRequest){
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.RepositoryId = "999" },
		func(m *golfv1.PrepareWorkflowDispatchRequest) { m.OwnerId = "999" },
	} {
		m := proto.Clone(valid).(*golfv1.PrepareWorkflowDispatchRequest)
		change(m)
		if _, err := f.server.PrepareWorkflowDispatch(f.context(t), workflowRunRequest(f, m)); connect.CodeOf(err) != connect.CodeNotFound {
			t.Fatal("replacement target adopted", err)
		}
	}
	for _, permission := range []string{"read", "none"} {
		f.permission = permission
		if _, err := f.server.PrepareWorkflowDispatch(f.context(t), workflowRunRequest(f, valid)); err == nil {
			t.Fatal("nonwriter read private parameter preparation")
		}
	}
}

func TestWorkflowDispatchPrepareRevocationPostgres(t *testing.T) {
	for _, revoke := range []string{"permission", "session", "native actor"} {
		t.Run(revoke, func(t *testing.T) {
			f := newWorkflowRunFixture(t)
			f.workflow = []byte(typedDispatchWorkflow)
			m := prepareTypedDispatchInput(f)
			var once atomic.Bool
			f.server.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
				response, err := http.DefaultTransport.RoundTrip(r)
				if strings.Contains(r.URL.Path, "/git/blobs/") && once.CompareAndSwap(false, true) {
					switch revoke {
					case "permission":
						f.mu.Lock()
						f.permission = "read"
						f.mu.Unlock()
					case "native actor":
						f.mu.Lock()
						f.user.ID++
						f.mu.Unlock()
					case "session":
						if _, e := f.server.db.ExecContext(t.Context(), `DELETE FROM golf_sessions`); e != nil {
							t.Error(e)
						}
					}
				}
				return response, err
			})
			if _, err := f.server.PrepareWorkflowDispatch(f.context(t), workflowRunRequest(f, m)); err == nil || !once.Load() {
				t.Fatal("authority revoked during native source read returned private preparation", err)
			}
			var count int
			if err := f.server.db.QueryRowContext(t.Context(), `SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 0 {
				t.Fatal("revocation created work", err)
			}
		})
	}
}

func TestWorkflowDispatchPrepareProtoJSONPresence(t *testing.T) {
	var request golfv1.PrepareWorkflowDispatchRequest
	if err := protojson.Unmarshal([]byte(`{"inputs":[{"name":"enabled","booleanValue":false},{"name":"count","numberValue":"0"},{"name":"text","stringValue":""}]}`), &request); err != nil {
		t.Fatal(err)
	}
	for _, value := range request.Inputs {
		if value.Value == nil {
			t.Fatal("wire lost present zero/false/empty")
		}
	}
	encoded, err := json.Marshal(workflowDispatchDefinitionsWire(workflowDispatchInputSchema{}))
	if err != nil || string(encoded) != "[]" {
		t.Fatal("empty declaration inventory is not an array")
	}
}
