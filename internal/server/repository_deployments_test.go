package server

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"google.golang.org/protobuf/proto"
)

func TestStaticPreviewConfigurationAndTokens(t *testing.T) {
	empty := func(string) string { return "" }
	if v, e := previewConfig("http://localhost:8080", true, empty); e != nil || v != nil {
		t.Fatal("disabled", e)
	}
	dir := t.TempDir()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "preview"}, DNSNames: []string{"*.preview.localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	cert, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	private, _ := x509.MarshalPKCS8PrivateKey(key)
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0600)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}), 0600)
	values := map[string]string{"GOLF_PREVIEW_TLS_LISTEN_ADDR": "127.0.0.1:8444", "GOLF_PREVIEW_BASE_URL": "https://preview.localhost:8444", "GOLF_PREVIEW_TLS_CERT_FILE": certPath, "GOLF_PREVIEW_TLS_KEY_FILE": keyPath}
	get := func(k string) string { return values[k] }
	v, e := previewConfig("https://golf.localhost", false, get)
	if e != nil || v.tls.MinVersion != tls.VersionTLS13 || !deploymentSHA.MatchString(v.fingerprint) {
		t.Fatal("valid isolated profile", e)
	}
	for _, control := range []string{"http://golf.localhost", "https://preview.localhost", "https://abc.preview.localhost", "https://golf.localhost/path", "https://user@golf.localhost", "https://golf.localhost?private=value"} {
		if _, e := previewConfig(control, false, get); e == nil {
			t.Fatal("unsafe control", control)
		}
	}
	for _, origin := range []string{"https://preview.localhost/path", "https://outside.invalid", "https://preview.localhost?grant=secret", "http://preview.localhost"} {
		values["GOLF_PREVIEW_BASE_URL"] = origin
		if _, e := previewConfig("https://golf.localhost", false, get); e == nil {
			t.Fatal("unsafe preview origin")
		}
	}
	values["GOLF_PREVIEW_BASE_URL"] = "https://preview.localhost:8444"
	delete(values, "GOLF_PREVIEW_TLS_CERT_FILE")
	if _, e := previewConfig("https://golf.localhost", false, get); e == nil {
		t.Fatal("partialprofile")
	}
	a, hash, e := previewToken()
	if e != nil {
		t.Fatal(e)
	}
	b, _, _ := previewToken()
	if a == b {
		t.Fatal("shared grant")
	}
	got, e := previewTokenHash(a)
	if e != nil || !bytes.Equal(hash, got) {
		t.Fatal("tokenhash")
	}
	for _, bad := range []string{a + "=", a[:42], "", strings.Repeat("a", 50)} {
		if _, e := previewTokenHash(bad); e == nil {
			t.Fatal("noncanonicalcapability")
		}
	}
}
func TestStaticDeploymentIntentAndSourcePolicy(t *testing.T) {
	a := &golfv1.CreateRepositoryDeploymentRequest{DeploymentId: uuid.NewString(), CurrentPassword: "not retained", Source: &golfv1.RepositorySourceSelector{Kind: 4, Name: strings.Repeat("a", 40)}}
	b := proto.Clone(a).(*golfv1.CreateRepositoryDeploymentRequest)
	b.CurrentPassword = "changed"
	if !bytes.Equal(deploymentIntent(a), deploymentIntent(b)) {
		t.Fatal("password retained")
	}
	for _, f := range []func(*golfv1.CreateRepositoryDeploymentRequest){func(v *golfv1.CreateRepositoryDeploymentRequest) { v.ArchiveSha256 = "new" }, func(v *golfv1.CreateRepositoryDeploymentRequest) { v.StaticRoot = "other" }, func(v *golfv1.CreateRepositoryDeploymentRequest) { v.EnvironmentVersion = "2" }, func(v *golfv1.CreateRepositoryDeploymentRequest) { v.Source.Name = strings.Repeat("b", 40) }} {
		b = proto.Clone(a).(*golfv1.CreateRepositoryDeploymentRequest)
		f(b)
		if bytes.Equal(deploymentIntent(a), deploymentIntent(b)) {
			t.Fatal("changedintentadopted")
		}
	}
	p := environmentTestPolicy()
	if !deploymentSourceAllowed(p, a.Source) {
		t.Fatal("commit denied")
	}
	if deploymentSourceAllowed(p, &golfv1.RepositorySourceSelector{Kind: 1}) {
		t.Fatal("guesseddefaultsource")
	}
	p.AllowAllSources = false
	p.Sources = []*golfv1.RepositorySourceSelector{{Kind: 2, Name: "main"}}
	if deploymentSourceAllowed(p, a.Source) || !deploymentSourceAllowed(p, p.Sources[0]) {
		t.Fatal("restrictionignored")
	}
}
func TestStaticDeploymentManagedOuterBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, method := range []string{"PrepareStaticDeployment", "CreateRepositoryDeployment", "GetRepositoryDeployment", "ListRepositoryDeployments", "ReviewRepositoryDeployment", "ActivateRepositoryDeployment", "RevokeRepositoryDeployment"} {
		for _, origin := range []string{s.config.PublicURL, "https://wrong.invalid"} {
			r := httptest.NewRequest("POST", "/rpc/golf.v1.RepositoryDeploymentService/"+method, strings.NewReader("{}"))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", origin)
			r.Header.Set("Connect-Protocol-Version", "1")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want {
				t.Fatal(method, w.Code)
			}
		}
	}
	for _, path := range []string{"/api/deployments/" + uuid.NewString() + "/open", "/", "/rpc/golf.v1.SessionService/GetSession"} {
		r := httptest.NewRequest("GET", "https://other.preview.localhost"+path, nil)
		w := httptest.NewRecorder()
		s.PreviewHandler().ServeHTTP(w, r)
		if w.Code != 404 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "worker-src 'none'") {
			t.Fatal("disabled preview exposed control")
		}
	}
}

// Real Golf protocol producer (not a mocked success or direct native storage).
func previewQualifiedArtifact(t *testing.T, f *workflowRunFixture, l loginResult) *golfv1.WorkflowArtifact {
	t.Helper()
	f.enable(t)
	f.workflow = []byte("build:\n  image: example/build@sha256:" + strings.Repeat("b", 64) + "\n  script: mkdir -p dist; printf built > dist/index.html\n  artifacts:\n    paths: [dist]\n")
	req, c := environmentRequest(f, l, &golfv1.DispatchWorkflowRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, WorkflowPath: ".gitlab-ci.yml", IdempotencyKey: uuid.NewString()})
	run, e := f.server.DispatchWorkflow(c, req)
	if e != nil {
		t.Fatal(e)
	}
	key := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	var lease struct{ RunID, AttemptID, AttemptToken string }
	call := func(action string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/internal/ci/attempt/"+lease.AttemptID+"/"+action, bytes.NewReader(body))
		r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
		r.Header.Set("Golf-Runner-ID", "fixture")
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Golf-Attempt-Token", lease.AttemptToken)
		w := httptest.NewRecorder()
		if action == "poll" {
			f.server.runnerPoll(w, r)
		} else {
			route := chi.NewRouteContext()
			route.URLParams.Add("id", lease.AttemptID)
			r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, route))
			f.server.runnerAttempt(w, r)
		}
		return w
	}
	poll := call("poll", []byte(`{"capabilities":["golf.runner.job-limits.v1","golf.workflow.shell.artifacts.v1"]}`))
	if poll.Code != 200 || json.Unmarshal(poll.Body.Bytes(), &lease) != nil {
		t.Fatal("producerpoll", poll.Code)
	}
	for _, progress := range []string{`{"sequence":1,"stepIndex":0,"kind":"started"}`, `{"sequence":2,"stepIndex":0,"kind":"finished","exitCode":0}`} {
		if w := call("progress", []byte(progress)); w.Code != 204 {
			t.Fatal("producerprogress", w.Code)
		}
	}
	archive, _, _, e := runner.NormalizeArtifactArchive(workflowRunTar(t, []*tar.Header{{Name: "dist/index.html", Typeflag: tar.TypeReg}, {Name: "dist/app.js", Typeflag: tar.TypeReg}}, [][]byte{[]byte("<html><script src=app.js></script></html>"), []byte("document.title='real-static';")}), []string{"dist"})
	if e != nil {
		t.Fatal(e)
	}
	if w := call("artifact", archive); w.Code != 204 {
		t.Fatal("producerartifact", w.Code)
	}
	if w := call("finish", []byte(`{"exitCode":0}`)); w.Code != 204 {
		t.Fatal("producerfinish", w.Code)
	}
	a, _, e := f.server.readWorkflowArtifact(t.Context(), l.Value, forgeCredential{Kind: "pat", Token: "run-fixture", Local: true}, run.Msg.Run.Id)
	if e != nil || a == nil {
		t.Fatal("qualifiedartifact", e)
	}
	return a
}
func deploymentActivityCount(t *testing.T, f *workflowRunFixture) int {
	t.Helper()
	var count int
	if e := f.server.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE forge_url=$1 AND repository_id=$2 AND recipient_user_id=0 AND topic='actions'", f.server.config.GiteaURL, f.row.ID).Scan(&count); e != nil {
		t.Fatal(e)
	}
	return count
}
func TestStaticDeploymentActivationReplayAndRevocationPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t, ".gitlab-ci.yml")
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture"}); e != nil {
		t.Fatal(e)
	}
	l, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	f.server.config.PublicURL = "https://golf.localhost"
	f.server.config.AllowInsecureCookies = false
	f.server.preview = &previewConfiguration{origin: "https://preview.localhost:8444", fingerprint: strings.Repeat("f", 64)}
	f.server.previewBound.Store(true)
	a := previewQualifiedArtifact(t, f, l)
	target0 := runnerPlacementFixture(t, f, l)
	target := &golfv1.RepositoryEnvironmentTarget{Repository: target0.Repository, RepositoryId: target0.RepositoryId, OwnerId: target0.OwnerId, AccessRevision: target0.ExpectedRevision}
	envInput := environmentInput(target)
	env, e := environmentSave(t, f, l, envInput)
	if e != nil {
		t.Fatal(e)
	}
	prepReq, c := environmentRequest(f, l, &golfv1.PrepareStaticDeploymentRequest{Target: target, RunId: a.RunId})
	prep, e := f.server.PrepareStaticDeployment(c, prepReq)
	if e != nil || len(prep.Msg.Roots) != 1 || prep.Msg.Roots[0].Path != "dist" {
		t.Fatal("actualprepare", e)
	}
	input := &golfv1.CreateRepositoryDeploymentRequest{Target: target, DeploymentId: uuid.NewString(), RunId: a.RunId, AttemptId: a.AttemptId, CommitId: a.CommitId, ArchiveSha256: a.ArchiveSha256, ManifestSha256: prep.Msg.ManifestSha256, EnvironmentId: env.Environment.Id, EnvironmentVersion: env.Environment.Version, Source: &golfv1.RepositorySourceSelector{Kind: 4, Name: a.CommitId}, StaticRoot: "dist", TargetFingerprint: prep.Msg.TargetFingerprint, CurrentPassword: localTestPassword}
	create := func(m *golfv1.CreateRepositoryDeploymentRequest) (*connect.Response[golfv1.RepositoryDeploymentResponse], error) {
		r, c := environmentRequest(f, l, m)
		return f.server.createRepositoryDeployment(c, r)
	}
	activity := deploymentActivityCount(t, f)
	first, e := create(input)
	if e != nil || first.Msg.Deployment.State != "REQUESTED" || !first.Msg.Deployment.CanActivate {
		t.Fatal("request", e)
	}
	again, e := create(input)
	if e != nil || again.Msg.Deployment.Id != input.DeploymentId {
		t.Fatal("once replay", e)
	}
	bad := proto.Clone(input).(*golfv1.CreateRepositoryDeploymentRequest)
	bad.StaticRoot = "other"
	if _, e = create(bad); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("originalintentchange", e)
	}
	if got := deploymentActivityCount(t, f); got != activity+1 {
		t.Fatalf("admission/replay activity = %d, want %d", got, activity+1)
	}
	get := &golfv1.RepositoryDeploymentRequest{Target: target, DeploymentId: input.DeploymentId}
	wrong := proto.Clone(get).(*golfv1.RepositoryDeploymentRequest)
	wrong.Target.Repository.Name = "replacement"
	wrongRequest, wrongContext := environmentRequest(f, l, wrong)
	if _, e = f.server.activateRepositoryDeployment(wrongContext, wrongRequest); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("activation must bind current canonical target", e)
	}
	r, c := environmentRequest(f, l, get)
	ready, e := f.server.activateRepositoryDeployment(c, r)
	if e != nil || ready.Msg.Deployment.State != "READY" || !ready.Msg.Deployment.CanOpen {
		t.Fatal("realactivation", e)
	}
	if got := deploymentActivityCount(t, f); got != activity+2 {
		t.Fatalf("activation activity = %d, want %d", got, activity+2)
	}
	second := proto.Clone(input).(*golfv1.CreateRepositoryDeploymentRequest)
	second.DeploymentId = uuid.NewString()
	secondResult, e := create(second)
	if e != nil || secondResult.Msg.Deployment.CanActivate || secondResult.Msg.Deployment.Reason != "capacity_unavailable" {
		t.Fatal("current capacity observation", e)
	}
	r, c = environmentRequest(f, l, &golfv1.RepositoryDeploymentRequest{Target: target, DeploymentId: second.DeploymentId})
	if _, e = f.server.activateRepositoryDeployment(c, r); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("concurrentcapacity", e)
	}
	r, c = environmentRequest(f, l, get)
	revoked, e := f.server.revokeRepositoryDeployment(c, r)
	if e != nil || revoked.Msg.Deployment.State != "REVOKED" || revoked.Msg.Deployment.CanOpen {
		t.Fatal("revoke", e)
	}
	if _, e = f.server.activateRepositoryDeployment(c, r); e == nil {
		t.Fatal("revoked revived")
	}
	if got := deploymentActivityCount(t, f); got != activity+4 {
		t.Fatalf("revoke/refusal activity = %d, want %d", got, activity+4)
	}
	var count int
	if f.server.db.QueryRow("SELECT count(*) FROM golf_repository_deployments WHERE id=$1", input.DeploymentId).Scan(&count) != nil || count != 1 {
		t.Fatal("replayedrequestduplicated")
	}
}

// ResponseController deadlines are exercised without opening a listener. Real
// TLS, DNS/cookie isolation and browser execution remain root qualification.
type previewResponseRecorder struct {
	*httptest.ResponseRecorder
	deadline time.Time
}

func (w *previewResponseRecorder) SetWriteDeadline(v time.Time) error { w.deadline = v; return nil }
func TestStaticPreviewAccessSessionAndEnvironmentPostgres(t *testing.T) {
	f := newWorkflowRunFixture(t, ".gitlab-ci.yml")
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture"}); e != nil {
		t.Fatal(e)
	}
	l, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	f.server.config.PublicURL = "https://golf.localhost"
	f.server.config.AllowInsecureCookies = false
	f.server.preview = &previewConfiguration{origin: "https://preview.localhost:8444", fingerprint: strings.Repeat("f", 64)}
	f.server.previewBound.Store(true)
	a := previewQualifiedArtifact(t, f, l)
	t0 := runnerPlacementFixture(t, f, l)
	target := &golfv1.RepositoryEnvironmentTarget{Repository: t0.Repository, RepositoryId: t0.RepositoryId, OwnerId: t0.OwnerId, AccessRevision: t0.ExpectedRevision}
	environment := environmentInput(target)
	env, e := environmentSave(t, f, l, environment)
	if e != nil {
		t.Fatal(e)
	}
	r, c := environmentRequest(f, l, &golfv1.PrepareStaticDeploymentRequest{Target: target, RunId: a.RunId})
	prep, e := f.server.PrepareStaticDeployment(c, r)
	if e != nil {
		t.Fatal(e)
	}
	input := &golfv1.CreateRepositoryDeploymentRequest{Target: target, DeploymentId: uuid.NewString(), RunId: a.RunId, AttemptId: a.AttemptId, CommitId: a.CommitId, ArchiveSha256: a.ArchiveSha256, ManifestSha256: prep.Msg.ManifestSha256, EnvironmentId: env.Environment.Id, EnvironmentVersion: env.Environment.Version, Source: &golfv1.RepositorySourceSelector{Kind: 4, Name: a.CommitId}, StaticRoot: "dist", TargetFingerprint: prep.Msg.TargetFingerprint, CurrentPassword: localTestPassword}
	create, ctx := environmentRequest(f, l, input)
	if _, e = f.server.createRepositoryDeployment(ctx, create); e != nil {
		t.Fatal(e)
	}
	get := &golfv1.RepositoryDeploymentRequest{Target: target, DeploymentId: input.DeploymentId}
	activation, ctx := environmentRequest(f, l, get)
	if _, e = f.server.activateRepositoryDeployment(ctx, activation); e != nil {
		t.Fatal(e)
	}
	open := httptest.NewRequest("POST", "https://golf.localhost/api/deployments/"+input.DeploymentId+"/open", nil)
	open.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
	open.Header.Set("Origin", f.server.config.PublicURL)
	open.AddCookie(&http.Cookie{Name: "__Host-golf_session", Value: l.Value})
	handoff := httptest.NewRecorder()
	f.server.DeploymentOpenHandler().ServeHTTP(handoff, open)
	if handoff.Code != 200 || strings.Contains(handoff.Body.String(), l.Value) {
		t.Fatal("securelaunchhandoff", handoff.Code)
	}
	text := handoff.Body.String()
	prefix := `name="grant" value="`
	i := strings.Index(text, prefix)
	if i < 0 {
		t.Fatal("missingprivateform")
	}
	grant := strings.SplitN(text[i+len(prefix):], `"`, 2)[0]
	origin := f.server.previewOrigin(input.DeploymentId)
	redeem := func(value string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", origin+"/__golf/auth", strings.NewReader("grant="+value))
		r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
		r.Header.Set("Origin", f.server.config.PublicURL)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		f.server.PreviewHandler().ServeHTTP(w, r)
		return w
	}
	auth := redeem(grant)
	if auth.Code != 303 || len(auth.Result().Cookies()) != 1 {
		t.Fatal("oneredeem", auth.Code)
	}
	cookie := auth.Result().Cookies()[0]
	if cookie.Name != previewCookie || !cookie.HttpOnly || !cookie.Secure || cookie.Domain != "" {
		t.Fatal("cookieboundary")
	}
	if w := redeem(grant); w.Code != 404 {
		t.Fatal("launchreplayed")
	}
	request := func(path string) *previewResponseRecorder {
		r := httptest.NewRequest("GET", origin+path, nil)
		r.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
		r.AddCookie(cookie)
		w := &previewResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
		f.server.PreviewHandler().ServeHTTP(w, r)
		return w
	}
	if w := request("/"); w.Code != 200 || !strings.Contains(w.Body.String(), "app.js") || w.deadline.IsZero() {
		t.Fatal("actualstaticserving", w.Code)
	}
	for _, path := range []string{"/%2e%2e/private", "/dist/index.html", "/__golf/private", "/api/session"} {
		if w := request(path); w.Code != 404 || strings.Contains(w.Body.String(), "app.js") {
			t.Fatal("unexpectedroute", w.Code)
		}
	}
	edit := proto.Clone(environment).(*golfv1.SaveRepositoryEnvironmentRequest)
	edit.ExpectedVersion = "1"
	edit.OperationId = uuid.NewString()
	edit.Name = "changed current policy"
	if _, e = environmentSave(t, f, l, edit); e != nil {
		t.Fatal(e)
	}
	if w := request("/"); w.Code != 404 || strings.Contains(w.Body.String(), "app.js") {
		t.Fatal("policychangedreleasedbytes", w.Code)
	}
	if e = f.server.logoutSession(t.Context(), l.Value); e != nil {
		t.Fatal(e)
	}
	if w := request("/"); w.Code != 404 {
		t.Fatal("parentlogoutignored")
	}
	var retained int
	if f.server.db.QueryRow("SELECT count(*) FROM golf_repository_deployments WHERE id=$1", input.DeploymentId).Scan(&retained) != nil || retained != 1 {
		t.Fatal("privacydenialerasedhistory")
	}
}
