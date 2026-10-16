package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

// Only the external Codex process is substituted. The RPC cookie boundary,
// immutable Golf identities, PostgreSQL ownership/CAS and AES-GCM are real.
func codexFixture(t *testing.T) (*managementFixture, loginResult, string) {
	return codexFixtureRole(t, false)
}
func codexFixtureRole(t *testing.T, admin bool) (*managementFixture, loginResult, string) {
	t.Helper()
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", admin)
	login := localLogin(t, f, "alice")
	python, e := exec.LookPath("python3")
	if e != nil {
		t.Skip("python3 native protocol fixture required")
	}
	root := t.TempDir()
	marker := filepath.Join(root, "control")
	src := `#!` + python + `
import json,os,sys,time,threading
home=os.environ['CODEX_HOME'];auth=home+'/auth.json';control=` + strconvJSON(marker) + `
lock=threading.Lock()
def emit(v):
 with lock: print(json.dumps(v),flush=True)
def write(v):
 with open(auth,'w') as f: json.dump(v,f)
 os.chmod(auth,0o600)
def complete():
 while not os.path.exists(control+'.complete'): time.sleep(.01)
 write({'mode':'chatgpt','fixture_refresh':'private-refresh'})
 emit({'method':'account/login/completed','params':{'loginId':'fixture-login','success':True}})
for line in sys.stdin:
 r=json.loads(line);i=r.get('id');m=r.get('method');p=r.get('params',{})
 if i is None: continue
 result={}
 if m=='account/logout':
  try: os.unlink(auth)
  except FileNotFoundError: pass
 elif m=='account/login/start':
  if p['type']=='apiKey':
   write({'mode':'apiKey','OPENAI_API_KEY':p['apiKey'],'serial':0});result={'type':'apiKey'}
  else:
   result={'type':'chatgptDeviceCode','loginId':'fixture-login','verificationUrl':'https://auth.openai.com/codex/device','userCode':'ABCD-EFGH'}
   if os.path.exists(control+'.async'):threading.Thread(target=complete,daemon=True).start()
 elif m=='account/rateLimits/read':
  result={'rateLimits':{'limitId':'codex','primary':{'usedPercent':25,'windowDurationMins':300,'resetsAt':1781654400}},'rateLimitResetCredits':{'availableCount':2}}
 elif m=='account/read':
  if os.path.exists(control+'.block'):
   open(control+'.entered','w').close()
   while not os.path.exists(control+'.resume'):time.sleep(.01)
  try:
   with open(auth) as f:v=json.load(f)
  except FileNotFoundError:v={}
  if v:
   v['serial']=v.get('serial',0)+1;write(v)
  if os.path.exists(control+'.fail'):
   emit({'id':i,'error':{'code':-32000,'message':'private-provider-error sk-never-expose'}});continue
  if v.get('mode')=='chatgpt':result={'account':{'type':'chatgpt','email':'fixture@example.com','planType':'plus'},'requiresOpenaiAuth':True}
  elif v:result={'account':{'type':'apiKey'},'requiresOpenaiAuth':True}
  else:result={'account':None,'requiresOpenaiAuth':True}
 emit({'id':i,'result':result})
`
	binary := filepath.Join(root, "codex-fixture")
	if e = os.WriteFile(binary, []byte(src), 0700); e != nil {
		t.Fatal(e)
	}
	f.s.config.CodexBinary = binary
	t.Cleanup(func() { f.s.CloseCodexAccounts() })
	return f, login, marker
}
func strconvJSON(v string) string { b, _ := json.Marshal(v); return string(b) }
func codexCall(s *Server, session loginResult, method string, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/rpc/golf.v1.CodexAccountService/"+method, strings.NewReader(body))
	r.Header.Set("Origin", s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	r.AddCookie(&http.Cookie{Name: cookieName, Value: session.Value})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func codexResponse(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("Codex RPC failed: status %d", w.Code)
	}
	var v struct {
		Connection map[string]any `json:"connection"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v.Connection
}
func codexExpect(t *testing.T, v map[string]any, state string) string {
	t.Helper()
	if v["state"] != state || v["modelVerified"] == true {
		t.Fatalf("unexpected Codex state %v", v["state"])
	}
	return v["version"].(string)
}

const fixtureCodexKey = "sk-0123456789abcdefghijklmnopqrstuvwxyz"

func TestCodexAccountEncryptionRestartAndIsolationPostgres(t *testing.T) {
	f, login, marker := codexFixture(t)
	v := codexResponse(t, codexCall(f.s, login, "GetCodexConnection", "{}"))
	version := codexExpect(t, v, "CODEX_CONNECTION_STATE_UNCONFIGURED")
	v = codexResponse(t, codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`","expectedVersion":"`+version+`"}`))
	version = codexExpect(t, v, "CODEX_CONNECTION_STATE_CONNECTED")
	if bytes.Contains(codexCall(f.s, login, "GetCodexConnection", "{}").Body.Bytes(), []byte(fixtureCodexKey)) {
		t.Fatal("credential exposed")
	}
	var ciphertext, binding []byte
	var id, key string
	if e := f.db.QueryRow(`SELECT c.id::text,a.encrypted_credential,a.credential_binding,a.credential_key_id FROM golf_codex_connections c JOIN golf_codex_auth a ON a.connection_id=c.id`).Scan(&id, &ciphertext, &binding, &key); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(ciphertext, []byte(fixtureCodexKey)) {
		t.Fatal("plaintext stored")
	}
	plain, e := f.s.keyring.open(key, infrastructureConnectionDomain, ciphertext, codexBinding(id))
	if e != nil || !strings.Contains(plain, fixtureCodexKey) {
		t.Fatal("native state not encrypted/restorable")
	}
	if _, e = f.s.keyring.open(key, infrastructureConnectionDomain, ciphertext, codexBinding("another-owner")); e == nil {
		t.Fatal("cross-owner binding accepted")
	}
	pat := f.session(t, "alice", "pat")
	if w := codexCall(f.s, pat, "GetCodexConnection", "{}"); w.Code != 403 {
		t.Fatalf("bootstrap token allowed: %d", w.Code)
	}
	oauth := f.session(t, "alice", "oauth")
	codexExpect(t, codexResponse(t, codexCall(f.s, oauth, "GetCodexConnection", "{}")), "CODEX_CONNECTION_STATE_CONNECTED")
	enrollLocal(t, f, "bob", false)
	bob := localLogin(t, f, "bob")
	codexExpect(t, codexResponse(t, codexCall(f.s, bob, "GetCodexConnection", "{}")), "CODEX_CONNECTION_STATE_UNCONFIGURED")
	if w := codexCall(f.s, bob, "DisconnectCodexConnection", `{"expectedVersion":"`+version+`"}`); w.Code != 400 {
		t.Fatal("foreign version accepted")
	}
	f.s.CloseCodexAccounts()
	next, e := New(f.s.config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	f.s = next
	v = codexResponse(t, codexCall(f.s, login, "RefreshCodexConnection", `{"expectedVersion":"`+version+`"}`))
	version = codexExpect(t, v, "CODEX_CONNECTION_STATE_CONNECTED")
	// Refreshed native writes must survive even provider-level refresh failures.
	if e = os.WriteFile(marker+".fail", nil, 0600); e != nil {
		t.Fatal(e)
	}
	v = codexResponse(t, codexCall(f.s, login, "RefreshCodexConnection", `{"expectedVersion":"`+version+`"}`))
	version = codexExpect(t, v, "CODEX_CONNECTION_STATE_REAUTH_REQUIRED")
	if v["reasonCode"] != "provider_refresh_failed" || v["email"] != nil {
		t.Fatal("refresh failure not safely represented")
	}
	if e = f.db.QueryRow(`SELECT encrypted_credential FROM golf_codex_auth WHERE connection_id=$1`, id).Scan(&ciphertext); e != nil {
		t.Fatal(e)
	}
	plain, e = f.s.keyring.open(key, infrastructureConnectionDomain, ciphertext, codexBinding(id))
	if e != nil || !strings.Contains(plain, `"serial": 3`) {
		t.Fatal("failed refresh native writes lost")
	}
	if w := codexCall(f.s, login, "DisconnectCodexConnection", `{"expectedVersion":"2"}`); w.Code != 400 {
		t.Fatal("stale disconnect accepted")
	}
	f.s.config.CodexBinary = ""
	v = codexResponse(t, codexCall(f.s, login, "DisconnectCodexConnection", `{"expectedVersion":"`+version+`"}`))
	codexExpect(t, v, "CODEX_CONNECTION_STATE_UNAVAILABLE")
	var n int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_codex_auth`).Scan(&n); e != nil || n != 0 {
		t.Fatal("disconnect retained credential")
	}
	var events int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_audit_events WHERE action LIKE 'CODEX_%'`).Scan(&events); e != nil || events < 4 {
		t.Fatal("account audit missing", e)
	}
}
func TestCodexDeviceCancelCompletionAndRestartPostgres(t *testing.T) {
	f, login, marker := codexFixture(t)
	start := func(version string) map[string]any {
		return codexResponse(t, codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_CHATGPT_DEVICE","expectedVersion":"`+version+`"}`))
	}
	v := start("0")
	version := codexExpect(t, v, "CODEX_CONNECTION_STATE_AWAITING_AUTH")
	if v["verificationUrl"] != "https://auth.openai.com/codex/device" || v["userCode"] != "ABCD-EFGH" {
		t.Fatal("native device challenge missing")
	}
	if w := codexCall(f.s, login, "CancelCodexLogin", `{"loginId":"another-login","expectedVersion":"`+version+`"}`); w.Code != 400 {
		t.Fatal("foreign login cancellation accepted")
	}
	// A newly signed-in browser may cancel; completion retains original actor.
	if e := f.s.logoutSession(context.Background(), login.Value); e != nil {
		t.Fatal(e)
	}
	login = localLogin(t, f, "alice")
	v = codexResponse(t, codexCall(f.s, login, "CancelCodexLogin", `{"loginId":"fixture-login","expectedVersion":"`+version+`"}`))
	version = codexExpect(t, v, "CODEX_CONNECTION_STATE_REAUTH_REQUIRED")
	v = start(version)
	version = codexExpect(t, v, "CODEX_CONNECTION_STATE_AWAITING_AUTH")
	f.s.CloseCodexAccounts()
	next, e := New(f.s.config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	f.s = next
	v = codexResponse(t, codexCall(f.s, login, "GetCodexConnection", "{}"))
	version = codexExpect(t, v, "CODEX_CONNECTION_STATE_REAUTH_REQUIRED")
	if v["reasonCode"] != "login_interrupted" || v["loginId"] != nil {
		t.Fatal("interrupted login remains actionable")
	}
	os.WriteFile(marker+".async", nil, 0600)
	v = start(version)
	codexExpect(t, v, "CODEX_CONNECTION_STATE_AWAITING_AUTH")
	os.WriteFile(marker+".complete", nil, 0600)
	until := time.Now().Add(5 * time.Second)
	for {
		v = codexResponse(t, codexCall(f.s, login, "GetCodexConnection", "{}"))
		if v["state"] == "CODEX_CONNECTION_STATE_CONNECTED" {
			break
		}
		if time.Now().After(until) {
			t.Fatal("native completion not persisted")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if v["email"] != "fixture@example.com" || v["planType"] != "plus" || v["loginId"] != nil || v["modelVerified"] == true {
		t.Fatal("native metadata wrong")
	}
}
func TestCodexRPCOriginAndDelegationPostgres(t *testing.T) {
	f, login, _ := codexFixture(t)
	source := issueApiCredential(t, apiManagementClient(t, f, login), "codex-denied", 3600)
	if w := apiRequest(f.s, source.Token, golfv1connect.CodexAccountServiceGetCodexConnectionProcedure, "{}"); w.Code != 403 {
		t.Fatal("delegated API allowed")
	}
	for _, method := range []string{"GetCodexConnection", "StartCodexLogin", "CompleteAgentLogin", "CancelCodexLogin", "RefreshCodexConnection", "DisconnectCodexConnection"} {
		r := httptest.NewRequest("POST", "/rpc/golf.v1.CodexAccountService/"+method, strings.NewReader("{}"))
		r.Header.Set("Origin", "http://wrong-origin.invalid")
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: cookieName, Value: login.Value})
		w := httptest.NewRecorder()
		f.s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("cross-origin allowed")
		}
	}
}

func waitCodexMarker(t *testing.T, path string) {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for {
		if _, e := os.Stat(path); e == nil {
			return
		}
		if time.Now().After(until) {
			t.Fatal("provider fixture did not enter wait")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestCodexProviderWaitRevocationAndOwnerLossPostgres(t *testing.T) {
	f, login, marker := codexFixture(t)
	v := codexResponse(t, codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`","expectedVersion":"0"}`))
	version := codexExpect(t, v, "CODEX_CONNECTION_STATE_CONNECTED")
	os.WriteFile(marker+".block", nil, 0600)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- codexCall(f.s, login, "RefreshCodexConnection", `{"expectedVersion":"`+version+`"}`) }()
	waitCodexMarker(t, marker+".entered")
	if e := f.s.logoutSession(context.Background(), login.Value); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(marker+".resume", nil, 0600)
	if w := <-done; w.Code != 401 {
		t.Fatal("revoked initiating caller completed provider refresh", w.Code)
	}
	os.Remove(marker + ".block")
	login = localLogin(t, f, "alice")
	v = codexResponse(t, codexCall(f.s, login, "GetCodexConnection", "{}"))
	if v["version"] != version {
		t.Fatal("revoked callback changed connection")
	}
	v = codexResponse(t, codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_CHATGPT_DEVICE","expectedVersion":"`+version+`"}`))
	codexExpect(t, v, "CODEX_CONNECTION_STATE_AWAITING_AUTH")
	f.s.codexMu.Lock()
	var rt *codexRuntime
	for _, r := range f.s.codexRuntimes {
		rt = r
	}
	f.s.codexMu.Unlock()
	var pid int
	if e := rt.conn.QueryRowContext(context.Background(), `SELECT pg_backend_pid()`).Scan(&pid); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Exec(`SELECT pg_terminate_backend($1)`, pid); e != nil {
		t.Fatal(e)
	}
	select {
	case <-rt.done:
	case <-time.After(5 * time.Second):
		t.Fatal("broker survived lost ownership")
	}
	until := time.Now().Add(5 * time.Second)
	for {
		v = codexResponse(t, codexCall(f.s, login, "GetCodexConnection", "{}"))
		if v["state"] == "CODEX_CONNECTION_STATE_REAUTH_REQUIRED" {
			break
		}
		if time.Now().After(until) {
			t.Fatal("lost login not reconciled")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
func TestCodexAuthKeyLifecyclePostgres(t *testing.T) {
	f, login, _ := codexFixture(t)
	codexExpect(t, codexResponse(t, codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`","expectedVersion":"0"}`)), "CODEX_CONNECTION_STATE_CONNECTED")
	f.s.CloseCodexAccounts()
	keys := rotationKeys(t, f.s.config)
	status, e := KeyStatus(context.Background(), f.db, keys)
	if e != nil {
		t.Fatal(e)
	}
	var count uint64
	for _, u := range status.Keys {
		if u.KeyID == "legacy" {
			count = u.InfrastructureConnections
		}
	}
	if count != 1 {
		t.Fatal("Codex key use omitted")
	}
	if _, e = CheckKeyRetirement(context.Background(), f.db, keys, "legacy"); e == nil {
		t.Fatal("Codex-used key retired")
	}
	mustActivate(t, f.db, keys)
	result, e := RotateCredentials(context.Background(), f.db, keys, 1, 8)
	if e != nil || !result.Complete || result.RotatedInfrastructureConnections != 1 {
		t.Fatal("Codex key rotation omitted", e)
	}
	var ciphertext, binding []byte
	var key string
	if e = f.db.QueryRow(`SELECT encrypted_credential,credential_binding,credential_key_id FROM golf_codex_auth`).Scan(&ciphertext, &binding, &key); e != nil {
		t.Fatal(e)
	}
	plain, e := keys.open(key, infrastructureConnectionDomain, ciphertext, binding)
	if e != nil || key != "next" || !strings.Contains(plain, fixtureCodexKey) {
		t.Fatal("rotated native auth invalid")
	}
	if _, e = CheckKeyRetirement(context.Background(), f.db, keys, "legacy"); e != nil {
		t.Fatal("old key retirement blocked after full rotation", e)
	}
}

func TestCodexAuditFailureRollsBackAndDisableWaitPostgres(t *testing.T) {
	f, login, marker := codexFixture(t)
	if _, e := f.db.Exec(`CREATE FUNCTION reject_codex_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'CODEX_%' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_codex_audit BEFORE INSERT ON golf_audit_events FOR EACH ROW EXECUTE FUNCTION reject_codex_audit()`); e != nil {
		t.Fatal(e)
	}
	if w := codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`","expectedVersion":"0"}`); w.Code == 200 {
		t.Fatal("audit failure admitted credentials")
	}
	var n int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_codex_connections`).Scan(&n); e != nil || n != 0 {
		t.Fatal("failed audit left partial connection")
	}
	if _, e := f.db.Exec(`DROP TRIGGER reject_codex_audit ON golf_audit_events;DROP FUNCTION reject_codex_audit()`); e != nil {
		t.Fatal(e)
	}
	v := codexResponse(t, codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`","expectedVersion":"0"}`))
	version := codexExpect(t, v, "CODEX_CONNECTION_STATE_CONNECTED")
	os.WriteFile(marker+".block", nil, 0600)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- codexCall(f.s, login, "RefreshCodexConnection", `{"expectedVersion":"`+version+`"}`) }()
	waitCodexMarker(t, marker+".entered")
	if _, e := ManageLocalAccount(context.Background(), f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "alice"}); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(marker+".resume", nil, 0600)
	if w := <-done; w.Code != 401 {
		t.Fatal("disabled caller persisted provider work", w.Code)
	}
	var storedVersion string
	if e := f.db.QueryRow(`SELECT version::text FROM golf_codex_connections`).Scan(&storedVersion); e != nil || storedVersion != version {
		t.Fatal("disabled callback mutated connection")
	}
}

func TestCodexUsageRefreshPostgres(t *testing.T) {
	f, login, marker := codexFixture(t)
	os.WriteFile(marker+".async", nil, 0600)
	codexResponse(t, codexCall(f.s, login, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_CHATGPT_DEVICE","expectedVersion":"0"}`))
	os.WriteFile(marker+".complete", nil, 0600)
	until := time.Now().Add(5 * time.Second)
	var c map[string]any
	for {
		c = codexResponse(t, codexCall(f.s, login, "GetCodexConnection", "{}"))
		if c["state"] == "CODEX_CONNECTION_STATE_CONNECTED" {
			break
		}
		if time.Now().After(until) {
			t.Fatal("completion timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
	w := codexCall(f.s, login, "RefreshCodexConnection", `{"expectedVersion":"`+c["version"].(string)+`"}`)
	var response struct {
		Usage struct {
			Available    bool
			BankedResets *uint32
			Buckets      []struct {
				Primary struct {
					UsedPercent        float64
					WindowDurationMins uint32
					ResetsAt           string
				}
			}
		}
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || !response.Usage.Available || response.Usage.BankedResets == nil || *response.Usage.BankedResets != 2 || len(response.Usage.Buckets) != 1 || response.Usage.Buckets[0].Primary.UsedPercent != 25 || response.Usage.Buckets[0].Primary.WindowDurationMins != 300 || response.Usage.Buckets[0].Primary.ResetsAt == "" {
		t.Fatal("provider usage did not survive authenticated refresh")
	}
	if bytes.Contains(w.Body.Bytes(), []byte("private-refresh")) {
		t.Fatal("provider credentials exposed")
	}
}
