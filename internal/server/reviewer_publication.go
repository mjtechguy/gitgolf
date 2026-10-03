package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type reviewerPublicationComment struct {
	Path    string `json:"path"`
	NewLine int    `json:"new_position"`
	OldLine int    `json:"old_position"`
	Body    string `json:"body"`
}
type reviewerPublicationInput struct {
	Body     string                       `json:"body"`
	Comments []reviewerPublicationComment `json:"comments"`
	Head     string                       `json:"commit_id"`
	Event    string                       `json:"event"`
}

func reviewerPublicationPayload(p reviewerRecord, r reviewerRunRecord, result reviewResult) reviewerPublicationInput {
	body := "**Golf bot · " + reviewText(p.Config.Name) + "**\n\n" + reviewText(result.Summary) + "\n\nReviewed old side `" + r.MergeBase + "` → head `" + r.Head + "` (target tip `" + r.Base + "`). Read-only review; no tests were executed.\n\n<!-- golf-review:" + r.ID + " -->"
	out := reviewerPublicationInput{Body: body, Head: r.Head, Event: "COMMENT", Comments: []reviewerPublicationComment{}}
	for _, f := range result.Findings {
		out.Comments = append(out.Comments, reviewerPublicationComment{Path: f.Path, NewLine: f.Line, Body: "**" + f.Severity + " · " + reviewText(f.Title) + "**\n\n" + reviewText(f.Evidence) + "\n\nSuggested fix: " + reviewText(f.Suggestion)})
	}
	return out
}
func reviewerPayloadFingerprint(input reviewerPublicationInput) []byte {
	// Native map order is not a receipt. Preserve duplicate multiplicity while
	// comparing the exact body/path/side/line multiset, without guessed IDs.
	input.Comments = append([]reviewerPublicationComment{}, input.Comments...)
	sort.Slice(input.Comments, func(i, j int) bool {
		a, b := input.Comments[i], input.Comments[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.NewLine != b.NewLine {
			return a.NewLine < b.NewLine
		}
		return a.Body < b.Body
	})
	raw, _ := json.Marshal(input)
	sum := sha256.Sum256(raw)
	return sum[:]
}
func (s *Server) reviewerEffectClear(ctx context.Context, p reviewerRecord, number uint32, pullID int64) error {
	var blocked bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_reviewer_runs r JOIN golf_reviewers v ON v.id=r.reviewer_id WHERE v.forge_url=$1 AND v.repository_id=$2 AND r.publisher_id=$3 AND r.pull_number=$4 AND r.legacy_effect_block) OR EXISTS(SELECT 1 FROM golf_reviewer_publications WHERE forge_url=$1 AND repository_id=$2 AND publisher_id=$3 AND pull_request_id=$5 AND state IN ('reserved','dispatch_unknown'))`, s.config.GiteaURL, p.RepoID, p.PublisherID, number, pullID).Scan(&blocked)
	if err != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errExecutionPolicyConflict
	}
	return nil
}
func (s *Server) reserveReviewerPublication(ctx context.Context, p reviewerRecord, r reviewerRunRecord, result reviewResult, input reviewerPublicationInput) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, errStorageUnavailable
	}
	defer tx.Rollback()
	// An advisory transaction lock covers the legacy number-bound exclusions as
	// well as the exact-ID unique index. No timeout releases accepted uncertainty.
	lock := s.config.GiteaURL + "/review-publication/" + strconv.FormatInt(r.RepositoryID, 10) + "/" + strconv.FormatInt(r.PublisherID, 10) + "/" + strconv.FormatInt(r.Number, 10)
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lock); err != nil {
		return false, err
	}
	var blocked bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_reviewer_runs r JOIN golf_reviewers v ON v.id=r.reviewer_id WHERE v.forge_url=$1 AND v.repository_id=$2 AND r.publisher_id=$3 AND r.pull_number=$4 AND r.legacy_effect_block) OR EXISTS(SELECT 1 FROM golf_reviewer_publications WHERE forge_url=$1 AND repository_id=$2 AND publisher_id=$3 AND pull_request_id=$5 AND state IN ('reserved','dispatch_unknown'))`, s.config.GiteaURL, r.RepositoryID, r.PublisherID, r.Number, r.PullID).Scan(&blocked)
	if err != nil {
		return false, err
	}
	if blocked {
		return false, errExecutionPolicyConflict
	}
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_reviewer_publications WHERE run_id=$1)`, r.ID).Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, errExecutionPolicyConflict
	}
	raw, _ := json.Marshal(result)
	updated, err := tx.ExecContext(ctx, `UPDATE golf_reviewer_runs SET findings=$2 WHERE id=$1 AND state IN ('queued','running') AND repository_id=$3 AND pull_request_id=$4 AND publisher_id=$5 AND reviewer_revision=$6`, r.ID, raw, r.RepositoryID, r.PullID, r.PublisherID, p.Revision)
	if err != nil {
		return false, err
	}
	n, _ := updated.RowsAffected()
	if n != 1 {
		return false, errExecutionPolicyConflict
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_reviewer_publications(run_id,forge_url,repository_id,pull_request_id,pull_number,publisher_id,payload_fingerprint,state) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved')`, r.ID, s.config.GiteaURL, r.RepositoryID, r.PullID, r.Number, r.PublisherID, reviewerPayloadFingerprint(input))
	if err != nil {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO golf_reviewer_publication_events(run_id,phase) VALUES($1,'reserved')`, r.ID); err != nil {
		return false, err
	}
	return true, tx.Commit()
}
func (s *Server) advanceReviewerPublication(ctx context.Context, r reviewerRunRecord, phase, reason string, receipt int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var query string
	var args []any
	switch phase {
	case "dispatch_unknown":
		query = `UPDATE golf_reviewer_publications SET state='dispatch_unknown',updated_at=clock_timestamp() WHERE run_id=$1 AND state='reserved'`
		args = []any{r.ID}
	case "receipt":
		query = `UPDATE golf_reviewer_publications SET observed_review_id=$2,updated_at=clock_timestamp() WHERE run_id=$1 AND state='dispatch_unknown' AND observed_review_id IS NULL`
		args = []any{r.ID, receipt}
	case "published":
		query = `UPDATE golf_reviewer_publications SET state='published',updated_at=clock_timestamp() WHERE run_id=$1 AND state='dispatch_unknown' AND observed_review_id=$2`
		args = []any{r.ID, receipt}
	case "rejected":
		query = `UPDATE golf_reviewer_publications SET state='rejected',failure_code=$2,updated_at=clock_timestamp() WHERE run_id=$1 AND state='reserved'`
		args = []any{r.ID, reason}
	default:
		query = `UPDATE golf_reviewer_publications SET failure_code=$2,updated_at=clock_timestamp() WHERE run_id=$1 AND state='dispatch_unknown'`
		args = []any{r.ID, reason}
	}
	updated, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	n, _ := updated.RowsAffected()
	if n != 1 {
		return errExecutionPolicyConflict
	}
	state := "publication_unknown"
	if phase == "dispatch_unknown" {
		state = "publishing"
	}
	if phase == "published" {
		state = "published"
	}
	if phase == "rejected" {
		state = "failed"
	}
	if phase != "receipt" {
		updated, err = tx.ExecContext(ctx, `UPDATE golf_reviewer_runs SET state=$2,reason=$3,review_id=CASE WHEN $4::bigint>0 THEN $4 ELSE review_id END WHERE id=$1 AND state IN ('queued','running','publishing','publication_unknown')`, r.ID, state, reason, receipt)
		if err != nil {
			return err
		}
		n, _ = updated.RowsAffected()
		if n != 1 {
			return errExecutionPolicyConflict
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_reviewer_publication_events(run_id,phase,failure_code,observed_review_id) VALUES($1,$2,$3,NULLIF($4::bigint,0))`, r.ID, phase, reason, receipt)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Server) reviewerBoundComparison(ctx context.Context, p reviewerRecord, r reviewerRunRecord) error {
	a, err := s.reviewerActor(ctx, p)
	if err != nil {
		return err
	}
	caller, err := s.currentUser(ctx, a.Credential)
	if err != nil {
		return err
	}
	login, err := s.createSessionBound(ctx, caller, "local", a.Credential.Token, "", &localLoginBinding{p.LocalID, p.UserID, p.LocalVersion})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		hash, _ := sessionHash(login.Value)
		_, _ = s.db.ExecContext(cleanup, `DELETE FROM golf_sessions WHERE token_hash=$1`, hash)
	}()
	observed, err := s.getPullRequestDiff(ctx, login.Value, a.Credential, &golfv1.GetPullRequestDiffRequest{Repository: p.Config.Repository, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), PullRequestId: strconv.FormatInt(r.PullID, 10), Number: uint32(r.Number), BaseCommitId: r.Base, HeadCommitId: r.Head})
	if err != nil {
		return err
	}
	hash := sha256.Sum256([]byte(observed.RawDiff))
	if observed.MergeBaseCommitId != r.MergeBase || !bytes.Equal(hash[:], r.DiffFingerprint) || observed.RawDiff != r.Diff {
		return errPullSnapshotChanged
	}
	return nil
}
func (s *Server) reviewerPublisherTarget(ctx context.Context, p reviewerRecord, r reviewerRunRecord) (string, Repository, forgePull, error) {
	base, err := repositoryPath(keyFrom(p.Config.Repository))
	if err != nil {
		return "", Repository{}, forgePull{}, err
	}
	publisher, err := s.reviewPublisher(ctx)
	if err != nil || publisher.ID != r.PublisherID {
		return base, Repository{}, forgePull{}, errCodexPermission
	}
	token := forgeCredential{Kind: "pat", Token: s.config.ReviewPublisherToken}
	repo, err := s.readRepository(ctx, base, token)
	if err != nil {
		return base, repo, forgePull{}, err
	}
	if repo.ID != r.RepositoryID {
		return base, repo, forgePull{}, errIssueTargetChanged
	}
	pull, err := s.readPull(ctx, token, base, repo, uint32(r.Number))
	if err != nil {
		return base, repo, pull, err
	}
	if pull.ID != r.PullID || pull.State != "open" || *pull.Draft || *pull.Merged || pull.Base.SHA != r.Base || pull.Head.SHA != r.Head || pull.MergeBase != r.MergeBase {
		return base, repo, pull, errPullSnapshotChanged
	}
	return base, repo, pull, nil
}
func (s *Server) reviewerPending(ctx context.Context, base string, pull forgePull, publisher int64) error {
	token := forgeCredential{Kind: "pat", Token: s.config.ReviewPublisherToken}
	return s.withNativePageSize(ctx, token, 100, func(limit uint32) error {
		total := int64(-1)
		seen := map[int64]bool{}
		for page := uint32(1); page <= 2000; page++ {
			var rows []forgePullReview
			headers, err := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatInt(pull.Number, 10)+"/reviews?"+pageQuery(page, limit).Encode(), token, nil, &rows)
			if err != nil {
				return err
			}
			text := headers.Get("X-Total-Count")
			count, err := strconv.ParseInt(text, 10, 64)
			if err != nil || count < 0 || count > 2000 || strconv.FormatInt(count, 10) != text || total >= 0 && total != count || rows == nil || len(rows) > int(limit) || int64(len(rows)) > count {
				return errInvalidForgeResponse
			}
			total = count
			for _, row := range rows {
				if row.ID <= 0 || seen[row.ID] || row.PullRequestURL != pull.HTMLURL || !validPullUser(row.User) || pullReviewState(row.State) == golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_UNSPECIFIED {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				if row.State == "PENDING" && row.User != nil && row.User.ID == publisher {
					return errExecutionPolicyConflict
				}
			}
			if int64(page)*int64(limit) >= total {
				return nil
			}
		}
		return errInvalidForgeResponse
	})
}
func reviewerHeaderMatches(row forgePullReview, r reviewerRunRecord, pull forgePull, input reviewerPublicationInput) bool {
	return row.ID > 0 && validPullUser(row.User) && row.User != nil && row.User.ID == r.PublisherID && row.PullRequestURL == pull.HTMLURL && row.State == "COMMENT" && row.CommitID == r.Head && !row.Dismissed && row.Body == input.Body && row.CommentsCount != nil && *row.CommentsCount == int64(len(input.Comments)) && validPullTime(row.SubmittedAt) && validPullTime(row.UpdatedAt)
}
func (s *Server) verifyReviewerPublication(ctx context.Context, base string, repo Repository, pull forgePull, r reviewerRunRecord, input reviewerPublicationInput, receipt int64, comparison reviewComparison) error {
	token := forgeCredential{Kind: "pat", Token: s.config.ReviewPublisherToken}
	route := base + "/pulls/" + strconv.FormatInt(r.Number, 10) + "/reviews/" + strconv.FormatInt(receipt, 10)
	read := func() (forgePullReview, error) {
		var row forgePullReview
		_, err := s.forge(ctx, http.MethodGet, route, token, nil, &row)
		if err == nil && (row.ID != receipt || !reviewerHeaderMatches(row, r, pull, input)) {
			err = errInvalidForgeResponse
		}
		return row, err
	}
	before, err := read()
	if err != nil {
		return err
	}
	var children []forgePullReviewComment
	if _, err = s.forge(ctx, http.MethodGet, route+"/comments", token, nil, &children); err != nil {
		return err
	}
	if children == nil || len(children) != len(input.Comments) || len(children) > 10 {
		return errInvalidForgeResponse
	}
	observed := reviewerPublicationInput{Body: before.Body, Event: before.State, Head: before.CommitID, Comments: []reviewerPublicationComment{}}
	seen := map[int64]bool{}
	for _, row := range children {
		if row.ID <= 0 || seen[row.ID] || !validPullUser(row.User) || row.User == nil || row.User.ID != r.PublisherID || !validPullUser(row.Resolver) || row.ReviewID != receipt || row.PullRequestURL != pull.HTMLURL || row.OriginalPosition != 0 || row.Position == 0 || row.Position > 2147483647 || !discussionText(row.Body, 6000) || !discussionText(row.DiffHunk, 64<<10) || row.CommitID != "" && (!objectID.MatchString(row.CommitID) || len(row.CommitID) != len(r.Head)) || row.OriginalCommitID != "" && (!objectID.MatchString(row.OriginalCommitID) || len(row.OriginalCommitID) != len(r.Head)) || !validPullTime(row.CreatedAt) || !validPullTime(row.UpdatedAt) || !comparison.MatchesNativeContext(row.Path, int(row.Position), row.DiffHunk) {
			return errInvalidForgeResponse
		}
		if !discussionURL(row.HTMLURL, repo.HTMLURL, "/pulls/"+strconv.FormatInt(r.Number, 10), "issuecomment-"+strconv.FormatInt(row.ID, 10)) && !discussionURL(row.HTMLURL, repo.HTMLURL, "/pulls/"+strconv.FormatInt(r.Number, 10)+"/files", "issuecomment-"+strconv.FormatInt(row.ID, 10)) {
			return errInvalidForgeResponse
		}
		seen[row.ID] = true
		observed.Comments = append(observed.Comments, reviewerPublicationComment{Path: row.Path, NewLine: int(row.Position), Body: row.Body})
	}
	if !bytes.Equal(reviewerPayloadFingerprint(observed), reviewerPayloadFingerprint(input)) {
		return errInvalidForgeResponse
	}
	after, err := read()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(before, after) {
		return errPullSnapshotChanged
	}
	return nil
}
func (s *Server) publishReviewer(ctx context.Context, p reviewerRecord, r reviewerRunRecord, result reviewResult, authority func(context.Context) error) error {
	hash := sha256.Sum256([]byte(r.Diff))
	if r.RepositoryID != p.RepoID || r.PullID <= 0 || !objectID.MatchString(r.MergeBase) || len(r.MergeBase) != len(r.Head) || !bytes.Equal(hash[:], r.DiffFingerprint) {
		return errExecutionPolicyConflict
	}
	comparison, err := parseReviewComparison(r.Diff)
	if err != nil {
		return err
	}
	for _, finding := range result.Findings {
		if !comparison.Allows(finding.Path, finding.Line) {
			return errInvalidForgeResponse
		}
	}
	input := reviewerPublicationPayload(p, r, result)
	// Escaping is part of the native input. Raw finding limits alone do not
	// guarantee that the final payload can pass independent receipt validation.
	if !discussionText(input.Body, 256<<10) || len(input.Comments) > 10 {
		return errInvalidForgeResponse
	}
	for _, comment := range input.Comments {
		if !discussionText(comment.Body, 6000) {
			return errInvalidForgeResponse
		}
	}
	// Bound the complete intended child receipt transport, including default
	// JSON escaping of every possible retained native hunk. The metadata reserve
	// covers the current native profile, not arbitrary external user-envelope
	// edits; unanticipated oversized metadata still fails closed after dispatch.
	encoded, err := json.Marshal(input)
	if err != nil {
		return errInvalidForgeResponse
	}
	receiptBudget := len(encoded) + (len(input.Comments)+1)*(16<<10)
	for _, comment := range input.Comments {
		contextBytes, supported := comparison.NativeContextJSONBound(comment.Path, comment.NewLine)
		if !supported || contextBytes > maxForgeResponse-receiptBudget {
			return errInvalidForgeResponse
		}
		receiptBudget += contextBytes
	}
	if receiptBudget > maxForgeResponse {
		return errInvalidForgeResponse
	}
	owned, err := s.reserveReviewerPublication(ctx, p, r, result, input)
	if err != nil || !owned {
		return err
	}
	finish := func(phase, reason string, id int64) error {
		c, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		return s.advanceReviewerPublication(c, r, phase, reason, id)
	}
	// All preflight refusals precede dispatch and release this reservation only.
	preflight := func() (string, Repository, forgePull, error) {
		if err := authority(ctx); err != nil {
			return "", Repository{}, forgePull{}, err
		}
		if err := s.reviewerBoundComparison(ctx, p, r); err != nil {
			return "", Repository{}, forgePull{}, err
		}
		base, repo, pull, err := s.reviewerPublisherTarget(ctx, p, r)
		return base, repo, pull, err
	}
	base, repo, pull, err := preflight()
	if err == nil {
		err = s.reviewerPending(ctx, base, pull, r.PublisherID)
	}
	if err == nil {
		base, repo, pull, err = preflight()
	}
	if err != nil {
		if e := finish("rejected", "preflight_refused", 0); e != nil {
			return e
		}
		return err
	}
	// Committing dispatch intent makes every later failure potentially accepted.
	// Only this reservation owner posts. Restart/status reads never resume it.
	if err = s.advanceReviewerPublication(ctx, r, "dispatch_unknown", "", 0); err != nil {
		return err
	}
	var receipt forgePullReview
	_, err = s.forgeJSON(ctx, http.MethodPost, base+"/pulls/"+strconv.FormatInt(r.Number, 10)+"/reviews", forgeCredential{Kind: "pat", Token: s.config.ReviewPublisherToken}, input, &receipt, http.StatusOK)
	if receipt.ID > 0 {
		if e := finish("receipt", "", receipt.ID); e != nil {
			return e
		}
	}
	if err == nil && !reviewerHeaderMatches(receipt, r, pull, input) {
		err = errInvalidForgeResponse
	}
	if err == nil {
		err = s.verifyReviewerPublication(ctx, base, repo, pull, r, input, receipt.ID, comparison)
	}
	if err == nil {
		_, _, _, err = preflight()
	}
	if err != nil {
		if e := finish("uncertain", "native_effect_unverified", 0); e != nil {
			return e
		}
		return err
	}
	return finish("published", "", receipt.ID)
}
