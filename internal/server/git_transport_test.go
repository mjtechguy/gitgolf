package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestManagedGitConfigurationAndTokenBoundary(t *testing.T) {
	source := map[string]string{"GOLF_MANAGED_HTTP_GIT": "true", "GOLF_MANAGED_HTTP_GIT_PUBLIC_URL": "https://git.golf.example"}
	read := func(k string) string { return source[k] }
	if c, e := managedGitConfig(read); e != nil || !c.Enabled || c.AllowLoopback {
		t.Fatal("explicit HTTPS profile", e)
	}
	for _, origin := range []string{"http://git.golf.example", "https://golf:secret@git.golf.example", "https://git.golf.example/path", "https://git.golf.example?token=secret"} {
		source["GOLF_MANAGED_HTTP_GIT_PUBLIC_URL"] = origin
		if _, e := managedGitConfig(read); e == nil {
			t.Fatal("unsafe public origin")
		}
	}
	source["GOLF_MANAGED_HTTP_GIT_PUBLIC_URL"] = "http://127.0.0.1:8080"
	source["GOLF_MANAGED_HTTP_GIT_ALLOW_LOOPBACK"] = "true"
	c, e := managedGitConfig(read)
	if e != nil {
		t.Fatal(e)
	}
	req := httptest.NewRequest("POST", "http://127.0.0.1/git/alice/example.git/git-receive-pack", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	req.Header.Set("X-Forwarded-Proto", "https")
	if gitRequestEncrypted(req, c) {
		t.Fatal("forwarded header became TLS proof")
	}
	req.RemoteAddr = "127.0.0.1:1234"
	if !gitRequestEncrypted(req, c) {
		t.Fatal("explicit actual loopback development refused")
	}
	valid := gitCredentialPrefix + base64OpaqueForTest()
	if _, e := gitTokenHash(valid); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{strings.Replace(valid, gitCredentialPrefix, apiTokenPrefix, 1), strings.TrimPrefix(valid, gitCredentialPrefix), valid + "=", gitCredentialPrefix + strings.Repeat("!", 43)} {
		if _, e := gitTokenHash(bad); e == nil {
			t.Fatal("wrong credential namespace/encoding accepted")
		}
	}
	if _, e := gitBrowserCredential(context.WithValue(t.Context(), apiAuthKey{}, apiAuth{})); e == nil {
		t.Fatal("read-only API delegation became Git credential management")
	}
}
func base64OpaqueForTest() string { return strings.Repeat("A", 43) }
func TestManagedGitAdvertisementNarrowing(t *testing.T) {
	original := append(managedPacket("# service=git-receive-pack\n"), []byte("0000")...)
	original = append(original, managedPacket(strings.Repeat("1", 40)+" refs/heads/main\x00report-status report-status-v2 side-band-64k push-options push-cert=nonce session-id=secret proc-receive agent=git/2.39.5\n")...)
	original = append(original, []byte("0000")...)
	filtered, e := filterGitAdvertisement(original, "git-receive-pack")
	if e != nil {
		t.Fatal(e)
	}
	for _, unsupported := range []string{"report-status-v2", "push-options", "push-cert", "session-id", "proc-receive"} {
		if bytes.Contains(filtered, []byte(unsupported)) {
			t.Fatal("unqualified advertised capability", unsupported)
		}
	}
	if !bytes.Contains(filtered, []byte("report-status side-band-64k")) || !bytes.Contains(filtered, []byte("refs/heads/main")) {
		t.Fatal("ordinary current ref/status capability lost")
	}
}

type gitTransportFixture struct {
	server     *Server
	session    loginResult
	credential forgeCredential
	ctx        context.Context
	mode       atomic.Int32
	forwards   atomic.Int32
	posts      atomic.Int32
}

func newGitTransportFixture(t *testing.T) *gitTransportFixture {
	t.Helper()
	db := testDatabase(t)
	f := &gitTransportFixture{credential: managementToken()}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/version" {
			fmt.Fprint(w, `{"version":"1.27.3"}`)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/") && r.Header.Get("Authorization") != "token alice-management-token" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/v1/user" {
			fmt.Fprint(w, `{"id":42,"login":"alice","is_admin":false}`)
			return
		}
		switch r.URL.Path {
		case "/api/v1/repos/alice/example":
			if f.mode.Load() == 1 {
				w.WriteHeader(404)
				return
			}
			repoID := int64(91)
			if f.mode.Load() == 2 {
				repoID = 92
			}
			pull, push := true, true
			if f.mode.Load() == 3 {
				pull = false
				push = false
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": repoID, "name": "example", "full_name": "alice/example", "owner": map[string]any{"id": 42, "login": "alice"}, "default_branch": "main", "private": true, "empty": false, "archived": false, "mirror": false, "has_actions": false, "permissions": map[string]bool{"pull": pull, "push": push}})
		case "/api/v1/repos/alice/example/branch_protections", "/api/v1/repos/alice/example/tag_protections", "/api/v1/repos/alice/example/push_mirrors":
			fmt.Fprint(w, `[]`)
		case "/api/v1/repos/alice/example/git/refs/heads/topic":
			fmt.Fprintf(w, `[{"ref":"refs/heads/topic","object":{"sha":"%s","type":"commit"}}]`, strings.Repeat("2", 40))
		case "/alice/example.git/info/refs":
			login, password, ok := r.BasicAuth()
			if !ok || login != "alice" || password != "alice-management-token" || r.Header.Get("Cookie") != "" || r.Header.Get("Sudo") != "" {
				w.WriteHeader(401)
				return
			}
			f.forwards.Add(1)
			w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
			w.Write(append(managedPacket("# service=git-upload-pack\n"), []byte("0000")...))
		case "/alice/example.git/git-upload-pack":
			f.forwards.Add(1)
			if f.mode.Load() == 4 {
				f.mode.Store(1)
			}
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			fmt.Fprint(w, "private fixture pack bytes")
		case "/alice/example.git/git-receive-pack":
			f.posts.Add(1)
			if f.mode.Load() == 5 {
				w.WriteHeader(500)
				return
			}
			w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
			inner := append(managedPacket("unpack ok\n"), managedPacket("ok refs/heads/topic\n")...)
			inner = append(inner, []byte("0000")...)
			w.Write(append(managedPacket("\x01"+string(inner)), []byte("0000")...))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(provider.Close)
	var e error
	f.server, e = New(testConfig(provider.URL), db)
	if e != nil {
		t.Fatal(e)
	}
	f.session, e = f.server.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", f.credential.Token, "")
	if e != nil {
		t.Fatal(e)
	}
	f.ctx = context.WithValue(t.Context(), sessionTokenKey{}, f.credential)
	t.Setenv("GOLF_MANAGED_HTTP_GIT", "true")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_PUBLIC_URL", "http://127.0.0.1:8080")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_ALLOW_LOOPBACK", "true")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_INCARNATION", "")
	return f
}
func gitTransportRequest[T any](f *gitTransportFixture, msg *T) *connect.Request[T] {
	r := connect.NewRequest(msg)
	r.Header().Set("Cookie", f.server.sessionCookie(f.session.Value, f.session.Expires, 3600).String())
	r.Header().Set("Origin", f.server.config.PublicURL)
	return r
}
func fixtureGitCredential(t *testing.T, f *gitTransportFixture) *golfv1.CreateGitCredentialResponse {
	t.Helper()
	response, e := f.server.CreateGitCredential(f.ctx, gitTransportRequest(f, &golfv1.CreateGitCredentialRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "91", OwnerId: "42", Label: "owned Git tool", Mode: golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_READ, LifetimeSeconds: 3600}))
	if e != nil {
		t.Fatal(e)
	}
	return response.Msg
}
func fixtureGitHTTP(f *gitTransportFixture, secret, method, endpoint string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, endpoint, bytes.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.SetBasicAuth("golf", secret)
	if method == "POST" {
		if strings.HasSuffix(endpoint, "git-receive-pack") {
			r.Header.Set("Content-Type", "application/x-git-receive-pack-request")
		} else {
			r.Header.Set("Content-Type", "application/x-git-upload-pack-request")
		}
	}
	w := httptest.NewRecorder()
	f.server.managedGitTransport(w, r)
	return w
}
func TestManagedGitOwnSessionScopePostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	created := fixtureGitCredential(t, f)
	if !strings.HasPrefix(created.Secret, gitCredentialPrefix) || created.Credential.Mode != golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_READ {
		t.Fatal("wrong namespace/receipt")
	}
	var stored []byte
	if e := f.server.db.QueryRow(`SELECT token_hash FROM golf_git_credentials WHERE id=$1`, created.Credential.Id).Scan(&stored); e != nil {
		t.Fatal(e)
	}
	hash, _ := gitTokenHash(created.Secret)
	if !bytes.Equal(stored, hash) || bytes.Contains(stored, []byte(created.Secret)) {
		t.Fatal("capability not hash-only")
	}
	if w := fixtureGitHTTP(f, created.Secret, "GET", "/git/alice/example.git/info/refs?service=git-upload-pack", nil); w.Code != 200 {
		t.Fatal("ordinary supported advertisement", w.Code)
	}
	f.mode.Store(2)
	if w := fixtureGitHTTP(f, created.Secret, "GET", "/git/alice/example.git/info/refs?service=git-upload-pack", nil); w.Code != 404 {
		t.Fatal("repository name replacement admitted", w.Code)
	}
	if f.forwards.Load() != 1 {
		t.Fatal("replacement request forwarded")
	}
	f.mode.Store(0)
	if e := f.server.logoutSession(t.Context(), f.session.Value); e != nil {
		t.Fatal(e)
	}
	if w := fixtureGitHTTP(f, created.Secret, "GET", "/git/alice/example.git/info/refs?service=git-upload-pack", nil); w.Code != 401 {
		t.Fatal("source-session logout did not revoke new Git requests", w.Code)
	}
	var count int
	if e := f.server.db.QueryRow(`SELECT count(*) FROM golf_git_credentials`).Scan(&count); e != nil || count != 1 {
		t.Fatal("metadata history erased", e)
	}
}
func TestManagedGitWithholdsLatePrivateReadPostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	created := fixtureGitCredential(t, f)
	f.mode.Store(4)
	w := fixtureGitHTTP(f, created.Secret, "POST", "/git/alice/example.git/git-upload-pack", []byte("bounded negotiation"))
	if w.Code == 200 || bytes.Contains(w.Body.Bytes(), []byte("private fixture pack bytes")) {
		t.Fatal("late native denial exposed buffered private source", w.Code)
	}
}
func TestManagedGitWriteUnqualifiedAndNoBypassPostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	_, e := f.server.CreateGitCredential(f.ctx, gitTransportRequest(f, &golfv1.CreateGitCredentialRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "91", OwnerId: "42", Label: "write", Mode: golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_WRITE}))
	if !errors.Is(e, errGitBackgroundUnqualified) {
		t.Fatal("environment alone qualified background writes", e)
	}
	created := fixtureGitCredential(t, f)
	if w := fixtureGitHTTP(f, created.Secret, "POST", "/git/alice/example.git/git-receive-pack", managedReceive("refs/heads/topic")); w.Code != 401 || f.posts.Load() != 0 {
		t.Fatal("read capability became Git write authority", w.Code)
	}
}
func seedManagedGitWriteFixture(t *testing.T, f *gitTransportFixture, created *golfv1.CreateGitCredentialResponse) (gitCredentialRecord, managedGitConfiguration) {
	t.Helper()
	incarnation := uuid.NewString()
	t.Setenv("GOLF_MANAGED_HTTP_GIT_INCARNATION", incarnation)
	// Own disposable Golf schema only: synthetic enrollment is source fault evidence,
	// never claimed as independent native/background/deployment qualification.
	if _, e := f.server.db.Exec(`INSERT INTO golf_git_transport_profiles(forge_url,incarnation,native_version,receipt_sha256,qualifier_source_commit,golf_image_digest,native_image_digest,native_runtime_id) VALUES($1,$2,'1.27.3',$3,$4,$5,$5,$3)`, f.server.config.GiteaURL, incarnation, strings.Repeat("a", 64), strings.Repeat("b", 40), "sha256:"+strings.Repeat("c", 64)); e != nil {
		t.Fatal(e)
	}
	hash, _ := gitTokenHash(created.Secret)
	var id, uid, sid int64
	var source []byte
	if e := f.server.db.QueryRow(`SELECT id,user_id,source_session_id,source_token_hash FROM golf_git_credentials WHERE token_hash=$1`, hash).Scan(&id, &uid, &sid, &source); e != nil {
		t.Fatal(e)
	}
	var writeID int64
	if e := f.server.db.QueryRow(`INSERT INTO golf_git_credentials(user_id,forge_url,repository_id,owner_id,native_user_id,source_session_id,source_token_hash,token_hash,label,mode,expires_at) VALUES($1,$2,91,42,42,$3,$4,$5,'write fixture','WRITE',clock_timestamp()+interval '1 hour') RETURNING id`, uid, f.server.config.GiteaURL, sid, source, bytes.Repeat([]byte{9}, 32)).Scan(&writeID); e != nil {
		t.Fatal(e)
	}
	record, e := scanGitCredential(f.server.db.QueryRow(`SELECT `+gitCredentialColumns+` FROM golf_git_credentials c WHERE c.id=$1`, writeID))
	if e != nil {
		t.Fatal(e)
	}
	config, e := f.server.gitConfiguration()
	if e != nil {
		t.Fatal(e)
	}
	return record, config
}
func TestManagedGitUnknownExcludesNewIntentAndSurvivesRestartPostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	created := fixtureGitCredential(t, f)
	cap, config := seedManagedGitWriteFixture(t, f, created)
	request, e := receiveRequest(managedReceive("refs/heads/topic"))
	if e != nil {
		t.Fatal(e)
	}
	route := gitTransportRoute{Key: repositoryKey{"alice", "example"}, Service: "git-receive-pack"}
	op, e := f.server.reserveGitReceive(t.Context(), cap, f.credential, route, request, config)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.server.markGitDispatch(t.Context(), op, cap); e != nil {
		t.Fatal(e)
	}
	var blocked bool
	if e = f.server.db.QueryRow(`SELECT golf_repository_lifecycle_blocked($1,91)`, f.server.config.GiteaURL).Scan(&blocked); e != nil || !blocked {
		t.Fatal("unknown did not block existing scoped consumers", e)
	}
	restarted, restartErr := New(f.server.config, f.server.db)
	if restartErr != nil {
		t.Fatal(restartErr)
	}
	if _, e = restarted.reserveGitReceive(t.Context(), cap, f.credential, route, request, config); !errors.Is(e, errGitReceiveUnknown) {
		t.Fatal("restart/same command resent", e)
	}
	request.Commands[0].New = strings.Repeat("3", 40)
	request.Digest[0]++
	if _, e = restarted.reserveGitReceive(t.Context(), cap, f.credential, route, request, config); !errors.Is(e, errGitReceiveUnknown) {
		t.Fatal("new digest bypassed unknown exclusion", e)
	}
	if _, e = f.server.db.Exec(`UPDATE golf_git_receive_operations SET phase='RESERVED',updated_at=clock_timestamp() WHERE id=$1`, op); e == nil {
		t.Fatal("unknown reset to retry")
	}
	if _, e = f.server.db.Exec(`DELETE FROM golf_git_receive_operations WHERE id=$1`, op); e == nil {
		t.Fatal("unknown journal deleted")
	}
	outcome, e := f.server.GetGitReceiveOutcome(f.ctx, gitTransportRequest(f, &golfv1.GetGitReceiveOutcomeRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "91", OwnerId: "42", OperationId: op}))
	if e != nil || outcome.Msg.Phase != "UNKNOWN" || outcome.Msg.AcceptedCount != nil {
		t.Fatal("status invented a completion", e)
	}
}

func TestManagedGitCompletedReceiveAndIndependentReceiptPostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	created := fixtureGitCredential(t, f)
	_, _ = seedManagedGitWriteFixture(t, f, created)
	response, e := f.server.CreateGitCredential(f.ctx, gitTransportRequest(f, &golfv1.CreateGitCredentialRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "91", OwnerId: "42", Label: "source-qualified write", Mode: golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_WRITE}))
	if e != nil {
		t.Fatal(e)
	}
	body := managedReceive("refs/heads/topic")
	w := fixtureGitHTTP(f, response.Msg.Secret, "POST", "/git/alice/example.git/git-receive-pack", body)
	if w.Code != 200 || f.posts.Load() != 1 || w.Header().Get("Golf-Git-Operation") == "" {
		t.Fatal("exact independent receive did not complete", w.Code)
	}
	var phase string
	var accepted, rejected int
	op := w.Header().Get("Golf-Git-Operation")
	if e = f.server.db.QueryRow(`SELECT phase,accepted_count,rejected_count FROM golf_git_receive_operations WHERE id=$1`, op).Scan(&phase, &accepted, &rejected); e != nil || phase != "COMPLETED" || accepted != 1 || rejected != 0 {
		t.Fatal("durable complete exact report", e)
	}
	if w := fixtureGitHTTP(f, response.Msg.Secret, "POST", "/git/alice/example.git/git-receive-pack", body); w.Code == 200 || f.posts.Load() != 1 {
		t.Fatal("same receive automatically redispatched", w.Code)
	}
	var events int
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_git_receive_events WHERE operation_id=$1`, op).Scan(&events); e != nil || events != 3 {
		t.Fatal("missing/duplicate reserve-dispatch-complete history", events, e)
	}
}
func TestManagedGitDispatchFailureRetainsUnknownPostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	created := fixtureGitCredential(t, f)
	_, _ = seedManagedGitWriteFixture(t, f, created)
	response, e := f.server.CreateGitCredential(f.ctx, gitTransportRequest(f, &golfv1.CreateGitCredentialRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "91", OwnerId: "42", Label: "failure fixture", Mode: golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_WRITE}))
	if e != nil {
		t.Fatal(e)
	}
	f.mode.Store(5)
	w := fixtureGitHTTP(f, response.Msg.Secret, "POST", "/git/alice/example.git/git-receive-pack", managedReceive("refs/heads/topic"))
	if w.Code == 200 || f.posts.Load() != 1 {
		t.Fatal("native failure hid dispatch uncertainty", w.Code)
	}
	var phase string
	if e = f.server.db.QueryRow(`SELECT phase FROM golf_git_receive_operations WHERE id=$1`, w.Header().Get("Golf-Git-Operation")).Scan(&phase); e != nil || phase != "UNKNOWN" {
		t.Fatal("native error released blocker", e)
	}
	f.mode.Store(0)
	replacement, e := f.server.CreateGitCredential(f.ctx, gitTransportRequest(f, &golfv1.CreateGitCredentialRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "91", OwnerId: "42", Label: "replacement fixture", Mode: golfv1.GitCredentialMode_GIT_CREDENTIAL_MODE_WRITE}))
	if !errors.Is(e, errLifecycleBlocked) {
		t.Fatal("new WRITE capability issued across unknown", e)
	}
	_ = replacement
	if w := fixtureGitHTTP(f, response.Msg.Secret, "POST", "/git/alice/example.git/git-receive-pack", managedReceive("refs/heads/topic")); w.Code != 409 || f.posts.Load() != 1 {
		t.Fatal("new credential bypassed unresolved repo effect", w.Code)
	}
}
