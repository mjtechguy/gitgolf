package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Actual public issuer, Golf handlers and native Access/Worker/D1/R2. Repository
// identity and the runner protocol producer remain controlled qualification data.
func TestCloudflarePreviewLive(t *testing.T) {
	directory := os.Getenv("GOLF_CF_PREVIEW_LIVE_DIRECTORY")
	if directory == "" {
		t.Skip("set an owned private live qualification directory")
	}
	f, l, target := cloudflarePreviewProducerFixture(t)
	write := func(name string, value any) {
		t.Helper()
		raw, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(directory, name), raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	wait := func(name string, bound time.Duration) []byte {
		t.Helper()
		deadline := time.Now().Add(bound)
		for time.Now().Before(deadline) {
			if raw, e := os.ReadFile(filepath.Join(directory, name)); e == nil {
				return raw
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatal("owned fixture deadline", name)
		return nil
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	var application, issuer atomic.Pointer[Server]
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s := application.Load(); s != nil {
			s.ServeHTTP(w, r)
			return
		}
		if s := issuer.Load(); s != nil && strings.HasPrefix(r.URL.Path, "/auth/access/") {
			s.ServeHTTP(w, r)
			return
		}
		http.Error(w, "Qualification preparing", 503)
	})}
	defer server.Close()
	go server.Serve(listener)
	write("listener.json", map[string]string{"url": "http://" + listener.Addr().String()})
	origin := string(wait("origin", time.Minute))
	if !regexp.MustCompile(`^https://[a-z0-9-]+\.trycloudflare\.com$`).MatchString(origin) {
		t.Fatal("owned HTTPS origin")
	}
	config := f.server.config
	config.PublicURL = origin
	config.AllowInsecureCookies = false
	config.WebDir, e = filepath.Abs("../../web/dist")
	if e != nil {
		t.Fatal(e)
	}
	s, e := New(config, f.server.db)
	if e != nil {
		t.Fatal(e)
	}
	f.server = s
	oidc := oidcTestConfiguration(t, origin)
	oidc.TeamDomain = os.Getenv("GOLF_CF_PREVIEW_TEAM_DOMAIN")
	if !regexp.MustCompile(`^[a-z0-9-]+\.cloudflareaccess\.com$`).MatchString(oidc.TeamDomain) {
		t.Fatal("selected team")
	}
	oidc.callback = "https://" + oidc.TeamDomain + "/cdn-cgi/access/callback"
	sum := sha256.Sum256([]byte(oidc.issuer + "\x00" + oidc.ClientID + "\x00" + oidc.ClientSecret + "\x00" + oidc.callback + "\x00" + oidc.kid))
	oidc.fingerprint = hex.EncodeToString(sum[:])
	s.accessOIDC = oidc
	issuer.Store(s)
	write("issuer.json", map[string]string{"issuer": oidc.issuer, "client_id": oidc.ClientID, "client_secret": oidc.ClientSecret})
	defer os.Remove(filepath.Join(directory, "issuer.json"))
	wait("preview-config.json", 2*time.Minute)
	preview, e := loadCloudflarePreview(origin, oidc, filepath.Join(directory, "preview-config.json"))
	if e != nil {
		t.Fatal(e)
	}
	defer os.Remove(filepath.Join(directory, "preview-config.json"))
	s.preview = preview
	s.previewBound.Store(true)
	a := previewQualifiedArtifact(t, f, l)
	env, e := environmentSave(t, f, l, environmentInput(target))
	if e != nil {
		t.Fatal(e)
	}
	r, c := environmentRequest(f, l, &golfv1.PrepareStaticDeploymentRequest{Target: target, RunId: a.RunId})
	prepared, e := s.PrepareStaticDeployment(c, r)
	if e != nil {
		t.Fatal(e)
	}
	input := &golfv1.CreateRepositoryDeploymentRequest{Target: target, DeploymentId: preview.cloudflare.DeploymentID, RunId: a.RunId, AttemptId: a.AttemptId, CommitId: a.CommitId, ArchiveSha256: a.ArchiveSha256, ManifestSha256: prepared.Msg.ManifestSha256, EnvironmentId: env.Environment.Id, EnvironmentVersion: env.Environment.Version, Source: &golfv1.RepositorySourceSelector{Kind: 4, Name: a.CommitId}, StaticRoot: "dist", TargetFingerprint: prepared.Msg.TargetFingerprint, CurrentPassword: localTestPassword}
	create, c := environmentRequest(f, l, input)
	if _, e = s.createRepositoryDeployment(c, create); e != nil {
		t.Fatal(e)
	}
	_, data, e := s.readWorkflowArtifact(t.Context(), l.Value, forgeCredential{Kind: "pat", Token: "run-fixture", Local: true}, a.RunId)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(directory, "artifact.tar"), data, 0600); e != nil {
		t.Fatal(e)
	}
	write("prepared.json", map[string]string{"deployment": input.DeploymentId, "archive": input.ArchiveSha256, "commit": input.CommitId, "fingerprint": input.TargetFingerprint, "manifest": input.ManifestSha256, "run": a.RunId, "preview": s.previewOrigin(input.DeploymentId)})
	wait("worker-ready", 7*time.Minute)
	request, c := environmentRequest(f, l, &golfv1.RepositoryDeploymentRequest{Target: target, DeploymentId: input.DeploymentId})
	if _, e = s.activateRepositoryDeployment(c, request); e != nil {
		t.Fatal("native activation failed", e)
	}
	application.Store(s)
	write("ready.json", map[string]string{"origin": origin, "preview": s.previewOrigin(input.DeploymentId), "deployment": input.DeploymentId, "scope": "actual_golf_access_worker_d1_r2_controlled_native_identity_runner_producer"})
	deadline := time.Now().Add(6 * time.Minute)
	revoked := false
	for time.Now().Before(deadline) {
		if _, e = os.Stat(filepath.Join(directory, "revoke-reader")); e == nil && !revoked {
			f.mu.Lock()
			f.repositoryStatus = http.StatusNotFound
			f.mu.Unlock()
			revoked = true
			write("reader-revoked.json", map[string]bool{"revoked": true})
		}
		if _, e = os.Stat(filepath.Join(directory, "stop")); e == nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("collaborative browser deadline")
}
