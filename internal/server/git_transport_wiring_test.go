package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedGitStartupSnapshotAndCloneDestination(t *testing.T) {
	t.Setenv("GOLF_MANAGED_HTTP_GIT", "true")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_PUBLIC_URL", "https://git.golf.example")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_ALLOW_LOOPBACK", "")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_INCARNATION", "")
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("GOLF_MANAGED_HTTP_GIT", "false")
	c, e := s.gitConfiguration()
	if e != nil || !c.Enabled || c.PublicURL != "https://git.golf.example" {
		t.Fatal("startup configuration changed dynamically", e)
	}
	repo := Repository{ID: 9, Name: "example", FullName: "alice/example", CloneURL: "http://native.invalid/alice/example.git", SSHURL: "ssh://native.invalid/alice/example.git"}
	wire := s.wireGitRepository(repo)
	if wire.CloneUrl != "https://git.golf.example/git/alice/example.git" || wire.SshUrl != "" {
		t.Fatal("opt-in advertised native bypass")
	}
	ordinary := (&Server{}).wireGitRepository(repo)
	if ordinary.CloneUrl != repo.CloneURL || ordinary.SshUrl != repo.SSHURL {
		t.Fatal("default clone destination changed")
	}
	repo.FullName = "alice/other"
	if s.wireGitRepository(repo).CloneUrl != "" {
		t.Fatal("mismatched native clone identity accepted")
	}
}
func TestManagedGitEndpointNamespaceAndBrowserBoundary(t *testing.T) {
	for _, tc := range []struct {
		path string
		git  bool
	}{
		{"/git/alice/example.git/info/refs", true}, {"/git/alice/example.wiki.git/HEAD", true},
		{"/git/example", false}, {"/git/example/tree/main", false}, {"/other/alice/example.git/info/refs", false},
	} {
		if managedGitRouteNamespace(tc.path) != tc.git {
			t.Fatalf("incorrect transport routing for %s", tc.path)
		}
	}
	t.Setenv("GOLF_MANAGED_HTTP_GIT", "")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_PUBLIC_URL", "")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_ALLOW_LOOPBACK", "")
	t.Setenv("GOLF_MANAGED_HTTP_GIT_INCARNATION", "")
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("GET", "/git/alice/example.git/info/refs?service=git-upload-pack", nil)
	r.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("disabled Git served a SPA or cacheable response", w.Code)
	}
	r = httptest.NewRequest("POST", "/rpc/golf.v1.GitTransportService/CreateGitCredential", strings.NewReader(`{}`))
	r.Header.Set("Origin", s.config.PublicURL)
	r.Header.Set("Connect-Protocol-Version", "1")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer golf_ro_"+strings.Repeat("A", 43))
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("API read bearer gained Git management", w.Code)
	}
}

func TestManagedGitEmptyInventoryCompleteness(t *testing.T) {
	empty := []map[string]any{}
	for _, tc := range []struct {
		endpoint, count string
		valid           bool
	}{
		{"/branch_protections", "", true}, {"/tag_protections", "", true},
		{"/push_mirrors", "", false}, {"/push_mirrors", "0", true}, {"/push_mirrors", "1", false},
		{"/branch_protections", "1", false}, {"/push_mirrors", "00", false},
	} {
		header := http.Header{}
		if tc.count != "" {
			header.Set("X-Total-Count", tc.count)
		}
		if gitEmptyInventory(tc.endpoint, empty, header) != tc.valid {
			t.Fatal("false empty/completeness observation", tc.endpoint, tc.count)
		}
	}
	h := http.Header{"X-Total-Count": []string{"0", "1"}}
	if gitEmptyInventory("/push_mirrors", empty, h) || gitEmptyInventory("/branch_protections", nil, http.Header{}) {
		t.Fatal("ambiguous or missing inventory admitted")
	}
}
