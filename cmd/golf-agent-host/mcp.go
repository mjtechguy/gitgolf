package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// mcpTokenVar carries the task token to a CLI that reads Golf's MCP bearer from its
// environment. The token is never in argv or in a file: Claude Code expands ${VAR} in
// --mcp-config headers, Codex reads bearer_token_env_var and OpenCode expands {env:VAR}.
const mcpTokenVar = "GOLF_MCP_TOKEN"

// mcpSetup points one tool run at Golf's MCP endpoint for one task.
type mcpSetup struct {
	args  []string // added to the tool's argv (never the token)
	env   []string // added to the tool's scrubbed environment
	files []string // removed after the run
}

// withArgs adds the setup's arguments before a trailing "-- -" (Codex reads its prompt
// from stdin after "--") or at the end.
func (m mcpSetup) withArgs(args []string) []string {
	if len(m.args) == 0 {
		return args
	}
	if n := len(args); n >= 2 && args[n-2] == "--" && args[n-1] == "-" {
		return append(append(slices.Clone(args[:n-2]), m.args...), "--", "-")
	}
	return append(slices.Clone(args), m.args...)
}

func (m mcpSetup) cleanup() {
	for _, f := range m.files {
		_ = os.Remove(f)
	}
}

// configureMCP returns how tool reaches url with token for this run only, without
// changing the user's own tool configuration. dir is the task's private directory
// (0700, outside the working copy). ok is false for a tool that can only read MCP
// servers from its persistent configuration (Grok).
func configureMCP(tool, url, token, dir string) (setup mcpSetup, ok bool, err error) {
	header := map[string]string{"Authorization": "Bearer ${" + mcpTokenVar + "}"}
	env := []string{mcpTokenVar + "=" + token}
	switch tool {
	case "claude":
		// --mcp-config adds the server for this session only; --allowedTools lets its
		// tools run without a prompt (--permission-prompts none denies anything else).
		data, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"golf": map[string]any{"type": "http", "url": url, "headers": header}}})
		file := filepath.Join(dir, "golf-mcp.json")
		f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return mcpSetup{}, false, err
		}
		_, werr := f.Write(append(data, '\n'))
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			_ = os.Remove(file)
			return mcpSetup{}, false, werr
		}
		return mcpSetup{args: []string{"--mcp-config", file, "--allowedTools", "mcp__golf"}, env: env, files: []string{file}}, true, nil
	case "codex":
		// -c overrides apply to this run only. Codex asks before every MCP tool call
		// unless approved, and exec never asks, so the golf server's tools are approved.
		// Its default environment excludes (names containing KEY, SECRET or TOKEN) keep
		// the token out of the shell commands it runs.
		quoted, _ := json.Marshal(url) // a TOML basic string
		return mcpSetup{args: []string{
			"-c", "mcp_servers.golf.url=" + string(quoted),
			"-c", `mcp_servers.golf.bearer_token_env_var="` + mcpTokenVar + `"`,
			"-c", `mcp_servers.golf.default_tools_approval_mode="approve"`,
			"-c", "shell_environment_policy.ignore_default_excludes=false",
		}, env: env}, true, nil
	case "opencode":
		// OPENCODE_CONFIG_CONTENT is merged as one more config for this process only.
		header["Authorization"] = "Bearer {env:" + mcpTokenVar + "}"
		data, _ := json.Marshal(map[string]any{"mcp": map[string]any{"golf": map[string]any{"type": "remote", "url": url, "headers": header, "enabled": true}}})
		return mcpSetup{env: append(env, "OPENCODE_CONFIG_CONTENT="+string(data))}, true, nil
	}
	return mcpSetup{}, false, nil
}

// mcpPrompt is appended to the task prompt when the tool can use Golf's MCP tools.
func mcpPrompt(t claimedTask) string {
	owner, name, _ := strings.Cut(t.Repository, "/")
	kind := "issue"
	if t.Target.Kind == "pull_request" {
		kind = "pull request"
	}
	return fmt.Sprintf(`

## Golf MCP tools

The Golf MCP server "golf" is connected for this task, with this task's own access. Use its tools (repo_overview, read_files, grep, list_commits, get_issue, get_pull_request, pull_request_diff and others, with owner %q and name %q) to read the %s, its discussion and files at other refs.
You may also publish the change yourself; for these tools only, this replaces the instruction above not to commit or open pull requests. Commit every change with commit_changes to the branch %s (the first time with expectedHead "" and base %s), then call open_pull_request with head %s and base %s. Golf then takes that branch as the proposal and commits nothing from this working copy, so leave no other changes here. Otherwise edit files here as described above and Golf commits them to %s when you finish.
Comment only on %s #%d, or on the pull request you open.
`, owner, name, kind, t.Branch, t.BaseCommit, t.Branch, strings.TrimPrefix(t.BaseRef, "refs/heads/"), t.Branch, kind, t.Target.Number)
}
