package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"os"
	"regexp"
	"strings"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

// RunAgentWorker is a trusted control-plane process. It holds the same account
// advisory owner as login/refresh, and only the native cache reaches a task.
func (s *Server) RunAgentWorker(ctx context.Context, worker, seccomp string) error {
	if !runnerIdentifier.MatchString(worker) || !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(s.config.AgentImage) {
		return errors.New("An enrolled worker ID and exact local agent image are required")
	}
	if info, e := os.Stat(seccomp); e != nil || !info.Mode().IsRegular() {
		return errors.New("A qualified native seccomp profile is required")
	}
	workerOwner, e := s.db.Conn(ctx)
	if e != nil {
		return errStorageUnavailable
	}
	workerLock := codexLockID("golf-agent-worker/" + s.config.ForgeURL + "/" + worker)
	var owns bool
	if e = workerOwner.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, workerLock).Scan(&owns); e != nil || !owns {
		workerOwner.Close()
		return errors.New("Agent worker enrollment is already owned")
	}
	defer releaseCodexOwner(workerOwner, workerLock)
	ctx, stopWorker := context.WithCancel(ctx)
	defer stopWorker()
	go func() {
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				check, cancel := context.WithTimeout(ctx, time.Second)
				ok := codexOwnerAlive(check, &codexRuntime{conn: workerOwner, ownerID: workerLock})
				cancel()
				if !ok {
					stopWorker()
					return
				}
			}
		}
	}()
	images := []string{s.config.AgentImage}
	if s.config.ReviewImage != "" {
		images = append(images, s.config.ReviewImage)
	}
	executor, e := runner.New(runner.Config{WorkerID: worker, ApprovedImages: images})
	if e != nil {
		return e
	}
	if _, e = s.db.ExecContext(ctx, `UPDATE golf_agent_tasks SET state='lost',version=version+1,finished_at=clock_timestamp(),reason='Worker restarted; no automatic retry.' WHERE forge_url=$1 AND worker_id=$2 AND state='running'`, s.config.ForgeURL, worker); e != nil {
		return errStorageUnavailable
	}
	cleanup, stopCleanup := context.WithTimeout(ctx, 45*time.Second)
	e = executor.CleanupWorker(cleanup)
	stopCleanup()
	if e != nil {
		return errors.New("Agent worker cleanup failed; inspect its labeled resources")
	}
	qualification, stopQualification := context.WithTimeout(ctx, 30*time.Second)
	e = executor.QualifyAgent(qualification, s.config.AgentImage, seccomp)
	stopQualification()
	if e != nil {
		return errors.New("Native task sandbox qualification failed; worker remains unavailable")
	}
	if s.config.ReviewImage != "" {
		check, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := executor.QualifyReview(check, s.config.ReviewImage)
		cancel()
		if err != nil {
			return errors.New("Native read-only reviewer qualification failed; worker remains unavailable")
		}
	}
	acpImage, acpVersion := "", ""
	if s.config.ReviewImage != "" {
		check, cancel := context.WithTimeout(ctx, 30*time.Second)
		if err := executor.QualifyManagedACP(check, s.config.ReviewImage, seccomp); err == nil {
			acpImage, acpVersion = s.config.ReviewImage, runner.ManagedACPVersion
		} else if errors.Is(err, runner.ErrCleanup) {
			cancel()
			return errors.New("ACP qualification cleanup failed; worker remains unavailable")
		}
		cancel()
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return nil
		}
		_, e = s.db.ExecContext(ctx, `INSERT INTO golf_agent_worker_presence(forge_url,worker_id,image,acp_image,acp_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(forge_url,worker_id) DO UPDATE SET image=EXCLUDED.image,acp_image=EXCLUDED.acp_image,acp_version=EXCLUDED.acp_version,acp_file_tools=false,last_seen=clock_timestamp()`, s.config.ForgeURL, worker, s.config.AgentImage, acpImage, acpVersion)
		if e != nil {
			return errStorageUnavailable
		}
		// Loss is terminal. An expired attempt may already have consumed quota or
		// changed files; never replay it automatically after a worker restart.
		_, e = s.db.ExecContext(ctx, `UPDATE golf_agent_tasks SET state='lost',reason='Worker lease expired; no automatic retry.',version=version+1,finished_at=clock_timestamp() WHERE forge_url=$1 AND state='running' AND lease_expires_at<=clock_timestamp()`, s.config.ForgeURL)
		if e != nil {
			return errStorageUnavailable
		}
		if s.config.ReviewImage != "" && s.config.ReviewPublisherToken != "" {
			s.coordinateReviews(ctx)
			s.publishReviews(ctx)
		}
		// A reviewer task is dispatchable only after its durable review receipt is linked.
		t, e := scanAgentTask(s.db.QueryRowContext(ctx, `SELECT `+agentTaskColumns+` FROM golf_agent_tasks WHERE forge_url=$1 AND state='queued' AND (COALESCE(config->>'model_id','') NOT LIKE 'opencode-go/%' OR $2 OR EXISTS(SELECT 1 FROM golf_reviewer_runs rr WHERE rr.task_id=golf_agent_tasks.id AND rr.state IN ('queued','running'))) ORDER BY created_at,id LIMIT 1`, s.config.ForgeURL, acpImage != ""))
		if e == nil {
			_ = s.executeAgentTask(ctx, executor, worker, seccomp, t)
		} else if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func (s *Server) taskActor(ctx context.Context, t agentTaskRecord) (codexActor, error) {
	a := codexActor{UserID: t.UserID, NativeID: t.NativeID, Hash: t.Hash}
	token, e := s.sessionCredentialHash(ctx, t.Hash)
	if e != nil {
		return a, e
	}
	a.Credential = token
	caller, e := s.currentUser(ctx, token)
	if e != nil {
		return a, e
	}
	if caller.ID != t.NativeID {
		return a, errUnauthenticated
	}
	if e = s.taskAccess(ctx, a, t); e == nil {
		e = s.workflowAgentAuthority(ctx, t)
	}
	return a, e
}
func (s *Server) rejectAgentTask(ctx context.Context, t agentTaskRecord, reason string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE golf_agent_tasks SET state='cancelled',reason=$2,version=version+1,finished_at=clock_timestamp() WHERE id=$1 AND forge_url=$3 AND state='queued'`, t.ID, reason, s.config.ForgeURL)
}
func (s *Server) executeAgentTask(ctx context.Context, executor *runner.Executor, worker, seccomp string, t agentTaskRecord) error {
	var c golfv1.AgentUsageConfig
	if json.Unmarshal(t.RawConfig, &c) != nil {
		return errStorageUnavailable
	}
	if c.SpendLimitCents != 0 {
		s.rejectAgentTask(ctx, t, agentSpendUnavailable)
		return invalid(agentSpendUnavailable)
	}
	a, e := s.taskActor(ctx, t)
	if e == nil {
		e = s.reviewTaskAccess(ctx, t)
	}
	if e != nil {
		s.rejectAgentTask(ctx, t, "Current repository/session authority is unavailable.")
		return e
	}
	r, e := s.codexAuthorized(ctx, a, t.Connection, false)
	if e != nil || r.State != "CONNECTED" || r.Version != t.ConnectionVersion {
		s.rejectAgentTask(ctx, t, "Account state or use access changed.")
		return errCodexConflict
	}
	owner, e := s.db.Conn(ctx)
	if e != nil {
		return e
	}
	locked := false
	if e = owner.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, codexLockID(r.ID)).Scan(&locked); e != nil || !locked {
		owner.Close()
		return errCodexUnavailable
	}
	defer releaseCodexOwner(owner, codexLockID(r.ID))
	attempt, e := runnerAttemptID()
	if e != nil {
		return e
	}
	e = s.codexGuard(ctx, a, func(tx *sql.Tx, _ int64) error {
		if e := s.agentAttemptFence(ctx, tx, a, r, t); e != nil {
			return e
		}
		// Conservative global concurrency ceiling; account ownership further limits
		// a rotating account to one task. Multiple accounts/workers can run in parallel.
		var busy int
		e := tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_agent_tasks WHERE forge_url=$1 AND state='running'`, s.config.ForgeURL).Scan(&busy)
		if e != nil {
			return errStorageUnavailable
		}
		if busy >= int(c.MaxConcurrent) {
			return errRunnerUnavailable
		}
		result, e := tx.ExecContext(ctx, `UPDATE golf_agent_tasks SET state='running',version=version+1,worker_id=$2,attempt_id=$3,lease_expires_at=clock_timestamp()+interval '45 seconds',started_at=clock_timestamp() WHERE id=$1 AND forge_url=$4 AND state='queued'`, t.ID, worker, attempt, s.config.ForgeURL)
		if e != nil {
			return errStorageUnavailable
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			return errExecutionPolicyConflict
		}
		return nil
	})
	if e != nil {
		if !errors.Is(e, errRunnerUnavailable) {
			s.rejectAgentTask(ctx, t, "Current agent policy or account authority changed.")
		}
		return e
	}
	t.Attempt, t.Worker, t.Version = attempt, worker, t.Version+1
	var encrypted []byte
	var key string
	e = owner.QueryRowContext(ctx, `SELECT encrypted_credential,credential_key_id FROM golf_codex_auth WHERE connection_id=$1`, r.ID).Scan(&encrypted, &key)
	if e != nil {
		s.finishAgentFailure(ctx, t.ID, attempt, "Native account cache is unavailable.")
		return e
	}
	plain, e := s.keyring.open(key, infrastructureConnectionDomain, encrypted, codexBinding(r.ID))
	if e != nil {
		s.finishAgentFailure(ctx, t.ID, attempt, "Native account cache is unavailable.")
		return e
	}
	// Bound task lifetime to the qualified native account broker window. No host
	// configuration, auth directory, keychain, provider env or forge credential.
	run, stop := context.WithTimeout(ctx, time.Duration(min(c.TimeoutSeconds, 900))*time.Second)
	defer stop()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		timer := time.NewTicker(3 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-run.Done():
				return
			case <-timer.C:
				check, cancel := context.WithTimeout(run, 5*time.Second)
				alive := true
				if !codexOwnerAlive(check, &codexRuntime{conn: owner, ownerID: codexLockID(r.ID)}) {
					alive = false
				}
				fresh, err := s.taskActor(check, t)
				if err == nil {
					err = s.reviewTaskAccess(check, t)
				}
				if err != nil {
					alive = false
				}
				if alive {
					err = s.codexGuard(check, fresh, func(tx *sql.Tx, _ int64) error {
						if e := s.agentAttemptFence(check, tx, fresh, r, t); e != nil {
							return e
						}
						result, e := tx.ExecContext(check, `UPDATE golf_agent_tasks SET lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1 AND state='running' AND attempt_id=$2 AND worker_id=$3 AND lease_expires_at>clock_timestamp()`, t.ID, attempt, worker)
						if e != nil {
							return errStorageUnavailable
						}
						n, _ := result.RowsAffected()
						if n != 1 {
							return errExecutionPolicyConflict
						}
						return nil
					})
					alive = err == nil
				}
				if alive {
					_, err = s.db.ExecContext(check, `UPDATE golf_agent_worker_presence SET last_seen=clock_timestamp() WHERE forge_url=$1 AND worker_id=$2 AND image=$3`, s.config.ForgeURL, worker, s.config.AgentImage)
					alive = err == nil
				}
				cancel()
				if !alive {
					stop()
					return
				}
			}
		}
	}()
	source, e := os.CreateTemp("", "golf-agent-source-")
	if e != nil {
		stop()
		<-heartbeatDone
		s.finishAgentFailure(ctx, t.ID, attempt, "Private source preparation failed; no automatic retry.")
		return e
	}
	defer os.Remove(source.Name())
	if _, e = source.Write(t.Source); e != nil {
		source.Close()
		stop()
		<-heartbeatDone
		s.finishAgentFailure(ctx, t.ID, attempt, "Private source preparation failed; no automatic retry.")
		return e
	}
	source.Close()
	job := runner.AgentJob{Job: runner.Job{AttemptID: attempt, JobID: t.ID, SourceCommit: t.Commit, ImageDigest: s.config.AgentImage, Timeout: time.Duration(min(c.TimeoutSeconds, 900)) * time.Second, SourceArchivePath: source.Name()}, Auth: []byte(plain), Model: c.ModelId, Reasoning: c.Reasoning, Instructions: c.Instructions, TokenBudget: c.TokenBudget, SeccompPath: seccomp}
	var result runner.AgentResult
	var executionErr error
	promptReceipt := c.Instructions
	if r.Harness == "opencode" && r.Provider == "opencode-go" {
		promptReceipt = reviewConversationPrompt(c.Instructions)
	}
	if e = s.startConversation(run, t, r, worker, attempt, promptReceipt, []byte(plain)); e != nil {
		stop()
		<-heartbeatDone
		s.finishAgentFailure(ctx, t.ID, attempt, "Private conversation admission failed; no native task was launched.")
		return e
	}
	job.Observe = func(observeCtx context.Context, v runner.AgentObservation) error {
		if !codexOwnerAlive(observeCtx, &codexRuntime{conn: owner, ownerID: codexLockID(r.ID)}) {
			return errCodexUnavailable
		}
		return s.observeConversation(observeCtx, t, r, worker, attempt, v, []byte(plain))
	}
	if r.Harness == "opencode" && r.Provider == "opencode-go" {
		job.ImageDigest = s.config.ReviewImage
		var reviewer bool
		if e = s.db.QueryRowContext(run, `SELECT EXISTS(SELECT 1 FROM golf_reviewer_runs WHERE task_id=$1)`, t.ID).Scan(&reviewer); e != nil {
			executionErr = errStorageUnavailable
		} else if reviewer {
			result, executionErr = executor.ExecuteReview(run, job)
		} else if !s.agentACPAvailable(run) {
			executionErr = errRunnerUnavailable
		} else {
			cleanup, err := s.managedACPJob(run, t, r, worker, attempt, &job)
			if err != nil {
				executionErr = err
			} else {
				var workflowChild bool
				if e = s.db.QueryRowContext(run, `SELECT EXISTS(SELECT 1 FROM golf_workflow_agent_children WHERE task_id=$1)`, t.ID).Scan(&workflowChild); e != nil {
					executionErr = errStorageUnavailable
					cleanup()
				} else {
					job.ACP.StopAfterTurn = workflowChild
					result, executionErr = executor.ExecuteAgent(run, job)
					cleanup()
				}
			}
		}
	} else {
		result, executionErr = executor.ExecuteAgent(run, job)
	}

	journaled := job.Observe != nil
	stop()
	<-heartbeatDone
	if executionErr != nil {
		log.Printf("managed agent execution failed at fixed stage %s", result.Stage)
	}
	finish, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if executionErr != nil && result.State == "succeeded" {
		result.State = "lost"
		result.Patch = ""
		result.Summary = ""
	}
	if result.State == "" {
		result.State = "lost"
	}
	if ctx.Err() != nil {
		result.State = "cancelled"
	}
	// Defend against accidental native echo. The command sandbox must separately
	// pass the credential-read denial qualification; redaction is not that boundary.
	if agentContainsCredential(result.Summary, []byte(plain)) || agentContainsCredential(result.Patch, []byte(plain)) || agentContainsCredential(result.Summary, result.Auth) || agentContainsCredential(result.Patch, result.Auth) || journaled && !validConversationAuth(result.Auth) {
		result.State = "failed"
		result.Summary = ""
		result.Patch = ""
	}
	fresh, e := s.taskActor(finish, t)
	if e != nil {
		s.finishAgentFailure(finish, t.ID, attempt, "Dispatch authority was revoked; no result was published.")
		return e
	}
	e = s.codexGuard(finish, fresh, func(tx *sql.Tx, _ int64) error {
		if e := s.agentAttemptFence(finish, tx, fresh, r, t); e != nil {
			return e
		}
		var state string
		if e := tx.QueryRowContext(finish, `SELECT state FROM golf_agent_tasks WHERE id=$1 AND attempt_id=$2 AND worker_id=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE`, t.ID, attempt, worker).Scan(&state); e != nil || (state != "running" && state != "cancelled") {
			return errExecutionPolicyConflict
		}
		conversationSafe := false
		if journaled {
			var screenErr error
			conversationSafe, screenErr = s.screenConversation(finish, tx, t, attempt, []byte(plain), result.Auth)
			if screenErr != nil {
				return screenErr
			}
			if result.ConversationUnavailable {
				conversationSafe = false
			}
			if !conversationSafe && !result.ConversationUnavailable && result.State == "succeeded" {
				result.State = "failed"
				result.Summary = ""
				result.Patch = ""
			}
		}
		// The rotating credential returns only to the original, current authorized
		// connection. Never overwrite a newer login or resurrect a disconnected one.
		if e := s.persistAgentCredential(finish, tx, r, result.Auth); e != nil {
			return e
		}

		if state == "cancelled" {
			// Preserve native renewal under the original current account fence while
			// never reviving cancellation or retaining its proposed output.
			_, e := tx.ExecContext(finish, `UPDATE golf_agent_tasks SET tokens=GREATEST(tokens,$2) WHERE id=$1 AND state='cancelled'`, t.ID, result.Tokens)
			if e == nil && journaled {
				e = s.finalizeConversation(finish, tx, t, attempt, false)
			}
			return e
		}
		reason := ""
		if executionErr != nil {
			reason = "Native task or Docker execution failed; private diagnostics withheld. No automatic retry."
			if strings.HasPrefix(result.Stage, "review-") && regexp.MustCompile(`^[a-z0-9-]{1,80}$`).MatchString(result.Stage) {
				reason = "Read-only review failed (" + result.Stage + "). No automatic task replay."
			}
		}
		_, e := tx.ExecContext(finish, `UPDATE golf_agent_tasks SET state=$2,version=version+1,finished_at=clock_timestamp(),summary=$3,patch=$4,tokens=$5,reason=$6 WHERE id=$1`, t.ID, result.State, result.Summary, result.Patch, result.Tokens, reason)
		if e != nil {
			return e
		}
		if journaled {
			if e = s.finalizeConversation(finish, tx, t, attempt, conversationSafe && result.State == "succeeded" && executionErr == nil); e != nil {
				return e
			}
		}
		if _, e = s.taskActor(finish, t); e != nil {
			return e
		}
		return s.reviewTaskAccess(finish, t)
	})
	if e != nil {
		s.finishAgentFailure(finish, t.ID, attempt, "Policy/account authority changed; no result was published.")
	}
	return e
}
func (s *Server) finishAgentFailure(ctx context.Context, id, attempt, reason string) {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `UPDATE golf_agent_tasks SET state='lost',reason=$3,version=version+1,finished_at=clock_timestamp(),summary='',patch='' WHERE id=$1 AND attempt_id=$2 AND state='running'`, id, attempt, reason); e != nil {
		return
	}
	if _, e = tx.ExecContext(ctx, `UPDATE golf_agent_conversations SET body_state='UNAVAILABLE' WHERE task_id=$1 AND attempt_id=$2 AND body_state='WITHHELD'`, id, attempt); e != nil {
		return
	}
	_ = tx.Commit()
}
func runnerAttemptID() (string, error) { return runner.NewAttemptID() }
func agentContainsCredential(text string, raw []byte) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	var check func(any) bool
	check = func(v any) bool {
		switch x := v.(type) {
		case string:
			return len(x) >= 20 && strings.Contains(text, x)
		case map[string]any:
			for _, a := range x {
				if check(a) {
					return true
				}
			}
		case []any:
			for _, a := range x {
				if check(a) {
					return true
				}
			}
		}
		return false
	}
	return check(value)
}

// Preserve the last known native cache when recovery failed or returned a
// malformed/non-object payload. This is the existing broker cache-shape bound,
// not a claim that syntactically valid credentials can still authenticate.
func (s *Server) persistAgentCredential(ctx context.Context, tx *sql.Tx, r codexRecord, auth []byte) error {
	if !validConversationAuth(auth) {
		return nil
	}
	encrypted, key, e := s.keyring.seal(infrastructureConnectionDomain, string(auth), codexBinding(r.ID))
	if e != nil {
		return e
	}
	result, e := tx.ExecContext(ctx, `UPDATE golf_codex_auth SET encrypted_credential=$2,credential_key_id=$3 WHERE connection_id=$1 AND EXISTS(SELECT 1 FROM golf_codex_connections c WHERE c.id=$1 AND c.version=$4 AND c.state='CONNECTED')`, r.ID, encrypted, key, r.Version)
	if e != nil {
		return errStorageUnavailable
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return errCodexConflict
	}
	result, e = tx.ExecContext(ctx, `UPDATE golf_codex_connections SET version=version+1,checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND version=$2 AND state='CONNECTED'`, r.ID, r.Version)
	if e != nil {
		return errStorageUnavailable
	}
	n, _ = result.RowsAffected()
	if n != 1 {
		return errCodexConflict
	}
	_, e = tx.ExecContext(ctx, `UPDATE golf_agent_model_catalogs SET connection_version=$2 WHERE connection_id=$1 AND connection_version=$3`, r.ID, r.Version+1, r.Version)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}
