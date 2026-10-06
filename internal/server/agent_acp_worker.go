package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

// One worker/process owns one live sandbox. Commands are marked claimed before
// handing them off. Any lost acknowledgement closes it; claims are never replayed.
func (s *Server) managedACPJob(ctx context.Context, t agentTaskRecord, r codexRecord, worker, attempt string, j *runner.AgentJob) (func(), error) {
	var fileTools bool
	if e := s.db.QueryRowContext(ctx, `SELECT acp_file_tools FROM golf_agent_worker_presence WHERE forge_url=$1 AND worker_id=$2 AND acp_image=$3 AND acp_version=$4 AND last_seen>clock_timestamp()-interval '30 seconds'`, s.config.GiteaURL, worker, s.config.ReviewImage, runner.ManagedACPVersion).Scan(&fileTools); e != nil {
		return nil, errCodexUnavailable
	}
	err := s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, `INSERT INTO golf_agent_controls(task_id,attempt_id,image,native_version,file_tools_qualified) VALUES($1,$2,$3,$4,$5)`, t.ID, attempt, s.config.ReviewImage, runner.ManagedACPVersion, fileTools)
		return e
	})
	if err != nil {
		return nil, err
	}
	run, stop := context.WithCancel(ctx)
	inputs := make(chan runner.ACPInput, 1)
	inputs <- runner.ACPInput{ID: "initial", Kind: "prompt", Text: j.Instructions}
	original := j.Observe
	var sequence int64
	emit := func(ctx context.Context, v runner.AgentObservation) error {
		sequence++
		v.Sequence = sequence
		if e := original(ctx, v); e != nil {
			return e
		}
		state := ""
		if v.Kind == "turn_started" {
			state = "active"
		}
		if v.Kind == "turn_completed" {
			state = "idle"
		}
		if state != "" {
			return s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
				_, e := tx.ExecContext(ctx, `UPDATE golf_agent_controls SET state=$3,permission_id='',tool_id='',allow_once_options='[]',revision=revision+1 WHERE task_id=$1 AND attempt_id=$2 AND state<>'closed'`, t.ID, attempt, state)
				return e
			})
		}
		return nil
	}
	gate := func(ctx context.Context) error {
		if run.Err() != nil {
			return run.Err()
		}
		return s.conversationGuard(ctx, t, r, worker, attempt, func(*sql.Tx) error { return nil })
	}
	options := &runner.ACPOptions{CWD: "/workspace", ExpectedVersion: runner.ManagedACPVersion, ExpectedMode: "golf-workspace", ExpectedModel: j.Model, Input: inputs, Gate: gate, Observe: emit}
	options.Ready = func(ctx context.Context, state runner.ACPState) error {
		if state.Version != runner.ManagedACPVersion || agentContainsCredential(state.Session, j.Auth) {
			return errCodexUnavailable
		}
		readyState := "idle"
		if sequence == 1 {
			readyState = "active"
		}
		return s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
			_, e := tx.ExecContext(ctx, `UPDATE golf_agent_controls SET native_session=$3,resume=$4,state=$5,revision=revision+1 WHERE task_id=$1 AND attempt_id=$2 AND state<>'closed'`, t.ID, attempt, state.Session, state.Resume, readyState)
			return e
		})
	}
	options.BeforeSend = func(ctx context.Context, input runner.ACPInput) error {
		if agentContainsCredential(input.Text, j.Auth) {
			return errCodexUnavailable
		}
		raw, _ := json.Marshal(input)
		digest := sha256.Sum256(raw)
		e := s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
			if input.Kind != "prompt" && input.Kind != "permission" {
				var claimed bool
				if tx.QueryRowContext(ctx, `SELECT state='claimed' FROM golf_agent_commands WHERE task_id=$1 AND attempt_id=$2 AND request_id=$3`, t.ID, attempt, input.ID).Scan(&claimed) != nil || !claimed {
					return errExecutionPolicyConflict
				}
			}
			_, e := tx.ExecContext(ctx, `INSERT INTO golf_agent_native_sends(task_id,attempt_id,input_id,kind,input_hash) VALUES($1,$2,$3,$4,$5)`, t.ID, attempt, input.ID, input.Kind, digest[:])
			if e != nil {
				return e
			}
			state := "active"
			if input.Kind == "cancel" {
				state = "cancelling"
			}
			if input.Kind == "resume" {
				state = "initializing"
			}
			_, e = tx.ExecContext(ctx, `UPDATE golf_agent_controls SET state=$3,permission_id='',tool_id='',allow_once_options='[]',revision=revision+1 WHERE task_id=$1 AND attempt_id=$2 AND state<>'closed'`, t.ID, attempt, state)
			return e
		})
		if e == nil && input.Kind == "reply" {
			e = emit(ctx, runner.AgentObservation{Kind: "user_message", ThreadID: currentACPThread(ctx, s, t.ID, attempt), TurnID: "golf-command-" + input.ID, ItemID: input.ID, Text: input.Text})
		}
		return e
	}
	options.Permission = func(ctx context.Context, p runner.ACPPermission) (string, error) {
		if !conversationNativeID(p.Tool) || !conversationNativeID(p.Session) || agentContainsCredential(p.Tool, j.Auth) || agentContainsCredential(p.ID, j.Auth) {
			return "", errCodexUnavailable
		}
		allowed := []string{}
		for _, option := range p.Options {
			if agentContainsCredential(option.ID, j.Auth) {
				return "", errCodexUnavailable
			}
		}
		// Shell is never approved. These requests are governed by the qualified
		// file-only native policy; the UI receives no tool arguments or file bodies.
		if fileTools && (p.Kind == "read" || p.Kind == "fileChange") {
			for _, o := range p.Options {
				if o.Kind == "allow_once" {
					allowed = append(allowed, o.ID)
				}
			}
		}
		raw, _ := json.Marshal(allowed)
		e := s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
			_, e := tx.ExecContext(ctx, `UPDATE golf_agent_controls SET state='permission',permission_id=$3,tool_id=$4,allow_once_options=$5,revision=revision+1 WHERE task_id=$1 AND attempt_id=$2 AND native_session=$6 AND state<>'closed'`, t.ID, attempt, p.ID, p.Tool, raw, p.Session)
			return e
		})
		if e != nil {
			return "", e
		}
		timer := time.NewTicker(200 * time.Millisecond)
		defer timer.Stop()
		for {
			command, e := s.claimAgentCommand(ctx, t, r, worker, attempt, true)
			if e != nil {
				return "", e
			}
			if command != nil {
				if command.PermissionId != p.ID {
					return "", errExecutionPolicyConflict
				}
				return command.OptionId, nil
			}
			select {
			case <-ctx.Done():
				return "", nil
			case <-timer.C:
			}
		}
	}
	j.ACP = options
	j.Checkpoint = func(ctx context.Context, auth []byte) error {
		return s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
			safe, e := s.screenConversation(ctx, tx, t, attempt, j.Auth, auth)
			if e != nil {
				return e
			}
			if !safe {
				return errCodexUnavailable
			}
			_, e = tx.ExecContext(ctx, `UPDATE golf_agent_controls SET screened_sequence=(SELECT last_sequence FROM golf_agent_conversations WHERE task_id=$1 AND attempt_id=$2),revision=revision+1 WHERE task_id=$1 AND attempt_id=$2 AND state<>'closed'`, t.ID, attempt)
			return e
		})
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(inputs)
		timer := time.NewTicker(200 * time.Millisecond)
		defer timer.Stop()
		for {
			command, e := s.claimAgentCommand(run, t, r, worker, attempt, false)
			if e != nil {
				stop()
				return
			}
			if command != nil {
				if command.Kind == "finish" {
					return
				}
				kind := command.Kind
				if kind == "cancel_turn" {
					kind = "cancel"
				}
				select {
				case inputs <- runner.ACPInput{ID: command.RequestId, Kind: kind, Text: command.Text}:
				case <-run.Done():
					return
				}
			}
			select {
			case <-run.Done():
				return
			case <-timer.C:
			}
		}
	}()
	// Cancel the enclosing execution when the command handoff fails, including
	// a DB acknowledgement lost after the claim committed.
	return func() {
		stop()
		<-done
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = s.db.ExecContext(closeCtx, `UPDATE golf_agent_controls SET state='closed',permission_id='',tool_id='',allow_once_options='[]',revision=revision+1 WHERE task_id=$1 AND attempt_id=$2 AND state<>'closed'`, t.ID, attempt)
	}, nil
}
func currentACPThread(ctx context.Context, s *Server, task, attempt string) string {
	var id string
	_ = s.db.QueryRowContext(ctx, `SELECT native_session FROM golf_agent_controls WHERE task_id=$1 AND attempt_id=$2`, task, attempt).Scan(&id)
	return id
}

func (s *Server) claimAgentCommand(ctx context.Context, t agentTaskRecord, r codexRecord, worker, attempt string, permission bool) (out *golfv1.SubmitAgentCommandRequest, err error) {
	err = s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
		// The same control lock is used by admission, preserving original decision
		// identity while a pending permission and cancellation race.
		if _, e := agentControlRow(ctx, tx, t.ID, attempt, true); e != nil {
			return errStorageUnavailable
		}
		var id, key string
		var raw, binding, digest []byte
		var seq int64
		e := tx.QueryRowContext(ctx, `SELECT c.request_id::text,b.credential_key_id,b.encrypted_content,b.content_binding,c.input_hash,b.sequence FROM golf_agent_commands c JOIN golf_agent_conversation_contents b ON b.id=c.content_id WHERE c.task_id=$1 AND c.attempt_id=$2 AND c.state='queued' AND (c.kind='permission')=$3 ORDER BY c.created_at,c.request_id LIMIT 1 FOR UPDATE OF c`, t.ID, attempt, permission).Scan(&id, &key, &raw, &binding, &digest, &seq)
		if errors.Is(e, sql.ErrNoRows) {
			return nil
		}
		if e != nil {
			return errStorageUnavailable
		}
		text, e := s.keyring.open(key, conversationContentDomain, raw, binding)
		if e != nil {
			return e
		}
		sum := sha256.Sum256([]byte(text))
		m := &golfv1.SubmitAgentCommandRequest{}
		if !bytesEqual(sum[:], digest) || !bytesEqual(binding, conversationBinding(t, s.config.GiteaURL, attempt, seq, []byte(text))) || json.Unmarshal([]byte(text), m) != nil || m.RequestId != id || m.TaskId != t.ID || m.AttemptId != attempt {
			return errStorageUnavailable
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_agent_commands SET state='claimed' WHERE task_id=$1 AND attempt_id=$2 AND request_id=$3 AND state='queued'`, t.ID, attempt, id); e != nil {
			return errStorageUnavailable
		}
		out = m
		return nil
	})
	return
}

// Compile-time check that the browser service stays available to root RPC wiring.
var _ interface {
	GetAgentControl(context.Context, *connect.Request[golfv1.GetAgentControlRequest]) (*connect.Response[golfv1.GetAgentControlResponse], error)
} = (*Server)(nil)
