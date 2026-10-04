package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

// Schema057 codec/058 key tests seed a real immutable typed run in the same
// fixture transaction as encrypted content. This is test data, not an engine
// admission claim; production planning is exercised separately below.
func insertTypedWorkflowInputFixtureRun(t *testing.T, tx *sql.Tx, source string, row workflowDispatchInputContent) {
	t.Helper()
	i := row.Identity
	plan := map[string]any{"Format": 1, "Actions": map[string]any{"catalog": workflowTypedEngineCatalog, "archiveSha256": i.SourceSHA256, "manualInputsContract": workflowManualInputsContract, "manualInputsSchemaSha256": i.SchemaSHA256, "jobs": []any{map[string]any{"instanceId": strings.Repeat("1", 32), "jobId": "input_fixture", "name": "Input fixture", "image": "fixture@sha256:" + strings.Repeat("b", 64), "matrix": []any{}, "needs": []any{}, "steps": []any{map[string]string{"id": "input", "name": "Input"}}}}}}
	patch, _ := json.Marshal(map[string]any{"id": i.RunID, "idempotency_key": i.IdempotencyKey, "input_contract": workflowManualInputsContract, "input_schema_sha256": i.SchemaSHA256, "submitted_inputs_sha256": i.SubmittedSHA256, "effective_inputs_sha256": i.EffectiveSHA256, "plan": plan})
	if _, err := tx.ExecContext(t.Context(), `INSERT INTO golf_workflow_runs SELECT (jsonb_populate_record(NULL::golf_workflow_runs,to_jsonb(r)||$2::jsonb)).* FROM golf_workflow_runs r WHERE id=$1`, source, string(patch)); err != nil {
		t.Fatal("typed run fixture insert", err)
	}
}

func typedDispatchMessage() *golfv1.DispatchWorkflowRequest {
	contract := workflowManualInputsContract
	submitted := strings.Repeat("c", 64)
	return &golfv1.DispatchWorkflowRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, Ref: strings.Repeat("a", 40), WorkflowPath: runWorkflowPath, IdempotencyKey: uuid.NewString(), RepositoryId: "7", OwnerId: "42", WorkflowBlobId: strings.Repeat("b", 40), SchemaSha256: strings.Repeat("d", 64), SubmittedSha256: &submitted, EffectiveSha256: strings.Repeat("e", 64), InputContract: &contract}
}
func TestWorkflowTypedRequestAndIntentBoundaries(t *testing.T) {
	m := typedDispatchMessage()
	typed, repo, owner, err := workflowDispatchTypedMode(m)
	if err != nil || !typed || repo != 7 || owner != 42 {
		t.Fatal("valid typed shape", err)
	}
	original := workflowTypedIntentHash(keyFrom(m.Repository), m.Ref, m.WorkflowPath, repo, owner, m.WorkflowBlobId, m.SchemaSha256, m.GetSubmittedSha256(), m.EffectiveSha256, m.GetInputContract())
	if fmt.Sprintf("%x", original) != "dbd859cde3e73af4cf1f811792961fe540a73a217191f7b3aec648d75dc0a7d0" {
		t.Fatal("typed identity domain/field order changed")
	}
	if bytes.Equal(original, workflowIntentHash(keyFrom(m.Repository), m.Ref, m.WorkflowPath, repo, owner)) {
		t.Fatal("typed intent adopted legacy identity")
	}
	for _, mutate := range []func(*golfv1.DispatchWorkflowRequest){func(m *golfv1.DispatchWorkflowRequest) { m.InputContract = nil }, func(m *golfv1.DispatchWorkflowRequest) { m.SubmittedSha256 = nil }, func(m *golfv1.DispatchWorkflowRequest) { m.Ref = "main" }, func(m *golfv1.DispatchWorkflowRequest) { m.SchemaSha256 = "" }, func(m *golfv1.DispatchWorkflowRequest) { m.WorkflowBlobId = "" }, func(m *golfv1.DispatchWorkflowRequest) { m.RepositoryId = "" }, func(m *golfv1.DispatchWorkflowRequest) { m.WorkflowPath = ".gitlab-ci.yml" }} {
		changed := typedDispatchMessage()
		mutate(changed)
		if _, _, _, err = workflowDispatchTypedMode(changed); err == nil {
			t.Fatal("incomplete typed request admitted")
		}
	}
	legacy := &golfv1.DispatchWorkflowRequest{Repository: m.Repository, Ref: "main", WorkflowPath: runWorkflowPath, IdempotencyKey: m.IdempotencyKey}
	if typed, _, _, err = workflowDispatchTypedMode(legacy); err != nil || typed {
		t.Fatal("legacy shape changed", err)
	}
	// Full metadata only: status inspection never needs plaintext values/defaults.
	inspection := &golfv1.GetWorkflowDispatchRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, CommitId: m.Ref, WorkflowPath: m.WorkflowPath, IdempotencyKey: m.IdempotencyKey, WorkflowBlobId: &m.WorkflowBlobId, SchemaSha256: &m.SchemaSha256, SubmittedSha256: m.SubmittedSha256, EffectiveSha256: &m.EffectiveSha256, InputContract: m.InputContract}
	record := workflowRunRecord{Origin: "manual", UserID: 1, RepositoryID: repo, OwnerID: owner, RepositoryOwner: "alice", RepositoryName: "example", CommitID: m.Ref, WorkflowPath: m.WorkflowPath, IdempotencyKey: m.IdempotencyKey, BlobID: m.WorkflowBlobId, InputContract: m.GetInputContract(), SchemaSHA256: m.SchemaSha256, SubmittedSHA256: m.GetSubmittedSha256(), EffectiveSHA256: m.EffectiveSha256, InputHash: original}
	if !validWorkflowTypedInspection(inspection) || !workflowDispatchMatches(record, keyFrom(m.Repository), repo, owner, 1, inspection) {
		t.Fatal("exact typed inspection refused")
	}
	inspection.SubmittedSha256 = nil
	if validWorkflowTypedInspection(inspection) || workflowDispatchMatches(record, keyFrom(m.Repository), repo, owner, 1, inspection) {
		t.Fatal("missing original metadata adopted")
	}
}

const typedWorkflowFixture = `on:
  workflow_dispatch:
    inputs:
      text: {type: string, required: true}
      flag: {type: boolean, default: false}
      count: {type: number, default: 2.0}
defaults: {run: {shell: sh}}
jobs:
  build:
    runs-on: linux
    steps: [{id: input, run: 'printf ok'}]
`

func typedPreparedFixture(t *testing.T, engine bool) (*workflowRunFixture, *golfv1.DispatchWorkflowRequest) {
	t.Helper()
	f := newWorkflowRunFixture(t)
	f.enable(t)
	f.workflow = []byte(typedWorkflowFixture)
	if engine {
		helper := os.Getenv("GOLF_TEST_ACTIONS_HELPER")
		if helper == "" {
			t.Skip("set GOLF_TEST_ACTIONS_HELPER to independently built typed v2 planner")
		}
		if !filepath.IsAbs(helper) {
			t.Fatal("planner path must be absolute")
		}
		f.server.config.ActionsEngineCatalog = workflowTypedEngineCatalog
		f.server.config.ActionsEngineBinary = helper
	}
	input := &golfv1.WorkflowDispatchInputValue{Name: "text", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "private <>& 世界 literal ${{ secrets.value }}"}}
	prepared, err := f.server.PrepareWorkflowDispatch(f.context(t), workflowRunRequest(f, &golfv1.PrepareWorkflowDispatchRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: strconv.FormatInt(f.row.ID, 10), OwnerId: strconv.FormatInt(f.row.Owner.ID, 10), CommitId: f.commit, WorkflowPath: runWorkflowPath, Inputs: []*golfv1.WorkflowDispatchInputValue{input}}))
	if err != nil {
		t.Fatal("prepare fixture", err)
	}
	p := prepared.Msg
	return f, &golfv1.DispatchWorkflowRequest{Repository: p.Repository, Ref: p.CommitId, WorkflowPath: p.WorkflowPath, IdempotencyKey: uuid.NewString(), Inputs: []*golfv1.WorkflowDispatchInputValue{input}, SubmittedSha256: &p.SubmittedSha256, WorkflowBlobId: p.WorkflowBlobId, RepositoryId: p.RepositoryId, OwnerId: p.OwnerId, SchemaSha256: p.SchemaSha256, InputContract: &p.InputContract, EffectiveSha256: p.EffectiveSha256}
}
func typedOriginalRequest(m *golfv1.DispatchWorkflowRequest) *golfv1.GetWorkflowDispatchRequest {
	return &golfv1.GetWorkflowDispatchRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, CommitId: m.Ref, WorkflowPath: m.WorkflowPath, IdempotencyKey: m.IdempotencyKey, SubmittedSha256: m.SubmittedSha256, SchemaSha256: &m.SchemaSha256, WorkflowBlobId: &m.WorkflowBlobId, InputContract: m.InputContract, EffectiveSha256: &m.EffectiveSha256}
}
func TestWorkflowTypedInvalidBeforeUploadPostgres(t *testing.T) {
	f, m := typedPreparedFixture(t, false)
	for _, mutate := range []func(*golfv1.DispatchWorkflowRequest){func(m *golfv1.DispatchWorkflowRequest) { m.SchemaSha256 = strings.Repeat("e", 64) }, func(m *golfv1.DispatchWorkflowRequest) { m.WorkflowBlobId = strings.Repeat("e", 40) }, func(m *golfv1.DispatchWorkflowRequest) { m.RepositoryId = "999" }, func(m *golfv1.DispatchWorkflowRequest) {
		m.Inputs = []*golfv1.WorkflowDispatchInputValue{{Name: "text", Value: &golfv1.WorkflowDispatchInputValue_BooleanValue{BooleanValue: true}}}
	}} {
		changed := proto.Clone(m).(*golfv1.DispatchWorkflowRequest)
		changed.IdempotencyKey = uuid.NewString()
		mutate(changed)
		if _, err := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, changed)); err == nil {
			t.Fatal("invalid typed input admitted")
		}
	}
	var count int
	if err := f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs`).Scan(&count); err != nil || count != 0 || f.archives != 0 {
		t.Fatal("invalid input reserved/fetched archive", err)
	}
}
func TestWorkflowTypedOnceReplayAndOriginalPostgres(t *testing.T) {
	f, m := typedPreparedFixture(t, true)
	var wg sync.WaitGroup
	results := make(chan *golfv1.WorkflowRun, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Go(func() {
			r, err := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, m))
			if err != nil {
				errs <- err
			} else {
				results <- r.Msg.Run
			}
		})
	}
	wg.Wait()
	close(errs)
	close(results)
	for err := range errs {
		t.Fatal("concurrent typed admission", err)
	}
	var first *golfv1.WorkflowRun
	for r := range results {
		if first == nil {
			first = r
		} else if r.Id != first.Id {
			t.Fatal("same original key admitted two runs")
		}
	}
	if first == nil || first.InputContract != workflowManualInputsContract || first.SubmittedSha256 != m.GetSubmittedSha256() || first.EffectiveSha256 != m.EffectiveSha256 {
		t.Fatal("typed receipt missing")
	}
	var runs, contents int
	if err := f.server.db.QueryRow(`SELECT (SELECT count(*) FROM golf_workflow_runs),(SELECT count(*) FROM golf_workflow_dispatch_inputs)`).Scan(&runs, &contents); err != nil || runs != 1 || contents != 1 {
		t.Fatal("atomic once-only run/content", err)
	}
	archives := f.archives
	// Changed submitted plaintext under the SAME digest claim must conflict.
	changed := proto.Clone(m).(*golfv1.DispatchWorkflowRequest)
	changed.Inputs = []*golfv1.WorkflowDispatchInputValue{{Name: "text", Value: &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: "different private intent"}}}
	if _, err := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, changed)); !errors.Is(err, errWorkflowRunConflict) && connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("changed map reused digest/key", err)
	}
	original, err := f.server.GetWorkflowDispatch(f.context(t), workflowRunRequest(f, typedOriginalRequest(m)))
	if err != nil || original.Msg.Run.Id != first.Id || original.Msg.Run.CanCancel || original.Msg.InputContract != workflowManualInputsContract {
		t.Fatal("lost-ack original inspection", err)
	}
	if f.archives != archives {
		t.Fatal("original inspection/replay fetched source")
	}
	raw, _ := json.Marshal(original.Msg)
	if bytes.Contains(raw, []byte("private")) || bytes.Contains(raw, []byte("encrypted_content")) {
		t.Fatal("metadata receipt disclosed inputs")
	}
	// Missing original keys do not prove no admission; another actor cannot
	// inspect this key or discover the original user's immutable private intent.
	missing := typedOriginalRequest(m)
	missing.IdempotencyKey = uuid.NewString()
	if _, err = f.server.GetWorkflowDispatch(f.context(t), workflowRunRequest(f, missing)); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("missing original outcome invented", err)
	}
	wrong := typedOriginalRequest(m)
	wrong.WorkflowBlobId = ptrTypedString(strings.Repeat("f", 40))
	if _, err = f.server.GetWorkflowDispatch(f.context(t), workflowRunRequest(f, wrong)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("wrong typed original tuple adopted", err)
	}
	f.mu.Lock()
	f.user.ID, f.user.Login, f.permission = 43, "bob", "write"
	f.mu.Unlock()
	bob, err := f.server.createSession(t.Context(), f.user, "pat", "run-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	oldSession := f.session
	f.session = bob
	if _, err = f.server.GetWorkflowDispatch(f.context(t), workflowRunRequest(f, typedOriginalRequest(m))); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("another actor discovered original key", err)
	}
	f.session = oldSession
	f.mu.Lock()
	f.user.ID, f.user.Login, f.permission = 42, "alice", "read"
	f.mu.Unlock()
	if _, err = f.server.GetWorkflowDispatch(f.context(t), workflowRunRequest(f, typedOriginalRequest(m))); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("revoked writer saw original private receipt", err)
	}
}

func TestWorkflowTypedPayloadMandatoryPostgres(t *testing.T) {
	f, rows := seedWorkflowInputKeyRows(t, 1)
	row := rows[0]
	tx, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	source := row.Identity.RunID
	row.Identity.RunID = uuid.NewString()
	row.Identity.IdempotencyKey = uuid.NewString()
	insertTypedWorkflowInputFixtureRun(t, tx, source, row)
	if err = tx.Commit(); err == nil {
		t.Fatal("typed run committed without encrypted content")
	}
	var count int
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs WHERE id=$1`, row.Identity.RunID).Scan(&count); err != nil || count != 0 {
		t.Fatal("missing payload left runnable admission", err)
	}
	// A metadata-only original read cannot adopt another actor or tuple.
}

func ptrTypedString(s string) *string { return &s }

// A typed v2 run must never silently inherit a v1 secret source approval.
func TestWorkflowTypedV1ExecutionApprovalRefusedPostgres(t *testing.T) {
	f, target := executionEngineFixture(t)
	_, binding := executionEngineApproval(t, f, target)
	r := workflowRunRecord{RepositoryID: f.row.ID, OwnerID: f.row.Owner.ID, WorkflowPath: runWorkflowPath, Origin: "manual", EngineCatalog: workflowTypedEngineCatalog}
	if err := f.server.db.QueryRow(`SELECT commit_id,blob_id,source_sha256 FROM golf_execution_binding_versions WHERE id=$1 AND version=1`, binding).Scan(&r.CommitID, &r.BlobID, &r.SourceSHA256); err != nil {
		t.Fatal("source approval fixture", err)
	}
	r.EventRef = r.CommitID
	if approval, err := f.server.executionApprovalForSource(t.Context(), r); !errors.Is(err, errExecutionApproval) || approval != nil {
		t.Fatal("typed source silently adopted v1 secret approval", err)
	}
	var count int
	if err := f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_execution_bindings`).Scan(&count); err != nil || count != 0 {
		t.Fatal("refusal attached secret release authority", err)
	}
}
