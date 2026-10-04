package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunnerEnrollmentBoundary(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	image := "alpine@sha256:" + strings.Repeat("a", 64)
	keys, _ := json.Marshal(map[string]string{"worker-1": key})
	images, _ := json.Marshal(map[string]string{"linux": image})
	s := &Server{config: Config{RunnerKeysJSON: string(keys), RunnerImagesJSON: string(images)}}
	if err := s.configureRunners(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "http://localhost/internal/ci/poll", strings.NewReader("{}"))
	r.Header.Set("Golf-Runner-ID", "worker-1")
	r.Header.Set("Authorization", "Bearer "+key)
	if id, ok := s.enrolledRunner(r); !ok || id != "worker-1" {
		t.Fatal("enrolled worker rejected")
	}
	r.Header.Add("Authorization", "Bearer "+key)
	if _, ok := s.enrolledRunner(r); ok {
		t.Fatal("duplicate authorization accepted")
	}
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("b", 43))
	if _, ok := s.enrolledRunner(r); ok {
		t.Fatal("wrong key accepted")
	}
	if imageGot, err := s.executionImage(&workflowExecutionPlan{RunnerLabel: "linux"}); err != nil || imageGot != image {
		t.Fatal("approved label mapping rejected")
	}
	if _, err := s.executionImage(&workflowExecutionPlan{RunnerLabel: "ubuntu-latest"}); err == nil {
		t.Fatal("unapproved runner label mapped")
	}
	if _, err := s.executionImage(&workflowExecutionPlan{ImageDigest: "alpine@sha256:" + strings.Repeat("b", 64)}); err == nil {
		t.Fatal("unapproved digest accepted")
	}
	for _, config := range []Config{{RunnerKeysJSON: string(keys)}, {RunnerKeysJSON: `{"worker":"short"}`, RunnerImagesJSON: string(images)}, {RunnerKeysJSON: string(keys), RunnerImagesJSON: `{"linux":"alpine:latest"}`}} {
		if (&Server{config: config}).configureRunners() == nil {
			t.Fatal("invalid operator config accepted")
		}
	}
	expected := sha256.Sum256([]byte(key))
	if s.runnerKeys["worker-1"] != expected {
		t.Fatal("enrollment key stored unhashed")
	}
}
func TestRunnerRequestBounds(t *testing.T) {
	for _, body := range []string{`{"extra":1}`, `{} {}`, strings.Repeat(" ", 200) + `{}`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		var input struct{}
		if runnerDecode(w, r, &input, 128) {
			t.Fatal("invalid runner body accepted")
		}
	}
	if runnerLogText("a\x00b") || runnerLogText(string([]byte{0xff})) {
		t.Fatal("invalid PostgreSQL log text accepted")
	}
	if !runnerLogText("safe\n\x1b[31mterminal text") {
		t.Fatal("valid log text rejected")
	}
}

func TestRunnerLeasesResultsAndRevocationPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	dispatch, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	call := func(method, route, capability, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, route, strings.NewReader(body))
		request.Header.Set("Golf-Runner-ID", "fixture")
		request.Header.Set("Authorization", "Bearer "+key)
		if capability != "" {
			request.Header.Set("Golf-Attempt-Token", capability)
		}
		response := httptest.NewRecorder()
		f.server.ServeHTTP(response, request)
		return response
	}
	poll := call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if poll.Code != 200 {
		t.Fatalf("poll: %d %s", poll.Code, poll.Body.String())
	}
	var lease struct {
		RunID        string `json:"runId"`
		AttemptID    string `json:"attemptId"`
		AttemptToken string `json:"attemptToken"`
	}
	if json.Unmarshal(poll.Body.Bytes(), &lease) != nil || lease.RunID != dispatch.Msg.Run.Id || !attemptIdentifier.MatchString(lease.AttemptID) {
		t.Fatal("assignment missing immutable run/attempt")
	}
	prefix := "/internal/ci/attempt/" + lease.AttemptID
	if got := call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`); got.Code != 204 {
		t.Fatal("duplicate poll reassigned busy worker", got.Code)
	}
	if got := call("GET", prefix+"/source", base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32)), ""); got.Code != 403 {
		t.Fatal("wrong attempt capability accepted")
	}
	source := call("GET", prefix+"/source", lease.AttemptToken, "")
	if source.Code != 200 || len(source.Body.Bytes()) == 0 || source.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("source fetch failed", source.Code)
	}
	for _, body := range []string{`{"sequence":1,"text":"hello\n"}`, `{"sequence":1,"text":"hello\n"}`, `{}`} {
		suffix := "logs"
		if body == "{}" {
			suffix = "heartbeat"
		}
		if got := call("POST", prefix+"/"+suffix, lease.AttemptToken, body); got.Code != 204 {
			t.Fatal("log replay/heartbeat failed", suffix, got.Code)
		}
	}
	if got := call("POST", prefix+"/logs", lease.AttemptToken, `{"sequence":1,"text":"different"}`); got.Code != 409 {
		t.Fatal("log replay changed payload")
	}
	if got := call("POST", prefix+"/logs", lease.AttemptToken, `{"sequence":3,"text":"gap"}`); got.Code != 409 {
		t.Fatal("log sequence gap accepted")
	}
	if got := call("POST", prefix+"/finish", lease.AttemptToken, `{"exitCode":0}`); got.Code != 204 {
		t.Fatal("finish failed", got.Code)
	}
	status, err := f.server.loadWorkflowRun(t.Context(), lease.RunID)
	if err != nil || status.State != "succeeded" || len(status.LeaseTokenHash) != 0 || status.LogBytes != 6 {
		t.Fatal("finish/provenance did not persist", err)
	}
	if got := call("POST", prefix+"/finish", lease.AttemptToken, `{"exitCode":0}`); got.Code != 403 {
		t.Fatal("completed capability accepted stale result")
	}
	next, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abd")
	if err != nil {
		t.Fatal(err)
	}
	poll = call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if poll.Code != 200 {
		t.Fatal("second assignment failed", poll.Code)
	}
	json.Unmarshal(poll.Body.Bytes(), &lease)
	prefix = "/internal/ci/attempt/" + lease.AttemptID
	if _, err = f.server.db.Exec(`UPDATE golf_execution_policies SET revocation_epoch=revocation_epoch+1,revision=revision+1 WHERE scope='repository'`); err != nil {
		t.Fatal(err)
	}
	if got := call("POST", prefix+"/finish", lease.AttemptToken, `{"exitCode":0}`); got.Code != 403 {
		t.Fatal("revoked policy accepted green result", got.Code)
	}
	status, err = f.server.loadWorkflowRun(t.Context(), next.Msg.Run.Id)
	if err != nil || status.State != "cancelled" {
		t.Fatal("revoked run not fenced", err)
	}
	f.enable(t)
	third, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abe")
	if err != nil {
		t.Fatal(err)
	}
	poll = call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if poll.Code != 200 {
		t.Fatal("third assignment failed", poll.Code)
	}
	json.Unmarshal(poll.Body.Bytes(), &lease)
	prefix = "/internal/ci/attempt/" + lease.AttemptID
	if _, err = f.server.db.Exec(`UPDATE golf_workflow_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, third.Msg.Run.Id); err != nil {
		t.Fatal(err)
	}
	if got := call("POST", prefix+"/finish", lease.AttemptToken, `{"exitCode":0}`); got.Code != 403 {
		t.Fatal("expired lease result accepted")
	}
	if got := call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`); got.Code != 204 {
		t.Fatal("lost attempt auto-replayed")
	}
	status, err = f.server.loadWorkflowRun(t.Context(), third.Msg.Run.Id)
	if err != nil || status.State != "lost" {
		t.Fatal("lease reaper failed", err)
	}
	fourth, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abf")
	if err != nil {
		t.Fatal(err)
	}
	poll = call("POST", "/internal/ci/poll", "", `{"capabilities":["golf.runner.job-limits.v1"]}`)
	if poll.Code != 200 {
		t.Fatal("fourth assignment failed", poll.Code)
	}
	json.Unmarshal(poll.Body.Bytes(), &lease)
	prefix = "/internal/ci/attempt/" + lease.AttemptID
	if got := call("POST", "/internal/ci/recover", "", "{}"); got.Code != 204 {
		t.Fatal("operator recovery failed", got.Code)
	}
	if got := call("POST", prefix+"/finish", lease.AttemptToken, `{"exitCode":0}`); got.Code != 403 {
		t.Fatal("recovered attempt reported success")
	}
	status, err = f.server.loadWorkflowRun(t.Context(), fourth.Msg.Run.Id)
	if err != nil || status.State != "lost" {
		t.Fatal("recovered run not lost", err)
	}
}
