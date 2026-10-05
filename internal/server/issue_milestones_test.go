package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type milestoneFixture struct {
	*discussionFixture
	admin bool
	mode  string
	rows  []forgeDiscussionMilestone
}

func newMilestoneFixture(t *testing.T) *milestoneFixture {
	t.Helper()
	f := &milestoneFixture{discussionFixture: newDiscussionFixture(t), admin: true}
	for i := int64(1); i <= 60; i++ {
		state := "open"
		if i%2 == 0 {
			state = "closed"
		}
		f.rows = append(f.rows, forgeDiscussionMilestone{ID: i, Title: fmt.Sprint("Milestone ", i), State: state, OpenIssues: proto.Int64(2), ClosedIssues: proto.Int64(3)})
	}
	f.mu.Lock()
	r := f.issues[1]
	r.Milestone = json.RawMessage(`null`)
	f.issues[1] = r
	f.mu.Unlock()
	f.nativeHook = func(w http.ResponseWriter, r *http.Request) bool {
		const base = "/api/v1/repos/alice/example"
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.URL.Path == base && r.Method == "GET" {
			raw, _ := json.Marshal(f.repo)
			var row map[string]any
			_ = json.Unmarshal(raw, &row)
			row["permissions"] = map[string]bool{"admin": f.admin}
			row["archived"] = false
			row["has_issues"] = true
			_ = json.NewEncoder(w).Encode(row)
			return true
		}
		if r.URL.Path == base+"/milestones" && r.Method == "GET" {
			var rows []forgeDiscussionMilestone
			for _, row := range f.rows {
				if r.URL.Query().Get("state") == "all" || r.URL.Query().Get("state") == row.State {
					rows = append(rows, row)
				}
			}
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			page, _ := strconv.Atoi(r.URL.Query().Get("page"))
			if limit > 50 {
				t.Error("configured native page clamp ignored")
			}
			w.Header().Set("X-Total-Count", strconv.Itoa(len(rows)))
			start := min((page-1)*limit, len(rows))
			end := min(start+limit, len(rows))
			_ = json.NewEncoder(w).Encode(rows[start:end])
			return true
		}
		if strings.HasPrefix(r.URL.Path, base+"/milestones/") && r.Method == "GET" {
			id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, base+"/milestones/"), 10, 64)
			for _, row := range f.rows {
				if row.ID == id {
					if f.mode == "change-during-choice" {
						current := f.issues[1]
						current.Milestone, _ = json.Marshal(f.rows[2])
						f.issues[1] = current
					}
					_ = json.NewEncoder(w).Encode(row)
					return true
				}
			}
			w.WriteHeader(404)
			return true
		}
		if r.URL.Path == base+"/issues/1" && r.Method == "PATCH" {
			f.patches.Add(1)
			var input map[string]json.RawMessage
			if json.NewDecoder(r.Body).Decode(&input) != nil {
				t.Error("invalid PATCH")
				w.WriteHeader(400)
				return true
			}
			if len(input) != 2 || input["milestone"] == nil || input["content_version"] == nil {
				t.Error("milestone PATCH mixed fields")
			}
			var reserved int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations m JOIN golf_issue_mutation_events e ON e.mutation_id=m.id WHERE m.kind='UPDATE_ISSUE' AND m.state='OUTCOME_UNKNOWN' AND e.phase='RESERVED'").Scan(&reserved); err != nil || reserved != 1 {
				t.Error("milestone PATCH not durably reserved", err, reserved)
			}
			if !f.admin {
				w.WriteHeader(403)
				return true
			}
			row := f.issues[1]
			var id int64
			_ = json.Unmarshal(input["milestone"], &id)
			row.Milestone = json.RawMessage(`null`)
			for _, choice := range f.rows {
				if choice.ID == id {
					row.Milestone, _ = json.Marshal(choice)
				}
			}
			if f.mode != "ignored" {
				f.issues[1] = row
			}
			if f.mode == "lost" {
				w.WriteHeader(500)
				return true
			}
			if f.mode == "wrong-receipt" {
				row.ID++
			}
			if f.mode == "changed-after" {
				changed := row
				changed.Milestone, _ = json.Marshal(f.rows[2])
				f.issues[1] = changed
			}
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(row)
			return true
		}
		return false
	}
	return f
}
func TestIssueMilestoneLifecyclePostgres(t *testing.T) {
	f := newMilestoneFixture(t)
	client, _ := f.client(t, "alice")
	for i, change := range [][2]string{{"0", "1"}, {"1", "2"}, {"2", "0"}} {
		req := updateIssueInput(f.discussionFixture, discussionKey(i+1))
		req.Milestone = &golfv1.IssueMilestoneChange{ExpectedMilestoneId: change[0], MilestoneId: change[1]}
		out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
		if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
			t.Fatal("milestone update not verified", err, out)
		}
		id, err := issueMilestoneID(f.issues[1].Issue)
		if err != nil || strconv.FormatInt(id, 10) != change[1] {
			t.Fatal("native assignment differs", err, id)
		}
		if out.Msg.Issue.Title != "Original" || out.Msg.Issue.Body != "private issue text" || out.Msg.Issue.State != golfv1.IssueState_ISSUE_STATE_OPEN {
			t.Fatal("unrelated fields changed")
		}
		if _, err = client.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || f.patches.Load() != int32(i+1) {
			t.Fatal("replayed milestone PATCH", err)
		}
	}
}
func TestIssueMilestonePreflightPostgres(t *testing.T) {
	for _, mode := range []string{"stale", "unknown", "reader-author", "foreign", "change-during-choice", "unchanged"} {
		t.Run(mode, func(t *testing.T) {
			f := newMilestoneFixture(t)
			client, _ := f.client(t, "alice")
			req := updateIssueInput(f.discussionFixture, discussionKey(1))
			req.Milestone = &golfv1.IssueMilestoneChange{ExpectedMilestoneId: "0", MilestoneId: "1"}
			f.mode = mode
			switch mode {
			case "stale":
				req.Milestone.ExpectedMilestoneId = "2"
			case "unknown":
				row := f.issues[1]
				row.Milestone = nil
				f.issues[1] = row
			case "reader-author":
				f.admin = false
			case "foreign":
				req.Milestone.MilestoneId = "999"
			case "unchanged":
				req.Milestone.MilestoneId = "0"
			}
			out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
			if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.patches.Load() != 0 {
				t.Fatal("invalid milestone dispatched", err, out)
			}
			if mode == "stale" || mode == "change-during-choice" {
				if out.Msg.Mutation.FailureCode != "revision_changed" {
					t.Fatal("wrong stale observation code")
				}
			}
		})
	}
}
func TestIssueMilestoneUnknownNoReplayPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "wrong-receipt", "ignored", "changed-after"} {
		t.Run(mode, func(t *testing.T) {
			f := newMilestoneFixture(t)
			f.mode = mode
			client, _ := f.client(t, "alice")
			req := updateIssueInput(f.discussionFixture, discussionKey(1))
			req.Milestone = &golfv1.IssueMilestoneChange{ExpectedMilestoneId: "0", MilestoneId: "1"}
			out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
			if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
				t.Fatal("uncertain assignment promoted", err, out)
			}
			_, err = client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: req.IdempotencyKey}))
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.UpdateIssue(t.Context(), connect.NewRequest(req))
			if err != nil || f.patches.Load() != 1 {
				t.Fatal("uncertain assignment replayed", err)
			}
			req.Milestone.MilestoneId = "2"
			if _, err = client.UpdateIssue(t.Context(), connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("changed original accepted", err)
			}
		})
	}
}
func TestIssueMilestoneValidationAndFingerprint(t *testing.T) {
	before := issueMutationInput{Kind: "UPDATE_ISSUE", Owner: "alice", Repository: "example", RepositoryID: 10, IssueID: 41, Number: 1, EditTitle: proto.String("Title"), ExpectedRevision: strings.Repeat("a", 64)}
	raw, _ := json.Marshal(before)
	want := `{"kind":"UPDATE_ISSUE","owner":"alice","repository":"example","repository_id":10,"issue_id":41,"number":1,"title":"","body":"","edit_title":"Title","expected_revision":"` + strings.Repeat("a", 64) + `"}`
	if string(raw) != want {
		t.Fatal("historical fingerprint changed")
	}
	before.EditMilestone = &issueMilestoneChange{ExpectedID: 0, ID: 1}
	if before.validate(discussionKey(1)) == nil {
		t.Fatal("mixed milestone fields accepted")
	}
	before.EditTitle = nil
	if err := before.validate(discussionKey(1)); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"", "01", "-1", "+1", "9223372036854775808"} {
		if _, err := milestoneID(v); err == nil {
			t.Fatal("invalid milestone ID", v)
		}
	}
	before.PullRequest = true
	before.Kind = "UPDATE_PULL"
	if before.validate(discussionKey(1)) == nil {
		t.Fatal("PR milestone admitted")
	}
}
