package runner

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Agent tasks use a separate approved image and native permission profile. No
// enrollment, database, forge or object-storage credential enters this image.
type AgentJob struct {
	Job
	Auth                                        []byte
	Model, Reasoning, Instructions, SeccompPath string
	TokenBudget                                 uint32
	// Observe must durably accept the private projection, or fail closed. The
	// consumer screens credentials and fences current authority before storage.
	Observe func(context.Context, AgentObservation) error
	// Managed ACP is opt-in after exact image/native sandbox qualification.
	ACP        *ACPOptions
	Checkpoint func(context.Context, []byte) error
}

// AgentObservation is a bounded private projection of native observations, not
// a raw protocol event or permission to resume/retry native execution. Completed
// messages are authoritative; reasoning, command arguments/output, paths, diffs
// and provider errors never enter this projection. Text still requires the
// coordinator's credential screening before durable private storage.
type AgentObservation struct {
	Sequence    int64           `json:"sequence"`
	Kind        string          `json:"kind"`
	ThreadID    string          `json:"threadId,omitempty"`
	TurnID      string          `json:"turnId,omitempty"`
	ItemID      string          `json:"itemId,omitempty"`
	Phase       string          `json:"phase,omitempty"`
	Text        string          `json:"text,omitempty"`
	Status      string          `json:"status,omitempty"`
	ToolKind    string          `json:"toolKind,omitempty"`
	Plan        []AgentPlanStep `json:"plan,omitempty"`
	TotalTokens *int64          `json:"totalTokens,omitempty"`
}
type AgentPlanStep struct {
	Step   string `json:"step"`
	Status string `json:"status"`
}

func agentObservationText(s string, limit int) bool {
	if len(s) > limit || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}
func agentNativeID(s string) bool {
	if s == "" || len(s) > 128 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

type AgentResult struct {
	State, Summary, Patch string
	Stage                 string
	Tokens                int64
	Auth                  []byte
	// Native review metadata may omit session/message IDs. Its final result can
	// remain usable, but no fabricated conversation identity is published.
	ConversationUnavailable bool
}

func agentOwner() (string, error) {
	b := make([]byte, 16)
	_, e := rand.Read(b)
	return hex.EncodeToString(b), e
}

const AgentPermissions = `default_permissions="golf-task"
approval_policy="never"
cli_auth_credentials_store="file"
[permissions.golf-task]
extends=":workspace"
[permissions.golf-task.filesystem]
":root"="deny"
":minimal"="read"
"/auth"="deny"
"/golf"="deny"
"/tmp"="write"
"/workspace"="write"
"/workspace/.git"="read"
"/workspace/.codex"="deny"
[permissions.golf-task.network]
enabled=false
[features]
shell_tool=true
web_search=false
`

func agentArchive(auth []byte) ([]byte, error) {
	if len(auth) == 0 || len(auth) > 65536 || !json.Valid(auth) {
		return nil, ErrInvalidJob
	}
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	for name, data := range map[string][]byte{"auth.json": auth, "config.toml": []byte(AgentPermissions)} {
		if err := w.WriteHeader(&tar.Header{Name: name, Mode: 0600, Uid: 1000, Gid: 1000, Typeflag: tar.TypeReg, Size: int64(len(data))}); err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// ExecuteAgent never executes a repository hook, loads project config, publishes
// a commit or exposes raw native events. The outer container is a trusted CLI
// boundary; native commands are additionally confined by AgentPermissions.
func (e *Executor) ExecuteAgent(ctx context.Context, j AgentJob) (out AgentResult, err error) {
	out.State = "lost"
	stage := "validation"
	defer func() { out.Stage = stage }()
	j.Steps = []Step{{Script: "true", Shell: "sh"}}
	if e.validate(j.Job) != nil || j.Model == "" || len(j.Model) > 256 || len(j.Reasoning) > 64 || len(j.Instructions) > 16384 || j.TokenBudget < 1000 || !strings.HasPrefix(j.SeccompPath, "/") {
		return out, ErrInvalidJob
	}
	stage = "source-snapshot"
	archive, err := e.snapshot(j.Job)
	if err != nil {
		return out, err
	}
	stage = "credential-envelope"
	authTar, err := agentArchive(j.Auth)
	if j.ACP != nil {
		authTar, err = managedACPEnvelope(j)
	}
	if err != nil {
		return out, err
	}
	// Attempt IDs are unique coordinator-issued capabilities; resource labels also
	// carry an independent random owner, so cleanup never targets foreign jobs.
	owner, err := agentOwner()
	if err != nil {
		return out, ErrInfrastructure
	}
	volume := "golf-source-" + j.AttemptID + "-" + owner
	labels := []string{"--label", workerLabel + "=" + e.config.WorkerID, "--label", managedLabel + "=true", "--label", attemptLabel + "=" + j.AttemptID, "--label", ownerLabel + "=" + owner}
	var helper, container string
	created := false
	defer func() {
		c, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		bad := false
		if container != "" {
			bad = e.removeContainer(c, container, j.AttemptID, owner) != nil || bad
		}
		if helper != "" {
			bad = e.removeContainer(c, helper, j.AttemptID, owner) != nil || bad
		}
		if created {
			bad = e.removeVolume(c, volume, j.AttemptID, owner) != nil || bad
		}
		if bad {
			out.State = "lost"
			out.Patch = ""
			out.Summary = ""
			err = ErrCleanup
		}
	}()
	run, stop := context.WithTimeout(ctx, j.Timeout)
	defer stop()
	var images []struct {
		ID, Os string
		Config struct{ Volumes map[string]json.RawMessage }
	}
	stage = "image-inspect"
	if e.inspect(run, "image", j.ImageDigest, &images) != nil || len(images) != 1 || !imageIDPattern.MatchString(images[0].ID) || images[0].Os != "linux" || len(images[0].Config.Volumes) > 0 {
		return out, ErrInfrastructure
	}
	stage = "source-volume"
	if _, err = e.command(run, nil, append(append([]string{"volume", "create"}, labels...), volume)...); err != nil {
		return
	}
	created = true
	makeContainer := func(task bool) (string, error) {
		args := []string{"container", "create", "--pull=never", "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--cpus=2", "--memory=1073741824", "--memory-swap=1073741824", "--pids-limit=128", "--restart=no", "--no-healthcheck", "--log-driver=none"}
		args = append(args, labels...)
		mount := "type=volume,src=" + volume + ",dst=/golf,volume-nocopy"
		if task {
			mount += ",readonly"
			authMount := "--tmpfs=/auth:rw,nosuid,nodev,noexec,size=16777216,mode=0700,uid=1000,gid=1000"
			if j.ACP != nil {
				authMount = "--tmpfs=/auth:rw,nosuid,nodev,noexec,size=536870912,mode=0700,uid=1000,gid=1000"
			}
			args = append(args, "--network=bridge", "--read-only", "--init", "--security-opt=seccomp="+j.SeccompPath, "--tmpfs=/workspace:rw,nosuid,nodev,size=134217728,mode=0700,uid=1000,gid=1000", authMount, "--tmpfs=/tmp:rw,nosuid,nodev,size=67108864,mode=1777", "--workdir=/workspace")
		} else {
			args = append(args, "--network=none")
		}
		args = append(args, "--mount", mount, "--entrypoint=/bin/sh", images[0].ID, "-c", "sleep 2147483647")
		data, x := e.command(run, nil, args...)
		id := strings.TrimSpace(string(data))
		if x != nil || !containerPattern.MatchString(id) {
			return "", ErrInfrastructure
		}
		return id, nil
	}
	stage = "source-helper"
	if helper, err = makeContainer(false); err != nil {
		return
	}
	stage = "source-copy"
	if _, err = e.command(run, bytes.NewReader(archive), "container", "cp", "-a", "-", helper+":/golf"); err != nil {
		return
	}
	stage = "source-helper-cleanup"
	if err = e.removeContainer(run, helper, j.AttemptID, owner); err != nil {
		return
	}
	helper = ""
	stage = "task-container"
	if container, err = makeContainer(true); err != nil {
		return
	}
	stage = "task-start"
	if _, err = e.command(run, nil, "container", "start", container); err != nil {
		return
	}
	stage = "credential-copy"
	if _, err = e.command(run, bytes.NewReader(authTar), "container", "exec", "-i", container, "/bin/tar", "-xf", "-", "-C", "/auth"); err != nil {
		return
	}
	bootstrap := `set -eu
cp -R /golf/source/. /workspace/
chmod -R u+w /workspace
test ! -e /workspace/.git
find /workspace -type d -name .codex -prune -exec rm -rf {} +
mkdir -p /workspace/.codex
git init -q
git -c core.hooksPath=/dev/null add .
git -c core.hooksPath=/dev/null -c user.name=Golf -c user.email=task@golf.invalid commit -q --allow-empty -m snapshot
`
	if j.ACP != nil {
		// Never load repository-owned executable config, plugins, dotenv or hooks.
		bootstrap = strings.Replace(bootstrap, "mkdir -p /workspace/.codex", `find /workspace -type d -name .opencode -prune -exec rm -rf {} +
find /workspace -type f \( -name opencode.json -o -name opencode.jsonc -o -name '.env*' \) -delete
mkdir -p /workspace/.codex`, 1)
	}
	stage = "workspace-bootstrap"
	if _, err = e.command(run, nil, "container", "exec", container, "/bin/sh", "-c", bootstrap); err != nil {
		return
	}
	args := []string{"container", "exec", "-i", container, "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/auth", "CODEX_HOME=/auth", "RUST_LOG=off", "/bin/sh", "-c", "echo $$ > /auth/native.pid; exec codex app-server --listen stdio://"}
	if j.ACP != nil {
		args = managedACPCommand(container)
	}
	cmd := exec.CommandContext(run, e.config.DockerBinary, args...)
	cmd.WaitDelay = 2 * time.Second
	cmd.Stderr = io.Discard
	input, x := cmd.StdinPipe()
	if x != nil {
		return out, ErrInfrastructure
	}
	output, x := cmd.StdoutPipe()
	if x != nil {
		input.Close()
		return out, ErrInfrastructure
	}
	if err = cmd.Start(); err != nil {
		return out, ErrInfrastructure
	}
	defer func() { input.Close(); cmd.Process.Kill(); cmd.Wait() }()
	stage = "native-protocol"
	if j.ACP != nil {
		options := *j.ACP
		options.CWD = "/workspace"
		options.ExpectedVersion = ManagedACPVersion
		options.ExpectedMode = "golf-workspace"
		options.ExpectedModel = j.Model
		original := options.Observe
		ready := options.Ready
		session := ""
		lastStatus := ""
		options.Ready = func(ctx context.Context, v ACPState) error {
			session = v.Session
			if ready != nil {
				return ready(ctx, v)
			}
			return nil
		}
		options.Observe = func(ctx context.Context, v AgentObservation) error {
			if err := original(ctx, v); err != nil {
				return err
			}
			if v.Kind == "assistant_message" {
				out.Summary = v.Text
			}
			if v.Kind == "turn_completed" {
				lastStatus = v.Status
			}
			if v.Kind == "turn_completed" && j.Checkpoint != nil {
				tokens, err := e.managedACPUsage(ctx, container, session, j.Model)
				if err != nil {
					return err
				}
				out.Tokens = tokens
				if tokens > int64(j.TokenBudget) {
					return ErrACPTokenBudget
				}
				if err = original(ctx, AgentObservation{Kind: "usage_updated", ThreadID: session, TurnID: v.TurnID, TotalTokens: &tokens}); err != nil {
					return err
				}
				auth, err := e.managedACPAuth(ctx, container)
				if err != nil {
					return err
				}
				return j.Checkpoint(ctx, auth)
			}
			return nil
		}
		err = RunACP(run, &acpDuplex{Reader: output, Writer: input, close: func() error { return input.Close() }}, options)
		if err == nil && lastStatus == "completed" {
			out.State = "succeeded"
		} else if err == nil {
			out.State = "failed"
			out.Summary = ""
			err = ErrACPProtocol
		} else if errors.Is(err, ErrACPTokenBudget) {
			out.State = "budget_exceeded"
			out.Summary = ""
		}
	} else {
		out, err = agentProtocol(run, input, output, j)
	}
	// Always recover the rotating native cache, including cancellation/failure.
	// It never becomes an artifact, browser receipt or log.
	recoverCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stage = "native-stop"
	_, killErr := e.command(recoverCtx, nil, "container", "exec", container, "/bin/sh", "-c", `pid=$(cat /auth/native.pid); case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -TERM "$pid" 2>/dev/null || true; for n in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 1; done; kill -KILL "$pid" 2>/dev/null || true`)
	if killErr != nil {
		out.State = "lost"
		return out, ErrInfrastructure
	}
	stage = "credential-recovery"
	var auth []byte
	if j.ACP != nil {
		auth, x = e.managedACPAuth(recoverCtx, container)
	} else {
		auth, x = e.command(recoverCtx, nil, "container", "exec", container, "/bin/cat", "/auth/auth.json")
	}
	if x != nil || len(auth) > 65536 || !json.Valid(auth) {
		out.State = "lost"
		out.Patch = ""
		return out, ErrInfrastructure
	}
	out.Auth = auth
	if ctx.Err() != nil {
		out.State = "cancelled"
	}
	if errors.Is(run.Err(), context.DeadlineExceeded) {
		out.State = "timed_out"
	}
	if out.State == "succeeded" {
		stage = "proposed-patch"
		patch, x := e.command(run, nil, "container", "exec", container, "/bin/sh", "-c", "git -c core.hooksPath=/dev/null add -N . && git --no-pager -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --binary HEAD")
		if x != nil {
			out.State = "failed"
			return out, ErrInfrastructure
		}
		out.Patch = string(patch)
	}
	return
}

// Only assistant text, usage and bounded observations leave this transport.
// Raw command output, reasoning, provider errors and protocol payloads do not.
func agentProtocol(ctx context.Context, in io.Writer, output io.Reader, j AgentJob) (out AgentResult, err error) {
	out.State = "failed"
	send := func(id int, method string, params any) error {
		b, e := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
		if e != nil {
			return e
		}
		_, e = in.Write(append(b, '\n'))
		return e
	}
	if send(1, "initialize", map[string]any{"clientInfo": map[string]string{"name": "golf_task", "version": "0.1.0"}, "capabilities": map[string]bool{"experimentalApi": false}}) != nil {
		return out, ErrInfrastructure
	}
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	var thread, turn string
	started := false
	initialized := false
	var sequence int64
	projectedBytes := 0
	observedItems := map[string]bool{}
	activeItems := map[string]string{}
	observe := func(v AgentObservation) error {
		if j.Observe == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ErrInfrastructure
		}
		v.Sequence = sequence + 1
		if v.Sequence > 512 {
			return ErrInfrastructure
		}
		b, e := json.Marshal(v)
		if e != nil || projectedBytes+len(b) > 256<<10 {
			return ErrInfrastructure
		}
		if e = j.Observe(ctx, v); e != nil || ctx.Err() != nil {
			return ErrInfrastructure
		}
		sequence = v.Sequence
		projectedBytes += len(b)
		return nil
	}
	total := 0
	for scanner.Scan() {
		total += len(scanner.Bytes())
		if total > 4<<20 {
			return out, ErrInfrastructure
		}
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			return out, ErrInfrastructure
		}
		if len(m.Error) > 0 && string(m.Error) != "null" {
			return out, ErrInfrastructure
		}
		if len(m.ID) > 0 && m.Method != "" { // Native approval requests are denied; no sandbox escape.
			if m.Method != "item/commandExecution/requestApproval" && m.Method != "item/fileChange/requestApproval" {
				return out, ErrInfrastructure
			}
			var p struct {
				ThreadID string `json:"threadId"`
				TurnID   string `json:"turnId"`
				ItemID   string `json:"itemId"`
			}
			if json.Unmarshal(m.Params, &p) != nil || !started || p.ThreadID != thread || p.TurnID != turn || !agentNativeID(p.ItemID) {
				return out, ErrInfrastructure
			}
			b, _ := json.Marshal(map[string]any{"id": json.RawMessage(m.ID), "result": map[string]string{"decision": "decline"}})
			if j.Observe != nil && activeItems[p.ItemID] != strings.TrimSuffix(strings.TrimPrefix(m.Method, "item/"), "/requestApproval") {
				return out, ErrInfrastructure
			}
			if _, e := in.Write(append(b, '\n')); e != nil {
				return out, ErrInfrastructure
			}
			tool := "commandExecution"
			if m.Method == "item/fileChange/requestApproval" {
				tool = "fileChange"
			}
			if observe(AgentObservation{Kind: "approval_declined", ThreadID: thread, TurnID: turn, ItemID: p.ItemID, ToolKind: tool, Status: "declined"}) != nil {
				return out, ErrInfrastructure
			}
			continue
		}
		if string(m.ID) == "1" {
			if initialized || thread != "" {
				return out, ErrInfrastructure
			}
			initialized = true
			if _, e := in.Write([]byte("{\"method\":\"initialized\"}\n")); e != nil {
				return out, ErrInfrastructure
			}
			if send(2, "thread/start", map[string]any{"cwd": "/workspace", "model": j.Model, "approvalPolicy": "never", "ephemeral": true, "config": map[string]any{"default_permissions": "golf-task", "web_search": "disabled", "features": map[string]any{"apps": false, "plugins": false}}}) != nil {
				return out, ErrInfrastructure
			}
		}
		if string(m.ID) == "2" {
			var r struct {
				Thread struct {
					ID string `json:"id"`
				} `json:"thread"`
			}
			if json.Unmarshal(m.Result, &r) != nil || !agentNativeID(r.Thread.ID) {
				return out, ErrInfrastructure
			}
			if thread != "" || !initialized {
				return out, ErrInfrastructure
			}
			thread = r.Thread.ID
			if observe(AgentObservation{Kind: "thread_started", ThreadID: thread}) != nil {
				return out, ErrInfrastructure
			}
			p := map[string]any{"threadId": thread, "input": []map[string]string{{"type": "text", "text": j.Instructions}}, "model": j.Model}
			if j.Reasoning != "" {
				p["effort"] = j.Reasoning
			}
			if send(3, "turn/start", p) != nil {
				return out, ErrInfrastructure
			}
		}
		if string(m.ID) == "3" {
			var r struct {
				Turn struct {
					ID string `json:"id"`
				} `json:"turn"`
			}
			if json.Unmarshal(m.Result, &r) != nil || !agentNativeID(r.Turn.ID) {
				return out, ErrInfrastructure
			}
			if started || thread == "" {
				return out, ErrInfrastructure
			}
			turn = r.Turn.ID
			started = true
			if observe(AgentObservation{Kind: "turn_started", ThreadID: thread, TurnID: turn, Status: "inProgress"}) != nil {
				return out, ErrInfrastructure
			}
		}
		switch m.Method {
		case "thread/tokenUsage/updated":
			var p struct {
				ThreadID   string `json:"threadId"`
				TurnID     string `json:"turnId"`
				TokenUsage struct {
					Total struct {
						TotalTokens *int64 `json:"totalTokens"`
					} `json:"total"`
				} `json:"tokenUsage"`
			}
			if json.Unmarshal(m.Params, &p) != nil || p.ThreadID != thread || ((j.Observe != nil || p.TurnID != "") && p.TurnID != turn) || !started || p.TokenUsage.Total.TotalTokens == nil || *p.TokenUsage.Total.TotalTokens < 0 {
				return out, ErrInfrastructure
			}
			nativeTotal := *p.TokenUsage.Total.TotalTokens
			reportedTotal := nativeTotal
			if observe(AgentObservation{Kind: "usage_updated", ThreadID: thread, TurnID: turn, TotalTokens: &reportedTotal}) != nil {
				return out, ErrInfrastructure
			}
			out.Tokens = max(out.Tokens, nativeTotal)
			if out.Tokens > int64(j.TokenBudget) {
				_ = send(4, "turn/interrupt", map[string]string{"threadId": thread, "turnId": turn})
				out.State = "budget_exceeded"
				return out, nil
			}
		case "model/rerouted":
			return out, ErrInfrastructure
		case "turn/plan/updated":
			var p struct {
				ThreadID string          `json:"threadId"`
				TurnID   string          `json:"turnId"`
				Plan     []AgentPlanStep `json:"plan"`
			}
			if json.Unmarshal(m.Params, &p) != nil || !started || p.ThreadID != thread || p.TurnID != turn || p.Plan == nil || len(p.Plan) > 32 {
				return out, ErrInfrastructure
			}
			size := 0
			for _, step := range p.Plan {
				size += len(step.Step)
				if strings.TrimSpace(step.Step) == "" || !agentObservationText(step.Step, 512) || (step.Status != "pending" && step.Status != "inProgress" && step.Status != "completed") {
					return out, ErrInfrastructure
				}
			}
			if size > 16384 || observe(AgentObservation{Kind: "plan_updated", ThreadID: thread, TurnID: turn, Plan: p.Plan}) != nil {
				return out, ErrInfrastructure
			}
		case "item/started", "item/completed":
			var p struct {
				ThreadID string `json:"threadId"`
				TurnID   string `json:"turnId"`
				Item     struct {
					ID     string `json:"id"`
					Type   string `json:"type"`
					Text   string `json:"text"`
					Phase  string `json:"phase"`
					Status string `json:"status"`
				} `json:"item"`
			}
			if json.Unmarshal(m.Params, &p) != nil || !started || p.ThreadID != thread || p.TurnID != turn {
				return out, ErrInfrastructure
			}
			completed := m.Method == "item/completed"
			selected := p.Item.Type == "agentMessage" || p.Item.Type == "commandExecution" || p.Item.Type == "fileChange"
			if j.Observe != nil && selected {
				if !agentNativeID(p.Item.ID) || observedItems[m.Method+":"+p.Item.ID] {
					return out, ErrInfrastructure
				}
				if !completed {
					if _, exists := activeItems[p.Item.ID]; exists {
						return out, ErrInfrastructure
					}
					activeItems[p.Item.ID] = p.Item.Type
				} else {
					if activeItems[p.Item.ID] != p.Item.Type {
						return out, ErrInfrastructure
					}
					delete(activeItems, p.Item.ID)
				}
				// Mark only after shape-specific checks below for emitted observations.
				if !completed && p.Item.Type == "agentMessage" {
					observedItems[m.Method+":"+p.Item.ID] = true
				}
			}
			if p.Item.Type == "agentMessage" && completed {
				if !agentObservationText(p.Item.Text, 65536) || (p.Item.Phase != "" && p.Item.Phase != "commentary" && p.Item.Phase != "final_answer") {
					return out, ErrInfrastructure
				}
				if j.Observe != nil && (!agentNativeID(p.Item.ID) || observedItems[m.Method+":"+p.Item.ID]) {
					return out, ErrInfrastructure
				}
				observedItems[m.Method+":"+p.Item.ID] = true
				if observe(AgentObservation{Kind: "assistant_message", ThreadID: thread, TurnID: turn, ItemID: p.Item.ID, Text: p.Item.Text, Phase: p.Item.Phase}) != nil {
					return out, ErrInfrastructure
				}
				if p.Item.Phase == "" || p.Item.Phase == "final_answer" {
					out.Summary = p.Item.Text
				}
			}
			if p.Item.Type == "commandExecution" || p.Item.Type == "fileChange" {
				// Existing final-result consumers do not require tool metadata. An enabled
				// durable observer requires exact native identity and known lifecycle state.
				if j.Observe != nil {
					if !agentNativeID(p.Item.ID) || observedItems[m.Method+":"+p.Item.ID] {
						return out, ErrInfrastructure
					}
					if (!completed && p.Item.Status != "inProgress") || (completed && p.Item.Status != "completed" && p.Item.Status != "failed" && p.Item.Status != "declined") {
						return out, ErrInfrastructure
					}
					observedItems[m.Method+":"+p.Item.ID] = true
					kind := "tool_started"
					if completed {
						kind = "tool_completed"
					}
					if observe(AgentObservation{Kind: kind, ThreadID: thread, TurnID: turn, ItemID: p.Item.ID, ToolKind: p.Item.Type, Status: p.Item.Status}) != nil {
						return out, ErrInfrastructure
					}
				}
			}
		case "turn/completed":
			var p struct {
				ThreadID string                      `json:"threadId"`
				Turn     struct{ ID, Status string } `json:"turn"`
			}
			if json.Unmarshal(m.Params, &p) != nil || !started || p.ThreadID != thread || p.Turn.ID != turn {
				return out, ErrInfrastructure
			}
			if p.Turn.Status == "completed" && j.Observe != nil && len(activeItems) != 0 {
				return out, ErrInfrastructure
			}
			if p.Turn.Status != "completed" && p.Turn.Status != "failed" && p.Turn.Status != "interrupted" {
				return out, ErrInfrastructure
			}
			if observe(AgentObservation{Kind: "turn_completed", ThreadID: thread, TurnID: turn, Status: p.Turn.Status}) != nil {
				return out, ErrInfrastructure
			}
			if p.Turn.Status == "completed" {
				out.State = "succeeded"
			}
			return out, nil
		}
		if ctx.Err() != nil {
			return out, ErrInfrastructure
		}
	}
	return out, ErrInfrastructure
}

// NewAttemptID returns a random coordinator-owned attempt identity.
func NewAttemptID() (string, error) { return agentOwner() }

// QualifyAgent checks the actual native sandbox before advertising worker
// readiness. It uses a dummy file, no login or inference.
func (e *Executor) QualifyAgent(ctx context.Context, image, seccomp string) error {
	allowed := false
	for _, v := range e.config.ApprovedImages {
		allowed = allowed || v == image
	}
	if !allowed {
		return ErrInvalidJob
	}
	// Run the same filesystem policy as tasks. Secret reads/writes, root writes,
	// project config access and command TCP access must be denied, workspace writes
	// must succeed. No weaker fallback is permitted.
	script := "cat > /auth/config.toml <<'GOLF_NATIVE_POLICY'\n" + AgentPermissions + "\nGOLF_NATIVE_POLICY\n" + `set -eu
 printf '{}' > /auth/auth.json
 mkdir -p /workspace/.codex
 exec codex sandbox -- /bin/sh -c 'set -eu; printf checked > /workspace/check; if cat /auth/auth.json >/dev/null 2>&1; then exit 21; fi; if touch /auth/leak 2>/dev/null; then exit 22; fi; if touch /etc/leak 2>/dev/null; then exit 23; fi; node -e '\''const n=require("net");const s=n.connect({host:"1.1.1.1",port:443});s.on("connect",()=>process.exit(24));s.on("error",e=>process.exit(["EPERM","EACCES","ENETUNREACH"].includes(e.code)?0:25));setTimeout(()=>process.exit(26),2000);'\'''
 `
	_, err := e.command(ctx, nil, "run", "--rm", "--pull=never", "--user=1000:1000", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--security-opt=seccomp="+seccomp, "--network=bridge", "--pids-limit=128", "--memory=1073741824", "--memory-swap=1073741824", "--cpus=2", "--log-driver=none", "--tmpfs=/auth:uid=1000,gid=1000,mode=0700,size=16777216", "--tmpfs=/workspace:uid=1000,gid=1000,mode=0700,size=134217728", "--tmpfs=/tmp:mode=1777,size=67108864", "--workdir=/workspace", "--entrypoint=/bin/sh", image, "-c", script)
	return err
}
