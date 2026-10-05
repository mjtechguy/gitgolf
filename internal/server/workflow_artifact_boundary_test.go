package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkflowArtifactManagedBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
		r := httptest.NewRequest("POST", "/rpc/golf.v1.WorkflowArtifactService/GetWorkflowArtifact", strings.NewReader("{}"))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("artifact RPC boundary", w.Code)
		}
	}
	if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), "/golf.v1.WorkflowArtifactService/GetWorkflowArtifact", "{}"); w.Code != 403 {
		t.Fatal("delegated artifact read admitted", w.Code)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/api/workflow-runs/12345678-1234-4234-8234-123456789abc/artifact", nil))
	if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("download route bypassed managed session", w.Code)
	}
}
