package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestParityReadCommandValidation(t *testing.T) {
	for _, args := range [][]string{
		{"issue", "list", "alice/repo", "--search", " leading"},
		{"issue", "list", "alice/repo", "--assignee", "../other"},
		{"issue", "list", "alice/repo", "--author", "_other"},
		{"issue", "list", "alice/repo", "--labels", "bug,bug"},
		{"issue", "list", "alice/repo", "--labels", "bug,"},
		{"pr", "list", "alice/repo", "--search", "find", "--sort", "updated"},
		{"pr", "list", "alice/repo", "--search", "find", "--limit", "21"},
		{"pr", "list", "alice/repo", "--base", "../main"},
		{"repo", "releases", "alice/repo", "--limit", "51"},
		{"repo", "release", "alice/repo", "9007199254740993.0"},
		{"pr", "checks", "alice/repo", "1"},
	} {
		if _, err := parseCommand(args); err == nil {
			t.Fatal("unsupported/unsafe command accepted", args)
		}
	}
}

func TestParityReadCommandsUseAuthorizedTypedContracts(t *testing.T) {
	for _, kind := range []string{"issue", "pr"} {
		t.Run(kind+"-search", func(t *testing.T) {
			command, err := parseCommand([]string{kind, "list", "alice/repo", "--search", `fix & q=other`, "--author", "alice", "--assignee", "bob", "--labels", "type/bug,priority/high", "--milestone", "v1.0", "--page", "2", "--limit", "1"})
			if err != nil {
				t.Fatal(err)
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+fixtureAPIToken || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "" || r.Header.Get("Origin") != "http://"+r.Host {
					t.Error("read crossed transport authority boundary")
				}
				data, _ := io.ReadAll(r.Body)
				var q *golfv1.DiscussionQuery
				if kind == "issue" {
					var request golfv1.ListIssuesRequest
					if r.URL.Path != "/rpc"+golfv1connect.RepositoryServiceListIssuesProcedure || protojson.Unmarshal(data, &request) != nil || request.GetPage().GetPage() != 2 {
						t.Error("wrong typed issue request")
					}
					q = request.Query
				} else {
					var request golfv1.ListPullRequestsRequest
					if r.URL.Path != "/rpc"+golfv1connect.RepositoryServiceListPullRequestsProcedure || protojson.Unmarshal(data, &request) != nil || request.GetPage().GetPage() != 2 {
						t.Error("wrong typed PR request")
					}
					q = request.Query
				}
				if q.GetSearch() != `fix & q=other` || q.GetAuthor() != "alice" || q.GetAssignee() != "bob" || strings.Join(q.GetLabelNames(), ",") != "type/bug,priority/high" || q.GetMilestoneTitle() != "v1.0" {
					t.Error("query lost literal values or scopes")
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"page":{"nextPage":3}}`)
			}))
			defer provider.Close()
			result, err := execute(context.Background(), provider.URL, command, credential{token: fixtureAPIToken, api: true})
			if err != nil || !strings.Contains(string(result), `"nextPage":3`) {
				t.Fatal("empty continuation lost", err)
			}
		})
	}
	for _, item := range []struct {
		args, procedure, response string
	}{
		{"repo tags alice/repo", "ListTags", `{"repositoryId":"9007199254740993","tags":[],"page":{"nextPage":2}}`},
		{"repo releases alice/repo", "ListRepositoryReleases", `{"repository":{"owner":"alice","name":"repo"},"repositoryId":"9007199254740993","releases":[]}`},
		{"repo release alice/repo 9007199254740995", "GetRepositoryRelease", `{"repository":{"owner":"alice","name":"repo"},"repositoryId":"9007199254740993","release":{"id":"9007199254740995"}}`},
		{"repo labels alice/repo", "ListRepositoryLabels", `{}`},
		{"repo milestones alice/repo --state all", "ListRepositoryMilestones", `{}`},
		{"repo assignees alice/repo", "ListRepositoryAssignees", `{}`},
	} {
		for _, corrupt := range []bool{false, true} {
			t.Run(item.procedure+map[bool]string{false: "/allowed", true: "/identity-replaced"}[corrupt], func(t *testing.T) {
				command, err := parseCommand(strings.Fields(item.args))
				if err != nil {
					t.Fatal(err)
				}
				calls := 0
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if r.Header.Get("Authorization") != "Bearer "+fixtureAPIToken || r.Header.Get("Cookie") != "" {
						t.Error("inventory used another credential")
					}
					w.Header().Set("Content-Type", "application/json")
					if strings.HasSuffix(r.URL.Path, "/GetRepository") {
						name := "alice/repo"
						if corrupt {
							name = "other/repo"
						}
						json.NewEncoder(w).Encode(map[string]any{"repository": map[string]any{"id": "9007199254740993", "name": "repo", "fullName": name}})
						return
					}
					if r.URL.Path != "/rpc/golf.v1.RepositoryService/"+item.procedure {
						t.Error("wrong inventory route", r.URL.Path)
					}
					var request map[string]any
					if json.NewDecoder(r.Body).Decode(&request) != nil || request["repositoryId"] != "9007199254740993" {
						t.Error("inventory lost exact native identity")
					}
					io.WriteString(w, item.response)
				}))
				defer provider.Close()
				result, err := execute(context.Background(), provider.URL, command, credential{token: fixtureAPIToken, api: true})
				if corrupt && (err == nil || result != nil || calls != 1) || !corrupt && (err != nil || calls != 2) {
					t.Fatal("inventory identity or same-authority traversal failed", err, calls)
				}
			})
		}
	}
}
