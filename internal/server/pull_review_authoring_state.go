package server

import (
	"context"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

type reviewAuthoringSnapshot struct {
	wire  *golfv1.GetPullReviewAuthoringStateResponse
	pull  forgePull
	repo  Repository
	base  string
	actor User
}

func authoringSelection(m *golfv1.SubmitPullReviewAuthoringOperationRequest) *golfv1.GetPullReviewAuthoringStateRequest {
	return &golfv1.GetPullReviewAuthoringStateRequest{Target: m.Target, ReviewId: m.ReviewId, ReviewCommitId: m.ReviewCommitId, CommentId: m.CommentId}
}
func (s *Server) ownNativePending(ctx context.Context, token forgeCredential, base string, repo Repository, pull forgePull, actor User) (*forgePullReview, error) {
	var found *forgePullReview
	e := s.withNativePageSize(ctx, token, 100, func(limit uint32) error {
		total := int64(-1)
		seen := map[int64]bool{}
		for page := uint32(1); page <= 2000; page++ {
			var rows []forgePullReview
			h, e := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatInt(pull.Number, 10)+"/reviews?"+pageQuery(page, limit).Encode(), token, nil, &rows)
			if e != nil {
				return e
			}
			count, e := strconv.ParseInt(h.Get("X-Total-Count"), 10, 64)
			if e != nil || count < 0 || count > 2000 || rows == nil || len(rows) > int(limit) || int64(len(rows)) > count || total >= 0 && total != count {
				return errInvalidForgeResponse
			}
			total = count
			for _, row := range rows {
				if row.ID <= 0 || seen[row.ID] || !validPullUser(row.User) || pullReviewState(row.State) == 0 || !validPullTime(row.SubmittedAt) || !validPullTime(row.UpdatedAt) || row.PullRequestURL != pull.HTMLURL {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				if row.State == "PENDING" && row.User != nil && row.User.ID == actor.ID {
					if found != nil {
						return errRepositoryAccessConflict
					}
					copy := row
					found = &copy
				}
			}
			next, e := pullNextPage(h, page, limit)
			if e != nil {
				return e
			}
			if next == 0 {
				if uint64(page)*uint64(limit) < uint64(total) {
					return errInvalidForgeResponse
				}
				return nil
			}
			if next != page+1 {
				return errInvalidForgeResponse
			}
		}
		return errForgeResponseTooLarge
	})
	return found, e
}
func (s *Server) authoringState(ctx context.Context, session string, token forgeCredential, m *golfv1.GetPullReviewAuthoringStateRequest) (reviewAuthoringSnapshot, error) {
	var snap reviewAuthoringSnapshot
	scope, e := reviewDraftTarget(m.Target)
	if e != nil {
		return snap, e
	}
	if m.ReviewId != "" {
		if _, e = discussionID(m.ReviewId); e != nil {
			return snap, e
		}
		if !objectID.MatchString(m.ReviewCommitId) {
			return snap, invalid("Select the exact reviewed commit.")
		}
	} else if m.ReviewCommitId != "" || m.CommentId != "" {
		return snap, invalid("A comment requires its exact visible review.")
	}
	if m.CommentId != "" {
		if _, e = discussionID(m.CommentId); e != nil {
			return snap, e
		}
	}
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Target.Repository), func(base string, repo Repository) error {
		if repo.ID != scope.repositoryID {
			return errIssueTargetChanged
		}
		pull, e := s.readPull(ctx, token, base, repo, uint32(scope.number))
		if e != nil {
			return e
		}
		if pull.ID != scope.pullID || pullRevision(pull) == "" {
			return errIssueTargetChanged
		}
		actor, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		enabled, e := s.activeDiscussionUnit(ctx, token, base, repo, true)
		if e != nil {
			return e
		}
		out := &golfv1.GetPullReviewAuthoringStateResponse{Target: proto.Clone(m.Target).(*golfv1.PullReviewDraftTarget), PullRevision: pullRevision(pull), CurrentHeadCommitId: pull.Head.SHA}
		var selected *forgePullReview
		if m.ReviewId == "" {
			selected, e = s.ownNativePending(ctx, token, base, repo, pull, actor)
			if e != nil {
				return e
			}
		} else {
			var row forgePullReview
			if _, e = s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatInt(pull.Number, 10)+"/reviews/"+m.ReviewId, token, nil, &row); e != nil {
				return e
			}
			if row.ID != mustDiscussionID(m.ReviewId) || row.CommitID != m.ReviewCommitId || row.PullRequestURL != pull.HTMLURL {
				return errIssueTargetChanged
			}
			selected = &row
		}
		if selected != nil {
			if selected.State == "PENDING" && (selected.User == nil || selected.User.ID != actor.ID) {
				return errResourceNotFound
			}
			comments, e := s.getPullRequestReviewComments(ctx, session, token, &golfv1.GetPullRequestReviewCommentsRequest{Repository: m.Target.Repository, RepositoryId: m.Target.RepositoryId, PullRequestId: m.Target.PullRequestId, Number: m.Target.Number, ReviewId: strconv.FormatInt(selected.ID, 10), ReviewCommitId: selected.CommitID})
			if e != nil {
				return e
			}
			out.Review, out.Comments = comments.Review, comments.Comments
			out.OwnPending = selected.State == "PENDING" && selected.User != nil && selected.User.ID == actor.ID
			if out.OwnPending {
				out.CanDiscard = enabled
				out.CanUpdate = enabled && pull.State == "open" && !*pull.Merged
				out.CanSubmit = out.CanUpdate && selected.CommitID == pull.Head.SHA && !*pull.Draft
				if out.CanSubmit && len(out.Comments) > 0 {
					raw, err := s.readCommitDiff(ctx, base+"/pulls/"+strconv.FormatInt(pull.Number, 10)+".diff", token)
					if err != nil {
						return err
					}
					comparison, err := parseReviewComparison(raw)
					if err != nil {
						return err
					}
					for _, row := range out.Comments {
						line, old := int(row.NewLine), false
						if row.OldLine > 0 {
							line, old = int(row.OldLine), true
						}
						if !comparison.matchesNativeContextSide(row.Path, line, old, row.DiffHunk) {
							out.CanSubmit = false
							break
						}
					}
				}
			}
			if m.CommentId != "" {
				var comment *golfv1.PullRequestReviewComment
				for _, row := range out.Comments {
					if row.Id == m.CommentId {
						comment = row
					}
				}
				if comment == nil {
					return errResourceNotFound
				}
				// A site-wide native admin is not an ordinary pull-unit writer.
				var caller struct {
					User
					SiteAdmin *bool `json:"is_admin"`
				}
				if _, e = s.forge(ctx, http.MethodGet, "/user", token, nil, &caller); e != nil {
					return e
				}
				if caller.ID != actor.ID || caller.SiteAdmin == nil {
					return errInvalidForgeResponse
				}
				writer := false
				if *caller.SiteAdmin {
					access, e := s.readRepositoryAccess(ctx, token, keyFrom(m.Target.Repository), actor)
					if e != nil && !mergeReadUnavailable(e) {
						return e
					}
					writer = e == nil && access.CanManage
				} else {
					writer, e = s.milestoneEditAuthority(context.WithValue(ctx, pullDiscussionKey{}, true), token, base, repo)
					if e != nil && !mergeReadUnavailable(e) {
						return e
					}
				}
				allowed := enabled && comment.User != nil && (comment.User.Id == strconv.FormatInt(actor.ID, 10) || writer)
				out.CanEditComment = allowed
				out.CanDeleteComment = allowed
			}
		} else {
			out.CanCreate = enabled && pull.State == "open" && !*pull.Merged && !*pull.Draft
		}
		out.SnapshotRevision = resourceHash(struct {
			Review   *golfv1.PullRequestReview
			Comments []*golfv1.PullRequestReviewComment
			Actor    int64
		}{out.Review, out.Comments, actor.ID})
		if selected != nil {
			again, e := s.getPullRequestReviewComments(ctx, session, token, &golfv1.GetPullRequestReviewCommentsRequest{Repository: m.Target.Repository, RepositoryId: m.Target.RepositoryId, PullRequestId: m.Target.PullRequestId, Number: m.Target.Number, ReviewId: strconv.FormatInt(selected.ID, 10), ReviewCommitId: selected.CommitID})
			if e != nil {
				return e
			}
			if !proto.Equal(again.Review, out.Review) || !reflect.DeepEqual(again.Comments, out.Comments) {
				return errPullSnapshotChanged
			}
		}
		after, e := s.readPull(ctx, token, base, repo, m.Target.Number)
		if e != nil {
			return e
		}
		if pullRevision(after) != out.PullRevision {
			return errPullSnapshotChanged
		}
		snap = reviewAuthoringSnapshot{out, pull, repo, base, actor}
		return nil
	})
	return snap, e
}
func (s *Server) GetPullReviewAuthoringState(ctx context.Context, req *connect.Request[golfv1.GetPullReviewAuthoringStateRequest]) (*connect.Response[golfv1.GetPullReviewAuthoringStateResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	snap, e := s.authoringState(ctx, session, token, req.Msg)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(snap.wire), nil
}
func reviewChildrenRevision(rows []*golfv1.PullRequestReviewComment) string {
	copy := append([]*golfv1.PullRequestReviewComment(nil), rows...)
	sort.Slice(copy, func(i, j int) bool { return mustDiscussionID(copy[i].Id) < mustDiscussionID(copy[j].Id) })
	return resourceHash(copy)
}
func (s *Server) authoringPrivateSource(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitPullReviewAuthoringOperationRequest) (*golfv1.PullReviewDraft, reviewerPublicationInput, reviewComparison, error) {
	scope, e := reviewDraftTarget(m.Target)
	if e != nil {
		return nil, reviewerPublicationInput{}, reviewComparison{}, e
	}
	var draft *golfv1.PullReviewDraft
	e = s.withReviewDraftAuthority(ctx, session, token, m.Target, scope, func(_ string, _ Repository, _ forgePull) error {
		read := func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			r, e := s.getReviewDraftState(ctx, q, caller.UserID, m.Target, scope, m.GolfDraftId, "")
			if e != nil {
				return e
			}
			if r.Deleted || r.Draft == nil || r.CurrentVersion != m.ExpectedDraftVersion || r.TargetGeneration != m.ExpectedTargetGeneration {
				return errReviewDraftConflict
			}
			draft = r.Draft
			return nil
		}
		if held, ok := ctx.Value(repositoryLifecycleTransactionKey{}).(repositoryLifecycleTransaction); ok && held.tx != nil {
			q := database.New(s.db).WithTx(held.tx)
			hash, err := s.authSessionHash(ctx, session, q)
			if err != nil {
				return err
			}
			identity, err := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: s.config.GiteaURL})
			if err != nil {
				return err
			}
			caller, err := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: hash, UserID: identity.ID, ForgeURL: s.config.GiteaURL})
			if err != nil {
				return err
			}
			return read(q, caller, hash)
		}
		return s.withManagedSession(ctx, session, token, read)
	})
	if e != nil {
		return nil, reviewerPublicationInput{}, reviewComparison{}, e
	}
	input, c, e := authoringInlinePayload(draft)
	return draft, input, c, e
}

// Pending is not an approval decision and permits an empty summary. Reuse the
// qualified coordinate/transport checks without implicitly rejecting a draft
// that will later be published as an approval.
func authoringInlinePayload(draft *golfv1.PullReviewDraft) (reviewerPublicationInput, reviewComparison, error) {
	input, c, e := inlinePayload(draft, "APPROVED")
	input.Event = "PENDING"
	return input, c, e
}
