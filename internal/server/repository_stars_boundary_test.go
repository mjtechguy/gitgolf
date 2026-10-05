package server

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestRepositoryStarsManagedBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.RepositoryServiceGetRepositoryStarProcedure, golfv1connect.RepositoryServiceSetRepositoryStarProcedure} {
		if apiReadProcedure(procedure) {
			t.Fatal("own preference delegated", procedure)
		}
		for _, origin := range []string{"", "https://foreign.invalid", s.config.PublicURL} {
			r := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("{}"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 403
			if origin == s.config.PublicURL {
				want = 401
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("managed preference boundary", procedure, w.Code)
			}
		}
		if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), procedure, "{}"); w.Code != 403 {
			t.Fatal("delegated preference admitted", procedure, w.Code)
		}
	}
}
