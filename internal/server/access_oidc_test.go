package server

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func oidcTestConfiguration(t *testing.T, public string) *accessOIDC {
	t.Helper()
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	secret, _, _ := previewToken()
	v := accessOIDC{ClientID: "golf-preview-access", ClientSecret: secret, TeamDomain: "golf-test.cloudflareaccess.com", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}))}
	raw, _ = json.Marshal(v)
	path := filepath.Join(t.TempDir(), "oidc.json")
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	got, e := loadAccessOIDC(public, false, path)
	if e != nil {
		t.Fatal(e)
	}
	if got.PrivateKeyPEM != "" || got.key == nil {
		t.Fatal("private key not parsed")
	}
	if _, e = loadAccessOIDC(public, true, path); e == nil {
		t.Fatal("insecure issuer")
	}
	if e = os.Chmod(path, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e = loadAccessOIDC(public, false, path); e == nil {
		t.Fatal("public secrets")
	}
	return got
}

func TestAccessOIDCConfiguration(t *testing.T) {
	v := oidcTestConfiguration(t, "https://golf.invalid")
	s := &Server{accessOIDC: v}
	for _, path := range []string{"/auth/access/jwks", "/auth/access/.well-known/openid-configuration"} {
		w := httptest.NewRecorder()
		s.AccessOIDCHandler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || strings.Contains(w.Body.String(), v.ClientSecret) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("public endpoint", w.Code)
		}
	}
	for _, query := range []string{"client_id=wrong", "redirect_uri=https%3A%2F%2Fevil.invalid", "client_id=x&client_id=y"} {
		w := httptest.NewRecorder()
		s.AccessOIDCHandler().ServeHTTP(w, httptest.NewRequest("GET", "/auth/access/authorize?"+query, nil))
		if w.Code != 400 || w.Header().Get("Location") != "" {
			t.Fatal("untrusted redirect")
		}
	}
}

func TestAccessOIDCCodesPostgres(t *testing.T) {
	f, l, _ := environmentFixture(t)
	f.server.config.PublicURL = "https://golf.invalid"
	f.server.config.AllowInsecureCookies = false
	v := oidcTestConfiguration(t, f.server.config.PublicURL)
	f.server.accessOIDC = v
	verifier, _, _ := previewToken()
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{"client_id": {v.ClientID}, "redirect_uri": {v.callback}, "response_type": {"code"}, "scope": {"openid email"}, "state": {"state-42"}, "nonce": {"nonce-42"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}}
	authorize := func() string {
		t.Helper()
		r := httptest.NewRequest("GET", v.issuer+"/authorize?"+q.Encode(), nil)
		r.AddCookie(&http.Cookie{Name: "__Host-golf_session", Value: l.Value})
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		if w.Code != 302 {
			t.Fatal("authorize", w.Code, w.Body.String())
		}
		u, e := url.Parse(w.Header().Get("Location"))
		if e != nil || u.Host != "golf-test.cloudflareaccess.com" || u.Query().Get("state") != q.Get("state") {
			t.Fatal("callback")
		}
		return u.Query().Get("code")
	}
	exchange := func(code, verify, secret string) *httptest.ResponseRecorder {
		body := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {v.callback}, "code_verifier": {verify}}
		r := httptest.NewRequest("POST", v.issuer+"/token", strings.NewReader(body.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.SetBasicAuth(v.ClientID, secret)
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, r)
		return w
	}
	anonymous := httptest.NewRecorder()
	f.server.ServeHTTP(anonymous, httptest.NewRequest("GET", v.issuer+"/authorize?"+q.Encode(), nil))
	redirect, e := url.Parse(anonymous.Header().Get("Location"))
	if anonymous.Code != 303 || e != nil || redirect.IsAbs() || redirect.Path != "/" || redirect.Query().Get("access_login") != q.Encode() {
		t.Fatal("Golf sign-in continuation")
	}
	// Native Access supplies its client domain and a long opaque state.
	q.Set("domain", v.ClientID)
	q.Set("state", strings.Repeat("s", 1800))
	for _, invalid := range []struct{ key, value string }{{"domain", "unregistered"}, {"domain", ""}, {"state", strings.Repeat("s", 3073)}, {"nonce", strings.Repeat("n", 513)}} {
		original := q.Get(invalid.key)
		q.Set(invalid.key, invalid.value)
		w := httptest.NewRecorder()
		f.server.ServeHTTP(w, httptest.NewRequest("GET", v.issuer+"/authorize?"+q.Encode(), nil))
		if w.Code != 400 || w.Header().Get("Location") != "" {
			t.Fatal("untrusted native authorization parameter", invalid.key)
		}
		q.Set(invalid.key, original)
	}
	code := authorize()
	if exchange(code, verifier, "wrong").Code != 401 || exchange(code, strings.Repeat("x", 43), v.ClientSecret).Code != 400 {
		t.Fatal("client/PKCE gate")
	}
	w := exchange(code, verifier, v.ClientSecret)
	if w.Code != 200 {
		t.Fatal("exchange", w.Code, w.Body.String())
	}
	var response struct {
		IDToken string `json:"id_token"`
	}
	if json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatal("token JSON")
	}
	parts := strings.Split(response.IDToken, ".")
	if len(parts) != 3 {
		t.Fatal("JWT")
	}
	signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
	signed := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(&v.key.PublicKey, crypto.SHA256, signed[:], signature) != nil {
		t.Fatal("signature")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims map[string]any
	json.Unmarshal(raw, &claims)
	if claims["nonce"] != "nonce-42" || claims["iss"] != v.issuer || claims["aud"] != v.ClientID || claims["email_verified"] != false || claims["email"] != "golf-42@reviewer.invalid" || claims["exp"].(float64) > float64(time.Now().Add(61*time.Second).Unix()) {
		t.Fatal("claims")
	}
	if exchange(code, verifier, v.ClientSecret).Code != 400 {
		t.Fatal("replay")
	}
	code = authorize()
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); statuses <- exchange(code, verifier, v.ClientSecret).Code }()
	}
	wg.Wait()
	close(statuses)
	success := 0
	for code := range statuses {
		if code == 200 {
			success++
		}
	}
	if success != 1 {
		t.Fatal("concurrent exchange", success)
	}
	code = authorize()
	hash, _ := previewTokenHash(code)
	if _, e := f.server.db.Exec("UPDATE golf_access_oidc_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", hash); e != nil {
		t.Fatal(e)
	}
	if exchange(code, verifier, v.ClientSecret).Code != 400 {
		t.Fatal("expired code")
	}
	code = authorize()
	parent, _ := sessionHash(l.Value)
	if _, e := f.server.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", parent); e != nil {
		t.Fatal(e)
	}
	if exchange(code, verifier, v.ClientSecret).Code != 400 {
		t.Fatal("expired parent")
	}
}
