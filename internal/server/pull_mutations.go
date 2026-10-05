package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func isPullMutationKind(kind string) bool { return kind == "CREATE_PULL" || kind == "UPDATE_PULL" }

// Native content_version fences description writes, not the whole PR object.
func pullRevision(pull forgePull) string {
	if pull.ContentVersion == nil || *pull.ContentVersion < 0 || pull.Head == nil || pull.Base == nil {
		return ""
	}
	// Embedded repository/user metadata is not a PR revision. A repository
	// description change or avatar update must not invalidate a displayed edit.
	ref := func(value *forgePullRef) forgePullRef {
		return forgePullRef{RepositoryID: value.RepositoryID, Ref: value.Ref, SHA: value.SHA}
	}
	author := int64(0)
	if pull.User != nil {
		author = pull.User.ID
	}
	data, _ := json.Marshal(struct {
		ID, Number, Author, ContentVersion   int64
		Title, Body, State, Created, Updated string
		Draft, Merged                        *bool
		MergedAt, MergeCommit                *string
		Head, Base                           forgePullRef
	}{pull.ID, pull.Number, author, *pull.ContentVersion, pull.Title, pull.Body, pull.State, pull.CreatedAt, pull.UpdatedAt, pull.Draft, pull.Merged, pull.MergedAt, pull.MergeCommitID, ref(pull.Head), ref(pull.Base)})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func pullTitle(value string) bool {
	return value != "" && strings.TrimSpace(value) == value && discussionText(value, 255) && strings.IndexFunc(value, unicode.IsControl) < 0
}
func (input issueMutationInput) validatePull() error {
	if !input.PullRequest || input.IssueID != 0 {
		return invalid("Pull request IDs must use their own identity fields.")
	}
	if input.Kind == "CREATE_PULL" {
		if input.EditMilestone != nil || input.EditLabels != nil || input.EditAssignees != nil || input.PullRequestID != 0 || input.Number != 0 || input.EditTitle != nil || input.EditBody != nil || input.EditState != "" || input.EditDraft != nil || input.ExpectedRevision != "" || !pullTitle(input.Title) {
			return invalid("Select a source and target branch and a nonempty trimmed PR title up to 255 bytes.")
		}
		if _, err := repositoryPath(repositoryKey{input.SourceOwner, input.SourceRepository}); err != nil {
			return err
		}
		if input.SourceRepositoryID <= 0 || input.BaseBranch == "" || input.HeadBranch == "" || !validRef(input.BaseBranch) || !validRef(input.HeadBranch) || strings.HasPrefix(input.BaseBranch, "refs/") || strings.HasPrefix(input.HeadBranch, "refs/") || !objectID.MatchString(input.BaseCommitID) || !objectID.MatchString(input.HeadCommitID) || len(input.BaseCommitID) != len(input.HeadCommitID) {
			return invalid("Select existing named branches, immutable repository IDs and full lowercase base/head commits.")
		}
		if input.SourceRepositoryID == input.RepositoryID && input.BaseBranch == input.HeadBranch {
			return invalid("The source and target must be different branches.")
		}
		if !input.CreateDraft && nativePullDraftPrefix(input.Title) != "" {
			return invalid("Select draft when using the native WIP title prefix.")
		}
		return nil
	}
	fields := 0
	if input.EditMilestone != nil {
		fields++
		if input.EditMilestone.ExpectedID < 0 || input.EditMilestone.ID < 0 {
			return invalid("Milestone IDs cannot be negative.")
		}
	}
	if input.EditLabels != nil {
		fields++
		if err := input.EditLabels.validate(); err != nil {
			return err
		}
	}
	if input.EditAssignees != nil {
		fields++
		if err := input.EditAssignees.validate(); err != nil {
			return err
		}
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
	if input.EditDraft != nil {
		fields++
	}
	if fields != 1 || input.PullRequestID <= 0 || input.Number == 0 || input.Number > 2147483647 || input.Title != "" || input.Body != "" || !issueRevisionPattern.MatchString(input.ExpectedRevision) || input.SourceOwner != "" || input.SourceRepository != "" || input.SourceRepositoryID != 0 || input.BaseBranch != "" || input.HeadBranch != "" || input.BaseCommitID != "" || input.HeadCommitID != "" || input.CreateDraft {
		return invalid("PR updates require exact target IDs, the displayed revision and exactly one title, description, state, draft, milestone, labels or assignees field.")
	}
	if input.EditTitle != nil && !pullTitle(*input.EditTitle) {
		return invalid("PR title must be trimmed nonempty UTF-8 up to 255 bytes, without controls.")
	}
	if input.EditBody != nil && !discussionText(*input.EditBody, 6000) {
		return invalid("PR description must be UTF-8 up to 6000 bytes, with only tabs and newlines as controls.")
	}
	if input.EditState != "" && input.EditState != "open" && input.EditState != "closed" {
		return invalid("PR state must be open or closed.")
	}
	return nil
}
func (s *Server) observePullMutationTarget(ctx context.Context, session string, token forgeCredential, record database.GolfIssueMutation) (Repository, *forgePull, error) {
	var repository Repository
	var result *forgePull
	err := s.withRepositoryRead(ctx, session, token, repositoryKey{record.RepositoryOwner, record.RepositoryName}, func(base string, repo Repository) error {
		if repo.ID != record.RepositoryID {
			return errIssueTargetChanged
		}
		repository = repo
		if record.PullRequestID == 0 {
			return nil
		}
		pull, err := s.readPull(ctx, token, base, repo, uint32(record.IssueNumber))
		if err != nil {
			return err
		}
		if pull.ID != record.PullRequestID {
			return errIssueTargetChanged
		}
		if record.Kind == "CREATE_PULL" && (pull.User == nil || pull.User.ID != record.ActorForgeUserID) {
			return errIssueTargetChanged
		}
		result = &pull
		return nil
	})
	return repository, result, err
}

// Drafts use the pinned native default title mapping; never claim a separate
// native draft field. Unknown custom prefixes fail rather than guessing removal.
func nativePullDraftTitle(title string, draft bool) (string, error) {
	if draft {
		if nativePullDraftPrefix(title) != "" {
			return title, nil
		}
		if !pullTitle("WIP: " + title) {
			return "", invalid("Draft title exceeds native title bounds.")
		}
		return "WIP: " + title, nil
	}
	prefix := nativePullDraftPrefix(title)
	if prefix == "" {
		return "", errIssueRevisionChanged
	}
	result := strings.TrimSpace(title[len(prefix):])
	if !pullTitle(result) {
		return "", errIssueRevisionChanged
	}
	return result, nil
}
func nativePullDraftPrefix(title string) string {
	for _, prefix := range []string{"WIP:", "[WIP]"} {
		if strings.HasPrefix(strings.ToUpper(title), prefix) {
			return prefix
		}
	}
	return ""
}

// A single-field update must not confirm a different author, comparison or
// merge record, nor an unrelated simultaneous edit. Native title/state writes
// are not atomic CAS operations; this is postflight detection, not fencing.
func (input issueMutationInput) matchesPullUpdateContext(before, after forgePull) bool {
	refMatches := func(a, b *forgePullRef) bool {
		return a != nil && b != nil && a.RepositoryID == b.RepositoryID && a.Ref == b.Ref && a.SHA == b.SHA
	}
	author := func(p forgePull) int64 {
		if p.User == nil {
			return 0
		}
		return p.User.ID
	}
	if before.ID != after.ID || before.Number != after.Number || before.CreatedAt != after.CreatedAt || author(before) != author(after) || !refMatches(before.Head, after.Head) || !refMatches(before.Base, after.Base) || before.Merged == nil || after.Merged == nil || *before.Merged != *after.Merged {
		return false
	}
	optional := func(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
	return optional(before.MergedAt, after.MergedAt) && optional(before.MergeCommitID, after.MergeCommitID) &&
		(input.EditTitle != nil || input.EditDraft != nil || before.Title == after.Title) &&
		(input.EditBody != nil || before.Body == after.Body) &&
		(input.EditState != "" || before.State == after.State) &&
		(input.EditTitle != nil || input.EditDraft != nil || before.Draft != nil && after.Draft != nil && *before.Draft == *after.Draft)
}
func (input issueMutationInput) matchesPull(pull forgePull, expectedTitle string) bool {
	if pull.ID <= 0 || pull.Draft == nil || pull.Merged == nil {
		return false
	}
	if input.Kind == "CREATE_PULL" {
		return pull.Title == expectedTitle && pull.Body == input.Body && pull.State == "open" && !*pull.Merged && *pull.Draft == input.CreateDraft && pull.Head.RepositoryID == input.SourceRepositoryID && pull.Base.RepositoryID == input.RepositoryID && pull.Head.Ref == input.HeadBranch && pull.Base.Ref == input.BaseBranch && pull.Head.SHA == input.HeadCommitID && pull.Base.SHA == input.BaseCommitID
	}
	return (expectedTitle == "" || pull.Title == expectedTitle) && (input.EditBody == nil || pull.Body == *input.EditBody) && (input.EditState == "" || pull.State == input.EditState) && (input.EditDraft == nil || *pull.Draft == *input.EditDraft)
}

// Check both named branches through caller-authorized endpoints. POST has no
// expected-head/base predicate; after-dispatch branch changes remain UNKNOWN.
func (s *Server) observePullCreationBranches(ctx context.Context, session string, token forgeCredential, input issueMutationInput) error {
	observe := func(key repositoryKey, id int64, branch, sha string) error {
		return s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
			if repo.ID != id {
				return errIssueTargetChanged
			}
			var row struct {
				Name   string `json:"name"`
				Commit struct {
					ID string `json:"id"`
				} `json:"commit"`
			}
			_, err := s.forge(ctx, http.MethodGet, base+"/branches/"+url.PathEscape(branch), token, nil, &row)
			if err != nil {
				return err
			}
			if row.Name != branch || row.Commit.ID != sha {
				return errIssueTargetChanged
			}
			return nil
		})
	}
	if err := observe(repositoryKey{input.Owner, input.Repository}, input.RepositoryID, input.BaseBranch, input.BaseCommitID); err != nil {
		return err
	}
	return observe(repositoryKey{input.SourceOwner, input.SourceRepository}, input.SourceRepositoryID, input.HeadBranch, input.HeadCommitID)
}
func (s *Server) dispatchPullMutation(ctx context.Context, session string, token forgeCredential, record database.GolfIssueMutation, input issueMutationInput) (database.GolfIssueMutation, string, string, error) {
	if input.EditMilestone != nil || input.EditLabels != nil || input.EditAssignees != nil {
		return s.dispatchPullMetadata(ctx, session, token, record, input)
	}
	repo, before, err := s.observePullMutationTarget(ctx, session, token, record)
	expectedTitle := ""
	payload := map[string]any{}
	if err == nil && input.Kind == "CREATE_PULL" {
		err = s.observePullCreationBranches(ctx, session, token, input)
		expectedTitle = input.Title
		if err == nil && input.CreateDraft {
			expectedTitle, err = nativePullDraftTitle(input.Title, true)
		}
		head := input.HeadBranch
		if input.SourceRepositoryID != input.RepositoryID {
			// The pinned native API accepts owner/repository:branch. Owner-only
			// syntax may infer a different fork than the source the user selected.
			head = input.SourceOwner + "/" + input.SourceRepository + ":" + head
		}
		payload = map[string]any{"head": head, "base": input.BaseBranch, "title": expectedTitle, "body": input.Body}
	} else if err == nil {
		if before == nil || pullRevision(*before) == "" || pullRevision(*before) != input.ExpectedRevision {
			err = errIssueRevisionChanged
		} else {
			payload["content_version"] = *before.ContentVersion
			if input.EditTitle != nil {
				expectedTitle = *input.EditTitle
				payload["title"] = expectedTitle
			}
			if input.EditBody != nil {
				payload["body"] = *input.EditBody
			}
			if input.EditState != "" {
				if *before.Merged {
					err = errIssueRevisionChanged
				} else {
					payload["state"] = input.EditState
				}
			}
			if input.EditDraft != nil {
				if *before.Merged || before.State != "open" {
					err = errIssueRevisionChanged
				} else {
					expectedTitle, err = nativePullDraftTitle(before.Title, *input.EditDraft)
					payload["title"] = expectedTitle
				}
			}
			if err == nil && input.matchesPull(*before, expectedTitle) {
				err = errIssueUnchanged
			}
		}
	}
	if err == nil {
		err = s.withManagedSession(ctx, session, token, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil })
	}
	reject := func(err error) (database.GolfIssueMutation, string, string, error) {
		failure := issueMutationRejection(err)
		if errors.Is(err, errIssueTargetChanged) {
			failure = "target_changed"
		}
		if errors.Is(err, errIssueRevisionChanged) {
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
	if err != nil {
		return reject(err)
	}
	base, _ := repositoryPath(repositoryKey{record.RepositoryOwner, record.RepositoryName})
	route, method := base+"/pulls", http.MethodPost
	if input.Kind == "UPDATE_PULL" {
		route += "/" + strconv.FormatInt(record.IssueNumber, 10)
		method = http.MethodPatch
	}
	var receipt forgePull
	_, err = s.forgeJSON(ctx, method, route, token, payload, &receipt, http.StatusCreated)
	if err != nil {
		if failure := issueMutationRejection(err); failure != "" {
			return record, "REJECTED", failure, nil
		}
		return record, "", "", nil
	}
	if !validPull(receipt, repo) || pullRevision(receipt) == "" || !input.matchesPull(receipt, expectedTitle) {
		return record, "", "", nil
	}
	if input.Kind == "CREATE_PULL" {
		if receipt.User == nil || receipt.User.ID != record.ActorForgeUserID {
			return record, "", "", nil
		}
	} else if before == nil || !input.matchesPullUpdateContext(*before, receipt) {
		return record, "", "", nil
	}
	candidate := record
	candidate.PullRequestID = receipt.ID
	candidate.IssueNumber = receipt.Number
	receiptContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	err = s.recordIssueMutationReceipt(receiptContext, record, receipt.ID, receipt.Number)
	cancel()
	if err != nil {
		return record, "", "", err
	}
	_, after, err := s.observePullMutationTarget(ctx, session, token, candidate)
	if err == nil && after != nil && input.matchesPull(*after, expectedTitle) && pullRevision(*after) == pullRevision(receipt) {
		if input.Kind == "CREATE_PULL" {
			err = s.observePullCreationBranches(ctx, session, token, input)
		}
		if err == nil {
			return candidate, "SUCCEEDED", "", nil
		}
	}
	return record, "", "", nil
}
func (s *Server) CreatePullRequest(ctx context.Context, req *connect.Request[golfv1.CreatePullRequestRequest]) (*connect.Response[golfv1.CreatePullRequestResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	repoID, err := discussionID(m.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	sourceID, err := discussionID(m.SourceRepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	target, source := keyFrom(m.Repository), keyFrom(m.SourceRepository)
	result, err := s.createIssueMutation(ctx, s.cookieValue(req.Header()), token, m.IdempotencyKey, issueMutationInput{Kind: "CREATE_PULL", PullRequest: true, Owner: target.Owner, Repository: target.Name, RepositoryID: repoID, SourceOwner: source.Owner, SourceRepository: source.Name, SourceRepositoryID: sourceID, BaseBranch: m.BaseBranch, HeadBranch: m.HeadBranch, BaseCommitID: m.BaseCommitId, HeadCommitID: m.HeadCommitId, Title: m.Title, Body: m.Body, CreateDraft: m.Draft})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CreatePullRequestResponse{Mutation: result.Mutation, PullRequest: result.PullRequest}), nil
}
func (s *Server) UpdatePullRequest(ctx context.Context, req *connect.Request[golfv1.UpdatePullRequestRequest]) (*connect.Response[golfv1.UpdatePullRequestResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	repoID, err := discussionID(m.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	pullID, err := discussionID(m.PullRequestId)
	if err != nil {
		return nil, rpcError(err)
	}
	state := ""
	switch m.State {
	case golfv1.IssueState_ISSUE_STATE_UNSPECIFIED:
	case golfv1.IssueState_ISSUE_STATE_OPEN:
		state = "open"
	case golfv1.IssueState_ISSUE_STATE_CLOSED:
		state = "closed"
	default:
		return nil, rpcError(invalid("PR state must be open or closed."))
	}
	milestone, labels, assignees, err := discussionChanges(m.Milestone, m.Labels, m.Assignees)
	if err != nil {
		return nil, rpcError(err)
	}
	target := keyFrom(m.Repository)
	result, err := s.createIssueMutation(ctx, s.cookieValue(req.Header()), token, m.IdempotencyKey, issueMutationInput{Kind: "UPDATE_PULL", PullRequest: true, Owner: target.Owner, Repository: target.Name, RepositoryID: repoID, PullRequestID: pullID, Number: m.Number, ExpectedRevision: m.ExpectedRevision, EditTitle: m.Title, EditBody: m.Body, EditState: state, EditDraft: m.Draft, EditMilestone: milestone, EditLabels: labels, EditAssignees: assignees})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.UpdatePullRequestResponse{Mutation: result.Mutation, PullRequest: result.PullRequest}), nil
}
