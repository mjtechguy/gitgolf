package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type assigneesFixture struct {
	*labelsFixture
	candidates   []User
	unassignable map[string]bool
	source       string
}

func newAssigneesFixture(t *testing.T) *assigneesFixture {
	t.Helper()
	f := &assigneesFixture{labelsFixture: newLabelsFixture(t), candidates: []User{{ID: 42, Login: "alice", FullName: "Alice"}, {ID: 43, Login: "bob", FullName: "Bob"}}, unassignable: map[string]bool{}}
	row := f.issues[1]
	row.Assignees = json.RawMessage(`[]`)
	row.Labels, _ = json.Marshal([]forgeDiscussionLabel{f.rows[0]})
	row.Milestone = json.RawMessage(`{"id":5,"title":"Release","state":"open","open_issues":3,"closed_issues":2,"due_on":"2026-12-01T00:00:00Z"}`)
	f.issues[1] = row
	previous := f.nativeHook
	f.nativeHook = func(w http.ResponseWriter, r *http.Request) bool {
		const base = "/api/v1/repos/alice/example"
		if r.Method == "GET" && r.URL.Path == base+"/assignees" {
			f.mu.Lock()
			defer f.mu.Unlock()
			if r.URL.RawQuery != "" {
				t.Error("invented native pagination")
			}
			if f.mode == "null-list" {
				_ = json.NewEncoder(w).Encode(nil)
				return true
			}
			_ = json.NewEncoder(w).Encode(f.candidates)
			if f.mode == "admin-during-list" {
				f.admin = false
			}
			if f.mode == "revoked-during-list" {
				if err := f.s.logoutSession(context.Background(), f.source); err != nil {
					t.Error(err)
				}
			}
			return true
		}
		if r.Method == "GET" && strings.HasPrefix(r.URL.Path, base+"/assignees/") {
			f.mu.Lock()
			defer f.mu.Unlock()
			login := strings.TrimPrefix(r.URL.Path, base+"/assignees/")
			for _, user := range f.candidates {
				if user.Login == login && !f.unassignable[login] {
					row := f.issues[1]
					switch f.mode {
					case "change-during-choice":
						row.Assignees, _ = json.Marshal([]User{f.candidates[1]})
						f.issues[1] = row
					case "identity-during-choice":
						row.ID++
						f.issues[1] = row
					case "revision-during-choice":
						row.Title = "Changed"
						f.issues[1] = row
					case "admin-during-choice":
						f.admin = false
					case "revoked-during-choice":
						if err := f.s.logoutSession(context.Background(), f.source); err != nil {
							t.Error(err)
						}
					}
					w.WriteHeader(204)
					return true
				}
			}
			w.WriteHeader(404)
			return true
		}
		if r.Method == "PATCH" && r.URL.Path == base+"/issues/1" {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.patches.Add(1)
			var input map[string]json.RawMessage
			if json.NewDecoder(r.Body).Decode(&input) != nil || len(input) != 2 || input["assignees"] == nil || input["content_version"] == nil {
				t.Error("mixed/legacy native assignment")
				w.WriteHeader(400)
				return true
			}
			var names []string
			if json.Unmarshal(input["assignees"], &names) != nil || names == nil {
				t.Error("clear sent null")
				w.WriteHeader(400)
				return true
			}
			var reserved int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations m JOIN golf_issue_mutation_events e ON e.mutation_id=m.id WHERE m.kind='UPDATE_ISSUE' AND m.state='OUTCOME_UNKNOWN' AND e.phase='RESERVED'").Scan(&reserved); err != nil || reserved != 1 {
				t.Error("not reserved before dispatch", err, reserved)
			}
			if status := f.patchStatus.Load(); status != 0 {
				w.WriteHeader(int(status))
				return true
			}
			if !f.admin {
				w.WriteHeader(403)
				return true
			}
			selected := make([]User, 0, len(names))
			for _, login := range names {
				for _, user := range f.candidates {
					if user.Login == login {
						selected = append(selected, user)
					}
				}
			}
			row := f.issues[1]
			row.Assignees, _ = json.Marshal(selected)
			row.Assignee = nil
			if f.mode != "ignored" {
				f.issues[1] = row
			}
			if f.mode == "lost" {
				w.WriteHeader(500)
				return true
			}
			receipt := row
			switch f.mode {
			case "wrong-receipt":
				receipt.Assignees, _ = json.Marshal([]User{f.candidates[1]})
			case "identity-receipt":
				receipt.ID++
			case "changed-after":
				row.Assignees, _ = json.Marshal([]User{f.candidates[1]})
				f.issues[1] = row
			case "identity-after":
				row.ID++
				f.issues[1] = row
			case "denied-after":
				f.readStatus.Store(403)
			case "revoked-after":
				if err := f.s.logoutSession(context.Background(), f.source); err != nil {
					t.Error(err)
				}
			}
			w.WriteHeader(201)
			if f.mode == "null-receipt" {
				_ = json.NewEncoder(w).Encode(nil)
			} else {
				_ = json.NewEncoder(w).Encode(receipt)
			}
			return true
		}
		return previous(w, r)
	}
	return f
}
func assigneesInput(f *assigneesFixture, key int, expected []string, selected ...User) *golfv1.UpdateIssueRequest {
	req := updateIssueInput(f.discussionFixture, discussionKey(key))
	req.Assignees = &golfv1.IssueAssigneesChange{ExpectedAssigneeIds: expected}
	for _, row := range selected {
		req.Assignees.Assignees = append(req.Assignees.Assignees, &golfv1.DiscussionAssigneeSelection{Id: strconv.FormatInt(row.ID, 10), Login: row.Login})
	}
	return req
}
func TestIssueAssigneesLifecyclePostgres(t *testing.T) {
	f := newAssigneesFixture(t)
	client, _ := f.client(t, "alice")
	changes := []struct {
		expected []string
		selected []User
	}{{nil, f.candidates[:1]}, {[]string{"42"}, f.candidates}, {[]string{"42", "43"}, f.candidates[1:]}, {[]string{"43"}, nil}}
	for i, change := range changes {
		req := assigneesInput(f, i+1, change.expected, change.selected...)
		var wg sync.WaitGroup
		for j := 0; j < 5; j++ {
			wg.Go(func() {
				if _, err := client.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
		out, err := client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: req.IdempotencyKey}))
		if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || out.Msg.Mutation.ObservedResultId != "41" || out.Msg.Issue == nil {
			t.Fatal("assignment not verified", err, out)
		}
		ids, err := issueAssigneeIDs(f.issues[1].Issue)
		want := make([]int64, len(change.selected))
		for j, row := range change.selected {
			want[j] = row.ID
		}
		if err != nil || !slices.Equal(ids, want) || f.patches.Load() != int32(i+1) {
			t.Fatal("wrong set/replay", ids, err)
		}
		row := out.Msg.Issue
		if row.Title != "Original" || row.Body != "private issue text" || row.State != golfv1.IssueState_ISSUE_STATE_OPEN || !row.Metadata.LabelsKnown || len(row.Metadata.Labels) != 1 || row.Metadata.Labels[0].Id != "1" || !row.Metadata.MilestoneKnown || row.Metadata.Milestone == nil || row.Metadata.Milestone.Id != "5" || row.Metadata.Milestone.OpenIssues != 3 || row.Metadata.Milestone.ClosedIssues != 2 || row.Metadata.Milestone.DueOn != "2026-12-01T00:00:00Z" {
			t.Fatal("unrelated fields changed")
		}
	}
	var activity int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE topic='issues'").Scan(&activity); err != nil || activity != 4 {
		t.Fatal("missing invalidation", err, activity)
	}
}
func TestIssueAssigneesPreflightPostgres(t *testing.T) {
	for _, mode := range []string{"stale", "unknown", "author-reader", "foreign", "wrong-login", "rename", "reused-login", "unassignable", "change-during-choice", "identity-during-choice", "revision-during-choice", "admin-during-choice", "unchanged", "remove-revoked", "retain-revoked", "large-id"} {
		t.Run(mode, func(t *testing.T) {
			f := newAssigneesFixture(t)
			client, _ := f.client(t, "alice")
			req := assigneesInput(f, 1, nil, f.candidates[0])
			f.mode = mode
			switch mode {
			case "stale":
				req.Assignees.ExpectedAssigneeIds = []string{"43"}
			case "unknown":
				row := f.issues[1]
				row.Assignees = nil
				f.issues[1] = row
			case "author-reader":
				f.admin = false
			case "foreign":
				req.Assignees.Assignees[0].Id = "99"
			case "wrong-login":
				req.Assignees.Assignees[0].Login = "bob"
			case "rename":
				f.candidates[0].Login = "alice-renamed"
			case "reused-login":
				f.candidates[0].ID = 99
			case "unassignable":
				f.unassignable["alice"] = true
			case "unchanged":
				req.Assignees.Assignees = nil
			case "remove-revoked", "retain-revoked":
				row := f.issues[1]
				row.Assignees, _ = json.Marshal(f.candidates[1:])
				f.issues[1] = row
				req.Assignees.ExpectedAssigneeIds = []string{"43"}
				f.candidates = f.candidates[:1]
				if mode == "remove-revoked" {
					req.Assignees.Assignees = nil
				} else {
					req.Assignees.Assignees = append(req.Assignees.Assignees, &golfv1.DiscussionAssigneeSelection{Id: "43", Login: "bob"})
				}
			case "large-id":
				f.candidates[0].ID = 9223372036854775807
				req.Assignees.Assignees[0].Id = "9223372036854775807"
			}
			out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
			if mode == "remove-revoked" || mode == "large-id" {
				if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || f.patches.Load() != 1 {
					t.Fatal("valid removal/exact id refused", err, out)
				}
				return
			}
			if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.patches.Load() != 0 {
				t.Fatal("invalid selection dispatched", err, out)
			}
			if (mode == "stale" || mode == "change-during-choice" || mode == "revision-during-choice") && out.Msg.Mutation.FailureCode != "revision_changed" {
				t.Fatal("wrong stale failure")
			}
		})
	}
}
func TestIssueAssigneesUnknownNoReplayPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "wrong-receipt", "identity-receipt", "ignored", "changed-after", "identity-after", "null-receipt", "denied-after"} {
		t.Run(mode, func(t *testing.T) {
			f := newAssigneesFixture(t)
			f.mode = mode
			client, _ := f.client(t, "alice")
			req := assigneesInput(f, 1, nil, f.candidates[0])
			out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
			if mode == "denied-after" {
				if err != nil || out.Msg.Issue != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
					t.Fatal("late denial exposed issue data", err)
				}
				f.readStatus.Store(0)
			} else if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
				t.Fatal("uncertainty promoted", err, out)
			}
			inspected, err := client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: req.IdempotencyKey}))
			if err != nil || inspected.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
				t.Fatal("inspection promoted lost response", err)
			}
			if _, err = client.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || f.patches.Load() != 1 {
				t.Fatal("uncertain PATCH replayed", err)
			}
			req.Assignees.Assignees = []*golfv1.DiscussionAssigneeSelection{{Id: "43", Login: "bob"}}
			if _, err = client.UpdateIssue(t.Context(), connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("changed same-key intent allowed", err)
			}
		})
	}
}
func TestIssueAssigneesSourceRevocationPostgres(t *testing.T) {
	for _, mode := range []string{"revoked-during-choice", "revoked-after"} {
		t.Run(mode, func(t *testing.T) {
			f := newAssigneesFixture(t)
			f.mode = mode
			client, source := f.client(t, "alice")
			f.source = source.Value
			other, _ := f.client(t, "alice")
			req := assigneesInput(f, 1, nil, f.candidates[0])
			if _, err := client.UpdateIssue(t.Context(), connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeUnauthenticated {
				t.Fatal("revoked source exposed result", err)
			}
			expected := int32(0)
			if mode == "revoked-after" {
				expected = 1
			}
			if f.patches.Load() != expected {
				t.Fatal("source revocation dispatch count")
			}
			out, err := other.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: req.IdempotencyKey}))
			if err != nil {
				t.Fatal(err)
			}
			if expected == 1 && out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN {
				t.Fatal("revoked receipt promoted")
			}
			if _, err := other.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || f.patches.Load() != expected {
				t.Fatal("fresh session replayed revoked intent", err)
			}
		})
	}
}
func TestIssueAssigneesUserIsolationPostgres(t *testing.T) {
	f := newAssigneesFixture(t)
	alice, _ := f.client(t, "alice")
	bob, _ := f.client(t, "bob")
	req := assigneesInput(f, 1, nil, f.candidates[0])
	if out, err := alice.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
		t.Fatal(err)
	}
	if _, err := bob.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: req.IdempotencyKey})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("other user intent exposed", err)
	}
	req = assigneesInput(f, 2, []string{"42"}, f.candidates[1])
	if out, err := bob.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.patches.Load() != 1 {
		t.Fatal("native reader admitted", err)
	}
}
func TestIssueAssigneesProviderDenialPostgres(t *testing.T) {
	f := newAssigneesFixture(t)
	client, _ := f.client(t, "alice")
	req := assigneesInput(f, 1, nil, f.candidates[0])
	f.patchStatus.Store(403)
	out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
	if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || out.Msg.Mutation.FailureCode != "provider_http_403" || out.Msg.Mutation.ObservedResultId != "" {
		t.Fatal("provider denial misclassified", err)
	}
	if _, err := client.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || f.patches.Load() != 1 {
		t.Fatal("denial replayed", err)
	}
}
func TestIssueAssigneesValidationAndFingerprint(t *testing.T) {
	boundary := &golfv1.IssueAssigneesChange{}
	for i := 1; i <= 100; i++ {
		id := strconv.Itoa(i)
		boundary.ExpectedAssigneeIds = append(boundary.ExpectedAssigneeIds, id)
		boundary.Assignees = append(boundary.Assignees, &golfv1.DiscussionAssigneeSelection{Id: id, Login: fmt.Sprint("user", i)})
	}
	if _, err := issueAssigneesInput(boundary); err != nil {
		t.Fatal("maximum exact sets refused", err)
	}
	for _, values := range [][]string{{"0"}, {"01"}, {"+1"}, {"-1"}, {"2", "1"}, {"1", "1"}, {"9223372036854775808"}, make([]string, 101)} {
		if _, err := assigneeIDs(values); err == nil {
			t.Fatal("invalid expected ids admitted", values)
		}
	}
	for _, rows := range [][]*golfv1.DiscussionAssigneeSelection{{nil}, {{Id: "1", Login: "../bad"}}, {{Id: "2", Login: "alice"}, {Id: "1", Login: "bob"}}, {{Id: "1", Login: "alice"}, {Id: "2", Login: "ALICE"}}, {{Id: "1", Login: "alice"}, {Id: "1", Login: "bob"}}, make([]*golfv1.DiscussionAssigneeSelection, 101)} {
		if _, err := issueAssigneesInput(&golfv1.IssueAssigneesChange{Assignees: rows}); err == nil {
			t.Fatal("invalid selections admitted")
		}
	}
	for _, rows := range [][]*golfv1.DiscussionAssigneeSelection{nil, {{Id: "9223372036854775807", Login: "alice"}}} {
		change, err := issueAssigneesInput(&golfv1.IssueAssigneesChange{Assignees: rows})
		if err != nil || change.ExpectedIDs == nil || change.Assignees == nil {
			t.Fatal("explicit sets lost", err)
		}
		input := issueMutationInput{Kind: "UPDATE_ISSUE", Owner: "alice", Repository: "example", RepositoryID: 10, IssueID: 41, Number: 1, ExpectedRevision: strings.Repeat("a", 64), EditAssignees: change}
		if err := input.validate(discussionKey(1)); err != nil {
			t.Fatal(err)
		}
		native := input.nativeUpdate(Issue{ContentVersion: proto.Int64(0)})
		raw, _ := json.Marshal(native)
		if len(native) != 2 || native["assignee"] != nil || strings.Contains(string(raw), `"assignees":null`) {
			t.Fatal("wrong native field shape")
		}
		for _, field := range []string{"title", "body", "state", "milestone", "labels"} {
			mixed := input
			switch field {
			case "title":
				mixed.EditTitle = proto.String("Title")
			case "body":
				mixed.EditBody = proto.String("")
			case "state":
				mixed.EditState = "closed"
			case "milestone":
				mixed.EditMilestone = &issueMilestoneChange{}
			case "labels":
				mixed.EditLabels = &issueLabelsChange{ExpectedIDs: []int64{}, IDs: []int64{}}
			}
			if mixed.validate(discussionKey(1)) == nil {
				t.Fatal("mixed assignment admitted", field)
			}
		}
		input.Kind = "UPDATE_PULL"
		input.PullRequest = true
		if input.validate(discussionKey(1)) == nil {
			t.Fatal("PR assignment allowed")
		}
	}
	input := issueMutationInput{Kind: "UPDATE_ISSUE", Owner: "alice", Repository: "example", RepositoryID: 10, IssueID: 41, Number: 1, EditTitle: proto.String("Title"), ExpectedRevision: strings.Repeat("a", 64)}
	raw, _ := json.Marshal(input)
	want := fmt.Sprintf(`{"kind":"UPDATE_ISSUE","owner":"alice","repository":"example","repository_id":10,"issue_id":41,"number":1,"title":"","body":"","edit_title":"Title","expected_revision":"%s"}`, strings.Repeat("a", 64))
	if string(raw) != want {
		t.Fatal("historical fingerprint changed")
	}
}
