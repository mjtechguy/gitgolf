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

type discussionIssue struct {
	forgeIssue
	Repository *struct {
		ID int64 `json:"id"`
	} `json:"repository"`
}

type forgeIssueComment struct {
	ID             int64  `json:"id"`
	User           *User  `json:"user"`
	Body           string `json:"body"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
	HTMLURL        string `json:"html_url"`
	IssueURL       string `json:"issue_url"`
	PullRequestURL string `json:"pull_request_url"`
}

func discussionID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
		return 0, invalid("Expected repository and issue IDs must be canonical positive decimal identifiers.")
	}
	return id, nil
}

func discussionText(value string, limit int) bool {
	return len(value) <= limit && utf8.ValidString(value) && strings.IndexFunc(value, func(r rune) bool { return unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r' }) < 0
}

// Gitea's issue_url is an HTML URL despite its schema comment. The origin may
// differ for internal/public requests. Bind escaped paths and explicit fragment,
// never follow provider URLs or treat a display URL as an immutable issue ID.
func discussionURL(value, repoURL, suffix, fragment string) bool {
	u, err := url.Parse(value)
	repo, repoErr := url.Parse(repoURL)
	if err != nil || repoErr != nil {
		return false
	}
	for _, entry := range []*url.URL{u, repo} {
		if (entry.Scheme != "http" && entry.Scheme != "https") || entry.Host == "" || entry.User != nil || entry.RawQuery != "" || entry.ForceQuery {
			return false
		}
	}
	return repo.Fragment == "" && u.Fragment == fragment && u.EscapedPath() == strings.TrimRight(repo.EscapedPath(), "/")+suffix
}

func issueSuffix(number int64) string { return "/issues/" + strconv.FormatInt(number, 10) }

type pullDiscussionKey struct{}

func isPullDiscussion(ctx context.Context) bool {
	value, _ := ctx.Value(pullDiscussionKey{}).(bool)
	return value
}
func discussionSuffix(number int64, pull bool) string {
	if pull {
		return "/pulls/" + strconv.FormatInt(number, 10)
	}
	return issueSuffix(number)
}
func validDiscussionIssue(issue discussionIssue, repo Repository, number uint32, pull ...bool) bool {
	expected := len(pull) > 0 && pull[0]
	return validIssue(issue.Issue) && issue.Number == int64(number) && issue.isPullRequest() == expected &&
		issue.Repository != nil && issue.Repository.ID == repo.ID &&
		discussionText(issue.Title, 1024) && discussionText(issue.Body, 256<<10) && validPullTime(issue.CreatedAt) && validPullTime(issue.UpdatedAt) &&
		discussionURL(issue.HTMLURL, repo.HTMLURL, discussionSuffix(issue.Number, expected), "")
}

func (s *Server) readDiscussionIssue(ctx context.Context, token forgeCredential, base string, repo Repository, number uint32) (discussionIssue, error) {
	var issue discussionIssue
	_, err := s.forge(ctx, http.MethodGet, base+issueSuffix(int64(number)), token, nil, &issue)
	if err != nil {
		return issue, err
	}
	if issue.isPullRequest() != isPullDiscussion(ctx) {
		return issue, errResourceNotFound
	}
	if len(issue.Body) > 256<<10 || len(issue.Title) > 1024 {
		return issue, errForgeResponseTooLarge
	}
	if !validDiscussionIssue(issue, repo, number, isPullDiscussion(ctx)) {
		return issue, errInvalidForgeResponse
	}
	return issue, nil
}

func validIssueComment(comment forgeIssueComment, repo Repository, number uint32, pull ...bool) bool {
	expected := len(pull) > 0 && pull[0]
	suffix := discussionSuffix(int64(number), expected)
	association := comment.PullRequestURL == "" && discussionURL(comment.IssueURL, repo.HTMLURL, issueSuffix(int64(number)), "")
	if expected {
		association = (comment.IssueURL == "" || discussionURL(comment.IssueURL, repo.HTMLURL, suffix, "") || discussionURL(comment.IssueURL, repo.HTMLURL, issueSuffix(int64(number)), "")) && discussionURL(comment.PullRequestURL, repo.HTMLURL, suffix, "")
	}

	return comment.ID > 0 && validPullUser(comment.User) && discussionText(comment.Body, 256<<10) && validPullTime(comment.CreatedAt) && validPullTime(comment.UpdatedAt) &&
		association &&
		discussionURL(comment.HTMLURL, repo.HTMLURL, suffix, "issuecomment-"+strconv.FormatInt(comment.ID, 10))
}

func wireIssueComment(comment forgeIssueComment) *golfv1.IssueComment {
	return &golfv1.IssueComment{Id: strconv.FormatInt(comment.ID, 10), User: wirePullUser(comment.User), Body: comment.Body, CreatedAt: comment.CreatedAt, UpdatedAt: comment.UpdatedAt, HtmlUrl: comment.HTMLURL, Revision: commentRevision(comment)}
}

func (s *Server) readDiscussionComment(ctx context.Context, token forgeCredential, base string, repo Repository, number uint32, id int64) (forgeIssueComment, error) {
	var comment forgeIssueComment
	_, err := s.forge(ctx, http.MethodGet, base+"/issues/comments/"+strconv.FormatInt(id, 10), token, nil, &comment)
	if err == nil && len(comment.Body) > 256<<10 {
		return comment, errForgeResponseTooLarge
	}
	if err == nil && (comment.ID != id || !validIssueComment(comment, repo, number, isPullDiscussion(ctx))) {
		err = errInvalidForgeResponse
	}
	return comment, err
}

func (s *Server) listIssueComments(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, issueID int64, number uint32, paging pageRequest) ([]*golfv1.IssueComment, uint32, error) {
	if number == 0 || number > 2147483647 {
		return nil, 0, invalid("Issue number must be 1–2147483647.")
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var result []*golfv1.IssueComment
	var next uint32
	err = s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		return s.withNativePageSize(ctx, token, limit, func(limit uint32) error {
			if repo.ID != repoID {
				return errIssueTargetChanged
			}
			before, err := s.readDiscussionIssue(ctx, token, base, repo, number)
			if err != nil {
				return err
			}
			if before.ID != issueID {
				return errIssueTargetChanged
			}
			var comments []forgeIssueComment
			headers, err := s.forge(ctx, http.MethodGet, base+"/issues/comments?"+pageQuery(page, limit).Encode(), token, nil, &comments)
			if err != nil {
				return err
			}
			if len(comments) > int(limit) {
				return errForgeResponseTooLarge
			}
			next, err = pullNextPage(headers, page, limit)
			if err != nil {
				return err
			}
			seen := map[int64]bool{}
			actor, actorErr := s.currentUser(ctx, token)
			writer, writerErr := s.milestoneEditAuthority(ctx, token, base, repo)
			unitActive, activeErr := s.activeDiscussionUnit(ctx, token, base, repo, isPullDiscussion(ctx))
			_, delegated := ctx.Value(apiAuthKey{}).(apiAuth)
			canObserveEdit := !delegated && actorErr == nil && writerErr == nil && activeErr == nil && unitActive
			for _, comment := range comments {
				if comment.ID <= 0 || seen[comment.ID] {
					return errInvalidForgeResponse
				}
				seen[comment.ID] = true
				// Exactly one native repository-wide page. Unrelated issues and PRs
				// never enter Golf's response; an empty filtered page may advance.
				related := discussionURL(comment.IssueURL, repo.HTMLURL, issueSuffix(int64(number)), "")
				if isPullDiscussion(ctx) {
					related = discussionURL(comment.PullRequestURL, repo.HTMLURL, discussionSuffix(int64(number), true), "")
				}
				if !related {
					continue
				}

				if len(comment.Body) > 256<<10 {
					return errForgeResponseTooLarge
				}
				if !validIssueComment(comment, repo, number, isPullDiscussion(ctx)) {
					return errInvalidForgeResponse
				}
				wire := wireIssueComment(comment)
				wire.CanEdit = canObserveEdit && comment.User != nil && comment.User.ID > 0 && (writer || comment.User.ID == actor.ID)
				wire.CanDelete = wire.CanEdit
				result = append(result, wire)
			}
			after, err := s.readDiscussionIssue(ctx, token, base, repo, number)
			if err != nil {
				return err
			}
			if after.ID != issueID {
				return errIssueTargetChanged
			}
			afterWriter, afterWriterErr := s.milestoneEditAuthority(ctx, token, base, repo)
			afterActive, afterActiveErr := s.activeDiscussionUnit(ctx, token, base, repo, isPullDiscussion(ctx))
			afterActor, afterActorErr := s.currentUser(ctx, token)
			if afterWriterErr != nil || afterActiveErr != nil || afterActorErr != nil || afterWriter != writer || !afterActive || afterActor.ID != actor.ID {
				for _, row := range result {
					row.CanEdit = false
					row.CanDelete = false
				}
			}
			return nil
		})
	})
	if err != nil {
		return nil, 0, err
	}
	return result, next, nil
}

func (s *Server) ListIssueComments(ctx context.Context, req *connect.Request[golfv1.ListIssueCommentsRequest]) (*connect.Response[golfv1.ListIssueCommentsResponse], error) {
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
	ctx = context.WithValue(ctx, pullDiscussionKey{}, req.Msg.PullRequest)
	rows, next, err := s.listIssueComments(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), repoID, issueID, req.Msg.Number, pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.ListIssueCommentsResponse{Comments: rows, Page: wirePage(next)}), nil
}

func (s *Server) GetPullRequestDiscussion(ctx context.Context, req *connect.Request[golfv1.GetPullRequestDiscussionRequest]) (*connect.Response[golfv1.GetPullRequestDiscussionResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	if e = pullNumber(req.Msg.Number); e != nil {
		return nil, rpcError(e)
	}
	ctx = context.WithValue(ctx, pullDiscussionKey{}, true)
	var issue discussionIssue
	e = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(req.Msg.Repository), func(base string, repo Repository) error {
		var err error
		issue, err = s.readDiscussionIssue(ctx, token, base, repo, req.Msg.Number)
		return err
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetPullRequestDiscussionResponse{Issue: wireIssue(issue.Issue)}), nil
}
