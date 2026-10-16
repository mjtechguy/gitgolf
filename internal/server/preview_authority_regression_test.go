package server

import (
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func TestStaticDeploymentMismatchedTargetErrorMapping(t *testing.T) {
	target := &golfv1.RepositoryEnvironmentTarget{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "1", OwnerId: "2", AccessRevision: strings.Repeat("a", 64)}
	d := &deploymentRecord{wire: &golfv1.RepositoryDeployment{Target: proto.Clone(target).(*golfv1.RepositoryEnvironmentTarget)}}
	d.wire.Target.RepositoryId = "3"
	s := &Server{}
	if v, e := s.deploymentResponse(t.Context(), "", forgeCredential{}, target, d); v != nil || connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("private target mismatch lost its wire denial", v, e)
	}
}

func TestStaticPreviewRejectsGolfCookiesBeforeRedemption(t *testing.T) {
	s := &Server{preview: &previewConfiguration{origin: "https://preview.localhost:8444"}, previewRequests: make(chan struct{}, 8)}
	s.previewBound.Store(true)
	for _, name := range []string{cookieName, "__Host-golf_session"} {
		for _, route := range []struct{ method, path string }{{"GET", "/"}, {"POST", "/__golf/auth"}} {
			r := httptest.NewRequest(route.method, "https://"+uuid.NewString()+".preview.localhost:8444"+route.path, strings.NewReader("grant=not-disclosed"))
			r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
			r.Header.Set("Origin", "https://golf.localhost")
			r.AddCookie(&http.Cookie{Name: name, Value: "control-plane-cookie"})
			w := httptest.NewRecorder()
			// A nil database makes reaching record lookup a failing check: denial
			// must precede both deployment inspection and launch redemption.
			s.PreviewHandler().ServeHTTP(w, r)
			if w.Code != http.StatusNotFound || len(w.Result().Cookies()) != 0 || strings.Contains(w.Body.String(), "not-disclosed") {
				t.Fatal("control-plane cookie reached preview", name, route.path, w.Code)
			}
		}
	}
}

func TestStaticDeploymentConcurrentAffirmativeReviewPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t, ".gitlab-ci.yml")
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	users := map[string]User{"preview-bob": {ID: 43, Login: "bob"}, "preview-carol": {ID: 44, Login: "carol"}}
	underlying := f.server.client.Transport
	if underlying == nil {
		underlying = http.DefaultTransport
	}
	var afterSnapshot func()
	f.server.client.Transport = environmentRoundTripper(func(r *http.Request) (*http.Response, error) {
		if afterSnapshot != nil && r.URL.Path == "/api/v1/user" && strings.HasSuffix(r.Header.Get("Authorization"), "run-fixture") {
			change := afterSnapshot
			afterSnapshot = nil
			change()
		}
		w := httptest.NewRecorder()
		w.Header().Set("Content-Type", "application/json")
		respond := func(v any) (*http.Response, error) {
			if e := json.NewEncoder(w).Encode(v); e != nil {
				return nil, e
			}
			return w.Result(), nil
		}
		for token, user := range users {
			actor := strings.HasSuffix(r.Header.Get("Authorization"), token)
			if actor && r.URL.Path == "/api/v1/user" || r.URL.Path == "/api/v1/users/"+user.Login {
				return respond(user)
			}
			if r.URL.Path == "/api/v1/users/search" && r.URL.Query().Get("q") == user.Login {
				return respond(map[string]any{"ok": true, "data": []User{user}})
			}
			if r.URL.Path == "/api/v1/repos/alice/example/collaborators/"+user.Login+"/permission" {
				return respond(map[string]any{"permission": "read", "user": user})
			}
			if r.URL.Path == "/api/v1/repos/alice/example/collaborators/"+user.Login {
				w.WriteHeader(http.StatusNoContent)
				return w.Result(), nil
			}
			if actor {
				r = r.Clone(r.Context())
				r.Header = r.Header.Clone()
				r.Header.Set("Authorization", "token run-fixture")
			}
		}
		return underlying.RoundTrip(r)
	})
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.ForgeURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture"}); e != nil {
		t.Fatal(e)
	}
	alice, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	bob, e := f.server.createSession(t.Context(), users["preview-bob"], "pat", "preview-bob", "")
	if e != nil {
		t.Fatal(e)
	}
	carol, e := f.server.createSession(t.Context(), users["preview-carol"], "pat", "preview-carol", "")
	if e != nil {
		t.Fatal(e)
	}
	f.server.config.PublicURL = "https://golf.localhost"
	f.server.config.AllowInsecureCookies = false
	f.server.preview = &previewConfiguration{origin: "https://preview.localhost:8444", fingerprint: strings.Repeat("f", 64)}
	f.server.previewBound.Store(true)
	a := previewQualifiedArtifact(t, f, alice)
	access := runnerPlacementFixture(t, f, alice)
	target := &golfv1.RepositoryEnvironmentTarget{Repository: access.Repository, RepositoryId: access.RepositoryId, OwnerId: access.OwnerId, AccessRevision: access.ExpectedRevision}
	envInput := environmentInput(target)
	envInput.Policy.RequiredApprovals = 1
	envInput.Policy.Reviewers = []*golfv1.RepositoryEnvironmentReviewer{{Id: "43", Login: "bob"}, {Id: "44", Login: "carol"}}
	env, e := environmentSave(t, f, alice, envInput)
	if e != nil {
		t.Fatal(e)
	}
	prepare, ctx := environmentRequest(f, alice, &golfv1.PrepareStaticDeploymentRequest{Target: target, RunId: a.RunId})
	p, e := f.server.PrepareStaticDeployment(ctx, prepare)
	if e != nil {
		t.Fatal(e)
	}
	input := &golfv1.CreateRepositoryDeploymentRequest{Target: target, DeploymentId: uuid.NewString(), RunId: a.RunId, AttemptId: a.AttemptId, CommitId: a.CommitId, ArchiveSha256: a.ArchiveSha256, ManifestSha256: p.Msg.ManifestSha256, EnvironmentId: env.Environment.Id, EnvironmentVersion: env.Environment.Version, Source: &golfv1.RepositorySourceSelector{Kind: 4, Name: a.CommitId}, StaticRoot: "dist", TargetFingerprint: p.Msg.TargetFingerprint, CurrentPassword: localTestPassword}
	create, ctx := environmentRequest(f, alice, input)
	if _, e = f.server.createRepositoryDeployment(ctx, create); e != nil {
		t.Fatal(e)
	}
	wrong := proto.Clone(target).(*golfv1.RepositoryEnvironmentTarget)
	wrong.Repository.Name = "replacement"
	activate, ctx := environmentRequest(f, alice, &golfv1.ActivateRepositoryDeploymentRequest{Target: wrong, DeploymentId: input.DeploymentId})
	if _, e := f.server.ActivateRepositoryDeployment(ctx, activate); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("public activation target error mapping", e)
	}
	wrong = proto.Clone(target).(*golfv1.RepositoryEnvironmentTarget)
	wrong.RepositoryId = "999999"
	get, ctx := environmentRequest(f, alice, &golfv1.GetRepositoryDeploymentRequest{Target: wrong, DeploymentId: input.DeploymentId})
	if _, e := f.server.GetRepositoryDeployment(ctx, get); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("public inspection target error mapping", e)
	}
	review, ctx := environmentRequest(f, bob, &golfv1.ReviewRepositoryDeploymentRequest{Target: wrong, DeploymentId: input.DeploymentId, OperationId: uuid.NewString(), Approve: true})
	if _, e := f.server.ReviewRepositoryDeployment(ctx, review); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("public review target error mapping", e)
	}
	approve := func(session loginResult) {
		r, ctx := environmentRequest(f, session, &golfv1.ReviewRepositoryDeploymentRequest{Target: target, DeploymentId: input.DeploymentId, OperationId: uuid.NewString(), Approve: true})
		if _, e := f.server.reviewRepositoryDeployment(ctx, r); e != nil {
			t.Fatal(e)
		}
	}
	approve(bob)
	d, e := f.server.deploymentRecord(t.Context(), input.DeploymentId)
	if e != nil {
		t.Fatal(e)
	}
	changed := false
	afterSnapshot = func() {
		// This supported review commits after the fence's initial review read,
		// before it acquires the repository/environment lock. Its parent then
		// logs out, so the earlier quorum must not bypass this new approval.
		approve(carol)
		if e := f.server.logoutSession(t.Context(), carol.Value); e != nil {
			t.Fatal(e)
		}
		changed = true
	}
	h, _ := sessionHash(alice.Value)
	executed := false
	e = f.server.deploymentFence(t.Context(), d, h, 42, func(_ *sql.Tx, _ *deploymentRecord, _ time.Time) error {
		executed = true
		return nil
	})
	if !changed || executed || !errors.Is(e, errDeployment) {
		t.Fatal("new affirmative authority was not fenced", changed, executed, e)
	}
}
