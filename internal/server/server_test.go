package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
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
			req := httptest.NewRequest("POST", "/api/session", strings.NewReader(tt.body))
			req.Header.Set("Origin", tt.origin)
			req.Header.Set("Content-Type", tt.contentType)
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
	s.setCookie(w, "opaque", time.Now().Add(time.Hour), 3600)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("unsafe session cookie")
	}
}

// This test uses a real PostgreSQL schema and only substitutes the external
// Gitea HTTP boundary. The separate end-to-end smoke check uses real Gitea.
func TestSessionAndRepositoryWithPostgres(t *testing.T) {
	dsn := os.Getenv("GOLF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GOLF_TEST_DATABASE_URL for real PostgreSQL integration")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	defer admin.Close()
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("golf_test_%x", random)
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`)
	config.RuntimeParams["search_path"] = schema
	registered := stdlib.RegisterConnConfig(config)
	defer stdlib.UnregisterConnConfig(registered)
	db, err := database.Open(context.Background(), registered)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
	request := func(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "http://localhost:8080")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/api/repositories", "", nil); w.Code != 401 {
		t.Fatalf("anonymous read: %d", w.Code)
	}
	w := request("POST", "/api/session", `{"token":"user-secret-token"}`, nil)
	if w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	var encrypted []byte
	var count int
	if err := db.QueryRow(`SELECT encrypted_token FROM golf_sessions`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte("user-secret-token")) {
		t.Fatal("stored plaintext credential")
	}
	if err := db.QueryRow(`SELECT count(*) FROM golf_users`).Scan(&count); err != nil || count != 1 {
		t.Fatal("missing persistent identity", err)
	}
	// A fresh server instance can recover the same encrypted session.
	s, err = New(testConfig(forge.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/session", "/api/repositories"} {
		if w := request("GET", path, "", cookie); w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	if w := request("POST", "/api/repositories", `{"name":"example","description":"","private":true}`, cookie); w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	if w := request("POST", "/api/repositories", `{"name":"example","description":""}`, cookie); w.Code != 400 {
		t.Fatalf("implicit public repository allowed: %d", w.Code)
	}
	revoked.Store(true)
	if w := request("GET", "/api/repositories", "", cookie); w.Code != 401 {
		t.Fatalf("revoked upstream token accepted: %d", w.Code)
	}
	revoked.Store(false)
	if w := request("DELETE", "/api/session", "", cookie); w.Code != 204 {
		t.Fatalf("logout: %d", w.Code)
	}
	if w := request("GET", "/api/session", "", cookie); w.Code != 401 {
		t.Fatalf("logged-out cookie accepted: %d", w.Code)
	}
	var unused int
	if err := db.QueryRow(`SELECT count(*) FROM golf_sessions`).Scan(&unused); err != nil && err != sql.ErrNoRows {
		t.Fatal(err)
	}
	if unused != 0 {
		t.Fatal("session not deleted")
	}
}
