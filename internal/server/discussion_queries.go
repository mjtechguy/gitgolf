package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/gitinput"
	"golang.org/x/sync/errgroup"
)

func nonemptyDiscussionQuery(q *golfv1.DiscussionQuery) bool {
	return q != nil && (q.Search != "" || q.Author != "" || q.Assignee != "" || len(q.LabelNames) != 0 || q.MilestoneTitle != "")
}

func validateDiscussionQuery(q *golfv1.DiscussionQuery) error {
	if q == nil {
		return nil
	}
	text := func(value string, max int, comma bool) bool {
		if len(value) > max || !utf8.ValidString(value) || strings.TrimSpace(value) != value || comma && strings.Contains(value, ",") {
			return false
		}
		for _, r := range value {
			if unicode.IsControl(r) {
				return false
			}
		}
		return true
	}
	if !text(q.Search, 512, false) || !text(q.MilestoneTitle, 255, true) || len(q.LabelNames) > 20 {
		return invalid("Discussion search must be bounded text; milestone titles cannot contain commas; select at most 20 labels.")
	}
	for _, login := range []string{q.Author, q.Assignee} {
		if login != "" && !repositoryName.MatchString(login) {
			return invalid("Discussion author and assignee must be valid account usernames.")
		}
	}
	seen := map[string]bool{}
	for _, name := range q.LabelNames {
		if name == "" || !text(name, 255, true) || seen[name] {
			return invalid("Discussion label names must be distinct nonempty bounded text without commas.")
		}
		seen[name] = true
	}
	return nil
}

func applyDiscussionQuery(values url.Values, q *golfv1.DiscussionQuery) {
	if q == nil {
		return
	}
	for key, value := range map[string]string{"q": q.Search, "created_by": q.Author, "assigned_by": q.Assignee, "labels": strings.Join(q.LabelNames, ","), "milestones": q.MilestoneTitle} {
		if value != "" {
			values.Set(key, value)
		}
	}
}

// Native ignores unknown label/milestone names. Never broaden a requested filter:
// preserve its continuation, but withhold rows whose current metadata disagrees.
func discussionQueryMatches(q *golfv1.DiscussionQuery, user *golfv1.User, metadata *golfv1.DiscussionMetadata) bool {
	if q == nil {
		return true
	}
	if q.Author != "" && (user == nil || !strings.EqualFold(user.Login, q.Author)) {
		return false
	}
	if q.Assignee != "" {
		found := false
		if metadata != nil && metadata.AssigneesKnown {
			for _, user := range metadata.Assignees {
				found = found || user != nil && strings.EqualFold(user.Login, q.Assignee)
			}
		}
		if !found {
			return false
		}
	}
	if len(q.LabelNames) != 0 {
		if metadata == nil || !metadata.LabelsKnown {
			return false
		}
		for _, name := range q.LabelNames {
			found := false
			for _, label := range metadata.Labels {
				found = found || label != nil && label.Name == name
			}
			if !found {
				return false
			}
		}
	}
	return q.MilestoneTitle == "" || metadata != nil && metadata.MilestoneKnown && metadata.Milestone != nil && metadata.Milestone.Title == q.MilestoneTitle
}

type pullListQuery struct {
	Discussion *golfv1.DiscussionQuery
	Sort       string
	BaseBranch string
}

func (q pullListQuery) validate() error {
	if err := validateDiscussionQuery(q.Discussion); err != nil {
		return err
	}
	if !gitinput.ValidRef(q.BaseBranch) {
		return invalid("Pull request base branch must be a valid ref name.")
	}
	if _, ok := nativePullSort(q.Sort); !ok {
		return invalid("Pull request sort must be newest, oldest, updated, least-updated, most-commented or least-commented.")
	}
	if nonemptyDiscussionQuery(q.Discussion) && q.Sort != "" && q.Sort != "newest" {
		return invalid("Filtered pull request search supports newest-first ordering.")
	}
	return nil
}

func nativePullSort(sort string) (string, bool) {
	value, ok := map[string]string{"": "recentupdate", "newest": "", "oldest": "oldest", "updated": "recentupdate", "least-updated": "leastupdate", "most-commented": "mostcomment", "least-commented": "leastcomment"}[sort]
	return value, ok
}

func (s *Server) searchDiscussionRows(ctx context.Context, token forgeCredential, base string, repo Repository, state string, page, limit uint32, q *golfv1.DiscussionQuery, pull bool) ([]discussionIssue, uint32, error) {
	query := pageQuery(page, limit)
	typeName := "issues"
	if pull {
		typeName = "pulls"
	}
	query.Set("type", typeName)
	query.Set("state", state)
	applyDiscussionQuery(query, q)
	var rows []discussionIssue
	headers, err := s.forge(ctx, http.MethodGet, base+"/issues?"+query.Encode(), token, nil, &rows)
	if err != nil {
		return nil, 0, err
	}
	if rows == nil || len(rows) > int(limit) {
		return nil, 0, errInvalidForgeResponse
	}
	next, err := pullNextPage(headers, page, limit)
	if err != nil {
		return nil, 0, err
	}
	seenID, seenNumber := map[int64]bool{}, map[int64]bool{}
	for _, row := range rows {
		if !validDiscussionIssue(row, repo, uint32(row.Number), pull) || seenID[row.ID] || seenNumber[row.Number] || state != "all" && row.State != state {
			return nil, 0, errInvalidForgeResponse
		}
		seenID[row.ID], seenNumber[row.Number] = true, true
	}
	return rows, next, nil
}

func (s *Server) searchIssues(ctx context.Context, token forgeCredential, base string, repo Repository, state string, paging pageRequest, q *golfv1.DiscussionQuery) ([]Issue, uint32, error) {
	if err := validateDiscussionQuery(q); err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var result []Issue
	var next uint32
	err = s.withNativePageSize(ctx, token, limit, func(effective uint32) error {
		rows, following, err := s.searchDiscussionRows(ctx, token, base, repo, state, page, effective, q, false)
		if err != nil {
			return err
		}
		for _, row := range rows {
			wire := wireIssue(row.Issue)
			if discussionQueryMatches(q, wire.User, wire.Metadata) {
				result = append(result, row.Issue)
			}
		}
		next = following
		return nil
	})
	return result, next, err
}

func (s *Server) searchPullRequests(ctx context.Context, token forgeCredential, base string, repo Repository, state string, page, limit uint32, q pullListQuery) ([]*golfv1.PullRequest, uint32, error) {
	// ponytail: native search hydrates at most 20 rows with four concurrent reads;
	// replace with a qualified bulk projection if measured traffic outgrows this.
	if limit > 20 {
		return nil, 0, invalid("Filtered pull request search supports page sizes up to 20.")
	}
	rows, next, err := s.searchDiscussionRows(ctx, token, base, repo, state, page, limit, q.Discussion, true)
	if err != nil {
		return nil, 0, err
	}
	result := make([]*golfv1.PullRequest, len(rows))
	group, work := errgroup.WithContext(ctx)
	group.SetLimit(4)
	work = context.WithValue(work, pullDiscussionKey{}, true)
	for i, row := range rows {
		group.Go(func() error {
			pull, err := s.readPull(work, token, base, repo, uint32(row.Number))
			if err != nil {
				return err
			}
			// PR IDs and issue IDs belong to separate native sequences.
			after, err := s.readDiscussionIssue(work, token, base, repo, uint32(row.Number))
			if err != nil {
				return err
			}
			if after.ID != row.ID || after.Title != pull.Title || after.Body != pull.Body || after.State != pull.State || after.UpdatedAt != pull.UpdatedAt {
				return errInvalidForgeResponse
			}
			wire := wirePull(pull, true)
			if (state == "all" || pull.State == state) && (q.BaseBranch == "" || pull.Base.Ref == q.BaseBranch) && discussionQueryMatches(q.Discussion, wire.User, wire.Metadata) {
				result[i] = wire
			}
			return nil
		})
	}
	if err = group.Wait(); err != nil {
		return nil, 0, err
	}
	filtered := make([]*golfv1.PullRequest, 0, len(result))
	for _, row := range result {
		if row != nil {
			filtered = append(filtered, row)
		}
	}
	return filtered, next, nil
}
