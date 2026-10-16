package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

type agentControlRecord struct {
	State, Session, Image, Version, Permission, Tool string
	Revision, Screened                               int64
	Resume                                           bool
	FileTools                                        bool
	Options                                          []string
}

func agentControlRow(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, task, attempt string, lock bool) (v agentControlRecord, err error) {
	query := `SELECT state,native_session,image,native_version,permission_id,tool_id,revision,screened_sequence,resume,file_tools_qualified,allow_once_options FROM golf_agent_controls WHERE task_id=$1 AND attempt_id=$2`
	if lock {
		query += " FOR UPDATE"
	}
	var raw []byte
	err = q.QueryRowContext(ctx, query, task, attempt).Scan(&v.State, &v.Session, &v.Image, &v.Version, &v.Permission, &v.Tool, &v.Revision, &v.Screened, &v.Resume, &v.FileTools, &raw)
	if err == nil && json.Unmarshal(raw, &v.Options) != nil {
		err = errStorageUnavailable
	}
	return
}
func (s *Server) agentACPAvailable(ctx context.Context) bool {
	if s.db == nil || s.config.ReviewImage == "" {
		return false
	}
	var ready bool
	_ = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_agent_worker_presence WHERE forge_url=$1 AND acp_image=$2 AND acp_version=$3 AND last_seen>clock_timestamp()-interval '30 seconds')`, s.config.ForgeURL, s.config.ReviewImage, runner.ManagedACPVersion).Scan(&ready)
	return ready
}
func (s *Server) GetAgentControl(ctx context.Context, req *connect.Request[golfv1.GetAgentControlRequest]) (*connect.Response[golfv1.GetAgentControlResponse], error) {
	a, err := s.codexIdentity(ctx, req.Header())
	if err != nil {
		return nil, rpcError(err)
	}
	if req.Msg.TaskId == "" && req.Msg.AttemptId == "" {
		out := &golfv1.AgentControl{Available: s.agentACPAvailable(ctx), State: "closed", Reason: "A fresh exact image/native ACP qualification is required."}
		if out.Available {
			out.NativeVersion = runner.ManagedACPVersion
			out.Image = s.config.ReviewImage
			out.Reason = "Qualified managed ACP is available; task admission still requires current repository, policy and connection authority."
		}
		if err = s.codexGuard(ctx, a, func(*sql.Tx, int64) error { return nil }); err != nil {
			return nil, rpcError(err)
		}
		return connect.NewResponse(&golfv1.GetAgentControlResponse{Control: out}), nil
	}
	t, err := s.taskRecord(ctx, req.Msg.TaskId)
	if err == nil {
		err = s.taskAccess(ctx, a, t)
	}
	if err != nil {
		return nil, rpcError(err)
	}
	if t.Attempt != req.Msg.AttemptId {
		return nil, rpcError(errExecutionPolicyConflict)
	}
	out := &golfv1.AgentControl{TaskId: t.ID, AttemptId: t.Attempt, TaskVersion: strconv.FormatInt(t.Version, 10), State: "closed", Reason: "This attempt has no qualified managed ACP sandbox."}
	c, err := agentControlRow(ctx, s.db, t.ID, t.Attempt, false)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, rpcError(errStorageUnavailable)
	}
	if err == nil {
		out.Revision = strconv.FormatInt(c.Revision, 10)
		out.State = c.State
		out.Image = c.Image
		out.NativeVersion = c.Version
		available := t.State == "running" && c.State != "closed" && bytesEqual(a.Hash, t.Hash) && s.agentACPAvailable(ctx)
		if available {
			_, err = s.taskActor(ctx, t)
			if err == nil {
				r, e := s.codexAuthorized(ctx, a, t.Connection, false)
				err = e
				if err == nil {
					err = s.conversationGuard(ctx, t, r, t.Worker, t.Attempt, func(*sql.Tx) error { return nil })
				}
			}
		}
		if err != nil {
			return nil, rpcError(err)
		}
		out.Available = available
		out.FilePermissionsQualified = available && c.FileTools
		out.CanResume = available && c.Resume && c.State == "idle"
		out.Reason = "Only the original current browser session controls this preserved sandbox. Restart or authority loss ends it; no transcript replay."
		if available && c.State == "permission" {
			out.PermissionId = c.Permission
			out.ToolId = c.Tool
			out.AllowOnceOptions = c.Options
		}
		if available && c.Screened > 0 {
			rows, e := s.db.QueryContext(ctx, `SELECT `+conversationEventColumns+` FROM golf_agent_task_events e JOIN golf_agent_conversation_contents c ON c.id=e.content_id WHERE e.task_id=$1 AND e.attempt_id=$2 AND e.sequence<=$3 AND e.kind IN ('assistant_message','user_message') ORDER BY e.sequence LIMIT 64`, t.ID, t.Attempt, c.Screened)
			if e != nil {
				return nil, rpcError(errStorageUnavailable)
			}
			total := 0
			for rows.Next() {
				v, e := scanConversationEvent(rows)
				if e != nil {
					rows.Close()
					return nil, rpcError(errStorageUnavailable)
				}
				p, e := s.openConversationEvent(t, t.Attempt, v)
				if e != nil {
					rows.Close()
					return nil, rpcError(e)
				}
				total += len(p.Observation.Text)
				if total > conversationBytes {
					rows.Close()
					return nil, rpcError(errStorageUnavailable)
				}
				out.Messages = append(out.Messages, &golfv1.AgentControlMessage{Sequence: strconv.FormatInt(v.Sequence, 10), Text: p.Observation.Text})
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return nil, rpcError(errStorageUnavailable)
			}
		}
	}
	if err = s.codexGuard(ctx, a, func(*sql.Tx, int64) error { return nil }); err != nil {
		return nil, rpcError(err)
	}
	if err = s.taskAccess(ctx, a, t); err != nil {
		return nil, rpcError(err)
	}
	if out.Available {
		r, e := s.codexAuthorized(ctx, a, t.Connection, false)
		if e != nil {
			return nil, rpcError(e)
		}
		if e = s.conversationGuard(ctx, t, r, t.Worker, t.Attempt, func(*sql.Tx) error { return nil }); e != nil {
			return nil, rpcError(e)
		}
	}
	return connect.NewResponse(&golfv1.GetAgentControlResponse{Control: out}), nil
}

func validAgentCommand(m *golfv1.SubmitAgentCommandRequest, c agentControlRecord) bool {
	if !creationKey.MatchString(m.RequestId) || !conversationText(m.Text, 8192) {
		return false
	}
	switch m.Kind {
	case "reply":
		return c.State == "idle" && strings.TrimSpace(m.Text) != "" && m.PermissionId == "" && m.OptionId == ""
	case "resume":
		return c.State == "idle" && c.Resume && m.Text == "" && m.PermissionId == "" && m.OptionId == ""
	case "cancel_turn":
		return (c.State == "active" || c.State == "permission") && m.Text == "" && m.PermissionId == "" && m.OptionId == ""
	case "finish":
		return c.State == "idle" && m.Text == "" && m.PermissionId == "" && m.OptionId == ""
	case "permission":
		if c.State != "permission" || m.PermissionId != c.Permission || m.Text != "" {
			return false
		}
		if m.OptionId == "" {
			return true
		}
		if !c.FileTools {
			return false
		}
		for _, v := range c.Options {
			if v == m.OptionId {
				return true
			}
		}
	}
	return false
}
func (s *Server) SubmitAgentCommand(ctx context.Context, req *connect.Request[golfv1.SubmitAgentCommandRequest]) (*connect.Response[golfv1.SubmitAgentCommandResponse], error) {
	a, err := s.codexIdentity(ctx, req.Header())
	if err != nil {
		return nil, rpcError(err)
	}
	m := req.Msg
	t, err := s.taskRecord(ctx, m.TaskId)
	if err == nil {
		err = s.taskAccess(ctx, a, t)
	}
	if err != nil {
		return nil, rpcError(err)
	}
	if t.Attempt != m.AttemptId || !bytesEqual(a.Hash, t.Hash) || !creationKey.MatchString(m.RequestId) {
		return nil, rpcError(errExecutionPolicyConflict)
	}
	if !s.agentACPAvailable(ctx) {
		return nil, rpcError(errRunnerUnavailable)
	}
	r, err := s.codexAuthorized(ctx, a, t.Connection, false)
	if err != nil {
		return nil, rpcError(err)
	}
	raw, _ := json.Marshal(m)
	digest := sha256.Sum256(raw)
	state := "queued"
	err = s.conversationGuard(ctx, t, r, t.Worker, t.Attempt, func(tx *sql.Tx) error {
		c, e := agentControlRow(ctx, tx, t.ID, t.Attempt, true)
		if e != nil {
			return errExecutionPolicyConflict
		}
		var old []byte
		e = tx.QueryRowContext(ctx, `SELECT input_hash,state FROM golf_agent_commands WHERE task_id=$1 AND attempt_id=$2 AND request_id=$3`, t.ID, t.Attempt, m.RequestId).Scan(&old, &state)
		if e == nil {
			if !bytesEqual(old, digest[:]) {
				return errExecutionPolicyConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		if m.ExpectedTaskVersion != strconv.FormatInt(t.Version, 10) || m.ExpectedRevision != strconv.FormatInt(c.Revision, 10) || !validAgentCommand(m, c) {
			return errExecutionPolicyConflict
		}
		var pending bool
		if tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_agent_commands WHERE task_id=$1 AND attempt_id=$2 AND state='queued')`, t.ID, t.Attempt).Scan(&pending) != nil {
			return errStorageUnavailable
		}
		if pending {
			return errExecutionPolicyConflict
		}
		// Reuse the existing encrypted content inventory, binding and rotation path.
		var sequence int64
		if tx.QueryRowContext(ctx, `SELECT last_sequence FROM golf_agent_conversations WHERE task_id=$1 AND attempt_id=$2`, t.ID, t.Attempt).Scan(&sequence) != nil {
			return errStorageUnavailable
		}
		binding := conversationBinding(t, s.config.ForgeURL, t.Attempt, sequence, raw)
		cipher, key, e := s.keyring.seal(conversationContentDomain, string(raw), binding)
		if e != nil {
			return e
		}
		content := uuid.NewString()
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_agent_conversation_contents(id,task_id,attempt_id,forge_url,repository_id,user_id,sequence,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, content, t.ID, t.Attempt, s.config.ForgeURL, t.RepositoryID, t.UserID, sequence, cipher, binding, key)
		if e != nil {
			return errStorageUnavailable
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_agent_commands(task_id,attempt_id,request_id,kind,input_hash,content_id) VALUES($1,$2,$3,$4,$5,$6)`, t.ID, t.Attempt, m.RequestId, m.Kind, digest[:], content)
		if e != nil {
			return errStorageUnavailable
		}
		_, e = tx.ExecContext(ctx, `UPDATE golf_agent_controls SET state='dispatching',revision=revision+1 WHERE task_id=$1 AND attempt_id=$2`, t.ID, t.Attempt)
		return e
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.SubmitAgentCommandResponse{RequestId: m.RequestId, State: state}), nil
}
