package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestACPInteractiveProtocol(t *testing.T) {
	for _, scenario := range []string{"reply", "cancel", "permission", "always-refused", "resume", "resume-refused", "lost-ack", "revoked", "foreign-session", "thought-private", "duplicate-permission", "cancel-permission", "steer-refused"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, stop := context.WithTimeout(t.Context(), 2*time.Second)
			defer stop()
			client, agent := net.Pipe()
			defer agent.Close()
			input := make(chan ACPInput, 3)
			kind := "prompt"
			if scenario == "steer-refused" {
				kind = "steer"
			}
			input <- ACPInput{ID: "first", Kind: kind, Text: "Inspect captured snapshot"}
			sent := []ACPInput{}
			observed := []AgentObservation{}
			revoked := false
			result := make(chan error, 1)
			go func() {
				defer agent.Close()
				dec := json.NewDecoder(agent)
				enc := json.NewEncoder(agent)
				read := func() map[string]any {
					var m map[string]any
					if dec.Decode(&m) != nil {
						return nil
					}
					return m
				}
				write := func(v any) bool { return enc.Encode(v) == nil }
				init := read()
				if init == nil || init["method"] != "initialize" {
					return
				}
				caps := map[string]any{}
				if scenario == "resume" {
					caps["sessionCapabilities"] = map[string]any{"resume": map[string]any{}}
				}
				if !write(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"protocolVersion": 1, "agentCapabilities": caps}}) {
					return
				}
				session := read()
				if session == nil {
					return
				}
				if scenario == "resume" && session["method"] != "session/resume" {
					return
				}
				if !write(map[string]any{"jsonrpc": "2.0", "id": 2, "result": map[string]any{"sessionId": "session"}}) {
					return
				}
				prompt := read()
				if prompt == nil {
					return
				}
				id := prompt["id"]
				if scenario == "lost-ack" || scenario == "revoked" {
					return
				}
				update := func(kind, text string) {
					sid := "session"
					if scenario == "foreign-session" {
						sid = "foreign"
					}
					write(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": kind, "content": map[string]string{"type": "text", "text": text}}}})
				}
				if scenario == "thought-private" {
					update("agent_thought_chunk", "PRIVATE REASONING")
				}
				if strings.Contains(scenario, "permission") || scenario == "always-refused" {
					permission := map[string]any{"jsonrpc": "2.0", "id": "approval1", "method": "session/request_permission", "params": map[string]any{"sessionId": "session", "toolCall": map[string]string{"toolCallId": "call"}, "options": []any{map[string]string{"optionId": "once", "kind": "allow_once"}, map[string]string{"optionId": "always", "kind": "allow_always"}}}}
					if scenario == "cancel-permission" {
						input <- ACPInput{ID: "stop-approval", Kind: "cancel"}
					}
					if !write(permission) {
						return
					}
					decision := read()
					if scenario == "cancel-permission" {
						if decision == nil || decision["method"] != "session/cancel" {
							return
						}
						decision = read()
					}
					if decision == nil {
						return
					}
					want := "selected"
					if scenario == "always-refused" || scenario == "cancel-permission" {
						want = "cancelled"
					}
					got := decision["result"].(map[string]any)["outcome"].(map[string]any)["outcome"]
					if got != want {
						return
					}
					if scenario == "duplicate-permission" {
						write(permission)
						return
					}
				}
				if scenario == "cancel" {
					input <- ACPInput{ID: "stop", Kind: "cancel"}
					cancel := read()
					if cancel == nil || cancel["method"] != "session/cancel" {
						return
					}
					close(input)
					write(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]string{"stopReason": "cancelled"}}) // reader closes input emits second cancel only if still active; tolerate below
					read()
					return
				}
				if scenario == "cancel-permission" {
					write(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]string{"stopReason": "cancelled"}})
					<-ctx.Done()
					return
				}
				update("agent_message_chunk", "Safe reply")
				if scenario == "foreign-session" {
					return
				}
				write(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]string{"stopReason": "end_turn"}})
				if scenario == "reply" {
					next := read()
					if next == nil || next["method"] != "session/prompt" {
						return
					}
					update("agent_message_chunk", "Follow-up")
					write(map[string]any{"jsonrpc": "2.0", "id": next["id"], "result": map[string]string{"stopReason": "end_turn"}})
				}
				// Keep the transport open until the caller consumes the closed input; EOF
				// without a terminal request receipt is deliberately a protocol failure.
				<-ctx.Done()
			}()
			options := ACPOptions{CWD: "/workspace", Input: input, Gate: func(context.Context) error {
				if revoked {
					return ErrACPProtocol
				}
				return nil
			}, BeforeSend: func(_ context.Context, v ACPInput) error {
				sent = append(sent, v)
				if scenario == "revoked" {
					revoked = true
				}
				return nil
			}, Observe: func(_ context.Context, v AgentObservation) error {
				observed = append(observed, v)
				if v.Kind == "turn_completed" {
					if scenario == "reply" && len(sent) == 1 {
						input <- ACPInput{ID: "second", Kind: "reply", Text: "Explain recommendation"}
					} else if scenario != "cancel" {
						close(input)
					}
				}
				return nil
			}, Permission: func(permissionContext context.Context, _ ACPPermission) (string, error) {
				if scenario == "cancel-permission" {
					<-permissionContext.Done()
					return "once", nil
				}
				if scenario == "always-refused" {
					return "always", nil
				}
				return "once", nil
			}}
			if scenario == "resume" || scenario == "resume-refused" {
				options.ResumeSession = "session"
			}
			go func() { result <- RunACP(ctx, client, options) }()
			err := <-result
			failure := scenario == "resume-refused" || scenario == "lost-ack" || scenario == "revoked" || scenario == "foreign-session" || scenario == "duplicate-permission" || scenario == "steer-refused"
			if failure != (err != nil) {
				t.Fatalf("unexpected outcome %v", err)
			}
			for _, v := range observed {
				if strings.Contains(v.Text, "PRIVATE") {
					t.Fatal("reasoning escaped projection")
				}
			}
			if scenario == "reply" && len(sent) != 2 {
				t.Fatal("follow-up was not dispatched exactly once")
			}
			if scenario == "lost-ack" && len(sent) != 1 {
				t.Fatal("unknown prompt resent")
			}
			stop()
		})
	}
}

type acpProcessStream struct {
	io.ReadCloser
	input io.WriteCloser
	cmd   *exec.Cmd
	once  sync.Once
}

func (s *acpProcessStream) Write(b []byte) (int, error) { return s.input.Write(b) }
func (s *acpProcessStream) Close() error {
	s.once.Do(func() {
		s.input.Close()
		s.ReadCloser.Close()
		if s.cmd.Process != nil {
			s.cmd.Process.Kill()
		}
		s.cmd.Wait()
	})
	return nil
}

// Opt-in actual installed OpenCode handshake/session only. No prompt/model,
// inherited credentials or user configuration. This does not qualify the
// pinned Docker image, inference, permissions or persisted context restoration.
func TestACPNativeOpenCodeSession(t *testing.T) {
	binary := os.Getenv("GOLF_TEST_ACP_BINARY")
	if binary == "" {
		t.Skip("explicit native binary required")
	}
	if !filepath.IsAbs(binary) {
		t.Fatal("absolute owned executable required")
	}
	home := t.TempDir()
	ctx, stop := context.WithTimeout(t.Context(), 20*time.Second)
	defer stop()
	cmd := exec.CommandContext(ctx, binary, "acp")
	cmd.Dir = home
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + home, "XDG_CONFIG_HOME=" + home + "/config", "XDG_DATA_HOME=" + home + "/data", "XDG_CACHE_HOME=" + home + "/cache", "OPENCODE_DISABLE_AUTOUPDATE=true", "OPENCODE_DISABLE_MODELS_FETCH=true", "OPENCODE_DISABLE_DEFAULT_PLUGINS=true", "OPENCODE_CONFIG_CONTENT={\"autoupdate\":false,\"share\":\"disabled\",\"plugin\":[],\"mcp\":{},\"permission\":{\"*\":\"deny\"}}"}
	cmd.Stderr = io.Discard
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal("native input unavailable")
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal("native output unavailable")
	}
	if cmd.Start() != nil {
		t.Fatal("native process unavailable")
	}
	stream := &acpProcessStream{ReadCloser: output, input: input, cmd: cmd}
	defer stream.Close()
	commands := make(chan ACPInput)
	seen := false
	err = RunACP(ctx, stream, ACPOptions{CWD: home, Input: commands, Gate: func(context.Context) error { return nil }, BeforeSend: func(context.Context, ACPInput) error { t.Fatal("unexpected native inference"); return ErrACPProtocol }, Observe: func(_ context.Context, v AgentObservation) error {
		if v.Kind != "thread_started" {
			t.Fatal("unexpected native event")
		}
		seen = true
		close(commands)
		return nil
	}})
	if err != nil || !seen {
		t.Fatalf("native ACP initialization/session proof failed: %v (session seen: %t)", err, seen)
	}
}

func TestACPRejectsMalformedFrames(t *testing.T) {
	// A real executable/transport fixture is used above. These framing checks
	// prevent unbounded stdout or plain process output from becoming trusted data.
	for _, raw := range []string{"plain stdout\n", `{"id":1,"result":{}}` + "\n", strings.Repeat("x", 256<<10) + "\n"} {
		client, agent := net.Pipe()
		ctx, stop := context.WithTimeout(t.Context(), time.Second)
		go func() { defer agent.Close(); bufio.NewReader(agent).ReadString('\n'); io.WriteString(agent, raw) }()
		err := RunACP(ctx, client, ACPOptions{CWD: "/workspace", Gate: func(context.Context) error { return nil }, BeforeSend: func(context.Context, ACPInput) error { return nil }, Observe: func(context.Context, AgentObservation) error { return nil }})
		stop()
		if err == nil {
			t.Fatal("accepted malformed protocol")
		}
	}
}

func TestACPRequestIdentityCanonical(t *testing.T) {
	a, ok := acpRequestIdentity(json.RawMessage(`"approval"`))
	b, ok2 := acpRequestIdentity(json.RawMessage(`"\u0061pproval"`))
	if !ok || !ok2 || a != b {
		t.Fatal("escaped same request became a second approval")
	}
	for _, raw := range []string{`1.0`, `{}`, `null`, `-1`, `"bad id"`} {
		if _, ok := acpRequestIdentity(json.RawMessage(raw)); ok {
			t.Fatal("ambiguous request ID accepted")
		}
	}
}
