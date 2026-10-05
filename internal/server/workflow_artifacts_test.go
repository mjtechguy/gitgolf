package server

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/go-chi/chi/v5"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestWorkflowArtifactsUploadFinishDownloadAndPrivacyPostgres(t *testing.T) {
	for _, outcome := range []string{"success", "cancelled", "revoked"} {
		t.Run(outcome, func(t *testing.T) {
			f := newWorkflowRunFixture(t, ".gitlab-ci.yml")
			f.enable(t)
			f.workflow = []byte("build:\n  image: example/build@sha256:" + strings.Repeat("b", 64) + "\n  script: mkdir -p dist; printf built > dist/result.html\n  artifacts:\n    paths: [dist]\n")
			dispatched, err := f.server.DispatchWorkflow(f.context(t), workflowRunRequest(f, &golfv1.DispatchWorkflowRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, WorkflowPath: ".gitlab-ci.yml", IdempotencyKey: "12345678-1234-4234-8234-123456789abc"}))
			if err != nil {
				t.Fatal("actual compiler/admission refused", err)
			}
			key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
			var lease struct {
				RunID         string   `json:"runId"`
				AttemptID     string   `json:"attemptId"`
				AttemptToken  string   `json:"attemptToken"`
				ArtifactPaths []string `json:"artifactPaths"`
			}
			call := func(action string, body []byte, secure bool) *httptest.ResponseRecorder {
				req := httptest.NewRequest("POST", "/internal/ci/attempt/"+lease.AttemptID+"/"+action, bytes.NewReader(body))
				req.Header.Set("Golf-Runner-ID", "fixture")
				req.Header.Set("Authorization", "Bearer "+key)
				if secure {
					req.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
				}
				if action != "poll" {
					req.Header.Set("Golf-Attempt-Token", lease.AttemptToken)
				}
				rec := httptest.NewRecorder()
				if action == "poll" {
					f.server.runnerPoll(rec, req)
				} else {
					route := chi.NewRouteContext()
					route.URLParams.Add("id", lease.AttemptID)
					req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
					f.server.runnerAttempt(rec, req)
				}
				return rec
			}
			if got := call("poll", []byte(`{"capabilities":["golf.runner.job-limits.v1"]}`), true); got.Code != 204 {
				t.Fatal("old worker adopted artifact source", got.Code)
			}
			if got := call("poll", []byte(`{"capabilities":["golf.runner.job-limits.v1","golf.workflow.shell.artifacts.v1"]}`), false); got.Code != 204 {
				t.Fatal("HTTP worker adopted artifact source", got.Code)
			}
			poll := call("poll", []byte(`{"capabilities":["golf.runner.job-limits.v1","golf.workflow.shell.artifacts.v1"]}`), true)
			if poll.Code != 200 || json.Unmarshal(poll.Body.Bytes(), &lease) != nil || len(lease.ArtifactPaths) != 1 || lease.RunID != dispatched.Msg.Run.Id {
				t.Fatal("claim binding failed", poll.Code)
			}
			archive, _, _, err := runner.NormalizeArtifactArchive(workflowRunTar(t, []*tar.Header{{Name: "dist/result.html", Typeflag: tar.TypeReg}}, [][]byte{[]byte("<html>owned output</html>")}), []string{"dist"})
			if err != nil {
				t.Fatal(err)
			}
			if got := call("artifact", archive, true); got.Code != 409 {
				t.Fatal("uploaded before maintained completion", got.Code)
			}
			for _, body := range []string{`{"sequence":1,"stepIndex":0,"kind":"started"}`, `{"sequence":2,"stepIndex":0,"kind":"finished","exitCode":0}`} {
				if got := call("progress", []byte(body), true); got.Code != 204 {
					t.Fatal("progress", got.Code)
				}
			}
			if got := call("finish", []byte(`{"exitCode":0}`), true); got.Code != 409 {
				t.Fatal("success without artifact accepted", got.Code)
			}
			if got := call("artifact", archive, false); got.Code != 403 {
				t.Fatal("artifact plaintext ingress", got.Code)
			}
			if got := call("artifact", archive, true); got.Code != 204 {
				t.Fatal("artifact upload", got.Code)
			}
			if got := call("artifact", archive, true); got.Code != 204 {
				t.Fatal("same upload not idempotent", got.Code)
			}
			changed, _, _, _ := runner.NormalizeArtifactArchive(workflowRunTar(t, []*tar.Header{{Name: "dist/result.html", Typeflag: tar.TypeReg}}, [][]byte{[]byte("changed")}), []string{"dist"})
			if got := call("artifact", changed, true); got.Code != 409 {
				t.Fatal("artifact overwrite", got.Code)
			}
			get := func() (*connect.Response[golfv1.GetWorkflowArtifactResponse], error) {
				return f.server.GetWorkflowArtifact(f.context(t), workflowRunRequest(f, &golfv1.GetWorkflowArtifactRequest{RunId: lease.RunID}))
			}
			if before, err := get(); err != nil || before.Msg.Artifact != nil {
				t.Fatal("unconfirmed result published", err)
			}
			if outcome == "revoked" {
				f.mu.Lock()
				f.denied = true
				f.mu.Unlock()
				if got := call("finish", []byte(`{"exitCode":0}`), true); got.Code != 403 {
					t.Fatal("revoked result accepted", got.Code)
				}
				if _, err := get(); connect.CodeOf(err) != connect.CodeNotFound {
					t.Fatal("revoked artifact details leaked", err)
				}
				return
			}
			finish := `{"exitCode":0}`
			if outcome == "cancelled" {
				finish = `{"exitCode":0,"cancelled":true}`
			}
			if got := call("finish", []byte(finish), true); got.Code != 204 {
				t.Fatal("finish", got.Code)
			}
			metadata, err := get()
			if err != nil {
				t.Fatal(err)
			}
			if outcome == "cancelled" {
				if metadata.Msg.Artifact != nil {
					t.Fatal("cancelled upload published")
				}
				return
			}
			a := metadata.Msg.Artifact
			if a == nil || a.AttemptId != lease.AttemptID || a.RepositoryId != dispatched.Msg.Run.RepositoryId || a.SourceSha256 != dispatched.Msg.Run.SourceSha256 || a.FileCount != 1 {
				t.Fatal("missing exact publication receipt")
			}
			if _, err := f.server.db.Exec(`UPDATE golf_workflow_artifacts SET archive='replacement' WHERE run_id=$1`, lease.RunID); err == nil {
				t.Fatal("immutable output overwritten")
			}
			request := httptest.NewRequest("GET", a.DownloadPath, nil)
			request.Header.Set("Cookie", cookieName+"="+f.session.Value)
			route := chi.NewRouteContext()
			route.URLParams.Add("id", lease.RunID)
			request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
			rec := httptest.NewRecorder()
			f.server.WorkflowArtifactDownloadHandler()(rec, request)
			if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), archive) || rec.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") || rec.Header().Get("Cache-Control") != "no-store" || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
				t.Fatal("private attachment boundary failed", rec.Code)
			}
			request.Header.Set("Authorization", "Bearer forbidden")
			rec = httptest.NewRecorder()
			f.server.WorkflowArtifactDownloadHandler()(rec, request)
			if rec.Code != 403 || bytes.Equal(rec.Body.Bytes(), archive) {
				t.Fatal("delegated attachment access")
			}
		})
	}
}
