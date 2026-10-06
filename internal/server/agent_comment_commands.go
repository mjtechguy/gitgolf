package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A comment is an instruction only under an explicitly configured mention
// trigger. Its native author and exact body must remain current until execution
// and publication. Editing/deleting it cancels authority, never resends a task.
type reviewCommentReceipt struct {
	ID, Author int64
	Digest     []byte
}

func (s *Server) readReviewComment(ctx context.Context, p reviewerRecord, a codexActor, pull forgePull, id int64) (reviewCommentReceipt, string, error) {
	var c struct {
		ID       int64  `json:"id"`
		Body     string `json:"body"`
		User     *User  `json:"user"`
		IssueURL string `json:"issue_url"`
	}
	base, err := repositoryPath(keyFrom(p.Config.Repository))
	if err != nil || id <= 0 || pull.Number <= 0 || pull.User == nil || !p.Config.RespondToMentions {
		return reviewCommentReceipt{}, "", errExecutionPolicyConflict
	}
	_, err = s.forge(ctx, http.MethodGet, base+"/issues/comments/"+strconv.FormatInt(id, 10), a.Credential, nil, &c)
	// The direct native response does not always carry issue_url. Independently
	// require the ID in this PR's bounded comment inventory; another PR cannot
	// lend a valid author's instruction to this run.
	var inventory []struct {
		ID   int64  `json:"id"`
		Body string `json:"body"`
		User *User  `json:"user"`
	}
	if err == nil {
		_, err = s.forge(ctx, http.MethodGet, base+"/issues/"+strconv.FormatInt(pull.Number, 10)+"/comments?limit=50&page=1", a.Credential, nil, &inventory)
	}
	member := false
	for _, item := range inventory {
		member = member || item.ID == id && item.Body == c.Body && item.User != nil && c.User != nil && item.User.ID == c.User.ID
	}
	if err != nil || len(inventory) > 50 || !member || c.ID != id || c.User == nil || c.User.ID == p.PublisherID || (c.User.ID != p.NativeID && c.User.ID != pull.User.ID) || len(c.Body) > 2000 || !reviewMention(c.Body, p.Config.PublisherLogin) {
		return reviewCommentReceipt{}, "", errExecutionPolicyConflict
	}
	digest := sha256.Sum256([]byte(c.Body))
	return reviewCommentReceipt{ID: id, Author: c.User.ID, Digest: digest[:]}, c.Body, nil
}

func (s *Server) agentCommentSnapshot(ctx context.Context, p reviewerRecord, a codexActor, pull forgePull, intent, question string) (*reviewCommentReceipt, error) {
	if !strings.HasPrefix(intent, "comment/") {
		return nil, nil
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(intent, "comment/"), 10, 64)
	if err != nil {
		return nil, errExecutionPolicyConflict
	}
	c, body, err := s.readReviewComment(ctx, p, a, pull, id)
	if err != nil || body != question {
		return nil, errExecutionPolicyConflict
	}
	return &c, nil
}

func (s *Server) recordReviewComment(ctx context.Context, run string, c reviewCommentReceipt) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO golf_reviewer_comment_commands(run_id,comment_id,author_native_id,body_sha256) VALUES($1,$2,$3,$4)`, run, c.ID, c.Author, c.Digest)
	if err != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) revalidateReviewComment(ctx context.Context, p reviewerRecord, a codexActor, pull forgePull, run, intent string) error {
	if !strings.HasPrefix(intent, "comment/") {
		return nil
	}
	var c reviewCommentReceipt
	err := s.db.QueryRowContext(ctx, `SELECT comment_id,author_native_id,body_sha256 FROM golf_reviewer_comment_commands WHERE run_id=$1`, run).Scan(&c.ID, &c.Author, &c.Digest)
	// Historical comment runs were admitted without author/body receipts. Never
	// infer or adopt that provenance retrospectively, even from today's comment.
	if errors.Is(err, sql.ErrNoRows) {
		return errExecutionPolicyConflict
	}
	if err != nil {
		return errStorageUnavailable
	}
	if intent != "comment/"+strconv.FormatInt(c.ID, 10) {
		return errExecutionPolicyConflict
	}
	current, _, err := s.readReviewComment(ctx, p, a, pull, c.ID)
	if err != nil || current.Author != c.Author || !bytesEqual(current.Digest, c.Digest) {
		return errExecutionPolicyConflict
	}
	return nil
}

// Large captured PR comparisons remain in their existing bounded task snapshot.
// The private transcript records a labeled excerpt and full request digest,
// rather than pretending an incomplete excerpt is the full dispatched prompt.
func reviewConversationPrompt(prompt string) string {
	if len(prompt) <= 16384 {
		return prompt
	}
	digest := sha256.Sum256([]byte(prompt))
	prefix, suffix := prompt[:6000], prompt[len(prompt)-6000:]
	for !utf8.ValidString(prefix) {
		prefix = prefix[:len(prefix)-1]
	}
	for !utf8.ValidString(suffix) {
		suffix = suffix[1:]
	}
	return fmt.Sprintf("Read-only PR review request excerpt; full dispatched request is %d bytes, SHA-256 %x. Captured comparison omitted from this transcript excerpt.\n\n%s\n\n[comparison excerpt omitted]\n\n%s", len(prompt), digest, prefix, suffix)
}
