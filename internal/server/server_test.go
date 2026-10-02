package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func testConfig(forgeURL string) Config {
	return Config{PublicURL: "http://localhost:8080", GiteaURL: forgeURL, AllowInsecureCookies: true,
		EncryptionKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))}
}

func TestConfigurationBoundary(t *testing.T) {
	for _, tt := range []struct {
		name   string
		change func(*Config)
		valid  bool
	}{
		{"loopback explicit", func(c *Config) {}, true},
		{"loopback implicit insecure", func(c *Config) { c.AllowInsecureCookies = false }, false},
		{"insecure remote", func(c *Config) { c.PublicURL = "http://golf.example" }, false},
		{"secure remote", func(c *Config) { c.PublicURL = "https://golf.example"; c.AllowInsecureCookies = false }, true},
		{"short encryption key", func(c *Config) { c.EncryptionKey = "c2hvcnQ=" }, false},
		{"credential in URL", func(c *Config) { c.GiteaURL = "https://user:secret@gitea.example" }, false},
		{"public URL query", func(c *Config) { c.PublicURL += "?unexpected=yes" }, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			config := testConfig("http://gitea:3000")
			tt.change(&config)
			_, err := New(config, nil)
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v err=%v", tt.valid, err)
			}
		})
	}
}

func TestOriginAndBodyBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea:3000"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, origin, body, contentType string
		status                          int
	}{
		{"missing origin", "", `{"token":"secret123"}`, "application/json", 403},
		{"foreign origin", "https://other.example", `{"token":"secret123"}`, "application/json", 403},
		{"prefix spoof", "http://localhost:8080.evil.example", `{"token":"secret123"}`, "application/json", 403},
		{"bad content type", "http://localhost:8080", `{}`, "text/plain", 415},
		{"unknown field", "http://localhost:8080", `{"extra":true}`, "application/json", 400},
		{"second value", "http://localhost:8080", `{} {}`, "application/json", 400},
		{"header injection", "http://localhost:8080", `{"token":"abc\r\ndef123"}`, "application/json", 400},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/rpc"+golfv1connect.SessionServiceLoginWithGiteaTokenProcedure, strings.NewReader(tt.body))
			req.Header.Set("Origin", tt.origin)
			req.Header.Set("Content-Type", tt.contentType)
			req.Header.Set("Connect-Protocol-Version", "1")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != tt.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tt.status, w.Body.String())
			}
		})
	}
}

func TestCredentialEnvelopeAndRedirect(t *testing.T) {
	var leaked atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer origin.Close()
	s, err := New(testConfig(origin.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	hash := bytes.Repeat([]byte{2}, 32)
	encrypted := s.seal("private-token", hash)
	if bytes.Contains(encrypted, []byte("private-token")) {
		t.Fatal("plaintext in envelope")
	}
	if token, err := s.unseal(encrypted, hash); err != nil || token != "private-token" {
		t.Fatal("round trip failed", err)
	}
	for _, entry := range []struct {
		name       string
		value, aad []byte
	}{
		{"other session", encrypted, bytes.Repeat([]byte{3}, 32)},
		{"truncated", encrypted[:4], hash},
		{"tampered", append(append([]byte{}, encrypted[:len(encrypted)-1]...), encrypted[len(encrypted)-1]^1), hash},
	} {
		t.Run(entry.name, func(t *testing.T) {
			if _, err := s.unseal(entry.value, entry.aad); err == nil {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
	if _, err := s.currentUser(context.Background(), "private-token"); err == nil {
		t.Fatal("redirect accepted")
	}
	if leaked.Load() {
		t.Fatal("credential request followed redirect")
	}
	w := httptest.NewRecorder()
	http.SetCookie(w, s.sessionCookie("opaque", time.Now().Add(time.Hour), 3600))
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("unsafe session cookie")
	}
}

func testDatabase(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("GOLF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GOLF_TEST_DATABASE_URL for real PostgreSQL integration")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	t.Cleanup(func() { admin.Close() })
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("golf_test_%x", random)
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`) })
	config.RuntimeParams["search_path"] = schema
	registered := stdlib.RegisterConnConfig(config)
	t.Cleanup(func() { stdlib.UnregisterConnConfig(registered) })
	db, err := database.Open(context.Background(), registered)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// This test uses a real PostgreSQL schema and only substitutes the external
// Gitea HTTP boundary. The separate end-to-end smoke check uses real Gitea.
func TestSessionAndRepositoryWithPostgres(t *testing.T) {
	db := testDatabase(t)
	var revoked atomic.Bool
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "token user-secret-token" || revoked.Load() {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/v1/user":
			fmt.Fprint(w, `{"id":42,"login":"developer","full_name":"Developer","avatar_url":""}`)
		case "/api/v1/user/repos":
			if r.Method == "POST" {
				var input struct {
					Name    string `json:"name"`
					Private bool   `json:"private"`
				}
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
				}
				if input.Name != "example" || !input.Private {
					t.Error("creation lost explicit fields")
				}
				w.WriteHeader(201)
				fmt.Fprint(w, `{"id":1,"name":"example","full_name":"developer/example","private":true}`)
				return
			}
			fmt.Fprint(w, `[{"id":1,"name":"example","full_name":"developer/example","private":true}]`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer forge.Close()

	s, err := New(testConfig(forge.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	sessions, repositories, _, httpClient, origin := testRPCClients(t, s)
	ctx := context.Background()
	if _, err := repositories.ListRepositories(ctx, connect.NewRequest(&golfv1.ListRepositoriesRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("anonymous access", err)
	}
	login, err := sessions.LoginWithGiteaToken(ctx, connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: "user-secret-token"}))
	if err != nil {
		t.Fatal(err)
	}
	if login.Msg.User.Id != "42" || login.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("login response lost identity/cache policy")
	}
	var encrypted []byte
	var count int
	if err := db.QueryRow(`SELECT encrypted_token FROM golf_sessions`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte("user-secret-token")) {
		t.Fatal("stored plaintext credential")
	}
	if err := db.QueryRow(`SELECT count(*) FROM golf_users`).Scan(&count); err != nil || count != 1 {
		t.Fatal("missing identity", err)
	}
	restored, err := New(testConfig(forge.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range httpClient.Jar.Cookies(origin) {
		if cookie.Name == cookieName {
			if token, err := restored.sessionCredential(ctx, cookie.Value); err != nil || token != "user-secret-token" {
				t.Fatal("restart could not recover credential", err)
			}
		}
	}
	if _, err := sessions.GetSession(ctx, connect.NewRequest(&golfv1.GetSessionRequest{})); err != nil {
		t.Fatal(err)
	}
	if _, err := repositories.ListRepositories(ctx, connect.NewRequest(&golfv1.ListRepositoriesRequest{})); err != nil {
		t.Fatal(err)
	}
	private := true
	if _, err := repositories.CreateRepository(ctx, connect.NewRequest(&golfv1.CreateRepositoryRequest{Name: "example", Private: &private})); err != nil {
		t.Fatal(err)
	}
	if _, err := repositories.CreateRepository(ctx, connect.NewRequest(&golfv1.CreateRepositoryRequest{Name: "example"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("implicit public repository allowed", err)
	}
	// Re-authentication invalidates the prior opaque session.
	oldCookies := httpClient.Jar.Cookies(origin)
	if _, err := sessions.LoginWithGiteaToken(ctx, connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: "user-secret-token"})); err != nil {
		t.Fatal(err)
	}
	for _, cookie := range oldCookies {
		if cookie.Name == cookieName {
			if _, err := s.sessionCredential(ctx, cookie.Value); !errors.Is(err, errUnauthenticated) {
				t.Fatal("old session remains live", err)
			}
		}
	}
	revoked.Store(true)
	if _, err := repositories.ListRepositories(ctx, connect.NewRequest(&golfv1.ListRepositoriesRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("revoked token accepted", err)
	}
	revoked.Store(false)
	if _, err := sessions.Logout(ctx, connect.NewRequest(&golfv1.LogoutRequest{})); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.GetSession(ctx, connect.NewRequest(&golfv1.GetSessionRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("logged-out cookie accepted", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM golf_sessions`).Scan(&count); err != nil || count != 0 {
		t.Fatal("session not deleted", err)
	}
}

func testRPCClients(t *testing.T, s *Server) (golfv1connect.SessionServiceClient, golfv1connect.RepositoryServiceClient, golfv1connect.CapabilityServiceClient, *http.Client, *url.URL) {
	t.Helper()
	server := httptest.NewServer(s)
	t.Cleanup(server.Close)
	jar, _ := cookiejar.New(nil)
	client := server.Client()
	client.Jar = jar
	options := []connect.ClientOption{connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, req)
		}
	}))}
	origin, _ := url.Parse(server.URL)
	return golfv1connect.NewSessionServiceClient(client, server.URL+"/rpc", options...), golfv1connect.NewRepositoryServiceClient(client, server.URL+"/rpc", options...), golfv1connect.NewCapabilityServiceClient(client, server.URL+"/rpc", options...), client, origin
}
