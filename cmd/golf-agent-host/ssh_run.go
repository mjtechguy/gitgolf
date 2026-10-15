package main

// ssh-run and ssh-probe (docs/SSH_HOSTS.md): golf-agent-host as the runner of one SSH host task, inside the container Golf starts
// for it. The job (the claimed task with its token, and the connection with Golf's key) arrives on standard input only. The task
// follows the outbound host's path (task.go) with the same protocol, log stream, tool table, commit and push; only the tool runs
// on the SSH host:
//  1. clone here with the task token (the token never reaches the SSH host, which needs no route to Golf);
//  2. create a private working directory on the host and send it the working copy (with .git, without any remote) and the prompt;
//  3. run the tool there in the account's login shell, headless with the outbound host's flags, prompt on standard input from the
//     file; stream its output to the task log; poll Golf for a cancel while it is silent;
//  4. bring the working tree back (never .git), commit it here as the agent with the Golf-Agent-Task trailer, push
//     golf-agent/<id8>, finish; remove the host's working directory whatever happened.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const maxJobBytes = 256 << 10

type sshJob struct {
	Origin string       `json:"origin"`
	Task   *claimedTask `json:"task,omitempty"`
	SSH    sshTarget    `json:"ssh"`
}

// probeReport is what ssh-probe prints (one JSON object); Golf computes the fingerprint itself.
type probeReport struct {
	HostKey       string       `json:"hostKey,omitempty"`
	Fingerprint   string       `json:"fingerprint,omitempty"`
	Matched       *bool        `json:"matched"`
	Authenticated bool         `json:"authenticated"`
	OS            string       `json:"os,omitempty"`
	Arch          string       `json:"arch,omitempty"`
	Tools         []toolReport `json:"tools"`
	Error         string       `json:"error,omitempty"`
}

func readJob(r io.Reader) (sshJob, error) {
	var job sshJob
	data, err := io.ReadAll(io.LimitReader(r, maxJobBytes+1))
	if err != nil || len(data) > maxJobBytes {
		return job, errors.New("job unreadable or larger than 256 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&job); err != nil {
		return job, fmt.Errorf("job is not valid JSON: %v", err)
	}
	if err := job.SSH.validate(); err != nil {
		return job, err
	}
	return job, nil
}

var remoteDirPattern = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,300}/[0-9a-f-]{36}$`)

// cmdSSHProbe tests the connection: without a pinned key it reports only the key the host offers; with one it verifies it,
// signs in with Golf's key and reports the OS, architecture and the coding tools (version and sign-in, as the outbound host does).
func cmdSSHProbe(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	job, err := readJob(stdin)
	report := probeReport{Tools: []toolReport{}}
	emit := func() error { return json.NewEncoder(stdout).Encode(report) }
	if err != nil {
		report.Error = "invalid job: " + err.Error()
		return emit()
	}
	secrets := job.SSH.secrets()
	dir, err := os.MkdirTemp("", "golf-ssh-probe-")
	if err != nil {
		report.Error = err.Error()
		return emit()
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(ctx, 100*time.Second)
	defer cancel()
	offered := &offeredKey{}
	client, r, err := connectSSH(ctx, job.SSH, dir, job.SSH.HostKey != "", offered, func(string) {})
	report.HostKey = offered.authorized()
	if offered.key != nil {
		report.Fingerprint = ssh.FingerprintSHA256(offered.key)
	}
	switch {
	case errors.Is(err, errHostKeyNotPinned):
		return emit()
	case errors.Is(err, errHostKeyMismatch):
		report.Matched = boolPtr(false)
		report.Error = err.Error() + " (" + report.Fingerprint + "). If the machine was reinstalled, confirm the new key in Golf; otherwise do not trust it."
		return emit()
	case err != nil:
		if report.HostKey != "" && job.SSH.HostKey != "" {
			report.Matched = boolPtr(true)
		}
		report.Error = clip(redact(err.Error(), secrets), 400)
		return emit()
	}
	defer r.close()
	defer client.Close()
	report.Matched, report.Authenticated = boolPtr(true), true
	out, code, err := remoteOutput(ctx, client, shellCommand("uname -s; uname -m"), 20*time.Second)
	if err == nil && code == 0 {
		lines := strings.Fields(strings.ToLower(string(out)))
		if len(lines) == 2 {
			report.OS, report.Arch = lines[0], map[string]string{"x86_64": "amd64", "aarch64": "arm64"}[lines[1]]
			if report.Arch == "" {
				report.Arch = clip(lines[1], 32)
			}
		}
	}
	report.Tools = detectRemoteTools(ctx, client)
	return emit()
}

// detectRemoteTools mirrors detectTools on the host: version from --version, sign-in from the CLI's own status command, Codex
// only when its workspace-write sandbox works there. Credential files are never read.
func detectRemoteTools(ctx context.Context, client *ssh.Client) []toolReport {
	reports := []toolReport{}
	for _, name := range toolOrder {
		spec := toolSpecs[name]
		run := func(args ...string) ([]byte, int, error) {
			words := []string{"env", "TERM=dumb", "NO_COLOR=1", name}
			for _, a := range args {
				words = append(words, shQuote(a))
			}
			script := "command -v " + name + " >/dev/null 2>&1 || exit 127; cd \"$HOME\" && exec " + strings.Join(words, " ")
			return remoteOutput(ctx, client, shellCommand(loginScript(script)), 25*time.Second)
		}
		out, code, err := run("--version")
		version := versionPattern.Find(stripANSI(out))
		if err != nil || code != 0 || version == nil {
			continue
		}
		if name == "codex" {
			if _, code, err := run("sandbox", "--", "true"); err != nil || code != 0 {
				continue
			}
		}
		report := toolReport{Tool: name, Version: clip(string(version), 64)}
		if spec.status != nil {
			if out, code, err := run(spec.statusArgs...); err == nil {
				report.SignedIn, report.Account = spec.status(out, code)
			}
		}
		reports = append(reports, report)
	}
	return reports
}

// cmdSSHRun runs one task end to end and always tries to report a finish.
func cmdSSHRun(ctx context.Context, stdin io.Reader, stderr io.Writer) error {
	job, err := readJob(stdin)
	if err != nil {
		return err
	}
	if job.Task == nil || !validOrigin(job.Origin) {
		return errors.New("ssh-run needs a task and Golf's origin")
	}
	if job.SSH.HostKey == "" {
		return errors.New("ssh-run needs a pinned host key")
	}
	h := &host{file: hostFile{Origin: job.Origin}, api: newAPIClient(job.Origin, ""), out: stderr, t: defaultTimings, running: map[string]context.CancelCauseFunc{}}
	t := *job.Task
	r := &taskRun{h: h, t: t, secrets: append([]string{t.Token}, job.SSH.secrets()...)}
	r.log = &logStream{secrets: r.secrets}
	if err := validateTask(t, job.Origin, time.Now()); err != nil {
		h.logf("task %s: refused: %v", clip(t.ID, 36), err)
		if tokenUsable(t) {
			r.finish(finishRequest{State: "failed", ExitCode: -1, Failure: "ssh runner refused the task: " + err.Error()})
		}
		return nil
	}
	f := r.executeSSH(ctx, job.SSH)
	if f.State == "gone" {
		h.logf("task %s: %v; stopped without a finish", t.ID, errTaskGone)
		return nil
	}
	r.finish(f)
	return nil
}

// pollCancel asks Golf every interval with an empty log chunk whether the task was cancelled; the tool may print nothing for long.
func (r *taskRun) pollCancel(stop <-chan struct{}, every time.Duration, cancelTask context.CancelCauseFunc) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		// Only while nothing is waiting to be sent: a chunk in flight answers cancel itself, and its offset is not settled yet.
		r.log.mu.Lock()
		offset, busy := r.log.offset, len(r.log.pending) > 0 && !r.log.full
		r.log.mu.Unlock()
		if busy {
			continue
		}
		_, cancel, err := r.postLog(context.Background(), offset, []string{})
		var a *apiError
		switch {
		case cancel:
			cancelTask(errCancelled)
		case err != nil && errors.As(err, &a) && a.Status == http.StatusConflict && a.NextOffset != nil:
			// Lines are in flight; the next poll asks again.
		case err != nil && isFinal(err):
			cancelTask(errTaskGone)
		}
	}
}

var cancelPollInterval = 10 * time.Second

func (r *taskRun) executeSSH(parent context.Context, target sshTarget) (result finishRequest) {
	h, t := r.h, r.t
	result = finishRequest{ExitCode: -1}
	spec := toolSpecs[t.Tool]
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
	var background sync.WaitGroup
	background.Add(2)
	go func() { defer background.Done(); r.streamLogs(stop, cancelTask) }()
	go func() { defer background.Done(); r.pollCancel(stop, cancelPollInterval, cancelTask) }()
	defer func() {
		close(stop)
		background.Wait()
		r.flushLogs()
	}()

	local, err := os.MkdirTemp("", "golf-ssh-task-")
	if err != nil {
		result.State, result.Failure = "failed", "working copy: "+err.Error()
		return
	}
	defer os.RemoveAll(local)
	dctx, dcancel := context.WithDeadlineCause(ctx, time.UnixMilli(t.Deadline), errTimedOut)
	defer dcancel()
	interrupted := func(stage string) bool {
		var state string
		switch cause := context.Cause(dctx); {
		case cause == nil:
			return false
		case errors.Is(cause, errTimedOut):
			state = "timed_out"
		case errors.Is(cause, errCancelled):
			state = "cancelled"
		case errors.Is(cause, errTaskGone):
			state = "gone"
		default:
			state = "failed"
			result.Failure = "runner stopped during " + stage
		}
		result.State = state
		r.hostLine("stopped during %s: %s", stage, state)
		return true
	}
	fail := func(stage string, err error) finishRequest {
		if interrupted(stage) {
			return result
		}
		result.State, result.Failure = "failed", stage+"_failed: "+clip(redact(err.Error(), r.secrets), 400)
		r.hostLine("%s", result.Failure)
		return result
	}

	// 1. The clone, here, with the task token.
	g := newGitRunner(local, t)
	r.hostLine("cloning %s at %s", t.Repository, t.BaseCommit[:12])
	repo, err := g.prepare(dctx)
	if err != nil {
		return fail("clone", err)
	}
	// 2. The SSH host and its working directory.
	r.hostLine("connecting to %s@%s:%d (%s)", target.User, target.Address, target.Port, target.Reach)
	client, path, err := connectSSH(dctx, target, local, true, &offeredKey{}, func(note string) { r.hostLine("%s", note) })
	if err != nil {
		return fail("connect", err)
	}
	defer path.close()
	defer client.Close()
	base := `"$HOME/.golf-agent/work"`
	if target.WorkDirectory != "" {
		base = shQuote(target.WorkDirectory)
	}
	out, code, err := remoteOutput(dctx, client, shellCommand(`set -e; umask 077; base=`+base+`; mkdir -p "$base"; d="$base/`+t.ID+`"; rm -rf "$d"; mkdir "$d"; cd "$d"; pwd`), 30*time.Second)
	remote := strings.TrimSpace(string(out))
	if err != nil || code != 0 || !remoteDirPattern.MatchString(remote) || !strings.HasSuffix(remote, "/"+t.ID) {
		if err == nil {
			err = fmt.Errorf("could not create the working directory on the host (exit %d): %s", code, clip(remote, 200))
		}
		return fail("prepare", err)
	}
	cleanup := func() {
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _, _ = remoteOutput(cctx, client, shellCommand("rm -rf "+shQuote(remote)), 30*time.Second)
	}
	defer cleanup()
	r.hostLine("sending the working copy to %s", remote)
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(writeArchive(pw, repo, "repo", map[string][]byte{"prompt.txt": []byte(t.Prompt)}))
	}()
	var upErr bytes.Buffer
	if code, err := remoteRun(dctx, client, shellCommand("cd "+shQuote(remote)+" && tar -xf -"), pr, io.Discard, &limitedBuffer{buf: &upErr, max: 4 << 10}); err != nil || code != 0 {
		pr.Close()
		if err == nil {
			err = fmt.Errorf("tar exited %d: %s", code, clip(strings.TrimSpace(upErr.String()), 200))
		}
		return fail("upload", err)
	}

	// 3. The tool, on the host.
	remoteRepo, promptFile := remote+"/repo", remote+"/prompt.txt"
	args := spec.args(toolConfig{}, "workspace-write", t.Model, remoteRepo, promptFile)
	words := []string{"exec", "env", "TERM=dumb", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0", shQuote("PWD=" + remoteRepo)}
	for _, kv := range spec.env {
		words = append(words, shQuote(kv))
	}
	words = append(words, t.Tool)
	for _, a := range args {
		words = append(words, shQuote(a))
	}
	script := "cd " + shQuote(remoteRepo) + " || exit 1; echo $$ > ../pid; { ps -o pgid= -p $$ 2>/dev/null || echo $$; } | tr -d ' ' > ../pgid; command -v " + t.Tool +
		" >/dev/null 2>&1 || { echo '" + t.Tool + " is not installed in this account' >&2; exit 127; }; " + strings.Join(words, " ") + " < ../prompt.txt"
	r.hostLine("running %s on branch %s", t.Tool, t.Branch)
	kill := func() {
		kctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _, _ = remoteOutput(kctx, client, shellCommand("cd "+shQuote(remote)+` 2>/dev/null || exit 0; g=$(cat pgid 2>/dev/null); p=$(cat pid 2>/dev/null); `+
			`[ -n "$g" ] && kill -TERM -- -"$g" 2>/dev/null; [ -n "$p" ] && kill -TERM "$p" 2>/dev/null; sleep 5; [ -n "$g" ] && kill -KILL -- -"$g" 2>/dev/null; [ -n "$p" ] && kill -KILL "$p" 2>/dev/null; true`), 20*time.Second)
	}
	outcome, err := runRemoteTool(dctx, client, shellCommand(loginScript(script)), spec.format, remoteRepo, h.t.killGrace, kill, r.log.add)
	result.ExitCode = outcome.exitCode
	result.Usage = outcome.parsed.usage
	result.Summary = outcome.parsed.final
	if result.Summary == "" {
		r.log.mu.Lock()
		result.Summary = strings.Join(r.log.tail, "\n")
		r.log.mu.Unlock()
	}
	if err != nil {
		return fail("tool", err)
	}
	if interrupted("the tool run") {
		return
	}
	if outcome.exitCode == 127 {
		result.State, result.Failure = "failed", "tool_unavailable: "+t.Tool+" is not installed for "+target.User+" on this host (or not on its login shell's PATH)"
		r.hostLine("%s", result.Failure)
		return
	}
	r.hostLine("%s exited with code %d", t.Tool, outcome.exitCode)
	toolFailed := outcome.exitCode != 0 || outcome.parsed.isError

	// 4. The working tree back, then the outbound host's commit and push.
	back := filepath.Join(local, "result")
	if err := os.Mkdir(back, 0700); err != nil {
		return fail("download", err)
	}
	dr, dw := io.Pipe()
	extracted := make(chan error, 1)
	go func() {
		err := extractArchive(dr, back)
		if err == nil {
			_, _ = io.Copy(io.Discard, dr) // tar ends with padding after its end marker
		}
		dr.CloseWithError(err)
		extracted <- err
	}()
	var downErr bytes.Buffer
	code, err = remoteRun(dctx, client, shellCommand("cd "+shQuote(remoteRepo)+" && tar -cf - --exclude=.git ."), nil, dw, &limitedBuffer{buf: &downErr, max: 4 << 10})
	dw.Close()
	if xerr := <-extracted; err == nil && xerr != nil {
		err = xerr
	}
	if err == nil && code != 0 {
		err = fmt.Errorf("tar exited %d: %s", code, clip(strings.TrimSpace(downErr.String()), 200))
	}
	if err != nil {
		return fail("download", err)
	}
	if err := replaceWorkTree(repo, back); err != nil {
		return fail("download", err)
	}
	commit, files, err := g.commit(dctx, repo)
	switch {
	case err != nil:
		return fail("commit", err)
	case commit == "" && toolFailed:
		result.State, result.Failure = "failed", fmt.Sprintf("%s failed (exit %d) without changing files", t.Tool, outcome.exitCode)
	case commit == "":
		result.State = "no_changes"
		r.hostLine("no changes")
	default:
		r.hostLine("committed %s (%d file(s)); pushing %s", commit[:12], len(files), t.Branch)
		if err := g.push(dctx, commit); err != nil {
			return fail("push", err)
		}
		result.State, result.CommitID, result.ChangedFiles = "succeeded", commit, files
		r.hostLine("pushed %s", t.Branch)
	}
	if result.Failure != "" {
		r.hostLine("%s", result.Failure)
	}
	return
}

// runRemoteTool is runTool over SSH: the same line reader and parser. When ctx ends, the remote process group gets SIGTERM
// (session signal and kill), then the session closes after grace.
func runRemoteTool(ctx context.Context, client *ssh.Client, command, format, dir string, grace time.Duration, kill func(), emit func(string)) (toolOutcome, error) {
	outcome := toolOutcome{exitCode: -1}
	session, err := client.NewSession()
	if err != nil {
		return outcome, err
	}
	defer session.Close()
	stdout, err := session.StdoutPipe()
	if err != nil {
		return outcome, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		return outcome, err
	}
	if err := session.Start(command); err != nil {
		return outcome, err
	}
	parser := newParser(format, dir)
	lines := make(chan streamLine, 256)
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); readLines(stdout, true, lines) }()
	go func() { defer readers.Done(); readLines(stderr, false, lines) }()
	go func() { readers.Wait(); close(lines) }()
	waited := make(chan error, 1)
	go func() { waited <- session.Wait() }()
	ctxDone := ctx.Done()
	var closeTimer <-chan time.Time
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
		case err := <-waited:
			waited = nil
			outcome.exitCode, _ = exitStatus(err)
			closeTimer = time.After(grace)
		case <-ctxDone:
			ctxDone = nil
			_ = session.Signal(ssh.SIGTERM)
			go kill()
			closeTimer = time.After(grace + 6*time.Second)
		case <-closeTimer:
			closeTimer = nil
			session.Close()
		}
	}
	outcome.parsed = parser.result()
	return outcome, nil
}
