package server

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestAgentCommentAuthorityPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	a, err := f.s.reviewerActor(t.Context(), f.p)
	if err != nil {
		t.Fatal(err)
	}
	base, _ := repositoryPath(keyFrom(f.p.Config.Repository))
	repo, err := f.s.readRepository(t.Context(), base, a.Credential)
	if err != nil {
		t.Fatal(err)
	}
	pull, err := f.s.readPull(t.Context(), a.Credential, base, repo, 7)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := f.s.agentCommentSnapshot(t.Context(), f.p, a, pull, "comment/501", "@golf-bot review")
	if err != nil || receipt == nil || receipt.ID != 501 || receipt.Author != 42 || len(receipt.Digest) != 32 {
		t.Fatal("native comment receipt failed")
	}
	run := f.run(t, "comment/501")
	if err = f.s.revalidateReviewComment(t.Context(), f.p, a, pull, run.ID, run.Intent); err != nil {
		t.Fatal("current exact command rejected")
	}
	if _, err = f.s.agentCommentSnapshot(t.Context(), f.p, a, pull, "comment/501", "@golf-bot different"); err == nil {
		t.Fatal("changed instruction accepted")
	}
	for _, mode := range []string{"comment-edited", "comment-deleted"} {
		f.mode.Store(mode)
		if err = f.s.revalidateReviewComment(t.Context(), f.p, a, pull, run.ID, run.Intent); err == nil {
			t.Fatal("changed/deleted instruction retained authority")
		}
		f.mode.Store("")
	}
	foreign := pull
	foreign.Number = 8
	if err = f.s.revalidateReviewComment(t.Context(), f.p, a, foreign, run.ID, run.Intent); err == nil {
		t.Fatal("another PR lent comment authority")
	}
	changedAuthor := pull
	copyUser := *pull.User
	copyUser.ID = 900
	changedAuthor.User = &copyUser
	other := f.p
	other.NativeID = 901
	if err = f.s.revalidateReviewComment(t.Context(), other, a, changedAuthor, run.ID, run.Intent); err == nil {
		t.Fatal("author lost command eligibility")
	}
	if _, err = f.s.db.Exec(`UPDATE golf_reviewer_comment_commands SET author_native_id=900 WHERE run_id=$1`, run.ID); err == nil {
		t.Fatal("immutable instruction receipt rewritten")
	}
	if err = f.s.revalidateReviewComment(t.Context(), f.p, a, pull, run.ID, "comment/502"); err == nil {
		t.Fatal("different original intent adopted")
	}
}
func TestAgentReviewRequestExcerpt(t *testing.T) {
	prompt := strings.Repeat("α", 14000)
	receipt := reviewConversationPrompt(prompt)
	if !utf8.ValidString(receipt) || len(receipt) > 16384 || !strings.Contains(receipt, "full dispatched request is 28000 bytes, SHA-256") || !strings.Contains(receipt, "omitted") {
		t.Fatal("large review request represented as complete")
	}
	if reviewConversationPrompt("Actual request") != "Actual request" {
		t.Fatal("bounded prompt changed")
	}
}
