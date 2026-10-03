package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// A saved reviewer is an explicit, expiring local-account automation delegation.
// No browser session is copied: each admitted task gets its own bound session.
func (s *Server) reviewerActor(ctx context.Context, p reviewerRecord) (codexActor, error) {
	var cipher, binding []byte
	var key string
	var version int64
	e := s.db.QueryRowContext(ctx, `SELECT encrypted_forge_token,credential_binding,credential_key_id,credential_version FROM golf_local_accounts WHERE id=$1 AND user_id=$2 AND disabled_at IS NULL`, p.LocalID, p.UserID).Scan(&cipher, &binding, &key, &version)
	if e != nil || version != p.LocalVersion || !p.Enabled || !p.Expiry.After(time.Now()) {
		return codexActor{}, errUnauthenticated
	}
	token, e := s.keyring.open(key, localAccountDomain, cipher, binding)
	if e != nil {
		return codexActor{}, errCredentialUnavailable
	}
	a := codexActor{UserID: p.UserID, NativeID: p.NativeID, Credential: forgeCredential{Kind: "pat", Token: token, Local: true}}
	user, e := s.currentUser(ctx, a.Credential)
	if e != nil || user.ID != p.NativeID {
		return a, errUnauthenticated
	}
	auth, e := s.agentAuthority(ctx, a, golfv1.AgentUsageScope_AGENT_USAGE_SCOPE_REPOSITORY, "", p.Config.Repository)
	if e != nil || mustID(auth.ID) != p.RepoID || auth.OwnerID != p.OwnerID {
		return a, errCodexPermission
	}
	return a, nil
}
func (s *Server) reviewerCurrent(ctx context.Context, p reviewerRecord) error {
	var okay bool
	e := s.db.QueryRowContext(ctx, `SELECT enabled AND revision=$2 AND publisher_id=$3 AND expires_at>clock_timestamp() FROM golf_reviewers WHERE id=$1 AND forge_url=$4`, p.ID, p.Revision, p.PublisherID, s.config.GiteaURL).Scan(&okay)
	if e != nil || !okay {
		return errExecutionPolicyConflict
	}
	_, e = s.reviewerActor(ctx, p)
	return e
}
func (s *Server) admitReview(ctx context.Context, p reviewerRecord, number uint32, trigger, intent, question string) (out reviewerRunRecord, err error) {
	if e := pullNumber(number); e != nil {
		return out, e
	}
	if len(question) > 2000 {
		return out, invalid("Bound review questions to 2000 bytes.")
	}
	// Serialize each observed intent before quota consumption; no model runs while
	// this short intake owner is held. Old ambiguous reservations are not replayed.
	conn, e := s.db.Conn(ctx)
	if e != nil {
		return out, errStorageUnavailable
	}
	defer conn.Close()
	lock := codexLockID("review-intake/" + p.ID + "/" + strconv.Itoa(int(number)))
	var owned bool
	if e = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, lock).Scan(&owned); e != nil || !owned {
		return out, errCodexUnavailable
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = conn.ExecContext(release, `SELECT pg_advisory_unlock($1)`, lock)
	}()
	a, e := s.reviewerActor(ctx, p)
	if e != nil {
		return out, e
	}
	if e = s.reviewerCurrent(ctx, p); e != nil {
		return out, e
	}
	if intent != "change" {
		receipt, err := scanReviewRun(s.db.QueryRowContext(ctx, `SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE reviewer_id=$1 AND intent=$2`, p.ID, intent))
		if err == nil {
			if receipt.Number != int64(number) {
				return out, errExecutionPolicyConflict
			}
			return receipt, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return out, errStorageUnavailable
		}
	}
	base, _ := repositoryPath(keyFrom(p.Config.Repository))
	repo, e := s.readRepository(ctx, base, a.Credential)
	if e != nil {
		return out, e
	}
	pull, e := s.readPull(ctx, a.Credential, base, repo, number)
	if e != nil {
		return out, e
	}
	if pull.State != "open" || pull.Draft != nil && *pull.Draft || pull.Head.RepositoryID != p.RepoID || pull.Base.RepositoryID != p.RepoID {
		return out, invalid("Review currently requires an open, non-draft same-repository PR.")
	}
	out, e = scanReviewRun(s.db.QueryRowContext(ctx, `SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE reviewer_id=$1 AND pull_number=$2 AND base_commit=$3 AND head_commit=$4 AND intent=$5`, p.ID, number, pull.Base.SHA, pull.Head.SHA, intent))
	if e == nil {
		return out, nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return out, errStorageUnavailable
	}
	// Limit paid fan-out, including mention spam. Existing receipts remain readable.
	var active int
	if s.db.QueryRowContext(ctx, `SELECT count(*) FROM golf_reviewer_runs WHERE reviewer_id=$1 AND (created_at>clock_timestamp()-interval '1 hour' OR state IN ('admitting','queued','running','publishing'))`, p.ID).Scan(&active) != nil {
		return out, errStorageUnavailable
	}
	if active >= 20 {
		return out, invalid("Reviewer hourly/outstanding admission limit reached.")
	}
	diff, e := s.readCommitDiff(ctx, base+"/pulls/"+strconv.Itoa(int(number))+".diff", a.Credential)
	if e != nil {
		return out, e
	}
	if len(diff) > 200000 || len(reviewDiffLines(diff)) == 0 {
		return out, invalid("PR diff is unsupported or exceeds the review bound.")
	}
	fresh, e := s.readPull(ctx, a.Credential, base, repo, number)
	if e != nil || fresh.Head.SHA != pull.Head.SHA || fresh.Base.SHA != pull.Base.SHA {
		return out, errExecutionPolicyConflict
	}
	user, e := s.currentUser(ctx, a.Credential)
	if e != nil {
		return out, e
	}
	login, e := s.createSessionBound(ctx, user, "local", a.Credential.Token, "", &localLoginBinding{p.LocalID, p.UserID, p.LocalVersion})
	if e != nil {
		return out, e
	}
	a.Hash, _ = sessionHash(login.Value)
	keepSession := false
	defer func() {
		if !keepSession {
			clean, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_, _ = s.db.ExecContext(clean, `DELETE FROM golf_sessions WHERE token_hash=$1`, a.Hash)
		}
	}()
	ctx = context.WithValue(ctx, reviewTriggerKey{}, trigger)
	selection := &golfv1.AgentTaskSelection{ConnectionId: p.Config.ConnectionId, ModelId: p.Config.ModelId, Reasoning: p.Config.Reasoning, Trigger: trigger}
	prompt := reviewPrompt(p, pull, diff, question)
	auth, settings, account, e := s.taskConfig(ctx, a, p.Config.Repository, selection, prompt)
	if e != nil {
		return out, e
	}
	publisher, e := s.reviewPublisher(ctx)
	if e != nil || publisher.ID != p.PublisherID {
		return out, errCodexPermission
	}
	id := uuid.NewString()
	_, e = s.db.ExecContext(ctx, `INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admitting')`, id, p.ID, p.Revision, number, pull.Base.SHA, pull.Head.SHA, trigger, intent, diff, p.PublisherID)
	if e != nil {
		return out, errStorageUnavailable
	}
	fail := func(e error) (reviewerRunRecord, error) {
		clean, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = s.db.ExecContext(clean, `UPDATE golf_agent_tasks SET state='cancelled',reason='Reviewer admission failed before dispatch.',version=version+1,finished_at=clock_timestamp() WHERE forge_url=$1 AND idempotency_key=$2 AND state='queued'`, s.config.GiteaURL, id)
		_, _ = s.db.ExecContext(context.Background(), `UPDATE golf_reviewer_runs SET state='failed',reason='Admission failed; inspect before explicitly retrying.' WHERE id=$1 AND state='admitting'`, id)
		return out, e
	}
	taskCtx := context.WithValue(ctx, sessionTokenKey{}, a.Credential)
	request := connect.NewRequest(&golfv1.CreateAgentTaskRequest{Repository: p.Config.Repository, Ref: pull.Head.SHA, Instructions: prompt, Selection: selection, ExpectedRevision: settings.Revision, ExpectedAuthorityRevision: auth.Revision, ExpectedConnectionVersion: strconv.FormatInt(account.Version, 10), IdempotencyKey: id})
	request.Header().Set("Cookie", s.sessionCookie(login.Value, login.Expires, 0).Name+"="+login.Value)
	response, e := s.CreateAgentTask(taskCtx, request)
	if e != nil {
		hash, _ := sessionHash(login.Value)
		_, _ = s.db.ExecContext(context.Background(), `DELETE FROM golf_sessions WHERE token_hash=$1`, hash)
		return fail(e)
	}
	_, e = s.db.ExecContext(ctx, `UPDATE golf_reviewer_runs SET task_id=$2,state='queued' WHERE id=$1 AND state='admitting'`, id, response.Msg.Task.Id)
	if e != nil {
		return out, errStorageUnavailable
	}
	keepSession = true
	// Superseding work loses publication authority, and queued/running work stops.
	_, _ = s.db.ExecContext(ctx, `UPDATE golf_reviewer_runs SET state='outdated',reason='PR commits changed; this review is historical.' WHERE reviewer_id=$1 AND pull_number=$2 AND (base_commit<>$3 OR head_commit<>$4) AND state NOT IN ('admitting','publishing')`, p.ID, number, pull.Base.SHA, pull.Head.SHA)
	_, _ = s.db.ExecContext(ctx, `UPDATE golf_agent_tasks SET state='cancelled',version=version+1,finished_at=clock_timestamp(),reason='PR snapshot was superseded.' WHERE id IN (SELECT task_id FROM golf_reviewer_runs WHERE reviewer_id=$1 AND state='outdated') AND state IN ('queued','running')`, p.ID)
	_ = s.reviewCheck(ctx, a, p, pull.Head.SHA, "pending", "Security review running")
	return scanReviewRun(s.db.QueryRowContext(ctx, `SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE id=$1`, id))
}
func (s *Server) coordinateReviews(ctx context.Context) {
	rows, e := s.db.QueryContext(ctx, `SELECT `+reviewerColumns+` FROM golf_reviewers WHERE forge_url=$1 AND enabled AND expires_at>clock_timestamp() ORDER BY id LIMIT 25`, s.config.GiteaURL)
	if e != nil {
		return
	}
	var people []reviewerRecord
	for rows.Next() {
		p, e := scanReviewer(rows)
		if e == nil {
			people = append(people, p)
		}
	}
	rows.Close()
	for _, p := range people {
		check, stop := context.WithTimeout(ctx, 20*time.Second)
		a, e := s.reviewerActor(check, p)
		if e != nil {
			stop()
			continue
		}
		base, _ := repositoryPath(keyFrom(p.Config.Repository))
		var pulls []forgePull
		_, e = s.forge(check, http.MethodGet, base+"/pulls?state=open&limit=50&page=1", a.Credential, nil, &pulls)
		if e == nil && len(pulls) <= 50 {
			for _, pull := range pulls {
				if pull.Number <= 0 || pull.Head == nil || pull.Base == nil || !objectID.MatchString(pull.Head.SHA) || !objectID.MatchString(pull.Base.SHA) {
					continue
				}
				trigger := "pr_open"
				var seen bool
				_ = s.db.QueryRowContext(check, `SELECT EXISTS(SELECT 1 FROM golf_reviewer_runs WHERE reviewer_id=$1 AND pull_number=$2)`, p.ID, pull.Number).Scan(&seen)
				if seen {
					trigger = "push"
				}
				if (!seen && p.Config.ReviewOnOpen) || (seen && p.Config.ReviewOnPush) {
					_, _ = s.admitReview(check, p, uint32(pull.Number), trigger, "change", "")
				}
				if p.Config.RespondToMentions {
					s.reviewMentions(check, p, a, base, pull)
				}
			}
		}
		stop()
	}
}
func (s *Server) reviewMentions(ctx context.Context, p reviewerRecord, a codexActor, base string, pull forgePull) {
	var comments []struct {
		ID   int64  `json:"id"`
		Body string `json:"body"`
		User *User  `json:"user"`
	}
	_, e := s.forge(ctx, http.MethodGet, base+"/issues/"+strconv.FormatInt(pull.Number, 10)+"/comments?limit=50&page=1", a.Credential, nil, &comments)
	if e != nil || len(comments) > 50 {
		return
	}
	for _, c := range comments {
		if c.User == nil || c.User.ID == p.PublisherID || len(c.Body) > 2000 || !reviewMention(c.Body, p.Config.PublisherLogin) {
			continue
		}
		// First conversation boundary: current sponsoring owner or current PR author.
		// Other collaborators require a separately qualified native role lookup.
		if c.User.ID != p.NativeID && (pull.User == nil || c.User.ID != pull.User.ID) {
			continue
		}
		_, _ = s.admitReview(ctx, p, uint32(pull.Number), "pr_comment", "comment/"+strconv.FormatInt(c.ID, 10), c.Body)
	}
}

type reviewFinding struct {
	Path       string `json:"path"`
	Line       int    `json:"line"`
	Severity   string `json:"severity"`
	Title      string `json:"title"`
	Evidence   string `json:"evidence"`
	Suggestion string `json:"suggestion"`
}
type reviewResult struct {
	Summary  string          `json:"summary"`
	Findings []reviewFinding `json:"findings"`
}

var reviewHunk = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

func reviewDiffLines(diff string) map[string]map[int]bool {
	files := map[string]map[int]bool{}
	path := ""
	line := 0
	inHunk := false
	for _, s := range strings.Split(diff, "\n") {
		if strings.HasPrefix(s, "diff --git ") {
			path = ""
			inHunk = false
		}
		if !inHunk && strings.HasPrefix(s, "+++ b/") {
			path = strings.TrimPrefix(s, "+++ b/")
			if validSourcePath(path) {
				files[path] = map[int]bool{}
			} else {
				path = ""
			}
			inHunk = false
			continue
		}
		if h := reviewHunk.FindStringSubmatch(s); h != nil {
			line, _ = strconv.Atoi(h[1])
			inHunk = true
			continue
		}
		if !inHunk || path == "" {
			continue
		}
		if strings.HasPrefix(s, "+") || strings.HasPrefix(s, " ") {
			files[path][line] = true
			line++
		}
	}
	return files
}
func validateReviewResult(text, diff string) (reviewResult, error) {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```json\n") && strings.HasSuffix(text, "```") {
		text = strings.TrimSuffix(strings.TrimPrefix(text, "```json\n"), "```")
	}
	var r reviewResult
	d := json.NewDecoder(strings.NewReader(text))
	d.DisallowUnknownFields()
	if e := d.Decode(&r); e != nil {
		return r, errInvalidForgeResponse
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return r, errInvalidForgeResponse
	}
	if len(r.Summary) < 1 || len(r.Summary) > 4000 || len(r.Findings) > 10 || strings.IndexFunc(r.Summary, func(c rune) bool { return unicode.IsControl(c) && c != '\n' && c != '\t' }) >= 0 {
		return r, errInvalidForgeResponse
	}
	lines := reviewDiffLines(diff)
	seen := map[string]bool{}
	for _, f := range r.Findings {
		key := fmt.Sprintf("%s:%d:%s", f.Path, f.Line, f.Title)
		if !lines[f.Path][f.Line] || seen[key] || !validReviewText(f.Title) || !validReviewText(f.Evidence) || !validReviewText(f.Suggestion) || len(f.Title) < 3 || len(f.Title) > 160 || len(f.Evidence) < 10 || len(f.Evidence) > 2000 || len(f.Suggestion) > 2000 || (f.Severity != "high" && f.Severity != "medium" && f.Severity != "low") {
			return r, errInvalidForgeResponse
		}
		seen[key] = true
	}
	return r, nil
}
func reviewText(s string) string {
	return strings.NewReplacer("<", "&lt;", ">", "&gt;", "@", "@\u200b").Replace(s)
}
func (s *Server) reviewCheck(ctx context.Context, a codexActor, p reviewerRecord, head, state, description string) error {
	base, _ := repositoryPath(keyFrom(p.Config.Repository))
	_, e := s.forgeJSON(ctx, http.MethodPost, base+"/statuses/"+head, a.Credential, map[string]string{"state": state, "context": "golf/security-reviewer", "description": description}, &struct{}{}, http.StatusCreated)
	return e
}
func (s *Server) publishReviews(ctx context.Context) {
	rows, e := s.db.QueryContext(ctx, `SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE reviewer_id IN (SELECT id FROM golf_reviewers WHERE forge_url=$1) AND state IN ('queued','running') ORDER BY created_at LIMIT 25`, s.config.GiteaURL)
	if e != nil {
		return
	}
	var runs []reviewerRunRecord
	for rows.Next() {
		r, e := scanReviewRun(rows)
		if e == nil {
			runs = append(runs, r)
		}
	}
	rows.Close()
	_, _ = s.db.ExecContext(ctx, `DELETE FROM golf_sessions WHERE token_hash IN (SELECT t.session_hash FROM golf_agent_tasks t JOIN golf_reviewer_runs r ON r.task_id=t.id WHERE t.forge_url=$1 AND t.state NOT IN ('running','queued') AND r.state IN ('published','failed','outdated','publication_unknown'))`, s.config.GiteaURL)
	for _, r := range runs {
		if r.Task == "" {
			continue
		}
		t, e := s.taskRecord(ctx, r.Task)
		if e != nil {
			continue
		}
		if t.State == "running" || t.State == "queued" {
			_, _ = s.db.ExecContext(ctx, `UPDATE golf_reviewer_runs SET state=$2 WHERE id=$1 AND state IN ('queued','running')`, r.ID, t.State)
			continue
		}
		check, stop := context.WithTimeout(ctx, 15*time.Second)
		p, e := scanReviewer(s.db.QueryRowContext(check, `SELECT `+reviewerColumns+` FROM golf_reviewers WHERE id=$1 AND forge_url=$2`, r.ReviewerID, s.config.GiteaURL))
		if e != nil {
			stop()
			continue
		}
		a, e := s.reviewerActor(check, p)
		if e == nil && p.Revision != r.Revision {
			e = errExecutionPolicyConflict
		}
		if e == nil {
			e = s.reviewerCurrent(check, p)
		}
		base, _ := repositoryPath(keyFrom(p.Config.Repository))
		var pull forgePull
		if e == nil {
			var repo Repository
			repo, e = s.readRepository(check, base, a.Credential)
			if e == nil {
				pull, e = s.readPull(check, a.Credential, base, repo, uint32(r.Number))
			}
		}
		if e != nil || pull.State != "open" || pull.Head == nil || pull.Base == nil || pull.Head.SHA != r.Head || pull.Base.SHA != r.Base {
			_, _ = s.db.ExecContext(check, `UPDATE golf_reviewer_runs SET state='outdated',reason='PR or delegation authority changed; no review published.' WHERE id=$1`, r.ID)
			stop()
			continue
		}
		fail := func(reason string) {
			_, _ = s.db.ExecContext(check, `UPDATE golf_reviewer_runs SET state='failed',reason=$2 WHERE id=$1 AND state IN ('queued','running')`, r.ID, reason)
			_ = s.reviewCheck(check, a, p, r.Head, "error", reason)
		}
		if t.State != "succeeded" {
			fail("Native review task did not complete; no automatic replay.")
			stop()
			continue
		}
		parsed, e := validateReviewResult(t.Summary, r.Diff)
		if e != nil {
			fail("Review output validation failed; inspect before retrying.")
			stop()
			continue
		}
		publisher, e := s.reviewPublisher(check)
		if e != nil || publisher.ID != r.PublisherID {
			fail("Publishing identity changed.")
			stop()
			continue
		}
		// Recheck all account/policy fences before publication, including new logout-
		// independent automation session and the current native repository authority.
		actor, e := s.taskActor(check, t)
		if e != nil {
			fail("Task authority changed before publication.")
			stop()
			continue
		}
		account, e := s.codexAuthorized(check, actor, t.Connection, false)
		if e != nil || account.Version != t.ConnectionVersion+1 {
			fail("Model account authority changed.")
			stop()
			continue
		}
		e = s.codexGuard(check, actor, func(tx *sql.Tx, _ int64) error {
			if e := s.agentFence(check, tx, actor, account, t.RepositoryID, t.OwnerID, t.Fingerprint); e != nil {
				return e
			}
			var current int64
			if e := tx.QueryRowContext(check, `SELECT revision FROM golf_reviewers WHERE id=$1 AND enabled AND expires_at>clock_timestamp() FOR UPDATE`, p.ID).Scan(&current); e != nil || current != r.Revision {
				return errExecutionPolicyConflict
			}
			result, e := tx.ExecContext(check, `UPDATE golf_reviewer_runs SET state='publishing' WHERE id=$1 AND state IN ('queued','running')`, r.ID)
			if e != nil {
				return e
			}
			n, _ := result.RowsAffected()
			if n != 1 {
				return errExecutionPolicyConflict
			}
			return nil
		})
		if e != nil {
			fail("Policy/account changed before publication.")
			stop()
			continue
		}
		if e = s.reviewerCurrent(check, p); e == nil {
			var repo Repository
			repo, e = s.readRepository(check, base, a.Credential)
			if e == nil {
				pull, e = s.readPull(check, a.Credential, base, repo, uint32(r.Number))
			}
		}
		if e != nil || pull.State != "open" || pull.Head.SHA != r.Head || pull.Base.SHA != r.Base {
			_, _ = s.db.ExecContext(check, `UPDATE golf_reviewer_runs SET state='outdated',reason='Authority or snapshot changed before native publication.' WHERE id=$1 AND state='publishing'`, r.ID)
			stop()
			continue
		}
		body := fmt.Sprintf("**Golf bot · %s**\n\n%s\n\nReviewed base `%s` → head `%s`. Read-only review; no tests were executed.\n\n<!-- golf-review:%s -->", reviewText(p.Config.Name), reviewText(parsed.Summary), r.Base, r.Head, r.ID)
		comments := []map[string]any{}
		for _, f := range parsed.Findings {
			comments = append(comments, map[string]any{"path": f.Path, "new_position": f.Line, "old_position": 0, "body": fmt.Sprintf("**%s · %s**\n\n%s\n\nSuggested fix: %s", f.Severity, reviewText(f.Title), reviewText(f.Evidence), reviewText(f.Suggestion))})
		}
		var receipt forgePullReview
		_, e = s.forgeJSON(check, http.MethodPost, base+"/pulls/"+strconv.FormatInt(r.Number, 10)+"/reviews", forgeCredential{Kind: "pat", Token: s.config.ReviewPublisherToken}, map[string]any{"body": body, "comments": comments, "commit_id": r.Head, "event": "COMMENT"}, &receipt, http.StatusOK)
		if e != nil || receipt.ID <= 0 || receipt.User == nil || receipt.User.ID != r.PublisherID || receipt.CommitID != r.Head {
			_, _ = s.db.ExecContext(check, `UPDATE golf_reviewer_runs SET state='publication_unknown',reason='Native publication outcome unknown; never automatically repost.' WHERE id=$1 AND state='publishing'`, r.ID)
			stop()
			continue
		}
		findings, _ := json.Marshal(parsed)
		_, e = s.db.ExecContext(check, `UPDATE golf_reviewer_runs SET state='published',review_id=$2,findings=$3 WHERE id=$1 AND state='publishing'`, r.ID, receipt.ID, findings)
		if e == nil {
			state, description := "success", "Security review completed with no findings"
			if len(parsed.Findings) > 0 {
				state, description = "failure", "Security review reported findings"
			}
			_ = s.reviewCheck(check, a, p, r.Head, state, description)
		}
		// Only this dedicated task session is revoked; sponsor browser sessions survive.
		_, _ = s.db.ExecContext(check, `DELETE FROM golf_sessions WHERE token_hash=$1`, t.Hash)
		stop()
	}
}

func validReviewText(s string) bool {
	return utf8.ValidString(s) && strings.IndexFunc(s, func(c rune) bool { return unicode.IsControl(c) && c != '\n' && c != '\t' }) < 0
}
func reviewMention(body, login string) bool {
	return regexp.MustCompile(`(?i)(^|[^a-z0-9_@.-])@` + regexp.QuoteMeta(login) + `($|[^a-z0-9_.-])`).MatchString(body)
}

// Recheck the expiring sponsorship and exact PR snapshot while native inference runs.
func (s *Server) reviewTaskAccess(ctx context.Context, t agentTaskRecord) error {
	r, e := scanReviewRun(s.db.QueryRowContext(ctx, `SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE task_id=$1`, t.ID))
	if errors.Is(e, sql.ErrNoRows) {
		var config golfv1.AgentUsageConfig
		_ = json.Unmarshal(t.RawConfig, &config)
		if strings.HasPrefix(config.ModelId, "opencode-go/") {
			return errExecutionPolicyConflict
		}
		return nil
	}
	if e != nil || (r.State != "queued" && r.State != "running") {
		return errExecutionPolicyConflict
	}
	p, e := scanReviewer(s.db.QueryRowContext(ctx, `SELECT `+reviewerColumns+` FROM golf_reviewers WHERE id=$1 AND forge_url=$2`, r.ReviewerID, s.config.GiteaURL))
	if e != nil || p.Revision != r.Revision {
		return errExecutionPolicyConflict
	}
	if e = s.reviewerCurrent(ctx, p); e != nil {
		return e
	}
	a, e := s.reviewerActor(ctx, p)
	if e != nil {
		return e
	}
	base, _ := repositoryPath(keyFrom(p.Config.Repository))
	repo, e := s.readRepository(ctx, base, a.Credential)
	if e != nil {
		return e
	}
	pull, e := s.readPull(ctx, a.Credential, base, repo, uint32(r.Number))
	if e != nil {
		return e
	}
	if pull.State != "open" || pull.Head.SHA != r.Head || pull.Base.SHA != r.Base {
		return errExecutionPolicyConflict
	}
	return nil
}
