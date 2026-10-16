package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestAgentControlCommands(t *testing.T) {
	c := agentControlRecord{State: "idle", Resume: true}
	m := &golfv1.SubmitAgentCommandRequest{RequestId: uuid.NewString(), Kind: "reply", Text: "Continue"}
	if !validAgentCommand(m, c) {
		t.Fatal("bounded reply refused")
	}
	for _, kind := range []string{"steer", "allow_always", "cancel_turn", "permission"} {
		m.Kind = kind
		if validAgentCommand(m, c) {
			t.Fatal("unsupported command accepted", kind)
		}
	}
	c.State = "permission"
	c.Permission = "s/native-request"
	c.Options = []string{"once"}
	c.FileTools = true
	m.Kind = "permission"
	m.Text = ""
	m.PermissionId = c.Permission
	m.OptionId = "once"
	if !validAgentCommand(m, c) {
		t.Fatal("exact native once refused")
	}
	c.FileTools = false
	if validAgentCommand(m, c) {
		t.Fatal("unqualified native file execution accepted")
	}
	m.OptionId = ""
	if !validAgentCommand(m, c) {
		t.Fatal("unqualified file request could not be rejected")
	}
	c.FileTools = true
	m.OptionId = "always"
	if validAgentCommand(m, c) {
		t.Fatal("persistent permission accepted")
	}
	m.OptionId = ""
	m.PermissionId = "foreign"
	if validAgentCommand(m, c) {
		t.Fatal("foreign native request accepted")
	}
}

func TestAgentControlFakeProcess(t *testing.T) {
	if os.Getenv("GOLF_AGENT_CONTROL_FAKE") != "1" {
		return
	}
	dec := json.NewDecoder(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	session := "native-preserved-session"
	turn := 0
	send := func(v any) {
		if enc.Encode(v) != nil {
			os.Exit(3)
		}
	}
	update := func(v any) {
		send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": session, "update": v}})
	}
	var pending any
	for {
		var m map[string]any
		if dec.Decode(&m) != nil {
			os.Exit(0)
		}
		switch m["method"] {
		case "initialize":
			send(map[string]any{"jsonrpc": "2.0", "id": m["id"], "result": map[string]any{"protocolVersion": 1, "agentInfo": map[string]string{"version": runner.ManagedACPVersion}, "agentCapabilities": map[string]any{"sessionCapabilities": map[string]any{"resume": map[string]any{}}}}})
		case "session/new", "session/resume":
			send(map[string]any{"jsonrpc": "2.0", "id": m["id"], "result": map[string]any{"sessionId": session, "modes": map[string]string{"currentModeId": "golf-workspace"}, "models": map[string]string{"currentModelId": "opencode-go/model"}}})
		case "session/prompt":
			turn++
			pending = m["id"]
			update(map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]string{"type": "text", "text": "PRIVATE REASONING"}})
			if turn == 1 {
				update(map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "Initial reply from the real subprocess"}})
				send(map[string]any{"jsonrpc": "2.0", "id": pending, "result": map[string]string{"stopReason": "end_turn"}})
			} else {
				update(map[string]any{"sessionUpdate": "tool_call", "toolCallId": "workspace-read", "kind": "read", "status": "pending"})
				send(map[string]any{"jsonrpc": "2.0", "id": "permission-1", "method": "session/request_permission", "params": map[string]any{"sessionId": session, "toolCall": map[string]string{"toolCallId": "workspace-read"}, "options": []any{map[string]string{"optionId": "once", "kind": "allow_once"}, map[string]string{"optionId": "always", "kind": "allow_always"}}}})
			}
		case "session/cancel":
			send(map[string]any{"jsonrpc": "2.0", "id": pending, "result": map[string]string{"stopReason": "cancelled"}})
		default:
			if m["id"] == "permission-1" {
				update(map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "Completed after the original permission decision"}})
				send(map[string]any{"jsonrpc": "2.0", "id": pending, "result": map[string]string{"stopReason": "end_turn"}})
			} else {
				os.Exit(4)
			}
		}
	}
}

func controlContext(t *testing.T, f *conversationFixture) (context.Context, string) {
	t.Helper()
	token, e := f.x.f.server.sessionCredential(t.Context(), f.x.login.Value)
	if e != nil {
		t.Fatal(e)
	}
	return context.WithValue(t.Context(), sessionTokenKey{}, token), f.x.f.server.sessionCookie(f.x.login.Value, f.x.login.Expires, 3600).String()
}
func TestAgentControlManagedSubprocessPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	s := f.x.f.server
	s.config.ReviewImage = "sha256:" + strings.Repeat("d", 64)
	if _, e := s.db.Exec(`INSERT INTO golf_agent_worker_presence(forge_url,worker_id,image,acp_image,acp_version,acp_file_tools) VALUES($1,'worker',$2,$2,$3,true)`, s.config.ForgeURL, s.config.ReviewImage, runner.ManagedACPVersion); e != nil {
		t.Fatal(e)
	}
	ctx, cookie := controlContext(t, f)
	j := runner.AgentJob{Auth: conversationInitial, Model: "opencode-go/model", Instructions: "Exact original task prompt", Observe: func(ctx context.Context, v runner.AgentObservation) error {
		return s.observeConversation(ctx, f.t, f.r, "worker", f.attempt, v, conversationInitial)
	}}
	finish, e := s.managedACPJob(ctx, f.t, f.r, "worker", f.attempt, &j)
	if e != nil {
		t.Fatal(e)
	}
	defer finish()
	processCtx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	process := exec.CommandContext(processCtx, os.Args[0], "-test.run=^TestAgentControlFakeProcess$")
	process.Env = []string{"GOLF_AGENT_CONTROL_FAKE=1"}
	process.Stderr = io.Discard
	input, e := process.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	output, e := process.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	if e = process.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { input.Close(); process.Process.Kill(); process.Wait() }()
	adapterDone := make(chan error, 1)
	go func() { adapterDone <- runner.RunACP(processCtx, &testACPStream{output, input}, *j.ACP) }()
	get := func() *golfv1.AgentControl {
		request := connect.NewRequest(&golfv1.GetAgentControlRequest{TaskId: f.t.ID, AttemptId: f.attempt})
		request.Header().Set("Cookie", cookie)
		v, e := s.GetAgentControl(ctx, request)
		if e != nil {
			t.Fatal(e)
		}
		return v.Msg.Control
	}
	wait := func(state string) *golfv1.AgentControl {
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			v := get()
			if v.State == state {
				return v
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatal("managed state did not reach", state)
		return nil
	}
	send := func(c *golfv1.AgentControl, kind, text, option string) *golfv1.SubmitAgentCommandRequest {
		m := &golfv1.SubmitAgentCommandRequest{TaskId: f.t.ID, AttemptId: f.attempt, ExpectedTaskVersion: c.TaskVersion, ExpectedRevision: c.Revision, RequestId: uuid.NewString(), Kind: kind, Text: text, OptionId: option}
		if kind == "permission" {
			m.PermissionId = c.PermissionId
		}
		request := connect.NewRequest(m)
		request.Header().Set("Cookie", cookie)
		if _, e := s.SubmitAgentCommand(ctx, request); e != nil {
			t.Fatal(e)
		}
		return m
	}
	idle := wait("idle")
	if !idle.Available || !idle.CanResume {
		t.Fatal("real session receipt unavailable")
	}
	// Checkpoint the actual completed native projection; no private reasoning leaks.
	if e = j.Checkpoint(ctx, conversationRefreshed); e != nil {
		t.Fatal(e)
	}
	idle = get()
	if len(idle.Messages) != 1 || strings.Contains(idle.Messages[0].Text, "REASONING") {
		t.Fatal("completed projection missing or private reasoning escaped")
	}
	send(idle, "resume", "", "")
	idle = wait("idle")
	reply := send(idle, "reply", "Follow up in the original workspace", "")
	permission := wait("permission")
	if len(permission.AllowOnceOptions) != 1 || permission.AllowOnceOptions[0] != "once" {
		t.Fatal("native permission option widened")
	}
	send(permission, "permission", "", "once")
	idle = wait("idle")
	if e = j.Checkpoint(ctx, conversationRefreshed); e != nil {
		t.Fatal(e)
	}
	// Original UUID inspection is idempotent; it does not hand off a second prompt.
	repeated := connect.NewRequest(reply)
	repeated.Header().Set("Cookie", cookie)
	if receipt, e := s.SubmitAgentCommand(ctx, repeated); e != nil || receipt.Msg.State != "claimed" {
		t.Fatal("original command inspection changed", e)
	}
	var claimed, sends int
	if e = s.db.QueryRow(`SELECT count(*) FROM golf_agent_commands WHERE task_id=$1 AND state='claimed'`, f.t.ID).Scan(&claimed); e != nil {
		t.Fatal(e)
	}
	if e = s.db.QueryRow(`SELECT count(*) FROM golf_agent_native_sends WHERE task_id=$1`, f.t.ID).Scan(&sends); e != nil || claimed != 3 || sends != 4 {
		t.Fatal("handoff replayed or lost", claimed, sends, e)
	}
	send(get(), "finish", "", "")
	select {
	case e = <-adapterDone:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("finish did not close preserved session")
	}
	finish()
	if get().Available {
		t.Fatal("closed sandbox retained control authority")
	}
	if _, e = s.db.Exec(`UPDATE golf_agent_commands SET state='queued' WHERE task_id=$1 AND state='claimed'`, f.t.ID); e == nil {
		t.Fatal("claimed command replay enabled")
	}
}

type testACPStream struct {
	io.Reader
	io.WriteCloser
}

func (s *testACPStream) Close() error { return s.WriteCloser.Close() }

func TestAgentControlAuthorityLossPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	s := f.x.f.server
	s.config.ReviewImage = "sha256:" + strings.Repeat("d", 64)
	if _, e := s.db.Exec(`INSERT INTO golf_agent_controls(task_id,attempt_id,image,native_version,native_session,state) VALUES($1,$2,$3,$4,'native','idle')`, f.t.ID, f.attempt, s.config.ReviewImage, runner.ManagedACPVersion); e != nil {
		t.Fatal(e)
	}
	if _, e := s.db.Exec(`INSERT INTO golf_agent_worker_presence(forge_url,worker_id,image,acp_image,acp_version,acp_file_tools) VALUES($1,'worker',$2,$2,$3,true)`, s.config.ForgeURL, s.config.ReviewImage, runner.ManagedACPVersion); e != nil {
		t.Fatal(e)
	}
	ctx, cookie := controlContext(t, f)
	req := connect.NewRequest(&golfv1.GetAgentControlRequest{TaskId: f.t.ID, AttemptId: f.attempt})
	req.Header().Set("Cookie", cookie)
	if _, e := s.GetAgentControl(ctx, req); e != nil {
		t.Fatal(e)
	}
	originalImage := s.config.ReviewImage
	s.config.ReviewImage = "sha256:" + strings.Repeat("e", 64)
	if response, e := s.GetAgentControl(ctx, req); e == nil && response.Msg.Control.Available {
		t.Fatal("changed configured image adopted an original live control")
	}
	s.config.ReviewImage = originalImage
	changedAccount := f.r
	changedAccount.Version++
	if e := s.conversationGuard(ctx, f.t, changedAccount, "worker", f.attempt, func(*sql.Tx) error { t.Fatal("new account generation published to old attempt"); return nil }); e == nil {
		t.Fatal("new account generation adopted an original live control")
	}
	if _, e := s.db.Exec(`UPDATE golf_agent_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, f.t.ID); e != nil {
		t.Fatal(e)
	}
	if _, e := s.GetAgentControl(ctx, req); e == nil {
		t.Fatal("expired original lease exposed controls")
	}
	// Recovery closes without changing the original native identity or replaying.
	if _, e := s.db.Exec(`UPDATE golf_agent_controls SET state='closed',revision=revision+1 WHERE state<>'closed'`); e != nil {
		t.Fatal(e)
	}
	if _, e := s.db.Exec(`UPDATE golf_agent_controls SET state='idle',revision=revision+1 WHERE task_id=$1`, f.t.ID); e == nil {
		t.Fatal("restored sandbox reopened")
	}
}
