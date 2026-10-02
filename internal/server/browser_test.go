package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestBrowserInputBoundaries(t *testing.T) {
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"", true}, {"main", true}, {"feature/fix", true}, {strings.Repeat("a", 40), true},
		{"refs/tags/v1.0", true}, {"mañana", true}, {"../secret", false}, {"main~1", false},
		{"main^{tree}", false}, {"main@{0}", false}, {"/main", false}, {"main/", false},
		{"main//next", false}, {"a.lock", false}, {"main\n", false}, {"a\\b", false},
		{"-option", false}, {"main:secret", false}, {strings.Repeat("a", 1025), false},
	} {
		if got := validRef(tc.value); got != tc.valid {
			t.Errorf("ref %q valid=%v, want %v", tc.value, got, tc.valid)
		}
	}
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"", true}, {"nested/hello world 雪.txt", true}, {".github/README.md", true},
		{"../file", false}, {"a/../file", false}, {"/absolute", false}, {"a//b", false},
		{"a/./b", false}, {"file\x00", false}, {"a\\b", false}, {"a/", false},
	} {
		if got := validSourcePath(tc.value); got != tc.valid {
			t.Errorf("path %q valid=%v, want %v", tc.value, got, tc.valid)
		}
	}
	for _, tc := range []struct {
		owner, repo, query string
		valid              bool
	}{
		{"developer", ".github", "ref=feature%2Ffix", true},
		{"..", "example", "", false}, {"a%2Fb", "example", "", false},
		{"developer", "example", "ref=main&ref=other", false},
		{"developer", "example", "url=https://evil.example", false},
		{"developer", "example", "ref=%GG", false},
	} {
		request := httptest.NewRequest("GET", "/?"+tc.query, nil)
		route := chi.NewRouteContext()
		route.URLParams.Add("owner", tc.owner)
		route.URLParams.Add("repo", tc.repo)
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
		_, _, got := browserInput(httptest.NewRecorder(), request, "ref")
		if got != tc.valid {
			t.Errorf("route/query %#v valid=%v", tc, got)
		}
	}
	for _, raw := range []string{"page=0", "page=10001", "limit=101", "limit=", "page=01", "page=%2B1"} {
		query, _ := url.ParseQuery(raw)
		if _, _, ok := browserPage(httptest.NewRecorder(), query); ok {
			t.Errorf("invalid pagination accepted: %s", raw)
		}
	}
}

func TestForgeResponseBounds(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		chunked    bool
		large      bool
	}{
		{"declared oversized", `"` + strings.Repeat("x", maxForgeResponse) + `"`, false, true},
		{"streamed oversized", `"` + strings.Repeat("x", maxForgeResponse) + `"`, true, true},
		{"second JSON value", `{} {}`, false, false},
		{"truncated", `{"id":`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.chunked {
					w.(http.Flusher).Flush()
				}
				fmt.Fprint(w, tc.body)
			}))
			defer upstream.Close()
			s, err := New(testConfig(upstream.URL), nil)
			if err != nil {
				t.Fatal(err)
			}
			var out any
			_, err = s.forge(context.Background(), "GET", "/user", "test-token", nil, &out)
			if err == nil || errors.Is(err, errForgeResponseTooLarge) != tc.large {
				t.Fatalf("unexpected response error: %v", err)
			}
		})
	}
}

func TestBrowserRequiresSession(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/branches", "/commits", "/contents", "/issues", "/issues/1"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", "/api/repositories/dev/repo"+suffix, nil))
		if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("anonymous %s: status=%d cache=%s", suffix, w.Code, w.Header().Get("Cache-Control"))
		}
	}
}

func TestRepositoryBrowserWithPostgres(t *testing.T) {
	db := testDatabase(t)
	const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const otherSHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	const plain = "<script>alert('text only')</script>\nHello 雪\n"
	var revoked atomic.Bool
	var contentFetches atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "token browser-user-token" || revoked.Load() {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/user" {
			respond(w, 200, User{ID: 42, Login: "developer"})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/developer/hidden") {
			w.WriteHeader(404)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/developer/denied") {
			w.WriteHeader(403)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/developer/outage") {
			w.WriteHeader(500)
			return
		}
		if r.URL.Path == "/api/v1/repos/developer/empty" {
			respond(w, 200, Repository{ID: 2, Name: "empty", FullName: "developer/empty", Empty: true})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/developer/empty/") {
			if strings.HasSuffix(r.URL.Path, "/branches") {
				t.Error("empty metadata must prevent Gitea's first-push branch race")
			}
			w.WriteHeader(409)
			return
		}
		base := "/api/v1/repos/developer/example"
		switch r.URL.Path {
		case base:
			respond(w, 200, Repository{ID: 1, Name: "example", FullName: "developer/example", DefaultBranch: "main", Private: true})
		case base + "/branches":
			w.Header().Set("Link", `</ignored?page=2>; rel="next"`)
			fmt.Fprintf(w, `[{"name":"feature/slash","protected":true,"commit":{"id":%q}}]`, sha)
		case base + "/commits":
			if r.URL.Query().Get("sha") == "missing" {
				w.WriteHeader(404)
				return
			}
			if r.URL.Query().Get("stat") != "false" || r.URL.Query().Get("files") != "false" || r.URL.Query().Get("verification") != "false" {
				t.Error("commit resolution must not request unbounded diffs")
			}
			if r.URL.Query().Get("page") == "1" {
				w.Header().Set("Link", `</ignored?page=2>; rel="next"`)
				fmt.Fprintf(w, `[{"sha":%q,"commit":{"message":"A real change","author":{"name":"Author","date":"2026-10-01T12:00:00Z"}}}]`, sha)
			} else {
				fmt.Fprint(w, `[]`)
			}
		case base + "/issues":
			if r.URL.Query().Get("type") != "issues" {
				t.Error("issue query must exclude pull requests upstream")
			}
			fmt.Fprint(w, `[{"id":1,"number":1,"title":"<b>plain</b>","body":"<script>plain text</script>","state":"open","user":{"id":42,"login":"developer"}}, {"id":2,"number":2,"state":"open","pull_request":{}}]`)
		case base + "/issues/1":
			fmt.Fprint(w, `{"id":1,"number":1,"title":"Bug","body":"Body","state":"closed","user":{"id":42,"login":"developer"}}`)
		case base + "/issues/2":
			fmt.Fprint(w, `{"id":2,"number":2,"title":"PR","state":"open","pull_request":{}}`)
		default:
			prefix := base + "/contents-ext/"
			if !strings.HasPrefix(r.URL.Path, prefix) {
				w.WriteHeader(404)
				return
			}
			if r.URL.Query().Get("ref") != sha {
				t.Error("source metadata/content was not pinned to resolved commit")
			}
			name := strings.TrimPrefix(r.URL.Path, prefix)
			if name == "missing" {
				w.WriteHeader(404)
				return
			}
			if name == "huge-directory" {
				entries := make([]forgeContents, maxDirectoryEntries+1)
				respond(w, 200, contentsEnvelope{Directory: entries})
				return
			}
			if name == "." {
				respond(w, 200, contentsEnvelope{Directory: []forgeContents{{sourceEntry: sourceEntry{Name: "plain.txt", Path: "plain.txt", Type: "file", SHA: sha, Size: int64(len(plain))}}}})
				return
			}
			entry := forgeContents{sourceEntry: sourceEntry{Name: name, Path: name, Type: "file", SHA: sha, Size: int64(len(plain))}}
			data := plain
			switch name {
			case "binary":
				data = "hello\x00binary"
			case "control":
				data = "hello\x1b[31m"
			case "invalid-utf8":
				data = "\xff\xfe"
			case "lfs-pointer":
				data = "version https://git-lfs.github.com/spec/v1\noid sha256:" + strings.Repeat("b", 64) + "\nsize 90000000\n"
			case "symlink", "submodule":
				entry.Type = name
			case "large":
				entry.Size = maxPreviewBytes + 1
			case "lfs":
				entry.LFSOID = strings.Repeat("b", 64)
			case "limit.txt":
				data = strings.Repeat("x", maxPreviewBytes)
			case "nested/hello world 雪.txt":
				entry.Name = "hello world 雪.txt"
			}
			if name != "large" {
				entry.Size = int64(len(data))
			}
			if strings.Contains(r.URL.Query().Get("includes"), "file_content") {
				contentFetches.Add(1)
				if name == "large" || name == "lfs" || name == "symlink" || name == "submodule" {
					t.Errorf("fetched metadata-only file %s", name)
				}
				entry.Encoding, entry.Content = "base64", base64.StdEncoding.EncodeToString([]byte(data))
				if name == "mismatch" {
					entry.SHA = otherSHA
				}
			}
			respond(w, 200, contentsEnvelope{File: &entry})
		}
	}))
	defer upstream.Close()
	s, err := New(testConfig(upstream.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRequest("POST", "/api/session", strings.NewReader(`{"token":"browser-user-token"}`))
	login.Header.Set("Origin", "http://localhost:8080")
	login.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, login)
	if w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	request := func(target string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/repositories/developer/"+target, nil)
		r.AddCookie(cookie)
		out := httptest.NewRecorder()
		s.ServeHTTP(out, r)
		if out.Header().Get("Cache-Control") != "no-store" || strings.Contains(out.Body.String(), "browser-user-token") {
			t.Fatal("private response/cache boundary failed")
		}
		return out
	}
	for _, tc := range []struct {
		target string
		status int
		marker string
	}{
		{"example", 200, `"private":true`}, {"empty", 200, `"empty":true`},
		{"empty/branches", 200, `"branches":[]`}, {"empty/commits", 200, `"commits":[]`}, {"empty/contents", 409, `empty_repository`},
		{"example/branches?limit=1", 200, `"next_page":2`},
		{"example/commits?ref=feature%2Fslash&limit=1", 200, `"author_name":"Author"`},
		{"example/commits?page=2", 200, `"commits":[]`},
		{"example/commits?ref=missing", 404, `not_found`},
		{"example/contents?ref=feature%2Fslash", 200, `"kind":"directory"`},
		{"example/contents?path=nested%2Fhello%20world%20%E9%9B%AA.txt", 200, `"kind":"file"`},
		{"example/contents?path=missing", 404, `not_found`},
		{"example/contents?path=mismatch", 502, `invalid_forge_response`},
		{"example/contents?path=huge-directory", 502, `forge_response_too_large`},
		{"example/issues", 200, `"issues":[`}, {"example/issues/1", 200, `"state":"closed"`},
		{"example/issues/2", 404, `not_found`}, {"example/issues/0", 400, `invalid_issue`},
		{"example/issues?state=bogus", 400, `invalid_state`},
		{"example?extra=yes", 400, `invalid_query`}, {"example/branches?limit=101", 400, `invalid_pagination`},
		{"example/commits?ref=main%5E", 400, `invalid_ref`},
		{"example/contents?path=..%2Fsecret", 400, `invalid_source`},
		{"hidden/contents", 404, `not_found`}, {"denied/issues", 403, `forge_forbidden`}, {"outage", 502, `forge_unavailable`},
	} {
		t.Run(tc.target, func(t *testing.T) {
			out := request(tc.target)
			if out.Code != tc.status || !strings.Contains(out.Body.String(), tc.marker) {
				t.Fatalf("status=%d body=%s", out.Code, out.Body.String())
			}
		})
	}
	for _, name := range []string{"plain.txt", "limit.txt", "binary", "control", "invalid-utf8", "lfs", "lfs-pointer", "large", "symlink", "submodule"} {
		t.Run("preview/"+name, func(t *testing.T) {
			before := contentFetches.Load()
			out := request("example/contents?ref=feature%2Fslash&path=" + name)
			if out.Code != 200 {
				t.Fatalf("preview: %d %s", out.Code, out.Body.String())
			}
			var result struct {
				CommitID string     `json:"commit_id"`
				File     sourceFile `json:"file"`
			}
			if err := json.Unmarshal(out.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.CommitID != sha {
				t.Fatal("source was not pinned")
			}
			if name == "plain.txt" || name == "limit.txt" {
				if result.File.Content == nil || result.File.PreviewReason != "" {
					t.Fatal("plain UTF-8 preview missing")
				}
				if name == "plain.txt" && *result.File.Content != plain {
					t.Fatal("source text was transformed")
				}
			} else if result.File.Content != nil || result.File.PreviewReason == "" {
				t.Fatal("unsafe preview exposed or missing explanation")
			}
			if (name == "large" || name == "lfs" || name == "symlink" || name == "submodule") && contentFetches.Load() != before {
				t.Fatal("metadata-only object fetched")
			}
		})
	}
	out := request("example/issues")
	var list struct {
		Issues []Issue `json:"issues"`
	}
	if err := json.Unmarshal(out.Body.Bytes(), &list); err != nil || len(list.Issues) != 1 || list.Issues[0].Body != "<script>plain text</script>" {
		t.Fatal("issue-only or plain-text boundary failed", err)
	}
	revoked.Store(true)
	for _, suffix := range []string{"", "/branches", "/commits", "/contents", "/issues", "/issues/1"} {
		if out := request("example" + suffix); out.Code != 401 {
			t.Errorf("revoked token %s: %d", suffix, out.Code)
		}
	}
}
