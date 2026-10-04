package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitAndOrganizationValueRegisteredBrowserBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	services := map[string][]string{
		"GitTransportService":               {"GetGitTransport", "CreateGitCredential", "ListGitCredentials", "RevokeGitCredential", "GetGitReceiveOutcome"},
		"OrganizationExecutionValueService": {"ListOrganizationExecutionValues", "SaveOrganizationExecutionValue", "DeleteOrganizationExecutionValue", "GetOrganizationExecutionVariable", "GetOrganizationExecutionValueOperation"},
	}
	for service, methods := range services {
		for _, method := range methods {
			path := "/golf.v1." + service + "/" + method
			for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
				r := httptest.NewRequest(http.MethodPost, "/rpc"+path, strings.NewReader("malformed"))
				r.Header.Set("Origin", origin)
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				want := http.StatusUnauthorized
				if origin != s.config.PublicURL {
					want = http.StatusForbidden
				}
				if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("%s boundary: status%d cache%q", path, w.Code, w.Header().Get("Cache-Control"))
				}
			}
			if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); w.Code != http.StatusForbidden || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s allowed delegated management: status%d", path, w.Code)
			}
		}
	}
}
