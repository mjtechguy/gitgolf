package server

import (
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

type labelsFixture struct {
	*discussionFixture
	admin bool
	mode  string
	rows  []forgeDiscussionLabel
}

func newLabelsFixture(t *testing.T) *labelsFixture {
	t.Helper()
	f := &labelsFixture{discussionFixture: newDiscussionFixture(t), admin: true}
	for id := int64(1); id <= 60; id++ {
		f.rows = append(f.rows, forgeDiscussionLabel{ID: id, Name: fmt.Sprint("Label ", id), Color: "AbC123", Description: "native label"})
	}
	f.mu.Lock()
	row := f.issues[1]
	row.Labels = json.RawMessage(`[]`)
	f.issues[1] = row
	f.mu.Unlock()
	f.nativeHook = func(w http.ResponseWriter, r *http.Request) bool {
		const base = "/api/v1/repos/alice/example"
		f.mu.Lock()
		defer f.mu.Unlock()
		if status := f.readStatus.Load(); status != 0 && r.Method == "GET" && strings.HasPrefix(r.URL.Path, base) {
			w.WriteHeader(int(status))
			return true
		}
		if r.URL.Path == base && r.Method == "GET" {
			raw, _ := json.Marshal(f.repo)
			var value map[string]any
			_ = json.Unmarshal(raw, &value)
			value["permissions"] = map[string]bool{"admin": f.admin && r.Header.Get("Authorization") != "token bob-issue-token"}
			value["archived"] = false
			value["has_issues"] = true
			_ = json.NewEncoder(w).Encode(value)
			return true
		}
		if r.URL.Path == base+"/labels" && r.Method == "GET" {
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			page, _ := strconv.Atoi(r.URL.Query().Get("page"))
			if limit > 50 {
				t.Error("native page clamp ignored")
			}
			w.Header().Set("X-Total-Count", strconv.Itoa(len(f.rows)))
			if f.mode == "bad-total" {
				w.Header().Set("X-Total-Count", "bad")
			}
			start := min((page-1)*limit, len(f.rows))
			end := min(start+limit, len(f.rows))
			_ = json.NewEncoder(w).Encode(f.rows[start:end])
			if f.mode == "admin-during-list" {
				f.admin = false
			}
			return true
		}
		if strings.HasPrefix(r.URL.Path, base+"/labels/") && r.Method == "GET" {
			id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, base+"/labels/"), 10, 64)
			for _, row := range f.rows {
				if row.ID == id {
					if f.mode == "change-during-choice" {
						current := f.issues[1]
						current.Labels, _ = json.Marshal([]forgeDiscussionLabel{f.rows[2]})
						f.issues[1] = current
					}
					if f.mode == "identity-during-choice" {
						current := f.issues[1]
						current.ID++
						f.issues[1] = current
					}
					if f.mode == "admin-during-choice" {
						f.admin = false
					}
					if f.mode == "wrong-label" {
						row.ID++
					}
					_ = json.NewEncoder(w).Encode(row)
					return true
				}
			}
			w.WriteHeader(404)
			return true
		}
		if r.URL.Path == base+"/issues/1/labels" && r.Method == "PUT" {
			f.patches.Add(1)
			var input map[string]json.RawMessage
			if json.NewDecoder(r.Body).Decode(&input) != nil || len(input) != 1 || input["labels"] == nil {
				t.Error("mixed/invalid label PUT")
				w.WriteHeader(400)
				return true
			}
			var ids []int64
			if json.Unmarshal(input["labels"], &ids) != nil || ids == nil {
				t.Error("empty selection must send []")
				w.WriteHeader(400)
				return true
			}
			var reserved int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_issue_mutations m JOIN golf_issue_mutation_events e ON e.mutation_id=m.id WHERE m.kind='UPDATE_ISSUE' AND m.state='OUTCOME_UNKNOWN' AND e.phase='RESERVED'").Scan(&reserved); err != nil || reserved != 1 {
				t.Error("not durably reserved", err, reserved)
			}
			if status := f.patchStatus.Load(); status != 0 {
				w.WriteHeader(int(status))
				return true
			}
			if !f.admin {
				w.WriteHeader(403)
				return true
			}
			selected := make([]forgeDiscussionLabel, 0, len(ids))
			for _, id := range ids {
				for _, row := range f.rows {
					if id == row.ID {
						selected = append(selected, row)
					}
				}
			}
			row := f.issues[1]
			row.Labels, _ = json.Marshal(selected)
			if f.mode != "ignored" {
				f.issues[1] = row
			}
			if f.mode == "lost" {
				w.WriteHeader(500)
				return true
			}
			if f.mode == "wrong-receipt" {
				selected = []forgeDiscussionLabel{f.rows[2]}
			}
			if f.mode == "changed-after" {
				row.Labels, _ = json.Marshal([]forgeDiscussionLabel{f.rows[2]})
				f.issues[1] = row
			}
			if f.mode == "identity-after" {
				row.ID++
				f.issues[1] = row
			}
			if f.mode == "null-receipt" {
				_ = json.NewEncoder(w).Encode(nil)
				return true
			}
			_ = json.NewEncoder(w).Encode(selected)
			return true
		}
		return false
	}
	return f
}
func labelsInput(f *labelsFixture, key int, expected, selected []string) *golfv1.UpdateIssueRequest {
	req := updateIssueInput(f.discussionFixture, discussionKey(key))
	req.Labels = &golfv1.IssueLabelsChange{ExpectedLabelIds: expected, LabelIds: selected}
	return req
}
func TestIssueLabelsLifecyclePostgres(t *testing.T) {
	f := newLabelsFixture(t)
	client, _ := f.client(t, "alice")
	changes := [][2][]string{{{}, {"1"}}, {{"1"}, {"1", "2"}}, {{"1", "2"}, {"2"}}, {{"2"}, {}}}
	for i, change := range changes {
		req := labelsInput(f, i+1, change[0], change[1])
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
			t.Fatal("label update not verified", err, out)
		}
		ids, err := issueLabelIDs(f.issues[1].Issue)
		wanted, _ := labelIDs(change[1], true)
		if err != nil || !slices.Equal(ids, wanted) || f.patches.Load() != int32(i+1) {
			t.Fatal("set mismatch/replay", err, ids)
		}
		if out.Msg.Issue.Title != "Original" || out.Msg.Issue.Body != "private issue text" || out.Msg.Issue.State != golfv1.IssueState_ISSUE_STATE_OPEN {
			t.Fatal("unrelated fields changed")
		}
	}
	var activity int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_repository_activity WHERE topic='issues'").Scan(&activity); err != nil || activity != 4 {
		t.Fatal("missing live invalidation", err, activity)
	}
}
func TestIssueLabelsPreflightPostgres(t *testing.T) {
	for _, mode := range []string{"stale", "unknown", "reader-author", "foreign", "org-current", "wrong-label", "change-during-choice", "identity-during-choice", "admin-during-choice", "unchanged", "exclusive", "exclusive-slashes", "large-current"} {
		t.Run(mode, func(t *testing.T) {
			f := newLabelsFixture(t)
			client, _ := f.client(t, "alice")
			req := labelsInput(f, 1, nil, []string{"1"})
			f.mode = mode
			switch mode {
			case "stale":
				req.Labels.ExpectedLabelIds = []string{"2"}
			case "unknown":
				row := f.issues[1]
				row.Labels = nil
				f.issues[1] = row
			case "reader-author":
				f.admin = false
			case "foreign":
				req.Labels.LabelIds = []string{"999"}
			case "org-current":
				row := f.issues[1]
				label := f.rows[0]
				label.ID = 999
				row.Labels, _ = json.Marshal([]forgeDiscussionLabel{label})
				f.issues[1] = row
				req.Labels.ExpectedLabelIds = []string{"999"}
				req.Labels.LabelIds = nil
			case "unchanged":
				req.Labels.LabelIds = nil
			case "exclusive", "exclusive-slashes":
				prefix := "type"
				if mode == "exclusive-slashes" {
					prefix = "team/type"
				}
				f.rows[0].Name = prefix + "/one"
				f.rows[1].Name = prefix + "/two"
				f.rows[0].Exclusive = true
				f.rows[1].Exclusive = true
				req.Labels.LabelIds = []string{"1", "2"}
			case "large-current":
				label := f.rows[0]
				label.ID = maxNativeLabelSelection + 2
				f.rows = append(f.rows, label)
				row := f.issues[1]
				row.Labels, _ = json.Marshal([]forgeDiscussionLabel{label})
				f.issues[1] = row
				req.Labels.ExpectedLabelIds = []string{strconv.FormatInt(label.ID, 10)}
				req.Labels.LabelIds = nil
			}
			out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
			if mode == "large-current" {
				if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED || f.patches.Load() != 1 {
					t.Fatal("exact huge current ID could not be removed", err, out)
				}
				return
			}
			if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.patches.Load() != 0 {
				t.Fatal("invalid labels dispatched", err, out)
			}
			if (mode == "stale" || mode == "change-during-choice") && out.Msg.Mutation.FailureCode != "revision_changed" {
				t.Fatal("wrong stale observation code")
			}
		})
	}
}
func TestIssueLabelsUnknownNoReplayPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "wrong-receipt", "ignored", "changed-after", "identity-after", "null-receipt"} {
		t.Run(mode, func(t *testing.T) {
			f := newLabelsFixture(t)
			f.mode = mode
			client, _ := f.client(t, "alice")
			req := labelsInput(f, 1, nil, []string{"1"})
			out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
			if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_OUTCOME_UNKNOWN || out.Msg.Mutation.ObservedResultId != "" {
				t.Fatal("uncertain result/identity promoted", err, out)
			}
			if _, err = client.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: req.IdempotencyKey})); err != nil {
				t.Fatal(err)
			}
			if _, err = client.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || f.patches.Load() != 1 {
				t.Fatal("uncertain PUT replayed", err)
			}
			req.Labels.LabelIds = []string{"2"}
			if _, err = client.UpdateIssue(t.Context(), connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("changed intent accepted", err)
			}
		})
	}
}
func TestIssueLabelsValidationAndFingerprint(t *testing.T) {
	for _, values := range [][]string{{"0"}, {"01"}, {"+1"}, {"-1"}, {"2", "1"}, {"1", "1"}, {"9223372036854775808"}, {"9007199254740992"}, make([]string, 257)} {
		if _, err := labelIDs(values, true); err == nil {
			t.Fatal("invalid selected IDs admitted", values)
		}
	}
	if ids, err := labelIDs([]string{"2", "10", "9007199254740991"}, true); err != nil || len(ids) != 3 {
		t.Fatal("numeric sort/exact integer boundary rejected")
	}
	empty, err := labelIDs(nil, true)
	if err != nil || empty == nil {
		t.Fatal("clear must normalize to nonnil []")
	}
	for _, selected := range [][]int64{{1, 2}, {}} {
		input := issueMutationInput{Kind: "UPDATE_ISSUE", Owner: "alice", Repository: "example", RepositoryID: 10, IssueID: 41, Number: 1, ExpectedRevision: strings.Repeat("a", 64), EditLabels: &issueLabelsChange{ExpectedIDs: []int64{}, IDs: selected}}
		if err := input.validate(discussionKey(1)); err != nil {
			t.Fatal(err)
		}
		input.EditTitle = proto.String("Title")
		if input.validate(discussionKey(1)) == nil {
			t.Fatal("mixed labels/title admitted")
		}
		input.EditTitle = nil
		input.EditMilestone = &issueMilestoneChange{}
		if input.validate(discussionKey(1)) == nil {
			t.Fatal("mixed metadata admitted")
		}
		input.EditMilestone = nil
		input.PullRequest = true
		input.Kind = "UPDATE_PULL"
		if input.validate(discussionKey(1)) == nil {
			t.Fatal("PR label mutation admitted")
		}
	}
	input := issueMutationInput{Kind: "UPDATE_ISSUE", Owner: "alice", Repository: "example", RepositoryID: 10, IssueID: 41, Number: 1, EditTitle: proto.String("Title"), ExpectedRevision: strings.Repeat("a", 64)}
	raw, _ := json.Marshal(input)
	want := `{"kind":"UPDATE_ISSUE","owner":"alice","repository":"example","repository_id":10,"issue_id":41,"number":1,"title":"","body":"","edit_title":"Title","expected_revision":"` + strings.Repeat("a", 64) + `"}`
	if string(raw) != want {
		t.Fatal("historical fingerprint changed")
	}
}

func TestIssueLabelsUserIsolationPostgres(t *testing.T) {
	f := newLabelsFixture(t)
	alice, _ := f.client(t, "alice")
	bob, _ := f.client(t, "bob")
	req := labelsInput(f, 1, nil, []string{"1"})
	if out, err := alice.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
		t.Fatal("owner write failed", err)
	}
	if _, err := bob.GetIssueMutation(t.Context(), connect.NewRequest(&golfv1.GetIssueMutationRequest{IdempotencyKey: req.IdempotencyKey})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("cross-user operation exposed", err)
	}
	req = labelsInput(f, 2, []string{"1"}, []string{"2"})
	if out, err := bob.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || f.patches.Load() != 1 {
		t.Fatal("native reader admitted to label writes", err)
	}
}
func TestIssueLabelsProviderDenialPostgres(t *testing.T) {
	f := newLabelsFixture(t)
	client, _ := f.client(t, "alice")
	req := labelsInput(f, 1, nil, []string{"1"})
	f.patchStatus.Store(403)
	out, err := client.UpdateIssue(t.Context(), connect.NewRequest(req))
	if err != nil || out.Msg.Mutation.State != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_REJECTED || out.Msg.Mutation.FailureCode != "provider_http_403" || out.Msg.Mutation.ObservedResultId != "" {
		t.Fatal("provider denial misclassified", err)
	}
	if _, err = client.UpdateIssue(t.Context(), connect.NewRequest(req)); err != nil || f.patches.Load() != 1 {
		t.Fatal("denial replayed", err)
	}
}
