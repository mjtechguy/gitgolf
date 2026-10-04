package server

import (
	"connectrpc.com/connect"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRepositoryInvitationIntegratedBrowserBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, method := range []string{"PreviewRepositoryInvitationRecipient", "CreateRepositoryInvitation", "ListRepositoryInvitations", "ListOwnRepositoryInvitations", "RespondRepositoryInvitation", "RevokeRepositoryInvitation", "GetRepositoryInvitationOperation"} {
		path := "/golf.v1.RepositoryInvitationService/" + method
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
				t.Fatalf("%s: unexpected predecode boundary %d", method, w.Code)
			}
		}
		w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed")
		if w.Code != http.StatusForbidden || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: delegated invitation access admitted", method)
		}
	}
}

func TestInvitationAuthorityErrorDoesNotDiscloseWrappedDetail(t *testing.T) {
	e := rpcError(fmt.Errorf("private wrapped authority detail: %w", errInvitationAuthority))
	if connect.CodeOf(e) != connect.CodePermissionDenied || strings.Contains(e.Error(), "private wrapped") {
		t.Fatal("invitation authority lost denial code or disclosed wrapped detail")
	}
}
