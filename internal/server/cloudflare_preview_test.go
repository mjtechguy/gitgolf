package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestCloudflarePreviewConfiguration(t *testing.T) {
	oidc := oidcTestConfiguration(t, "https://golf.invalid")
	secret, _, _ := previewToken()
	original := cloudflarePreview{BaseURL: "https://previews.example.com", DeploymentID: uuid.NewString(), AccountID: strings.Repeat("a", 32), D1ID: uuid.NewString(), R2Bucket: "golf-preview-test", R2Created: time.Now().UTC().Format(time.RFC3339Nano), AccessAUD: strings.Repeat("b", 64), BrokerSecret: secret, ProbeClientID: "probe", ProbeClientSecret: "secret"}
	path := filepath.Join(t.TempDir(), "preview.json")
	load := func(v cloudflarePreview, issuer *accessOIDC) (*previewConfiguration, error) {
		t.Helper()
		raw, _ := json.Marshal(v)
		if e := os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
		return loadCloudflarePreview("https://golf.invalid", issuer, path)
	}
	initial, e := load(original, oidc)
	if e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*cloudflarePreview){
		func(v *cloudflarePreview) { v.BaseURL = "https://golf.invalid" },
		func(v *cloudflarePreview) { v.BaseURL = "https://preview.golf.invalid" },
		func(v *cloudflarePreview) { v.BaseURL = "http://previews.example.com" },
		func(v *cloudflarePreview) { v.BaseURL += "/path" },
		func(v *cloudflarePreview) { v.BaseURL += ":443" },
		func(v *cloudflarePreview) { v.DeploymentID = "invalid" },
		func(v *cloudflarePreview) { v.D1ID = "invalid" },
		func(v *cloudflarePreview) { v.AccountID = "invalid" },
		func(v *cloudflarePreview) { v.AccessAUD = "invalid" },
		func(v *cloudflarePreview) { v.BrokerSecret = "invalid" },
		func(v *cloudflarePreview) { v.R2Created = "invalid" },
		func(v *cloudflarePreview) { v.R2Bucket = "invalid/bucket" },
		func(v *cloudflarePreview) { v.ProbeClientSecret = "" },
		func(v *cloudflarePreview) { v.AccessReviewerEmail = "existing@example.com" },
		func(v *cloudflarePreview) { v.AccessReviewerNativeID = 42 },
		func(v *cloudflarePreview) {
			v.AccessReviewerNativeID = 42
			v.AccessReviewerEmail = "Name <existing@example.com>"
		},
	} {
		v := original
		mutate(&v)
		if _, e := load(v, oidc); e == nil {
			t.Fatal("accepted invalid preview configuration")
		}
	}
	if _, e := load(original, nil); e == nil {
		t.Fatal("missing identity provider")
	}
	external := original
	external.AccessReviewerNativeID = 42
	external.AccessReviewerEmail = "existing@example.com"
	mapped, e := load(external, oidc)
	if e != nil || mapped.fingerprint == initial.fingerprint || !mapped.cloudflare.matchesReviewer(42, "existing@example.com") || mapped.cloudflare.matchesReviewer(43, "existing@example.com") {
		t.Fatal("external reader binding")
	}
	replacement := original
	replacement.D1ID = uuid.NewString()
	changed, e := load(replacement, oidc)
	if e != nil || changed.fingerprint == initial.fingerprint {
		t.Fatal("resource replacement not fenced")
	}
	replacement = original
	replacement.BrokerSecret, _, _ = previewToken()
	changed, e = load(replacement, oidc)
	if e != nil || changed.fingerprint == initial.fingerprint {
		t.Fatal("secret rotation not fenced")
	}
}

type previewTransport func(*http.Request) (*http.Response, error)

func (f previewTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func cloudflarePreviewProducerFixture(t *testing.T) (*workflowRunFixture, loginResult, *golfv1.RepositoryEnvironmentTarget) {
	t.Helper()
	f := newWorkflowRunFixture(t, ".gitlab-ci.yml")
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture"}); e != nil {
		t.Fatal(e)
	}
	l, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	placement := runnerPlacementFixture(t, f, l)
	return f, l, &golfv1.RepositoryEnvironmentTarget{Repository: placement.Repository, RepositoryId: placement.RepositoryId, OwnerId: placement.OwnerId, AccessRevision: placement.ExpectedRevision}
}

func cloudflarePreviewFixture(t *testing.T) (*workflowRunFixture, loginResult, *golfv1.CreateRepositoryDeploymentRequest) {
	t.Helper()
	f, l, target := cloudflarePreviewProducerFixture(t)
	f.server.config.PublicURL = "https://golf.invalid"
	f.server.config.AllowInsecureCookies = false
	f.server.accessOIDC = oidcTestConfiguration(t, f.server.config.PublicURL)
	secret, _, _ := previewToken()
	f.server.preview = &previewConfiguration{origin: "https://previews.example.com", fingerprint: strings.Repeat("f", 64), cloudflare: &cloudflarePreview{DeploymentID: uuid.NewString(), BrokerSecret: secret, AccessAUD: strings.Repeat("a", 64), D1ID: uuid.NewString(), R2Bucket: "golf-preview-test", ProbeClientID: "probe", ProbeClientSecret: "machine-private"}}
	f.server.previewBound.Store(true)
	a := previewQualifiedArtifact(t, f, l)
	env, e := environmentSave(t, f, l, environmentInput(target))
	if e != nil {
		t.Fatal(e)
	}
	r, c := environmentRequest(f, l, &golfv1.PrepareStaticDeploymentRequest{Target: target, RunId: a.RunId})
	prep, e := f.server.PrepareStaticDeployment(c, r)
	if e != nil {
		t.Fatal(e)
	}
	if prep.Msg.ReservedDeploymentId != f.server.preview.cloudflare.DeploymentID {
		t.Fatal("reserved deployment identity")
	}
	input := &golfv1.CreateRepositoryDeploymentRequest{Target: target, DeploymentId: f.server.preview.cloudflare.DeploymentID, RunId: a.RunId, AttemptId: a.AttemptId, CommitId: a.CommitId, ArchiveSha256: a.ArchiveSha256, ManifestSha256: prep.Msg.ManifestSha256, EnvironmentId: env.Environment.Id, EnvironmentVersion: env.Environment.Version, Source: &golfv1.RepositorySourceSelector{Kind: 4, Name: a.CommitId}, StaticRoot: "dist", TargetFingerprint: prep.Msg.TargetFingerprint, CurrentPassword: localTestPassword}
	create, c := environmentRequest(f, l, input)
	if _, e = f.server.createRepositoryDeployment(c, create); e != nil {
		t.Fatal(e)
	}
	return f, l, input
}
func previewProbeTransport(f *workflowRunFixture, input *golfv1.CreateRepositoryDeploymentRequest, anonymous int) http.RoundTripper {
	return previewTransport(func(r *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(r.URL.Host, ".previews.example.com") {
			return http.DefaultTransport.RoundTrip(r)
		}
		response := &http.Response{StatusCode: anonymous, Header: http.Header{"Location": {"https://" + f.server.accessOIDC.TeamDomain + "/cdn-cgi/access/login"}}, Body: io.NopCloser(strings.NewReader(""))}
		if r.Header.Get("CF-Access-Client-Secret") != "" {
			raw, _ := json.Marshal(map[string]string{"fingerprint": input.TargetFingerprint, "archive": input.ArchiveSha256, "commit": input.CommitId, "d1": f.server.preview.cloudflare.D1ID, "r2": f.server.preview.cloudflare.R2Bucket})
			response.StatusCode = 200
			response.Body = io.NopCloser(bytes.NewReader(raw))
		}
		return response, nil
	})
}
func TestCloudflarePreviewBrokerPostgres(t *testing.T) {
	f, l, input := cloudflarePreviewFixture(t)
	request, c := environmentRequest(f, l, &golfv1.RepositoryDeploymentRequest{Target: input.Target, DeploymentId: input.DeploymentId})
	f.server.client.Transport = previewProbeTransport(f, input, 200)
	if _, e := f.server.activateRepositoryDeployment(c, request); e == nil {
		t.Fatal("public endpoint marked READY")
	}
	f.server.client.Transport = previewProbeTransport(f, input, 302)
	if _, e := f.server.activateRepositoryDeployment(c, request); e != nil {
		t.Fatal(e)
	}
	resume := httptest.NewRecorder()
	f.server.ServeHTTP(resume, httptest.NewRequest("GET", f.server.config.PublicURL+"/api/deployments/"+input.DeploymentId+"/resume", nil))
	if resume.Code != 303 || resume.Header().Get("Location") != "/?preview_login="+input.DeploymentId {
		t.Fatal("external Access reviewer must sign into Golf")
	}
	resumeRequest := httptest.NewRequest("GET", f.server.config.PublicURL+"/api/deployments/"+input.DeploymentId+"/resume", nil)
	resumeRequest.AddCookie(&http.Cookie{Name: "__Host-golf_session", Value: l.Value})
	resume = httptest.NewRecorder()
	f.server.ServeHTTP(resume, resumeRequest)
	if resume.Code != 200 || resume.Header().Get("Referrer-Policy") != "strict-origin" {
		t.Fatal("resume form must retain Origin")
	}
	open := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", f.server.config.PublicURL+"/api/deployments/"+input.DeploymentId+"/open", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", f.server.config.PublicURL)
		r.AddCookie(&http.Cookie{Name: "__Host-golf_session", Value: l.Value})
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		return w
	}
	if w := open(""); w.Code != 303 || w.Header().Get("Location") != f.server.previewOrigin(input.DeploymentId)+"/__golf/enter" {
		t.Fatal("Access must precede grant", w.Code)
	}
	handoff := open("access_ready=true")
	if handoff.Code != 200 || handoff.Header().Get("Referrer-Policy") != "strict-origin" || !strings.Contains(handoff.Body.String(), `name="referrer" content="strict-origin"`) || strings.Contains(handoff.Body.String(), l.Value) {
		t.Fatal("grant handoff", handoff.Code)
	}
	prefix := `name="grant" value="`
	parts := strings.SplitN(handoff.Body.String(), prefix, 2)
	if len(parts) != 2 {
		t.Fatal("missing grant")
	}
	grant := strings.SplitN(parts[1], `"`, 2)[0]
	broker := func(input cloudflarePreviewRequest, secret string) *previewResponseRecorder {
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", f.server.config.PublicURL+"/internal/cloudflare/preview", bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+secret)
		w := &previewResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
		f.server.ServeHTTP(w, r)
		return w
	}
	auth := cloudflarePreviewRequest{Method: "POST", Path: "/__golf/auth", Origin: f.server.config.PublicURL, Email: accessReviewerEmail(42), Grant: grant}
	secret := f.server.preview.cloudflare.BrokerSecret
	if broker(auth, "wrong").Code != 404 {
		t.Fatal("broker authentication")
	}
	auth.Email = accessReviewerEmail(43)
	if broker(auth, secret).Code != 404 {
		t.Fatal("Access identity mismatch")
	}
	auth.Email = accessReviewerEmail(42)
	w := broker(auth, secret)
	if w.Code != 303 || len(w.Result().Cookies()) != 1 {
		t.Fatal("redemption", w.Code)
	}
	cookie := w.Result().Cookies()[0]
	if cookie.Domain != "" || !cookie.HttpOnly || !cookie.Secure || cookie.Expires.After(time.Now().Add(301*time.Second)) {
		t.Fatal("short isolated viewer")
	}
	if broker(auth, secret).Code != 404 {
		t.Fatal("launch replay")
	}
	read := cloudflarePreviewRequest{Method: "GET", Path: "/", Email: accessReviewerEmail(42), Credential: cookie.Value}
	w = broker(read, secret)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "app.js") || w.deadline.IsZero() {
		t.Fatal("immutable bytes with authority", w.Code)
	}
	for _, path := range []string{"//evil.invalid", "/%2e%2e/private", "/__golf/private", "/?grant=secret"} {
		read.Path = path
		if broker(read, secret).Code != 404 {
			t.Fatal("path boundary", path)
		}
	}
	read.Path = "/"
	f.server.preview.cloudflare.AccessReviewerNativeID = 42
	f.server.preview.cloudflare.AccessReviewerEmail = "existing@example.com"
	if broker(read, secret).Code != 404 {
		t.Fatal("external mapping must not accept the synthetic identity")
	}
	read.Email = "existing@example.com"
	if broker(read, secret).Code != 200 {
		t.Fatal("explicit existing Access reviewer binding")
	}
	if f.server.preview.cloudflare.matchesReviewer(43, read.Email) {
		t.Fatal("external identity must not authorize another native reader")
	}
	read.Path = "/"
	f.mu.Lock()
	f.repositoryStatus = http.StatusNotFound
	f.mu.Unlock()
	if w = broker(read, secret); w.Code != 404 || strings.Contains(w.Body.String(), "app.js") {
		t.Fatal("repository reader revocation")
	}
	f.mu.Lock()
	f.repositoryStatus = 0
	f.mu.Unlock()
	parent, _ := sessionHash(l.Value)
	if _, e := f.server.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", parent); e != nil {
		t.Fatal(e)
	}
	if w = broker(read, secret); w.Code != 404 || strings.Contains(w.Body.String(), "app.js") {
		t.Fatal("parent revocation")
	}
}
