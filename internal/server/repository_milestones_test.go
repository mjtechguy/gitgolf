package server

import (
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestRepositoryMilestoneInventoryPostgres(t *testing.T) {
	f := newMilestoneFixture(t)
	client, _ := f.client(t, "alice")
	req := &golfv1.ListRepositoryMilestonesRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10", State: golfv1.IssueState_ISSUE_STATE_ALL, Page: &golfv1.PageRequest{Page: 1, Limit: 100}}
	first, err := client.ListRepositoryMilestones(t.Context(), connect.NewRequest(req))
	if err != nil || len(first.Msg.Milestones) != 50 || first.Msg.Page.NextPage != 2 || !first.Msg.CanEditMilestone {
		t.Fatal("native page/capability mismatch", err, first)
	}
	req.Page.Page = 2
	second, err := client.ListRepositoryMilestones(t.Context(), connect.NewRequest(req))
	if err != nil || len(second.Msg.Milestones) != 10 || second.Msg.Page.NextPage != 0 {
		t.Fatal("native page completion", err, second)
	}
	req.Page.Page = 1
	req.State = golfv1.IssueState_ISSUE_STATE_UNSPECIFIED
	f.admin = false
	open, err := client.ListRepositoryMilestones(t.Context(), connect.NewRequest(req))
	if err != nil || len(open.Msg.Milestones) != 30 || open.Msg.CanEditMilestone {
		t.Fatal("reader wrongly admitted", err, open)
	}
	for _, row := range open.Msg.Milestones {
		if row.State != golfv1.IssueState_ISSUE_STATE_OPEN {
			t.Fatal("default state not open")
		}
	}
	req.RepositoryId = "11"
	if _, err := client.ListRepositoryMilestones(t.Context(), connect.NewRequest(req)); err == nil {
		t.Fatal("replacement repository accepted")
	}
	req.RepositoryId = "10"
	f.rows[0].OpenIssues = proto.Int64(-1)
	if _, err := client.ListRepositoryMilestones(t.Context(), connect.NewRequest(req)); err == nil {
		t.Fatal("invalid native count accepted")
	}
}

func TestRepositoryMilestoneApiCredentialPostgres(t *testing.T) {
	f := newMilestoneFixture(t)
	_, session := f.client(t, "alice")
	credential := issueApiCredential(t, apiManagementClient(t, &managementFixture{s: f.s, db: f.db}, session), "milestone read", 0)
	req := &golfv1.ListRepositoryMilestonesRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10", State: golfv1.IssueState_ISSUE_STATE_ALL, Page: &golfv1.PageRequest{Page: 1, Limit: 100}}
	raw, err := protojson.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	response := apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceListRepositoryMilestonesProcedure, string(raw))
	var out golfv1.ListRepositoryMilestonesResponse
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || protojson.Unmarshal(response.Body.Bytes(), &out) != nil || len(out.Milestones) != 50 || out.CanEditMilestone {
		t.Fatal("read-only API milestone boundary", response.Code)
	}
	if err := f.s.logoutSession(t.Context(), session.Value); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceListRepositoryMilestonesProcedure, string(raw))
	if response.Code != 401 || strings.Contains(response.Body.String(), "Milestone 1") {
		t.Fatal("expired source exposed milestone inventory", response.Code)
	}
}
