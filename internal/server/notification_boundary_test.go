package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmailNotificationManagedBrowserBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"ListEmailTransports", "SaveEmailTransport", "ActivateEmailTransport", "GetOwnEmailNotifications", "RequestEmailVerification", "ConfirmEmailVerification", "SaveOwnEmailPreference", "GetRepositoryEmailSubscription", "SaveRepositoryEmailSubscription", "ListOwnEmailDeliveries", "RedeliverOwnEmail"} {
		path := "/golf.v1.EmailNotificationService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			req := httptest.NewRequest(http.MethodPost, "/rpc"+path, strings.NewReader("malformed"))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			want := http.StatusUnauthorized
			if origin != s.config.PublicURL {
				want = http.StatusForbidden
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s boundary: status=%d cache=%q", method, w.Code, w.Header().Get("Cache-Control"))
			}
		}
		if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); response.Code != http.StatusForbidden || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s allowed delegated API access: %d", method, response.Code)
		}
	}
}

func TestEmailOperatorPolicyFailsBeforeDatabaseUse(t *testing.T) {
	t.Setenv("GOLF_EMAIL_EGRESS_POLICY", `[{"host":"private-secret-host","port":25,"tls_mode":"implicit","ips":["bad-private-network"]}]`)
	_, err := New(testConfig("http://forge.invalid"), nil)
	if err == nil || err.Error() != "Email operator egress policy is invalid" {
		t.Fatal("invalid SMTP operator policy was accepted or disclosed")
	}
}
