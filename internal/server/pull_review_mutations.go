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
)

func wirePullReviewMutation(r database.GolfPullReviewMutation) *golfv1.PullRequestReviewMutation {
	observed := ""
	if r.ObservedReviewID > 0 {
		observed = strconv.FormatInt(r.ObservedReviewID, 10)
	}
	return &golfv1.PullRequestReviewMutation{Id: strconv.FormatInt(r.ID, 10), IdempotencyKey: r.IdempotencyKey, State: golfv1.IssueMutationState(golfv1.IssueMutationState_value["ISSUE_MUTATION_STATE_"+r.State]), Repository: &golfv1.RepositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), PullRequestId: strconv.FormatInt(r.PullRequestID, 10), Number: uint32(r.Number), HeadCommitId: r.HeadCommitID, ReviewState: pullReviewState(r.ReviewState), ObservedReviewId: observed, FailureCode: r.FailureCode, CreatedAt: r.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.Format(time.RFC3339Nano)}
}

// Receipt proof binds a body-only review to its immutable author/PR/commit. It
// is not freshness, eligible approval, native CAS, or protected merge authority.
func reviewMatches(r database.GolfPullReviewMutation, row forgePullReview, pull forgePull) bool {
	hash := sha256.Sum256([]byte(row.Body))
	return row.ID > 0 && (r.ObservedReviewID == 0 || row.ID == r.ObservedReviewID) && row.User != nil && row.User.ID == r.ActorForgeUserID && validPullUser(row.User) && row.PullRequestURL == pull.HTMLURL && row.CommitID == r.HeadCommitID && row.State == r.ReviewState && bytes.Equal(hash[:], r.BodyFingerprint) && discussionText(row.Body, 6000) && validPullTime(row.SubmittedAt) && validPullTime(row.UpdatedAt) && row.CommentsCount != nil && *row.CommentsCount == 0 && (!row.Dismissed || r.State == "SUCCEEDED")
}

func (s *Server) observeReviewTarget(ctx context.Context, session string, token forgeCredential, r database.GolfPullReviewMutation, inspect bool) (forgePull, *forgePullReview, error) {
	var pull forgePull
	var result *forgePullReview
	err := s.withRepositoryRead(ctx, session, token, repositoryKey{r.RepositoryOwner, r.RepositoryName}, func(base string, repo Repository) error {
		if repo.ID != r.RepositoryID {
			return errIssueTargetChanged
		}
		var err error
		pull, err = s.readPull(ctx, token, base, repo, uint32(r.Number))
		if err != nil {
			return err
		}
		if pull.ID != r.PullRequestID {
			return errIssueTargetChanged
		}
		if inspect && r.ObservedReviewID > 0 {
			var row forgePullReview
			_, err = s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatInt(r.Number, 10)+"/reviews/"+strconv.FormatInt(r.ObservedReviewID, 10), token, nil, &row)
			if err != nil {
				return err
			}
			if !reviewMatches(r, row, pull) {
				return errInvalidForgeResponse
			}
			after, err := s.readPull(ctx, token, base, repo, uint32(r.Number))
			if err != nil {
				return err
			}
			if after.ID != r.PullRequestID {
				return errIssueTargetChanged
			}
			result = &row
		}
		return nil
	})
	return pull, result, err
}

// Native totals count hidden other-user PENDING rows. An empty visible page is
// not completion. Bound the preflight to 2000 native reviews/pages and 15 seconds.
func (s *Server) ownPendingReview(ctx context.Context, session string, token forgeCredential, r database.GolfPullReviewMutation) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	pending := false
	err := s.withRepositoryRead(ctx, session, token, repositoryKey{r.RepositoryOwner, r.RepositoryName}, func(base string, repo Repository) error {
		return s.withNativePageSize(ctx, token, 100, func(limit uint32) error {
			if repo.ID != r.RepositoryID {
				return errIssueTargetChanged
			}
			var count int64 = -1
			seen := map[int64]bool{}
			for page := uint32(1); page <= 2000; page++ {
				var rows []forgePullReview
				headers, err := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatInt(r.Number, 10)+"/reviews?"+pageQuery(page, limit).Encode(), token, nil, &rows)
				if err != nil {
					return err
				}
				value := headers.Get("X-Total-Count")
				total, e := strconv.ParseInt(value, 10, 64)
				if e != nil || total < 0 || total > 2000 || strconv.FormatInt(total, 10) != value || rows == nil || len(rows) > int(limit) || int64(len(rows)) > total || count >= 0 && total != count {
					return errInvalidForgeResponse
				}
				count = total
				for _, row := range rows {
					if row.ID <= 0 || seen[row.ID] || !validPullUser(row.User) || pullReviewState(row.State) == golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_UNSPECIFIED || !validPullTime(row.SubmittedAt) || !validPullTime(row.UpdatedAt) || row.PullRequestURL != strings.TrimRight(repo.HTMLURL, "/")+"/pulls/"+strconv.FormatInt(r.Number, 10) {
						return errInvalidForgeResponse
					}
					seen[row.ID] = true
					if row.State == "PENDING" && row.User != nil && row.User.ID == r.ActorForgeUserID {
						pending = true
					}
				}
				if int64(page)*int64(limit) >= total {
					return nil
				}
			}
			return errInvalidForgeResponse
		})
	})
	return pending, err
}

func (s *Server) advanceReviewMutation(ctx context.Context, r database.GolfPullReviewMutation, observed int64, state, failure string) (database.GolfPullReviewMutation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return r, errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	phase := "COMPLETED"
	var updated database.GolfPullReviewMutation
	if observed > 0 {
		phase = "RECEIPT"
		updated, err = q.RecordPullReviewReceipt(ctx, database.RecordPullReviewReceiptParams{MutationID: r.ID, UserID: r.UserID, ForgeURL: s.config.GiteaURL, ObservedReviewID: observed})
	} else {
		updated, err = q.CompletePullReviewMutation(ctx, database.CompletePullReviewMutationParams{MutationID: r.ID, UserID: r.UserID, ForgeURL: s.config.GiteaURL, State: state, FailureCode: failure})
	}
	if err != nil {
		return r, errStorageUnavailable
	}
	if err = q.AppendPullReviewMutationEvent(ctx, database.AppendPullReviewMutationEventParams{MutationID: updated.ID, Phase: phase, State: updated.State, ObservedReviewID: updated.ObservedReviewID, FailureCode: updated.FailureCode}); err != nil {
		return r, errStorageUnavailable
	}
	if err = tx.Commit(); err != nil {
		return r, errStorageUnavailable
	}
	return updated, nil
}

func (s *Server) getPullReviewMutation(ctx context.Context, session string, token forgeCredential, key string) (*golfv1.GetPullRequestReviewMutationResponse, error) {
	if !creationKey.MatchString(key) {
		return nil, invalid("Review request key must be a canonical lowercase UUID v4.")
	}
	var r database.GolfPullReviewMutation
	err := s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		var err error
		r, err = q.GetPullReviewMutation(ctx, database.GetPullReviewMutationParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: key})
		if errors.Is(err, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if err != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	result := &golfv1.GetPullRequestReviewMutationResponse{Mutation: wirePullReviewMutation(r)}
	if r.State != "SUCCEEDED" {
		return result, nil
	}
	_, row, readErr := s.observeReviewTarget(ctx, session, token, r, true)
	if err = s.withManagedSession(ctx, session, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil }); err != nil {
		return nil, err
	}
	if readErr != nil {
		var upstream forgeError
		if errors.Is(readErr, errIssueTargetChanged) || errors.Is(readErr, errResourceNotFound) || errors.As(readErr, &upstream) && (upstream.status == 401 || upstream.status == 403 || upstream.status == 404) {
			return result, nil
		}
		return nil, readErr
	}
	if row != nil {
		result.Review = wirePullReview(*row)
	}
	return result, nil
}

func (s *Server) CreatePullRequestReview(ctx context.Context, req *connect.Request[golfv1.CreatePullRequestReviewRequest]) (*connect.Response[golfv1.CreatePullRequestReviewResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return nil, rpcError(errApiCredentialReadOnly)
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	repoID, err := discussionID(m.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	pullID, err := discussionID(m.PullRequestId)
	if err != nil {
		return nil, rpcError(err)
	}
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	state := ""
	switch m.State {
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT:
		state = "COMMENT"
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED:
		state = "APPROVED"
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES:
		state = "REQUEST_CHANGES"
	}
	if !creationKey.MatchString(m.IdempotencyKey) || pullNumber(m.Number) != nil || !issueRevisionPattern.MatchString(m.ExpectedRevision) || !objectID.MatchString(m.BaseCommitId) || !objectID.MatchString(m.HeadCommitId) || len(m.BaseCommitId) != len(m.HeadCommitId) || state == "" || !discussionText(m.Body, 6000) || state != "APPROVED" && strings.TrimSpace(m.Body) == "" {
		return nil, rpcError(invalid("Use exact PR/repository IDs, displayed revision and full base/head commits, a supported review decision, and UTF-8 review text up to 6000 bytes. Comment/change requests require text."))
	}
	canonical, _ := json.Marshal(struct {
		Repository                        repositoryKey
		RepositoryID, PullID              int64
		Number                            uint32
		Revision, Base, Head, State, Body string
	}{key, repoID, pullID, m.Number, m.ExpectedRevision, m.BaseCommitId, m.HeadCommitId, state, m.Body})
	fingerprint := sha256.Sum256(canonical)
	bodyHash := sha256.Sum256([]byte(m.Body))
	session := s.cookieValue(req.Header())
	var record database.GolfPullReviewMutation
	dispatch := false
	err = s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		var err error
		record, err = q.ReservePullReviewMutation(ctx, database.ReservePullReviewMutationParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: m.IdempotencyKey, PayloadFingerprint: fingerprint[:], BodyFingerprint: bodyHash[:], RepositoryID: repoID, RepositoryOwner: key.Owner, RepositoryName: key.Name, PullRequestID: pullID, Number: int64(m.Number), ExpectedRevision: m.ExpectedRevision, BaseCommitID: m.BaseCommitId, HeadCommitID: m.HeadCommitId, ReviewState: state})
		if errors.Is(err, sql.ErrNoRows) {
			record, err = q.GetPullReviewMutation(ctx, database.GetPullReviewMutationParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: m.IdempotencyKey})
			if err != nil {
				return errStorageUnavailable
			}
			if !bytes.Equal(record.PayloadFingerprint, fingerprint[:]) {
				return errIssueMutationConflict
			}
			return nil
		}
		if err != nil {
			return errStorageUnavailable
		}
		if err = q.AppendPullReviewMutationEvent(ctx, database.AppendPullReviewMutationEventParams{MutationID: record.ID, Phase: "RESERVED", State: record.State}); err != nil {
			return errStorageUnavailable
		}
		dispatch = true
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	if dispatch {
		pull, _, preflightErr := s.observeReviewTarget(ctx, session, token, record, false)
		failure := ""
		if preflightErr == nil {
			if pullRevision(pull) != m.ExpectedRevision || pull.Base.SHA != m.BaseCommitId || pull.Head.SHA != m.HeadCommitId {
				failure = "revision_changed"
			} else if state != "COMMENT" && (pull.State != "open" || *pull.Merged || *pull.Draft || pull.User != nil && pull.User.ID == record.ActorForgeUserID) {
				failure = "review_unavailable"
			}
		}
		if preflightErr == nil && failure == "" {
			var pending bool
			pending, preflightErr = s.ownPendingReview(ctx, session, token, record)
			if pending {
				failure = "pending_review"
			}
		}
		if preflightErr == nil && failure == "" {
			after, _, e := s.observeReviewTarget(ctx, session, token, record, false)
			preflightErr = e
			if e == nil && (pullRevision(after) != m.ExpectedRevision || after.Base.SHA != m.BaseCommitId || after.Head.SHA != m.HeadCommitId) {
				failure = "revision_changed"
			}
		}
		if preflightErr == nil && failure == "" {
			preflightErr = s.withManagedSession(ctx, session, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil })
		}
		finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		if preflightErr != nil || failure != "" {
			if failure == "" {
				failure = issueMutationRejection(preflightErr)
				if errors.Is(preflightErr, errIssueTargetChanged) {
					failure = "target_changed"
				}
				if failure == "" {
					failure = "preflight_unavailable"
				}
			}
			_, err = s.advanceReviewMutation(finishCtx, record, 0, "REJECTED", failure)
			cancel()
			if err != nil {
				return nil, rpcError(err)
			}
		} else {
			cancel()
			var receipt forgePullReview
			base, _ := repositoryPath(key)
			_, writeErr := s.forge(ctx, http.MethodPost, base+"/pulls/"+strconv.FormatUint(uint64(m.Number), 10)+"/reviews", token, map[string]any{"event": state, "body": m.Body, "commit_id": m.HeadCommitId}, &receipt)
			completion, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			if writeErr != nil {
				if rejected := issueMutationRejection(writeErr); rejected != "" {
					_, err = s.advanceReviewMutation(completion, record, 0, "REJECTED", rejected)
				}
			} else if reviewMatches(record, receipt, pull) {
				record, err = s.advanceReviewMutation(completion, record, receipt.ID, "", "")
				if err == nil {
					_, observed, observeErr := s.observeReviewTarget(ctx, session, token, record, true)
					if observeErr == nil && observed != nil {
						_, err = s.advanceReviewMutation(completion, record, 0, "SUCCEEDED", "")
					}
				}
			}
			done()
			if err != nil {
				return nil, rpcError(err)
			}
		}
	}
	result, err := s.getPullReviewMutation(ctx, session, token, m.IdempotencyKey)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CreatePullRequestReviewResponse{Mutation: result.Mutation, Review: result.Review}), nil
}

func (s *Server) GetPullRequestReviewMutation(ctx context.Context, req *connect.Request[golfv1.GetPullRequestReviewMutationRequest]) (*connect.Response[golfv1.GetPullRequestReviewMutationResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.getPullReviewMutation(ctx, s.cookieValue(req.Header()), token, req.Msg.IdempotencyKey)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
