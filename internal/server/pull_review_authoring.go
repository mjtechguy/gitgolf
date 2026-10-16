package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const reviewAuthoringContract = "golf.pull.review-authoring.v1"
const (
	authorCreate  = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_CREATE_DRAFT
	authorPrivate = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_CREATE_FROM_PRIVATE_DRAFT
	authorUpdate  = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_UPDATE_DRAFT
	authorSubmit  = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_SUBMIT_DRAFT
	authorDiscard = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_DISCARD_DRAFT
	authorEdit    = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_EDIT_COMMENT
	authorDelete  = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_DELETE_COMMENT
	authorAppend  = golfv1.PullReviewAuthoringKind_PULL_REVIEW_AUTHORING_KIND_APPEND_FROM_PRIVATE_DRAFT
)

func validateReviewAuthoring(m *golfv1.SubmitPullReviewAuthoringOperationRequest) error {
	if _, e := reviewDraftTarget(m.Target); e != nil {
		return e
	}
	if !creationKey.MatchString(m.OperationId) || !issueRevisionPattern.MatchString(m.ExpectedPullRevision) || !issueRevisionPattern.MatchString(m.ExpectedSnapshotRevision) {
		return invalid("Select original review revisions and operation.")
	}
	if m.Kind < authorCreate || m.Kind > authorAppend {
		return invalid("Select a supported review operation.")
	}
	create := m.Kind == authorCreate || m.Kind == authorPrivate
	if create {
		if m.ReviewId != "" || m.ReviewCommitId != "" || m.CommentId != "" {
			return invalid("Creating a pending review cannot adopt an existing review.")
		}
	} else if _, e := discussionID(m.ReviewId); e != nil || !objectID.MatchString(m.ReviewCommitId) {
		return invalid("Select the exact review and commit.")
	}
	if m.Kind == authorEdit || m.Kind == authorDelete {
		if _, e := discussionID(m.CommentId); e != nil {
			return e
		}
	} else if m.CommentId != "" {
		return invalid("This operation does not select a comment.")
	}
	body := m.Kind == authorCreate || m.Kind == authorUpdate || m.Kind == authorSubmit || m.Kind == authorEdit
	if body {
		if !issueRevisionPattern.MatchString(m.BodyHash) || m.Body != "" && (!discussionText(m.Body, 6000) || replyBodyHash(m.Body) != m.BodyHash) {
			return invalid("Use an exact bounded review body.")
		}
	} else if m.Body != "" || m.BodyHash != "" {
		return invalid("This operation cannot carry a new body.")
	}
	if m.Kind == authorSubmit {
		if inlineDecision(m.Decision) == "" {
			return invalid("Select comment, approval or request changes.")
		}
	} else if m.Decision != 0 {
		return invalid("Only submission selects a decision.")
	}
	if m.Kind == authorPrivate || m.Kind == authorAppend {
		if reviewDraftUUID(m.GolfDraftId) != nil {
			return invalid("Select the saved private draft.")
		}
		if _, e := reviewDraftCounter(m.ExpectedDraftVersion, false); e != nil {
			return e
		}
		if _, e := reviewDraftCounter(m.ExpectedTargetGeneration, false); e != nil {
			return e
		}
	} else if m.GolfDraftId != "" || m.ExpectedDraftVersion != "" || m.ExpectedTargetGeneration != "" {
		return invalid("Only private-draft transfer selects a saved version.")
	}
	return nil
}
func reviewAuthoringRetained(m *golfv1.SubmitPullReviewAuthoringOperationRequest) *golfv1.SubmitPullReviewAuthoringOperationRequest {
	c := proto.Clone(m).(*golfv1.SubmitPullReviewAuthoringOperationRequest)
	c.Body = ""
	return c
}
func reviewAuthoringBytes(m *golfv1.SubmitPullReviewAuthoringOperationRequest) []byte {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(reviewAuthoringRetained(m))
	return b
}
func reviewAuthoringFingerprint(m *golfv1.SubmitPullReviewAuthoringOperationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitPullReviewAuthoringOperationRequest)
	c.OperationId = ""
	h := sha256.Sum256(reviewAuthoringBytes(c))
	return h[:]
}

type reviewAuthoringRecord struct {
	ID, UserID, ActorID, RepositoryID, ObservedReviewID int64
	ForgeURL, OperationID, Phase, Failure               string
	Original, Fingerprint                               []byte
	Created, Updated                                    time.Time
}

const reviewAuthoringColumns = `id,user_id,actor_id,repository_id,observed_review_id,forge_url,operation_id,phase,failure_code,original,input_fingerprint,created_at,updated_at`

func scanReviewAuthoring(row interface{ Scan(...any) error }) (r reviewAuthoringRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ActorID, &r.RepositoryID, &r.ObservedReviewID, &r.ForgeURL, &r.OperationID, &r.Phase, &r.Failure, &r.Original, &r.Fingerprint, &r.Created, &r.Updated)
	return
}
func reviewAuthoringOriginal(r reviewAuthoringRecord) (*golfv1.SubmitPullReviewAuthoringOperationRequest, error) {
	m := new(golfv1.SubmitPullReviewAuthoringOperationRequest)
	if proto.Unmarshal(r.Original, m) != nil || validateReviewAuthoring(m) != nil || m.Body != "" || m.OperationId != r.OperationID || m.Target.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || !bytes.Equal(reviewAuthoringFingerprint(m), r.Fingerprint) {
		return nil, errStorageUnavailable
	}
	return m, nil
}
func reviewAuthoringWire(r reviewAuthoringRecord) (*golfv1.PullReviewAuthoringOperation, error) {
	m, e := reviewAuthoringOriginal(r)
	if e != nil {
		return nil, e
	}
	w := &golfv1.PullReviewAuthoringOperation{Contract: reviewAuthoringContract, Original: m, ActorId: strconv.FormatInt(r.ActorID, 10), Phase: golfv1.DiscussionResourceOperationPhase(golfv1.DiscussionResourceOperationPhase_value["DISCUSSION_RESOURCE_OPERATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
	if r.ObservedReviewID > 0 {
		w.ObservedReviewId = strconv.FormatInt(r.ObservedReviewID, 10)
	}
	return w, nil
}
func (s *Server) lockReviewAuthoring(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_review_authoring_lock($1,$2)`, s.config.ForgeURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	if e := s.protectionDispatchAllowed(ctx, tx, id); e != nil {
		return nil, e
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.ForgeURL, id, tx}), nil
}
func (s *Server) advanceReviewAuthoring(ctx context.Context, session string, token forgeCredential, r reviewAuthoringRecord, phase string, observed, recipient int64) (reviewAuthoringRecord, error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	var out reviewAuthoringRecord
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		held, e := s.lockReviewAuthoring(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		out, e = scanReviewAuthoring(tx.QueryRowContext(held, `UPDATE golf_pull_review_authoring_operations SET phase=$1,failure_code=$2,observed_review_id=$3 WHERE id=$4 AND user_id=$5 AND forge_url=$6 AND phase=$7 RETURNING `+reviewAuthoringColumns, phase, failure, observed, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return e
		}
		if phase == "SUCCEEDED" {
			if recipient != 0 && recipient != r.UserID {
				return errStorageUnavailable
			}
			_, e = tx.ExecContext(held, `SELECT golf_append_repository_activity($1,$2,$3,'pulls')`, r.ForgeURL, r.RepositoryID, recipient)
		}
		return e
	})
	return out, e
}

func authoringRoute(base string, m *golfv1.SubmitPullReviewAuthoringOperationRequest) (string, string) {
	route := base + "/pulls/" + strconv.FormatUint(uint64(m.Target.Number), 10) + "/reviews"
	switch m.Kind {
	case authorCreate, authorPrivate, authorUpdate, authorAppend:
		return http.MethodPost, route
	case authorSubmit:
		return http.MethodPost, route + "/" + m.ReviewId
	case authorDiscard:
		return http.MethodDelete, route + "/" + m.ReviewId
	case authorEdit:
		return http.MethodPatch, base + "/issues/comments/" + m.CommentId
	case authorDelete:
		return http.MethodDelete, base + "/issues/comments/" + m.CommentId
	}
	return "", ""
}

type reviewAuthoringPermitKey struct{}
type reviewAuthoringPermit struct {
	record  reviewAuthoringRecord
	payload []byte
}

func (s *Server) validateReviewAuthoringPermit(ctx context.Context, tx *sql.Tx, p reviewAuthoringPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	m, e := reviewAuthoringOriginal(r)
	if e != nil {
		return e
	}
	base, _ := repositoryPath(key)
	want, route := authoringRoute(base, m)
	raw, _ := json.Marshal(input)
	if tx == nil || repo.ID != r.RepositoryID || key != keyFrom(m.Target.Repository) || method != want || path != route || !bytes.Equal(raw, p.payload) {
		return errLifecycleBlocked
	}
	stored, e := scanReviewAuthoring(tx.QueryRowContext(ctx, `SELECT `+reviewAuthoringColumns+` FROM golf_pull_review_authoring_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || stored.ActorID != r.ActorID || !bytes.Equal(stored.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_review_authoring($1,$2) OR EXISTS(SELECT 1 FROM golf_pull_review_authoring_operations WHERE forge_url=$1 AND repository_id=$2 AND id<>$3 AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID, r.ID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}

// Inventory and proposals are stable observations, not a native expected-head CAS.
func (s *Server) authoringPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitPullReviewAuthoringOperationRequest) (reviewAuthoringSnapshot, any, *golfv1.PullReviewDraft, error) {
	snap, e := s.authoringState(ctx, session, token, authoringSelection(m))
	if e != nil {
		return snap, nil, nil, e
	}
	w := snap.wire
	if w.PullRevision != m.ExpectedPullRevision || w.SnapshotRevision != m.ExpectedSnapshotRevision {
		return snap, nil, nil, errPullSnapshotChanged
	}
	switch m.Kind {
	case authorCreate:
		if strings.TrimSpace(m.Body) == "" {
			return snap, nil, nil, invalid("The native pending API requires a nonempty summary.")
		}
		if !w.CanCreate {
			return snap, nil, nil, errResourceNotFound
		}
		return snap, reviewerPublicationInput{Body: m.Body, Head: w.CurrentHeadCommitId, Event: "PENDING", Comments: []reviewerPublicationComment{}}, nil, nil
	case authorPrivate, authorAppend:
		if m.Kind == authorPrivate && !w.CanCreate || m.Kind == authorAppend && (!w.OwnPending || !w.CanSubmit || w.Review == nil || w.Review.Id != m.ReviewId || w.Review.CommitId != m.ReviewCommitId) {
			return snap, nil, nil, errResourceNotFound
		}
		draft, input, _, e := s.authoringPrivateSource(ctx, session, token, m)
		if e != nil {
			return snap, nil, nil, e
		}
		if m.Kind == authorAppend {
			if strings.TrimSpace(w.Review.Body) == "" || !discussionText(w.Review.Body, 6000) {
				return snap, nil, nil, invalid("Append requires a native summary of 1–6000 UTF-8 bytes.")
			}
			if len(w.Comments)+len(input.Comments) > 100 {
				return snap, nil, nil, errForgeResponseTooLarge
			}
			input.Body = w.Review.Body // Append preserves the independently observed native summary.
			// Review activity can advance the PR timestamp. Source/head/base and exact raw diff are still independently revalidated.
			draft = proto.Clone(draft).(*golfv1.PullReviewDraft)
			draft.Comparison.Capture.ExpectedPullRevision = m.ExpectedPullRevision
		}
		scope, _ := reviewDraftTarget(m.Target)
		r := database.GolfInlineReviewMutation{ActorID: snap.actor.ID, ExpectedRevision: m.ExpectedPullRevision, HeadCommit: input.Head, BaseTip: draft.Comparison.Capture.Selection.BaseCommitId, MergeBase: draft.Comparison.Capture.MergeBaseCommitId, Decision: "COMMENT"}
		_, _, _, e = s.inlinePreflight(ctx, session, token, m.Target, scope, r, draft)
		return snap, input, draft, e
	case authorUpdate:
		if strings.TrimSpace(m.Body) == "" {
			return snap, nil, nil, invalid("The native pending API requires a nonempty summary.")
		}
		if !w.CanUpdate {
			return snap, nil, nil, errResourceNotFound
		}
		return snap, reviewerPublicationInput{Body: m.Body, Head: m.ReviewCommitId, Event: "PENDING", Comments: []reviewerPublicationComment{}}, nil, nil
	case authorSubmit:
		if m.Decision != golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED && strings.TrimSpace(m.Body) == "" {
			return snap, nil, nil, invalid("Comments and change requests require a review summary.")
		}
		if !w.CanSubmit || m.Decision != golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT && snap.pull.User != nil && snap.pull.User.ID == snap.actor.ID {
			return snap, nil, nil, errResourceNotFound
		}
		return snap, map[string]any{"event": inlineDecision(m.Decision), "body": m.Body}, nil, nil
	case authorDiscard:
		if !w.CanDiscard {
			return snap, nil, nil, errResourceNotFound
		}
		return snap, nil, nil, nil
	case authorEdit:
		if strings.TrimSpace(m.Body) == "" {
			return snap, nil, nil, invalid("An edited inline comment requires text.")
		}
		if !w.CanEditComment {
			return snap, nil, nil, errResourceNotFound
		}
		return snap, map[string]any{"body": m.Body}, nil, nil
	case authorDelete:
		if !w.CanDeleteComment {
			return snap, nil, nil, errResourceNotFound
		}
		return snap, nil, nil, nil
	}
	return snap, nil, nil, errResourceNotFound
}

func (s *Server) GetPullReviewAuthoringOperation(ctx context.Context, req *connect.Request[golfv1.GetPullReviewAuthoringOperationRequest]) (*connect.Response[golfv1.GetPullReviewAuthoringOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = reviewDraftTarget(m.Target); e != nil {
		return nil, rpcError(e)
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original operation."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r reviewAuthoringRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanReviewAuthoring(s.db.QueryRowContext(ctx, `SELECT `+reviewAuthoringColumns+` FROM golf_pull_review_authoring_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	original, e := reviewAuthoringOriginal(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !proto.Equal(original.Target, m.Target) {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Target.Repository), func(_ string, repo Repository) error {
		actor, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		if actor.ID != r.ActorID || repo.ID != r.RepositoryID {
			return errResourceNotFound
		}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	wire, e := reviewAuthoringWire(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetPullReviewAuthoringOperationResponse{Operation: wire}), nil
}

func (s *Server) SubmitPullReviewAuthoringOperation(ctx context.Context, req *connect.Request[golfv1.SubmitPullReviewAuthoringOperationRequest]) (*connect.Response[golfv1.SubmitPullReviewAuthoringOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateReviewAuthoring(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	scope, _ := reviewDraftTarget(m.Target)
	fp := reviewAuthoringFingerprint(m)
	var r reviewAuthoringRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockReviewAuthoring(ctx, tx, scope.repositoryID)
		if e != nil {
			return e
		}
		r, e = scanReviewAuthoring(tx.QueryRowContext(held, `SELECT `+reviewAuthoringColumns+` FROM golf_pull_review_authoring_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(fp, r.Fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		if m.BodyHash != "" && replyBodyHash(m.Body) != m.BodyHash {
			return invalid("A new operation requires its exact body.")
		}
		if _, _, _, e = s.authoringPreflight(held, session, token, m); e != nil {
			return e
		}
		r, e = scanReviewAuthoring(tx.QueryRowContext(held, `INSERT INTO golf_pull_review_authoring_operations(user_id,forge_url,actor_id,operation_id,repository_id,original,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+reviewAuthoringColumns, c.UserID, s.config.ForgeURL, actor.ID, m.OperationId, scope.repositoryID, reviewAuthoringBytes(m), fp))
		fresh = e == nil
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if _, _, _, e = s.authoringPreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceReviewAuthoring(ctx, session, token, r, "REJECTED", 0, 0)
		} else {
			r, e = s.advanceReviewAuthoring(ctx, session, token, r, "DISPATCH_UNKNOWN", 0, 0)
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			var observed, recipient int64
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockReviewAuthoring(ctx, tx, scope.repositoryID)
				if e != nil {
					return e
				}
				snap, payload, draft, e := s.authoringPreflight(held, session, token, m)
				if e != nil {
					return e
				}
				recipient = r.UserID
				if m.Kind == authorSubmit || (m.Kind == authorEdit || m.Kind == authorDelete) && !snap.wire.OwnPending {
					recipient = 0
				}
				raw, _ := json.Marshal(payload)
				held = context.WithValue(held, reviewAuthoringPermitKey{}, reviewAuthoringPermit{r, raw})
				base, _ := repositoryPath(keyFrom(m.Target.Repository))
				method, path := authoringRoute(base, m)
				var output json.RawMessage
				status := http.StatusOK
				if method == http.MethodDelete {
					status = http.StatusNoContent
				}
				var response any = &output
				if method == http.MethodDelete {
					response = nil
				}
				_, nativeErr = s.forgeJSON(held, method, path, token, payload, response, status)
				if nativeErr == nil {
					observed, nativeErr = s.authoringPostflight(held, session, token, m, snap, output, draft)
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				r, e = s.advanceReviewAuthoring(ctx, session, token, r, "SUCCEEDED", observed, recipient)
			}
		}
		if e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	status := connect.NewRequest(&golfv1.GetPullReviewAuthoringOperationRequest{Target: m.Target, OperationId: m.OperationId})
	status.Header().Set("Cookie", req.Header().Get("Cookie"))
	status.Header().Set("Origin", req.Header().Get("Origin"))
	out, e := s.GetPullReviewAuthoringOperation(ctx, status)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitPullReviewAuthoringOperationResponse{Operation: out.Msg.Operation}), nil
}
