package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const metadataFixture = `{"labels":[{"id":9007199254740993,"name":"type/bug","color":"AAbB00","description":"<script>literal label description</script>","exclusive":true,"is_archived":true}],"assignees":[{"id":9007199254740995,"login":"developer","full_name":"Developer"}],"assignee":{"id":9007199254740995,"login":"developer"},"milestone":{"id":9007199254740997,"title":"v1.0","description":"Ship the release","state":"closed","open_issues":9007199254740999,"closed_issues":5,"due_on":"2026-12-01T00:00:00Z"}}`

func TestDiscussionMetadata(t *testing.T) {
	var row forgeDiscussionMetadata
	if err := json.Unmarshal([]byte(metadataFixture), &row); err != nil {
		t.Fatal(err)
	}
	got, err := discussionMetadata(row)
	if err != nil || !got.LabelsKnown || !got.AssigneesKnown || !got.MilestoneKnown || got.Labels[0].Id != "9007199254740993" || got.Labels[0].Color != "aabb00" || !got.Labels[0].Exclusive || !got.Labels[0].Archived || got.Assignees[0].Id != "9007199254740995" || got.Assignees[0].IsInstanceAdmin || got.Milestone.Id != "9007199254740997" || got.Milestone.OpenIssues != 9007199254740999 || got.Milestone.State != golfv1.IssueState_ISSUE_STATE_CLOSED {
		t.Fatal("metadata identity, precision or field projection lost", err)
	}
	encoded, err := protojson.Marshal(got)
	if err != nil || !strings.Contains(string(encoded), `"9007199254740999"`) {
		t.Fatal("wire count lost precision", err)
	}
	issue := Issue{ID: 1, Number: 1, State: "open", forgeDiscussionMetadata: row}
	pull := metadataPull(row)
	if !validIssue(issue) || !validPull(pull, metadataRepository()) || !proto.Equal(wireIssue(issue).Metadata, wirePull(pull, false).Metadata) {
		t.Fatal("issue and PR use different metadata contracts")
	}
	for _, tc := range []struct {
		name, body                   string
		labels, assignees, milestone bool
		absent                       bool
	}{
		{name: "absent", body: `{}`, absent: true},
		{name: "explicit null", body: `{"labels":null,"assignees":null,"milestone":null}`, labels: true, assignees: true, milestone: true},
		{name: "empty arrays", body: `{"labels":[],"assignees":[],"milestone":null}`, labels: true, assignees: true, milestone: true},
		{name: "labels only", body: `{"labels":[]}`, labels: true},
		{name: "milestone only", body: `{"milestone":null}`, milestone: true},
		{name: "legacy assignee", body: `{"assignee":{"id":7,"login":"developer"}}`, assignees: true},
		{name: "no legacy assignee", body: `{"assignee":null}`, assignees: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var native forgeDiscussionMetadata
			if json.Unmarshal([]byte(tc.body), &native) != nil {
				t.Fatal("fixture")
			}
			result, err := discussionMetadata(native)
			if err != nil || (result == nil) != tc.absent {
				t.Fatal("availability", err)
			}
			if result != nil && (result.LabelsKnown != tc.labels || result.AssigneesKnown != tc.assignees || result.MilestoneKnown != tc.milestone) {
				t.Fatal("omitted native fields became known")
			}
		})
	}
	for _, tc := range []struct {
		name   string
		change func(*forgeDiscussionMetadata)
	}{
		{"invalid color", func(v *forgeDiscussionMetadata) {
			v.Labels = json.RawMessage(`[ {"id":1,"name":"bug","color":"url(x)"} ]`)
		}},
		{"CSS prefix", func(v *forgeDiscussionMetadata) {
			v.Labels = json.RawMessage(`[ {"id":1,"name":"bug","color":"#aabb00"} ]`)
		}},
		{"duplicate labels", func(v *forgeDiscussionMetadata) {
			v.Labels = json.RawMessage(`[ {"id":1,"name":"bug","color":"aabb00"},{"id":1,"name":"other","color":"000000"} ]`)
		}},
		{"label name control", func(v *forgeDiscussionMetadata) {
			v.Labels = json.RawMessage(`[ {"id":1,"name":"bug\n","color":"aabb00"} ]`)
		}},
		{"label scalar", func(v *forgeDiscussionMetadata) { v.Labels = json.RawMessage(`true`) }},
		{"label null item", func(v *forgeDiscussionMetadata) { v.Labels = json.RawMessage(`[null]`) }},
		{"labels bound", func(v *forgeDiscussionMetadata) {
			v.Labels = json.RawMessage("[" + strings.Repeat(`{"id":1,"name":"bug","color":"aabb00"},`, 256) + `{"id":2,"name":"bug","color":"aabb00"}]`)
		}},
		{"label bytes bound", func(v *forgeDiscussionMetadata) { v.Labels = json.RawMessage(strings.Repeat(" ", (1<<20)+1)) }},
		{"null assignee item", func(v *forgeDiscussionMetadata) { v.Assignees = json.RawMessage(`[null]`) }},
		{"ghost assignee", func(v *forgeDiscussionMetadata) {
			v.Assignees = json.RawMessage(`[{"id":-1,"login":"ghost"}]`)
			v.Assignee = nil
		}},
		{"duplicate assignee ID", func(v *forgeDiscussionMetadata) {
			v.Assignees = json.RawMessage(`[{"id":7,"login":"developer"},{"id":7,"login":"other"}]`)
			v.Assignee = nil
		}},
		{"duplicate assignee login", func(v *forgeDiscussionMetadata) {
			v.Assignees = json.RawMessage(`[{"id":7,"login":"developer"},{"id":8,"login":"Developer"}]`)
			v.Assignee = nil
		}},
		{"invalid assignee login", func(v *forgeDiscussionMetadata) {
			v.Assignees = json.RawMessage(`[{"id":7,"login":"../foreign"}]`)
			v.Assignee = nil
		}},
		{"legacy mismatch", func(v *forgeDiscussionMetadata) { v.Assignee = json.RawMessage(`{"id":7,"login":"other"}`) }},
		{"legacy with empty modern list", func(v *forgeDiscussionMetadata) { v.Assignees = json.RawMessage(`[]`) }},
		{"milestone negative count", func(v *forgeDiscussionMetadata) {
			v.Milestone = json.RawMessage(`{"id":1,"title":"v1","state":"open","open_issues":-1,"closed_issues":0}`)
		}},
		{"milestone count overflow", func(v *forgeDiscussionMetadata) {
			v.Milestone = json.RawMessage(`{"id":1,"title":"v1","state":"open","open_issues":9223372036854775808}`)
		}},
		{"milestone bad date", func(v *forgeDiscussionMetadata) {
			v.Milestone = json.RawMessage(`{"id":1,"title":"v1","state":"open","open_issues":0,"closed_issues":0,"due_on":"tomorrow"}`)
		}},
		{"milestone bad state", func(v *forgeDiscussionMetadata) {
			v.Milestone = json.RawMessage(`{"id":1,"title":"v1","state":"all","open_issues":0,"closed_issues":0}`)
		}},
		{"milestone omitted counts", func(v *forgeDiscussionMetadata) {
			v.Milestone = json.RawMessage(`{"id":1,"title":"v1","state":"open"}`)
		}},
		{"milestone null count", func(v *forgeDiscussionMetadata) {
			v.Milestone = json.RawMessage(`{"id":1,"title":"v1","state":"open","open_issues":null,"closed_issues":0}`)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := row
			tc.change(&bad)
			if _, err := discussionMetadata(bad); err == nil {
				t.Fatal("malformed metadata accepted")
			}
			issue.forgeDiscussionMetadata = bad
			if validIssue(issue) || validPull(metadataPull(bad), metadataRepository()) {
				t.Fatal("invalid metadata escaped shared issue/PR admission")
			}
		})
	}
}

func metadataRepository() Repository {
	return Repository{ID: 1, Name: "example", FullName: "developer/example", HTMLURL: "https://forge.invalid/developer/example"}
}
func metadataPull(metadata forgeDiscussionMetadata) forgePull {
	no := false
	return forgePull{forgeDiscussionMetadata: metadata, ID: 2, Number: 2, Title: "Change", State: "open", User: &User{ID: 7, Login: "developer"}, CreatedAt: "2026-10-05T12:00:00Z", UpdatedAt: "2026-10-05T12:00:00Z", HTMLURL: metadataRepository().HTMLURL + "/pulls/2", Draft: &no, Merged: &no, Head: &forgePullRef{RepositoryID: 1, Ref: "feature", SHA: strings.Repeat("a", 40)}, Base: &forgePullRef{RepositoryID: 1, Ref: "main", SHA: strings.Repeat("b", 40)}}
}

func TestDiscussionMetadataProviderReads(t *testing.T) {
	var metadata forgeDiscussionMetadata
	if err := json.Unmarshal([]byte(metadataFixture), &metadata); err != nil {
		t.Fatal(err)
	}
	corrupt := false
	calls := map[string]int{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls[r.URL.Path]++
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "token metadata-pat" {
			t.Error("wrong native read authority")
			w.WriteHeader(401)
			return
		}
		native := metadata
		if corrupt {
			native.Labels = json.RawMessage(`[{"id":0}]`)
		}
		issue := Issue{forgeDiscussionMetadata: native, ID: 1, Number: 1, Title: "Issue", State: "open", User: User{ID: 7, Login: "developer"}}
		switch r.URL.Path {
		case "/api/v1/repos/developer/example/issues":
			if r.URL.Query().Get("type") != "issues" {
				t.Error("PRs leaked into issue inventory")
			}
			w.Header().Set("Link", `</ignored?page=2>; rel="next"`)
			respond(w, 200, []Issue{issue})
		case "/api/v1/repos/developer/example/issues/1":
			respond(w, 200, issue)
		case "/api/v1/repos/developer/example/pulls/2":
			respond(w, 200, metadataPull(native))
		default:
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	s, err := New(testConfig(upstream.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	token := forgeCredential{Kind: "pat", Token: "metadata-pat"}
	key := repositoryKey{Owner: "developer", Name: "example"}
	listed, next, err := s.listIssues(context.Background(), token, key, "open", pageRequest{})
	if err != nil || len(listed) != 1 || next != 2 {
		t.Fatal("native inventory", err)
	}
	issue, err := s.getIssue(context.Background(), token, key, 1)
	if err != nil {
		t.Fatal(err)
	}
	pull, err := s.readPull(context.Background(), token, "/repos/developer/example", metadataRepository(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(wireIssue(listed[0]).Metadata, wireIssue(issue).Metadata) || !proto.Equal(wireIssue(issue).Metadata, wirePull(pull, false).Metadata) {
		t.Fatal("metadata dropped between list/detail/PR")
	}
	if len(calls) != 3 {
		t.Fatal("metadata caused auxiliary provider reads")
	}
	corrupt = true
	if _, _, err = s.listIssues(context.Background(), token, key, "open", pageRequest{}); !errors.Is(err, errInvalidForgeResponse) {
		t.Fatal("invalid list metadata not refused", err)
	}
	if _, err = s.getIssue(context.Background(), token, key, 1); !errors.Is(err, errInvalidForgeResponse) {
		t.Fatal("invalid detail metadata not refused", err)
	}
	if _, err = s.readPull(context.Background(), token, "/repos/developer/example", metadataRepository(), 2); !errors.Is(err, errInvalidForgeResponse) {
		t.Fatal("invalid PR metadata not refused", err)
	}
}

func TestDiscussionMetadataRPCPostgres(t *testing.T) {
	db := testDatabase(t)
	var metadata forgeDiscussionMetadata
	if json.Unmarshal([]byte(metadataFixture), &metadata) != nil {
		t.Fatal("fixture")
	}
	var mode atomic.Value
	mode.Store("")
	var late atomic.Bool
	var repositoryReads atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "token metadata-pat" {
			w.WriteHeader(401)
			return
		}
		repo := metadataRepository()
		switch r.URL.Path {
		case "/api/v1/user":
			respond(w, 200, User{ID: 7, Login: "developer"})
		case "/api/v1/version":
			respond(w, 200, map[string]string{"version": "1.27.3"})
		case "/api/v1/settings/api":
			respond(w, 200, map[string]int{"max_response_items": 50})
		case "/api/v1/repos/developer/example":
			repositoryReads.Add(1)
			if late.Load() && mode.Load().(string) == "late-denied" {
				w.WriteHeader(404)
				return
			}
			if late.Load() && mode.Load().(string) == "late-replaced" {
				repo.ID++
			}
			respond(w, 200, repo)
		case "/api/v1/repos/developer/example/issues", "/api/v1/repos/developer/example/issues/1":
			native := metadata
			if mode.Load().(string) == "malformed" {
				native.Milestone = json.RawMessage(`{"id":1,"title":"v1","state":"open"}`)
			}
			row := Issue{forgeDiscussionMetadata: native, ID: 1, Number: 1, Title: "Private issue", Body: "private original body", State: "open", User: User{ID: 7, Login: "developer"}}
			late.Store(true)
			if strings.HasSuffix(r.URL.Path, "/1") {
				respond(w, 200, row)
			} else {
				respond(w, 200, []Issue{row})
			}
		case "/api/v1/repos/developer/example/pulls":
			w.Header().Set("X-Total-Count", "1")
			respond(w, 200, []forgePull{metadataPull(metadata)})
		case "/api/v1/repos/developer/example/pulls/2":
			respond(w, 200, metadataPull(metadata))
		default:
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	s, err := New(testConfig(upstream.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	sessions, client, _, _, _ := testRPCClients(t, s)
	ctx := context.Background()
	key := &golfv1.RepositoryKey{Owner: "developer", Name: "example"}
	if _, err = sessions.LoginWithGiteaToken(ctx, connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: "metadata-pat"})); err != nil {
		t.Fatal(err)
	}
	list, err := client.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: key}))
	if err != nil || len(list.Msg.Issues) != 1 {
		t.Fatal("issue RPC inventory", err)
	}
	detail, err := client.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key, Number: 1}))
	if err != nil {
		t.Fatal("issue RPC detail", err)
	}
	pulls, err := client.ListPullRequests(ctx, connect.NewRequest(&golfv1.ListPullRequestsRequest{Repository: key}))
	if err != nil || len(pulls.Msg.PullRequests) != 1 {
		t.Fatal("PR RPC inventory", err)
	}
	pull, err := client.GetPullRequest(ctx, connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: key, Number: 2}))
	if err != nil {
		t.Fatal("PR RPC detail", err)
	}
	for _, value := range []*golfv1.DiscussionMetadata{list.Msg.Issues[0].Metadata, detail.Msg.Issue.Metadata, pulls.Msg.PullRequests[0].Metadata, pull.Msg.PullRequest.Metadata} {
		if !proto.Equal(value, detail.Msg.Issue.Metadata) || value == nil {
			t.Fatal("authenticated native metadata dropped")
		}
	}
	if list.Header().Get("Cache-Control") != "no-store" || detail.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private metadata cached")
	}
	for _, tc := range []struct {
		mode string
		code connect.Code
	}{{"late-denied", connect.CodeNotFound}, {"late-replaced", connect.CodeUnavailable}, {"malformed", connect.CodeUnavailable}} {
		for _, kind := range []string{"list", "detail"} {
			t.Run(tc.mode+"/"+kind, func(t *testing.T) {
				mode.Store(tc.mode)
				late.Store(false)
				if kind == "list" {
					response, err := client.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: key}))
					if response != nil || connect.CodeOf(err) != tc.code {
						t.Fatal("private inventory escaped late native authority/metadata refusal", err)
					}
				} else {
					response, err := client.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key, Number: 1}))
					if response != nil || connect.CodeOf(err) != tc.code {
						t.Fatal("private detail escaped late native authority/metadata refusal", err)
					}
				}
			})
		}
	}
	mode.Store("late-denied")
	late.Store(true)
	before := repositoryReads.Load()
	for _, number := range []uint32{0, 2147483648} {
		response, err := client.GetIssue(ctx, connect.NewRequest(&golfv1.GetIssueRequest{Repository: key, Number: number}))
		if response != nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid issue number reached repository I/O", err)
		}
	}
	for _, page := range []*golfv1.PageRequest{{Page: 10001}, {Limit: 101}} {
		response, err := client.ListIssues(ctx, connect.NewRequest(&golfv1.ListIssuesRequest{Repository: key, Page: page}))
		if response != nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid issue paging reached repository I/O", err)
		}
	}
	if repositoryReads.Load() != before {
		t.Fatal("invalid input consumed repository read capacity")
	}
}

// The caller provisions and removes an owned native fixture through supported
// APIs. This conditional qualification never mutates the user's repositories.
func TestDiscussionMetadataNativeRead(t *testing.T) {
	token := os.Getenv("GOLF_TEST_DISCUSSION_NATIVE_TOKEN")
	fullName := os.Getenv("GOLF_TEST_DISCUSSION_NATIVE_REPOSITORY")
	if token == "" || fullName == "" {
		t.Skip("set owned native discussion qualification fixture")
	}
	parts := strings.Split(fullName, "/")
	if len(parts) != 2 {
		t.Fatal("fixture repository key")
	}
	issueNo, err := strconv.ParseUint(os.Getenv("GOLF_TEST_DISCUSSION_NATIVE_ISSUE"), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	pullNo, err := strconv.ParseUint(os.Getenv("GOLF_TEST_DISCUSSION_NATIVE_PULL"), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(testConfig("http://localhost:3001"), nil)
	if err != nil {
		t.Fatal(err)
	}
	credential := forgeCredential{Kind: "pat", Token: token}
	key := repositoryKey{Owner: parts[0], Name: parts[1]}
	base := "/repos/" + fullName
	repo, err := s.readRepository(context.Background(), base, credential)
	if err != nil {
		t.Fatal("native repository read failed")
	}
	issue, err := s.getIssue(context.Background(), credential, key, uint32(issueNo))
	if err != nil {
		t.Fatal("native issue read failed")
	}
	pull, err := s.readPull(context.Background(), credential, base, repo, uint32(pullNo))
	if err != nil {
		t.Fatal("native PR read failed")
	}
	for _, metadata := range []*golfv1.DiscussionMetadata{wireIssue(issue).Metadata, wirePull(pull, false).Metadata} {
		if metadata == nil || !metadata.LabelsKnown || !metadata.AssigneesKnown || !metadata.MilestoneKnown || len(metadata.Labels) != 1 || metadata.Labels[0].Name != "type/bug" || metadata.Labels[0].Color != "aabb00" || len(metadata.Assignees) != 1 || metadata.Assignees[0].Login != parts[0] || metadata.Milestone == nil || metadata.Milestone.Title != "v1.0" {
			t.Fatal("native assigned metadata projection mismatch")
		}
	}
	listed, _, err := s.listIssues(context.Background(), credential, key, "all", pageRequest{})
	if err != nil {
		t.Fatal("native issue inventory failed")
	}
	found := false
	for _, row := range listed {
		if row.Number == int64(issueNo) {
			found = proto.Equal(wireIssue(row).Metadata, wireIssue(issue).Metadata)
		}
	}
	if !found {
		t.Fatal("native issue list/detail metadata differ")
	}
	fmt.Println("PASS owned actual Gitea issue/list/PR metadata reads; no Golf runtime or job activation")
}
