package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type pullMutationFixture struct {
	*pullFixture
	mu             sync.Mutex
	row            forgePull
	posts, patches atomic.Int32
	writeStatus    atomic.Int32
	hook           func(http.ResponseWriter, *http.Request, forgePull) bool
}

func copyMutationPull(row forgePull) forgePull {
	data, _ := json.Marshal(row)
	var copy forgePull
	_ = json.Unmarshal(data, &copy)
	return copy
}
func newPullMutationFixture(t *testing.T) *pullMutationFixture {
	t.Helper()
	base := &pullFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}
	base.mode.Store("")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/repos/alice/private/pulls/7", nil)
	req.Header.Set("Authorization", "token pull-pat")
	base.serveProvider(rec, req)
	f := &pullMutationFixture{pullFixture: base}
	if err := json.Unmarshal(rec.Body.Bytes(), &f.row); err != nil {
		t.Fatal(err)
	}
	f.row.ContentVersion = proto.Int64(3)
	provider := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *pullMutationFixture) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	mode := f.mode.Load().(string)
	if r.URL.Path == "/api/v1/user" && r.Header.Get("Authorization") == "token other-pat" {
		_ = json.NewEncoder(w).Encode(User{ID: 43, Login: "bob"})
		return
	}
	authorized := r.Header.Get("Authorization") == "token pull-pat" || r.Header.Get("Authorization") == "Bearer pull-oauth"
	if !authorized || mode == "revoked" || mode == "wrong-identity" {
		f.serveProvider(w, r)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/v1/repos/author/fork" {
		if mode == "source-denied" {
			w.WriteHeader(404)
			return
		}
		id := int64(23)
		if mode == "source-rebound" {
			id++
		}
		_ = json.NewEncoder(w).Encode(Repository{ID: id, Name: "fork", FullName: "author/fork", Private: true, HTMLURL: "https://forge.invalid/author/fork"})
		return
	}
	if r.Method == "GET" && strings.Contains(r.URL.Path, "/branches/") {
		branch, sha := "main", strings.Repeat("b", 40)
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/author/fork/") || strings.HasSuffix(r.URL.Path, "/feature/slash") {
			branch, sha = "feature/slash", strings.Repeat("a", 40)
		}
		if mode == "branch-stale" || mode == "branch-after-write" && f.posts.Load() > 0 {
			sha = strings.Repeat("c", 40)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"name": branch, "commit": map[string]string{"id": sha}})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/v1/repos/alice/private/pulls/7" {
		f.mu.Lock()
		row := copyMutationPull(f.row)
		f.mu.Unlock()
		if mode == "missing-version" {
			row.ContentVersion = nil
		}
		if mode == "negative-version" {
			row.ContentVersion = proto.Int64(-1)
		}
		_ = json.NewEncoder(w).Encode(row)
		return
	}
	if (r.Method == "POST" && r.URL.Path == "/api/v1/repos/alice/private/pulls") || (r.Method == "PATCH" && r.URL.Path == "/api/v1/repos/alice/private/pulls/7") {
		if r.Method == "POST" {
			f.posts.Add(1)
		} else {
			f.patches.Add(1)
		}
		var reserved int
		if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations WHERE state='OUTCOME_UNKNOWN'").Scan(&reserved); err != nil || reserved == 0 {
			panic("native write before reservation")
		}
		if status := f.writeStatus.Load(); status != 0 {
			w.WriteHeader(int(status))
			return
		}
		var input map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		row := copyMutationPull(f.row)
		if r.Method == "PATCH" {
			if len(input) != 2 || input["content_version"] == nil {
				f.mu.Unlock()
				w.WriteHeader(422)
				return
			}
			var version int64
			_ = json.Unmarshal(input["content_version"], &version)
			if version != *row.ContentVersion {
				f.mu.Unlock()
				w.WriteHeader(409)
				return
			}
			if input["body"] != nil {
				_ = json.Unmarshal(input["body"], &row.Body)
				row.ContentVersion = proto.Int64(version + 1)
			}
			if input["title"] != nil {
				_ = json.Unmarshal(input["title"], &row.Title)
			}
			if input["state"] != nil {
				_ = json.Unmarshal(input["state"], &row.State)
			}
		} else {
			if len(input) != 4 {
				f.mu.Unlock()
				w.WriteHeader(422)
				return
			}
			var head, base string
			_ = json.Unmarshal(input["head"], &head)
			_ = json.Unmarshal(input["base"], &base)
			if base != "main" || head != "feature/slash" && head != "author/fork:feature/slash" {
				f.mu.Unlock()
				w.WriteHeader(422)
				return
			}
			if head == "feature/slash" {
				row.Head.RepositoryID = 11
			}
			_ = json.Unmarshal(input["title"], &row.Title)
			_ = json.Unmarshal(input["body"], &row.Body)
		}
		row.Draft = proto.Bool(nativePullDraftPrefix(row.Title) != "")
		row.UpdatedAt = "2026-10-03T12:00:00Z"
		f.row = copyMutationPull(row)
		f.mu.Unlock()
		if f.hook != nil && f.hook(w, r, row) {
			return
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(row)
		return
	}
	f.serveProvider(w, r)
}
func (f *pullMutationFixture) update(key string) *golfv1.UpdatePullRequestRequest {
	f.mu.Lock()
	row := copyMutationPull(f.row)
	f.mu.Unlock()
	return &golfv1.UpdatePullRequestRequest{Repository: pullKey, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7, ExpectedRevision: pullRevision(row), IdempotencyKey: key}
}
func pullCreateInput(key string) *golfv1.CreatePullRequestRequest {
	return &golfv1.CreatePullRequestRequest{Repository: pullKey, RepositoryId: "11", SourceRepository: &golfv1.RepositoryKey{Owner: "author", Name: "fork"}, SourceRepositoryId: "23", BaseBranch: "main", HeadBranch: "feature/slash", BaseCommitId: strings.Repeat("b", 40), HeadCommitId: strings.Repeat("a", 40), Title: "New proposal", Body: "Private description", IdempotencyKey: key}
}
func TestPullMutationLifecycle(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			f := newPullMutationFixture(t)
			client := f.client(t, f.session(t, kind))
			for i, field := range []string{"title", "body", "draft", "ready", "close", "reopen"} {
				input := f.update(discussionKey(i + 1))
				switch field {
				case "title":
					input.Title = proto.String("Edited PR title")
				case "body":
					input.Body = proto.String("")
				case "draft":
					input.Draft = proto.Bool(true)
				case "ready":
					input.Draft = proto.Bool(false)
				case "close":
					input.State = golfv1.IssueState_ISSUE_STATE_CLOSED
				case "reopen":
					input.State = golfv1.IssueState_ISSUE_STATE_OPEN
				}
				var wg sync.WaitGroup
				for range 5 {
					wg.Go(func() {
						if _, err := client.UpdatePullRequest(t.Context(), connect.NewRequest(input)); err != nil {
							t.Error(err)
						}
					})
				}
				wg.Wait()
				result, err := client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: input.IdempotencyKey}))
				if err != nil {
					t.Fatal(err)
				}
				if result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || result.Msg.PullRequest == nil || result.Msg.Mutation.PullRequestId != "9007199254740993" || result.Msg.Mutation.IssueId != "" || result.Msg.Mutation.ObservedResultId != "9007199254740993" {
					t.Fatal("PR outcome/identity lost", result.Msg)
				}
				if f.patches.Load() != int32(i+1) {
					t.Fatal("duplicate PATCH")
				}
				if field == "body" && result.Msg.PullRequest.Body != "" {
					t.Fatal("empty description lost")
				}
				if field == "ready" && result.Msg.PullRequest.Draft {
					t.Fatal("explicit false lost")
				}
			}
			var activity int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE topic='pulls'").Scan(&activity); err != nil || activity != 6 {
				t.Fatal("missing PR live events", activity, err)
			}
			for _, sql := range []string{"UPDATE golf_issue_mutations SET pull_request_id=99", "UPDATE golf_issue_mutations SET pull_request=false"} {
				if _, err := f.db.Exec(sql); err == nil {
					t.Fatal("terminal target mutable")
				}
			}
		})
	}
}
func TestPullMutationCreateAndReplay(t *testing.T) {
	for _, draft := range []bool{false, true} {
		for _, fork := range []bool{false, true} {
			t.Run(fmt.Sprintf("draft=%v/fork=%v", draft, fork), func(t *testing.T) {
				f := newPullMutationFixture(t)
				client := f.client(t, f.session(t, "pat"))
				input := pullCreateInput(discussionKey(1))
				input.Draft = draft
				if !fork {
					input.SourceRepository = proto.Clone(pullKey).(*golfv1.RepositoryKey)
					input.SourceRepositoryId = "11"
				}
				var wg sync.WaitGroup
				for range 5 {
					wg.Go(func() {
						if _, err := client.CreatePullRequest(t.Context(), connect.NewRequest(input)); err != nil {
							t.Error(err)
						}
					})
				}
				wg.Wait()
				result, err := client.CreatePullRequest(t.Context(), connect.NewRequest(input))
				if err != nil {
					t.Fatal(err)
				}
				if result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || result.Msg.PullRequest == nil || result.Msg.PullRequest.Draft != draft || f.posts.Load() != 1 {
					t.Fatal("create outcome lost", result.Msg)
				}
				input.Body = "Changed intent"
				if _, err := client.CreatePullRequest(t.Context(), connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeFailedPrecondition || f.posts.Load() != 1 {
					t.Fatal("conflicting key reused", err)
				}
			})
		}
	}
}
func TestPullMutationPreflight(t *testing.T) {
	for _, mode := range []string{"source-denied", "source-rebound", "branch-stale", "repository-denied", "repository-rebound"} {
		for _, draft := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/draft=%v", mode, draft), func(t *testing.T) {
				f := newPullMutationFixture(t)
				client := f.client(t, f.session(t, "pat"))
				f.mode.Store(mode)
				input := pullCreateInput(discussionKey(1))
				input.Draft = draft
				result, err := client.CreatePullRequest(t.Context(), connect.NewRequest(input))
				if err != nil {
					t.Fatal(err)
				}
				if result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.posts.Load() != 0 {
					t.Fatal("failed preflight reached native POST", result.Msg)
				}
			})
		}
	}
	for _, mode := range []string{"stale", "wrong-id", "missing-version", "negative-version", "merged", "unchanged", "closed-draft"} {
		t.Run(mode, func(t *testing.T) {
			f := newPullMutationFixture(t)
			client := f.client(t, f.session(t, "pat"))
			input := f.update(discussionKey(1))
			input.Title = proto.String("Edited title")
			f.mu.Lock()
			switch mode {
			case "stale":
				f.row.Title = "Concurrent title"
			case "wrong-id":
				f.row.ID++
			case "merged":
				f.row.Merged = proto.Bool(true)
				f.row.State = "closed"
				f.row.MergedAt = proto.String(f.row.UpdatedAt)
				f.row.MergeCommitID = proto.String(strings.Repeat("d", 40))
				input = f.updateUnsafe(input)
				input.Title = nil
				input.State = golfv1.IssueState_ISSUE_STATE_OPEN
			case "unchanged":
				input.Title = proto.String(f.row.Title)
			case "closed-draft":
				f.row.State = "closed"
				input = f.updateUnsafe(input)
				input.Title = nil
				input.Draft = proto.Bool(true)
			}
			f.mu.Unlock()
			if strings.Contains(mode, "version") {
				f.mode.Store(mode)
			}
			result, err := client.UpdatePullRequest(t.Context(), connect.NewRequest(input))
			if err != nil {
				t.Fatal(err)
			}
			if result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.patches.Load() != 0 {
				t.Fatal("invalid preflight reached PATCH", result.Msg)
			}
		})
	}
}
func (f *pullMutationFixture) updateUnsafe(input *golfv1.UpdatePullRequestRequest) *golfv1.UpdatePullRequestRequest {
	input.ExpectedRevision = pullRevision(f.row)
	return input
}
func TestPullMutationUncertainReceipts(t *testing.T) {
	for _, create := range []bool{false, true} {
		for _, mode := range []string{"lost", "wrong-author", "wrong-id", "negative-version", "changed-head", "changed-body", "post-changed-head", "revoked-after-write"} {
			t.Run(fmt.Sprintf("create=%v/%s", create, mode), func(t *testing.T) {
				f := newPullMutationFixture(t)
				source := f.session(t, "pat")
				client := f.client(t, source)
				other := f.client(t, f.session(t, "pat"))
				update := f.update(discussionKey(1))
				update.Title = proto.String("Edited title")
				input := pullCreateInput(discussionKey(1))
				f.hook = func(w http.ResponseWriter, r *http.Request, row forgePull) bool {
					switch mode {
					case "lost":
						w.WriteHeader(500)
						return true
					case "wrong-author":
						row.User.ID++
					case "wrong-id":
						row.ID++
					case "negative-version":
						row.ContentVersion = proto.Int64(-1)
					case "changed-head":
						row.Head.SHA = strings.Repeat("c", 40)
					case "changed-body":
						row.Body = "Unrelated change"
					case "post-changed-head":
						f.mu.Lock()
						f.row.Head.SHA = strings.Repeat("c", 40)
						f.mu.Unlock()
					case "revoked-after-write":
						if err := f.s.logoutSession(context.Background(), source.Value); err != nil {
							t.Error(err)
						}
					}
					w.WriteHeader(201)
					_ = json.NewEncoder(w).Encode(row)
					return true
				}
				if create {
					_, _ = client.CreatePullRequest(t.Context(), connect.NewRequest(input))
				} else {
					_, _ = client.UpdatePullRequest(t.Context(), connect.NewRequest(update))
				}
				result, err := other.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)}))
				if err != nil {
					t.Fatal(err)
				}
				if result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN || result.Msg.PullRequest != nil {
					t.Fatal("uncertain result became success", result.Msg)
				}
				if create {
					_, err = other.CreatePullRequest(t.Context(), connect.NewRequest(input))
				} else {
					_, err = other.UpdatePullRequest(t.Context(), connect.NewRequest(update))
				}
				if err != nil {
					t.Fatal(err)
				}
				if f.posts.Load()+f.patches.Load() != 1 {
					t.Fatal("unknown outcome redispatched")
				}
				foreignSource, err := f.s.createSession(t.Context(), User{ID: 43, Login: "bob"}, "pat", "other-pat", "")
				if err != nil {
					t.Fatal(err)
				}
				foreign := f.client(t, foreignSource)
				if _, err := foreign.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: discussionKey(1)})); connect.CodeOf(err) != connect.CodeNotFound {
					t.Fatal("foreign outcome exposed", err)
				}
			})
		}
	}
}
func TestPullMutationBranchAfterWrite(t *testing.T) {
	f := newPullMutationFixture(t)
	client := f.client(t, f.session(t, "pat"))
	f.mode.Store("branch-after-write")
	result, err := client.CreatePullRequest(t.Context(), connect.NewRequest(pullCreateInput(discussionKey(1))))
	if err != nil {
		t.Fatal(err)
	}
	if result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN || result.Msg.Mutation.ObservedResultId != "9007199254740993" || result.Msg.Mutation.PullRequestId != "" {
		t.Fatal("branch race claimed success", result.Msg)
	}
}
func TestPullMutationRPCBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"CreatePullRequest", "UpdatePullRequest"} {
		path := "/golf.v1.RepositoryService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("mutation decoded before auth/origin", w.Code)
			}
		}
		if r := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); r.Code != 403 {
			t.Fatal("read-only credential reached mutation")
		}
	}
}
func TestPullMutationRevisionProjection(t *testing.T) {
	f := &pullFixture{}
	f.mode.Store("")
	r := httptest.NewRequest("GET", "/api/v1/repos/alice/private/pulls/7", nil)
	r.Header.Set("Authorization", "token pull-pat")
	w := httptest.NewRecorder()
	f.serveProvider(w, r)
	var row forgePull
	_ = json.Unmarshal(w.Body.Bytes(), &row)
	row.ContentVersion = proto.Int64(0)
	revision := pullRevision(row)
	row.User.AvatarURL = "changed"
	row.User.Login = "renamed"
	row.Head.Label = "New label"
	row.Head.Repository = &Repository{ID: 23, Description: "Changed description"}
	if revision == "" || pullRevision(row) != revision {
		t.Fatal("unrelated metadata changed PR revision")
	}
	row.Head.SHA = strings.Repeat("c", 40)
	if pullRevision(row) == revision {
		t.Fatal("changed head did not change revision")
	}
	for _, title := range []string{"WIP: Proposal", "[WIP] Proposal", "wip: Proposal"} {
		ready, err := nativePullDraftTitle(title, false)
		if err != nil || ready != "Proposal" {
			t.Fatal("native default draft prefix lost", title, err)
		}
	}
	if _, err := nativePullDraftTitle("Custom: Proposal", false); err == nil {
		t.Fatal("unknown native prefix guessed")
	}
}

func TestPullMutationNativeDenials(t *testing.T) {
	for _, create := range []bool{false, true} {
		for _, status := range []int{403, 409, 412, 422, 500} {
			t.Run(fmt.Sprintf("create=%v/status=%d", create, status), func(t *testing.T) {
				f := newPullMutationFixture(t)
				client := f.client(t, f.session(t, "pat"))
				f.writeStatus.Store(int32(status))
				input := pullCreateInput(discussionKey(1))
				update := f.update(discussionKey(1))
				update.Body = proto.String("Edited description")
				var result *golfv1.IssueMutation
				for range 2 {
					if create {
						r, err := client.CreatePullRequest(t.Context(), connect.NewRequest(input))
						if err != nil {
							t.Fatal(err)
						}
						result = r.Msg.Mutation
					} else {
						r, err := client.UpdatePullRequest(t.Context(), connect.NewRequest(update))
						if err != nil {
							t.Fatal(err)
						}
						result = r.Msg.Mutation
					}
				}
				expected := golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED
				if status == 500 {
					expected = golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN
				}
				if result.State != expected || f.posts.Load()+f.patches.Load() != 1 {
					t.Fatal("native denial replay/state", result)
				}
			})
		}
	}
}
func TestPullMutationValidation(t *testing.T) {
	f := newPullMutationFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for i, change := range []func(*golfv1.CreatePullRequestRequest){func(r *golfv1.CreatePullRequestRequest) { r.BaseCommitId = "main" }, func(r *golfv1.CreatePullRequestRequest) { r.HeadBranch = "refs/pull/7/head" }, func(r *golfv1.CreatePullRequestRequest) { r.SourceRepositoryId = "0" }, func(r *golfv1.CreatePullRequestRequest) { r.Title = "[WIP] Not selected as draft" }, func(r *golfv1.CreatePullRequestRequest) { r.Body = "bad\x00body" }, func(r *golfv1.CreatePullRequestRequest) {
		r.SourceRepository = proto.Clone(pullKey).(*golfv1.RepositoryKey)
		r.SourceRepositoryId = "11"
		r.HeadBranch = r.BaseBranch
	}} {
		input := pullCreateInput(discussionKey(i + 1))
		change(input)
		if _, err := client.CreatePullRequest(t.Context(), connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid create accepted", i, err)
		}
	}
	for i, change := range []func(*golfv1.UpdatePullRequestRequest){func(r *golfv1.UpdatePullRequestRequest) { r.Body = proto.String("second field") }, func(r *golfv1.UpdatePullRequestRequest) { r.ExpectedRevision = "bad" }, func(r *golfv1.UpdatePullRequestRequest) { r.Title = proto.String(" padded ") }, func(r *golfv1.UpdatePullRequestRequest) { r.PullRequestId = "0" }} {
		input := f.update(discussionKey(i + 20))
		input.Title = proto.String("New title")
		change(input)
		if _, err := client.UpdatePullRequest(t.Context(), connect.NewRequest(input)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid update accepted", i, err)
		}
	}
	if f.posts.Load()+f.patches.Load() != 0 {
		t.Fatal("invalid intent reached native write")
	}
	var records int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations").Scan(&records); err != nil || records != 0 {
		t.Fatal("invalid input reserved intent", records, err)
	}
}
