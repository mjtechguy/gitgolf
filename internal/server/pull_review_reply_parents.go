package server

import (
	"context"
	"strconv"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// The native API does not expose reply ancestry. Only a completed Golf reply
// receipt can establish a parent, and only while both native IDs remain visible.
// External comments at an identical path/line are never inferred to be replies.
func (s *Server) enrichReviewReplyParents(ctx context.Context, repoID, pullID int64, number uint32, review forgePullReview, comments []*golfv1.PullRequestReviewComment) error {
	if review.State == "PENDING" || len(comments) == 0 {
		return nil
	}
	visible := make(map[string]*golfv1.PullRequestReviewComment, len(comments))
	ids := make([]int64, 0, len(comments))
	for _, row := range comments {
		visible[row.Id] = row
		ids = append(ids, mustDiscussionID(row.Id))
	}
	rows, e := s.db.QueryContext(ctx, `SELECT `+reviewCommentColumns+` FROM golf_pull_review_comment_operations WHERE forge_url=$1 AND repository_id=$2 AND phase='SUCCEEDED' AND observed_reply_id=ANY($3::bigint[]) ORDER BY id LIMIT 101`, s.config.GiteaURL, repoID, ids)
	if e != nil {
		return errStorageUnavailable
	}
	defer rows.Close()
	seen := map[int64]bool{}
	count := 0
	for rows.Next() {
		count++
		if count > 100 {
			return errStorageUnavailable
		}
		record, e := scanReviewComment(rows)
		if e != nil {
			return errStorageUnavailable
		}
		m, e := reviewCommentOriginal(record)
		if e != nil {
			return e
		}
		child := visible[strconv.FormatInt(record.ReplyID, 10)]
		parent := visible[m.CommentId]
		if m.ReplyBodyHash == "" || m.RepositoryId != strconv.FormatInt(repoID, 10) || m.PullRequestId != strconv.FormatInt(pullID, 10) || m.Number != number || m.ReviewId != strconv.FormatInt(review.ID, 10) || m.ReviewCommitId != review.CommitID || child == nil || parent == nil || child.Id == parent.Id || child.User == nil || child.User.Id != strconv.FormatInt(record.ActorID, 10) || child.Path != parent.Path || child.OldLine != parent.OldLine || child.NewLine != parent.NewLine {
			continue
		}
		if seen[record.ReplyID] {
			return errStorageUnavailable
		}
		seen[record.ReplyID] = true
		child.ReplyToCommentId = parent.Id
	}
	if rows.Err() != nil {
		return errStorageUnavailable
	}
	return nil
}
