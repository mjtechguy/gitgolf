package server

import (
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestReviewerResultBoundary(t *testing.T) {
	diff := "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,2 @@\n keep\n+new\n"
	good := `{"summary":"Introduced defect","findings":[{"path":"a.py","line":2,"severity":"high","title":"SQL injection","evidence":"Untrusted query enters dynamic SQL.","suggestion":"Bind parameters."}]}`
	if _, e := validateReviewResult(good, diff); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{good + "garbage", good + `{}`, `{"summary":"OK","findings":[],"unknown":true}`, `{"summary":"Bad","findings":[{"path":"auth.json","line":1,"severity":"high","title":"Leak","evidence":"Credential read attempted","suggestion":"Fix"}]}`, `{"summary":"Bad","findings":[{"path":"a.py","line":99,"severity":"high","title":"Leak","evidence":"Not in the supplied snapshot","suggestion":"Fix"}]}`} {
		if _, e := validateReviewResult(bad, diff); e == nil {
			t.Fatal("accepted unbound or malformed result")
		}
	}
	if !reviewMention("Please @golf-review-bot recheck.", "golf-review-bot") || reviewMention("@golf-review-bot-other", "golf-review-bot") || reviewMention("foo@golf-review-bot", "golf-review-bot") {
		t.Fatal("mention boundary")
	}
}

func TestReviewerDiffCannotForgeFileHeader(t *testing.T) {
	diff := "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,3 @@\n keep\n+++ b/other.py\n+new\n"
	comparison, err := parseReviewComparison(diff)
	if err != nil || !comparison.Allows("a.py", 2) || !comparison.Allows("a.py", 3) || comparison.Allows("other.py", 1) {
		t.Fatal("source content forged a diff header")
	}
	if !reviewConnectionID("208c39b0-a49d-574f-9130-caf6cf452991") || reviewConnectionID("not-a-connection") {
		t.Fatal("existing connection identifier rejected")
	}
}

// A remembered mention or explicit request must not consume quota again when
// polling sees a different PR head; automatic change events remain head-scoped.
func TestReviewerIntentPostgres(t *testing.T) {
	f, _, _ := codexFixtureRole(t, true)
	var user, local int64
	if e := f.db.QueryRow(`SELECT user_id,id FROM golf_local_accounts WHERE username='alice'`).Scan(&user, &local); e != nil {
		t.Fatal(e)
	}
	reviewer := uuid.NewString()
	_, e := f.db.Exec(`INSERT INTO golf_reviewers(id,forge_url,repository_id,owner_id,repository_owner,repository_name,sponsor_user_id,sponsor_native_id,local_account_id,local_version,publisher_id,config,enabled,expires_at) VALUES($1,$2,11,42,'alice','example',$3,42,$4,1,43,'{}',true,clock_timestamp()+interval '1 day')`, reviewer, f.s.config.ForgeURL, user, local)
	if e != nil {
		t.Fatal(e)
	}
	insert := func(intent, head string, number int) error {
		_, e := f.db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state) VALUES($1,$2,1,$3,$4,$5,'pr_comment',$6,'',43,'admitting')`, uuid.NewString(), reviewer, number, strings.Repeat("a", 40), head, intent)
		return e
	}
	for _, intent := range []string{"comment/123", "manual/" + uuid.NewString()} {
		if e := insert(intent, strings.Repeat("b", 40), 1); e != nil {
			t.Fatal(e)
		}
		if insert(intent, strings.Repeat("c", 40), 1) == nil {
			t.Fatal("intent replayed on later head")
		}
		if insert(intent, strings.Repeat("d", 40), 2) == nil {
			t.Fatal("intent replayed on another PR")
		}
	}
	if insert("change", strings.Repeat("b", 40), 1) != nil || insert("change", strings.Repeat("c", 40), 1) != nil {
		t.Fatal("new automatic head was denied")
	}
	if insert("change", strings.Repeat("c", 40), 1) == nil {
		t.Fatal("same automatic head duplicated")
	}
}
