package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
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

const reviewLifecycleContract = "golf.pull.review-lifecycle.v1"

func validateReviewLifecycle(m *golfv1.SubmitPullReviewLifecycleRequest) error {
	if e := reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return e
	}
	if _, e := discussionID(m.ReviewId); e != nil {
		return e
	}
	if !objectID.MatchString(m.ReviewCommitId) || !creationKey.MatchString(m.OperationId) || !issueRevisionPattern.MatchString(m.ExpectedPullRevision) || !issueRevisionPattern.MatchString(m.ExpectedReviewRevision) {
		return invalid("Select the published review and original revisions.")
	}
	if m.Dismiss {
		if !issueRevisionPattern.MatchString(m.ReasonHash) || m.Reason != "" && (!discussionText(m.Reason, 1000) || strings.TrimSpace(m.Reason) == "" || replyBodyHash(m.Reason) != m.ReasonHash) {
			return invalid("Use an exact bounded dismissal reason.")
		}
	} else if m.Reason != "" || m.ReasonHash != "" {
		return invalid("Restoring a review cannot change its dismissal reason.")
	}
	return nil
}
func reviewLifecycleRetained(m *golfv1.SubmitPullReviewLifecycleRequest) *golfv1.SubmitPullReviewLifecycleRequest {
	c := proto.Clone(m).(*golfv1.SubmitPullReviewLifecycleRequest)
	c.Reason = ""
	return c
}
func reviewLifecycleBytes(m *golfv1.SubmitPullReviewLifecycleRequest) []byte {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(reviewLifecycleRetained(m))
	return b
}
func reviewLifecycleFingerprint(m *golfv1.SubmitPullReviewLifecycleRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitPullReviewLifecycleRequest)
	c.OperationId = ""
	h := sha256.Sum256(reviewLifecycleBytes(c))
	return h[:]
}

func (s *Server) readLifecycleReview(ctx context.Context, token forgeCredential, base string, pull forgePull, m *golfv1.GetPullReviewLifecycleStateRequest) (forgePullReview, error) {
	var raw json.RawMessage
	if _, e := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatUint(uint64(m.Number), 10)+"/reviews/"+m.ReviewId, token, nil, &raw); e != nil {
		return forgePullReview{}, e
	}
	var fields map[string]json.RawMessage
	var row forgePullReview
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(raw, &row) != nil || len(fields["dismissed"]) == 0 || len(fields["stale"]) == 0 || string(fields["dismissed"]) == "null" || string(fields["stale"]) == "null" {
		return row, errInvalidForgeResponse
	}
	id, _ := discussionID(m.ReviewId)
	if row.ID != id || row.CommitID != m.ReviewCommitId || row.PullRequestURL != pull.HTMLURL || row.User == nil || row.User.ID <= 0 || !validPullUser(row.User) || !validPullTime(row.SubmittedAt) || !validPullTime(row.UpdatedAt) || !discussionText(row.Body, 256<<10) || row.CommentsCount == nil || *row.CommentsCount < 0 {
		return row, errInvalidForgeResponse
	}
	if row.State != "APPROVED" && row.State != "REQUEST_CHANGES" {
		return row, errResourceNotFound
	}
	return row, nil
}
func (s *Server) reviewLifecycleSnapshot(ctx context.Context, session string, token forgeCredential, m *golfv1.GetPullReviewLifecycleStateRequest) (*golfv1.GetPullReviewLifecycleStateResponse, error) {
	if e := reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return nil, e
	}
	if _, e := discussionID(m.ReviewId); e != nil {
		return nil, e
	}
	if !objectID.MatchString(m.ReviewCommitId) {
		return nil, invalid("Select the exact reviewed commit.")
	}
	var out *golfv1.GetPullReviewLifecycleStateResponse
	e := s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		if strconv.FormatInt(repo.ID, 10) != m.RepositoryId {
			return errIssueTargetChanged
		}
		pull, e := s.readPull(ctx, token, base, repo, m.Number)
		if e != nil {
			return e
		}
		if strconv.FormatInt(pull.ID, 10) != m.PullRequestId || pullRevision(pull) == "" {
			return errIssueTargetChanged
		}
		before, e := s.readLifecycleReview(ctx, token, base, pull, m)
		if e != nil {
			return e
		}
		caller, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		access, e := s.readRepositoryAccess(ctx, token, keyFrom(m.Repository), caller)
		if e != nil {
			if !mergeReadUnavailable(e) {
				return e
			}
			access = &golfv1.RepositoryAccess{}
		}
		enabled, e := s.activeDiscussionUnit(ctx, token, base, repo, true)
		if e != nil {
			return e
		}
		manage := enabled && pull.State == "open" && !*pull.Merged && access.CanManage && (access.CurrentPermission == "admin" || access.CurrentPermission == "owner")
		after, e := s.readLifecycleReview(ctx, token, base, pull, m)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(before, after) {
			return errPullSnapshotChanged
		}
		latest, e := s.readPull(ctx, token, base, repo, m.Number)
		if e != nil {
			return e
		}
		if pullRevision(latest) != pullRevision(pull) {
			return errPullSnapshotChanged
		}
		out = &golfv1.GetPullReviewLifecycleStateResponse{RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, PullRevision: pullRevision(pull), ReviewRevision: resourceHash(before), Review: wirePullReview(before), CanManage: manage, CanRestore: manage && before.Dismissed && before.CommitID == pull.Head.SHA && !before.Stale, CurrentHeadCommitId: pull.Head.SHA}
		return nil
	})
	return out, e
}
func (s *Server) GetPullReviewLifecycleState(ctx context.Context, req *connect.Request[golfv1.GetPullReviewLifecycleStateRequest]) (*connect.Response[golfv1.GetPullReviewLifecycleStateResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, e := s.reviewLifecycleSnapshot(ctx, session, token, req.Msg)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(out), nil
}
func reviewLifecycleSelection(m *golfv1.SubmitPullReviewLifecycleRequest) *golfv1.GetPullReviewLifecycleStateRequest {
	return &golfv1.GetPullReviewLifecycleStateRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, ReviewId: m.ReviewId, ReviewCommitId: m.ReviewCommitId}
}
func (s *Server) reviewLifecyclePreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitPullReviewLifecycleRequest) error {
	snap, e := s.reviewLifecycleSnapshot(ctx, session, token, reviewLifecycleSelection(m))
	if e != nil {
		return e
	}
	if !snap.CanManage || !m.Dismiss && !snap.CanRestore {
		return errResourceNotFound
	}
	if snap.PullRevision != m.ExpectedPullRevision || snap.ReviewRevision != m.ExpectedReviewRevision || snap.Review.Dismissed == m.Dismiss {
		return errPullSnapshotChanged
	}
	return nil
}

type reviewLifecycleRecord struct {
	ID, UserID, ActorID, RepositoryID     int64
	ForgeURL, OperationID, Phase, Failure string
	Original, Fingerprint                 []byte
	Created, Updated                      time.Time
}

const reviewLifecycleColumns = `id,user_id,actor_id,repository_id,forge_url,operation_id,phase,failure_code,original,input_fingerprint,created_at,updated_at`

func scanReviewLifecycle(row interface{ Scan(...any) error }) (r reviewLifecycleRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ActorID, &r.RepositoryID, &r.ForgeURL, &r.OperationID, &r.Phase, &r.Failure, &r.Original, &r.Fingerprint, &r.Created, &r.Updated)
	return
}
func reviewLifecycleOriginal(r reviewLifecycleRecord) (*golfv1.SubmitPullReviewLifecycleRequest, error) {
	m := new(golfv1.SubmitPullReviewLifecycleRequest)
	if proto.Unmarshal(r.Original, m) != nil || validateReviewLifecycle(m) != nil || m.OperationId != r.OperationID || m.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || !bytes.Equal(reviewLifecycleFingerprint(m), r.Fingerprint) {
		return nil, errStorageUnavailable
	}
	return m, nil
}
func reviewLifecycleWire(r reviewLifecycleRecord) (*golfv1.PullReviewLifecycleOperation, error) {
	m, e := reviewLifecycleOriginal(r)
	if e != nil {
		return nil, e
	}
	return &golfv1.PullReviewLifecycleOperation{Contract: reviewLifecycleContract, Original: m, ActorId: strconv.FormatInt(r.ActorID, 10), Phase: golfv1.DiscussionResourceOperationPhase(golfv1.DiscussionResourceOperationPhase_value["DISCUSSION_RESOURCE_OPERATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}, nil
}
func (s *Server) lockReviewLifecycle(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_review_lifecycle_lock($1,$2)`, s.config.GiteaURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, id, tx}), nil
}
func (s *Server) advanceReviewLifecycle(ctx context.Context, session string, token forgeCredential, r reviewLifecycleRecord, phase string) (reviewLifecycleRecord, error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	var updated reviewLifecycleRecord
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		held, e := s.lockReviewLifecycle(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanReviewLifecycle(tx.QueryRowContext(held, `UPDATE golf_pull_review_lifecycle_operations SET phase=$1,failure_code=$2 WHERE id=$3 AND user_id=$4 AND forge_url=$5 AND phase=$6 RETURNING `+reviewLifecycleColumns, phase, failure, r.ID, r.UserID, r.ForgeURL, r.Phase))
		return e
	})
	return updated, e
}

type reviewLifecyclePermitKey struct{}
type reviewLifecyclePermit struct{ record reviewLifecycleRecord }

func (s *Server) validateReviewLifecyclePermit(ctx context.Context, tx *sql.Tx, p reviewLifecyclePermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	m, e := reviewLifecycleOriginal(r)
	if e != nil {
		return e
	}
	base, _ := repositoryPath(key)
	want := "POST"
	if tx == nil || repo.ID != r.RepositoryID || key != keyFrom(m.Repository) || method != want || path != reviewLifecycleRoute(base, m) {
		return errLifecycleBlocked
	}
	a, _ := json.Marshal(input)
	b, _ := json.Marshal(nil)
	if m.Dismiss {
		payload, ok := input.(map[string]any)
		if !ok || len(payload) != 2 || payload["priors"] != false {
			return errLifecycleBlocked
		}
		reason, ok := payload["message"].(string)
		if !ok || replyBodyHash(reason) != m.ReasonHash {
			return errLifecycleBlocked
		}
		b = a
	}
	if !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	stored, e := scanReviewLifecycle(tx.QueryRowContext(ctx, `SELECT `+reviewLifecycleColumns+` FROM golf_pull_review_lifecycle_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || stored.ActorID != r.ActorID || !bytes.Equal(stored.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_review_lifecycle($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) GetPullReviewLifecycleOperation(ctx context.Context, req *connect.Request[golfv1.GetPullReviewLifecycleOperationRequest]) (*connect.Response[golfv1.GetPullReviewLifecycleOperationResponse], error) {
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
	var r reviewLifecycleRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanReviewLifecycle(s.db.QueryRowContext(ctx, `SELECT `+reviewLifecycleColumns+` FROM golf_pull_review_lifecycle_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	original, e := reviewLifecycleOriginal(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !proto.Equal(original.Repository, m.Repository) || original.RepositoryId != m.RepositoryId || original.PullRequestId != m.PullRequestId || original.Number != m.Number {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	snap, e := s.reviewLifecycleSnapshot(ctx, session, token, reviewLifecycleSelection(original))
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !snap.CanManage {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	wire, e := reviewLifecycleWire(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetPullReviewLifecycleOperationResponse{Operation: wire}), nil
}
func (s *Server) SubmitPullReviewLifecycle(ctx context.Context, req *connect.Request[golfv1.SubmitPullReviewLifecycleRequest]) (*connect.Response[golfv1.SubmitPullReviewLifecycleResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateReviewLifecycle(m); e != nil {
		return nil, rpcError(e)
	}
	if m.Dismiss && m.Reason == "" {
		return nil, rpcError(invalid("A new dismissal requires its reason."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	snap, e := s.reviewLifecycleSnapshot(ctx, session, token, reviewLifecycleSelection(m))
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !snap.CanManage {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	repoID, _ := discussionID(m.RepositoryId)
	fingerprint := reviewLifecycleFingerprint(m)
	var r reviewLifecycleRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockReviewLifecycle(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanReviewLifecycle(tx.QueryRowContext(held, `SELECT `+reviewLifecycleColumns+` FROM golf_pull_review_lifecycle_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(fingerprint, r.Fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanReviewLifecycle(tx.QueryRowContext(held, `INSERT INTO golf_pull_review_lifecycle_operations(user_id,forge_url,actor_id,operation_id,repository_id,original,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+reviewLifecycleColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, repoID, reviewLifecycleBytes(m), fingerprint))
		fresh = e == nil
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if e = s.reviewLifecyclePreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceReviewLifecycle(ctx, session, token, r, "REJECTED")
		} else {
			r, e = s.advanceReviewLifecycle(ctx, session, token, r, "DISPATCH_UNKNOWN")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockReviewLifecycle(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.reviewLifecyclePreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, reviewLifecyclePermitKey{}, reviewLifecyclePermit{r})
				base, _ := repositoryPath(keyFrom(m.Repository))
				var output forgePullReview
				_, nativeErr = s.forgeJSON(held, http.MethodPost, reviewLifecycleRoute(base, m), token, reviewLifecyclePayload(m), &output, http.StatusOK)
				if nativeErr == nil {
					current, e := s.reviewLifecycleSnapshot(held, session, token, reviewLifecycleSelection(m))
					nativeErr = e
					if e == nil && (output.ID != mustDiscussionID(m.ReviewId) || output.CommitID != m.ReviewCommitId || output.Dismissed != m.Dismiss || current.Review.Dismissed != m.Dismiss || !current.CanManage || output.User == nil || current.Review.User == nil || strconv.FormatInt(output.User.ID, 10) != current.Review.User.Id || output.State != nativeReviewState(current.Review.State) || output.Body != current.Review.Body) {
						nativeErr = errPullSnapshotChanged
					}
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				r, e = s.advanceReviewLifecycle(ctx, session, token, r, "SUCCEEDED")
			}
		}
		if e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	status := connect.NewRequest(&golfv1.GetPullReviewLifecycleOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, OperationId: m.OperationId})
	status.Header().Set("Cookie", req.Header().Get("Cookie"))
	status.Header().Set("Origin", req.Header().Get("Origin"))
	out, e := s.GetPullReviewLifecycleOperation(ctx, status)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitPullReviewLifecycleResponse{Operation: out.Msg.Operation}), nil
}

func reviewLifecycleRoute(base string, m *golfv1.SubmitPullReviewLifecycleRequest) string {
	suffix := "undismissals"
	if m.Dismiss {
		suffix = "dismissals"
	}
	return base + "/pulls/" + strconv.FormatUint(uint64(m.Number), 10) + "/reviews/" + m.ReviewId + "/" + suffix
}
func reviewLifecyclePayload(m *golfv1.SubmitPullReviewLifecycleRequest) any {
	if m.Dismiss {
		return map[string]any{"message": m.Reason, "priors": false}
	}
	return nil
}
func nativeReviewState(state golfv1.PullRequestReviewState) string {
	switch state {
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED:
		return "APPROVED"
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES:
		return "REQUEST_CHANGES"
	}
	return ""
}
