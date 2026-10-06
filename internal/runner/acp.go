package runner

// ACP v1 is a native stdio protocol, not MCP. This bounded adapter deliberately
// grants no filesystem/terminal/MCP client capabilities. The process owner must
// provide a qualified sandbox and persist each outgoing intent before dispatch.
import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"
)

var ErrACPProtocol = errors.New("ACP protocol or authority unavailable")
var ErrACPUnsupported = errors.New("ACP operation is not supported")

type ACPInput struct{ ID, Kind, Text string }
type ACPPermission struct {
	ID, Session, Tool string
	Options           []ACPPermissionOption
}
type ACPPermissionOption struct {
	ID   string `json:"optionId"`
	Kind string `json:"kind"`
}
type ACPOptions struct {
	CWD, ResumeSession string
	// Gate rechecks current attempt, connection, policy and ownership. BeforeSend
	// commits the immutable request ID/body; neither callback may silently retry.
	Gate       func(context.Context) error
	BeforeSend func(context.Context, ACPInput) error
	Observe    func(context.Context, AgentObservation) error
	// Permission receives safe IDs only, never untrusted tool arguments/diffs.
	// Empty/default decisions cancel. Only exact allow_once is eligible.
	Permission func(context.Context, ACPPermission) (string, error)
	Input      <-chan ACPInput
}

type acpFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

// RunACP supports ordinary sequential prompt/reply and cancellation in one
// process. Resume is negotiated and must name the original sandbox session.
// In-flight steering and history-loading are intentionally refused; neither is
// an ACP-v1 baseline operation. Reconnecting a reader never calls this function.
func RunACP(ctx context.Context, stream io.ReadWriteCloser, opt ACPOptions) error {
	if opt.Gate == nil || opt.BeforeSend == nil || opt.Observe == nil || !strings.HasPrefix(opt.CWD, "/") || len(opt.CWD) > 4096 || strings.ContainsAny(opt.CWD, "\x00\r\n") || opt.ResumeSession != "" && !agentNativeID(opt.ResumeSession) {
		return ErrInvalidJob
	}
	run, stop := context.WithCancel(ctx)
	defer stop()
	defer stream.Close()
	frames := make(chan acpFrame, 1)
	go func() {
		defer close(frames)
		scan := bufio.NewScanner(stream)
		scan.Buffer(make([]byte, 4096), 256<<10)
		for scan.Scan() {
			var f acpFrame
			if json.Unmarshal(scan.Bytes(), &f) != nil || f.JSONRPC != "2.0" {
				return
			}
			select {
			case frames <- f:
			case <-run.Done():
				return
			}
		}
	}()
	send := func(v any) error {
		if opt.Gate(run) != nil {
			return ErrACPProtocol
		}
		b, e := json.Marshal(v)
		if e != nil || len(b) > 256<<10 {
			return ErrACPProtocol
		}
		b = append(b, '\n')
		n, e := stream.Write(b)
		if e != nil || n != len(b) {
			return ErrACPProtocol
		}
		return nil
	}
	request := func(id uint64, method string, params any) error {
		return send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	}
	notify := func(method string, params any) error {
		return send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	}
	if err := request(1, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]string{"name": "golf", "version": "085"}}); err != nil {
		return err
	}
	next := uint64(2)
	stage := "initialize"
	session, turn := "", ""
	pendingSession := ""
	pending := uint64(1)
	active := false
	cancelRequested := false
	sequence := int64(0)
	prompts := 0
	inputClosed := false
	permissionIDs := map[string]bool{}
	seen := map[string]bool{}
	messages := map[string]string{}
	messageOrder := []string{}
	tools := map[string]string{}
	emit := func(v AgentObservation) error {
		sequence++
		if sequence > 512 || opt.Gate(run) != nil {
			return ErrACPProtocol
		}
		v.Sequence = sequence
		if v.ThreadID == "" {
			v.ThreadID = session
		}
		if v.Kind != "thread_started" && v.TurnID == "" {
			v.TurnID = turn
		}
		return opt.Observe(run, v)
	}
	for {
		inputChannel := opt.Input
		if stage != "ready" {
			inputChannel = nil
		}
		select {
		case <-run.Done():
			return run.Err()
		case input, ok := <-inputChannel:
			if !ok {
				inputClosed = true
				if active {
					if !cancelRequested {
						if err := notify("session/cancel", map[string]string{"sessionId": session}); err != nil {
							return err
						}
					}
					opt.Input = nil
					continue
				}
				return nil
			}
			if stage != "ready" || !agentNativeID(input.ID) || seen[input.ID] {
				return ErrACPProtocol
			}
			if input.Kind == "cancel" {
				if !active {
					return ErrACPUnsupported
				}
				if err := opt.BeforeSend(run, input); err != nil {
					return err
				}
				seen[input.ID] = true
				if cancelRequested {
					return ErrACPProtocol
				}
				cancelRequested = true
				if err := notify("session/cancel", map[string]string{"sessionId": session}); err != nil {
					return err
				}
				continue
			}
			if input.Kind != "prompt" && input.Kind != "reply" {
				return ErrACPUnsupported
			}
			if active || strings.TrimSpace(input.Text) == "" || !agentObservationText(input.Text, 16384) || prompts >= 16 {
				return ErrACPProtocol
			}
			if err := opt.BeforeSend(run, input); err != nil {
				return err
			}
			seen[input.ID] = true
			prompts++
			turn = "golf-turn-" + strconv.Itoa(prompts)
			messages = map[string]string{}
			messageOrder = nil
			tools = map[string]string{}
			if err := emit(AgentObservation{Kind: "turn_started", Status: "inProgress"}); err != nil {
				return err
			}
			pending = next
			next++
			active = true
			cancelRequested = false
			if err := request(pending, "session/prompt", map[string]any{"sessionId": session, "prompt": []map[string]string{{"type": "text", "text": input.Text}}}); err != nil {
				return err
			}
		case f, open := <-frames:
			if !open {
				return ErrACPProtocol
			}
			if len(f.ID) > 0 && f.Method == "" {
				var id uint64
				if json.Unmarshal(f.ID, &id) != nil || id != pending || len(f.Error) > 0 && string(f.Error) != "null" {
					return ErrACPProtocol
				}
				switch stage {
				case "initialize":
					var v struct {
						ProtocolVersion   int `json:"protocolVersion"`
						AgentCapabilities struct {
							SessionCapabilities struct {
								Resume json.RawMessage `json:"resume"`
							} `json:"sessionCapabilities"`
						} `json:"agentCapabilities"`
					}
					if json.Unmarshal(f.Result, &v) != nil || v.ProtocolVersion != 1 {
						return ErrACPProtocol
					}
					pending = next
					next++
					method := "session/new"
					params := map[string]any{"cwd": opt.CWD, "mcpServers": []any{}}
					if opt.ResumeSession != "" {
						if len(v.AgentCapabilities.SessionCapabilities.Resume) == 0 || string(v.AgentCapabilities.SessionCapabilities.Resume) == "null" {
							return ErrACPUnsupported
						}
						method = "session/resume"
						params["sessionId"] = opt.ResumeSession
					}
					stage = "session"
					if err := request(pending, method, params); err != nil {
						return err
					}
				case "session":
					var v struct {
						SessionID string `json:"sessionId"`
					}
					if json.Unmarshal(f.Result, &v) != nil {
						return ErrACPProtocol
					}
					if opt.ResumeSession != "" {
						session = opt.ResumeSession
						if v.SessionID != "" && v.SessionID != session {
							return ErrACPProtocol
						}
					} else {
						session = v.SessionID
					}
					if !agentNativeID(session) || pendingSession != "" && pendingSession != session {
						return ErrACPProtocol
					}
					stage = "ready"
					pending = 0
					if err := emit(AgentObservation{Kind: "thread_started"}); err != nil {
						return err
					}
				case "ready":
					if !active {
						return ErrACPProtocol
					}
					var v struct {
						StopReason string `json:"stopReason"`
					}
					if json.Unmarshal(f.Result, &v) != nil {
						return ErrACPProtocol
					}
					status := "failed"
					if v.StopReason == "end_turn" {
						status = "completed"
					} else if v.StopReason == "cancelled" {
						status = "interrupted"
					} else if v.StopReason != "max_tokens" && v.StopReason != "max_turn_requests" && v.StopReason != "refusal" {
						return ErrACPProtocol
					}
					for _, id := range messageOrder {
						if err := emit(AgentObservation{Kind: "assistant_message", ItemID: id, Text: messages[id], Phase: "final_answer"}); err != nil {
							return err
						}
					}
					if err := emit(AgentObservation{Kind: "turn_completed", Status: status}); err != nil {
						return err
					}
					active = false
					pending = 0
					if inputClosed {
						return nil
					}
				default:
					return ErrACPProtocol
				}
				continue
			}
			if f.Method == "session/request_permission" && len(f.ID) > 0 {
				var p struct {
					SessionID string `json:"sessionId"`
					ToolCall  struct {
						ToolCallID string `json:"toolCallId"`
					} `json:"toolCall"`
					Options []ACPPermissionOption `json:"options"`
				}
				if !active || len(f.ID) > 128 || json.Unmarshal(f.Params, &p) != nil || p.SessionID != session || !agentNativeID(p.ToolCall.ToolCallID) || len(p.Options) > 8 {
					return ErrACPProtocol
				}
				if permissionIDs[string(f.ID)] || len(permissionIDs) >= 64 {
					return ErrACPProtocol
				}
				permissionIDs[string(f.ID)] = true
				var remoteID any
				if json.Unmarshal(f.ID, &remoteID) != nil {
					return ErrACPProtocol
				}
				if _, ok := remoteID.(string); !ok {
					if _, ok = remoteID.(float64); !ok {
						return ErrACPProtocol
					}
				}
				permission := ACPPermission{ID: string(f.ID), Session: session, Tool: p.ToolCall.ToolCallID, Options: p.Options}
				decision := ""
				if opt.Permission != nil {
					deadline, cancel := context.WithTimeout(run, 30*time.Second)
					var err error
					decision, err = opt.Permission(deadline, permission)
					cancel()
					if err != nil {
						return err
					}
				}
				allowed := false
				for _, o := range p.Options {
					allowed = allowed || o.ID == decision && o.Kind == "allow_once" && agentNativeID(o.ID)
				}
				if err := opt.BeforeSend(run, ACPInput{ID: "permission/" + string(f.ID), Kind: "permission", Text: decision}); err != nil {
					return err
				}
				outcome := map[string]any{"outcome": "cancelled"}
				if allowed {
					outcome = map[string]any{"outcome": "selected", "optionId": decision}
				}
				if err := send(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(f.ID), "result": map[string]any{"outcome": outcome}}); err != nil {
					return err
				}
				continue
			}
			if len(f.ID) > 0 { // Never expose host fs, terminal, authentication or extensions.
				if err := send(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(f.ID), "error": map[string]any{"code": -32601, "message": "Unsupported client method"}}); err != nil {
					return err
				}
				continue
			}
			if f.Method != "session/update" {
				return ErrACPProtocol
			}
			var p struct {
				SessionID string `json:"sessionId"`
				Update    struct {
					Type                     string                      `json:"sessionUpdate"`
					MessageID                string                      `json:"messageId"`
					Content                  struct{ Type, Text string } `json:"content"`
					ToolCallID, Kind, Status string
					Entries                  []struct{ Content, Status string } `json:"entries"`
				} `json:"update"`
			}
			if json.Unmarshal(f.Params, &p) != nil {
				return ErrACPProtocol
			}
			u := p.Update
			// Native OpenCode advertises commands before session/new acknowledges.
			// Bind this metadata to the ensuing receipt; do not replay it as a turn.
			if stage == "session" {
				if !agentNativeID(p.SessionID) || pendingSession != "" && pendingSession != p.SessionID {
					return ErrACPProtocol
				}
				if u.Type != "available_commands_update" && u.Type != "config_option_update" && u.Type != "current_mode_update" {
					return ErrACPProtocol
				}
				pendingSession = p.SessionID
				continue
			}
			if p.SessionID != session {
				return ErrACPProtocol
			}
			switch u.Type {
			case "agent_thought_chunk", "user_message_chunk", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update":
				continue // Never persist reasoning/provider errors, paths or costs as token usage.
			case "agent_message_chunk":
				if !active || u.Content.Type != "text" || !agentObservationText(u.Content.Text, 65536) {
					return ErrACPProtocol
				}
				id := u.MessageID
				if id == "" {
					id = "golf-message-" + strconv.Itoa(prompts)
				}
				if !agentNativeID(id) {
					return ErrACPProtocol
				}
				if _, ok := messages[id]; !ok {
					if len(messages) >= 32 {
						return ErrACPProtocol
					}
					messageOrder = append(messageOrder, id)
				}
				messages[id] += u.Content.Text
				if len(messages[id]) > 65536 {
					return ErrACPProtocol
				}
			case "plan":
				if !active || u.Entries == nil || len(u.Entries) > 32 {
					return ErrACPProtocol
				}
				steps := []AgentPlanStep{}
				total := 0
				for _, e := range u.Entries {
					status := e.Status
					if status == "in_progress" {
						status = "inProgress"
					}
					if !agentObservationText(e.Content, 512) || strings.TrimSpace(e.Content) == "" || (status != "pending" && status != "inProgress" && status != "completed") {
						return ErrACPProtocol
					}
					total += len(e.Content)
					steps = append(steps, AgentPlanStep{Step: e.Content, Status: status})
				}
				if total > 16384 {
					return ErrACPProtocol
				}
				if err := emit(AgentObservation{Kind: "plan_updated", Plan: steps}); err != nil {
					return err
				}
			case "tool_call", "tool_call_update":
				if !active || !agentNativeID(u.ToolCallID) {
					return ErrACPProtocol
				}
				kind := tools[u.ToolCallID]
				if u.Type == "tool_call" {
					if kind != "" {
						return ErrACPProtocol
					}
					if u.Kind == "execute" {
						kind = "commandExecution"
					} else if u.Kind == "edit" {
						kind = "fileChange"
					} else {
						continue
					}
					tools[u.ToolCallID] = kind
					if len(tools) > 64 {
						return ErrACPProtocol
					}
					if err := emit(AgentObservation{Kind: "tool_started", ItemID: u.ToolCallID, ToolKind: kind, Status: "inProgress"}); err != nil {
						return err
					}
				}
				if kind == "finished" {
					return ErrACPProtocol
				}
				if kind != "" && (u.Status == "completed" || u.Status == "failed") {
					if err := emit(AgentObservation{Kind: "tool_completed", ItemID: u.ToolCallID, ToolKind: kind, Status: u.Status}); err != nil {
						return err
					}
					tools[u.ToolCallID] = "finished"
				} else if kind == "finished" {
					return ErrACPProtocol
				}
			default:
				return ErrACPProtocol
			}
		}
	}
}
