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
	"unicode"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

// Fixed field order fingerprints the exact intent, including kind and immutable
// target IDs. The journal retains the digest, never the private title/body.
type issueMutationInput struct {
	PullRequest  bool   `json:"pull_request,omitempty"`
	Kind         string `json:"kind"`
	Owner        string `json:"owner"`
	Repository   string `json:"repository"`
	RepositoryID int64  `json:"repository_id"`
	IssueID      int64  `json:"issue_id"`
	Number       uint32 `json:"number"`
	Title        string `json:"title"`
	Body         string `json:"body"`
	// Appended optional fields preserve all existing create/comment fingerprints.
	EditTitle          *string               `json:"edit_title,omitempty"`
	EditBody           *string               `json:"edit_body,omitempty"`
	EditState          string                `json:"edit_state,omitempty"`
	ExpectedRevision   string                `json:"expected_revision,omitempty"`
	PullRequestID      int64                 `json:"pull_request_id,omitempty"`
	EditDraft          *bool                 `json:"edit_draft,omitempty"`
	SourceOwner        string                `json:"source_owner,omitempty"`
	SourceRepository   string                `json:"source_repository,omitempty"`
	SourceRepositoryID int64                 `json:"source_repository_id,omitempty"`
	BaseBranch         string                `json:"base_branch,omitempty"`
	HeadBranch         string                `json:"head_branch,omitempty"`
	BaseCommitID       string                `json:"base_commit_id,omitempty"`
	HeadCommitID       string                `json:"head_commit_id,omitempty"`
	EditMilestone      *issueMilestoneChange `json:"edit_milestone,omitempty"`
	CreateDraft        bool                  `json:"create_draft,omitempty"`
	EditLabels         *issueLabelsChange    `json:"edit_labels,omitempty"`
}

func (input issueMutationInput) validate(key string) error {
	if !creationKey.MatchString(key) {
		return invalid("Issue mutation key must be a canonical lowercase UUID v4.")
	}
	if _, err := repositoryPath(repositoryKey{input.Owner, input.Repository}); err != nil {
		return err
	}
	if input.RepositoryID <= 0 || !discussionText(input.Body, 6000) {
		return invalid("Provide a positive repository ID and UTF-8 body up to 6000 bytes, without controls other than tab or newlines.")
	}
	if isPullMutationKind(input.Kind) {
		if input.EditMilestone != nil || input.EditLabels != nil {
			return invalid("Metadata edits currently support ordinary issues only.")
		}
		return input.validatePull()
	}
	if input.PullRequestID != 0 || input.EditDraft != nil || input.SourceOwner != "" || input.SourceRepository != "" || input.SourceRepositoryID != 0 || input.BaseBranch != "" || input.HeadBranch != "" || input.BaseCommitID != "" || input.HeadCommitID != "" || input.CreateDraft {
		return invalid("Pull fields require a pull request mutation.")
	}
	if input.Kind != "UPDATE_ISSUE" && (input.EditTitle != nil || input.EditBody != nil || input.EditState != "" || input.EditMilestone != nil || input.EditLabels != nil || input.ExpectedRevision != "") {
		return invalid("Edit fields require an issue update.")
	}
	switch input.Kind {
	case "CREATE_ISSUE":
		if input.PullRequest || input.Title == "" || strings.TrimSpace(input.Title) != input.Title || !discussionText(input.Title, 255) || strings.IndexFunc(input.Title, unicode.IsControl) >= 0 || input.IssueID != 0 || input.Number != 0 {
			return invalid("Issue title must be trimmed nonempty UTF-8, at most 255 bytes, without controls.")
		}
	case "CREATE_COMMENT":
		if input.Title != "" || strings.TrimSpace(input.Body) == "" || input.IssueID <= 0 || input.Number == 0 || input.Number > 2147483647 {
			return invalid("Provide an issue ID, issue number 1–2147483647 and nonempty comment body.")
		}
	case "UPDATE_ISSUE":
		return input.validateUpdate()
	default:
		return invalid("Issue mutation kind is unsupported.")
	}
	return nil
}

func wireIssueMutation(record database.GolfIssueMutation) *golfv1.IssueMutation {
	optionalID := func(id int64) string {
		if id == 0 {
			return ""
		}
		return strconv.FormatInt(id, 10)
	}
	return &golfv1.IssueMutation{Id: strconv.FormatInt(record.ID, 10), IdempotencyKey: record.IdempotencyKey,
		Kind: golfv1.IssueMutationKind(golfv1.IssueMutationKind_value["ISSUE_MUTATION_KIND_"+record.Kind]), State: golfv1.IssueMutationState(golfv1.IssueMutationState_value["ISSUE_MUTATION_STATE_"+record.State]),
		Repository: &golfv1.RepositoryKey{Owner: record.RepositoryOwner, Name: record.RepositoryName}, RepositoryId: strconv.FormatInt(record.RepositoryID, 10),
		PullRequestId: optionalID(record.PullRequestID), IssueId: optionalID(record.IssueID), Number: uint32(record.IssueNumber), CommentId: optionalID(record.CommentID),
		ObservedResultId: optionalID(record.ObservedResultID), ObservedNumber: uint32(record.ObservedNumber),
		CreatedAt: record.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: record.UpdatedAt.Format(time.RFC3339Nano), FailureCode: record.FailureCode}
}

// All provider calls happen outside account locks. These are repeated native
// observations, not atomic expected-ID predicates on Gitea's slug-based POST.
func (s *Server) observeIssueMutationTarget(ctx context.Context, session string, token forgeCredential, record database.GolfIssueMutation) (Repository, *Issue, *golfv1.IssueComment, error) {
	ctx = context.WithValue(ctx, pullDiscussionKey{}, record.PullRequest)
	var repository Repository
	var issue *Issue
	var comment *golfv1.IssueComment
	err := s.withRepositoryRead(ctx, session, token, repositoryKey{record.RepositoryOwner, record.RepositoryName}, func(base string, repo Repository) error {
		if repo.ID != record.RepositoryID {
			return errIssueTargetChanged
		}
		repository = repo
		if record.IssueID == 0 {
			return nil
		}
		row, err := s.readDiscussionIssue(ctx, token, base, repo, uint32(record.IssueNumber))
		if err != nil {
			return err
		}
		if row.ID != record.IssueID {
			return errIssueTargetChanged
		}
		if record.Kind == "CREATE_ISSUE" && row.User.ID != record.ActorForgeUserID {
			return errInvalidForgeResponse
		}
		issue = &row.Issue
		if record.CommentID != 0 {
			row, err := s.readDiscussionComment(ctx, token, base, repo, uint32(record.IssueNumber), record.CommentID)
			if err != nil {
				return err
			}
			if row.User == nil || row.User.ID != record.ActorForgeUserID {
				return errInvalidForgeResponse
			}
			comment = wireIssueComment(row)
			// A native issue move changes comment association. Re-read the
			// numbered issue after fetching the comment, not only before it.
			after, err := s.readDiscussionIssue(ctx, token, base, repo, uint32(record.IssueNumber))
			if err != nil {
				return err
			}
			if after.ID != record.IssueID {
				return errIssueTargetChanged
			}
		}
		return nil
	})
	if err != nil {
		return Repository{}, nil, nil, err
	}
	return repository, issue, comment, nil
}

func issueMutationRejection(err error) string {
	var upstream forgeError
	if errors.As(err, &upstream) {
		switch upstream.status {
		case 400, 401, 403, 404, 409, 412, 422, 423:
			return "provider_http_" + strconv.Itoa(upstream.status)
		}
	}
	return ""
}

func (s *Server) completeIssueMutation(ctx context.Context, record database.GolfIssueMutation, state, failure string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	updated, err := queries.CompleteIssueMutation(ctx, database.CompleteIssueMutationParams{MutationID: record.ID, UserID: record.UserID, ForgeURL: s.config.GiteaURL, State: state, FailureCode: failure, IssueID: record.IssueID, IssueNumber: record.IssueNumber, CommentID: record.CommentID, PullRequestID: record.PullRequestID})
	if err != nil {
		return errStorageUnavailable
	}
	if err := queries.AppendIssueMutationEvent(ctx, database.AppendIssueMutationEventParams{MutationID: updated.ID, State: updated.State, Phase: "COMPLETED", ObservedResultID: updated.ObservedResultID, ObservedNumber: updated.ObservedNumber}); err != nil {
		return errStorageUnavailable
	}
	if err := tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	return nil
}

// A matching native receipt is durable provisional evidence, not success or
// permission to adopt an object later. This transaction runs before postflight
// and is independent of client disconnect; a crash before commit can still lose
// the receipt. No request text or provider response snapshot is retained.
func (s *Server) recordIssueMutationReceipt(ctx context.Context, record database.GolfIssueMutation, resultID, number int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	updated, err := queries.RecordIssueMutationReceipt(ctx, database.RecordIssueMutationReceiptParams{MutationID: record.ID, UserID: record.UserID, ForgeURL: s.config.GiteaURL, ObservedResultID: resultID, ObservedNumber: number})
	if err != nil {
		return errStorageUnavailable
	}
	if err := queries.AppendIssueMutationEvent(ctx, database.AppendIssueMutationEventParams{MutationID: updated.ID, State: updated.State, Phase: "RECEIPT", ObservedResultID: updated.ObservedResultID, ObservedNumber: updated.ObservedNumber}); err != nil {
		return errStorageUnavailable
	}
	if err := tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) createIssueMutation(ctx context.Context, session string, token forgeCredential, key string, input issueMutationInput) (*golfv1.GetIssueMutationResponse, error) {
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return nil, errApiCredentialReadOnly
	}
	if err := input.validate(key); err != nil {
		return nil, err
	}
	canonical, _ := json.Marshal(input)
	fingerprint := sha256.Sum256(canonical)
	var record database.GolfIssueMutation
	dispatch := false
	err := s.withManagedSession(ctx, session, token, func(queries *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		var err error
		record, err = queries.ReserveIssueMutation(ctx, database.ReserveIssueMutationParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: key, PayloadFingerprint: fingerprint[:], Kind: input.Kind, RepositoryID: input.RepositoryID, RepositoryOwner: input.Owner, RepositoryName: input.Repository, IssueID: input.IssueID, IssueNumber: int64(input.Number), PullRequest: input.PullRequest, PullRequestID: input.PullRequestID})
		if errors.Is(err, sql.ErrNoRows) {
			record, err = queries.GetIssueMutation(ctx, database.GetIssueMutationParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: key})
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
		if err := queries.AppendIssueMutationEvent(ctx, database.AppendIssueMutationEventParams{MutationID: record.ID, State: record.State, Phase: "RESERVED"}); err != nil {
			return errStorageUnavailable
		}
		dispatch = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	if dispatch && isPullMutationKind(input.Kind) {
		next, state, failure, dispatchErr := s.dispatchPullMutation(ctx, session, token, record, input)
		if dispatchErr != nil {
			return nil, dispatchErr
		}
		if state != "" {
			completion, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			err = s.completeIssueMutation(completion, next, state, failure)
			cancel()
			if err != nil {
				return nil, err
			}
		}
	} else if dispatch {
		state, failure := "", ""
		repo, before, _, preflightErr := s.observeIssueMutationTarget(ctx, session, token, record)
		if preflightErr == nil && input.Kind == "UPDATE_ISSUE" {
			if before == nil || issueRevision(*before) != input.ExpectedRevision {
				preflightErr = errIssueRevisionChanged
			} else if input.EditLabels != nil {
				preflightErr = s.preflightIssueLabels(ctx, session, token, input, before)
			} else if input.EditMilestone != nil {
				current, err := issueMilestoneID(*before)
				if err != nil {
					preflightErr = err
				} else if current != input.EditMilestone.ExpectedID {
					preflightErr = errIssueMilestoneChanged
				} else if current == input.EditMilestone.ID {
					preflightErr = errIssueUnchanged
				} else {
					preflightErr = s.withRepositoryRead(ctx, session, token, repositoryKey{input.Owner, input.Repository}, func(base string, currentRepo Repository) error {
						if currentRepo.ID != input.RepositoryID {
							return errIssueTargetChanged
						}
						allowed, err := s.milestoneEditAuthority(ctx, token, base, currentRepo)
						if err != nil {
							return err
						}
						if !allowed {
							return forgeError{status: 403}
						}
						if input.EditMilestone.ID != 0 {
							if err := s.readRepositoryMilestone(ctx, token, base, input.EditMilestone.ID); err != nil {
								return err
							}
						}
						fresh, err := s.readDiscussionIssue(ctx, token, base, currentRepo, input.Number)
						if err != nil {
							return err
						}
						if fresh.ID != input.IssueID {
							return errIssueTargetChanged
						}
						freshID, err := issueMilestoneID(fresh.Issue)
						if err != nil {
							return err
						}
						if freshID != input.EditMilestone.ExpectedID {
							return errIssueMilestoneChanged
						}
						if issueRevision(fresh.Issue) != input.ExpectedRevision {
							return errIssueRevisionChanged
						}
						*before = fresh.Issue
						allowed, err = s.milestoneEditAuthority(ctx, token, base, currentRepo)
						if err != nil {
							return err
						}
						if !allowed {
							return forgeError{status: 403}
						}
						return nil
					})
				}
			} else if input.matchesUpdate(*before) {
				preflightErr = errIssueUnchanged
			}
		}
		if preflightErr == nil {
			// Recheck the source after the preflight provider waits, immediately
			// before dispatch. This does not fence subsequent native changes.
			preflightErr = s.withManagedSession(ctx, session, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil })
		}
		if preflightErr != nil {
			state, failure = "REJECTED", issueMutationRejection(preflightErr)
			if errors.Is(preflightErr, errIssueTargetChanged) {
				failure = "target_changed"
			}
			if errors.Is(preflightErr, errIssueRevisionChanged) {
				failure = "revision_changed"
			}
			if errors.Is(preflightErr, errIssueMilestoneChanged) || errors.Is(preflightErr, errIssueLabelsChanged) {
				failure = "revision_changed"
			}
			if errors.Is(preflightErr, errIssueUnchanged) {
				failure = "unchanged"
			}
			if failure == "" {
				failure = "preflight_unavailable"
			}
		} else {
			base, _ := repositoryPath(repositoryKey{record.RepositoryOwner, record.RepositoryName})
			var providerErr error
			candidate := record
			if input.EditLabels != nil {
				providerErr = s.dispatchIssueLabels(ctx, token, base, input)
			} else if input.Kind == "UPDATE_ISSUE" {
				var receipt discussionIssue
				_, providerErr = s.forgeJSON(ctx, http.MethodPatch, base+issueSuffix(record.IssueNumber), token, input.nativeUpdate(*before), &receipt, http.StatusCreated)
				if providerErr == nil && (!validDiscussionIssue(receipt, repo, input.Number) || receipt.ID != input.IssueID || receipt.User.ID != before.User.ID || receipt.isPullRequest() || !input.matchesUpdate(receipt.Issue) || receipt.ContentVersion == nil) {
					providerErr = errInvalidForgeResponse
				}
			} else if input.Kind == "CREATE_ISSUE" {
				var receipt discussionIssue
				_, providerErr = s.forgeJSON(ctx, http.MethodPost, base+"/issues", token, struct {
					Title string `json:"title"`
					Body  string `json:"body"`
				}{input.Title, input.Body}, &receipt, http.StatusCreated)
				if providerErr == nil {
					if !validDiscussionIssue(receipt, repo, uint32(receipt.Number)) || receipt.User.ID != record.ActorForgeUserID || receipt.Title != input.Title || receipt.Body != input.Body {
						providerErr = errInvalidForgeResponse
					} else {
						candidate.IssueID, candidate.IssueNumber = receipt.ID, receipt.Number
					}
				}
			} else {
				var receipt forgeIssueComment
				_, providerErr = s.forgeJSON(ctx, http.MethodPost, base+issueSuffix(record.IssueNumber)+"/comments", token, struct {
					Body string `json:"body"`
				}{input.Body}, &receipt, http.StatusCreated)
				if providerErr == nil {
					if !validIssueComment(receipt, repo, uint32(record.IssueNumber), record.PullRequest) || receipt.User == nil || receipt.User.ID != record.ActorForgeUserID || receipt.Body != input.Body {
						providerErr = errInvalidForgeResponse
					} else {
						candidate.CommentID = receipt.ID
					}
				}
			}
			if providerErr != nil {
				if rejection := issueMutationRejection(providerErr); rejection != "" {
					state, failure = "REJECTED", rejection
				}
			} else if input.EditLabels != nil {
				// Label PUT returns only labels, without immutable issue identity.
				// Record identity only from the subsequent authorized, ID-bound GET.
				if _, after, _, err := s.observeIssueMutationTarget(ctx, session, token, candidate); err == nil && after != nil && input.matchesUpdate(*after) {
					receiptContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
					err := s.recordIssueMutationReceipt(receiptContext, record, after.ID, after.Number)
					cancel()
					if err != nil {
						return nil, err
					}
					record, state = candidate, "SUCCEEDED"
				}
			} else {
				resultID := candidate.IssueID
				if candidate.Kind == "CREATE_COMMENT" {
					resultID = candidate.CommentID
				}
				receiptContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				err := s.recordIssueMutationReceipt(receiptContext, record, resultID, candidate.IssueNumber)
				cancel()
				if err != nil {
					return nil, err
				}
				// A successful receipt without current ID-bound observation remains
				// UNKNOWN. Never adopt a same-text/same-name object or retry POST.
				if _, after, _, err := s.observeIssueMutationTarget(ctx, session, token, candidate); err == nil && (input.Kind != "UPDATE_ISSUE" || after != nil && input.matchesUpdate(*after)) {
					record, state = candidate, "SUCCEEDED"
				}
			}
		}
		if state != "" {
			completion, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			err = s.completeIssueMutation(completion, record, state, failure)
			cancel()
			if err != nil {
				return nil, err
			}
		}
	}
	return s.getIssueMutation(ctx, session, token, key)
}

func (s *Server) getIssueMutation(ctx context.Context, session string, token forgeCredential, key string) (*golfv1.GetIssueMutationResponse, error) {
	if !creationKey.MatchString(key) {
		return nil, invalid("Issue mutation key must be a canonical lowercase UUID v4.")
	}
	var record database.GolfIssueMutation
	err := s.withManagedSession(ctx, session, token, func(queries *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		var err error
		record, err = queries.GetIssueMutation(ctx, database.GetIssueMutationParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, IdempotencyKey: key})
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
	result := &golfv1.GetIssueMutationResponse{Mutation: wireIssueMutation(record)}
	if record.State != "SUCCEEDED" {
		return result, nil
	}
	var issue *Issue
	var comment *golfv1.IssueComment
	var readErr error
	if isPullMutationKind(record.Kind) {
		var pull *forgePull
		_, pull, readErr = s.observePullMutationTarget(ctx, session, token, record)
		if readErr == nil && pull != nil {
			result.PullRequest = wirePull(*pull, false)
		}
	} else {
		_, issue, comment, readErr = s.observeIssueMutationTarget(ctx, session, token, record)
	}
	// Operation evidence survives access loss. Final native actor + local source
	// checks still run even when a target read itself was denied or replaced.
	if err := s.withManagedSession(ctx, session, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil }); err != nil {
		return nil, err
	}
	if readErr != nil {
		var upstream forgeError
		if errors.Is(readErr, errIssueTargetChanged) || errors.Is(readErr, errResourceNotFound) || errors.As(readErr, &upstream) && (upstream.status == 401 || upstream.status == 403 || upstream.status == 404) {
			return result, nil
		}
		return nil, readErr
	}
	if issue != nil {
		result.Issue = wireIssue(*issue)
	}
	result.Comment = comment
	return result, nil
}

func (s *Server) CreateIssue(ctx context.Context, req *connect.Request[golfv1.CreateIssueRequest]) (*connect.Response[golfv1.CreateIssueResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	result, err := s.createIssueMutation(ctx, s.cookieValue(req.Header()), token, req.Msg.IdempotencyKey, issueMutationInput{Kind: "CREATE_ISSUE", Owner: key.Owner, Repository: key.Name, RepositoryID: id, Title: req.Msg.Title, Body: req.Msg.Body})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CreateIssueResponse{Mutation: result.Mutation, Issue: result.Issue}), nil
}

func (s *Server) CreateIssueComment(ctx context.Context, req *connect.Request[golfv1.CreateIssueCommentRequest]) (*connect.Response[golfv1.CreateIssueCommentResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	repoID, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	issueID, err := discussionID(req.Msg.IssueId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	result, err := s.createIssueMutation(ctx, s.cookieValue(req.Header()), token, req.Msg.IdempotencyKey, issueMutationInput{Kind: "CREATE_COMMENT", PullRequest: req.Msg.PullRequest, Owner: key.Owner, Repository: key.Name, RepositoryID: repoID, IssueID: issueID, Number: req.Msg.Number, Body: req.Msg.Body})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CreateIssueCommentResponse{Mutation: result.Mutation, Comment: result.Comment}), nil
}

func (s *Server) GetIssueMutation(ctx context.Context, req *connect.Request[golfv1.GetIssueMutationRequest]) (*connect.Response[golfv1.GetIssueMutationResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.getIssueMutation(ctx, s.cookieValue(req.Header()), token, req.Msg.IdempotencyKey)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
