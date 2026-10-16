package server

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"testing"
	"time"
)

// Opt-in bounded browser fixture: real Golf handlers and encrypted PostgreSQL
// profiles, controlled native repository identity, no provider credential. The
// owned quick tunnel supplies trusted HTTPS; the backend stays on loopback.
func TestCloudflareConnectionBrowser(t *testing.T) {
	directory := os.Getenv("GOLF_CF_PRODUCT_BROWSER")
	if directory == "" {
		t.Skip("set GOLF_CF_PRODUCT_BROWSER to a private owned evidence directory")
	}
	f, l, target := environmentFixture(t)
	if _, e := environmentSave(t, f, l, environmentInput(target)); e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	var application atomic.Pointer[Server]
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s := application.Load(); s != nil {
			s.ServeHTTP(w, r)
		} else {
			http.Error(w, "Browser fixture awaiting its HTTPS origin", 503)
		}
	})}
	defer server.Close()
	go server.Serve(listener)
	raw, _ := json.Marshal(map[string]string{"url": "http://" + listener.Addr().String()})
	if e = os.WriteFile(filepath.Join(directory, "browser-listener.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(time.Minute)
	var origin string
	for time.Now().Before(deadline) {
		if raw, e := os.ReadFile(filepath.Join(directory, "browser-origin")); e == nil {
			origin = string(raw)
			if !regexp.MustCompile(`^https://[a-z0-9-]+\.trycloudflare\.com$`).MatchString(origin) {
				t.Fatal("invalid owned temporary HTTPS origin")
			}
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if origin == "" {
		t.Fatal("temporary HTTPS origin deadline expired")
	}
	config := f.server.config
	config.PublicURL = origin
	config.AllowInsecureCookies = false
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = "", "", ""
	config.WebDir, e = filepath.Abs("../../web/dist")
	if e != nil {
		t.Fatal(e)
	}
	s, e := New(config, f.server.db)
	if e != nil {
		t.Fatal(e)
	}
	application.Store(s)
	raw, _ = json.Marshal(map[string]string{"url": origin, "scope": "real_golf_handlers_controlled_native_identity_no_provider_credential"})
	if e = os.WriteFile(filepath.Join(directory, "browser-ready.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	timer := time.NewTimer(5 * time.Minute)
	defer timer.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-timer.C:
			t.Fatal("collaborative browser deadline expired")
		case <-ticker.C:
			if _, e := os.Stat(filepath.Join(directory, "browser-stop")); e == nil {
				return
			}
		}
	}
}
