package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestLocalLoginCookieAndOriginBoundary(t *testing.T) {
	cfg := testConfig("http://forge.example.invalid")
	cfg.PublicURL, cfg.AllowInsecureCookies = "https://golf.example.invalid", false
	s, err := New(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	cookie := s.sessionCookie("opaque", time.Now().Add(sessionLifetime), int(sessionLifetime.Seconds()))
	if cookie.Name != "__Host-golf_session" || !cookie.HttpOnly || !cookie.Secure || cookie.Domain != "" || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 43200 {
		t.Fatal("production cookie lost host-only, HttpOnly, Secure, SameSite or persistent expiry")
	}
	h := make(http.Header)
	h.Set("Cookie", "__Host-golf_session=opaque")
	if s.cookieValue(h) != "opaque" {
		t.Fatal("host cookie was not read")
	}
	for _, value := range []string{"golf_session=opaque", "__Host-golf_session=one; __Host-golf_session=two"} {
		h.Set("Cookie", value)
		if s.cookieValue(h) != "" {
			t.Fatal("legacy or ambiguous production cookie accepted")
		}
	}
	for _, origin := range []string{"", "https://evil.example.invalid", "https://golf.example.invalid.evil"} {
		req := httptest.NewRequest("POST", "/rpc"+golfv1connect.SessionServiceLoginWithPasswordProcedure, strings.NewReader(`{"username":"admin","password":"private value"}`))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, req)
		if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "private value") {
			t.Fatal("local login origin or error redaction failed")
		}
	}
}

func TestNativeJSONCannotAssignGolfAdmin(t *testing.T) {
	var user User
	if err := json.Unmarshal([]byte(`{"id":42,"login":"alice","is_instance_admin":true,"IsInstanceAdmin":true}`), &user); err != nil {
		t.Fatal(err)
	}
	if user.IsInstanceAdmin {
		t.Fatal("provider JSON assigned Golf administration")
	}
	// Role resolution for a missing session must never treat caller/provider flags as authority.
	s, err := New(testConfig("http://forge.example.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	user.IsInstanceAdmin = true
	resolved, err := s.localSessionUser(context.Background(), "invalid", user)
	if err == nil && resolved.IsInstanceAdmin {
		t.Fatal("unverified session retained Golf administration")
	}
}
