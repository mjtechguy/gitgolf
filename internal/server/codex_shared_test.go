package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func sharedCodexCreate(t *testing.T, f *managementFixture, admin loginResult, name string) map[string]any {
	t.Helper()
	return codexResponse(t, codexCall(f.s, admin, "CreateCodexConnection", `{"name":"`+name+`"}`))
}
func sharedCodexAccess(t *testing.T, f *managementFixture, admin loginResult, c map[string]any, ids ...string) map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"connectionId": c["id"], "expectedVersion": c["version"], "name": c["name"], "allowedUserIds": ids})
	return codexResponse(t, codexCall(f.s, admin, "SetCodexConnectionAccess", string(b)))
}
func sharedCodexList(t *testing.T, f *managementFixture, caller loginResult, admin bool) []map[string]any {
	t.Helper()
	body := `{"instanceAdmin":false}`
	if admin {
		body = `{"instanceAdmin":true}`
	}
	w := codexCall(f.s, caller, "ListCodexConnections", body)
	if w.Code != 200 {
		t.Fatal("inventory failed", w.Code)
	}
	var result struct {
		Connections []map[string]any `json:"connections"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	return result.Connections
}
func TestCodexSharedAuthorizationAndInventoryPostgres(t *testing.T) {
	f, admin, _ := codexFixtureRole(t, true)
	bobAccount := enrollLocal(t, f, "bob", false)
	bob := localLogin(t, f, "bob")
	shared := sharedCodexCreate(t, f, admin, "Engineering Codex")
	id := shared["id"].(string)
	if shared["canManage"] != true || shared["canUse"] == true || shared["scope"] != "CODEX_CONNECTION_SCOPE_INSTANCE" {
		t.Fatal("management implicitly granted shared usage")
	}
	if len(sharedCodexList(t, f, bob, false)) != 1 {
		t.Fatal("ungranted shared inventory disclosed")
	}
	if w := codexCall(f.s, bob, "GetCodexConnection", `{"connectionId":"`+id+`"}`); w.Code != 404 {
		t.Fatal("ungranted shared lookup disclosed")
	}
	if w := codexCall(f.s, bob, "ListCodexConnections", `{"instanceAdmin":true}`); w.Code != 403 {
		t.Fatal("ordinary user acquired admin inventory")
	}
	if w := codexCall(f.s, bob, "CreateCodexConnection", `{"name":"unauthorized"}`); w.Code != 403 {
		t.Fatal("ordinary user created instance account")
	}
	oauth := f.session(t, "alice", "oauth")
	if w := codexCall(f.s, oauth, "ListCodexConnections", `{"instanceAdmin":true}`); w.Code != 403 {
		t.Fatal("native OAuth acquired local administrator authority")
	}
	shared = sharedCodexAccess(t, f, admin, shared, bobAccount.UserID)
	list := sharedCodexList(t, f, bob, false)
	if len(list) != 2 {
		t.Fatal("selected user missing shared account")
	}
	view := list[1]
	if view["id"] != id || view["canUse"] != true || view["canManage"] == true || view["allowedUserIds"] != nil {
		t.Fatal("shared use permission leaked manager projection")
	}
	for _, method := range []string{"StartCodexLogin", "CancelCodexLogin", "RefreshCodexConnection", "DisconnectCodexConnection", "SetCodexConnectionAccess"} {
		body := `{"connectionId":"` + id + `","expectedVersion":"` + shared["version"].(string) + `"}`
		if method == "StartCodexLogin" {
			body = `{"connectionId":"` + id + `","expectedVersion":"` + shared["version"].(string) + `","method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"` + fixtureCodexKey + `"}`
		}
		if method == "CancelCodexLogin" {
			body = `{"connectionId":"` + id + `","expectedVersion":"` + shared["version"].(string) + `","loginId":"fixture-login"}`
		}
		if w := codexCall(f.s, bob, method, body); w.Code != 403 {
			t.Fatal("selected user acquired manager method", method, w.Code)
		}
	}
	shared = codexResponse(t, codexCall(f.s, admin, "StartCodexLogin", `{"connectionId":"`+id+`","expectedVersion":"`+shared["version"].(string)+`","method":"CODEX_LOGIN_METHOD_CHATGPT_DEVICE"}`))
	codexExpect(t, shared, "CODEX_CONNECTION_STATE_AWAITING_AUTH")
	view = codexResponse(t, codexCall(f.s, bob, "GetCodexConnection", `{"connectionId":"`+id+`"}`))
	for _, k := range []string{"loginId", "userCode", "verificationUrl", "loginExpiresAt", "allowedUserIds"} {
		if view[k] != nil {
			t.Fatal("selected user received manager material", k)
		}
	}
	shared = sharedCodexAccess(t, f, admin, shared)
	codexExpect(t, shared, "CODEX_CONNECTION_STATE_REAUTH_REQUIRED")
	if w := codexCall(f.s, bob, "GetCodexConnection", `{"connectionId":"`+id+`"}`); w.Code != 404 {
		t.Fatal("revoked user retained shared access")
	}
	if len(sharedCodexList(t, f, bob, false)) != 1 {
		t.Fatal("revoked user retained inventory")
	}
	// The creator is the real admin actor; selected users get no invented audit.
	var own, foreign int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_audit_events e JOIN golf_users u ON u.id=e.user_id WHERE action LIKE 'CODEX_%' AND resource_id=$1 AND u.forge_user_id=42`, id).Scan(&own); e != nil || own < 4 {
		t.Fatal("shared actor/resource audit missing", e)
	}
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_audit_events e JOIN golf_users u ON u.id=e.user_id WHERE action LIKE 'CODEX_%' AND u.forge_user_id=84`).Scan(&foreign); e != nil || foreign != 0 {
		t.Fatal("selected user impersonated in audit")
	}
}
func TestCodexSharedMultipleOwnersRestartAndRotationPostgres(t *testing.T) {
	f, admin, _ := codexFixtureRole(t, true)
	var rows []map[string]any
	for _, name := range []string{"Engineering", "Review"} {
		c := sharedCodexCreate(t, f, admin, name)
		c = codexResponse(t, codexCall(f.s, admin, "StartCodexLogin", `{"connectionId":"`+c["id"].(string)+`","expectedVersion":"`+c["version"].(string)+`","method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`"}`))
		codexExpect(t, c, "CODEX_CONNECTION_STATE_CONNECTED")
		rows = append(rows, c)
	}
	f.s.codexMu.Lock()
	n := len(f.s.codexRuntimes)
	f.s.codexMu.Unlock()
	if n != 2 {
		t.Fatal("accounts share a broker/credential owner")
	}
	var blobs int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_codex_auth`).Scan(&blobs); e != nil || blobs != 2 {
		t.Fatal("shared encrypted credentials missing")
	}
	f.s.CloseCodexAccounts()
	next, e := New(f.s.config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	f.s = next
	for _, c := range rows {
		v := codexResponse(t, codexCall(f.s, admin, "RefreshCodexConnection", `{"connectionId":"`+c["id"].(string)+`","expectedVersion":"`+c["version"].(string)+`"}`))
		codexExpect(t, v, "CODEX_CONNECTION_STATE_CONNECTED")
	}
	f.s.CloseCodexAccounts()
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	result, e := RotateCredentials(context.Background(), f.db, keys, 1, 8)
	if e != nil || !result.Complete || result.RotatedInfrastructureConnections != 2 {
		t.Fatal("shared key lifecycle omitted", e)
	}
}
func TestCodexSharedDisabledSelectionAndManagerWaitPostgres(t *testing.T) {
	f, admin, marker := codexFixtureRole(t, true)
	target := enrollLocal(t, f, "bob", false)
	bob := localLogin(t, f, "bob")
	c := sharedCodexCreate(t, f, admin, "Shared")
	c = sharedCodexAccess(t, f, admin, c, target.UserID)
	if _, e := ManageLocalAccount(context.Background(), f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "bob"}); e != nil {
		t.Fatal(e)
	}
	if w := codexCall(f.s, bob, "GetCodexConnection", `{"connectionId":"`+c["id"].(string)+`"}`); w.Code != 401 {
		t.Fatal("disabled selected user retained capability")
	}
	if w := codexCall(f.s, admin, "SetCodexConnectionAccess", `{"connectionId":"`+c["id"].(string)+`","expectedVersion":"`+c["version"].(string)+`","name":"Shared","allowedUserIds":["`+target.UserID+`"]}`); w.Code != 400 {
		t.Fatal("disabled user accepted new grant")
	}
	c = codexResponse(t, codexCall(f.s, admin, "StartCodexLogin", `{"connectionId":"`+c["id"].(string)+`","expectedVersion":"`+c["version"].(string)+`","method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`"}`))
	os.WriteFile(marker+".block", nil, 0600)
	done := make(chan int, 1)
	go func() {
		done <- codexCall(f.s, admin, "RefreshCodexConnection", `{"connectionId":"`+c["id"].(string)+`","expectedVersion":"`+c["version"].(string)+`"}`).Code
	}()
	waitCodexMarker(t, marker+".entered")
	if _, e := ManageLocalAccount(context.Background(), f.db, f.s.keyring, f.s.config.ForgeURL, "disable", LocalAccountInput{Username: "alice"}); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(marker+".resume", nil, 0600)
	select {
	case code := <-done:
		if code != 401 {
			t.Fatal("disabled manager completed shared refresh", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("manager guard deadlocked")
	}
	var version string
	if e := f.db.QueryRow(`SELECT version::text FROM golf_codex_connections WHERE id=$1`, c["id"]).Scan(&version); e != nil || version != c["version"] {
		t.Fatal("disabled manager changed shared state")
	}
}
func TestCodexNamesAndACLBounds(t *testing.T) {
	for _, s := range []string{"", " leading", "trailing ", "bad\nname", strings.Repeat("x", 101)} {
		if codexName(s) {
			t.Fatal("invalid connection name accepted")
		}
	}
	if !codexName("Engineering team") {
		t.Fatal("valid connection name rejected")
	}
}

func TestCodexStaleManagerRequiresCurrentRolePostgres(t *testing.T) {
	f, caller, _ := codexFixture(t)
	hash, e := sessionHash(caller.Value)
	if e != nil {
		t.Fatal(e)
	}
	var id int64
	if e = f.db.QueryRow(`SELECT id FROM golf_users WHERE forge_user_id=42`).Scan(&id); e != nil {
		t.Fatal(e)
	}
	// Cached role evidence cannot authorize the transaction after a wait.
	actor := codexActor{UserID: id, NativeID: 42, Hash: hash, Admin: true, RequireAdmin: true}
	called := false
	e = f.s.codexGuard(context.Background(), actor, func(*sql.Tx, int64) error { called = true; return nil })
	if !errors.Is(e, errCodexPermission) || called {
		t.Fatal("cached manager role bypassed current authority")
	}
}

func TestCodexPersonalRenamePostgres(t *testing.T) {
	f, owner, _ := codexFixture(t)
	current := codexResponse(t, codexCall(f.s, owner, "StartCodexLogin", `{"method":"CODEX_LOGIN_METHOD_API_KEY","apiKey":"`+fixtureCodexKey+`","expectedVersion":"0"}`))
	id, version := current["id"].(string), current["version"].(string)
	body := `{"connectionId":"` + id + `","expectedVersion":"` + version + `","name":"Work Codex"}`
	renamed := codexResponse(t, codexCall(f.s, owner, "SetCodexConnectionAccess", body))
	if renamed["name"] != "Work Codex" || renamed["id"] != id || renamed["state"] != current["state"] || renamed["version"] == version {
		t.Fatal("rename changed identity or authentication")
	}
	if w := codexCall(f.s, owner, "SetCodexConnectionAccess", body); w.Code != 400 {
		t.Fatal("stale rename accepted", w.Code)
	}
	enrollLocal(t, f, "bob", false)
	bob := localLogin(t, f, "bob")
	if w := codexCall(f.s, bob, "SetCodexConnectionAccess", body); w.Code != 404 {
		t.Fatal("foreign personal rename accepted", w.Code)
	}
	body = `{"connectionId":"` + id + `","expectedVersion":"` + renamed["version"].(string) + `","name":"Shared","allowedUserIds":["1"]}`
	if w := codexCall(f.s, owner, "SetCodexConnectionAccess", body); w.Code != 400 {
		t.Fatal("personal sharing accepted", w.Code)
	}
	// A restart must retain the encrypted login after metadata editing.
	refreshed := codexResponse(t, codexCall(f.s, owner, "RefreshCodexConnection", `{"expectedVersion":"`+renamed["version"].(string)+`"}`))
	if refreshed["state"] != current["state"] || refreshed["name"] != "Work Codex" {
		t.Fatal("rename lost private login state")
	}
}
