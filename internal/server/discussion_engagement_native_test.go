package server

import (
	"connectrpc.com/connect"
	"context"
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	golfv1connect "github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"os"
	"testing"
)

func TestDiscussionEngagementNative(t *testing.T) {
	raw := os.Getenv("GOLF_TEST_ENGAGEMENT_NATIVE")
	if raw == "" {
		t.Skip("requires owned actual native fixture")
	}
	var f struct {
		NativeURL, Token, Owner, Name, RepositoryID, IssueID, CommentID, ReaderToken, Organization, OrganizationRepositoryID, OrganizationIssueID, OrganizationLabelID string
		Number, OrganizationNumber                                                                                                                                     uint32
	}
	if json.Unmarshal([]byte(raw), &f) != nil || f.NativeURL != "http://localhost:3001" || f.Token == "" {
		t.Fatal("invalid owned native fixture")
	}
	s, e := New(testConfig(f.NativeURL), testDatabase(t))
	if e != nil {
		t.Fatal("native source setup", e)
	}
	sessions, writes, _, httpClient, origin := testRPCClients(t, s)
	login, e := sessions.LoginWithGiteaToken(t.Context(), connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: f.Token}))
	if e != nil || login.Msg.User == nil {
		t.Fatal("native source login", connect.CodeOf(e))
	}
	defer sessions.Logout(t.Context(), connect.NewRequest(&golfv1.LogoutRequest{}))
	reads := golfv1connect.NewDiscussionCollaborationServiceClient(httpClient, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, r)
		}
	})))
	for _, comment := range []string{"", f.CommentID} {
		target := &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: f.Owner, Name: f.Name}, RepositoryId: f.RepositoryID, IssueId: f.IssueID, Number: f.Number, CommentId: comment}
		kinds := []golfv1.DiscussionResourceOperationKind{9, 10}
		original, e := reads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
		if e != nil {
			t.Fatal("native initial engagement", connect.CodeOf(e))
		}
		if comment == "" {
			if original.Msg.Subscribed {
				kinds = append(kinds, 12, 11)
			} else {
				kinds = append(kinds, 11, 12)
			}
		}
		for _, kind := range kinds {
			current, e := reads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
			if e != nil {
				t.Fatal("native engagement observation", connect.CodeOf(e))
			}
			m := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: target.Repository, RepositoryId: f.RepositoryID, IssueId: f.IssueID, Number: f.Number, ResourceId: f.IssueID, ExpectedRevision: current.Msg.Revision, OperationId: randomUUID(), Kind: kind}
			if comment != "" {
				m.ResourceId = comment
				m.ReactionComment = true
			}
			if kind == 9 || kind == 10 {
				m.Change = &golfv1.SubmitDiscussionResourceOperationRequest_Reaction{Reaction: "+1"}
			} else {
				m.SubscriptionLogin = login.Msg.User.Login
			}
			for repeat := 0; repeat < 2; repeat++ {
				result, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
				if e != nil || result.Msg.Operation.GetPhase() != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
					t.Fatalf("native kind%d receipt/replay not confirmed code=%s phase=%s", kind, connect.CodeOf(e), result.Msg.GetOperation().GetPhase())
				}
			}
		}
		final, e := reads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
		if e != nil || final.Msg.Subscribed != original.Msg.Subscribed {
			t.Fatal("native original subscription not preserved")
		}
		for _, r := range final.Msg.Reactions {
			if r.Content == "+1" && r.Reacted {
				t.Fatal("native reaction cleanup not confirmed")
			}
		}
	}
	timeline, e := reads.ListDiscussionTimeline(t.Context(), connect.NewRequest(&golfv1.ListDiscussionTimelineRequest{Target: &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: f.Owner, Name: f.Name}, RepositoryId: f.RepositoryID, IssueId: f.IssueID, Number: f.Number}}))
	if e != nil || len(timeline.Msg.Events) == 0 {
		t.Fatal("native timeline unavailable", connect.CodeOf(e))
	}

	templates, e := reads.ListIssueTemplates(t.Context(), connect.NewRequest(&golfv1.ListIssueTemplatesRequest{Repository: &golfv1.RepositoryKey{Owner: f.Owner, Name: f.Name}, RepositoryId: f.RepositoryID}))
	if e != nil || len(templates.Msg.Templates) != 1 || templates.Msg.Templates[0].Body != "## Reproduce\n" {
		t.Fatal("native immutable template read", connect.CodeOf(e))
	}
	inbox, e := reads.ListOwnForgeNotifications(t.Context(), connect.NewRequest(&golfv1.ListOwnForgeNotificationsRequest{}))
	if e != nil || len(inbox.Msg.Notifications) == 0 {
		t.Fatal("native own inbox", connect.CodeOf(e))
	}
	var notification *golfv1.OwnForgeNotification
	for _, row := range inbox.Msg.Notifications {
		if row.Target.IssueId == f.IssueID {
			notification = row
		}
	}
	if notification == nil {
		t.Fatal("native author notification absent")
	}
	mark := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: notification.Target.Repository, RepositoryId: f.RepositoryID, IssueId: f.IssueID, Number: f.Number, ResourceId: notification.Id, ExpectedRevision: notification.Revision, Kind: 13, OperationId: randomUUID()}
	for range 2 {
		result, e := writes.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(mark))
		if e != nil || result.Msg.Operation.GetPhase() != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
			t.Fatal("native own mark-read/replay", connect.CodeOf(e))
		}
	}
	inherited, e := writes.ListRepositoryLabels(t.Context(), connect.NewRequest(&golfv1.ListRepositoryLabelsRequest{Repository: &golfv1.RepositoryKey{Owner: f.Organization, Name: "labels"}, RepositoryId: f.OrganizationRepositoryID, IncludeOrganizationLabels: true}))
	if e != nil || len(inherited.Msg.Labels) != 1 || !inherited.Msg.Labels[0].OrganizationOwned || inherited.Msg.Labels[0].Id != f.OrganizationLabelID {
		t.Fatal("native inherited label inventory", connect.CodeOf(e))
	}
	orgIssue, e := writes.GetIssue(t.Context(), connect.NewRequest(&golfv1.GetIssueRequest{Repository: &golfv1.RepositoryKey{Owner: f.Organization, Name: "labels"}, Number: f.OrganizationNumber}))
	if e != nil {
		t.Fatal("native organization issue", connect.CodeOf(e))
	}
	labels, e := writes.UpdateIssue(t.Context(), connect.NewRequest(&golfv1.UpdateIssueRequest{Repository: &golfv1.RepositoryKey{Owner: f.Organization, Name: "labels"}, RepositoryId: f.OrganizationRepositoryID, IssueId: f.OrganizationIssueID, Number: f.OrganizationNumber, ExpectedRevision: orgIssue.Msg.Issue.Revision, Labels: &golfv1.IssueLabelsChange{LabelIds: []string{f.OrganizationLabelID}}, IdempotencyKey: randomUUID()}))
	if e != nil || labels.Msg.Mutation.GetState() != golfv1.IssueMutationState_ISSUE_MUTATION_STATE_SUCCEEDED {
		t.Fatal("native inherited label assignment", connect.CodeOf(e))
	}

	readerSessions, readerWrites, _, readerHTTP, readerOrigin := testRPCClients(t, s)
	readerLogin, e := readerSessions.LoginWithGiteaToken(t.Context(), connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: f.ReaderToken}))
	if e != nil || readerLogin.Msg.User == nil {
		t.Fatal("native ordinary reader login", connect.CodeOf(e))
	}
	defer readerSessions.Logout(t.Context(), connect.NewRequest(&golfv1.LogoutRequest{}))
	readerReads := golfv1connect.NewDiscussionCollaborationServiceClient(readerHTTP, readerOrigin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Origin", s.config.PublicURL)
			return next(ctx, r)
		}
	})))
	target := &golfv1.DiscussionTarget{Repository: &golfv1.RepositoryKey{Owner: f.Owner, Name: f.Name}, RepositoryId: f.RepositoryID, IssueId: f.IssueID, Number: f.Number}
	current, e := readerReads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
	if e != nil || !current.Msg.CanReact || !current.Msg.CanSubscribe {
		t.Fatal("native reader engagement unavailable", connect.CodeOf(e))
	}
	originalSubscription := current.Msg.Subscribed
	sequence := []golfv1.DiscussionResourceOperationKind{9, 10}
	if originalSubscription {
		sequence = append(sequence, 12, 11)
	} else {
		sequence = append(sequence, 11, 12)
	}
	for _, kind := range sequence {
		current, e = readerReads.GetDiscussionEngagement(t.Context(), connect.NewRequest(&golfv1.GetDiscussionEngagementRequest{Target: target}))
		if e != nil {
			t.Fatal("native reader reobservation", connect.CodeOf(e))
		}
		m := &golfv1.SubmitDiscussionResourceOperationRequest{Repository: target.Repository, RepositoryId: f.RepositoryID, IssueId: f.IssueID, Number: f.Number, ResourceId: f.IssueID, ExpectedRevision: current.Msg.Revision, OperationId: randomUUID(), Kind: kind}
		if kind == 9 || kind == 10 {
			m.Change = &golfv1.SubmitDiscussionResourceOperationRequest_Reaction{Reaction: "+1"}
		} else {
			m.SubscriptionLogin = readerLogin.Msg.User.Login
		}
		result, e := readerWrites.SubmitDiscussionResourceOperation(t.Context(), connect.NewRequest(m))
		if e != nil || result.Msg.Operation.GetPhase() != golfv1.DiscussionResourceOperationPhase_DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED {
			t.Fatal("native read-only collaborator engagement refused", kind, connect.CodeOf(e))
		}
	}
	t.Log("PASS actual native issue/comment reactions, own subscriptions, original-key replay and native activity; temporary schema and owned actor cleaned by launcher; no served-runtime claim")
}
