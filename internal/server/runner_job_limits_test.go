package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestRunnerResourceManagedBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, procedure := range []string{golfv1connect.RunnerControlServiceGetInstanceRunnerLimitsProcedure, golfv1connect.RunnerControlServiceSetInstanceRunnerLimitsProcedure} {
		if apiReadProcedure(procedure) {
			t.Fatal("resource administration delegated")
		}
		for _, tc := range []struct {
			origin, bearer string
			want           int
		}{{"https://foreign.invalid", "", 403}, {s.config.PublicURL, "", 401}, {s.config.PublicURL, apiTokenPrefix + base64.RawURLEncoding.EncodeToString(make([]byte, 32)), 403}} {
			r := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader(`{}`))
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			if tc.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatal("administration boundary", procedure, w.Code)
			}
		}
	}
}
func TestRunnerResourceWireDoesNotInventHistoricalBinding(t *testing.T) {
	r := workflowRunRecord{Resources: runner.DefaultJobLimits()}
	w := resourceBindingWire(r)
	if w.Bound || w.Limits != nil || w.Profile != "" || w.InstanceVersion != "" {
		t.Fatal("historical absent snapshot presented as admitted limits")
	}
	r.ResourceBound = true
	w = resourceBindingWire(r)
	if !w.Bound || w.InstanceVersion != "0" || w.Limits.MemoryBytes != "268435456" {
		t.Fatal("real version-zero snapshot lost")
	}
	changed := r
	changed.Resources.Pids = 16
	if sameRunnerPoolClaimTarget(r, changed) {
		t.Fatal("changed immutable limits compare equal")
	}
	changed = r
	changed.ResourceInstanceVersion = 1
	if sameRunnerPoolClaimTarget(r, changed) {
		t.Fatal("changed generation compares equal")
	}
}
func TestRunnerResourceCapabilityRefusesOldAndMalformedWorker(t *testing.T) {
	cfg := testConfig("http://forge.invalid")
	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	cfg.RunnerImagesJSON = `{"linux":"alpine@sha256:` + strings.Repeat("b", 64) + `"}`
	cfg.RunnerKeysJSON = `{"fixture":"` + key + `"}`
	s, e := New(cfg, nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		body string
		want int
	}{{`{}`, 204}, {`{"capabilities":["golf.runner.job-limits.v1","golf.runner.job-limits.v1"]}`, 400}, {`{"capabilities":["unknown"]}`, 400}, {`{"capabilities":["golf.runner.job-limits.v1"]}`, 503}} {
		r := httptest.NewRequest("POST", "/internal/ci/poll", strings.NewReader(tc.body))
		r.Header.Set("Golf-Runner-ID", "fixture")
		r.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.want || w.Body.Len() > 128 {
			t.Fatal("capability refused incorrectly", w.Code)
		}
	}
}
func resourcePolicySet(t *testing.T, f *workflowRunFixture, admin loginResult, version string, l runner.JobLimits) (*connect.Response[golfv1.SetInstanceRunnerLimitsResponse], error) {
	t.Helper()
	req, ctx := runnerControlRequest(f.server, admin, &golfv1.SetInstanceRunnerLimitsRequest{ExpectedVersion: version, Limits: limitsWire(l), CurrentPassword: localTestPassword})
	return f.server.SetInstanceRunnerLimits(ctx, req)
}
func resourceWorkerCall(f *workflowRunFixture, path, token, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.Header.Set("Golf-Runner-ID", "fixture")
	if token == "" {
		token = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	} else {
		r.Header.Set("Golf-Attempt-Token", token)
		token = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	}
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	f.server.ServeHTTP(w, r)
	return w
}
func TestRunnerResourceAdminCASAndParentIntersectionPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	request, ctx := runnerControlRequest(f.server, admin, &golfv1.GetInstanceRunnerLimitsRequest{})
	initial, e := f.server.GetInstanceRunnerLimits(ctx, request)
	if e != nil || initial.Msg.Policy.Version != "0" {
		t.Fatal("explicit startup profile", e)
	}
	pool := runnerPoolSaveFixture(t, f, admin, poolInput())
	runnerPlacementSetFixture(t, f, admin, "0", pool.Version, pool.Id)
	l := runner.JobLimits{CPUMillis: 250, MemoryBytes: "67108864", Pids: 16, TimeoutSeconds: 30}
	saved, e := resourcePolicySet(t, f, admin, "0", l)
	if e != nil || saved.Msg.Policy.Version != "1" {
		t.Fatal("lower parent refused by higher configured children", e)
	}
	if _, e = resourcePolicySet(t, f, admin, "0", l); connect.CodeOf(e) != connect.CodeAborted {
		t.Fatal("stale CAS accepted", e)
	}
	p := poolInput()
	p.ExpectedVersion = "1"
	p.JobLimits = limitsWire(runner.DefaultJobLimits())
	poolReq, poolCtx := runnerControlRequest(f.server, admin, p)
	if _, e = f.server.SaveRunnerPool(poolCtx, poolReq); e == nil {
		t.Fatal("explicit child ceiling raised parent")
	}
	f.enable(t)
	run, e := f.dispatch(t, "12345678-1234-4234-8234-123456789091")
	if e != nil {
		t.Fatal(e)
	}
	b := run.Msg.Run.JobResources
	if b == nil || !b.Bound || b.InstanceVersion != "1" || b.PoolVersion != "1" || b.PlacementVersion != "1" || b.Limits.CpuMillis != 250 || b.Limits.MemoryBytes != "67108864" {
		t.Fatal("effective immutable intersection not retained")
	}
	for _, q := range []string{`UPDATE golf_workflow_runs SET resource_cpu_millis=1000`, `UPDATE golf_workflow_runs SET resource_bound=false`, `DELETE FROM golf_instance_runner_limit_audit`, `TRUNCATE golf_instance_runner_limits`} {
		if _, e = f.server.db.Exec(q); e == nil {
			t.Fatal("retained snapshot/history editable")
		}
	}
	restarted, e := New(f.server.config, f.server.db)
	if e != nil {
		t.Fatal(e)
	}
	r, e := restarted.loadWorkflowRun(t.Context(), run.Msg.Run.Id)
	if e != nil || r.Resources != l || r.ResourceInstanceVersion != 1 {
		t.Fatal("restart changed original snapshot", e)
	}
}
func TestRunnerResourceTighteningFencesPrivateTransportPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	f.enable(t)
	run, e := f.dispatch(t, "12345678-1234-4234-8234-123456789092")
	if e != nil {
		t.Fatal(e)
	}
	poll := resourceWorkerCall(f, "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if poll.Code != 200 {
		t.Fatal("claim", poll.Code)
	}
	var assignment struct {
		AttemptID, AttemptToken string
		TimeoutSeconds          int
		JobResources            runner.JobResourceBinding
	}
	if json.Unmarshal(poll.Body.Bytes(), &assignment) != nil || assignment.JobResources.Validate() != nil || assignment.TimeoutSeconds != 900 {
		t.Fatal("assignment missing exact bound limits")
	}
	if _, e = resourcePolicySet(t, f, admin, "0", runner.JobLimits{CPUMillis: 500, MemoryBytes: "134217728", Pids: 32, TimeoutSeconds: 60}); e != nil {
		t.Fatal(e)
	}
	source := httptest.NewRequest("GET", "/internal/ci/attempt/"+assignment.AttemptID+"/source", nil)
	source.Header.Set("Golf-Runner-ID", "fixture")
	source.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	source.Header.Set("Golf-Attempt-Token", assignment.AttemptToken)
	w := httptest.NewRecorder()
	f.server.ServeHTTP(w, source)
	if w.Code != 403 || w.Body.Len() > 128 {
		t.Fatal("stale resources released source", w.Code)
	}
	for _, action := range []string{"heartbeat", "logs", "finish"} {
		if w := resourceWorkerCall(f, "/internal/ci/attempt/"+assignment.AttemptID+"/"+action, assignment.AttemptToken, `{}`); w.Code != 403 {
			t.Fatal("stale active consumer accepted", action, w.Code)
		}
	}
	original, e := f.server.loadWorkflowRun(t.Context(), run.Msg.Run.Id)
	if e != nil || original.State != "cancelled" || !original.CancelRequested || original.LeaseTokenHash != nil || original.Resources != runner.DefaultJobLimits() {
		t.Fatal("cancellation rewrote snapshot or kept token", e)
	}
	replay, e := f.dispatch(t, "12345678-1234-4234-8234-123456789092")
	if e != nil || replay.Msg.Run.Id != run.Msg.Run.Id || replay.Msg.Run.JobResources.InstanceVersion != "0" {
		t.Fatal("original intent silently adopted new policy", e)
	}
	if w := resourceWorkerCall(f, "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`); w.Code != 204 {
		t.Fatal("completed cancelled intent replayed")
	}
}
func TestRunnerResourceCurrentGenerationNotRepeatableSnapshotPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	tx, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	first, e := f.server.instanceRunnerLimits(t.Context(), tx, true)
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() {
		_, e := resourcePolicySet(t, f, admin, "0", runner.JobLimits{CPUMillis: 500, MemoryBytes: "134217728", Pids: 32, TimeoutSeconds: 60})
		done <- e
	}()
	// Wait for the actual blocked UPDATE, rather than mistaking password hashing
	// or scheduling delay for proof that the resource read fence was held.
	deadline := time.Now().Add(5 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		select {
		case e := <-done:
			t.Fatal("edit bypassed final admission shared fence", e)
		default:
		}
		if e = f.server.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'UPDATE golf_instance_runner_limits SET%')`).Scan(&blocked); e != nil {
			t.Fatal(e)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("policy mutation never reached held final generation fence")
	}

	if tx.Commit() != nil {
		t.Fatal("commit")
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	current, e := f.server.instanceRunnerLimits(t.Context(), f.server.db, false)
	if e != nil || current.Version != first.Version+1 {
		t.Fatal("generation not current after wait", e)
	}
}
