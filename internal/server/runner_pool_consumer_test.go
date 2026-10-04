package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestRunnerPoolManagedRPCBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, procedure := range []string{golfv1connect.RunnerPoolServiceListRunnerPoolsProcedure, golfv1connect.RunnerPoolServiceSaveRunnerPoolProcedure, golfv1connect.RunnerPoolServiceGetRepositoryRunnerPlacementProcedure, golfv1connect.RunnerPoolServiceSetRepositoryRunnerPlacementProcedure} {
		if apiReadProcedure(procedure) {
			t.Fatal("runner pool delegated read/write grant", procedure)
		}
		for _, tc := range []struct {
			origin, bearer string
			status         int
		}{
			{"https://foreign.invalid", "", 403},
			{s.config.PublicURL, "", 401},
			{s.config.PublicURL, apiTokenPrefix + base64.RawURLEncoding.EncodeToString(make([]byte, 32)), 403},
		} {
			r := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader(`{}`))
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			if tc.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatal("managed RPC boundary or registration", procedure, w.Code)
			}
		}
	}
}

func TestRunnerPoolProductionTransportAndReplayPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	secondKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32))
	f.server.runnerKeys["second"] = sha256.Sum256([]byte(secondKey))
	pool := runnerPoolSaveFixture(t, f, admin, poolInput())
	runnerPlacementSetFixture(t, f, admin, "0", pool.Version, pool.Id)
	f.enable(t)
	firstKey := "12345678-1234-4234-8234-123456789021"
	first, e := f.dispatch(t, firstKey)
	if e != nil {
		t.Fatal(e)
	}
	second, e := f.dispatch(t, "12345678-1234-4234-8234-123456789022")
	if e != nil {
		t.Fatal(e)
	}
	for _, run := range []*golfv1.WorkflowRun{first.Msg.Run, second.Msg.Run} {
		if run.RunnerPlacement == nil || run.RunnerPlacement.PoolId != pool.Id || run.RunnerPlacement.PoolVersion != "1" || run.RunnerPlacement.PlacementVersion != "1" || run.RunnerPlacement.LegacyUnbound {
			t.Fatal("dispatch omitted immutable placement")
		}
	}
	poll := func(worker, key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/internal/ci/poll", strings.NewReader(`{"capabilities":["golf.runner.job-limits.v1"]}`))
		r.Header.Set("Golf-Runner-ID", worker)
		r.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		return w
	}
	fixtureKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	w := poll("fixture", fixtureKey)
	if w.Code != 200 {
		t.Fatal("production assigned pool claim", w.Code)
	}
	var receipt struct {
		RunID     string `json:"runId"`
		AttemptID string `json:"attemptId"`
	}
	if json.Unmarshal(w.Body.Bytes(), &receipt) != nil || receipt.RunID != first.Msg.Run.Id || !attemptIdentifier.MatchString(receipt.AttemptID) {
		t.Fatal("claim did not return exact run/attempt")
	}
	if w = poll("second", secondKey); w.Code != 204 || w.Body.Len() != 0 {
		t.Fatal("capacity released second assignment", w.Code)
	}
	queued, e := f.server.loadWorkflowRun(t.Context(), second.Msg.Run.Id)
	if e != nil || queued.State != "queued" {
		t.Fatal("backpressure cancelled queued work", e)
	}
	m := poolInput()
	m.ExpectedVersion = "1"
	m.State = golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING
	runnerPoolSaveFixture(t, f, admin, m)
	archives := f.archives
	replay, e := f.dispatch(t, firstKey)
	if e != nil || replay.Msg.Run.Id != first.Msg.Run.Id || replay.Msg.Run.RunnerPlacement.PoolVersion != "1" || f.archives != archives {
		t.Fatal("same original intent redispatched or refreshed pool pin", e)
	}
	if _, e = f.dispatch(t, "12345678-1234-4234-8234-123456789023"); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("new manual admission ignored drain", e)
	}
	if w = poll("second", secondKey); w.Code != 204 || w.Body.Len() != 0 {
		t.Fatal("stale admission dispatched", w.Code)
	}
	queued, e = f.server.loadWorkflowRun(t.Context(), second.Msg.Run.Id)
	if e != nil || queued.State != "cancelled" || queued.RunnerPlacement.PoolVersion.Int64 != 1 || !strings.Contains(queued.Reason, "explicitly dispatch") {
		t.Fatal("stale original pin/refusal unavailable", e)
	}
	status, e := f.server.GetWorkflowRun(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowRunRequest{RunId: first.Msg.Run.Id}))
	if e != nil || status.Msg.Run.State != golfv1.WorkflowRunState_WORKFLOW_RUN_STATE_RUNNING || status.Msg.Run.RunnerPlacement.PoolVersion != "1" {
		t.Fatal("drain erased running attempt or original detail receipt", e)
	}
}
