package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestDiscussionQueryBoundaries(t *testing.T) {
	for _, q := range []*golfv1.DiscussionQuery{
		{Search: " leading"}, {Search: "private\ntext"}, {Search: strings.Repeat("x", 513)}, {Search: string([]byte{255})},
		{Author: "../other"}, {Assignee: "a&assigned_by=b"}, {MilestoneTitle: "one,two"},
		{LabelNames: []string{""}}, {LabelNames: []string{"a,b"}}, {LabelNames: []string{"bug", "bug"}}, {LabelNames: make([]string, 21)},
	} {
		if validateDiscussionQuery(q) == nil {
			t.Fatal("unsafe/ambiguous query accepted", q)
		}
	}
	if validateDiscussionQuery(&golfv1.DiscussionQuery{Search: `修正 "hello" & q=other`, Author: "alice", Assignee: "Bob", LabelNames: []string{"type/bug", "priority/high"}, MilestoneTitle: "v1.0"}) != nil {
		t.Fatal("literal supported query rejected")
	}
	for _, q := range []pullListQuery{{Sort: "random"}, {BaseBranch: "../x"}, {Discussion: &golfv1.DiscussionQuery{Search: "find"}, Sort: "updated"}} {
		if q.validate() == nil {
			t.Fatal("unsupported native sort/ref combination accepted")
		}
	}
	metadata := &golfv1.DiscussionMetadata{LabelsKnown: true, Labels: []*golfv1.DiscussionLabel{{Name: "bug"}}, AssigneesKnown: true, Assignees: []*golfv1.User{{Login: "alice"}}, MilestoneKnown: true, Milestone: &golfv1.DiscussionMilestone{Title: "v1"}}
	if !discussionQueryMatches(&golfv1.DiscussionQuery{Author: "ALICE", Assignee: "Alice", LabelNames: []string{"bug"}, MilestoneTitle: "v1"}, &golfv1.User{Login: "alice"}, metadata) {
		t.Fatal("current exact metadata selection lost")
	}
	for _, q := range []*golfv1.DiscussionQuery{{LabelNames: []string{"bug", "missing"}}, {MilestoneTitle: "missing"}, {Assignee: "missing"}, {Author: "missing"}} {
		if discussionQueryMatches(q, &golfv1.User{Login: "alice"}, metadata) || discussionQueryMatches(q, nil, nil) {
			t.Fatal("unknown native criteria broadened results")
		}
	}
}

func TestDiscussionQueryNativePagingAndPullAssociation(t *testing.T) {
	var metadata forgeDiscussionMetadata
	if json.Unmarshal([]byte(metadataFixture), &metadata) != nil {
		t.Fatal("metadata fixture")
	}
	repo := metadataRepository()
	issue := discussionIssue{forgeIssue: forgeIssue{Issue: Issue{forgeDiscussionMetadata: metadata, ID: 9007199254740993, Number: 2, Title: "Change", State: "open", User: User{ID: 7, Login: "developer"}, CreatedAt: "2026-10-05T12:00:00Z", UpdatedAt: "2026-10-05T12:00:00Z", HTMLURL: repo.HTMLURL + "/issues/2"}}, Repository: &struct {
		ID int64 `json:"id"`
	}{ID: repo.ID}}
	var wrongRepository, replacedIssue, denied atomic.Bool
	var reads atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "token query-pat" {
			t.Error("query bypassed native read authority")
			w.WriteHeader(401)
			return
		}
		if denied.Load() {
			w.WriteHeader(403)
			return
		}
		row := issue
		row.Repository = &struct {
			ID int64 `json:"id"`
		}{ID: repo.ID}
		if wrongRepository.Load() {
			row.Repository.ID++
		}
		write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch r.URL.Path {
		case "/api/v1/settings/api":
			write(map[string]any{"max_response_items": 1})
		case "/api/v1/repos/developer/example/issues":
			q := r.URL.Query()
			if q.Get("q") != `fix & q=other` || q.Get("created_by") != "developer" || q.Get("labels") != "type/bug" || q.Get("limit") != "1" || q.Get("page") != "1" || q.Get("state") != "open" {
				t.Error("query escaped scope/filters/paging", q)
			}
			if q.Get("type") == "pulls" {
				row.PullRequest = json.RawMessage(`{"merged":false}`)
				row.HTMLURL = repo.HTMLURL + "/pulls/2"
			}
			w.Header().Set("X-Total-Count", "2")
			write([]discussionIssue{row})
		case "/api/v1/repos/developer/example/pulls/2":
			write(metadataPull(metadata))
		case "/api/v1/repos/developer/example/issues/2":
			row.PullRequest = json.RawMessage(`{"merged":false}`)
			row.HTMLURL = repo.HTMLURL + "/pulls/2"
			if replacedIssue.Load() {
				row.ID++
			}
			write(row)
		default:
			t.Error("unexpected native route", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	token := forgeCredential{Kind: "pat", Token: "query-pat"}
	q := &golfv1.DiscussionQuery{Search: `fix & q=other`, Author: "developer", LabelNames: []string{"type/bug"}}
	rows, next, err := s.searchIssues(context.Background(), token, "/repos/developer/example", repo, "open", pageRequest{Limit: 20}, q)
	if err != nil || len(rows) != 1 || next != 2 {
		t.Fatal("native-clamped page span lost", err)
	}
	q.MilestoneTitle = "missing"
	rows, next, err = s.searchIssues(context.Background(), token, "/repos/developer/example", repo, "open", pageRequest{Limit: 20}, q)
	if err != nil || len(rows) != 0 || next != 2 {
		t.Fatal("unknown native filter broadened or lost empty continuation", err)
	}
	q.MilestoneTitle = ""
	pulls, next, err := s.searchPullRequests(context.Background(), token, "/repos/developer/example", repo, "open", 1, 1, pullListQuery{Discussion: q, BaseBranch: "main"})
	if err != nil || len(pulls) != 1 || pulls[0].Id != "2" || next != 2 {
		t.Fatal("distinct PR/issue ID association lost", err)
	}
	replacedIssue.Store(true)
	if _, _, err = s.searchPullRequests(context.Background(), token, "/repos/developer/example", repo, "open", 1, 1, pullListQuery{Discussion: q}); err == nil {
		t.Fatal("replacement issue adopted")
	}
	replacedIssue.Store(false)
	wrongRepository.Store(true)
	if _, _, err = s.searchIssues(context.Background(), token, "/repos/developer/example", repo, "open", pageRequest{Limit: 20}, q); err == nil {
		t.Fatal("foreign repository rows accepted")
	}
	wrongRepository.Store(false)
	denied.Store(true)
	if _, _, err = s.searchIssues(context.Background(), token, "/repos/developer/example", repo, "open", pageRequest{Limit: 20}, q); err == nil {
		t.Fatal("native denial swallowed")
	}
	before := reads.Load()
	if _, _, err = s.searchIssues(context.Background(), token, "/repos/developer/example", repo, "open", pageRequest{}, &golfv1.DiscussionQuery{Author: "../other"}); err == nil || reads.Load() != before {
		t.Fatal("malformed query dispatched")
	}
}
