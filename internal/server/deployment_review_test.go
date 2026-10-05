package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func TestStaticDeploymentIndependentReviewAndParentExpiryPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t, ".gitlab-ci.yml")
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	upstream, _ := url.Parse(f.server.config.GiteaURL)
	const bobToken = "preview-bob-fixture"
	bob := User{ID: 43, Login: "bob"}
	var denyBob atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		second := r.Header.Get("Authorization") == "token "+bobToken || r.Header.Get("Authorization") == "Bearer "+bobToken
		w.Header().Set("Content-Type", "application/json")
		if second && denyBob.Load() {
			w.WriteHeader(403)
			return
		}
		if second && r.URL.Path == "/api/v1/user" {
			json.NewEncoder(w).Encode(bob)
			return
		}
		if r.URL.Path == "/api/v1/users/bob" {
			json.NewEncoder(w).Encode(bob)
			return
		}
		if r.URL.Path == "/api/v1/users/search" && r.URL.Query().Get("q") == "bob" {
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{bob}})
			return
		}
		if second && r.URL.Path == "/api/v1/repos/alice/example/collaborators/bob/permission" {
			json.NewEncoder(w).Encode(map[string]any{"permission": "read", "user": bob})
			return
		}
		if second && r.URL.Path == "/api/v1/repos/alice/example/collaborators/bob" {
			w.WriteHeader(204)
			return
		}
		req := r.Clone(r.Context())
		req.URL.Scheme, req.URL.Host = upstream.Scheme, upstream.Host
		req.Host, req.RequestURI = upstream.Host, ""
		req.Header = r.Header.Clone()
		if second {
			req.Header.Set("Authorization", "token run-fixture")
		}
		resp, e := http.DefaultTransport.RoundTrip(req)
		if e != nil {
			w.WriteHeader(502)
			return
		}
		defer resp.Body.Close()
		for k, v := range resp.Header {
			w.Header()[k] = v
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	}))
	t.Cleanup(provider.Close)
	config := f.server.config
	config.GiteaURL = provider.URL
	var e error
	f.server, e = New(config, f.server.db)
	if e != nil {
		t.Fatal(e)
	}
	for _, actor := range []struct{ name, token string }{{"alice", "run-fixture"}, {"bob", bobToken}} {
		if _, e = ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, config.GiteaURL, "create", LocalAccountInput{Username: actor.name, Password: localTestPassword, ForgeToken: actor.token}); e != nil {
			t.Fatal("supportedactorenrollment", e)
		}
	}
	alice, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	reviewer, e := f.server.loginLocalSession(t.Context(), "bob", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	f.server.config.PublicURL = "https://golf.localhost"
	f.server.config.AllowInsecureCookies = false
	f.server.preview = &previewConfiguration{origin: "https://preview.localhost:8444", fingerprint: strings.Repeat("f", 64)}
	f.server.previewBound.Store(true)
	artifact := previewQualifiedArtifact(t, f, alice)
	a := runnerPlacementFixture(t, f, alice)
	target := &golfv1.RepositoryEnvironmentTarget{Repository: a.Repository, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, AccessRevision: a.ExpectedRevision}
	envInput := environmentInput(target)
	envInput.Policy.RequiredApprovals = 1
	envInput.Policy.Reviewers = []*golfv1.RepositoryEnvironmentReviewer{{Id: "43", Login: "bob"}}
	env, e := environmentSave(t, f, alice, envInput)
	if e != nil {
		t.Fatal(e)
	}
	prepare, c := environmentRequest(f, alice, &golfv1.PrepareStaticDeploymentRequest{Target: target, RunId: artifact.RunId})
	p, e := f.server.PrepareStaticDeployment(c, prepare)
	if e != nil {
		t.Fatal(e)
	}
	input := &golfv1.CreateRepositoryDeploymentRequest{Target: target, DeploymentId: uuid.NewString(), RunId: artifact.RunId, AttemptId: artifact.AttemptId, CommitId: artifact.CommitId, ArchiveSha256: artifact.ArchiveSha256, ManifestSha256: p.Msg.ManifestSha256, EnvironmentId: env.Environment.Id, EnvironmentVersion: env.Environment.Version, Source: &golfv1.RepositorySourceSelector{Kind: 4, Name: artifact.CommitId}, StaticRoot: "dist", TargetFingerprint: p.Msg.TargetFingerprint, CurrentPassword: localTestPassword}
	create, c := environmentRequest(f, alice, input)
	first, e := f.server.createRepositoryDeployment(c, create)
	if e != nil || first.Msg.Deployment.CanActivate {
		t.Fatal("unreviewedadmission", e)
	}
	selected := &golfv1.RepositoryDeploymentRequest{Target: target, DeploymentId: input.DeploymentId}
	activate, c := environmentRequest(f, alice, selected)
	if _, e = f.server.activateRepositoryDeployment(c, activate); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("approvalnotrequired", e)
	}
	decision := &golfv1.ReviewRepositoryDeploymentRequest{Target: target, DeploymentId: input.DeploymentId, OperationId: uuid.NewString(), Approve: true}
	self, c := environmentRequest(f, alice, decision)
	if _, e = f.server.reviewRepositoryDeployment(c, self); connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("selfapproval", e)
	}
	review, c := environmentRequest(f, reviewer, decision)
	approved, e := f.server.reviewRepositoryDeployment(c, review)
	if e != nil || len(approved.Msg.Deployment.Approvals) != 1 || !approved.Msg.Deployment.Approvals[0].Approved {
		t.Fatal("independentreview", e)
	}
	if _, e = f.server.reviewRepositoryDeployment(c, review); e != nil {
		t.Fatal("decisionreplay", e)
	}
	changed := proto.Clone(decision).(*golfv1.ReviewRepositoryDeploymentRequest)
	changed.Approve = false
	request, c := environmentRequest(f, reviewer, changed)
	if _, e = f.server.reviewRepositoryDeployment(c, request); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("changeddecisionkey", e)
	}
	activate, c = environmentRequest(f, alice, selected)
	if ready, e := f.server.activateRepositoryDeployment(c, activate); e != nil || !ready.Msg.Deployment.CanOpen {
		t.Fatal("approvedactivation", e)
	}
	denyBob.Store(true)
	get, c := environmentRequest(f, alice, selected)
	denied, e := f.server.getRepositoryDeployment(c, get)
	if e != nil || denied.Msg.Deployment.CanOpen {
		t.Fatal("reviewercurrentdenialignored", e)
	}
	denyBob.Store(false)
	if e = f.server.logoutSession(t.Context(), reviewer.Value); e != nil {
		t.Fatal(e)
	}
	denied, e = f.server.getRepositoryDeployment(c, get)
	if e != nil || denied.Msg.Deployment.CanOpen {
		t.Fatal("revokedreviewersessionignored", e)
	}
}
