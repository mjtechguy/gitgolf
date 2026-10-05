package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errIssueRevisionChanged = errors.New("issue revision changed")
var errIssueMilestoneChanged = errors.New("issue milestone changed")
var errIssueUnchanged = errors.New("issue field unchanged")
var issueRevisionPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// A form-staleness observation, not a native target-ID or global CAS fence.
// Native content_version fences body edits only. Title/state can still race.
func issueRevision(issue Issue) string {
	if issue.ContentVersion == nil || *issue.ContentVersion < 0 {
		return ""
	}
	data, _ := json.Marshal(struct {
		ID, Number, AuthorID, Version int64
		Title, Body, State, Updated   string
	}{issue.ID, issue.Number, issue.User.ID, *issue.ContentVersion, issue.Title, issue.Body, issue.State, issue.UpdatedAt})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type issueMilestoneChange struct {
	ExpectedID int64 `json:"expected_id"`
	ID         int64 `json:"id"`
}

func milestoneID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id < 0 || strconv.FormatInt(id, 10) != value {
		return 0, invalid("Milestone IDs must be canonical nonnegative decimal strings; 0 explicitly means None.")
	}
	return id, nil
}
func issueMilestoneID(issue Issue) (int64, error) {
	metadata, err := discussionMetadata(issue.forgeDiscussionMetadata)
	if err != nil {
		return 0, err
	}
	if metadata == nil || !metadata.MilestoneKnown {
		return 0, errInvalidForgeResponse
	}
	if metadata.Milestone == nil {
		return 0, nil
	}
	return discussionID(metadata.Milestone.Id)
}
func (input issueMutationInput) validateUpdate() error {
	fields := 0
	if input.EditLabels != nil {
		fields++
		if err := input.EditLabels.validate(); err != nil {
			return err
		}
	}
	if input.EditMilestone != nil {
		fields++
	}
	if input.EditTitle != nil {
		fields++
	}
	if input.EditBody != nil {
		fields++
	}
	if input.EditState != "" {
		fields++
	}
	if fields != 1 || input.PullRequest || input.IssueID <= 0 || input.Number == 0 || input.Number > 2147483647 || input.Title != "" || input.Body != "" || !issueRevisionPattern.MatchString(input.ExpectedRevision) {
		return invalid("Issue updates require exact target IDs, the displayed revision and exactly one title, body, state, milestone or labels field.")
	}
	if input.EditMilestone != nil && (input.EditMilestone.ExpectedID < 0 || input.EditMilestone.ID < 0) {
		return invalid("Milestone IDs cannot be negative.")
	}
	if input.EditTitle != nil && (*input.EditTitle == "" || strings.TrimSpace(*input.EditTitle) != *input.EditTitle || !discussionText(*input.EditTitle, 255) || strings.IndexFunc(*input.EditTitle, unicode.IsControl) >= 0) {
		return invalid("Issue title must be trimmed nonempty UTF-8, at most 255 bytes, without controls.")
	}
	if input.EditBody != nil && !discussionText(*input.EditBody, 6000) {
		return invalid("Issue body must be valid UTF-8 up to 6000 bytes, with only tabs and newlines as controls.")
	}
	if input.EditState != "" && input.EditState != "open" && input.EditState != "closed" {
		return invalid("Issue state must be open or closed.")
	}
	return nil
}
func (input issueMutationInput) matchesUpdate(issue Issue) bool {
	if input.EditLabels != nil {
		ids, err := issueLabelIDs(issue)
		return err == nil && slices.Equal(ids, input.EditLabels.IDs)
	}
	if input.EditMilestone != nil {
		id, err := issueMilestoneID(issue)
		return err == nil && id == input.EditMilestone.ID
	}
	return (input.EditTitle == nil || issue.Title == *input.EditTitle) && (input.EditBody == nil || issue.Body == *input.EditBody) && (input.EditState == "" || issue.State == input.EditState)
}
func (input issueMutationInput) nativeUpdate(before Issue) map[string]any {
	result := map[string]any{"content_version": *before.ContentVersion}
	if input.EditMilestone != nil {
		result["milestone"] = input.EditMilestone.ID
	}
	if input.EditTitle != nil {
		result["title"] = *input.EditTitle
	}
	if input.EditBody != nil {
		result["body"] = *input.EditBody
	}
	if input.EditState != "" {
		result["state"] = input.EditState
	}
	return result
}
func (s *Server) UpdateIssue(ctx context.Context, req *connect.Request[golfv1.UpdateIssueRequest]) (*connect.Response[golfv1.UpdateIssueResponse], error) {
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
	state := ""
	switch req.Msg.State {
	case golfv1.IssueState_ISSUE_STATE_UNSPECIFIED:
	case golfv1.IssueState_ISSUE_STATE_OPEN:
		state = "open"
	case golfv1.IssueState_ISSUE_STATE_CLOSED:
		state = "closed"
	default:
		return nil, rpcError(invalid("Issue state must be open or closed."))
	}
	var milestone *issueMilestoneChange
	if req.Msg.Milestone != nil {
		expected, err := milestoneID(req.Msg.Milestone.ExpectedMilestoneId)
		if err != nil {
			return nil, rpcError(err)
		}
		selected, err := milestoneID(req.Msg.Milestone.MilestoneId)
		if err != nil {
			return nil, rpcError(err)
		}
		milestone = &issueMilestoneChange{ExpectedID: expected, ID: selected}
	}
	var labels *issueLabelsChange
	if req.Msg.Labels != nil {
		expected, err := labelIDs(req.Msg.Labels.ExpectedLabelIds, false)
		if err != nil {
			return nil, rpcError(err)
		}
		selected, err := labelIDs(req.Msg.Labels.LabelIds, true)
		if err != nil {
			return nil, rpcError(err)
		}
		labels = &issueLabelsChange{ExpectedIDs: expected, IDs: selected}
	}
	key := keyFrom(req.Msg.Repository)
	result, err := s.createIssueMutation(ctx, s.cookieValue(req.Header()), token, req.Msg.IdempotencyKey, issueMutationInput{Kind: "UPDATE_ISSUE", Owner: key.Owner, Repository: key.Name, RepositoryID: repoID, IssueID: issueID, Number: req.Msg.Number, EditTitle: req.Msg.Title, EditBody: req.Msg.Body, EditState: state, ExpectedRevision: req.Msg.ExpectedRevision, EditMilestone: milestone, EditLabels: labels})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.UpdateIssueResponse{Mutation: result.Mutation, Issue: result.Issue}), nil
}
