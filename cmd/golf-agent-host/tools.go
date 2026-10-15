package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// toolSpec is one row of the fixed command table. Commands are argv lists, never shell
// strings. The prompt never appears in argv: it is read from stdin (a private file),
// or for Grok from --prompt-file, so it does not show in process listings.
type toolSpec struct {
	name   string
	format string // output parser: "claude" (Claude Code and Grok), "codex" or "opencode"
	// args builds argv after the binary name; dir is the working copy. review asks for
	// the tool's read-only mode (a review task changes nothing).
	args func(c toolConfig, sandbox, model, dir, promptFile string, review bool) []string
	// noReview marks a tool without a read-only mode; its review tasks fail.
	noReview bool
	// env adds tool-specific variables to the scrubbed environment.
	env        []string
	statusArgs []string
	status     func(output []byte, exitCode int) (*bool, string)
}

func boolPtr(v bool) *bool { return &v }

func withModel(args []string, model string, extra []string) []string {
	if model != "" {
		args = append(args, "--model", model)
	}
	return append(args, extra...)
}

var toolOrder = []string{"codex", "claude", "opencode", "grok"}

var toolSpecs = map[string]*toolSpec{
	"codex": {
		name: "codex", format: "codex",
		// codex exec: non-interactive; --sandbox workspace-write confines writes to the
		// working directory (and temp) and blocks network for commands it runs;
		// --ephemeral keeps no session files; "-" reads the prompt from stdin. A review
		// runs in the read-only sandbox.
		args: func(c toolConfig, sandbox, model, _, _ string, review bool) []string {
			if review {
				sandbox = "read-only"
			}
			a := []string{"exec", "--json", "--color", "never", "--sandbox", sandbox, "--ephemeral"}
			return append(withModel(a, model, c.ExtraArgs), "--", "-")
		},
		statusArgs: []string{"login", "status"},
		status: func(out []byte, code int) (*bool, string) {
			s := string(out)
			switch {
			case code == 0 && strings.Contains(s, "Logged in"):
				account := ""
				if strings.Contains(s, "ChatGPT") {
					account = "ChatGPT"
				} else if strings.Contains(s, "API key") {
					account = "API key"
				}
				return boolPtr(true), account
			case code != 0 && strings.Contains(s, "Not logged in"):
				return boolPtr(false), ""
			}
			return nil, ""
		},
	},
	"claude": {
		name: "claude", format: "claude",
		// claude -p: print mode reads the prompt from stdin. acceptEdits lets file tools
		// write inside the working directory only; --permission-prompts none denies
		// everything else that would ask (shell commands, paths outside). Only the
		// user's own settings load (not the repository's .claude/settings.json). A review
		// runs in plan mode, which only reads.
		args: func(c toolConfig, _, model, _, _ string, review bool) []string {
			mode := "acceptEdits"
			if review {
				mode = "plan"
			}
			a := []string{"-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode,
				"--permission-prompts", "none", "--setting-sources", "user", "--no-session-persistence"}
			return withModel(a, model, c.ExtraArgs)
		},
		statusArgs: []string{"auth", "status", "--json"},
		status: func(out []byte, _ int) (*bool, string) {
			var s struct {
				LoggedIn         *bool  `json:"loggedIn"`
				AuthMethod       string `json:"authMethod"`
				SubscriptionType string `json:"subscriptionType"`
			}
			if json.Unmarshal(out, &s) != nil || s.LoggedIn == nil {
				return nil, ""
			}
			account := ""
			if *s.LoggedIn && s.AuthMethod != "" && s.AuthMethod != "none" {
				account = s.AuthMethod
				if s.SubscriptionType != "" {
					account += " (" + s.SubscriptionType + ")"
				}
			}
			return s.LoggedIn, clip(account, 100)
		},
	},
	"opencode": {
		name: "opencode", format: "opencode",
		// opencode run reads the prompt from stdin. It takes its project directory from
		// $PWD, not the process directory, so --dir names it explicitly (and PWD is set).
		// OPENCODE_PERMISSION is merged after every config file (including the
		// repository's), so edits stay allowed, shell commands and paths outside the
		// directory are denied. It has no read-only mode, so it takes no review tasks.
		args: func(c toolConfig, _, model, dir, _ string, _ bool) []string {
			return withModel([]string{"run", "--format", "json", "--dir", dir}, model, c.ExtraArgs)
		},
		noReview:   true,
		env:        []string{`OPENCODE_PERMISSION={"edit":"allow","bash":"deny","external_directory":"deny"}`},
		statusArgs: []string{"providers", "list"},
		status: func(out []byte, code int) (*bool, string) {
			m := regexp.MustCompile(`(\d+) credentials?\b`).FindSubmatch(stripANSI(out))
			if code != 0 || m == nil {
				return nil, ""
			}
			if n, _ := strconv.Atoi(string(m[1])); n > 0 {
				return boolPtr(true), ""
			}
			// Environment API keys and free models need no stored credential.
			return nil, ""
		},
	},
	"grok": {
		name: "grok", format: "claude",
		// grok --prompt-file: headless single turn (same as -p, from a file). In headless
		// mode acceptEdits alone cancels writes, so writes and edits are allowed by rule
		// for ./** only; other non-read-only calls are cancelled. --verbatim sends the
		// prompt as given (no @file expansion). A review gets no write or edit rule, so
		// its writes are cancelled.
		args: func(c toolConfig, _, model, _, promptFile string, review bool) []string {
			a := []string{"--output-format", "streaming-messages-json", "--permission-mode", "acceptEdits"}
			if !review {
				a = append(a, "--allow", "Write(./**)", "--allow", "Edit(./**)")
			}
			a = append(a, "--verbatim")
			return append(withModel(a, model, c.ExtraArgs), "--prompt-file", promptFile)
		},
		// Grok has no status command; signed-in is reported as unknown.
	},
}

var versionPattern = regexp.MustCompile(`\d+\.\d+(\.\d+)?[0-9A-Za-z.+-]*`)

// probe runs a short detection command with the scrubbed environment.
func probe(ctx context.Context, path string, env []string, dir string, args ...string) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(env, "PWD="+dir)
	cmd.Dir = dir
	cmd.SysProcAttr = processAttributes()
	var out bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &out, max: 64 << 10}
	cmd.Stderr = cmd.Stdout
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if cmd.ProcessState == nil {
		return out.Bytes(), -1, err
	}
	return out.Bytes(), cmd.ProcessState.ExitCode(), nil
}

type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}

// detectTools reports each enabled, installed tool: version from --version, signed-in
// from the CLI's own status command where one exists. Credential files are never read.
func detectTools(ctx context.Context, c config, env []string, dir string, notes func(string)) []toolReport {
	var reports []toolReport
	for _, name := range toolOrder {
		spec := toolSpecs[name]
		if !c.enabled(name) {
			continue
		}
		path, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		out, code, err := probe(ctx, path, env, dir, "--version")
		version := versionPattern.Find(out)
		if err != nil || code != 0 || version == nil {
			notes(name + ": --version failed; not reported")
			continue
		}
		if name == "codex" && c.codexSandbox() == "workspace-write" {
			// The workspace-write sandbox needs unprivileged user namespaces (bubblewrap
			// on Linux). Where the kernel refuses them, every write would fail.
			if out, code, err := probe(ctx, path, env, dir, "sandbox", "--", "true"); err != nil || code != 0 {
				notes("codex: workspace-write sandbox unavailable on this machine (" + clip(strings.TrimSpace(string(stripANSI(out))), 160) +
					"); not reported. Set tools.codex.sandbox to \"danger-full-access\" to run Codex without its sandbox.")
				continue
			}
		}
		report := toolReport{Tool: name, Version: clip(string(version), 64)}
		if spec.status != nil {
			out, code, err := probe(ctx, path, env, dir, spec.statusArgs...)
			if err == nil {
				report.SignedIn, report.Account = spec.status(out, code)
			}
		}
		reports = append(reports, report)
	}
	return reports
}

// toolEnvironment is the scrubbed environment for tools and detection: the host user's
// own variables (HOME, PATH, tool configuration and sign-in) minus anything Golf or Git
// specific and anything that contains a secret the host holds.
func toolEnvironment(base []string, secrets []string, extra ...string) []string {
	env := make([]string, 0, len(base)+len(extra)+3)
	for _, kv := range base {
		name, value, ok := strings.Cut(kv, "=")
		if !ok || strings.HasPrefix(name, "GOLF_") || strings.HasPrefix(name, "GIT_") || name == "TERM" || name == "NO_COLOR" || name == "PWD" || name == "OLDPWD" {
			continue
		}
		leak := false
		for _, s := range secrets {
			if s != "" && strings.Contains(value, s) {
				leak = true
			}
		}
		if !leak {
			env = append(env, kv)
		}
	}
	env = append(env, "TERM=dumb", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0")
	return append(env, extra...)
}

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]`)

func stripANSI(b []byte) []byte { return ansiPattern.ReplaceAll(b, nil) }

// parsed is what a parser learned from the tool's own output.
type parsed struct {
	final   string
	isError bool
	usage   *usageReport
}

type outputParser interface {
	// render turns one stdout line into zero or more log lines.
	render(line []byte) []string
	result() parsed
}

func newParser(format, dir string) outputParser {
	switch format {
	case "codex":
		return &codexParser{dir: dir}
	case "opencode":
		return &opencodeParser{dir: dir}
	}
	return &claudeParser{dir: dir}
}

func textLines(s string) []string {
	s = strings.TrimRight(s, "\n")
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func relPath(dir, p string) string {
	if rest, ok := strings.CutPrefix(p, dir+"/"); ok {
		return rest
	}
	return p
}

// briefInput names what a tool call touched (a path, a command or a pattern).
func briefInput(dir string, raw json.RawMessage) string {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil {
		return ""
	}
	for _, k := range []string{"file_path", "filePath", "path", "command", "cmd", "pattern", "url", "description"} {
		if v, ok := in[k].(string); ok && v != "" {
			return clip(strings.ReplaceAll(relPath(dir, v), "\n", " "), 200)
		}
	}
	return ""
}

func addUsage(u *usageReport, in, out int64, cost *float64) *usageReport {
	if u == nil {
		u = &usageReport{}
	}
	u.InputTokens += in
	u.OutputTokens += out
	if cost != nil {
		c := *cost
		if u.CostUSD != nil {
			c += *u.CostUSD
		}
		u.CostUSD = &c
	}
	return u
}

// claudeParser reads Claude Code stream-json and Grok streaming-messages-json (the
// same Messages-API shaped events).
type claudeParser struct {
	dir       string
	out       parsed
	lastText  string
	sawResult bool
}

func (p *claudeParser) render(line []byte) []string {
	var ev struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Model   string `json:"model"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		Result       *string  `json:"result"`
		IsError      bool     `json:"is_error"`
		NumTurns     int      `json:"num_turns"`
		TotalCostUSD *float64 `json:"total_cost_usd"`
		Usage        *struct {
			Input         int64 `json:"input_tokens"`
			Output        int64 `json:"output_tokens"`
			CacheRead     int64 `json:"cache_read_input_tokens"`
			CacheCreation int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
		Errors []string `json:"errors"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return []string{string(line)}
	}
	var blocks []struct {
		Type    string          `json:"type"`
		Text    string          `json:"text"`
		Name    string          `json:"name"`
		Input   json.RawMessage `json:"input"`
		Content json.RawMessage `json:"content"`
		IsError bool            `json:"is_error"`
	}
	if len(ev.Message.Content) > 0 && ev.Message.Content[0] == '[' {
		_ = json.Unmarshal(ev.Message.Content, &blocks)
	}
	var lines []string
	switch ev.Type {
	case "system":
		if ev.Subtype == "init" {
			lines = append(lines, "session started (model "+clip(ev.Model, 80)+")")
		}
	case "assistant":
		for _, b := range blocks {
			switch b.Type {
			case "text":
				lines = append(lines, textLines(b.Text)...)
				if strings.TrimSpace(b.Text) != "" {
					p.lastText = b.Text
				}
			case "tool_use":
				lines = append(lines, "→ "+b.Name+" "+briefInput(p.dir, b.Input))
			}
		}
	case "user":
		for _, b := range blocks {
			if b.Type == "tool_result" && b.IsError {
				var text string
				if json.Unmarshal(b.Content, &text) != nil {
					text = string(b.Content)
				}
				first, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
				lines = append(lines, "← tool error: "+clip(first, 300))
			}
		}
	case "result":
		p.sawResult = true
		p.out.isError = ev.IsError
		if ev.Result != nil {
			p.out.final = *ev.Result
		}
		if ev.Usage != nil {
			in := ev.Usage.Input + ev.Usage.CacheRead + ev.Usage.CacheCreation
			if in+ev.Usage.Output > 0 || ev.TotalCostUSD != nil {
				p.out.usage = addUsage(nil, in, ev.Usage.Output, ev.TotalCostUSD)
			}
		}
		state := "success"
		if ev.IsError {
			state = "error " + ev.Subtype
			if len(ev.Errors) > 0 {
				state += ": " + clip(strings.Join(ev.Errors, "; "), 300)
			}
		}
		lines = append(lines, "result: "+state+" ("+strconv.Itoa(ev.NumTurns)+" turns)")
	}
	return lines
}

func (p *claudeParser) result() parsed {
	r := p.out
	if r.final == "" {
		r.final = p.lastText
	}
	return r
}

// codexParser reads `codex exec --json` events.
type codexParser struct {
	dir string
	out parsed
}

func (p *codexParser) render(line []byte) []string {
	var ev struct {
		Type string `json:"type"`
		Item *struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Command  string `json:"command"`
			ExitCode *int   `json:"exit_code"`
			Status   string `json:"status"`
			Server   string `json:"server"`
			Tool     string `json:"tool"`
			Message  string `json:"message"`
			Changes  []struct {
				Path string `json:"path"`
				Kind string `json:"kind"`
			} `json:"changes"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"` // an MCP tool call's failure
		} `json:"item"`
		Usage *struct {
			Input  int64 `json:"input_tokens"`
			Output int64 `json:"output_tokens"`
		} `json:"usage"`
		Message string `json:"message"`
		Error   *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return []string{string(line)}
	}
	var lines []string
	switch ev.Type {
	case "item.started":
		if ev.Item != nil && ev.Item.Type == "command_execution" {
			lines = append(lines, "$ "+clip(strings.ReplaceAll(ev.Item.Command, "\n", " "), 300))
		}
		if ev.Item != nil && ev.Item.Type == "mcp_tool_call" {
			lines = append(lines, "→ "+clip(ev.Item.Server+"."+ev.Item.Tool, 200))
		}
	case "item.completed":
		if ev.Item == nil {
			break
		}
		switch ev.Item.Type {
		case "agent_message":
			lines = append(lines, textLines(ev.Item.Text)...)
			if strings.TrimSpace(ev.Item.Text) != "" {
				p.out.final = ev.Item.Text
			}
		case "command_execution":
			if ev.Item.ExitCode != nil {
				lines = append(lines, "  exit "+strconv.Itoa(*ev.Item.ExitCode))
			}
		case "file_change":
			for _, c := range ev.Item.Changes {
				lines = append(lines, "changed "+relPath(p.dir, c.Path)+" ("+c.Kind+", "+ev.Item.Status+")")
			}
		case "mcp_tool_call":
			if ev.Item.Error != nil {
				lines = append(lines, "← tool error: "+clip(ev.Item.Error.Message, 300))
			}
		case "error":
			lines = append(lines, "error: "+clip(ev.Item.Message, 300))
		}
	case "turn.completed":
		if ev.Usage != nil {
			p.out.usage = addUsage(p.out.usage, ev.Usage.Input, ev.Usage.Output, nil)
		}
	case "turn.failed", "error":
		p.out.isError = true
		msg := ev.Message
		if ev.Error != nil {
			msg = ev.Error.Message
		}
		lines = append(lines, "error: "+clip(msg, 300))
	}
	return lines
}

func (p *codexParser) result() parsed { return p.out }

// opencodeParser reads `opencode run --format json` events.
type opencodeParser struct {
	dir string
	out parsed
}

func (p *opencodeParser) render(line []byte) []string {
	var ev struct {
		Type string `json:"type"`
		Part struct {
			Text  string `json:"text"`
			Tool  string `json:"tool"`
			State struct {
				Status string          `json:"status"`
				Title  string          `json:"title"`
				Input  json.RawMessage `json:"input"`
				Error  string          `json:"error"`
			} `json:"state"`
			Tokens *struct {
				Input     int64 `json:"input"`
				Output    int64 `json:"output"`
				Reasoning int64 `json:"reasoning"`
				Cache     struct {
					Read  int64 `json:"read"`
					Write int64 `json:"write"`
				} `json:"cache"`
			} `json:"tokens"`
			Cost *float64 `json:"cost"`
		} `json:"part"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return []string{string(line)}
	}
	var lines []string
	switch ev.Type {
	case "text":
		lines = append(lines, textLines(ev.Part.Text)...)
		if strings.TrimSpace(ev.Part.Text) != "" {
			p.out.final = ev.Part.Text
		}
	case "tool_use":
		what := briefInput(p.dir, ev.Part.State.Input)
		if what == "" {
			what = clip(ev.Part.State.Title, 200)
		}
		lines = append(lines, "→ "+ev.Part.Tool+" "+what+" ("+ev.Part.State.Status+")")
		if ev.Part.State.Error != "" {
			lines = append(lines, "← tool error: "+clip(ev.Part.State.Error, 300))
		}
	case "step_finish":
		if t := ev.Part.Tokens; t != nil {
			p.out.usage = addUsage(p.out.usage, t.Input+t.Cache.Read+t.Cache.Write, t.Output+t.Reasoning, ev.Part.Cost)
		}
	case "error":
		p.out.isError = true
		var e struct {
			Name string `json:"name"`
			Data struct {
				Message string `json:"message"`
			} `json:"data"`
		}
		_ = json.Unmarshal(ev.Error, &e)
		msg := e.Data.Message
		if msg == "" {
			msg = e.Name
		}
		lines = append(lines, "error: "+clip(msg, 300))
	}
	return lines
}

func (p *opencodeParser) result() parsed { return p.out }

// environ is the process environment captured once at start (after the registration
// token has been removed).
var environ = os.Environ
