package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"
)

func TestPublicImportURLBoundary(t *testing.T) {
	for _, source := range []string{"https://github.com/octocat/Hello-World", "https://gitlab.com/group/subgroup/project.git"} {
		canonical, metadata, e := publicImportURL(source)
		if e != nil || !strings.HasSuffix(canonical, ".git") || metadata == "" {
			t.Fatal("public source refused", e)
		}
	}
	for _, source := range []string{"http://github.com/a/b", "https://localhost/a/b", "https://github.com.evil.invalid/a/b", "https://a:b@github.com/a/b", "https://github.com:443/a/b", "https://github.com/a/b?token=secret", "https://github.com/a/b?", "https://github.com/a/b#fragment", "https://github.com/a/b/tree/main", "https://github.com/a/%2e%2e", "https://gitlab.com/a/../b", "https://gitlab.com/-/a", "https://github.com//a/b"} {
		if _, _, e := publicImportURL(source); e == nil {
			t.Fatalf("unsafe import URL admitted: %s", source)
		}
	}
	legacy, _ := json.Marshal(repositoryCreationInput{Name: "example", Description: "text", Private: true})
	if string(legacy) != `{"name":"example","description":"text","private":true}` {
		t.Fatal("empty import changed existing creation fingerprint")
	}
}
func TestPublicImportOriginalJournal(t *testing.T) {
	f := newCreationFixture(t)
	session := f.session(t, "alice", "pat")
	metadataCalls := 0
	posts := 0
	privateSource := false
	lost := false
	f.s.client.Transport = releaseOperationTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			metadataCalls++
			if r.Header.Get("Authorization") != "" {
				t.Fatal("native credential sent to public source")
			}
			body := `{"private":false,"clone_url":"https://github.com/octocat/Hello-World.git"}`
			if privateSource {
				body = `{"private":true,"clone_url":"https://github.com/octocat/Hello-World.git"}`
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		}
		if r.URL.Path == "/api/v1/repos/migrate" {
			posts++
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Fatal("migration input")
			}
			if body["clone_addr"] != "https://github.com/octocat/Hello-World.git" || body["repo_owner"] != "alice" || body["mirror"] != false {
				t.Fatal("migration intent changed")
			}
			row := Repository{ID: 142, Name: "example", FullName: "alice/example", Private: true}
			f.mu.Lock()
			f.repos[row.FullName] = row
			f.mu.Unlock()
			status := 201
			if lost {
				status = 503
			}
			data, _ := json.Marshal(row)
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(string(data))), Request: r}, nil
		}
		return http.DefaultTransport.RoundTrip(r)
	})
	m := creationRequest(creationFixtureKey)
	m.SourceUrl = "https://github.com/octocat/Hello-World"
	first, e := f.client(t, session).CreateRepository(t.Context(), connect.NewRequest(m))
	if e != nil || first.Msg.Creation.State.String() != "REPOSITORY_CREATION_STATE_SUCCEEDED" {
		t.Fatal("public import failed", e)
	}
	if _, e = f.client(t, session).CreateRepository(t.Context(), connect.NewRequest(m)); e != nil || posts != 1 || metadataCalls != 1 {
		t.Fatal("original import replayed", posts, metadataCalls, e)
	}
	changed := creationRequest(creationFixtureKey)
	changed.SourceUrl = "https://github.com/other/project"
	if _, e = f.client(t, session).CreateRepository(t.Context(), connect.NewRequest(changed)); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("changed original source admitted", e)
	}
	privateSource = true
	denied := creationRequest(randomUUID())
	denied.Name = "privateblocked"
	denied.SourceUrl = m.SourceUrl
	refused, e := f.client(t, session).CreateRepository(t.Context(), connect.NewRequest(denied))
	if e != nil || refused.Msg.Creation.State.String() != "REPOSITORY_CREATION_STATE_REJECTED" || posts != 1 {
		t.Fatal("private source reached native migration", posts, e)
	}
	privateSource = false
	lost = true
	uncertain := creationRequest(randomUUID())
	uncertain.SourceUrl = m.SourceUrl
	unresolved, e := f.client(t, session).CreateRepository(t.Context(), connect.NewRequest(uncertain))
	if e != nil || unresolved.Msg.Creation.State.String() != "REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN" {
		t.Fatal("lost native import receipt not retained", e)
	}
	if _, e = f.client(t, session).CreateRepository(t.Context(), connect.NewRequest(uncertain)); e != nil || posts != 2 {
		t.Fatal("unknown import resent", posts, e)
	}
}
func TestPublicImportMetadataRefusesBeforeNativeMigration(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, body := range []string{`{"private":true,"clone_url":"https://github.com/a/b.git"}`, `{"clone_url":"https://github.com/a/b.git"}`, `{"private":false,"clone_url":"https://localhost/a/b.git"}`, `{"visibility":"private","http_url_to_repo":"https://gitlab.com/a/b.git"}`} {
		s.client.Transport = releaseOperationTransport(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "" {
				t.Fatal("credential leaked")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		})
		source := "https://github.com/a/b"
		if strings.Contains(body, "visibility") {
			source = "https://gitlab.com/a/b"
		}
		if s.verifyPublicImport(t.Context(), source) == nil {
			t.Fatal("private or foreign source admitted")
		}
	}
}
