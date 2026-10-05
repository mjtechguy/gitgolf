package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func accessRequest(s *Server, session loginResult, procedure string, input any) *httptest.ResponseRecorder {
	body, _ := json.Marshal(input)
	r := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader(string(body)))
	r.Header.Set("Origin", s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	if session.Value != "" {
		r.AddCookie(s.sessionCookie(session.Value, session.Expires, 3600))
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func managementNativeID(login string) string {
	if login == "bob" {
		return "84"
	}
	return "42"
}
func accessInput(target LocalAccountResult, version string, suspended bool) *golfv1.ChangeGolfUserAccessRequest {
	return &golfv1.ChangeGolfUserAccessRequest{GolfUserId: target.UserID, NativeUserId: managementNativeID(target.Username), ExpectedVersion: version, Suspended: suspended, Reason: "Access policy review", PasswordConfirmation: localTestPassword, OperationId: uuid.NewString()}
}
func TestGolfUserAccessInput(t *testing.T) {
	m := &golfv1.ChangeGolfUserAccessRequest{GolfUserId: "1", NativeUserId: "2", ExpectedVersion: "0", Suspended: true, Reason: " test ", OperationId: uuid.NewString()}
	i, a, e := parseGolfAccessIntent(m)
	if e != nil || i.Reason != "test" {
		t.Fatal(e)
	}
	m.PasswordConfirmation = "another password"
	_, b, e := parseGolfAccessIntent(m)
	if e != nil || string(a) != string(b) {
		t.Fatal("password retained in fingerprint")
	}
	for _, modify := range []func(*golfv1.ChangeGolfUserAccessRequest){func(m *golfv1.ChangeGolfUserAccessRequest) { m.GolfUserId = "01" }, func(m *golfv1.ChangeGolfUserAccessRequest) { m.NativeUserId = "0" }, func(m *golfv1.ChangeGolfUserAccessRequest) { m.ExpectedVersion = "00" }, func(m *golfv1.ChangeGolfUserAccessRequest) { m.ExpectedVersion = "9223372036854775807" }, func(m *golfv1.ChangeGolfUserAccessRequest) { m.OperationId = "bad" }, func(m *golfv1.ChangeGolfUserAccessRequest) { m.Reason = " " }, func(m *golfv1.ChangeGolfUserAccessRequest) { m.Reason = strings.Repeat("x", 1025) }, func(m *golfv1.ChangeGolfUserAccessRequest) { m.Reason = "a\x00b" }} {
		x := proto.Clone(m).(*golfv1.ChangeGolfUserAccessRequest)
		modify(x)
		if _, _, e = parseGolfAccessIntent(x); e == nil {
			t.Fatal("invalid intent accepted")
		}
	}
}
func TestGolfUserAccessBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{golfv1connect.InstanceAdminServiceListGolfUserAccessProcedure, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, golfv1connect.InstanceAdminServiceGetGolfUserAccessOperationProcedure} {
		if w := accessRequest(s, loginResult{}, p, map[string]string{}); w.Code != 401 {
			t.Fatal(p, w.Code)
		}
		if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), p, "malformed"); w.Code != 403 {
			t.Fatal("delegated admission", w.Code)
		}
	}
}
func TestGolfUserAccessLifecyclePostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	local := localLogin(t, f, "bob")
	pat := f.session(t, "bob", "pat")
	// OAuth payloads use the fixture's Alice access token; its immutable Bob
	// source still exercises the resolver and re-entry boundaries without relying
	// on an invented native identity response.
	oauth := f.session(t, "bob", "oauth")
	delegate := issueApiCredential(t, apiManagementClient(t, f, pat), "suspended read", 0)
	grantID := uuid.NewString()
	if _, e := f.db.Exec(`INSERT INTO golf_automation_grants(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,sponsor_user_id,sponsor_native_user_id,expires_at,idempotency_key,input_hash,branches,workflow_paths) VALUES($1,$2,7,84,'bob','project',false,$3,84,clock_timestamp()+interval '1 hour',$4,$5,'["main"]','[".github/workflows/check.yml"]')`, grantID, f.s.config.GiteaURL, bob.UserID, uuid.NewString(), make([]byte, 32)); e != nil {
		t.Fatal(e)
	}
	input := accessInput(bob, "0", true)
	for _, actor := range []loginResult{local, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		if w := accessRequest(f.s, actor, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, input); w.Code != 403 {
			t.Fatal("wrong source changed user access", w.Code)
		}
	}
	wrong := proto.Clone(input).(*golfv1.ChangeGolfUserAccessRequest)
	wrong.PasswordConfirmation = "The wrong password confirmation!"
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, wrong); w.Code != 403 || w.Header().Get("Golf-Access-Outcome") != "rejected" {
		t.Fatal("wrong confirmation lacks definite rejection", w.Code, w.Header().Get("Golf-Access-Outcome"))
	}
	w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, input)
	if w.Code != 200 {
		t.Fatal("suspend", w.Code, w.Body.String())
	}
	result := &golfv1.ChangeGolfUserAccessResponse{}
	if e := protojson.Unmarshal(w.Body.Bytes(), result); e != nil {
		t.Fatal(e)
	}
	if result.Operation.SessionsRevoked != 3 || result.Operation.AutomationGrantsRevoked != 1 || !result.User.Suspended || result.User.Version != "1" {
		t.Fatal("receipt", result)
	}
	for _, session := range []loginResult{local, pat, oauth} {
		if _, e := f.s.sessionCredential(context.Background(), session.Value); !errors.Is(e, errUnauthenticated) {
			t.Fatal("old session usable", e)
		}
	}
	if w := apiRequest(f.s, delegate.Token, golfv1connect.RepositoryServiceListRepositoriesProcedure, `{}`); w.Code != 401 {
		t.Fatal("dependent API survived", w.Code)
	}
	if _, e := f.s.loginLocalSession(context.Background(), "bob", localTestPassword, ""); e == nil {
		t.Fatal("local login restored suspended access")
	}
	if _, e := f.s.createSession(context.Background(), User{ID: 84, Login: "bob"}, "pat", "bob-management-token", ""); !errors.Is(e, errUnauthenticated) {
		t.Fatal("PAT re-entry", e)
	}
	if _, e := f.s.createSession(context.Background(), User{ID: 84, Login: "bob"}, "oauth", "fixture-payload", ""); !errors.Is(e, errUnauthenticated) {
		t.Fatal("OAuth re-entry", e)
	}
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, input); w.Code != 200 {
		t.Fatal("exact retry", w.Code)
	}
	inspect := &golfv1.GetGolfUserAccessOperationRequest{GolfUserId: bob.UserID, NativeUserId: managementNativeID(bob.Username), OperationId: input.OperationId}
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceGetGolfUserAccessOperationProcedure, inspect); w.Code != 200 {
		t.Fatal("inspect", w.Code)
	}
	changed := proto.Clone(input).(*golfv1.ChangeGolfUserAccessRequest)
	changed.Reason = "different exact intent"
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, changed); w.Code != 409 {
		t.Fatal("UUID rebound", w.Code)
	}
	wrong = accessInput(bob, "1", false)
	wrong.NativeUserId = "42"
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, wrong); w.Code != 404 {
		t.Fatal("native ID rebound", w.Code)
	}
	restore := accessInput(bob, "1", false)
	w = accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, restore)
	if w.Code != 200 {
		t.Fatal("restore", w.Code, w.Body.String())
	}
	if e := protojson.Unmarshal(w.Body.Bytes(), result); e != nil {
		t.Fatal(e)
	}
	if result.Operation.SessionsRevoked != 0 || result.User.Suspended || result.User.Version != "2" {
		t.Fatal("restore receipt")
	}
	var enabled bool
	var revision, epoch int64
	if e := f.db.QueryRow(`SELECT enabled,revision,revocation_epoch FROM golf_automation_grants WHERE id=$1`, grantID).Scan(&enabled, &revision, &epoch); e != nil || enabled || revision != 2 || epoch != 2 {
		t.Fatal("restore resurrected automation grant", e)
	}
	var events int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_automation_grant_events WHERE grant_id=$1 AND action='REVOKED'`, grantID).Scan(&events); e != nil || events != 1 {
		t.Fatal("grant revocation receipt", e, events)
	}
	localLogin(t, f, "bob")
	for _, session := range []loginResult{local, pat, oauth} {
		if _, e := f.s.sessionCredential(context.Background(), session.Value); !errors.Is(e, errUnauthenticated) {
			t.Fatal("restore resurrected session", e)
		}
	}
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, accessInput(bob, "0", true)); w.Code != 409 {
		t.Fatal("stale version", w.Code)
	}
	var history int
	if e := f.db.QueryRow("SELECT count(*) FROM golf_user_access_operations").Scan(&history); e != nil || history != 2 {
		t.Fatal("history", e, history)
	}
	if _, e := f.db.Exec("UPDATE golf_user_access_operations SET reason='edited'"); e == nil {
		t.Fatal("receipt mutable")
	}
}
func TestGolfUserAccessAdminRacePostgres(t *testing.T) {
	f := newManagementFixture(t)
	alice := enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", true)
	a := localLogin(t, f, "alice")
	b := localLogin(t, f, "bob")
	if w := accessRequest(f.s, a, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, accessInput(alice, "0", true)); w.Code != 403 {
		t.Fatal("self suspension", w.Code)
	}
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 2)
	for _, p := range []struct {
		session loginResult
		target  LocalAccountResult
	}{{a, bob}, {b, alice}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- accessRequest(f.s, p.session, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, accessInput(p.target, "0", true))
		}()
	}
	wg.Wait()
	close(results)
	accepted := 0
	for response := range results {
		code := response.Code
		if code == 200 {
			accepted++
		} else if code != 401 && code != 403 {
			t.Fatal("concurrent admin outcome", code, response.Body.String())
		}
	}
	if accepted != 1 {
		t.Fatal("administrators not serialized", accepted)
	}
	var active int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_users u WHERE EXISTS(SELECT 1 FROM golf_local_accounts l WHERE l.user_id=u.id AND l.is_instance_admin AND l.disabled_at IS NULL) AND NOT EXISTS(SELECT 1 FROM golf_user_access a WHERE a.user_id=u.id AND a.suspended)`).Scan(&active); e != nil || active != 1 {
		t.Fatal("last active admin", active, e)
	}
}
func TestGolfUserAccessLockedGuardsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	session := localLogin(t, f, "bob")
	_, uid, hash := f.id(t, session)
	var native int64
	if e := f.db.QueryRow("SELECT forge_user_id FROM golf_users WHERE id=$1", uid).Scan(&native); e != nil {
		t.Fatal(e)
	}
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, accessInput(bob, "0", true)); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if e := f.s.codexGuard(context.Background(), codexActor{UserID: uid, NativeID: native, Hash: hash}, func(_ *sql.Tx, _ int64) error { return nil }); e == nil {
		t.Fatal("agent guard allowed suspended source")
	}
}

func TestGolfUserAccessLateReadsPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newManagementFixture(t)
			alice := enrollLocal(t, f, "alice", false)
			enrollLocal(t, f, "bob", true)
			admin := localLogin(t, f, "bob")
			source := f.session(t, "alice", kind)
			f.mode.Store(3)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				done <- accessRequest(f.s, source, golfv1connect.SessionServiceGetSessionProcedure, map[string]string{})
			}()
			select {
			case <-f.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("read never reached provider")
			}
			f.mode.Store(0)
			if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, accessInput(alice, "0", true)); w.Code != 200 {
				t.Fatal("suspend during read", w.Code, w.Body.String())
			}
			close(f.resume)
			select {
			case w := <-done:
				if w.Code != 401 || strings.Contains(w.Body.String(), "alice") {
					t.Fatal("late private response escaped", w.Code, w.Body.String())
				}
			case <-time.After(5 * time.Second):
				t.Fatal("read did not finish")
			}
		})
	}
}
func TestGolfUserAccessPasswordEnrollmentSeparatePostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	if w := disableAccountRequest(f.s, admin, bob.ID, "1", localTestPassword); w.Code != 200 {
		t.Fatal("local disable", w.Code)
	}
	for _, m := range []*golfv1.ChangeGolfUserAccessRequest{accessInput(bob, "0", true), accessInput(bob, "1", false)} {
		if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, m); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	var disabled bool
	id, _ := strconv.ParseInt(bob.ID, 10, 64)
	if e := f.db.QueryRow(`SELECT disabled_at IS NOT NULL FROM golf_local_accounts WHERE id=$1`, id).Scan(&disabled); e != nil || !disabled {
		t.Fatal("restoration enabled password enrollment", e)
	}
	if _, e := f.s.loginLocalSession(context.Background(), "bob", localTestPassword, ""); e == nil {
		t.Fatal("disabled password restored")
	}
	f.session(t, "bob", "pat")
}

// Add one native fixture administrator alongside the existing protocol fixture;
// all other supported API/Git/OAuth behavior stays on the original HTTP handler.
func accessAdminProvider(t *testing.T, s *Server, beforeToken func()) loginResult {
	t.Helper()
	original, _ := url.Parse(s.config.GiteaURL)
	proxy := httputil.NewSingleHostReverseProxy(original)
	facade := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/user" && r.Header.Get("Authorization") == "token bob-management-token" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"id":84,"login":"bob","is_admin":false}`))
			return
		}
		if beforeToken != nil && r.URL.Path == "/login/oauth/access_token" {
			beforeToken()
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(facade.Close)
	s.config.GiteaURL = facade.URL
	if _, e := ManageLocalAccount(t.Context(), s.db, s.keyring, facade.URL, "create", LocalAccountInput{Username: "bob", Password: localTestPassword, ForgeToken: "bob-management-token", IsInstanceAdmin: true}); e != nil {
		t.Fatal("fixture admin enrollment", e)
	}
	session, e := s.loginLocalSession(t.Context(), "bob", localTestPassword, "")
	if e != nil {
		t.Fatal("fixture admin login", e)
	}
	return session
}
func TestGolfUserAccessManagedGitPostgres(t *testing.T) {
	f := newGitTransportFixture(t)
	admin := accessAdminProvider(t, f.server, nil)
	var e error
	f.session, e = f.server.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", f.credential.Token, "")
	if e != nil {
		t.Fatal(e)
	}
	created := fixtureGitCredential(t, f)
	if w := fixtureGitHTTP(f, created.Secret, "GET", "/git/alice/example.git/info/refs?service=git-upload-pack", nil); w.Code != 200 {
		t.Fatal("baseline Git read", w.Code)
	}
	var uid int64
	if e = f.server.db.QueryRow(`SELECT user_id FROM golf_sessions WHERE token_hash=$1`, mustSessionHash(t, f.session.Value)).Scan(&uid); e != nil {
		t.Fatal(e)
	}
	m := &golfv1.ChangeGolfUserAccessRequest{GolfUserId: strconv.FormatInt(uid, 10), NativeUserId: "42", ExpectedVersion: "0", Suspended: true, Reason: "Managed Git access review", PasswordConfirmation: localTestPassword, OperationId: uuid.NewString()}
	if w := accessRequest(f.server, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, m); w.Code != 200 {
		t.Fatal("suspend Git owner", w.Code, w.Body.String())
	}
	before := f.forwards.Load()
	if w := fixtureGitHTTP(f, created.Secret, "GET", "/git/alice/example.git/info/refs?service=git-upload-pack", nil); w.Code != 401 {
		t.Fatal("suspended Git capability", w.Code)
	}
	if f.forwards.Load() != before {
		t.Fatal("suspended capability reached native Git")
	}
	m.ExpectedVersion = "1"
	m.Suspended = false
	m.OperationId = uuid.NewString()
	if w := accessRequest(f.server, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, m); w.Code != 200 {
		t.Fatal("restore Git owner", w.Code)
	}
	if w := fixtureGitHTTP(f, created.Secret, "GET", "/git/alice/example.git/info/refs?service=git-upload-pack", nil); w.Code != 401 {
		t.Fatal("restore resurrected managed Git capability", w.Code)
	}
}
func mustSessionHash(t *testing.T, value string) []byte {
	t.Helper()
	hash, e := sessionHash(value)
	if e != nil {
		t.Fatal(e)
	}
	return hash
}
func TestGolfUserAccessOAuthRefreshLockPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	entered := make(chan struct{})
	resume := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	})
	admin := accessAdminProvider(t, f.s, func() { once.Do(func() { close(entered) }); <-resume })
	source := f.expiredSession(t)
	hash := mustSessionHash(t, source.Value)
	var uid int64
	if e := f.db.QueryRow(`SELECT user_id FROM golf_sessions WHERE token_hash=$1`, hash).Scan(&uid); e != nil {
		t.Fatal(e)
	}
	refresh := make(chan error, 1)
	go func() { _, e := f.s.sessionCredential(context.Background(), source.Value); refresh <- e }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("refresh never entered provider")
	}
	m := &golfv1.ChangeGolfUserAccessRequest{GolfUserId: strconv.FormatInt(uid, 10), NativeUserId: "42", ExpectedVersion: "0", Suspended: true, Reason: "OAuth access review", PasswordConfirmation: localTestPassword, OperationId: uuid.NewString()}
	suspend := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		suspend <- accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, m)
	}()
	// The fixture polls only its own Golf user lock, never native storage.
	deadline := time.Now().Add(5 * time.Second)
	locked := false
	for time.Now().Before(deadline) {
		tx, e := f.db.BeginTx(t.Context(), nil)
		if e != nil {
			t.Fatal(e)
		}
		var id int64
		e = tx.QueryRow(`SELECT id FROM golf_users WHERE id=$1 FOR UPDATE NOWAIT`, uid).Scan(&id)
		tx.Rollback()
		if e != nil {
			locked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !locked {
		t.Fatal("suspension did not acquire source-user lock")
	}
	close(resume)
	select {
	case e := <-refresh:
		if e != nil && !errors.Is(e, errUnauthenticated) {
			t.Fatal("refresh completion", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("refresh deadlocked on user lock")
	}
	select {
	case w := <-suspend:
		if w.Code != 200 {
			t.Fatal("suspend after refresh", w.Code, w.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("suspension remained blocked")
	}
	if _, e := f.s.sessionCredential(t.Context(), source.Value); !errors.Is(e, errUnauthenticated) {
		t.Fatal("refreshed source survived suspension", e)
	}
	m.ExpectedVersion = "1"
	m.Suspended = false
	m.OperationId = uuid.NewString()
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, m); w.Code != 200 {
		t.Fatal("restore", w.Code)
	}
	if _, e := f.s.sessionCredential(t.Context(), source.Value); !errors.Is(e, errUnauthenticated) {
		t.Fatal("restoration resurrected refreshed source", e)
	}
}

func TestGolfUserAccessCommitUncertaintyPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	source := localLogin(t, f, "bob")
	if _, e := f.db.Exec(`CREATE FUNCTION access_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned commit fixture'; END $$; CREATE CONSTRAINT TRIGGER access_commit_failure AFTER INSERT ON golf_user_access_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access_commit_failure()`); e != nil {
		t.Fatal(e)
	}
	m := accessInput(bob, "0", true)
	w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceChangeGolfUserAccessProcedure, m)
	if w.Code != 503 || w.Header().Get("Golf-Access-Outcome") != "" {
		t.Fatal("commit uncertainty falsely marked rejected", w.Code, w.Header().Get("Golf-Access-Outcome"))
	}
	inspect := &golfv1.GetGolfUserAccessOperationRequest{GolfUserId: m.GolfUserId, NativeUserId: m.NativeUserId, OperationId: m.OperationId}
	if w := accessRequest(f.s, admin, golfv1connect.InstanceAdminServiceGetGolfUserAccessOperationProcedure, inspect); w.Code != 404 {
		t.Fatal("failed commit left accepted receipt", w.Code)
	}
	if _, e := f.s.sessionCredential(t.Context(), source.Value); e != nil {
		t.Fatal("failed commit revoked source", e)
	}
	var count int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_user_access`).Scan(&count); e != nil || count != 0 {
		t.Fatal("failed commit changed current access", e, count)
	}
}
