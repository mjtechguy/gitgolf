package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

func (s *Server) preflightIssueMilestone(ctx context.Context, session string, token forgeCredential, input issueMutationInput, before *Issue) error {
	return s.withRepositoryRead(ctx, session, token, repositoryKey{input.Owner, input.Repository}, func(base string, repo Repository) error {
		if repo.ID != input.RepositoryID {
			return errIssueTargetChanged
		}
		allowed, err := s.milestoneEditAuthority(ctx, token, base, repo)
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
		fresh, err := s.readDiscussionIssue(ctx, token, base, repo, input.Number)
		if err != nil {
			return err
		}
		if fresh.ID != input.IssueID || fresh.isPullRequest() != input.PullRequest {
			return errIssueTargetChanged
		}
		id, err := issueMilestoneID(fresh.Issue)
		if err != nil {
			return err
		}
		if id != input.EditMilestone.ExpectedID {
			return errIssueMilestoneChanged
		}
		if issueRevision(fresh.Issue) != input.ExpectedRevision {
			return errIssueRevisionChanged
		}
		allowed, err = s.milestoneEditAuthority(ctx, token, base, repo)
		if err != nil {
			return err
		}
		if !allowed {
			return forgeError{status: 403}
		}
		if id == input.EditMilestone.ID {
			return errIssueUnchanged
		}
		*before = fresh.Issue
		return nil
	})
}

func pullMetadataIssue(pull forgePull) Issue {
	return Issue{forgeDiscussionMetadata: pull.forgeDiscussionMetadata}
}

func (input issueMutationInput) matchesOtherMetadata(before, after forgePull) bool {
	a, err := discussionMetadata(before.forgeDiscussionMetadata)
	if err != nil || a == nil {
		return false
	}
	b, err := discussionMetadata(after.forgeDiscussionMetadata)
	if err != nil || b == nil {
		return false
	}
	if input.EditAssignees != nil {
		a.Assignees, b.Assignees = nil, nil
	}
	if input.EditLabels != nil {
		a.Labels, b.Labels = nil, nil
	}
	if input.EditMilestone != nil {
		a.Milestone, b.Milestone = nil, nil
	}
	return proto.Equal(a, b)
}

// Native pull PATCH ignores milestone=0. Use its issue metadata endpoint while
// independently retaining the immutable PR identity and comparison. Every
// effect is one-field; response loss remains UNKNOWN and is never replayed.
func (s *Server) dispatchPullMetadata(ctx context.Context, session string, token forgeCredential, record database.GolfIssueMutation, input issueMutationInput) (database.GolfIssueMutation, string, string, error) {
	ctx = context.WithValue(ctx, pullDiscussionKey{}, true)
	repo, before, err := s.observePullMutationTarget(ctx, session, token, record)
	var discussion discussionIssue
	base, _ := repositoryPath(repositoryKey{input.Owner, input.Repository})
	if err == nil {
		if before == nil || pullRevision(*before) != input.ExpectedRevision {
			err = errIssueRevisionChanged
		} else {
			discussion, err = s.readDiscussionIssue(ctx, token, base, repo, input.Number)
			if err == nil && (discussion.ContentVersion == nil || before.ContentVersion == nil || *discussion.ContentVersion != *before.ContentVersion || discussion.Title != before.Title || discussion.Body != before.Body || discussion.State != before.State || discussion.User.ID != before.User.ID) {
				err = errIssueRevisionChanged
			}
		}
	}
	bridge := input
	if err == nil {
		bridge.IssueID, bridge.ExpectedRevision = discussion.ID, issueRevision(discussion.Issue)
		if bridge.ExpectedRevision == "" {
			err = errInvalidForgeResponse
		} else {
			switch {
			case input.EditLabels != nil:
				err = s.preflightIssueLabels(ctx, session, token, bridge, &discussion.Issue)
			case input.EditAssignees != nil:
				err = s.preflightIssueAssignees(ctx, session, token, bridge, &discussion.Issue)
			case input.EditMilestone != nil:
				err = s.preflightIssueMilestone(ctx, session, token, bridge, &discussion.Issue)
			}
		}
	}
	if err == nil {
		_, fresh, e := s.observePullMutationTarget(ctx, session, token, record)
		err = e
		if err == nil && (fresh == nil || pullRevision(*fresh) != input.ExpectedRevision) {
			err = errIssueRevisionChanged
		}
	}
	if err == nil {
		err = s.withManagedSession(ctx, session, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil })
	}
	if err != nil {
		failure := issueMutationRejection(err)
		if errors.Is(err, errIssueTargetChanged) {
			failure = "target_changed"
		}
		if errors.Is(err, errIssueRevisionChanged) || errors.Is(err, errIssueMilestoneChanged) || errors.Is(err, errIssueLabelsChanged) || errors.Is(err, errIssueAssigneesChanged) {
			failure = "revision_changed"
		}
		if errors.Is(err, errIssueUnchanged) {
			failure = "unchanged"
		}
		if failure == "" {
			failure = "preflight_unavailable"
		}
		return record, "REJECTED", failure, nil
	}
	if input.EditLabels != nil {
		err = s.dispatchIssueLabels(ctx, token, base, bridge)
	} else {
		var receipt discussionIssue
		_, err = s.forgeJSON(ctx, http.MethodPatch, base+issueSuffix(int64(input.Number)), token, bridge.nativeUpdate(discussion.Issue), &receipt, http.StatusCreated)
		if err == nil && (!validDiscussionIssue(receipt, repo, input.Number, true) || receipt.ID != discussion.ID || receipt.User.ID != discussion.User.ID || !bridge.matchesUpdate(receipt.Issue) || receipt.ContentVersion == nil) {
			err = errInvalidForgeResponse
		}
	}
	if err != nil {
		if failure := issueMutationRejection(err); failure != "" {
			return record, "REJECTED", failure, nil
		}
		return record, "", "", nil
	}
	// A label response has no issue/PR identity. Even a PATCH issue receipt must
	// be joined to the original current PR before retaining a PR journal receipt.
	_, after, err := s.observePullMutationTarget(ctx, session, token, record)
	if err == nil && after != nil && input.matchesPullUpdateContext(*before, *after) && input.matchesOtherMetadata(*before, *after) && input.matchesUpdate(pullMetadataIssue(*after)) {
		fresh, readErr := s.readDiscussionIssue(ctx, token, base, repo, input.Number)
		if readErr == nil && fresh.ID == discussion.ID && bridge.matchesUpdate(fresh.Issue) {
			receiptContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			err = s.recordIssueMutationReceipt(receiptContext, record, record.PullRequestID, record.IssueNumber)
			cancel()
			if err != nil {
				return record, "", "", err
			}
			// Current managed/native read after both provider waits gates success.
			_, final, err := s.observePullMutationTarget(ctx, session, token, record)
			if err == nil && final != nil && input.matchesPullUpdateContext(*before, *final) && input.matchesOtherMetadata(*before, *final) && input.matchesUpdate(pullMetadataIssue(*final)) {
				return record, "SUCCEEDED", "", nil
			}
		}
	}
	return record, "", "", nil
}
