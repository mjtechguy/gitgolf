package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestRunnerControlTransitionAndVersion(t *testing.T) {
	for _, old := range []string{"active", "draining", "revoked", "invalid"} {
		for _, next := range []string{"active", "draining", "revoked", "invalid"} {
			expected := old == "active" && (next == "draining" || next == "revoked") || old == "draining" && (next == "active" || next == "revoked")
			if runnerControlTransition(old, next) != expected {
				t.Fatal(old, next)
			}
		}
	}
	for _, v := range []string{"0", "1", "9007199254740993", "9223372036854775807"} {
		if _, ok := runnerControlVersion(v); !ok {
			t.Fatal(v)
		}
	}
	for _, v := range []string{"", "01", "-1", "+1", "1.0", "9223372036854775808"} {
		if _, ok := runnerControlVersion(v); ok {
			t.Fatal(v)
		}
	}
	for _, state := range []string{"active", "draining", "revoked"} {
		if runnerControlName(runnerControlWire(state)) != state {
			t.Fatal(state)
		}
	}
}
func runnerControlRequest[T any](s *Server, session loginResult, m *T) (*connect.Request[T], context.Context) {
	req := connect.NewRequest(m)
	req.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 0).Name+"="+session.Value)
	credential, err := s.sessionCredential(context.Background(), session.Value)
	if err != nil {
		return req, context.Background()
	}
	return req, context.WithValue(context.Background(), sessionTokenKey{}, credential)
}
func TestRunnerControlAdminCASRestartPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	member := localLogin(t, f, "bob")
	f.s.runnerKeys = map[string][32]byte{"worker": sha256.Sum256([]byte("not exposed"))}
	for _, session := range []loginResult{member, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		req, ctx := runnerControlRequest(f.s, session, &golfv1.GetInstanceRunnersRequest{})
		if _, err := f.s.GetInstanceRunners(ctx, req); connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatal("foreign admin", err)
		}
		update, updateContext := runnerControlRequest(f.s, session, &golfv1.UpdateRunnerControlRequest{WorkerId: "worker", ExpectedVersion: "0", State: golfv1.RunnerControlState_RUNNER_CONTROL_STATE_DRAINING, CurrentPassword: localTestPassword})
		if response, err := f.s.UpdateRunnerControl(updateContext, update); response != nil || connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatal("foreign control must preserve permission denial", err)
		}
	}
	list, ctx := runnerControlRequest(f.s, admin, &golfv1.GetInstanceRunnersRequest{})
	r, err := f.s.GetInstanceRunners(ctx, list)
	if err != nil || len(r.Msg.Runners) != 1 || r.Msg.Runners[0].Version != "0" || r.Msg.Runners[0].RecentConnection {
		t.Fatal("initial", err)
	}
	update := func(version string, state golfv1.RunnerControlState, password string) (*connect.Response[golfv1.UpdateRunnerControlResponse], error) {
		req, ctx := runnerControlRequest(f.s, admin, &golfv1.UpdateRunnerControlRequest{WorkerId: "worker", ExpectedVersion: version, State: state, CurrentPassword: password})
		return f.s.UpdateRunnerControl(ctx, req)
	}
	if _, err = update("0", golfv1.RunnerControlState_RUNNER_CONTROL_STATE_DRAINING, "wrong password"); err == nil {
		t.Fatal("password bypass")
	}
	r1, err := update("0", golfv1.RunnerControlState_RUNNER_CONTROL_STATE_DRAINING, localTestPassword)
	if err != nil || r1.Msg.Runner.Version != "1" {
		t.Fatal("drain", err)
	}
	if _, err = update("0", golfv1.RunnerControlState_RUNNER_CONTROL_STATE_REVOKED, localTestPassword); connect.CodeOf(err) != connect.CodeAborted {
		t.Fatal("stale CAS", err)
	}
	if _, err = update("1", golfv1.RunnerControlState_RUNNER_CONTROL_STATE_ACTIVE, localTestPassword); err != nil {
		t.Fatal("resume", err)
	}
	if _, err = update("2", golfv1.RunnerControlState_RUNNER_CONTROL_STATE_REVOKED, localTestPassword); err != nil {
		t.Fatal("revoke", err)
	}
	if _, err = update("3", golfv1.RunnerControlState_RUNNER_CONTROL_STATE_ACTIVE, localTestPassword); err == nil {
		t.Fatal("revocation erased")
	}
	var count int
	if err = f.db.QueryRow(`SELECT count(*) FROM golf_runner_control_audit`).Scan(&count); err != nil || count != 3 {
		t.Fatal("audit", count, err)
	}
	restarted, e := New(f.s.config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	restarted.runnerKeys = f.s.runnerKeys
	req, ctx := runnerControlRequest(restarted, admin, &golfv1.GetInstanceRunnersRequest{})
	after, e := restarted.GetInstanceRunners(ctx, req)
	if e != nil || after.Msg.Runners[0].State != golfv1.RunnerControlState_RUNNER_CONTROL_STATE_REVOKED || after.Msg.Runners[0].Version != "3" {
		t.Fatal("restart cleared durable control", e)
	}
	if _, e = f.db.Exec(`DELETE FROM golf_runner_controls`); e == nil {
		t.Fatal("terminal row erased")
	}
}
func TestRunnerControlTransportDrainRevokePostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	dispatched, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	call := func(method, path, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Golf-Runner-ID", "fixture")
		r.Header.Set("Authorization", "Bearer "+key)
		if token != "" {
			r.Header.Set("Golf-Attempt-Token", token)
		}
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		return w
	}
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture", IsInstanceAdmin: true}); e != nil {
		t.Fatal(e)
	}
	admin, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	set := func(next string) {
		tx, e := f.server.db.BeginTx(t.Context(), nil)
		if e != nil {
			t.Fatal(e)
		}
		_, v, e := f.server.runnerControl(t.Context(), tx, "fixture")
		tx.Rollback()
		if e != nil {
			t.Fatal(e)
		}
		req, ctx := runnerControlRequest(f.server, admin, &golfv1.UpdateRunnerControlRequest{WorkerId: "fixture", ExpectedVersion: strconv.FormatInt(v, 10), State: runnerControlWire(next), CurrentPassword: localTestPassword})
		if _, e = f.server.UpdateRunnerControl(ctx, req); e != nil {
			t.Fatal("actual control", e)
		}
	}
	set("draining")
	if r := call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`); r.Code != 204 {
		t.Fatal("drain claimed", r.Code)
	}
	run, e := f.server.loadWorkflowRun(t.Context(), dispatched.Msg.Run.Id)
	if e != nil || run.State != "queued" {
		t.Fatal("drain cancelled queued", e)
	}
	set("active")
	r := call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if r.Code != 200 {
		t.Fatal("claim", r.Code)
	}
	var lease struct {
		AttemptID    string `json:"attemptId"`
		AttemptToken string `json:"attemptToken"`
	}
	if e = json.Unmarshal(r.Body.Bytes(), &lease); e != nil {
		t.Fatal(e)
	}
	set("draining")
	prefix := "/internal/ci/attempt/" + lease.AttemptID
	for _, action := range []struct{ method, suffix, body string }{{"GET", "source", ""}, {"POST", "heartbeat", "{}"}, {"POST", "logs", `{"sequence":1,"text":"owned log"}`}, {"POST", "finish", `{"exitCode":0}`}} {
		r := call(action.method, prefix+"/"+action.suffix, lease.AttemptToken, action.body)
		if r.Code != 200 && r.Code != 204 {
			t.Fatal("draining active attempt denied", action.suffix, r.Code)
		}
	}
	set("active")
	next, e := f.dispatch(t, "12345678-1234-4234-8234-123456789abd")
	if e != nil {
		t.Fatal(e)
	}
	r = call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if r.Code != 200 {
		t.Fatal(r.Code)
	}
	json.Unmarshal(r.Body.Bytes(), &lease)
	prefix = "/internal/ci/attempt/" + lease.AttemptID
	set("revoked")
	for _, action := range []string{"source", "heartbeat", "logs", "finish"} {
		method := http.MethodPost
		if action == "source" {
			method = http.MethodGet
		}
		if r := call(method, prefix+"/"+action, lease.AttemptToken, "{}"); r.Code != 403 {
			t.Fatal("revoked accepted", action, r.Code)
		}
	}
	run, e = f.server.loadWorkflowRun(t.Context(), next.Msg.Run.Id)
	if e != nil || run.State != "cancelled" || len(run.LeaseTokenHash) != 0 {
		t.Fatal("cancel fence", e)
	}
	if r := call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`); r.Code != 204 {
		t.Fatal("revoked claim", r.Code)
	}
}
func TestRunnerControlLockSerializesClaimPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	if _, e := f.dispatch(t, "12345678-1234-4234-8234-123456789abc"); e != nil {
		t.Fatal(e)
	}
	tx, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if e = f.server.lockRunnerControl(t.Context(), tx, "fixture"); e != nil {
		t.Fatal(e)
	}
	started := make(chan struct{})
	result := make(chan int, 1)
	go func() {
		close(started)
		r := httptest.NewRequest("POST", "/internal/ci/poll", strings.NewReader(`{"capabilities":["golf.runner.job-limits.v1"]}`))
		r.Header.Set("Golf-Runner-ID", "fixture")
		r.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		result <- w.Code
	}()
	<-started
	select {
	case <-result:
		t.Fatal("claim bypassed worker lock")
	case <-time.After(50 * time.Millisecond):
	}
	if _, e = tx.Exec(`INSERT INTO golf_runner_controls(forge_url,runner_id,state,version) VALUES($1,'fixture','revoked',1)`, f.server.config.GiteaURL); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	select {
	case code := <-result:
		if code != 204 {
			t.Fatal(code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("claim did not resume")
	}
	var n int
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs WHERE state='running'`).Scan(&n); e != nil || n != 0 {
		t.Fatal("claim resurrected", n, e)
	}
}
func TestRunnerControlCredentialDeclinesDelegation(t *testing.T) {
	for _, local := range []bool{false, true} {
		ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Token: "private", Local: local})
		if local {
			ctx = context.WithValue(ctx, apiAuthKey{}, apiAuth{})
		}
		if _, e := runnerControlCredential(ctx); connect.CodeOf(e) != connect.CodePermissionDenied {
			t.Fatal("delegation accepted", e)
		}
	}
}

func TestRunnerControlRepositoryBindingPoliciesPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	// The shared repository read guard requires the native canonical link.
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	f.enable(t)
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture"}); e != nil {
		t.Fatal(e)
	}
	local, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	input := &golfv1.GetRepositoryRunnersRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: strconv.FormatInt(f.row.ID, 10), OwnerId: strconv.FormatInt(f.row.Owner.ID, 10), WorkflowPath: runWorkflowPath}
	req, ctx := runnerControlRequest(f.server, local, input)
	response, e := f.server.GetRepositoryRunners(ctx, req)
	if e != nil || response.Msg.RepositoryId != input.RepositoryId || response.Msg.OwnerId != input.OwnerId || response.Msg.WorkflowPath != runWorkflowPath || !response.Msg.ManualAllowed || len(response.Msg.Runners) != 1 {
		t.Fatal("bound current policies", e)
	}
	if _, e = f.server.db.Exec(`UPDATE golf_execution_policies SET mode='disabled',revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE scope='instance'`); e != nil {
		t.Fatal(e)
	}
	response, e = f.server.GetRepositoryRunners(ctx, req)
	if e != nil || response.Msg.ManualAllowed || response.Msg.PushAllowed {
		t.Fatal("higher ceiling bypassed", e)
	}
	input.OwnerId = "999"
	if response, e = f.server.GetRepositoryRunners(ctx, req); e == nil || response != nil {
		t.Fatal("wrong native owner returned inventory")
	}
	input.OwnerId = strconv.FormatInt(f.row.Owner.ID, 10)
	input.RepositoryId = "999"
	if response, e = f.server.GetRepositoryRunners(ctx, req); e == nil || response != nil {
		t.Fatal("wrong native repository returned inventory")
	}
	input.RepositoryId = strconv.FormatInt(f.row.ID, 10)
	f.mu.Lock()
	f.denied = true
	f.mu.Unlock()
	if response, e = f.server.GetRepositoryRunners(ctx, req); e == nil || response != nil {
		t.Fatal("current native revocation returned inventory")
	}
}
