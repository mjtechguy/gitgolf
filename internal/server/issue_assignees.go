package server

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errIssueAssigneesChanged = errors.New("issue assignees changed")

type issueAssigneeSelection struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}
type issueAssigneesChange struct {
	ExpectedIDs []int64                  `json:"expected_ids"`
	Assignees   []issueAssigneeSelection `json:"assignees"`
}

func assigneeIDs(values []string) ([]int64, error) {
	if len(values) > 100 {
		return nil, invalid("Issue assignee sets support at most 100 IDs.")
	}
	ids := make([]int64, len(values))
	for i, value := range values {
		id, err := discussionID(value)
		if err != nil || i > 0 && id <= ids[i-1] {
			return nil, invalid("Assignee IDs must be numerically sorted unique positive canonical decimal strings.")
		}
		ids[i] = id
	}
	return ids, nil
}
func issueAssigneesInput(change *golfv1.IssueAssigneesChange) (*issueAssigneesChange, error) {
	if change == nil {
		return nil, nil
	}
	expected, err := assigneeIDs(change.ExpectedAssigneeIds)
	if err != nil {
		return nil, err
	}
	if len(change.Assignees) > 100 {
		return nil, invalid("Issue assignee sets support at most 100 users.")
	}
	result := &issueAssigneesChange{ExpectedIDs: expected, Assignees: make([]issueAssigneeSelection, len(change.Assignees))}
	for i, row := range change.Assignees {
		if row == nil {
			return nil, invalid("Each assignee needs an exact ID and login.")
		}
		id, err := discussionID(row.Id)
		if err != nil {
			return nil, err
		}
		result.Assignees[i] = issueAssigneeSelection{ID: id, Login: row.Login}
	}
	if err := result.validate(); err != nil {
		return nil, err
	}
	return result, nil
}
func (change issueAssigneesChange) validate() error {
	if change.ExpectedIDs == nil || change.Assignees == nil || len(change.ExpectedIDs) > 100 || len(change.Assignees) > 100 {
		return invalid("Assignees require bounded explicit expected and replacement sets.")
	}
	for i, id := range change.ExpectedIDs {
		if id <= 0 || i > 0 && id <= change.ExpectedIDs[i-1] {
			return invalid("Expected assignee IDs must be sorted unique positive IDs.")
		}
	}
	logins := map[string]bool{}
	for i, row := range change.Assignees {
		if row.ID <= 0 || i > 0 && row.ID <= change.Assignees[i-1].ID || !validOrganizationName(row.Login) || logins[strings.ToLower(row.Login)] {
			return invalid("Selected assignees require sorted unique IDs and unique valid logins.")
		}
		logins[strings.ToLower(row.Login)] = true
	}
	return nil
}
func (change issueAssigneesChange) ids() []int64 {
	ids := make([]int64, len(change.Assignees))
	for i, row := range change.Assignees {
		ids[i] = row.ID
	}
	return ids
}
func issueAssigneeIDs(issue Issue) ([]int64, error) {
	metadata, err := discussionMetadata(issue.forgeDiscussionMetadata)
	if err != nil {
		return nil, err
	}
	if metadata == nil || !metadata.AssigneesKnown {
		return nil, errInvalidForgeResponse
	}
	ids := make([]int64, len(metadata.Assignees))
	for i, row := range metadata.Assignees {
		ids[i], err = discussionID(row.Id)
		if err != nil {
			return nil, err
		}
	}
	slices.Sort(ids)
	return ids, nil
}
func (s *Server) preflightIssueAssignees(ctx context.Context, session string, token forgeCredential, input issueMutationInput, before *Issue) error {
	current, err := issueAssigneeIDs(*before)
	if err != nil {
		return err
	}
	if !slices.Equal(current, input.EditAssignees.ExpectedIDs) {
		return errIssueAssigneesChanged
	}
	if slices.Equal(current, input.EditAssignees.ids()) {
		return errIssueUnchanged
	}
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
		// Only retained/new selections need current identity and assignability. A
		// revoked current member can still be removed without being a candidate.
		if len(input.EditAssignees.Assignees) > 0 {
			rows, err := s.readRepositoryAssignees(ctx, token, base)
			if err != nil {
				return err
			}
			candidates := map[int64]string{}
			for _, row := range rows {
				candidates[row.ID] = row.Login
			}
			for _, selected := range input.EditAssignees.Assignees {
				if candidates[selected.ID] != selected.Login {
					return invalid("Selected assignee identity is not in the current repository inventory.")
				}
				if _, err := s.forgeJSON(ctx, http.MethodGet, base+"/assignees/"+url.PathEscape(selected.Login), token, nil, nil, http.StatusNoContent); err != nil {
					return err
				}
			}
		}
		fresh, err := s.readDiscussionIssue(ctx, token, base, repo, input.Number)
		if err != nil {
			return err
		}
		if fresh.ID != input.IssueID || fresh.isPullRequest() {
			return errIssueTargetChanged
		}
		observed, err := issueAssigneeIDs(fresh.Issue)
		if err != nil {
			return err
		}
		if !slices.Equal(observed, input.EditAssignees.ExpectedIDs) {
			return errIssueAssigneesChanged
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
		*before = fresh.Issue
		return nil
	})
}
