package server

import (
	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
	"testing"
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
