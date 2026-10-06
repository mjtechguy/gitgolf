package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

func authoringHeaderUnchanged(before, after *golfv1.PullRequestReview, body string, count uint32) bool {
	if before == nil || after == nil {
		return false
	}
	a := proto.Clone(before).(*golfv1.PullRequestReview)
	a.Body = body
	a.CommentsCount = count
	a.UpdatedAt = after.UpdatedAt
	return proto.Equal(a, after)
}
func authoringChildrenUnchanged(before, after []*golfv1.PullRequestReviewComment, editID, body, deleteID string) bool {
	expected := make([]*golfv1.PullRequestReviewComment, 0, len(before))
	for _, row := range before {
		if row.Id == deleteID {
			continue
		}
		c := proto.Clone(row).(*golfv1.PullRequestReviewComment)
		if row.Id == editID {
			c.Body = body
			for _, a := range after {
				if a.Id == row.Id {
					c.UpdatedAt = a.UpdatedAt
				}
			}
		}
		expected = append(expected, c)
	}
	return reviewChildrenRevision(expected) == reviewChildrenRevision(after)
}

// Native pending and published comments have different presentation URLs. Both
// observations independently validate repository/PR/comment URL binding; the
// publication must preserve every other retained child field and multiplicity.
func authoringPublishedChildrenUnchanged(before, after []*golfv1.PullRequestReviewComment) bool {
	current := map[string]*golfv1.PullRequestReviewComment{}
	for _, row := range after {
		current[row.Id] = row
	}
	expected := make([]*golfv1.PullRequestReviewComment, 0, len(before))
	for _, row := range before {
		now := current[row.Id]
		if now == nil {
			return false
		}
		c := proto.Clone(row).(*golfv1.PullRequestReviewComment)
		c.HtmlUrl = now.HtmlUrl
		expected = append(expected, c)
	}
	return authoringChildrenUnchanged(expected, after, "", "", "")
}
func (s *Server) authoringPostflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitPullReviewAuthoringOperationRequest, before reviewAuthoringSnapshot, raw json.RawMessage, draft *golfv1.PullReviewDraft) (int64, error) {
	if m.Kind == authorDiscard {
		var row forgePullReview
		_, e := s.forge(ctx, http.MethodGet, before.base+"/pulls/"+strconv.FormatUint(uint64(m.Target.Number), 10)+"/reviews/"+m.ReviewId, token, nil, &row)
		var missing forgeError
		if !errors.As(e, &missing) || missing.status != http.StatusNotFound {
			if e != nil {
				return 0, e
			}
			return 0, errPullSnapshotChanged
		}
		after, e := s.authoringState(ctx, session, token, &golfv1.GetPullReviewAuthoringStateRequest{Target: m.Target})
		if e != nil {
			return 0, e
		}
		if after.wire.Review != nil || !inlinePullSemanticsMatch(before.pull, after.pull) {
			return 0, errPullSnapshotChanged
		}
		return mustDiscussionID(m.ReviewId), nil
	}
	selection := authoringSelection(m)
	if m.Kind == authorDelete {
		selection.CommentId = ""
	}
	var receipt forgePullReview
	if m.Kind == authorCreate || m.Kind == authorPrivate || m.Kind == authorUpdate || m.Kind == authorSubmit {
		if json.Unmarshal(raw, &receipt) != nil || receipt.ID <= 0 || receipt.User == nil || receipt.User.ID != before.actor.ID {
			return 0, errInvalidForgeResponse
		}
		if m.Kind == authorCreate || m.Kind == authorPrivate {
			selection.ReviewId = strconv.FormatInt(receipt.ID, 10)
			selection.ReviewCommitId = before.pull.Head.SHA
		} else if receipt.ID != mustDiscussionID(m.ReviewId) {
			return 0, errPullSnapshotChanged
		}
	}
	after, e := s.authoringState(ctx, session, token, selection)
	if e != nil {
		return 0, e
	}
	if !inlinePullSemanticsMatch(before.pull, after.pull) {
		return 0, errPullSnapshotChanged
	}
	w := after.wire
	switch m.Kind {
	case authorCreate:
		input := reviewerPublicationInput{Body: m.Body, Head: before.pull.Head.SHA, Event: "PENDING", Comments: []reviewerPublicationComment{}}
		r := database.GolfInlineReviewMutation{ActorID: before.actor.ID, HeadCommit: input.Head, Decision: "PENDING", ObservedReviewID: receipt.ID, PayloadFingerprint: inlinePayloadFingerprint(input)}
		if !inlineHeaderMatches(receipt, r, before.pull, input) || !proto.Equal(w.Review, wirePullReview(receipt)) || len(w.Comments) != 0 || !w.OwnPending {
			return 0, errPullSnapshotChanged
		}
	case authorPrivate:
		input, c, e := authoringInlinePayload(draft)
		if e != nil {
			return 0, e
		}
		r := database.GolfInlineReviewMutation{ActorID: before.actor.ID, RepositoryID: before.repo.ID, PullRequestID: before.pull.ID, PullNumber: int32(before.pull.Number), HeadCommit: input.Head, Decision: "PENDING", ObservedReviewID: receipt.ID, PayloadFingerprint: inlinePayloadFingerprint(input), EntryCount: int32(len(input.Comments))}
		if !inlineHeaderMatches(receipt, r, before.pull, input) || !proto.Equal(w.Review, wirePullReview(receipt)) {
			return 0, errPullSnapshotChanged
		}
		if _, e = s.verifyInlineReview(ctx, token, before.base, before.repo, before.pull, r, input, c); e != nil {
			return 0, e
		}
		if e = s.inlinePostflight(ctx, session, token, m.Target, r, draft, before.pull); e != nil {
			return 0, e
		}
	case authorUpdate:
		if !w.OwnPending || !authoringHeaderUnchanged(before.wire.Review, w.Review, m.Body, uint32(len(before.wire.Comments))) || !proto.Equal(w.Review, wirePullReview(receipt)) || !authoringChildrenUnchanged(before.wire.Comments, w.Comments, "", "", "") {
			return 0, errPullSnapshotChanged
		}
	case authorSubmit:

		if w.OwnPending || w.Review == nil || w.Review.State != m.Decision || w.Review.CommitId != before.pull.Head.SHA || w.Review.Body != m.Body || w.Review.User == nil || w.Review.User.Id != strconv.FormatInt(before.actor.ID, 10) || w.Review.Dismissed || w.Review.Stale || !proto.Equal(w.Review, wirePullReview(receipt)) || !authoringPublishedChildrenUnchanged(before.wire.Comments, w.Comments) {
			return 0, errPullSnapshotChanged
		}
		original := before.wire.Review
		if w.Review.Id != original.Id || w.Review.CommentsCount != original.CommentsCount {
			return 0, errPullSnapshotChanged
		}
	case authorEdit:
		var receipt struct {
			ID   int64  `json:"id"`
			Body string `json:"body"`
			User *User  `json:"user"`
		}
		if json.Unmarshal(raw, &receipt) != nil || receipt.ID != mustDiscussionID(m.CommentId) || receipt.Body != m.Body {
			return 0, errInvalidForgeResponse
		}
		var original *golfv1.PullRequestReviewComment
		for _, c := range before.wire.Comments {
			if c.Id == m.CommentId {
				original = c
			}
		}
		if original == nil || original.User == nil || receipt.User != nil && receipt.User.ID > 0 && original.User.Id != strconv.FormatInt(receipt.User.ID, 10) || !authoringHeaderUnchanged(before.wire.Review, w.Review, before.wire.Review.Body, uint32(len(before.wire.Comments))) || !authoringChildrenUnchanged(before.wire.Comments, w.Comments, m.CommentId, m.Body, "") {
			return 0, errPullSnapshotChanged
		}
	case authorDelete:
		if len(before.wire.Comments) == 0 || !authoringHeaderUnchanged(before.wire.Review, w.Review, before.wire.Review.Body, uint32(len(before.wire.Comments)-1)) || !authoringChildrenUnchanged(before.wire.Comments, w.Comments, "", "", m.CommentId) {
			return 0, errPullSnapshotChanged
		}
	}
	return mustDiscussionID(w.Review.Id), nil
}
