package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// A task with mcp runs Claude Code with a per-task --mcp-config (0600, in the task's
// private directory, removed after the run) that names the token only as ${GOLF_MCP_TOKEN};
// the token is in the tool's environment, never in argv, the file or a log.
func TestMCPClaudeConfigPerTask(t *testing.T) {
	h := newHarness(t)
	h.keep = true // the configuration file is removed even when the working copy is kept
	ft := h.f.addTask("Do the thing. MODE=success", 5*time.Minute, func(ft *fakeTask) { ft.task.MCP = &taskMCP{URL: h.f.srv.URL + "/mcp"} })
	h.run(t, ft)
	if ft.finish.State != "succeeded" {
		t.Fatalf("finish %+v\nlog:\n%s", ft.finish, h.logText(ft))
	}
	token := ft.task.Token
	args, _ := os.ReadFile(h.dump + ".args")
	argv := strings.Split(strings.TrimSpace(string(args)), "\n")
	path, _ := os.ReadFile(h.dump + ".mcppath")
	file := strings.TrimSpace(string(path))
	dir := filepath.Join(h.state, "work", ft.task.ID)
	if file != filepath.Join(dir, "golf-mcp.json") {
		t.Fatalf("config at %q, want the task's private directory", file)
	}
	if i := slices.Index(argv, "--mcp-config"); i < 0 || argv[i+1] != file || !slices.Contains(argv, "--allowedTools") || argv[slices.Index(argv, "--allowedTools")+1] != "mcp__golf" {
		t.Fatalf("argv %q", argv)
	}
	if bytes.Contains(args, []byte(token)) || bytes.Contains(args, []byte(token[len(token)-64:])) {
		t.Fatal("the task token is in argv")
	}
	copied, err := os.Stat(h.dump + ".mcp")
	if err != nil || copied.Mode().Perm() != 0600 {
		t.Fatalf("config mode %v %v", copied.Mode(), err)
	}
	data, _ := os.ReadFile(h.dump + ".mcp")
	var cfg struct {
		MCPServers map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil || cfg.MCPServers["golf"].Type != "http" || cfg.MCPServers["golf"].URL != h.f.srv.URL+"/mcp" ||
		cfg.MCPServers["golf"].Headers["Authorization"] != "Bearer ${GOLF_MCP_TOKEN}" || bytes.Contains(data, []byte(token)) {
		t.Fatalf("config %s %v", data, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("the MCP configuration was not removed after the run")
	}
	if _, err := os.Stat(filepath.Join(dir, "repo")); err != nil {
		t.Fatal("keepWork did not keep the working copy")
	}
	// The token reaches the tool only as GOLF_MCP_TOKEN; no other variable carries it.
	env, _ := os.ReadFile(h.dump + ".env")
	for _, line := range strings.Split(string(env), "\n") {
		if strings.Contains(line, token) && line != mcpTokenVar+"="+token {
			t.Fatalf("token in %q", line)
		}
	}
	if !slices.Contains(strings.Split(string(env), "\n"), mcpTokenVar+"="+token) {
		t.Fatal("tool environment lacks GOLF_MCP_TOKEN")
	}
	// The prompt gains the MCP section naming the branch, the base and the target.
	prompt, _ := os.ReadFile(h.dump + ".prompt")
	for _, want := range []string{"Do the thing. MODE=success", "## Golf MCP tools", `owner "owner" and name "repo"`, "commit_changes to the branch " + ft.task.Branch,
		"base " + ft.task.BaseCommit, "head " + ft.task.Branch + " and base main", "Comment only on issue #12"} {
		if !strings.Contains(string(prompt), want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	log := h.logText(ft)
	if !strings.Contains(log, "Golf MCP tools connected for claude") || strings.Contains(log, token) || strings.Contains(h.out.String(), token) {
		t.Fatalf("log:\n%s", log)
	}
	// Without mcp nothing changes: no flags, no variable, no prompt section.
	plain := h.f.addTask("MODE=success", 5*time.Minute, nil)
	h.run(t, plain)
	args, _ = os.ReadFile(h.dump + ".args")
	env, _ = os.ReadFile(h.dump + ".env")
	prompt, _ = os.ReadFile(h.dump + ".prompt")
	if bytes.Contains(args, []byte("--mcp-config")) || bytes.Contains(env, []byte(mcpTokenVar)) || bytes.Contains(prompt, []byte("Golf MCP")) {
		t.Fatal("a task without mcp was configured for MCP")
	}
}

// The tool published its branch itself through MCP (commit_changes): the host adopts it
// and pushes nothing; local changes the branch does not hold fail the task.
func TestMCPPublishedBranchIsAdopted(t *testing.T) {
	h := newHarness(t)
	withMCP := func(ft *fakeTask) { ft.task.MCP = &taskMCP{URL: h.f.srv.URL + "/mcp"} }
	only := h.f.addTask("MODE=publishonly", 5*time.Minute, withMCP)
	same := h.f.addTask("MODE=publishsame", 5*time.Minute, withMCP)
	diverged := h.f.addTask("MODE=publishdiverge", 5*time.Minute, withMCP)
	h.run(t, only, same, diverged)
	for _, ft := range []*fakeTask{only, same} {
		head := gitCommand(t, h.f.bare, "rev-parse", "refs/heads/"+ft.task.Branch)
		if fin := ft.finish; fin.State != "succeeded" || fin.CommitID != head || strings.Join(fin.ChangedFiles, ",") != "PUB.md" {
			t.Fatalf("finish %+v (branch at %s)\nlog:\n%s", fin, head, h.logText(ft))
		}
		if msg := gitCommand(t, h.f.bare, "log", "-1", "--format=%s", head); msg != "published through MCP" {
			t.Fatalf("the host replaced the published commit: %q", msg)
		}
		if !strings.Contains(h.logText(ft), "published "+ft.task.Branch) {
			t.Fatalf("log:\n%s", h.logText(ft))
		}
	}
	if fin := diverged.finish; fin.State != "failed" || !strings.HasPrefix(fin.Failure, "branch_published: ") || !strings.Contains(fin.Failure, "different changes") {
		t.Fatalf("diverged finish %+v", fin)
	}
}

func TestConfigureMCPPerTool(t *testing.T) {
	const url, token = "https://golf.example.invalid/mcp", "golf_agent_task_secret_value"
	dir := t.TempDir()
	codex, ok, err := configureMCP("codex", url, token, dir)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	base := toolSpecs["codex"].args(toolConfig{}, "workspace-write", "", "/w", "")
	got := strings.Join(codex.withArgs(base), " ")
	if got != `exec --json --color never --sandbox workspace-write --ephemeral -c mcp_servers.golf.url="https://golf.example.invalid/mcp" -c mcp_servers.golf.bearer_token_env_var="GOLF_MCP_TOKEN" -c mcp_servers.golf.default_tools_approval_mode="approve" -c shell_environment_policy.ignore_default_excludes=false -- -` {
		t.Fatalf("codex argv %q", got)
	}
	if !slices.Equal(codex.env, []string{"GOLF_MCP_TOKEN=" + token}) || len(codex.files) != 0 {
		t.Fatalf("codex %+v", codex)
	}
	opencode, ok, err := configureMCP("opencode", url, token, dir)
	if err != nil || !ok || len(opencode.args) != 0 || len(opencode.env) != 2 || opencode.env[0] != "GOLF_MCP_TOKEN="+token {
		t.Fatalf("opencode %+v %v %v", opencode, ok, err)
	}
	content, found := strings.CutPrefix(opencode.env[1], "OPENCODE_CONFIG_CONTENT=")
	var oc struct {
		MCP map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
			Enabled bool              `json:"enabled"`
		} `json:"mcp"`
	}
	if !found || json.Unmarshal([]byte(content), &oc) != nil || oc.MCP["golf"].Type != "remote" || oc.MCP["golf"].URL != url || !oc.MCP["golf"].Enabled ||
		oc.MCP["golf"].Headers["Authorization"] != "Bearer {env:GOLF_MCP_TOKEN}" || strings.Contains(content, token) {
		t.Fatalf("opencode config %q", content)
	}
	if setup, ok, err := configureMCP("grok", url, token, dir); ok || err != nil || len(setup.args)+len(setup.env)+len(setup.files) != 0 {
		t.Fatalf("grok %+v %v %v", setup, ok, err)
	}
	// Claude Code's file is created exclusively: a planted file or symlink is refused.
	if err := os.Symlink("/tmp/elsewhere", filepath.Join(dir, "golf-mcp.json")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := configureMCP("claude", url, token, dir); err == nil {
		t.Fatal("wrote through a planted golf-mcp.json")
	}
	// Claude Code's flags follow the fixed argv, before the model and extraArgs.
	claude := mcpSetup{args: []string{"--mcp-config", "/d/golf-mcp.json", "--allowedTools", "mcp__golf"}}
	if got := strings.Join(claude.withArgs([]string{"-p", "--model", "x"}), " "); got != "-p --model x --mcp-config /d/golf-mcp.json --allowedTools mcp__golf" {
		t.Fatalf("claude argv %q", got)
	}
}

func TestValidateTaskMCPOrigin(t *testing.T) {
	id := newUUID()
	origin := "https://golf.example.invalid"
	task := claimedTask{ID: id, CloneURL: origin + "/native/agent-host/tasks/" + id + "/git", Branch: "golf-agent/" + id[:8],
		BaseRef: "refs/heads/main", BaseCommit: strings.Repeat("a", 40), Tool: "claude", Prompt: "p",
		Deadline: time.Now().Add(time.Hour).UnixMilli(), Token: "golf_agent_task_" + id + "_" + strings.Repeat("d", 64),
		Target: taskTarget{Kind: "issue", Number: 3}, MCP: &taskMCP{URL: origin + "/mcp"}}
	if err := validateTask(task, origin, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{"https://evil.example/mcp", origin + "/mcp/", origin + "/native/mcp", ""} {
		task.MCP = &taskMCP{URL: url}
		if validateTask(task, origin, time.Now()) == nil {
			t.Errorf("accepted mcp url %q", url)
		}
	}
}

// magicWord is what the stub /mcp tool golf_magic returns (TestRealTools with
// GOLF_AGENT_HOST_REAL_MCP=1 checks that a real CLI called it).
const magicWord = "PELICAN-42"

// serveMCP is a stub of Golf's /mcp (Streamable HTTP, JSON responses) that accepts any
// claimed task's token as its Bearer and offers one tool.
func (f *fakeGolf) serveMCP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	known := false
	for _, ft := range f.tasks {
		known = known || r.Header.Get("Authorization") == "Bearer "+ft.task.Token
	}
	f.mu.Unlock()
	if !known {
		w.Header().Set("WWW-Authenticate", `Bearer realm="Golf MCP"`)
		writeJSON(w, 401, map[string]string{"code": "unauthenticated", "message": "task token required"})
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			ProtocolVersion string `json:"protocolVersion"`
			Name            string `json:"name"`
		} `json:"params"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&m) != nil {
		writeJSON(w, 400, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "Parse error."}})
		return
	}
	if len(m.ID) == 0 || string(m.ID) == "null" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch m.Method {
	case "initialize":
		version := m.Params.ProtocolVersion
		if version == "" {
			version = "2025-06-18"
		}
		result = map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "golf", "version": "stub"}}
	case "tools/list":
		result = map[string]any{"tools": []any{map[string]any{"name": "golf_magic", "description": "Returns the magic word for this Golf task.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}}}}
	case "tools/call":
		f.mu.Lock()
		f.mcpCalls = append(f.mcpCalls, m.Params.Name)
		f.mu.Unlock()
		result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "The magic word is " + magicWord + "."}}}
	case "ping":
		result = map[string]any{}
	default:
		writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "Method not found: " + m.Method + "."}})
		return
	}
	writeJSON(w, 200, map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
}

func TestCodexParserRendersMCPCalls(t *testing.T) {
	p := newParser("codex", "/w")
	lines := p.render([]byte(`{"type":"item.started","item":{"type":"mcp_tool_call","server":"golf","tool":"read_files","arguments":{}}}`))
	lines = append(lines, p.render([]byte(`{"type":"item.completed","item":{"type":"mcp_tool_call","server":"golf","tool":"comment","error":{"message":"This agent task may comment only on #12."},"status":"failed"}}`))...)
	if strings.Join(lines, "|") != "→ golf.read_files|← tool error: This agent task may comment only on #12." {
		t.Fatalf("lines %q", lines)
	}
}
