package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
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
		owner, repo string
		valid       bool
	}{{"developer", ".github", true}, {"..", "repo", false}, {"a%2Fb", "repo", false}, {"", "repo", false}, {"owner", "../repo", false}} {
		_, err := repositoryPath(repositoryKey{tc.owner, tc.repo})
		if (err == nil) != tc.valid {
			t.Errorf("key %#v: %v", tc, err)
		}
	}
	for _, paging := range []pageRequest{{10001, 20}, {1, 101}} {
		if _, _, err := pagination(paging); err == nil {
			t.Error("invalid pagination accepted")
		}
	}
	if page, limit, err := pagination(pageRequest{}); err != nil || page != 1 || limit != 20 {
		t.Fatal("incorrect default pagination")
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
			_, err = s.forge(context.Background(), "GET", "/user", forgeCredential{Kind: "pat", Token: "test-token"}, nil, &out)
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
	for _, procedure := range []string{golfv1connect.SessionServiceGetSessionProcedure, golfv1connect.RepositoryServiceListRepositoriesProcedure, golfv1connect.RepositoryServiceCreateRepositoryProcedure, golfv1connect.RepositoryServiceGetRepositoryProcedure, golfv1connect.RepositoryServiceListBranchesProcedure, golfv1connect.RepositoryServiceListTagsProcedure, golfv1connect.RepositoryServiceListCommitsProcedure, golfv1connect.RepositoryServiceGetContentsProcedure, golfv1connect.RepositoryServiceListIssuesProcedure, golfv1connect.RepositoryServiceGetIssueProcedure} {
		body := &unreadBody{t: t}
		r := httptest.NewRequest("POST", "/rpc"+procedure, body)
		r.Header.Set("Origin", s.config.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Content-Encoding", "gzip")
		r.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 401 || !strings.Contains(w.Body.String(), `"code":"unauthenticated"`) || w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("anonymous %s: %d %s", procedure, w.Code, w.Body.String())
		}
	}
}

type unreadBody struct{ t *testing.T }

func (r *unreadBody) Read([]byte) (int, error) {
	r.t.Error("unauthenticated compressed body was read before rejection")
	return 0, errors.New("must not read")
}

func TestRepositoryBrowserWithPostgres(t *testing.T) {
	db := testDatabase(t)
	const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const plain = "<script>alert('text only')</script>\nHello 雪\n"
	files := map[string]string{"plain.txt": plain, "nested/hello world 雪.txt": plain, "limit.txt": strings.Repeat("x", maxPreviewBytes), "binary": "hello\x00binary", "control": "hello\x1b[31m", "invalid-utf8": "\xff\xfe", "lfs": "version https://git-lfs.github.com/spec/v1\noid sha256:" + strings.Repeat("b", 64) + "\nsize 90000000\n", "lfs-pointer": "version https://git-lfs.github.com/spec/v1\noid sha256:" + strings.Repeat("b", 64) + "\nsize 90000000\n", "large": strings.Repeat("x", maxPreviewBytes+1), "symlink": "outside", "submodule": "submodule", "mismatch": "expected"}
	objects := newSourceObjectFixture(sha, files, map[string]string{"symlink": "symlink", "submodule": "submodule"})
	for i := range objects.root {
		if objects.root[i].Path == "large" {
			objects.root[i].Size = maxPreviewBytes + 1
		}
	}
	objects.root = append(objects.root, sourceTreeEntry{Path: "huge-directory", Mode: "040000", Type: "tree", SHA: strings.Repeat("f", 40)})
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
			respond(w, 200, Repository{ID: 2, Name: "empty", FullName: "developer/empty", HTMLURL: "https://forge.invalid/developer/empty", Empty: true})
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
		if strings.HasPrefix(r.URL.Path, base+"/git/refs/heads/") {
			name := strings.TrimPrefix(r.URL.Path, base+"/git/refs/heads/")
			respond(w, 200, []map[string]any{{"ref": "refs/heads/" + name, "object": map[string]string{"type": "commit", "sha": sha}}})
			return
		}
		if strings.HasPrefix(r.URL.Path, base+"/tags/") {
			w.WriteHeader(404)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/git/trees/"+strings.Repeat("f", 40)) {
			respond(w, 200, sourceTree{SHA: strings.Repeat("f", 40), Page: 1, Total: maxDirectoryEntries + 1, Truncated: true})
			return
		}
		if strings.Contains(r.URL.Path, "/git/blobs/") {
			contentFetches.Add(1)
			if path.Base(r.URL.Path) == sourceBlobHash([]byte("expected"), 40) {
				respond(w, 200, map[string]any{"sha": path.Base(r.URL.Path), "size": 8, "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte("wrong!!!"))})
				return
			}
		}
		if objects.serve(w, r, base) {
			return
		}
		switch r.URL.Path {
		case base:
			respond(w, 200, Repository{ID: 1, Name: "example", FullName: "developer/example", HTMLURL: "https://forge.invalid/developer/example", DefaultBranch: "main", Private: true})
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
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()

	s, err := New(testConfig(upstream.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	sessions, repositories, _, _, _ := testRPCClients(t, s)
	ctx := context.Background()
	if _, err := sessions.LoginWithGiteaToken(ctx, connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: "browser-user-token"})); err != nil {
		t.Fatal(err)
	}
	key := func(name string) *golfv1.RepositoryKey { return &golfv1.RepositoryKey{Owner: "developer", Name: name} }
	repo, err := repositories.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: key("example")}))
	if err != nil || !repo.Msg.Repository.Private || repo.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("repository metadata", err)
	}
	empty, err := repositories.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: key("empty")}))
	if err != nil || !empty.Msg.Repository.Empty {
		t.Fatal("empty metadata", err)
	}
	branches, err := repositories.ListBranches(ctx, connect.NewRequest(&golfv1.ListBranchesRequest{Repository: key("empty")}))
	if err != nil || len(branches.Msg.Branches) != 0 {
		t.Fatal("empty branches", err)
	}
	commits, err := repositories.ListCommits(ctx, connect.NewRequest(&golfv1.ListCommitsRequest{Repository: key("empty")}))
	if err != nil || len(commits.Msg.Commits) != 0 {
		t.Fatal("empty commits", err)
	}
	branches, err = repositories.ListBranches(ctx, connect.NewRequest(&golfv1.ListBranchesRequest{Repository: key("example"), Page: &golfv1.PageRequest{Limit: 1}}))
	if err != nil || branches.Msg.Page.NextPage != 2 || branches.Msg.Branches[0].Name != "feature/slash" {
		t.Fatal("branches pagination", err)
	}
	commits, err = repositories.ListCommits(ctx, connect.NewRequest(&golfv1.ListCommitsRequest{Repository: key("example"), Ref: "feature/slash", Page: &golfv1.PageRequest{Limit: 1}}))
	if err != nil || commits.Msg.Page.NextPage != 2 || commits.Msg.Commits[0].AuthorName != "Author" {
		t.Fatal("commit history", err)
	}
	commits, err = repositories.ListCommits(ctx, connect.NewRequest(&golfv1.ListCommitsRequest{Repository: key("example"), Page: &golfv1.PageRequest{Page: 2}}))
	if err != nil || len(commits.Msg.Commits) != 0 || commits.Msg.Page.NextPage != 0 {
		t.Fatal("terminal page", err)
	}
	directory, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example"), Ref: "feature/slash"}))
	if err != nil || directory.Msg.Kind != golfv1.SourceEntryType_SOURCE_ENTRY_TYPE_DIRECTORY || directory.Msg.CommitId != sha {
		t.Fatal("pinned directory", err)
	}
	nested, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example"), Path: "nested/hello world 雪.txt"}))
	if err != nil || nested.Msg.File.GetContent() != plain {
		t.Fatal("nested unicode path", err)
	}
	for _, tc := range []struct {
		name string
		call func() error
		code connect.Code
	}{
		{"missing commit", func() error {
			_, err := repositories.ListCommits(ctx, connect.NewRequest(&golfv1.ListCommitsRequest{Repository: key("example"), Ref: "missing"}))
			return err
		}, connect.CodeNotFound},
		{"empty contents", func() error {
			_, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("empty")}))
			return err
		}, connect.CodeFailedPrecondition},
		{"missing file", func() error {
			_, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example"), Path: "missing"}))
			return err
		}, connect.CodeNotFound},
		{"pinned metadata mismatch", func() error {
			_, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example"), Path: "mismatch"}))
			return err
		}, connect.CodeUnavailable},
		{"oversized directory", func() error {
			_, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example"), Path: "huge-directory"}))
			return err
		}, connect.CodeResourceExhausted},
		{"PR is not issue", func() error {
			_, err := repositories.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key("example"), Number: 2}))
			return err
		}, connect.CodeNotFound},
		{"zero issue", func() error {
			_, err := repositories.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key("example")}))
			return err
		}, connect.CodeInvalidArgument},
		{"oversized issue number", func() error {
			_, err := repositories.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key("example"), Number: 4294967295}))
			return err
		}, connect.CodeInvalidArgument},
		{"unknown enum", func() error {
			_, err := repositories.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: key("example"), State: golfv1.IssueState(99)}))
			return err
		}, connect.CodeInvalidArgument},
		{"missing key", func() error {
			_, err := repositories.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{}))
			return err
		}, connect.CodeInvalidArgument},
		{"page bound", func() error {
			_, err := repositories.ListBranches(ctx, connect.NewRequest(&golfv1.ListBranchesRequest{Repository: key("example"), Page: &golfv1.PageRequest{Limit: 101}}))
			return err
		}, connect.CodeInvalidArgument},
		{"revision expression", func() error {
			_, err := repositories.ListCommits(ctx, connect.NewRequest(&golfv1.ListCommitsRequest{Repository: key("example"), Ref: "main^"}))
			return err
		}, connect.CodeInvalidArgument},
		{"traversal", func() error {
			_, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example"), Path: "../secret"}))
			return err
		}, connect.CodeInvalidArgument},
		{"private", func() error {
			_, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("hidden")}))
			return err
		}, connect.CodeNotFound},
		{"scope denial", func() error {
			_, err := repositories.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: key("denied")}))
			return err
		}, connect.CodePermissionDenied},
		{"outage", func() error {
			_, err := repositories.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: key("outage")}))
			return err
		}, connect.CodeUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); connect.CodeOf(err) != tc.code {
				t.Fatalf("got %v, want %v", err, tc.code)
			}
		})
	}
	for _, name := range []string{"plain.txt", "limit.txt", "binary", "control", "invalid-utf8", "lfs", "lfs-pointer", "large", "symlink", "submodule"} {
		t.Run("preview/"+name, func(t *testing.T) {
			before := contentFetches.Load()
			result, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example"), Ref: "feature/slash", Path: name}))
			if err != nil {
				t.Fatal(err)
			}
			if result.Msg.CommitId != sha || result.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("pin/cache boundary")
			}
			file := result.Msg.File
			if name == "plain.txt" || name == "limit.txt" {
				if file.Content == nil || file.PreviewReason != "" {
					t.Fatal("text missing")
				}
				if name == "plain.txt" && *file.Content != plain {
					t.Fatal("text transformed")
				}
			} else if file.Content != nil || file.PreviewReason == "" {
				t.Fatal("unsafe preview exposed")
			}
			if (name == "large" || name == "symlink" || name == "submodule") && contentFetches.Load() != before {
				t.Fatal("metadata-only object fetched")
			}
		})
	}
	issues, err := repositories.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: key("example")}))
	if err != nil || len(issues.Msg.Issues) != 1 || issues.Msg.Issues[0].Body != "<script>plain text</script>" {
		t.Fatal("issue filtering/text", err)
	}
	issue, err := repositories.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key("example"), Number: 1}))
	if err != nil || issue.Msg.Issue.State != golfv1.IssueState_ISSUE_STATE_CLOSED {
		t.Fatal("issue detail", err)
	}
	revoked.Store(true)
	calls := []func() error{
		func() error {
			_, err := repositories.GetRepository(ctx, connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: key("example")}))
			return err
		},
		func() error {
			_, err := repositories.ListBranches(ctx, connect.NewRequest(&golfv1.ListBranchesRequest{Repository: key("example")}))
			return err
		},
		func() error {
			_, err := repositories.ListCommits(ctx, connect.NewRequest(&golfv1.ListCommitsRequest{Repository: key("example")}))
			return err
		},
		func() error {
			_, err := repositories.GetContents(ctx, connect.NewRequest(&golfv1.GetContentsRequest{Repository: key("example")}))
			return err
		},
		func() error {
			_, err := repositories.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: key("example")}))
			return err
		},
		func() error {
			_, err := repositories.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key("example"), Number: 1}))
			return err
		},
	}
	for _, call := range calls {
		if err := call(); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("revoked upstream token accepted", err)
		}
	}
}
