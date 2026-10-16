package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const reviewCommentContract = "golf.pull.review-comment-interaction.v1"

func validateReviewComment(m *golfv1.SubmitPullReviewCommentInteractionRequest) error {
	if e := reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return e
	}
	if _, e := discussionID(m.ReviewId); e != nil {
		return e
	}
	if _, e := discussionID(m.CommentId); e != nil {
		return e
	}
	if !objectID.MatchString(m.ReviewCommitId) || !creationKey.MatchString(m.OperationId) || !issueRevisionPattern.MatchString(m.ExpectedPullRevision) || !issueRevisionPattern.MatchString(m.ExpectedCommentRevision) {
		return invalid("Select the visible review, comment and original revisions.")
	}
	if m.ReplyBodyHash != "" && (!issueRevisionPattern.MatchString(m.ReplyBodyHash) || m.Resolve || m.ReplyBody != "" && (!discussionText(m.ReplyBody, 1000) || strings.TrimSpace(m.ReplyBody) == "" || replyBodyHash(m.ReplyBody) != m.ReplyBodyHash)) {
		return invalid("Use an exact bounded reply body and fingerprint.")
	}
	if m.ReplyBodyHash == "" && m.ReplyBody != "" {
		return invalid("A reply requires its body fingerprint.")
	}
	return nil
}
func replyBodyHash(body string) string {
	h := sha256.Sum256([]byte(body))
	return fmt.Sprintf("%x", h[:])
}
func reviewCommentBytes(m *golfv1.SubmitPullReviewCommentInteractionRequest) []byte {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(reviewCommentRetained(m))
	return b
}
func reviewCommentRetained(m *golfv1.SubmitPullReviewCommentInteractionRequest) *golfv1.SubmitPullReviewCommentInteractionRequest {
	c := proto.Clone(m).(*golfv1.SubmitPullReviewCommentInteractionRequest)
	c.ReplyBody = ""
	return c
}
func reviewCommentFingerprint(m *golfv1.SubmitPullReviewCommentInteractionRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitPullReviewCommentInteractionRequest)
	c.OperationId = ""
	h := sha256.Sum256(reviewCommentBytes(c))
	return h[:]
}

// Published-parent visibility is independently checked before native known-ID
// resolution routes; native write permission alone does not protect hidden drafts.
func (s *Server) reviewCommentSnapshot(ctx context.Context, session string, token forgeCredential, m *golfv1.GetPullReviewCommentStateRequest) (*golfv1.GetPullReviewCommentStateResponse, error) {
	if e := reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return nil, e
	}
	if _, e := discussionID(m.CommentId); e != nil {
		return nil, e
	}
	visible, e := s.getPullRequestReviewComments(ctx, session, token, &golfv1.GetPullRequestReviewCommentsRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, ReviewId: m.ReviewId, ReviewCommitId: m.ReviewCommitId})
	if e != nil {
		return nil, e
	}
	if visible.Review == nil || visible.Review.State == golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_PENDING {
		return nil, errResourceNotFound
	}
	var comment *golfv1.PullRequestReviewComment
	for _, row := range visible.Comments {
		if row.Id == m.CommentId {
			comment = row
		}
	}
	if comment == nil {
		return nil, errResourceNotFound
	}
	var out *golfv1.GetPullReviewCommentStateResponse
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		if strconv.FormatInt(repo.ID, 10) != m.RepositoryId {
			return errIssueTargetChanged
		}
		pull, e := s.readPull(ctx, token, base, repo, m.Number)
		if e != nil {
			return e
		}
		if strconv.FormatInt(pull.ID, 10) != m.PullRequestId {
			return errIssueTargetChanged
		}
		var caller struct {
			User
			SiteAdmin *bool `json:"is_admin"`
		}
		if _, e = s.forge(ctx, http.MethodGet, "/user", token, nil, &caller); e != nil {
			return e
		}
		if caller.ID <= 0 || caller.SiteAdmin == nil {
			return errInvalidForgeResponse
		}
		enabled, e := s.activeDiscussionUnit(ctx, token, base, repo, true)
		if e != nil {
			return e
		}
		manage := false
		if enabled && pull.State == "open" && !*pull.Merged {
			manage = pull.User != nil && pull.User.ID == caller.ID
			if !manage && *caller.SiteAdmin {
				access, e := s.readRepositoryAccess(ctx, token, keyFrom(m.Repository), caller.User)
				if e != nil {
					return e
				}
				manage = access.CanManage
			} else if !manage {
				manage, e = s.milestoneEditAuthority(context.WithValue(ctx, pullDiscussionKey{}, true), token, base, repo)
				if e != nil {
					return e
				}
			}
		}
		out = &golfv1.GetPullReviewCommentStateResponse{RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, PullRevision: pullRevision(pull), CommentRevision: accessRevision(comment), Comment: comment, CanManage: manage, CanReply: manage && len(visible.Comments) < maxPullReviewComments}
		return nil
	})
	if e != nil {
		return nil, e
	}
	after, e := s.getPullRequestReviewComments(ctx, session, token, &golfv1.GetPullRequestReviewCommentsRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, ReviewId: m.ReviewId, ReviewCommitId: m.ReviewCommitId})
	if e != nil {
		return nil, e
	}
	if !proto.Equal(visible.Review, after.Review) || !reflect.DeepEqual(visible.Comments, after.Comments) {
		return nil, errPullSnapshotChanged
	}
	return out, nil
}
func (s *Server) GetPullReviewCommentState(ctx context.Context, req *connect.Request[golfv1.GetPullReviewCommentStateRequest]) (*connect.Response[golfv1.GetPullReviewCommentStateResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	snap, e := s.reviewCommentSnapshot(ctx, session, token, req.Msg)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(snap), nil
}
func resolutionSelection(m *golfv1.SubmitPullReviewCommentInteractionRequest) *golfv1.GetPullReviewCommentStateRequest {
	return &golfv1.GetPullReviewCommentStateRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, ReviewId: m.ReviewId, ReviewCommitId: m.ReviewCommitId, CommentId: m.CommentId}
}
func (s *Server) reviewCommentPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitPullReviewCommentInteractionRequest) error {
	snap, e := s.reviewCommentSnapshot(ctx, session, token, resolutionSelection(m))
	if e != nil {
		return e
	}
	if !snap.CanManage || m.ReplyBodyHash != "" && !snap.CanReply {
		return errResourceNotFound
	}
	if snap.PullRevision != m.ExpectedPullRevision || snap.CommentRevision != m.ExpectedCommentRevision || m.ReplyBodyHash == "" && snap.Comment.Resolved == m.Resolve {
		return errPullSnapshotChanged
	}
	return nil
}

type reviewCommentRecord struct {
	ID, UserID, ActorID, RepositoryID, ReplyID int64
	ForgeURL, OperationID, Phase, Failure      string
	Original, Fingerprint                      []byte
	Created, Updated                           time.Time
}

const reviewCommentColumns = `id,user_id,actor_id,repository_id,forge_url,operation_id,phase,failure_code,original,input_fingerprint,created_at,updated_at,observed_reply_id`

func scanReviewComment(row interface{ Scan(...any) error }) (r reviewCommentRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ActorID, &r.RepositoryID, &r.ForgeURL, &r.OperationID, &r.Phase, &r.Failure, &r.Original, &r.Fingerprint, &r.Created, &r.Updated, &r.ReplyID)
	return
}
func reviewCommentOriginal(r reviewCommentRecord) (*golfv1.SubmitPullReviewCommentInteractionRequest, error) {
	m := new(golfv1.SubmitPullReviewCommentInteractionRequest)
	if proto.Unmarshal(r.Original, m) != nil || validateReviewComment(m) != nil || m.OperationId != r.OperationID || m.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || !bytes.Equal(reviewCommentFingerprint(m), r.Fingerprint) {
		return nil, errStorageUnavailable
	}
	if r.ReplyID < 0 || m.ReplyBodyHash == "" && r.ReplyID != 0 || r.Phase == "SUCCEEDED" && m.ReplyBodyHash != "" && r.ReplyID == 0 {
		return nil, errStorageUnavailable
	}
	return m, nil
}
func reviewCommentWire(r reviewCommentRecord) (*golfv1.PullReviewCommentOperation, error) {
	m, e := reviewCommentOriginal(r)
	if e != nil {
		return nil, e
	}
	return &golfv1.PullReviewCommentOperation{Contract: reviewCommentContract, Original: m, ActorId: strconv.FormatInt(r.ActorID, 10), Phase: golfv1.DiscussionResourceOperationPhase(golfv1.DiscussionResourceOperationPhase_value["DISCUSSION_RESOURCE_OPERATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano), ReplyId: wireReplyID(r.ReplyID)}, nil
}
func wireReplyID(id int64) string {
	if id > 0 {
		return strconv.FormatInt(id, 10)
	}
	return ""
}
func (s *Server) lockReviewComment(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_review_comment_lock($1,$2)`, s.config.ForgeURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.ForgeURL, id, tx}), nil
}
func (s *Server) advanceReviewComment(ctx context.Context, session string, token forgeCredential, r reviewCommentRecord, phase string) (reviewCommentRecord, error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	var updated reviewCommentRecord
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		held, e := s.lockReviewComment(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanReviewComment(tx.QueryRowContext(held, `UPDATE golf_pull_review_comment_operations SET phase=$1,failure_code=$2,observed_reply_id=$7 WHERE id=$3 AND user_id=$4 AND forge_url=$5 AND phase=$6 RETURNING `+reviewCommentColumns, phase, failure, r.ID, r.UserID, r.ForgeURL, r.Phase, r.ReplyID))
		return e
	})
	return updated, e
}

type reviewCommentPermitKey struct{}
type reviewCommentPermit struct{ record reviewCommentRecord }

func (s *Server) validateReviewCommentPermit(ctx context.Context, tx *sql.Tx, p reviewCommentPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	m, e := reviewCommentOriginal(r)
	if e != nil {
		return e
	}
	base, _ := repositoryPath(key)
	want := "POST"
	if tx == nil || repo.ID != r.RepositoryID || key != keyFrom(m.Repository) || method != want || path != resolutionRoute(base, m) {
		return errLifecycleBlocked
	}
	a, _ := json.Marshal(input)
	b, _ := json.Marshal(reviewCommentPayload(m, ""))
	if m.ReplyBodyHash != "" {
		payload, ok := input.(map[string]string)
		if !ok || len(payload) != 1 || replyBodyHash(payload["body"]) != m.ReplyBodyHash {
			return errLifecycleBlocked
		}
		b = a
	}
	if !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	stored, e := scanReviewComment(tx.QueryRowContext(ctx, `SELECT `+reviewCommentColumns+` FROM golf_pull_review_comment_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || stored.ActorID != r.ActorID || !bytes.Equal(stored.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_review_comment($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) GetPullReviewCommentOperation(ctx context.Context, req *connect.Request[golfv1.GetPullReviewCommentOperationRequest]) (*connect.Response[golfv1.GetPullReviewCommentOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return nil, rpcError(e)
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original operation."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r reviewCommentRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanReviewComment(s.db.QueryRowContext(ctx, `SELECT `+reviewCommentColumns+` FROM golf_pull_review_comment_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	original, e := reviewCommentOriginal(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !proto.Equal(original.Repository, m.Repository) || original.RepositoryId != m.RepositoryId || original.PullRequestId != m.PullRequestId || original.Number != m.Number {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	snap, e := s.reviewCommentSnapshot(ctx, session, token, resolutionSelection(original))
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !snap.CanManage {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	wire, e := reviewCommentWire(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetPullReviewCommentOperationResponse{Operation: wire}), nil
}
func (s *Server) SubmitPullReviewCommentInteraction(ctx context.Context, req *connect.Request[golfv1.SubmitPullReviewCommentInteractionRequest]) (*connect.Response[golfv1.SubmitPullReviewCommentInteractionResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateReviewComment(m); e != nil {
		return nil, rpcError(e)
	}
	if m.ReplyBodyHash != "" && m.ReplyBody == "" {
		return nil, rpcError(invalid("A new reply requires its bounded body."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	snap, e := s.reviewCommentSnapshot(ctx, session, token, resolutionSelection(m))
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !snap.CanManage || m.ReplyBodyHash != "" && !snap.CanReply {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	repoID, _ := discussionID(m.RepositoryId)
	fingerprint := reviewCommentFingerprint(m)
	var r reviewCommentRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockReviewComment(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanReviewComment(tx.QueryRowContext(held, `SELECT `+reviewCommentColumns+` FROM golf_pull_review_comment_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(fingerprint, r.Fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanReviewComment(tx.QueryRowContext(held, `INSERT INTO golf_pull_review_comment_operations(user_id,forge_url,actor_id,operation_id,repository_id,original,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+reviewCommentColumns, c.UserID, s.config.ForgeURL, actor.ID, m.OperationId, repoID, reviewCommentBytes(m), fingerprint))
		fresh = e == nil
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if e = s.reviewCommentPreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceReviewComment(ctx, session, token, r, "REJECTED")
		} else {
			r, e = s.advanceReviewComment(ctx, session, token, r, "DISPATCH_UNKNOWN")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockReviewComment(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.reviewCommentPreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, reviewCommentPermitKey{}, reviewCommentPermit{r})
				base, _ := repositoryPath(keyFrom(m.Repository))
				if m.ReplyBodyHash != "" {
					var reply forgePullReviewComment
					_, nativeErr = s.forgeJSON(held, http.MethodPost, resolutionRoute(base, m), token, reviewCommentPayload(m, m.ReplyBody), &reply, http.StatusCreated)
					if nativeErr == nil {
						current, e := s.getPullRequestReviewComments(held, session, token, &golfv1.GetPullRequestReviewCommentsRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, ReviewId: m.ReviewId, ReviewCommitId: m.ReviewCommitId})
						nativeErr = e
						if e == nil {
							found := false
							for _, child := range current.Comments {
								if child.Id == strconv.FormatInt(reply.ID, 10) && child.ReviewId == m.ReviewId && child.User != nil && child.User.Id == strconv.FormatInt(actor.ID, 10) && replyBodyHash(child.Body) == m.ReplyBodyHash && child.Path == snap.Comment.Path && child.OldLine == snap.Comment.OldLine && child.NewLine == snap.Comment.NewLine {
									found = true
								}
							}
							if !found || reply.ID <= 0 || reply.User == nil || reply.User.ID != actor.ID || reply.ReviewID != mustDiscussionID(m.ReviewId) || replyBodyHash(reply.Body) != m.ReplyBodyHash {
								nativeErr = errPullSnapshotChanged
							} else {
								r.ReplyID = reply.ID
							}
						}
					}
				} else {
					_, nativeErr = s.forgeJSON(held, http.MethodPost, resolutionRoute(base, m), token, nil, nil, http.StatusNoContent)
					if nativeErr == nil {
						current, e := s.reviewCommentSnapshot(held, session, token, resolutionSelection(m))
						nativeErr = e
						if e == nil && (current.Comment.Resolved != m.Resolve || !current.CanManage || m.Resolve && (current.Comment.Resolver == nil || current.Comment.Resolver.Id != strconv.FormatInt(actor.ID, 10))) {
							nativeErr = errPullSnapshotChanged
						}
					}
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				r, e = s.advanceReviewComment(ctx, session, token, r, "SUCCEEDED")
			}
		}
		if e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	status := connect.NewRequest(&golfv1.GetPullReviewCommentOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, OperationId: m.OperationId})
	status.Header().Set("Cookie", req.Header().Get("Cookie"))
	status.Header().Set("Origin", req.Header().Get("Origin"))
	out, e := s.GetPullReviewCommentOperation(ctx, status)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitPullReviewCommentInteractionResponse{Operation: out.Msg.Operation}), nil
}

func resolutionRoute(base string, m *golfv1.SubmitPullReviewCommentInteractionRequest) string {
	if m.ReplyBodyHash != "" {
		return base + "/pulls/" + strconv.FormatUint(uint64(m.Number), 10) + "/comments/" + m.CommentId + "/replies"
	}
	suffix := "unresolve"
	if m.Resolve {
		suffix = "resolve"
	}
	return base + "/pulls/comments/" + m.CommentId + "/" + suffix
}

func mustDiscussionID(value string) int64 { id, _ := discussionID(value); return id }
func reviewCommentPayload(m *golfv1.SubmitPullReviewCommentInteractionRequest, body string) any {
	if m.ReplyBodyHash != "" {
		return map[string]string{"body": body}
	}
	return nil
}
