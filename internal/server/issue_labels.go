package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
)

var errIssueLabelsChanged = errors.New("issue labels changed")

const maxNativeLabelSelection int64 = 9007199254740991 // Native PUT dynamically decodes JSON numbers as float64.

type issueLabelsChange struct {
	ExpectedIDs []int64 `json:"expected_ids"`
	IDs         []int64 `json:"ids"`
}

func labelIDs(values []string, selected bool) ([]int64, error) {
	if len(values) > 256 {
		return nil, invalid("Issue label sets support at most 256 IDs.")
	}
	ids := make([]int64, len(values))
	for i, value := range values {
		id, err := discussionID(value)
		if err != nil || i > 0 && id <= ids[i-1] || selected && id > maxNativeLabelSelection {
			return nil, invalid("Label IDs must be unique, numerically sorted positive decimal strings; selections must fit native exact JSON integers.")
		}
		ids[i] = id
	}
	return ids, nil
}
func (change issueLabelsChange) validate() error {
	for i, ids := range [][]int64{change.ExpectedIDs, change.IDs} {
		if ids == nil || len(ids) > 256 {
			return invalid("Issue labels require explicit bounded expected and selected sets.")
		}
		for j, id := range ids {
			if id <= 0 || j > 0 && id <= ids[j-1] || i == 1 && id > maxNativeLabelSelection {
				return invalid("Issue label sets must contain sorted unique positive exact IDs.")
			}
		}
	}
	return nil
}
func issueLabelIDs(issue Issue) ([]int64, error) {
	metadata, err := discussionMetadata(issue.forgeDiscussionMetadata)
	if err != nil {
		return nil, err
	}
	if metadata == nil || !metadata.LabelsKnown {
		return nil, errInvalidForgeResponse
	}
	ids := make([]int64, len(metadata.Labels))
	for i, row := range metadata.Labels {
		ids[i], err = discussionID(row.Id)
		if err != nil {
			return nil, err
		}
	}
	slices.Sort(ids)
	return ids, nil
}

func (s *Server) preflightIssueLabels(ctx context.Context, session string, token forgeCredential, input issueMutationInput, before *Issue) error {
	current, err := issueLabelIDs(*before)
	if err != nil {
		return err
	}
	if !slices.Equal(current, input.EditLabels.ExpectedIDs) {
		return errIssueLabelsChanged
	}
	if slices.Equal(current, input.EditLabels.IDs) {
		return errIssueUnchanged
	}
	return s.withRepositoryRead(ctx, session, token, repositoryKey{input.Owner, input.Repository}, func(base string, repo Repository) error {
		if repo.ID != input.RepositoryID {
			return errIssueTargetChanged
		}
		// Reuse the current native administrator + writable issue-unit observation.
		allowed, err := s.milestoneEditAuthority(ctx, token, base, repo)
		if err != nil {
			return err
		}
		if !allowed {
			return forgeError{status: 403}
		}
		ids := append(slices.Clone(current), input.EditLabels.IDs...)
		slices.Sort(ids)
		ids = slices.Compact(ids)
		scopes := map[string]bool{}
		for _, id := range ids {
			label, err := s.readRepositoryLabel(ctx, token, base, id)
			if err != nil {
				return err
			}
			// Bind existing labels too: this editor cannot silently remove org labels.
			if slices.Contains(input.EditLabels.IDs, id) && label.Exclusive {
				index := strings.LastIndex(label.Name, "/")
				if index > 0 && index < len(label.Name)-1 {
					scope := label.Name[:index]
					if scopes[scope] {
						return invalid("Select at most one exclusive label per scope.")
					}
					scopes[scope] = true
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
		observed, err := issueLabelIDs(fresh.Issue)
		if err != nil {
			return err
		}
		if !slices.Equal(observed, input.EditLabels.ExpectedIDs) {
			return errIssueLabelsChanged
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
func (s *Server) dispatchIssueLabels(ctx context.Context, token forgeCredential, base string, input issueMutationInput) error {
	var raw json.RawMessage
	_, err := s.forgeJSON(ctx, http.MethodPut, base+issueSuffix(int64(input.Number))+"/labels", token, struct {
		Labels []int64 `json:"labels"`
	}{input.EditLabels.IDs}, &raw, http.StatusOK)
	if err != nil {
		return err
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '[' {
		return errInvalidForgeResponse
	}
	ids, err := issueLabelIDs(Issue{forgeDiscussionMetadata: forgeDiscussionMetadata{Labels: raw}})
	if err != nil {
		return err
	}
	if !slices.Equal(ids, input.EditLabels.IDs) {
		return errInvalidForgeResponse
	}
	return nil
}
