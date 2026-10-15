package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

const (
	maxLogLine     = 2000     // bytes per stored log line
	maxPendingLogs = 20000    // lines buffered locally before dropping
	maxChunkLines  = 200      // contract: ≤ 200 lines per log call
	maxChunkBytes  = 60 << 10 // contract: ≤ 64 KiB per log call (JSON-encoded)
	maxSummary     = 4 << 10
	maxFailure     = 512
	maxEventLine   = 1 << 20 // stdout JSON events larger than this are not parsed
	maxChanged     = 1000
)

// redact replaces every secret in s.
func redact(s string, secrets []string) string {
	for _, v := range secrets {
		if v != "" {
			s = strings.ReplaceAll(s, v, "[redacted]")
		}
	}
	return s
}

// sanitizeLine makes one log line: no terminal escapes or control characters, valid
// UTF-8, secrets redacted, bounded.
func sanitizeLine(s string, secrets []string) string {
	s = string(stripANSI([]byte(s)))
	s = strings.TrimRight(s, "\r")
	s = strings.Map(func(r rune) rune {
		if r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, strings.ToValidUTF8(s, "�"))
	s = redact(s, secrets)
	if len(s) > maxLogLine {
		s = clip(s, maxLogLine) + " …[line truncated]"
	}
	return s
}

// logStream buffers a task's log lines and sends them to Golf in bounded chunks.
type logStream struct {
	mu      sync.Mutex
	pending []string
	offset  int64 // lines Golf has accepted
	dropped int
	full    bool // Golf stopped storing lines (log truncated)
	secrets []string
	tail    []string // last lines, for a summary when the tool gives none
}

func (l *logStream) add(line string) {
	line = sanitizeLine(line, l.secrets)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.tail = append(l.tail, line)
	if len(l.tail) > 20 {
		l.tail = l.tail[1:]
	}
	if l.full {
		return
	}
	if len(l.pending) >= maxPendingLogs {
		l.dropped++
		return
	}
	l.pending = append(l.pending, line)
}

func (l *logStream) empty() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.pending) == 0 || l.full
}

type logPost func(ctx context.Context, offset int64, lines []string) (next int64, cancel bool, err error)

// send posts one chunk. It returns cancel when Golf asks the task to stop.
func (l *logStream) send(ctx context.Context, post logPost) (bool, error) {
	l.mu.Lock()
	if l.full || len(l.pending) == 0 {
		l.mu.Unlock()
		return false, nil
	}
	offset := l.offset
	size := 0
	n := 0
	for n < len(l.pending) && n < maxChunkLines {
		encoded, _ := json.Marshal(l.pending[n])
		if n > 0 && size+len(encoded)+1 > maxChunkBytes {
			break
		}
		size += len(encoded) + 1
		n++
	}
	chunk := slices.Clone(l.pending[:n])
	l.mu.Unlock()

	next, cancel, err := post(ctx, offset, chunk)
	var a *apiError
	if err != nil && !(errors.As(err, &a) && a.Status == http.StatusConflict && a.NextOffset != nil) {
		return false, err
	}
	if err != nil {
		next = *a.NextOffset // resync: Golf holds a different count than this host thought
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	accepted := next - offset
	switch {
	case err != nil && accepted <= 0:
		// Golf has fewer lines than expected; continue from its count with what is
		// still pending (lines in between were lost).
	case accepted >= int64(len(chunk)) || err != nil:
		l.pending = l.pending[min(int(accepted), len(l.pending)):]
	default:
		// Fewer lines stored than sent: the stored log is full.
		l.full = true
		l.pending = nil
	}
	l.offset = next
	return cancel, nil
}

// taskRun is the work for one claimed task.
type taskRun struct {
	h       *host
	t       claimedTask
	log     *logStream
	secrets []string
}

func (r *taskRun) hostLine(format string, args ...any) {
	r.log.add("[golf-agent-host] " + fmt.Sprintf(format, args...))
}

func (r *taskRun) postLog(ctx context.Context, offset int64, lines []string) (int64, bool, error) {
	var resp struct {
		NextOffset int64 `json:"nextOffset"`
		Cancel     bool  `json:"cancel"`
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	err := r.h.api.post(cctx, "/native/agent-host/tasks/"+r.t.ID+"/log", r.t.Token, map[string]any{"offset": offset, "lines": lines}, &resp)
	return resp.NextOffset, resp.Cancel, err
}

// streamLogs sends buffered lines about every second until stop closes.
func (r *taskRun) streamLogs(stop <-chan struct{}, cancelTask context.CancelCauseFunc) {
	ticker := time.NewTicker(r.h.t.log)
	defer ticker.Stop()
	backoff := time.Time{}
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		if time.Now().Before(backoff) {
			continue
		}
		cancel, err := r.log.send(context.Background(), r.postLog)
		switch {
		case cancel:
			cancelTask(errCancelled)
		case err != nil && isFinal(err):
			r.h.logf("task %s: log refused (%v); stopping the tool", r.t.ID, err)
			cancelTask(errTaskGone)
		case err != nil:
			backoff = time.Now().Add(5 * time.Second)
		}
	}
}

func (r *taskRun) flushLogs() {
	for i := 0; i < 200 && !r.log.empty(); i++ {
		if _, err := r.log.send(context.Background(), r.postLog); err != nil {
			if isFinal(err) || i > 5 {
				return
			}
			time.Sleep(2 * time.Second)
		}
	}
}

func (r *taskRun) finish(f finishRequest) {
	f.Summary = clip(f.Summary, maxSummary)
	f.Failure = clip(redact(f.Failure, r.secrets), maxFailure)
	f.Summary = redact(f.Summary, r.secrets)
	if f.ChangedFiles == nil {
		f.ChangedFiles = []string{}
	}
	var resp struct {
		OK    bool   `json:"ok"`
		State string `json:"state"`
	}
	var err error
	wait := 2 * time.Second
	for attempt := 0; attempt < 6; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		err = r.h.api.post(ctx, "/native/agent-host/tasks/"+r.t.ID+"/finish", r.t.Token, f, &resp)
		cancel()
		if err == nil || isFinal(err) {
			break
		}
		time.Sleep(wait)
		wait *= 2
	}
	if err != nil {
		r.h.logf("task %s: finish %s not recorded: %v", r.t.ID, f.State, err)
		return
	}
	r.h.logf("task %s: finished %s (Golf state %s)", r.t.ID, f.State, resp.State)
}

// runTask executes one task end to end and always tries to report a finish.
func (h *host) runTask(ctx context.Context, t claimedTask) {
	r := &taskRun{h: h, t: t, secrets: []string{t.Token, h.file.Credential}}
	r.log = &logStream{secrets: r.secrets}
	if err := validateTask(t, h.file.Origin, time.Now()); err != nil {
		h.logf("task %s: refused: %v", clip(t.ID, 36), err)
		if tokenUsable(t) {
			r.finish(finishRequest{State: "failed", ExitCode: -1, Failure: "host refused the task: " + err.Error()})
		}
		return
	}
	h.logf("task %s: claimed (%s, %s %s #%d)", t.ID, t.Tool, t.Repository, t.Target.Kind, t.Target.Number)
	f := r.execute(ctx)
	if f.State == "gone" {
		h.logf("task %s: %v; stopped without a finish", t.ID, errTaskGone)
		return
	}
	r.finish(f)
}

func (r *taskRun) execute(parent context.Context) (result finishRequest) {
	h, t := r.h, r.t
	result = finishRequest{ExitCode: -1}
	spec := toolSpecs[t.Tool]
	tc := h.cfg.tool(t.Tool)
	path, lookErr := exec.LookPath(t.Tool)
	reported := slices.ContainsFunc(h.currentTools(), func(r toolReport) bool { return r.Tool == t.Tool })
	switch {
	case !h.cfg.enabled(t.Tool):
		result.State, result.Failure = "failed", "tool_unavailable: "+t.Tool+" is disabled in this host's configuration"
		return
	case !reported:
		result.State, result.Failure = "failed", "tool_unavailable: this host does not report "+t.Tool+" as usable (see the host's output)"
		return
	case lookErr != nil:
		result.State, result.Failure = "failed", "tool_unavailable: "+t.Tool+" is not installed on this host"
		return
	case t.Model != "" && len(tc.Models) > 0 && !slices.Contains(tc.Models, t.Model):
		result.State, result.Failure = "failed", "model_not_allowed: this host does not allow model "+t.Model+" for "+t.Tool
		return
	}

	ctx, cancelTask := context.WithCancelCause(parent)
	defer cancelTask(nil)
	var start struct {
		OK     bool `json:"ok"`
		Cancel bool `json:"cancel"`
	}
	sctx, scancel := context.WithTimeout(ctx, 20*time.Second)
	err := h.api.post(sctx, "/native/agent-host/tasks/"+t.ID+"/start", t.Token, map[string]any{}, &start)
	scancel()
	if err != nil {
		result.State, result.Failure = "failed", "start refused: "+err.Error()
		if s := statusOf(err); s == http.StatusUnauthorized || s == http.StatusConflict {
			result.State = "gone"
		}
		return
	}
	if start.Cancel {
		result.State = "cancelled"
		return
	}

	stop := make(chan struct{})
	streamDone := make(chan struct{})
	go func() { r.streamLogs(stop, cancelTask); close(streamDone) }()
	defer func() {
		close(stop)
		<-streamDone
		r.flushLogs()
	}()

	dir := filepath.Join(h.workRoot, t.ID)
	_ = os.RemoveAll(dir)
	if err := os.Mkdir(dir, 0700); err != nil {
		result.State, result.Failure = "failed", "working copy: "+err.Error()
		return
	}
	if h.cfg.KeepWork {
		r.hostLine("keeping the working copy at %s", dir)
	} else {
		defer os.RemoveAll(dir)
	}
	dctx, dcancel := context.WithDeadlineCause(ctx, time.UnixMilli(t.Deadline), errTimedOut)
	defer dcancel()
	stateFor := func() (string, bool) {
		switch cause := context.Cause(dctx); {
		case cause == nil:
			return "", false
		case errors.Is(cause, errTimedOut):
			return "timed_out", true
		case errors.Is(cause, errCancelled):
			return "cancelled", true
		case errors.Is(cause, errTaskGone):
			return "gone", true
		default:
			return "failed", true
		}
	}
	interrupted := func(stage string) bool {
		if state, ok := stateFor(); ok {
			result.State = state
			if state == "failed" {
				result.Failure = "host stopped during " + stage
			}
			r.hostLine("stopped during %s: %s", stage, state)
			return true
		}
		return false
	}

	g := newGitRunner(dir, t)
	r.hostLine("cloning %s at %s", t.Repository, t.BaseCommit[:12])
	repo, err := g.prepare(dctx)
	if err != nil {
		if interrupted("clone") {
			return
		}
		result.State, result.Failure = "failed", "clone_failed: "+err.Error()
		r.hostLine("%s", result.Failure)
		return
	}
	// Golf's MCP endpoint for this run only, with the task token in the tool's environment
	// (never in argv, a file or a log); the prompt then says how to use it.
	prompt, mcp, mcpOn := t.Prompt, mcpSetup{}, false
	if t.MCP != nil {
		var err error
		if mcp, mcpOn, err = configureMCP(t.Tool, t.MCP.URL, t.Token, dir); err != nil {
			result.State, result.Failure = "failed", "mcp config: "+err.Error()
			return
		}
		defer mcp.cleanup()
		if mcpOn {
			prompt += mcpPrompt(t)
			r.hostLine("Golf MCP tools connected for %s (%s)", t.Tool, t.MCP.URL)
		} else {
			r.hostLine("%s reads MCP servers only from its own configuration; running without Golf MCP tools", t.Tool)
		}
	}
	promptFile := filepath.Join(dir, "prompt.txt")
	if err := os.WriteFile(promptFile, []byte(prompt), 0600); err != nil {
		result.State, result.Failure = "failed", "prompt file: "+err.Error()
		return
	}
	args := mcp.withArgs(spec.args(tc, h.cfg.codexSandbox(), t.Model, repo, promptFile))
	// Some CLIs (OpenCode) take the project directory from $PWD, so it must name repo/.
	env := h.scrubbedEnv([]string{t.Token}, append(append([]string{"PWD=" + repo}, spec.env...), mcp.env...)...)
	r.hostLine("running %s on branch %s", t.Tool, t.Branch)
	outcome, err := runTool(dctx, path, args, env, repo, promptFile, spec.format, h.t.killGrace, r.log.add)
	mcp.cleanup()
	result.ExitCode = outcome.exitCode
	result.Usage = outcome.parsed.usage
	result.Summary = outcome.parsed.final
	if result.Summary == "" {
		r.log.mu.Lock()
		result.Summary = strings.Join(r.log.tail, "\n")
		r.log.mu.Unlock()
	}
	if err != nil {
		result.State, result.Failure = "failed", "tool did not start: "+err.Error()
		r.hostLine("%s", result.Failure)
		return
	}
	if interrupted("the tool run") {
		return
	}
	r.hostLine("%s exited with code %d", t.Tool, outcome.exitCode)
	toolFailed := outcome.exitCode != 0 || outcome.parsed.isError

	// With MCP the tool may have published the branch itself (commit_changes); then that
	// branch is the proposal and the host pushes nothing.
	published := ""
	if mcpOn {
		if published, err = g.remoteHead(dctx); err != nil {
			if interrupted("branch check") {
				return
			}
			result.State, result.Failure = "failed", "branch_check_failed: "+err.Error()
			r.hostLine("%s", result.Failure)
			return
		}
	}
	commit, files, err := g.commit(dctx, repo)
	switch {
	case err != nil:
		if interrupted("commit") {
			return
		}
		result.State, result.Failure = "failed", "commit_failed: "+err.Error()
	case published != "":
		files, err := g.adopt(dctx, published, commit)
		if err != nil {
			if interrupted("branch check") {
				return
			}
			result.State, result.Failure = "failed", "branch_published: "+err.Error()
			break
		}
		result.State, result.CommitID, result.ChangedFiles = "succeeded", published, files
		r.hostLine("%s published %s at %s through Golf MCP; nothing pushed from the working copy", t.Tool, t.Branch, published[:12])
	case commit == "" && toolFailed:
		result.State, result.Failure = "failed", fmt.Sprintf("%s failed (exit %d) without changing files", t.Tool, outcome.exitCode)
	case commit == "":
		result.State = "no_changes"
		r.hostLine("no changes")
	default:
		r.hostLine("committed %s (%d file(s)); pushing %s", commit[:12], len(files), t.Branch)
		if err := g.push(dctx, commit); err != nil {
			if interrupted("push") {
				return
			}
			result.State, result.Failure = "failed", "push_failed: "+err.Error()
			break
		}
		result.State, result.CommitID, result.ChangedFiles = "succeeded", commit, files
		r.hostLine("pushed %s", t.Branch)
	}
	if result.Failure != "" {
		r.hostLine("%s", result.Failure)
	}
	return
}

type toolOutcome struct {
	exitCode int
	parsed   parsed
}

type streamLine struct {
	stdout    bool
	text      []byte
	truncated bool
}

// readLines splits r into lines, keeping at most maxEventLine bytes of each.
func readLines(r io.Reader, stdout bool, out chan<- streamLine) {
	br := bufio.NewReaderSize(r, 64<<10)
	var line []byte
	truncated := false
	for {
		part, err := br.ReadSlice('\n')
		if len(line)+len(part) <= maxEventLine {
			line = append(line, part...)
		} else {
			truncated = true
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if len(line) > 0 {
			out <- streamLine{stdout: stdout, text: bytes.TrimRight(line, "\r\n"), truncated: truncated}
		}
		line, truncated = nil, false
		if err != nil {
			return
		}
	}
}

// runTool starts the tool in its own process group with the prompt file on stdin and
// streams rendered output lines to emit. When ctx ends the whole group gets SIGTERM,
// then SIGKILL after grace; after the tool exits any leftover group members are killed.
func runTool(ctx context.Context, path string, args, env []string, dir, promptFile, format string, grace time.Duration, emit func(string)) (toolOutcome, error) {
	outcome := toolOutcome{exitCode: -1}
	stdin, err := os.Open(promptFile)
	if err != nil {
		return outcome, err
	}
	defer stdin.Close()
	outR, outW, err := os.Pipe()
	if err != nil {
		return outcome, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return outcome, err
	}
	defer outR.Close()
	defer errR.Close()
	cmd := exec.Command(path, args...)
	cmd.Dir, cmd.Env, cmd.Stdin, cmd.Stdout, cmd.Stderr = dir, env, stdin, outW, errW
	cmd.SysProcAttr = processAttributes()
	startErr := cmd.Start()
	outW.Close()
	errW.Close()
	if startErr != nil {
		return outcome, startErr
	}
	pgid := cmd.Process.Pid
	parser := newParser(format, dir)

	lines := make(chan streamLine, 256)
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); readLines(outR, true, lines) }()
	go func() { defer readers.Done(); readLines(errR, false, lines) }()
	go func() { readers.Wait(); close(lines) }()
	waited := make(chan *os.ProcessState, 1)
	go func() { _ = cmd.Wait(); waited <- cmd.ProcessState }()

	ctxDone := ctx.Done()
	var killTimer, closeTimer <-chan time.Time
	for lines != nil || waited != nil {
		select {
		case l, ok := <-lines:
			if !ok {
				lines = nil
				continue
			}
			switch {
			case !l.stdout:
				emit(string(l.text))
			case l.truncated && bytes.HasPrefix(l.text, []byte("{")):
				emit("[large output event omitted]")
			default:
				for _, s := range parser.render(l.text) {
					emit(s)
				}
			}
		case state := <-waited:
			waited = nil
			if state != nil {
				outcome.exitCode = state.ExitCode()
			}
			// Kill anything the tool left running in its group; give readers a bound.
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
			closeTimer = time.After(grace)
		case <-ctxDone:
			ctxDone = nil
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
			killTimer = time.After(grace)
		case <-killTimer:
			killTimer = nil
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
			_ = cmd.Process.Kill() // in case the group could not be signalled
		case <-closeTimer:
			// A process that escaped the group still holds the pipes.
			closeTimer = nil
			outR.Close()
			errR.Close()
		}
	}
	outcome.parsed = parser.result()
	return outcome, nil
}

// gitRunner runs host-side Git. The task token reaches Git only through environment
// configuration (http.extraHeader) of commands that talk to Golf, run in origin.git,
// a bare clone the tool is never pointed at. The tool works in repo/, a local clone
// with no remote and no token. Host Git ignores system and global configuration and
// hooks, and allows only http(s) and local transports.
type gitRunner struct {
	dir     string
	t       claimedTask
	origin  string
	plain   []string
	authEnv []string
}

func gitEnvironment(home string, header string) []string {
	cfg := [][2]string{
		{"core.hooksPath", "/dev/null"}, {"core.fsmonitor", "false"}, {"credential.helper", ""},
		{"http.followRedirects", "false"}, {"gc.auto", "0"}, {"maintenance.auto", "false"}, {"commit.gpgSign", "false"},
		{"protocol.allow", "never"}, {"protocol.https.allow", "always"}, {"protocol.http.allow", "always"}, {"protocol.file.allow", "always"},
	}
	if header != "" {
		cfg = append(cfg, [2]string{"http.extraHeader", header})
	}
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "LANG=C", "LC_ALL=C", "GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", fmt.Sprintf("GIT_CONFIG_COUNT=%d", len(cfg))}
	for i, kv := range cfg {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, kv[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, kv[1]))
	}
	return env
}

func newGitRunner(dir string, t claimedTask) *gitRunner {
	home := filepath.Join(dir, "home")
	basic := base64.StdEncoding.EncodeToString([]byte("golf:" + t.Token))
	return &gitRunner{dir: dir, t: t, origin: filepath.Join(dir, "origin.git"),
		plain: gitEnvironment(home, ""), authEnv: gitEnvironment(home, "Authorization: Basic "+basic)}
}

func (g *gitRunner) git(ctx context.Context, dir string, env []string, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir, cmd.Env = dir, env
	cmd.WaitDelay = 5 * time.Second
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &stdout, max: 4 << 20}
	cmd.Stderr = &limitedBuffer{buf: &stderr, max: 16 << 10}
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(string(stripANSI(stderr.Bytes())))
		if i := strings.LastIndex(msg, "\n"); i >= 0 && len(msg)-i > 10 {
			msg = msg[i+1:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", args[0], clip(redact(msg, []string{g.t.Token}), 300))
	}
	return strings.TrimSpace(stdout.String()), nil
}

// prepare clones the task's repository and checks out the task branch at baseCommit.
// It returns the working copy path.
func (g *gitRunner) prepare(ctx context.Context) (string, error) {
	if err := os.Mkdir(filepath.Join(g.dir, "home"), 0700); err != nil {
		return "", err
	}
	args := []string{"clone", "--quiet", "--bare", "--no-tags", "--single-branch", "--branch", strings.TrimPrefix(g.t.BaseRef, "refs/heads/"), "--", g.t.CloneURL, g.origin}
	if _, err := g.git(ctx, g.dir, g.authEnv, "", args...); err != nil {
		return "", err
	}
	if _, err := g.git(ctx, g.origin, g.plain, "", "cat-file", "-e", g.t.BaseCommit+"^{commit}"); err != nil {
		// The base branch moved past (or away from) baseCommit; ask for it directly.
		if _, err := g.git(ctx, g.origin, g.authEnv, "", "fetch", "--quiet", "--no-tags", "--", g.t.CloneURL, g.t.BaseCommit); err != nil {
			return "", errors.New("base commit " + g.t.BaseCommit[:12] + " is not available: " + err.Error())
		}
	}
	repo := filepath.Join(g.dir, "repo")
	if _, err := g.git(ctx, g.dir, g.plain, "", "clone", "--quiet", "--no-checkout", "--no-tags", "--", g.origin, repo); err != nil {
		return "", err
	}
	for _, s := range [][]string{{"checkout", "--quiet", "-b", g.t.Branch, g.t.BaseCommit}, {"remote", "remove", "origin"}} {
		if _, err := g.git(ctx, repo, g.plain, "", s...); err != nil {
			return "", err
		}
	}
	return repo, nil
}

func commitMessage(t claimedTask) string {
	kind := "issue"
	if t.Target.Kind == "pull_request" {
		kind = "pull request"
	}
	subject := fmt.Sprintf("Agent proposal for %s #%d", kind, t.Target.Number)
	if title := strings.Join(strings.Fields(t.Target.Title), " "); title != "" {
		subject += ": " + title
	}
	if r := []rune(subject); len(r) > 72 {
		subject = string(r[:71]) + "…"
	}
	body := fmt.Sprintf("Proposed by %s on a Golf agent host for %s #%d.", t.Tool, kind, t.Target.Number)
	if t.Target.URL != "" {
		body += "\n" + t.Target.URL
	}
	return subject + "\n\n" + body + "\n\nGolf-Agent-Task: " + t.ID + "\n"
}

// commit records the working tree as one commit whose only parent is baseCommit (any
// commits the tool made itself are folded in). It returns "" when nothing changed.
func (g *gitRunner) commit(ctx context.Context, repo string) (string, []string, error) {
	base := g.t.BaseCommit
	if _, err := g.git(ctx, repo, g.plain, "", "add", "--all"); err != nil {
		return "", nil, err
	}
	tree, err := g.git(ctx, repo, g.plain, "", "write-tree")
	if err != nil {
		return "", nil, err
	}
	baseTree, err := g.git(ctx, repo, g.plain, "", "rev-parse", base+"^{tree}")
	if err != nil {
		return "", nil, err
	}
	if tree == baseTree {
		return "", nil, nil
	}
	author := "Golf agent (" + g.t.Tool + ")"
	env := append(slices.Clone(g.plain), "GIT_AUTHOR_NAME="+author, "GIT_AUTHOR_EMAIL=agent@golf.invalid",
		"GIT_COMMITTER_NAME="+author, "GIT_COMMITTER_EMAIL=agent@golf.invalid")
	commit, err := g.git(ctx, repo, env, commitMessage(g.t), "commit-tree", tree, "-p", base, "-F", "-")
	if err != nil {
		return "", nil, err
	}
	if _, err := g.git(ctx, repo, g.plain, "", "update-ref", "refs/golf-agent/proposal", commit); err != nil {
		return "", nil, err
	}
	// Bring the commit into the host-owned bare clone; only upload-pack runs in repo/.
	if _, err := g.git(ctx, g.origin, g.plain, "", "fetch", "--quiet", "--no-tags", "--", "../repo", "+refs/golf-agent/proposal:refs/golf-agent/proposal"); err != nil {
		return "", nil, err
	}
	parents, err := g.git(ctx, g.origin, g.plain, "", "rev-list", "--parents", "-n", "1", commit)
	if err != nil || parents != commit+" "+base {
		return "", nil, errors.New("proposal commit is not a single commit on baseCommit")
	}
	files, err := g.changedFiles(ctx, commit)
	if err != nil {
		return "", nil, err
	}
	return commit, files, nil
}

// changedFiles lists the paths commit changes from baseCommit, in origin.git.
func (g *gitRunner) changedFiles(ctx context.Context, commit string) ([]string, error) {
	out, err := g.git(ctx, g.origin, g.plain, "", "diff-tree", "-r", "--no-commit-id", "--name-only", "-z", g.t.BaseCommit, commit)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, f := range strings.Split(out, "\x00") {
		if f != "" && len(files) < maxChanged {
			files = append(files, clip(f, 1024))
		}
	}
	return files, nil
}

// remoteHead is the commit refs/heads/<branch> points at in Golf, or "" when the branch
// does not exist.
func (g *gitRunner) remoteHead(ctx context.Context) (string, error) {
	out, err := g.git(ctx, g.origin, g.authEnv, "", "ls-remote", "--", g.t.CloneURL, "refs/heads/"+g.t.Branch)
	if err != nil || out == "" {
		return "", err
	}
	head, ref, _ := strings.Cut(out, "\t")
	if ref != "refs/heads/"+g.t.Branch || !shaPattern.MatchString(head) {
		return "", errors.New("unexpected ls-remote answer")
	}
	return head, nil
}

// adopt takes the branch the tool published through Golf MCP as the proposal: it is
// fetched into origin.git, and any change the tool also left in the working copy
// (commit, or "" for none) must already be on it. It returns the changed files.
func (g *gitRunner) adopt(ctx context.Context, published, commit string) ([]string, error) {
	if _, err := g.git(ctx, g.origin, g.authEnv, "", "fetch", "--quiet", "--no-tags", "--", g.t.CloneURL, "+refs/heads/"+g.t.Branch+":refs/golf-agent/published"); err != nil {
		return nil, err
	}
	if got, err := g.git(ctx, g.origin, g.plain, "", "rev-parse", "refs/golf-agent/published"); err != nil || got != published {
		return nil, errors.New(g.t.Branch + " moved while the host read it")
	}
	if commit != "" {
		trees, err := g.git(ctx, g.origin, g.plain, "", "rev-parse", published+"^{tree}", commit+"^{tree}")
		if err != nil {
			return nil, err
		}
		if one, other, _ := strings.Cut(trees, "\n"); one != other {
			return nil, errors.New("the tool published " + g.t.Branch + " through Golf MCP and also left different changes in the working copy; the branch keeps only what was published")
		}
	}
	return g.changedFiles(ctx, published)
}

// push creates refs/heads/<branch> at commit in Golf, from the host-owned bare clone.
func (g *gitRunner) push(ctx context.Context, commit string) error {
	_, err := g.git(ctx, g.origin, g.authEnv, "", "push", "--quiet", "--no-verify", "--", g.t.CloneURL, commit+":refs/heads/"+g.t.Branch)
	return err
}
