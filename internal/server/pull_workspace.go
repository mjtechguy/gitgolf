package server

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Both native endpoints use retained PR objects. Verify that reference as well
// as the displayed metadata around every page. These are observations, not an
// atomic native lock or proof of provider-internal comparison completeness.
func (s *Server) withPullSelection(ctx context.Context, session string, token forgeCredential, selected *golfv1.PullRequestSelection, operation func(string, Repository) error) error {
	repoID, err := discussionID(selected.GetRepositoryId())
	if err != nil {
		return err
	}
	pullID, err := discussionID(selected.GetPullRequestId())
	if err != nil {
		return err
	}
	if err := pullNumber(selected.GetNumber()); err != nil {
		return err
	}
	head, baseID := selected.GetHeadCommitId(), selected.GetBaseCommitId()
	if !objectID.MatchString(head) || !objectID.MatchString(baseID) || len(head) != len(baseID) {
		return invalid("Select full lowercase PR base and head commit IDs.")
	}
	return s.withRepositoryRead(ctx, session, token, keyFrom(selected.GetRepository()), func(base string, repo Repository) error {
		if repo.ID != repoID {
			return errPullSnapshotChanged
		}
		before, err := s.readPull(ctx, token, base, repo, selected.Number)
		if err != nil {
			return err
		}
		if before.ID != pullID || before.Base.SHA != baseID || before.Head.SHA != head {
			return errPullSnapshotChanged
		}
		retained := func() error {
			rows, _, err := s.readCommits(ctx, base, token, "refs/pull/"+strconv.FormatUint(uint64(selected.Number), 10)+"/head", 1, 1)
			if err != nil {
				return err
			}
			if len(rows) != 1 || rows[0].SHA != head {
				return errPullSnapshotChanged
			}
			return nil
		}
		if err = retained(); err != nil {
			return err
		}
		if err = operation(base, repo); err != nil {
			return err
		}
		if err = retained(); err != nil {
			return err
		}
		after, err := s.readPull(ctx, token, base, repo, selected.Number)
		if err != nil {
			return err
		}
		if after.ID != before.ID || after.Base.SHA != baseID || after.Head.SHA != head || after.Base.Ref != before.Base.Ref || after.Head.Ref != before.Head.Ref || after.Head.RepositoryID != before.Head.RepositoryID || after.State != before.State || *after.Merged != *before.Merged {
			return errPullSnapshotChanged
		}
		return nil
	})
}

type forgePullCommit struct {
	forgeCommit
	HTMLURL string `json:"html_url"`
}

func (s *Server) ListPullRequestCommits(ctx context.Context, req *connect.Request[golfv1.ListPullRequestCommitsRequest]) (*connect.Response[golfv1.ListPullRequestCommitsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.ListPullRequestCommitsResponse{Selection: req.Msg.Selection}
	err = s.withPullSelection(ctx, s.cookieValue(req.Header()), token, req.Msg.Selection, func(base string, repo Repository) error {
		query := pageQuery(page, limit)
		query.Set("files", "false")
		query.Set("verification", "false")
		var rows []forgePullCommit
		headers, err := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatUint(uint64(req.Msg.Selection.Number), 10)+"/commits?"+query.Encode(), token, nil, &rows)
		if err != nil {
			return err
		}
		if rows == nil {
			return errInvalidForgeResponse
		}
		if len(rows) > int(limit) {
			return errForgeResponseTooLarge
		}
		seen := map[string]bool{}
		for _, row := range rows {
			if !objectID.MatchString(row.SHA) || len(row.SHA) != len(req.Msg.Selection.HeadCommitId) || seen[row.SHA] || !validCommitURL(row.HTMLURL, repo.HTMLURL, row.SHA) || !validPullTime(row.Commit.Author.Date) || !discussionText(row.Commit.Message, 256<<10) || !utf8.ValidString(row.Commit.Author.Name) || len(row.Commit.Author.Name) > 1024 || strings.IndexFunc(row.Commit.Author.Name, unicode.IsControl) >= 0 {
				return errInvalidForgeResponse
			}
			seen[row.SHA] = true
			result.Commits = append(result.Commits, &golfv1.Commit{Sha: row.SHA, Message: row.Commit.Message, AuthorName: row.Commit.Author.Name, AuthoredAt: row.Commit.Author.Date})
		}
		next, err := pullNextPage(headers, page, limit)
		result.Page = wirePage(next)
		return err
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

type forgeReportedCheck struct {
	ID          int64  `json:"id"`
	Context     string `json:"context"`
	State       string `json:"status"`
	Description string `json:"description"`
	Creator     *User  `json:"creator"`
	Created     string `json:"created_at"`
	Updated     string `json:"updated_at"`
	TargetURL   string `json:"target_url"`
}

func reportedCheckState(value string) golfv1.ReportedCheckState {
	switch value {
	case "pending":
		return golfv1.ReportedCheckState_REPORTED_CHECK_STATE_PENDING
	case "success":
		return golfv1.ReportedCheckState_REPORTED_CHECK_STATE_SUCCESS
	case "failure":
		return golfv1.ReportedCheckState_REPORTED_CHECK_STATE_FAILURE
	case "error":
		return golfv1.ReportedCheckState_REPORTED_CHECK_STATE_ERROR
	case "warning":
		return golfv1.ReportedCheckState_REPORTED_CHECK_STATE_WARNING
	case "skipped":
		return golfv1.ReportedCheckState_REPORTED_CHECK_STATE_SKIPPED
	}
	return golfv1.ReportedCheckState_REPORTED_CHECK_STATE_UNSPECIFIED
}

// Link metadata is never a fetch destination and refuses userinfo credentials.
func reportedCheckLink(value string) string {
	u, err := url.Parse(value)
	if err != nil || len(value) > 2048 || !utf8.ValidString(value) || strings.IndexFunc(value, unicode.IsControl) >= 0 || u.User != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return value
}
func (s *Server) ListPullRequestChecks(ctx context.Context, req *connect.Request[golfv1.ListPullRequestChecksRequest]) (*connect.Response[golfv1.ListPullRequestChecksResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.ListPullRequestChecksResponse{Selection: req.Msg.Selection}
	err = s.withPullSelection(ctx, s.cookieValue(req.Header()), token, req.Msg.Selection, func(base string, repo Repository) error {
		var combined struct {
			SHA        string               `json:"sha"`
			Repository *Repository          `json:"repository"`
			Statuses   []forgeReportedCheck `json:"statuses"`
		}
		headers, err := s.forge(ctx, http.MethodGet, base+"/commits/"+req.Msg.Selection.HeadCommitId+"/status?"+pageQuery(page, limit).Encode(), token, nil, &combined)
		if err != nil {
			return err
		}
		if combined.SHA != req.Msg.Selection.HeadCommitId || combined.Repository == nil || combined.Repository.ID != repo.ID || !strings.EqualFold(combined.Repository.FullName, repo.FullName) {
			return errInvalidForgeResponse
		}
		if len(combined.Statuses) > int(limit) {
			return errForgeResponseTooLarge
		}
		next, err := pullNextPage(headers, page, limit)
		if err != nil {
			return err
		}
		if combined.Statuses == nil && headers.Get("X-Total-Count") != "0" {
			return errInvalidForgeResponse
		}
		seenIDs, seenContexts := map[int64]bool{}, map[string]bool{}
		for _, row := range combined.Statuses {
			state := reportedCheckState(row.State)
			if row.ID <= 0 || seenIDs[row.ID] || seenContexts[row.Context] || state == golfv1.ReportedCheckState_REPORTED_CHECK_STATE_UNSPECIFIED || row.Context == "" || len(row.Context) > 255 || !utf8.ValidString(row.Context) || strings.IndexFunc(row.Context, unicode.IsControl) >= 0 || !discussionText(row.Description, 4096) || !validPullUser(row.Creator) || !validPullTime(row.Created) || !validPullTime(row.Updated) {
				return errInvalidForgeResponse
			}
			seenIDs[row.ID], seenContexts[row.Context] = true, true
			result.Checks = append(result.Checks, &golfv1.ReportedCheck{Id: strconv.FormatInt(row.ID, 10), Context: row.Context, State: state, Description: row.Description, Creator: wirePullUser(row.Creator), CreatedAt: row.Created, UpdatedAt: row.Updated, TargetUrl: reportedCheckLink(row.TargetURL)})
		}
		// Native state/total_count describe only this returned page. Do not convert
		// them into a global aggregate or protected merge-readiness decision.
		result.Page = wirePage(next)
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
