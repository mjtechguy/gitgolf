package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"

	"google.golang.org/protobuf/proto"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type pullMetadataFixture struct {
	*pullMutationFixture
	mode       string
	labels     []forgeDiscussionLabel
	milestone  forgeDiscussionMilestone
	candidates []User
}

func newPullMetadataFixture(t *testing.T) *pullMetadataFixture {
	t.Helper()
	f := &pullMetadataFixture{pullMutationFixture: newPullMutationFixture(t), labels: []forgeDiscussionLabel{{ID: 1, Name: "bug", Color: "abcdef"}, {ID: 2, Name: "enhancement", Color: "123456"}}, milestone: forgeDiscussionMilestone{ID: 3, Title: "Release", State: "open", OpenIssues: proto.Int64(0), ClosedIssues: proto.Int64(0)}, candidates: []User{{ID: 42, Login: "alice"}, {ID: 43, Login: "bob"}}}
	f.row.Labels = json.RawMessage(`[]`)
	f.row.Assignees = json.RawMessage(`[]`)
	f.row.Milestone = json.RawMessage(`null`)
	provider := httptest.NewServer(http.HandlerFunc(f.serveMetadata))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *pullMetadataFixture) discussion(row forgePull) discussionIssue {
	id := int64(77)
	if f.mode == "issue-rebound-after" && f.patches.Load() > 0 {
		id++
	}
	return discussionIssue{IsLocked: proto.Bool(false), forgeIssue: forgeIssue{Issue: Issue{forgeDiscussionMetadata: row.forgeDiscussionMetadata, ID: id, Number: row.Number, Title: row.Title, Body: row.Body, State: row.State, User: *row.User, ContentVersion: row.ContentVersion, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, HTMLURL: row.HTMLURL}, PullRequest: json.RawMessage(`{}`)}, Repository: &struct {
		ID int64 `json:"id"`
	}{ID: 11}}
}
func (f *pullMetadataFixture) serveMetadata(w http.ResponseWriter, r *http.Request) {
	const base = "/api/v1/repos/alice/private"
	w.Header().Set("Content-Type", "application/json")
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	if r.URL.Path == base && r.Method == "GET" {
		write(map[string]any{"id": 11, "name": "private", "full_name": "alice/private", "html_url": "https://forge.invalid/alice/private", "private": true, "permissions": map[string]bool{"admin": f.mode != "denied"}, "archived": false, "has_issues": true, "has_pull_requests": true})
		return
	}
	if r.URL.Path == base+"/issues/7" && r.Method == "GET" {
		f.mu.Lock()
		row := copyMutationPull(f.row)
		f.mu.Unlock()
		write(f.discussion(row))
		return
	}
	if r.URL.Path == base+"/pulls/7" && r.Method == "GET" && f.patches.Load() > 0 && (f.mode == "pull-rebound-after" || f.mode == "denied-after") {
		if f.mode == "denied-after" {
			w.WriteHeader(404)
			return
		}
		f.mu.Lock()
		row := copyMutationPull(f.row)
		f.mu.Unlock()
		row.ID++
		write(row)
		return
	}
	if r.Method == "GET" && strings.HasPrefix(r.URL.Path, base+"/labels/") {
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, base+"/labels/"), 10, 64)
		for _, label := range f.labels {
			if label.ID == id {
				write(label)
				return
			}
		}
		w.WriteHeader(404)
		return
	}
	if r.Method == "GET" && r.URL.Path == base+"/milestones/3" {
		if f.mode == "changed-before" {
			f.mu.Lock()
			f.row.Title = "Changed concurrently"
			f.mu.Unlock()
		}
		write(f.milestone)
		return
	}
	if r.Method == "GET" && r.URL.Path == base+"/assignees" {
		write(f.candidates)
		return
	}
	if r.Method == "GET" && strings.HasPrefix(r.URL.Path, base+"/assignees/") {
		login := strings.TrimPrefix(r.URL.Path, base+"/assignees/")
		for _, user := range f.candidates {
			if user.Login == login && f.mode != "unassignable" {
				w.WriteHeader(204)
				return
			}
		}
		w.WriteHeader(404)
		return
	}
	if r.Method == "PATCH" && r.URL.Path == base+"/issues/7" || r.Method == "PUT" && r.URL.Path == base+"/issues/7/labels" {
		f.patches.Add(1)
		var body map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(400)
			return
		}
		var reserved int
		if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations WHERE kind='UPDATE_PULL' AND state='OUTCOME_UNKNOWN'").Scan(&reserved); err != nil || reserved < 1 {
			panic("metadata write without durable reservation")
		}
		f.mu.Lock()
		row := copyMutationPull(f.row)
		if r.Method == "PUT" {
			if len(body) != 1 || body["labels"] == nil {
				panic("mixed label mutation")
			}
			var ids []int64
			_ = json.Unmarshal(body["labels"], &ids)
			if ids == nil {
				panic("null labels")
			}
			rows := []forgeDiscussionLabel{}
			for _, id := range ids {
				for _, label := range f.labels {
					if id == label.ID {
						rows = append(rows, label)
					}
				}
			}
			row.Labels, _ = json.Marshal(rows)
		} else {
			if len(body) != 2 || body["content_version"] == nil {
				panic("mixed metadata patch")
			}
			var version int64
			_ = json.Unmarshal(body["content_version"], &version)
			if version != *row.ContentVersion {
				f.mu.Unlock()
				w.WriteHeader(409)
				return
			}
			if body["assignees"] != nil {
				var names []string
				_ = json.Unmarshal(body["assignees"], &names)
				if names == nil {
					panic("null assignees")
				}
				users := []User{}
				for _, name := range names {
					for _, user := range f.candidates {
						if name == user.Login {
							users = append(users, user)
						}
					}
				}
				row.Assignees, _ = json.Marshal(users)
			} else if body["milestone"] != nil {
				var id int64
				_ = json.Unmarshal(body["milestone"], &id)
				if id == 0 {
					row.Milestone = json.RawMessage(`null`)
				} else {
					row.Milestone, _ = json.Marshal(f.milestone)
				}
			} else {
				panic("wrong metadata field")
			}
		}
		if f.mode != "ignored" {
			f.row = copyMutationPull(row)
		}
		if f.mode == "unrelated-title-after" {
			f.row.Title = "Concurrent unrelated title"
		}
		f.mu.Unlock()
		if f.mode == "lost" {
			w.WriteHeader(500)
			return
		}
		if r.Method == "PUT" {
			w.WriteHeader(200)
			if f.mode == "wrong-receipt" {
				write(f.labels)
			} else {
				w.Write(row.Labels)
			}
			return
		}
		receipt := f.discussion(row)
		if f.mode == "wrong-receipt" {
			receipt.ID++
		}
		w.WriteHeader(201)
		write(receipt)
		return
	}
	f.serve(w, r)
}

func TestPullMetadataLifecyclePostgres(t *testing.T) {
	f := newPullMetadataFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for i, field := range []string{"milestone", "labels", "assignees", "clear-milestone", "clear-labels", "clear-assignees"} {
		req := f.update(discussionKey(i + 1))
		switch field {
		case "milestone":
			req.Milestone = &golfv1.IssueMilestoneChange{ExpectedMilestoneId: "0", MilestoneId: "3"}
		case "clear-milestone":
			req.Milestone = &golfv1.IssueMilestoneChange{ExpectedMilestoneId: "3", MilestoneId: "0"}
		case "labels":
			req.Labels = &golfv1.IssueLabelsChange{LabelIds: []string{"1"}}
		case "clear-labels":
			req.Labels = &golfv1.IssueLabelsChange{ExpectedLabelIds: []string{"1"}}
		case "assignees":
			req.Assignees = &golfv1.IssueAssigneesChange{Assignees: []*golfv1.DiscussionAssigneeSelection{{Id: "43", Login: "bob"}}}
		case "clear-assignees":
			req.Assignees = &golfv1.IssueAssigneesChange{ExpectedAssigneeIds: []string{"43"}}
		}
		for range 2 {
			result, err := client.UpdatePullRequest(t.Context(), connect.NewRequest(req))
			if err != nil || result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || result.Msg.PullRequest == nil || result.Msg.Mutation.IssueId != "" || result.Msg.Mutation.ObservedResultId != req.PullRequestId {
				t.Fatal(field, "metadata outcome/PR receipt lost", result, err)
			}
		}
		if f.patches.Load() != int32(i+1) {
			t.Fatal("metadata replay dispatched twice")
		}
	}
	if f.row.Title != "Private change" || f.row.Body != "<script>plain text</script>" {
		t.Fatal("unrelated content changed", f.row.Title, f.row.Body)
	}
}

func TestPullMetadataRefusalsPostgres(t *testing.T) {
	for _, mode := range []string{"denied", "changed-before", "stale-milestone", "stale-labels", "stale-assignees", "identity-mismatch", "unassignable"} {
		t.Run(mode, func(t *testing.T) {
			f := newPullMetadataFixture(t)
			client := f.client(t, f.session(t, "pat"))
			f.mode = mode
			req := f.update(discussionKey(1))
			req.Milestone = &golfv1.IssueMilestoneChange{ExpectedMilestoneId: "0", MilestoneId: "3"}
			switch mode {
			case "stale-milestone":
				req.Milestone.ExpectedMilestoneId = "9"
			case "stale-labels":
				req.Milestone = nil
				req.Labels = &golfv1.IssueLabelsChange{ExpectedLabelIds: []string{"2"}, LabelIds: []string{"1"}}
			case "stale-assignees", "identity-mismatch", "unassignable":
				req.Milestone = nil
				req.Assignees = &golfv1.IssueAssigneesChange{Assignees: []*golfv1.DiscussionAssigneeSelection{{Id: "43", Login: "bob"}}}
				if mode == "stale-assignees" {
					req.Assignees.ExpectedAssigneeIds = []string{"42"}
				}
				if mode == "identity-mismatch" {
					req.Assignees.Assignees[0].Login = "alice"
				}
			}
			result, err := client.UpdatePullRequest(t.Context(), connect.NewRequest(req))
			if err != nil || result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.patches.Load() != 0 {
				t.Fatal("unsafe metadata dispatched", result, err, f.patches.Load())
			}
		})
	}
}

func TestPullMetadataUnknownNoReplayPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "ignored", "wrong-receipt", "issue-rebound-after", "pull-rebound-after", "denied-after", "unrelated-title-after"} {
		t.Run(mode, func(t *testing.T) {
			f := newPullMetadataFixture(t)
			client := f.client(t, f.session(t, "pat"))
			f.mode = mode
			req := f.update(discussionKey(1))
			req.Milestone = &golfv1.IssueMilestoneChange{ExpectedMilestoneId: "0", MilestoneId: "3"}
			for range 2 {
				result, err := client.UpdatePullRequest(t.Context(), connect.NewRequest(req))
				if err != nil || result.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
					t.Fatal("uncertain native effect promoted", result, err)
				}
			}
			if f.patches.Load() != 1 {
				t.Fatal("uncertain effect replayed", f.patches.Load())
			}
		})
	}
}
