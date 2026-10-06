package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"golang.org/x/oauth2"
)

type oauthFixture struct {
	s          *Server
	db         *sql.DB
	mode       atomic.Int32 // token outage, invalid grant, oversized, user outage, wrong identity, unsupported version
	calls      atomic.Int32
	mu         sync.Mutex
	generation int
	challenge  string
}

func oauthAccess(generation int) string { return strings.Repeat("jwt", 350) + fmt.Sprint(generation) }
func newOAuthFixture(t *testing.T) *oauthFixture {
	t.Helper()
	f := &oauthFixture{db: testDatabase(t)}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			if f.mode.Load() == 6 {
				fmt.Fprint(w, `{"version":"1.26.0"}`)
			} else {
				fmt.Fprint(w, `{"version":"1.27.3"}`)
			}
		case "/login/oauth/access_token":
			f.calls.Add(1)
			if err := r.ParseForm(); err != nil {
				t.Error("invalid token form")
			}
			if r.Form.Get("client_id") != "client-id" || r.Form.Get("client_secret") != "client-secret" || r.Header.Get("Authorization") != "" {
				t.Error("wrong confidential client authentication")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if r.Form.Get("grant_type") == "authorization_code" {
				sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
				if base64.RawURLEncoding.EncodeToString(sum[:]) != f.challenge || r.Form.Get("redirect_uri") != f.s.config.PublicURL+oauthCallbackPath {
					t.Error("PKCE or redirect mismatch")
					w.WriteHeader(400)
					return
				}
			} else if r.Form.Get("grant_type") == "refresh_token" {
				if r.Form.Get("refresh_token") != fmt.Sprintf("refresh-%d", f.generation) {
					t.Error("refresh token used twice or lost")
					w.WriteHeader(400)
					fmt.Fprint(w, `{"error":"invalid_grant"}`)
					return
				}
			} else {
				t.Error("unexpected grant")
				w.WriteHeader(400)
				return
			}
			switch f.mode.Load() {
			case 1:
				w.WriteHeader(503)
				fmt.Fprint(w, `{"error":"unavailable"}`)
				return
			case 2:
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":"invalid_grant","error_description":"secret must never escape"}`)
				return
			case 7:
				time.Sleep(600 * time.Millisecond)
			case 8:
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":"invalid_client","error_description":"secret must never escape"}`)
				return
			case 9:
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":"unauthorized_client"}`)
				return
			case 10:
				w.WriteHeader(503)
				fmt.Fprint(w, `{"error":"invalid_grant"}`)
				return
			case 11:
				w.WriteHeader(429)
				fmt.Fprint(w, `{"error":"invalid_client"}`)
				return
			case 3:
				fmt.Fprint(w, strings.Repeat("x", maxOAuthResponse+1))
				return
			}
			f.generation++
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": oauthAccess(f.generation), "refresh_token": fmt.Sprintf("refresh-%d", f.generation), "token_type": "Bearer", "expires_in": 3600})
		case "/api/v1/user":
			if r.Header.Get("Authorization") == "token pat-fixture" {
				fmt.Fprint(w, `{"id":42,"login":"same-user"}`)
				return
			}
			f.mu.Lock()
			generation := f.generation
			f.mu.Unlock()
			if r.Header.Get("Authorization") != "Bearer "+oauthAccess(generation) {
				w.WriteHeader(401)
				return
			}
			if f.mode.Load() == 4 {
				w.WriteHeader(503)
				return
			}
			if f.mode.Load() == 5 {
				fmt.Fprint(w, `{"id":99,"login":"same-user"}`)
				return
			}
			fmt.Fprint(w, `{"id":42,"login":"same-user"}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "client-id", "client-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *oauthFixture) begin(t *testing.T) (url.Values, *http.Cookie) {
	t.Helper()
	sessions, _, _, _, _ := testRPCClients(t, f.s)
	response, err := sessions.BeginGiteaOAuth(context.Background(), connect.NewRequest(&golfv1.BeginGiteaOAuthRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("auth response lacks privacy headers")
	}
	u, err := url.Parse(response.Msg.AuthorizationUrl)
	if err != nil {
		t.Fatal("invalid authorize URL")
	}
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("scope") != strings.Join(oauthScopes, " ") || q.Get("response_type") != "code" || q.Get("redirect_uri") != f.s.config.PublicURL+oauthCallbackPath || q.Get("client_secret") != "" {
		t.Fatal("incorrect authorize parameters")
	}
	if !strings.Contains(" "+q.Get("scope")+" ", " write:package ") {
		t.Fatal("new explicit consent lacks package publication scope")
	}
	f.mu.Lock()
	f.challenge = q.Get("code_challenge")
	f.mu.Unlock()
	cookies := (&http.Response{Header: response.Header()}).Cookies()
	if len(cookies) != 1 || cookies[0].Name != oauthCookieName || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Path != oauthCallbackPath || cookies[0].MaxAge != 600 {
		t.Fatal("incorrect binding cookie")
	}
	return q, cookies[0]
}
func (f *oauthFixture) callback(query url.Values, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", oauthCallbackPath+"?"+query.Encode(), nil)
	for _, c := range cookies {
		if c != nil {
			req.AddCookie(c)
		}
	}
	response := httptest.NewRecorder()
	f.s.ServeHTTP(response, req)
	return response
}
func oauthCallbackQuery(authorize url.Values) url.Values {
	return url.Values{"state": {authorize.Get("state")}, "code": {"authorization-code"}}
}
func sessionFromResponse(t *testing.T, response *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range response.Result().Cookies() {
		if c.Name == cookieName {
			return c
		}
	}
	t.Fatal("session cookie absent")
	return nil
}

func TestOAuthConfigurationAndPublicBoundary(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*Config)
		valid  bool
	}{
		{"disabled", func(c *Config) {}, true},
		{"partial", func(c *Config) { c.GiteaOAuthClientID = "client" }, false},
		{"complete loopback", func(c *Config) {
			c.GiteaPublicURL = "http://localhost:3001"
			c.GiteaOAuthClientID = "client"
			c.GiteaOAuthClientSecret = "secret"
		}, true},
		{"remote insecure", func(c *Config) {
			c.GiteaPublicURL = "http://forge.example"
			c.GiteaOAuthClientID = "client"
			c.GiteaOAuthClientSecret = "secret"
		}, false},
		{"query", func(c *Config) {
			c.GiteaPublicURL = "https://forge.example?secret=1"
			c.GiteaOAuthClientID = "client"
			c.GiteaOAuthClientSecret = "secret"
		}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			c := testConfig("http://gitea:3000")
			test.change(&c)
			_, err := New(c, nil)
			if (err == nil) != test.valid {
				t.Fatal("configuration boundary mismatch")
			}
		})
	}
	s, err := New(testConfig("http://gitea:3000"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.SessionServiceGetAuthenticationOptionsProcedure, golfv1connect.SessionServiceBeginGiteaOAuthProcedure} {
		req := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed"))
		req.Header.Set("Origin", "https://attacker.example")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, req)
		if response.Code != 403 {
			t.Fatal("OAuth origin checked after decoding")
		}
	}
	options, err := s.GetAuthenticationOptions(context.Background(), connect.NewRequest(&golfv1.GetAuthenticationOptionsRequest{}))
	if err != nil || options.Msg.GiteaOauthEnabled {
		t.Fatal("unconfigured OAuth advertised")
	}
	if _, err := s.BeginGiteaOAuth(context.Background(), connect.NewRequest(&golfv1.BeginGiteaOAuthRequest{})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("unconfigured OAuth began")
	}
}
func TestOAuthLoginBindingAndReplayPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	old, err := f.s.loginSession(context.Background(), "pat-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	authorize, binding := f.begin(t)
	stateHash, _ := sessionHash(authorize.Get("state"))
	var cipher []byte
	if err := f.db.QueryRow("SELECT encrypted_verifier FROM golf_oauth_attempts WHERE state_hash=$1", stateHash).Scan(&cipher); err != nil {
		t.Fatal(err)
	}
	verifier, err := f.s.unseal(cipher, stateHash)
	if err != nil || bytes.Contains(cipher, []byte(verifier)) {
		t.Fatal("verifier not encrypted")
	}
	query := oauthCallbackQuery(authorize)
	replica, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.s = replica
	response := f.callback(query, binding, f.s.sessionCookie(old.Value, old.Expires, 3600))
	if response.Code != 303 || response.Header().Get("Location") != "/" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("callback failed or lost privacy headers")
	}
	session := sessionFromResponse(t, response)
	if !session.HttpOnly || session.SameSite != http.SameSiteLaxMode || session.MaxAge != int(sessionLifetime.Seconds()) {
		t.Fatal("unsafe OAuth session cookie")
	}
	if _, err := f.s.sessionCredential(context.Background(), old.Value); !errors.Is(err, errUnauthenticated) {
		t.Fatal("PAT session not replaced")
	}
	var users, attempts int
	f.db.QueryRow("SELECT count(*) FROM golf_users").Scan(&users)
	f.db.QueryRow("SELECT count(*) FROM golf_oauth_attempts").Scan(&attempts)
	if users != 1 || attempts != 0 {
		t.Fatal("OAuth identity split or attempt not consumed")
	}
	credential, err := f.s.sessionCredential(context.Background(), session.Value)
	if err != nil || credential.Kind != "oauth" || len(credential.Token) <= 512 {
		t.Fatal("OAuth credential rejected or confused with PAT")
	}
	if _, err := f.s.currentUser(context.Background(), credential); err != nil {
		t.Fatal("Bearer credential rejected")
	}
	f.db.QueryRow("SELECT encrypted_token FROM golf_sessions").Scan(&cipher)
	if bytes.Contains(cipher, []byte("refresh-")) || bytes.Contains(cipher, []byte("jwt")) {
		t.Fatal("plaintext OAuth tokens persisted")
	}
	replay := f.callback(query, binding)
	if replay.Header().Get("Location") != "/?auth_error=oauth_failed" || f.calls.Load() != 1 {
		t.Fatal("callback replay accepted")
	}
	f.mode.Store(6)
	options, err := f.s.GetAuthenticationOptions(context.Background(), connect.NewRequest(&golfv1.GetAuthenticationOptionsRequest{}))
	if err != nil || options.Msg.GiteaOauthEnabled {
		t.Fatal("unsupported Gitea advertised")
	}
}
func TestOAuthCallbackDenialsPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	for _, scenario := range []string{"missing binding", "wrong binding", "expired", "denied", "duplicate code", "missing state"} {
		t.Run(scenario, func(t *testing.T) {
			authorize, binding := f.begin(t)
			query := oauthCallbackQuery(authorize)
			switch scenario {
			case "missing binding":
				binding = nil
			case "wrong binding":
				binding.Value = randomOpaque()
			case "expired":
				if _, err := f.db.Exec("UPDATE golf_oauth_attempts SET expires_at=now()-interval '1 second'"); err != nil {
					t.Fatal(err)
				}
			case "denied":
				query.Set("error", "access_denied")
			case "duplicate code":
				query.Add("code", "other")
			case "missing state":
				query.Del("state")
			}
			response := f.callback(query, binding)
			if response.Header().Get("Location") != "/?auth_error=oauth_failed" || f.calls.Load() != 0 {
				t.Fatal("invalid callback accepted")
			}
			cleared := false
			for _, c := range response.Result().Cookies() {
				if c.Name == oauthCookieName && c.MaxAge < 0 {
					cleared = true
				}
				if c.Name == cookieName {
					t.Fatal("denial created session")
				}
			}
			if !cleared {
				t.Fatal("binding not cleared")
			}
			if scenario == "denied" || scenario == "duplicate code" {
				retry := f.callback(oauthCallbackQuery(authorize), binding)
				if retry.Header().Get("Location") != "/?auth_error=oauth_failed" || f.calls.Load() != 0 {
					t.Fatal("denied attempt reusable")
				}
			}
		})
	}
}
func (f *oauthFixture) expiredSession(t *testing.T) loginResult {
	t.Helper()
	session, err := f.s.createSession(context.Background(), User{ID: 42, Login: "same-user"}, "oauth", encodeOAuth(oauthEnvelope{Version: 1, AccessToken: oauthAccess(0), RefreshToken: "refresh-0", Expiry: time.Now().Add(-time.Minute), Verified: true}), "")
	if err != nil {
		t.Fatal(err)
	}
	return session
}
func TestOAuthRefreshConcurrentReplicasPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	session := f.expiredSession(t)
	replica, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 12)
	for i := range 12 {
		go func() {
			<-start
			s := f.s
			if i%2 == 1 {
				s = replica
			}
			credential, err := s.sessionCredential(context.Background(), session.Value)
			if err == nil && (credential.Kind != "oauth" || credential.Token != oauthAccess(1)) {
				err = errors.New("incorrect refreshed credential")
			}
			results <- err
		}()
	}
	close(start)
	for range 12 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatal("concurrent replicas rotated more than once")
	}
	hash, _ := sessionHash(session.Value)
	var expires time.Time
	if err := f.db.QueryRow("SELECT expires_at FROM golf_sessions WHERE token_hash=$1", hash).Scan(&expires); err != nil || expires.Sub(session.Expires).Abs() > time.Millisecond {
		t.Fatal("refresh extended session lifetime")
	}
	if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.sessionCredential(context.Background(), session.Value); !errors.Is(err, errUnauthenticated) || f.calls.Load() != 1 {
		t.Fatal("expired Golf session refreshed")
	}
}
func TestOAuthRefreshFailureRecoveryPostgres(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		mode    int32
		deleted bool
	}{{"outage", 1, false}, {"invalid grant", 2, true}, {"oversized", 3, false}, {"identity outage", 4, false}, {"wrong identity", 5, true}, {"application rejected", 8, false}, {"expired or reused refresh", 9, true}, {"server error with grant code", 10, false}, {"rate limit with client code", 11, false}} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newOAuthFixture(t)
			session := f.expiredSession(t)
			f.mode.Store(scenario.mode)
			_, err := f.s.sessionCredential(context.Background(), session.Value)
			if err == nil {
				t.Fatal("failed refresh authorized request")
			}
			if scenario.deleted && !errors.Is(err, errUnauthenticated) {
				t.Fatal("revoked identity not denied")
			}
			hash, _ := sessionHash(session.Value)
			row, lookupErr := database.New(f.db).GetSessionCredential(context.Background(), database.GetSessionCredentialParams{TokenHash: hash, ForgeURL: f.s.config.GiteaURL})
			if scenario.deleted {
				if !errors.Is(lookupErr, sql.ErrNoRows) {
					t.Fatal("denied session retained")
				}
				return
			}
			if lookupErr != nil {
				t.Fatal("transient outage deleted session")
			}
			payload, err := f.s.unseal(row.EncryptedToken, hash)
			if err != nil {
				t.Fatal(err)
			}
			envelope, err := decodeOAuth(payload)
			if err != nil {
				t.Fatal(err)
			}
			if scenario.mode == 4 {
				if envelope.RefreshToken != "refresh-1" || envelope.Verified {
					t.Fatal("rotated token lost or authorized without identity")
				}
			} else if envelope.RefreshToken != "refresh-0" {
				t.Fatal("failed exchange changed credential")
			}
			f.mode.Store(0)
			if _, err := f.s.sessionCredential(context.Background(), session.Value); err != nil {
				t.Fatal("outage recovery failed")
			}
			expected := int32(2)
			if scenario.mode == 4 {
				expected = 1
			}
			if f.calls.Load() != expected {
				t.Fatal("unnecessary refresh after identity outage")
			}
		})
	}
}
func TestOAuthTokenRedirectDenied(t *testing.T) {
	var contacted atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { contacted.Store(true) }))
	defer target.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer provider.Close()
	c := testConfig(provider.URL)
	c.GiteaPublicURL = provider.URL
	c.GiteaOAuthClientID = "client"
	c.GiteaOAuthClientSecret = "secret"
	s, err := New(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.oauthConfig().Exchange(s.oauthContext(context.Background()), "code"); err == nil || contacted.Load() {
		t.Fatal("token redirect followed")
	}
}

func TestOAuthRefreshWriteRollbackPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	session := f.expiredSession(t)
	// Fail the local write after the provider has rotated its refresh token.
	// PostgreSQL must retain the old ciphertext, and Golf must not return the
	// uncommitted access token. A provider rotation cannot itself be rolled back.
	if _, err := f.db.Exec(`CREATE FUNCTION reject_oauth_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced test rollback'; END $$; CREATE TRIGGER reject_oauth_update BEFORE UPDATE ON golf_sessions FOR EACH ROW EXECUTE FUNCTION reject_oauth_update()`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.sessionCredential(context.Background(), session.Value); !errors.Is(err, errStorageUnavailable) {
		t.Fatal("failed DB write returned a credential")
	}
	hash, _ := sessionHash(session.Value)
	row, err := database.New(f.db).GetSessionCredential(context.Background(), database.GetSessionCredentialParams{TokenHash: hash, ForgeURL: f.s.config.GiteaURL})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := f.s.unseal(row.EncryptedToken, hash)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := decodeOAuth(payload)
	if err != nil || envelope.RefreshToken != "refresh-0" || f.calls.Load() != 1 {
		t.Fatal("write rollback leaked a partial credential")
	}
}
func TestOAuthAbsoluteExpiryAfterLockWaitPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	session := f.expiredSession(t)
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	tx, err := f.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := database.New(f.db).WithTx(tx).LockSessionCredential(context.Background(), database.LockSessionCredentialParams{TokenHash: hash, ForgeURL: f.s.config.GiteaURL}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := f.s.sessionCredential(context.Background(), session.Value); done <- err }()
	time.Sleep(400 * time.Millisecond)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, errUnauthenticated) || f.calls.Load() != 0 {
		t.Fatal("session expired while blocked but refreshed")
	}
}

func TestOAuthAbsoluteExpiryDuringExchangePostgres(t *testing.T) {
	f := newOAuthFixture(t)
	session := f.expiredSession(t)
	hash, _ := sessionHash(session.Value)
	if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	f.mode.Store(7)
	if _, err := f.s.sessionCredential(context.Background(), session.Value); !errors.Is(err, errUnauthenticated) || f.calls.Load() != 1 {
		t.Fatal("session expired during exchange but authorized a request")
	}
}

func TestOAuthRefreshErrorClassification(t *testing.T) {
	for _, status := range []int{200, 400, 401, 403, 429, 500, 503} {
		for _, code := range []string{"invalid_grant", "invalid_token", "unauthorized_client", "invalid_client", "unknown"} {
			expected := errForgeUnavailable
			if status == 400 || status == 401 {
				switch code {
				case "invalid_grant", "invalid_token", "unauthorized_client":
					expected = errUnauthenticated
				case "invalid_client":
					expected = errOAuthClientRejected
				}
			}
			classified := oauthRefreshError(&oauth2.RetrieveError{Response: &http.Response{StatusCode: status}, ErrorCode: code, ErrorDescription: "private provider details"})
			if !errors.Is(classified, expected) || strings.Contains(rpcError(classified).Error(), "private provider details") {
				t.Fatalf("incorrect classification for status=%d code=%s", status, code)
			}
		}
	}
	if !errors.Is(oauthRefreshError(errors.New("unknown SDK failure secret")), errForgeUnavailable) {
		t.Fatal("unrecognized SDK error escaped")
	}
}
func TestOAuthClientRejectionRetainsSessionPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	session := f.expiredSession(t)
	f.mode.Store(8)
	sessions, _, _, client, origin := testRPCClients(t, f.s)
	client.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	_, err := sessions.GetSession(context.Background(), connect.NewRequest(&golfv1.GetSessionRequest{}))
	if connect.CodeOf(err) != connect.CodeUnavailable || !strings.Contains(err.Error(), "administrator") || strings.Contains(err.Error(), "secret must never escape") {
		t.Fatal("client rejection lost safe operator diagnosis")
	}
	// Simulate correcting an operator's bad client secret. The fixture verifies
	// that the original refresh token is still supplied, and no sign-in is needed.
	f.mode.Store(0)
	if _, err := sessions.GetSession(context.Background(), connect.NewRequest(&golfv1.GetSessionRequest{})); err != nil {
		t.Fatal("client configuration recovery lost the user's grant")
	}
	if f.calls.Load() != 2 {
		t.Fatal("unexpected exchange count")
	}
}
