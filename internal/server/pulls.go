package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Gitea list heads are retained PR snapshots even when Ref names a source
// branch. Detail reads can also fall back to refs/pull/N/head. Neither response
// establishes an atomic source/base observation or qualified merge eligibility.
type forgePullRef struct {
	RepositoryID int64       `json:"repo_id"`
	Label        string      `json:"label"`
	Ref          string      `json:"ref"`
	SHA          string      `json:"sha"`
	Repository   *Repository `json:"repo"`
}

type forgePull struct {
	ContentVersion *int64        `json:"content_version"`
	ID             int64         `json:"id"`
	Number         int64         `json:"number"`
	Title          string        `json:"title"`
	Body           string        `json:"body"`
	State          string        `json:"state"`
	User           *User         `json:"user"`
	CreatedAt      string        `json:"created_at"`
	UpdatedAt      string        `json:"updated_at"`
	HTMLURL        string        `json:"html_url"`
	Draft          *bool         `json:"draft"`
	Merged         *bool         `json:"merged"`
	MergedAt       *string       `json:"merged_at"`
	MergeCommitID  *string       `json:"merge_commit_sha"`
	Head           *forgePullRef `json:"head"`
	Base           *forgePullRef `json:"base"`
	MergeBase      string        `json:"merge_base"`
}

type forgePullReview struct {
	ID             int64  `json:"id"`
	User           *User  `json:"user"`
	Body           string `json:"body"`
	State          string `json:"state"`
	CommitID       string `json:"commit_id"`
	Stale          bool   `json:"stale"`
	Dismissed      bool   `json:"dismissed"`
	Official       bool   `json:"official"`
	SubmittedAt    string `json:"submitted_at"`
	UpdatedAt      string `json:"updated_at"`
	HTMLURL        string `json:"html_url"`
	PullRequestURL string `json:"pull_request_url"`
	CommentsCount  *int64 `json:"comments_count"`
}

func wirePullReview(row forgePullReview) *golfv1.PullRequestReview {
	result := &golfv1.PullRequestReview{Id: strconv.FormatInt(row.ID, 10), User: wirePullUser(row.User), Body: row.Body, State: pullReviewState(row.State), CommitId: row.CommitID, Stale: row.Stale, Dismissed: row.Dismissed, Official: row.Official, SubmittedAt: row.SubmittedAt, UpdatedAt: row.UpdatedAt, HtmlUrl: row.HTMLURL}
	if row.CommentsCount != nil && *row.CommentsCount >= 0 && *row.CommentsCount <= 2147483647 {
		result.CommentsCount = uint32(*row.CommentsCount)
	}
	return result
}

func pullState(value golfv1.IssueState) (string, error) {
	switch value {
	case golfv1.IssueState_ISSUE_STATE_UNSPECIFIED, golfv1.IssueState_ISSUE_STATE_OPEN:
		return "open", nil
	case golfv1.IssueState_ISSUE_STATE_CLOSED:
		return "closed", nil
	case golfv1.IssueState_ISSUE_STATE_ALL:
		return "all", nil
	default:
		return "", invalid("Pull request state must be open, closed or all.")
	}
}

func pullNumber(number uint32) error {
	if number == 0 || number > 2147483647 {
		return invalid("Pull request number must be 1–2147483647.")
	}
	return nil
}

func pullReviewState(state string) golfv1.PullRequestReviewState {
	switch state {
	case "APPROVED":
		return golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED
	case "PENDING":
		return golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_PENDING
	case "COMMENT":
		return golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT
	case "REQUEST_CHANGES":
		return golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES
	case "REQUEST_REVIEW":
		return golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_REVIEW
	default:
		return golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_UNSPECIFIED
	}
}

func validPullTime(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

// The native ghost user has ID -1. Preserve absence instead of inventing a
// normal account ID. The provider can omit an author for a team review request.
func validPullUser(user *User) bool {
	return user == nil || user.ID == -1 || (user.ID > 0 && validOrganizationName(user.Login))
}

func wirePullUser(user *User) *golfv1.User {
	if user == nil || user.ID == -1 {
		return nil
	}
	return wireUser(*user)
}

func validPullRef(ref *forgePullRef) bool {
	return ref != nil && ref.RepositoryID != 0 && ref.RepositoryID >= -1 && ref.Ref != "" && validRef(ref.Ref) &&
		(len(ref.Label) <= 1024 && utf8.ValidString(ref.Label) && strings.IndexFunc(ref.Label, unicode.IsControl) == -1) && (ref.SHA == "" || objectID.MatchString(ref.SHA)) &&
		(ref.Repository == nil || ref.Repository.ID == ref.RepositoryID)
}

func validPull(row forgePull, repo Repository) bool {
	if row.ID <= 0 || row.Number <= 0 || row.Number > 2147483647 || row.Title == "" || len(row.Title) > 1024 ||
		(row.State != "open" && row.State != "closed") || !validPullUser(row.User) || !validPullTime(row.CreatedAt) || !validPullTime(row.UpdatedAt) ||
		row.Draft == nil || row.Merged == nil || !validPullRef(row.Head) || !validPullRef(row.Base) {
		return false
	}
	if row.MergeBase != "" && (!objectID.MatchString(row.MergeBase) || row.Head.SHA != "" && len(row.MergeBase) != len(row.Head.SHA) || row.Base.SHA != "" && len(row.MergeBase) != len(row.Base.SHA)) {
		return false
	}
	if row.Base.RepositoryID != repo.ID || row.HTMLURL != strings.TrimRight(repo.HTMLURL, "/")+"/pulls/"+strconv.FormatInt(row.Number, 10) {
		return false
	}
	retained := "refs/pull/" + strconv.FormatInt(row.Number, 10) + "/head"
	if strings.HasPrefix(row.Head.Ref, "refs/pull/") && row.Head.Ref != retained {
		return false
	}
	if row.Head.RepositoryID == -1 && row.Head.Ref != retained {
		return false
	}
	if *row.Merged {
		return row.State == "closed" && row.MergedAt != nil && validPullTime(*row.MergedAt) && row.MergeCommitID != nil && objectID.MatchString(*row.MergeCommitID)
	}
	return row.MergedAt == nil && row.MergeCommitID == nil
}

func wirePullRef(ref *forgePullRef, retained bool) *golfv1.PullRequestRef {
	id := ""
	if ref.RepositoryID > 0 {
		id = strconv.FormatInt(ref.RepositoryID, 10)
	}
	return &golfv1.PullRequestRef{RepositoryId: id, Label: ref.Label, Ref: ref.Ref, CommitId: ref.SHA, RetainedSnapshot: retained}
}

func wirePull(row forgePull, listed bool) *golfv1.PullRequest {
	state := golfv1.IssueState_ISSUE_STATE_OPEN
	if row.State == "closed" {
		state = golfv1.IssueState_ISSUE_STATE_CLOSED
	}
	result := &golfv1.PullRequest{Id: strconv.FormatInt(row.ID, 10), Number: uint32(row.Number), Title: row.Title, Body: row.Body,
		State: state, User: wirePullUser(row.User), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, HtmlUrl: row.HTMLURL,
		Revision: pullRevision(row), MergeBaseCommitId: row.MergeBase, Draft: *row.Draft, Merged: *row.Merged, Head: wirePullRef(row.Head, listed || row.Head.Ref == "refs/pull/"+strconv.FormatInt(row.Number, 10)+"/head"), Base: wirePullRef(row.Base, false)}
	if row.MergedAt != nil {
		result.MergedAt = *row.MergedAt
	}
	if row.MergeCommitID != nil {
		result.MergeCommitId = *row.MergeCommitID
	}
	return result
}

// Reviews only send X-Total-Count, not Link. Their count is computed before
// provider filtering of other users' pending reviews. Keep empty pages with a
// next page and never infer completion from the number of returned rows.
func pullNextPage(headers http.Header, page, limit uint32) (uint32, error) {
	value := headers.Get("X-Total-Count")
	total, err := strconv.ParseInt(value, 10, 64)
	if err != nil || total < 0 || strconv.FormatInt(total, 10) != value {
		return 0, errInvalidForgeResponse
	}
	if uint64(page)*uint64(limit) >= uint64(total) {
		return 0, nil
	}
	if page == 10000 {
		return 0, invalid("Pull request browsing exceeds the 10000-page limit. Increase the page size before continuing.")
	}
	return page + 1, nil
}

func (s *Server) withRepositoryRead(ctx context.Context, value string, token forgeCredential, key repositoryKey, operation func(string, Repository) error) error {
	base, err := repositoryPath(key)
	if err != nil {
		return err
	}
	return s.withForgeCaller(ctx, value, token, func(User) error {
		repo, err := s.readRepository(ctx, base, token)
		if err != nil {
			return err
		}
		if !strings.EqualFold(repo.FullName, key.Owner+"/"+key.Name) || repo.HTMLURL == "" {
			return errInvalidForgeResponse
		}
		if err := operation(base, repo); err != nil {
			return err
		}
		// Recheck repository permission/binding after provider waits. This is a
		// read boundary, not a claim to lock provider membership or repository state.
		after, err := s.readRepository(ctx, base, token)
		if err != nil {
			return err
		}
		if after.ID != repo.ID || !strings.EqualFold(after.FullName, repo.FullName) {
			return errInvalidForgeResponse
		}
		return nil
	})
}

func (s *Server) readPull(ctx context.Context, token forgeCredential, base string, repo Repository, number uint32) (forgePull, error) {
	var row forgePull
	_, err := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatUint(uint64(number), 10), token, nil, &row)
	if err == nil && (!validPull(row, repo) || row.Number != int64(number)) {
		err = errInvalidForgeResponse
	}
	return row, err
}

func (s *Server) listPullRequests(ctx context.Context, value string, token forgeCredential, key repositoryKey, state golfv1.IssueState, paging pageRequest) ([]*golfv1.PullRequest, uint32, error) {
	filter, err := pullState(state)
	if err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var result []*golfv1.PullRequest
	var next uint32
	err = s.withRepositoryRead(ctx, value, token, key, func(base string, repo Repository) error {
		return s.withNativePageSize(ctx, token, limit, func(limit uint32) error {
			query := pageQuery(page, limit)
			query.Set("state", filter)
			query.Set("sort", "recentupdate")
			var rows []forgePull
			headers, err := s.forge(ctx, http.MethodGet, base+"/pulls?"+query.Encode(), token, nil, &rows)
			if err != nil {
				return err
			}
			if rows == nil {
				return errInvalidForgeResponse
			}
			if len(rows) > int(limit) {
				return errForgeResponseTooLarge
			}
			seenID, seenNumber := map[int64]bool{}, map[int64]bool{}
			for _, row := range rows {
				if !validPull(row, repo) || seenID[row.ID] || seenNumber[row.Number] || (filter != "all" && row.State != filter) {
					return errInvalidForgeResponse
				}
				seenID[row.ID], seenNumber[row.Number] = true, true
				result = append(result, wirePull(row, true))
			}
			next, err = pullNextPage(headers, page, limit)
			return err
		})
	})
	if err != nil {
		return nil, 0, err
	}
	return result, next, nil
}

func (s *Server) getPullRequest(ctx context.Context, value string, token forgeCredential, key repositoryKey, number uint32) (*golfv1.PullRequest, error) {
	if err := pullNumber(number); err != nil {
		return nil, err
	}
	var result *golfv1.PullRequest
	err := s.withRepositoryRead(ctx, value, token, key, func(base string, repo Repository) error {
		row, err := s.readPull(ctx, token, base, repo, number)
		if err == nil {
			result = wirePull(row, false)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) listPullRequestReviews(ctx context.Context, value string, token forgeCredential, key repositoryKey, number uint32, paging pageRequest) ([]*golfv1.PullRequestReview, uint32, error) {
	if err := pullNumber(number); err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var result []*golfv1.PullRequestReview
	var next uint32
	err = s.withRepositoryRead(ctx, value, token, key, func(base string, repo Repository) error {
		return s.withNativePageSize(ctx, token, limit, func(limit uint32) error {
			pull, err := s.readPull(ctx, token, base, repo, number)
			if err != nil {
				return err
			}
			var rows []forgePullReview
			headers, err := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatUint(uint64(number), 10)+"/reviews?"+pageQuery(page, limit).Encode(), token, nil, &rows)
			if err != nil {
				return err
			}
			if rows == nil {
				return errInvalidForgeResponse
			}
			if len(rows) > int(limit) {
				return errForgeResponseTooLarge
			}
			seen := map[int64]bool{}
			for _, row := range rows {
				state := pullReviewState(row.State)
				if row.ID <= 0 || seen[row.ID] || !validPullUser(row.User) || state == golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_UNSPECIFIED ||
					(row.CommitID != "" && !objectID.MatchString(row.CommitID)) || !validPullTime(row.SubmittedAt) || !validPullTime(row.UpdatedAt) || row.PullRequestURL != pull.HTMLURL {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				result = append(result, wirePullReview(row))
			}
			next, err = pullNextPage(headers, page, limit)
			return err
		})
	})
	if err != nil {
		return nil, 0, err
	}
	return result, next, nil
}
