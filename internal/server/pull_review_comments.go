package server

import (
	"context"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

const maxPullReviewComments = 100

type forgePullReviewComment struct {
	ID               int64  `json:"id"`
	User             *User  `json:"user"`
	Resolver         *User  `json:"resolver"`
	Body             string `json:"body"`
	Path             string `json:"path"`
	Position         uint64 `json:"position"`
	OriginalPosition uint64 `json:"original_position"`
	ReviewID         int64  `json:"pull_request_review_id"`
	CommitID         string `json:"commit_id"`
	OriginalCommitID string `json:"original_commit_id"`
	DiffHunk         string `json:"diff_hunk"`
	CreatedAt        string `json:"created_at"`
	UpdatedAt        string `json:"updated_at"`
	HTMLURL          string `json:"html_url"`
	PullRequestURL   string `json:"pull_request_url"`
}

func (s *Server) getPullRequestReviewComments(ctx context.Context, session string, token forgeCredential, m *golfv1.GetPullRequestReviewCommentsRequest) (*golfv1.GetPullRequestReviewCommentsResponse, error) {
	repoID, err := discussionID(m.RepositoryId)
	if err != nil {
		return nil, err
	}
	pullID, err := discussionID(m.PullRequestId)
	if err != nil {
		return nil, err
	}
	reviewID, err := discussionID(m.ReviewId)
	if err != nil {
		return nil, err
	}
	if err = pullNumber(m.Number); err != nil {
		return nil, err
	}
	if !objectID.MatchString(m.ReviewCommitId) {
		return nil, invalid("Select the full lowercase reviewed commit ID.")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetPullRequestReviewCommentsResponse
	err = s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		if repo.ID != repoID {
			return errIssueTargetChanged
		}
		pull, err := s.readPull(ctx, token, base, repo, m.Number)
		if err != nil {
			return err
		}
		if pull.ID != pullID {
			return errIssueTargetChanged
		}
		caller, err := s.currentUser(ctx, token)
		if err != nil {
			return err
		}
		route := base + "/pulls/" + strconv.FormatUint(uint64(m.Number), 10) + "/reviews/" + m.ReviewId
		readReview := func() (forgePullReview, error) {
			var row forgePullReview
			_, e := s.forge(ctx, http.MethodGet, route, token, nil, &row)
			if e != nil {
				return row, e
			}
			if row.ID != reviewID || row.CommitID != m.ReviewCommitId || row.PullRequestURL != pull.HTMLURL || !validPullUser(row.User) || pullReviewState(row.State) == golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_UNSPECIFIED || !validPullTime(row.SubmittedAt) || !validPullTime(row.UpdatedAt) || !discussionText(row.Body, 256<<10) || row.CommentsCount == nil || *row.CommentsCount < 0 {
				return row, errInvalidForgeResponse
			}
			if row.State == "PENDING" && (row.User == nil || row.User.ID != caller.ID) {
				return row, errResourceNotFound
			}
			if *row.CommentsCount > maxPullReviewComments {
				return row, errForgeResponseTooLarge
			}
			return row, nil
		}
		before, err := readReview()
		if err != nil {
			return err
		}
		var rows []forgePullReviewComment
		// This native endpoint ignores page/limit. Read the entire bounded array;
		// never fabricate pagination or truncate a partially visible conversation.
		_, err = s.forge(ctx, http.MethodGet, route+"/comments", token, nil, &rows)
		if err != nil {
			return err
		}
		if len(rows) > maxPullReviewComments {
			return errForgeResponseTooLarge
		}
		if rows == nil || int64(len(rows)) != *before.CommentsCount {
			return errInvalidForgeResponse
		}
		seen := map[int64]bool{}
		for _, row := range rows {
			if row.ID <= 0 || seen[row.ID] || row.ReviewID != reviewID || !validPullUser(row.User) || !validPullUser(row.Resolver) || !discussionText(row.Body, 256<<10) || row.Path == "" || !validSourcePath(row.Path) || (row.Position == 0) == (row.OriginalPosition == 0) || row.Position > 2147483647 || row.OriginalPosition > 2147483647 || row.CommitID != "" && !objectID.MatchString(row.CommitID) || row.OriginalCommitID != "" && !objectID.MatchString(row.OriginalCommitID) || !discussionText(row.DiffHunk, 64<<10) || !validPullTime(row.CreatedAt) || !validPullTime(row.UpdatedAt) || row.PullRequestURL != pull.HTMLURL {
				return errInvalidForgeResponse
			}
			fragment := "issuecomment-" + strconv.FormatInt(row.ID, 10)
			suffix := "/pulls/" + strconv.FormatUint(uint64(m.Number), 10)
			if !discussionURL(row.HTMLURL, repo.HTMLURL, suffix, fragment) && !discussionURL(row.HTMLURL, repo.HTMLURL, suffix+"/files", fragment) {
				return errInvalidForgeResponse
			}
			seen[row.ID] = true
		}
		after, err := readReview()
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, after) {
			return errPullSnapshotChanged
		}
		afterPull, err := s.readPull(ctx, token, base, repo, m.Number)
		if err != nil {
			return err
		}
		if afterPull.ID != pullID {
			return errIssueTargetChanged
		}
		// Native map traversal is not ordering. Stable creation/ID order preserves
		// distinct authors at the same location without inventing reply relations.
		sort.Slice(rows, func(i, j int) bool {
			a, _ := time.Parse(time.RFC3339Nano, rows[i].CreatedAt)
			b, _ := time.Parse(time.RFC3339Nano, rows[j].CreatedAt)
			if a.Equal(b) {
				return rows[i].ID < rows[j].ID
			}
			return a.Before(b)
		})
		result = &golfv1.GetPullRequestReviewCommentsResponse{RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Review: wirePullReview(after), CurrentHeadCommitId: afterPull.Head.SHA}
		for _, row := range rows {
			result.Comments = append(result.Comments, &golfv1.PullRequestReviewComment{Id: strconv.FormatInt(row.ID, 10), User: wirePullUser(row.User), Resolver: wirePullUser(row.Resolver), Body: row.Body, Path: row.Path, OldLine: uint32(row.OriginalPosition), NewLine: uint32(row.Position), ReviewId: m.ReviewId, CommitId: row.CommitID, OriginalCommitId: row.OriginalCommitID, DiffHunk: row.DiffHunk, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, HtmlUrl: row.HTMLURL, Resolved: row.Resolver != nil})
		}
		if err := s.enrichReviewReplyParents(ctx, repoID, pullID, m.Number, after, result.Comments); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) GetPullRequestReviewComments(ctx context.Context, req *connect.Request[golfv1.GetPullRequestReviewCommentsRequest]) (*connect.Response[golfv1.GetPullRequestReviewCommentsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.getPullRequestReviewComments(ctx, s.cookieValue(req.Header()), token, req.Msg)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
