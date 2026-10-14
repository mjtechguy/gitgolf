package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func gitCommand(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// fakeGolf implements the host protocol of docs/AGENT_HOSTS.md and serves one bare
// repository over Smart HTTP (git http-backend through net/http/cgi).
type fakeGolf struct {
	t          *testing.T
	srv        *httptest.Server
	root       string // GIT_PROJECT_ROOT holding repo.git
	bare       string
	base       string // baseCommit
	regToken   string
	credential string
	hostUUID   string

	mu         sync.Mutex
	queue      []*fakeTask
	claims     map[string]*fakeTask
	tasks      map[string]*fakeTask
	heartbeats [][]toolReport
	gitBadAuth int
	gitOK      int
}

type fakeTask struct {
	task          claimedTask
	started       bool
	lines         []string
	cancelOnLine  string // log responses say cancel once a stored line contains this
	goneOnLine    string // log answers 409 (finished elsewhere) once a line contains this
	cancelOnStart bool
	heartbeatStop bool // heartbeat lists the task for cancel once started
	finish        *finishRequest
	done          chan struct{}
}

func newFakeGolf(t *testing.T) *fakeGolf {
	t.Helper()
	f := &fakeGolf{t: t, root: t.TempDir(), claims: map[string]*fakeTask{}, tasks: map[string]*fakeTask{},
		regToken: "golfagentreg_" + strings.Repeat("a", 64)}
	f.hostUUID = newUUID()
	f.credential = "golf_agent_host_" + f.hostUUID + "_" + strings.Repeat("b", 64)
	src := filepath.Join(t.TempDir(), "src")
	if err := os.Mkdir(src, 0700); err != nil {
		t.Fatal(err)
	}
	gitCommand(t, src, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(src, "README.md"), []byte("# fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitCommand(t, src, "add", ".")
	gitCommand(t, src, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial")
	f.base = gitCommand(t, src, "rev-parse", "HEAD")
	f.bare = filepath.Join(f.root, "repo.git")
	gitCommand(t, f.root, "init", "-q", "--bare", f.bare)
	gitCommand(t, f.bare, "config", "http.receivepack", "true")
	gitCommand(t, src, "push", "-q", f.bare, "main")
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	backend := &cgi.Handler{Path: gitPath, Args: []string{"http-backend"}, Root: "/git",
		Env: []string{"GIT_PROJECT_ROOT=" + f.root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { f.serve(w, r, backend) }))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGolf) addTask(prompt string, deadline time.Duration, edit func(*fakeTask)) *fakeTask {
	id := newUUID()
	ft := &fakeTask{done: make(chan struct{}), task: claimedTask{
		ID: id, Repository: "owner/repo", CloneURL: f.srv.URL + "/native/agent-host/tasks/" + id + "/git",
		Branch: "golf-agent/" + id[:8], BaseRef: "refs/heads/main", BaseCommit: f.base, Tool: "claude", Prompt: prompt,
		Deadline: time.Now().Add(deadline).UnixMilli(), Token: "golf_agent_task_" + id + "_" + strings.Repeat("c", 64),
		Target: taskTarget{Kind: "issue", Number: 12, Title: "Say hello", URL: "https://golf.example.invalid/owner/repo/issues/12"},
	}}
	if edit != nil {
		edit(ft)
	}
	f.mu.Lock()
	f.queue = append(f.queue, ft)
	f.tasks[id] = ft
	f.mu.Unlock()
	return ft
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeGolf) serve(w http.ResponseWriter, r *http.Request, backend http.Handler) {
	const prefix = "/native/agent-host/"
	path := strings.TrimPrefix(r.URL.Path, prefix)
	if rest, ok := strings.CutPrefix(path, "tasks/"); ok {
		id, sub, _ := strings.Cut(rest, "/")
		f.mu.Lock()
		ft := f.tasks[id]
		f.mu.Unlock()
		if ft == nil {
			writeJSON(w, 404, map[string]string{"code": "not_found", "message": "no task"})
			return
		}
		if git, ok := strings.CutPrefix(sub, "git"); ok {
			user, pass, ok := r.BasicAuth()
			f.mu.Lock()
			denied := !ok || user != "golf" || pass != ft.task.Token || strings.Contains(git, "receive-pack") && !ft.started
			if denied {
				f.gitBadAuth++
			} else {
				f.gitOK++
			}
			f.mu.Unlock()
			if denied {
				http.Error(w, "denied", http.StatusForbidden)
				return
			}
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/git/repo.git" + git
			backend.ServeHTTP(w, r2)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+ft.task.Token {
			writeJSON(w, 401, map[string]string{"code": "bad_token", "message": "task token"})
			return
		}
		f.serveTask(w, r, ft, sub)
		return
	}
	if path == "register" {
		var in struct{ RegistrationToken, Name, HostVersion, OS, Arch string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in.RegistrationToken != f.regToken || in.Name == "" || in.HostVersion == "" || in.OS == "" {
			writeJSON(w, 401, map[string]string{"code": "bad_token", "message": "registration token"})
			return
		}
		writeJSON(w, 200, map[string]any{"hostId": "7", "uuid": f.hostUUID, "credential": f.credential}) // the Worker sends ids as strings
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+f.credential {
		writeJSON(w, 401, map[string]string{"code": "bad_credential", "message": "host credential"})
		return
	}
	switch path {
	case "heartbeat":
		var in struct {
			Tools []toolReport `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		f.heartbeats = append(f.heartbeats, in.Tools)
		cancel := []string{}
		for id, ft := range f.tasks {
			if ft.heartbeatStop && ft.started && ft.finish == nil {
				cancel = append(cancel, id)
			}
		}
		f.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "cancel": cancel, "state": "ACTIVE"})
	case "claim":
		var in struct {
			ClaimID string `json:"claimId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		if !uuidPattern.MatchString(in.ClaimID) {
			writeJSON(w, 400, map[string]string{"code": "bad_claim", "message": "claimId"})
			return
		}
		f.mu.Lock()
		ft := f.claims[in.ClaimID]
		if ft == nil && len(f.queue) > 0 {
			ft, f.queue = f.queue[0], f.queue[1:]
			f.claims[in.ClaimID] = ft
		}
		f.mu.Unlock()
		if ft == nil {
			writeJSON(w, 200, map[string]any{"task": nil})
			return
		}
		writeJSON(w, 200, map[string]any{"task": ft.task})
	default:
		writeJSON(w, 404, map[string]string{"code": "not_found", "message": path})
	}
}

func (f *fakeGolf) serveTask(w http.ResponseWriter, r *http.Request, ft *fakeTask, sub string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch sub {
	case "start":
		ft.started = true
		writeJSON(w, 200, map[string]any{"ok": true, "cancel": ft.cancelOnStart})
	case "log":
		var in struct {
			Offset int64    `json:"offset"`
			Lines  []string `json:"lines"`
		}
		body, _ := io.ReadAll(r.Body)
		if len(body) > 64<<10 || json.Unmarshal(body, &in) != nil || len(in.Lines) > 200 {
			writeJSON(w, 413, map[string]string{"code": "too_large", "message": "log chunk"})
			return
		}
		stored := int64(len(ft.lines))
		if in.Offset > stored {
			writeJSON(w, 409, map[string]any{"code": "offset", "message": "offset past stored lines", "nextOffset": stored})
			return
		}
		ft.lines = append(ft.lines, in.Lines[stored-in.Offset:]...)
		for _, l := range in.Lines {
			if ft.goneOnLine != "" && strings.Contains(l, ft.goneOnLine) {
				writeJSON(w, 409, map[string]string{"code": "finished", "message": "task already finished"})
				return
			}
		}
		cancel := false
		for _, l := range ft.lines {
			if ft.cancelOnLine != "" && strings.Contains(l, ft.cancelOnLine) {
				cancel = true
			}
		}
		writeJSON(w, 200, map[string]any{"nextOffset": len(ft.lines), "cancel": cancel})
	case "finish":
		var in finishRequest
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeJSON(w, 400, map[string]string{"code": "bad", "message": err.Error()})
			return
		}
		if ft.finish == nil {
			ft.finish = &in
			close(ft.done)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "state": strings.ToUpper(ft.finish.State)})
	default:
		writeJSON(w, 404, map[string]string{"code": "not_found", "message": sub})
	}
}

// fakeTool is put first in PATH as "claude". It reads the prompt from stdin and acts on
// the MODE= word in it, printing Claude Code stream-json.
const fakeTool = `#!/bin/sh
case "$1" in
--version) echo "9.9.9 (Fake Code)"; exit 0;;
auth) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; exit 0;;
esac
prompt=$(cat)
env > "$FAKE_DUMP.env"
pwd > "$FAKE_DUMP.pwd"
tr "\\0" "\\n" < /proc/$$/environ > "$FAKE_DUMP.initenv"
printf '%s\n' "$@" > "$FAKE_DUMP.args"
case "$prompt" in
*MODE=success*)
  echo '{"type":"system","subtype":"init","model":"fake-1"}'
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Writing HELLO.md"},{"type":"tool_use","name":"Write","input":{"file_path":"'"$PWD"'/HELLO.md"}}]}}'
  echo hello > HELLO.md
  mkdir -p docs && echo note > docs/NOTE.md
  echo "a warning on stderr" >&2
  echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Created HELLO.md and docs/NOTE.md.","total_cost_usd":0.25,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3}}'
  ;;
*MODE=selfcommit*)
  echo one > ONE.txt
  git add ONE.txt && git -c user.name=Tool -c user.email=tool@example.invalid commit -qm "tool commit"
  echo two > TWO.txt
  ;;
*MODE=nochange*)
  echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Nothing needed changing."}'
  ;;
*MODE=fail*)
  echo "boom" >&2
  exit 3
  ;;
*MODE=cancel*)
  sleep 300 &
  echo $! > "$FAKE_DUMP.child"
  echo "CANCEL_POINT"
  wait
  ;;
*MODE=silent*|*MODE=deadline*)
  sleep 300 &
  echo $! > "$FAKE_DUMP.child"
  wait
  ;;
esac
`

type harness struct {
	f     *fakeGolf
	state string
	dump  string
	out   *syncBuffer
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	f := newFakeGolf(t)
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(fakeTool), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	h := &harness{f: f, state: filepath.Join(t.TempDir(), "state"), dump: filepath.Join(t.TempDir(), "dump"), out: &syncBuffer{}}
	t.Setenv("FAKE_DUMP", h.dump)
	t.Setenv("GOLF_SOMETHING", "must-not-reach-the-tool")
	t.Setenv("GOLF_AGENT_REGISTRATION_TOKEN", f.regToken)
	var out bytes.Buffer
	if err := cmdRegister([]string{"--origin", f.srv.URL, "--name", "test host", "--state", h.state}, &out); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEAKY", "prefix "+f.credential)
	return h
}

// run starts the host with only Claude Code enabled and returns once every listed task
// has finished.
func (h *harness) run(t *testing.T, tasks ...*fakeTask) {
	t.Helper()
	file, err := loadHostFile(h.state)
	if err != nil {
		t.Fatal(err)
	}
	off := false
	cfg := config{MaxConcurrent: 2, Tools: map[string]toolConfig{"codex": {Enabled: &off}, "opencode": {Enabled: &off}, "grok": {Enabled: &off}}}
	hst, err := newHost(file, cfg, h.state, h.out)
	if err != nil {
		t.Fatal(err)
	}
	hst.t = timings{heartbeat: 200 * time.Millisecond, claim: 100 * time.Millisecond, detect: time.Hour, log: 100 * time.Millisecond,
		killGrace: time.Second, tick: 50 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- hst.run(ctx) }()
	for _, ft := range tasks {
		select {
		case <-ft.done:
		case <-time.After(60 * time.Second):
			cancel()
			t.Fatalf("task %s did not finish; host output:\n%s", ft.task.ID, h.out.String())
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func (h *harness) logText(ft *fakeTask) string {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	return strings.Join(ft.lines, "\n")
}

func TestRegisterWritesPrivateHostFile(t *testing.T) {
	h := newHarness(t)
	info, err := os.Stat(filepath.Join(h.state, "host.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("host.json mode %v err %v", info.Mode(), err)
	}
	if info, err := os.Stat(h.state); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("state dir mode %v", info.Mode())
	}
	file, err := loadHostFile(h.state)
	if err != nil || file.Credential != h.f.credential || file.HostID != 7 {
		t.Fatalf("host file %+v %v", file, err)
	}
	if os.Getenv("GOLF_AGENT_REGISTRATION_TOKEN") != "" {
		t.Fatal("registration token left in the environment")
	}
	// Group-readable host.json and state directory, and a symlinked state path, are refused.
	if err := os.Chmod(filepath.Join(h.state, "host.json"), 0640); err != nil {
		t.Fatal(err)
	}
	if _, err := loadHostFile(h.state); err == nil {
		t.Fatal("accepted a group-readable host.json")
	}
	_ = os.Chmod(filepath.Join(h.state, "host.json"), 0600)
	if err := os.Chmod(h.state, 0750); err != nil {
		t.Fatal(err)
	}
	if _, err := loadHostFile(h.state); err == nil {
		t.Fatal("accepted a group-accessible state directory")
	}
	_ = os.Chmod(h.state, 0700)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(h.state, link); err != nil {
		t.Fatal(err)
	}
	if _, err := loadHostFile(link); err == nil {
		t.Fatal("accepted a symlinked state directory")
	}
	t.Setenv("GOLF_AGENT_REGISTRATION_TOKEN", "golfagentreg_"+strings.Repeat("9", 64))
	if err := cmdRegister([]string{"--origin", h.f.srv.URL, "--name", "x", "--state", h.state}, io.Discard); err == nil {
		t.Fatal("registered with a wrong token")
	}
	t.Setenv("GOLF_AGENT_REGISTRATION_TOKEN", h.f.regToken)
	if err := cmdRegister([]string{"--origin", "http://golf.example.com", "--name", "x", "--state", h.state}, io.Discard); err == nil {
		t.Fatal("accepted plain HTTP to a non-local origin")
	}
}

func TestTaskSucceedsWithCommitPushAndScrubbedEnvironment(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("Do the thing. MODE=success", 5*time.Minute, nil)
	h.run(t, ft)
	fin := ft.finish
	if fin.State != "succeeded" || fin.ExitCode != 0 || !shaPattern.MatchString(fin.CommitID) {
		t.Fatalf("finish %+v\nlog:\n%s\nhost:\n%s", fin, h.logText(ft), h.out.String())
	}
	if fin.Summary != "Created HELLO.md and docs/NOTE.md." {
		t.Fatalf("summary %q", fin.Summary)
	}
	if strings.Join(fin.ChangedFiles, ",") != "HELLO.md,docs/NOTE.md" {
		t.Fatalf("changed files %v", fin.ChangedFiles)
	}
	if fin.Usage == nil || fin.Usage.InputTokens != 13 || fin.Usage.OutputTokens != 5 || fin.Usage.CostUSD == nil || *fin.Usage.CostUSD != 0.25 {
		t.Fatalf("usage %+v", fin.Usage)
	}
	// The branch in Golf points at the commit: one commit on baseCommit, the agent author,
	// a message naming the issue and ending with the task trailer.
	bare := h.f.bare
	if got := gitCommand(t, bare, "rev-parse", "refs/heads/"+ft.task.Branch); got != fin.CommitID {
		t.Fatalf("branch at %s, want %s", got, fin.CommitID)
	}
	if got := gitCommand(t, bare, "rev-list", "--parents", "-n", "1", fin.CommitID); got != fin.CommitID+" "+h.f.base {
		t.Fatalf("parents %s", got)
	}
	if got := gitCommand(t, bare, "log", "-1", "--format=%an <%ae>|%cn <%ce>", fin.CommitID); got != "Golf agent (claude) <agent@golf.invalid>|Golf agent (claude) <agent@golf.invalid>" {
		t.Fatalf("author %s", got)
	}
	msg := gitCommand(t, bare, "log", "-1", "--format=%B", fin.CommitID)
	if !strings.HasPrefix(msg, "Agent proposal for issue #12: Say hello") || !strings.HasSuffix(msg, "Golf-Agent-Task: "+ft.task.ID) {
		t.Fatalf("message %q", msg)
	}
	if got := gitCommand(t, bare, "show", fin.CommitID+":HELLO.md"); got != "hello" {
		t.Fatalf("HELLO.md %q", got)
	}
	// Live log: rendered tool output and stderr, the host's own steps.
	log := h.logText(ft)
	for _, want := range []string{"session started (model fake-1)", "Writing HELLO.md", "→ Write HELLO.md", "a warning on stderr", "result: success (2 turns)", "[golf-agent-host] pushed " + ft.task.Branch} {
		if !strings.Contains(log, want) {
			t.Fatalf("log lacks %q:\n%s", want, log)
		}
	}
	// The tool saw neither Golf's credential nor the task token nor host Git settings,
	// but kept the user's HOME and PATH, and ran in the task's working copy.
	env, err := os.ReadFile(h.dump + ".env")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{h.f.credential, ft.task.Token, "GOLF_", "GIT_CONFIG", "extraHeader", "Authorization"} {
		if bytes.Contains(env, []byte(bad)) {
			t.Fatalf("tool environment contains %q", bad)
		}
	}
	if !bytes.Contains(env, []byte("HOME="+os.Getenv("HOME"))) || !bytes.Contains(env, []byte("PATH=")) {
		t.Fatal("tool environment lost HOME or PATH")
	}
	pwd, _ := os.ReadFile(h.dump + ".pwd")
	if want := filepath.Join(h.state, "work", ft.task.ID, "repo"); strings.TrimSpace(string(pwd)) != want {
		t.Fatalf("tool ran in %q, want %q", pwd, want)
	}
	// The PWD the host passed at exec names the working copy too (OpenCode resolves its
	// project from $PWD; the test process's own PWD must not leak through).
	initEnv, _ := os.ReadFile(h.dump + ".initenv")
	if want := "PWD=" + strings.TrimSpace(string(pwd)); !slices.Contains(strings.Split(string(initEnv), "\n"), want) {
		t.Fatalf("tool started without %s:\n%s", want, initEnv)
	}
	args, _ := os.ReadFile(h.dump + ".args")
	if bytes.Contains(args, []byte("MODE=success")) || !bytes.Contains(args, []byte("acceptEdits")) {
		t.Fatalf("argv %q (prompt must come on stdin)", args)
	}
	// Working copy removed; nothing token-bearing left in any Git config.
	if _, err := os.Stat(filepath.Join(h.state, "work", ft.task.ID)); !os.IsNotExist(err) {
		t.Fatal("working copy not removed")
	}
	if h.f.gitBadAuth != 0 || h.f.gitOK == 0 {
		t.Fatalf("git auth: ok %d bad %d", h.f.gitOK, h.f.gitBadAuth)
	}
	if strings.Contains(h.out.String(), ft.task.Token) || strings.Contains(h.out.String(), h.f.credential) || strings.Contains(log, ft.task.Token) {
		t.Fatal("a secret reached a log")
	}
	// Heartbeats reported the fake tool with its signed-in state.
	h.f.mu.Lock()
	hb := h.f.heartbeats
	h.f.mu.Unlock()
	if len(hb) == 0 || len(hb[0]) != 1 || hb[0][0].Tool != "claude" || hb[0][0].Version != "9.9.9" || hb[0][0].SignedIn == nil || !*hb[0][0].SignedIn || hb[0][0].Account != "claude.ai (max)" {
		t.Fatalf("heartbeat tools %+v", hb)
	}
}

func TestKeepWorkLeavesWorkingCopyWithoutToken(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("MODE=success", 5*time.Minute, nil)
	file, _ := loadHostFile(h.state)
	off := false
	hst, err := newHost(file, config{MaxConcurrent: 1, KeepWork: true, Tools: map[string]toolConfig{"codex": {Enabled: &off}, "opencode": {Enabled: &off}, "grok": {Enabled: &off}}}, h.state, h.out)
	if err != nil {
		t.Fatal(err)
	}
	hst.t = timings{heartbeat: time.Second, claim: 100 * time.Millisecond, detect: time.Hour, log: 100 * time.Millisecond, killGrace: time.Second, tick: 50 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- hst.run(ctx) }()
	<-ft.done
	cancel()
	<-done
	dir := filepath.Join(h.state, "work", ft.task.ID)
	err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !info.Mode().IsRegular() {
			return err
		}
		data, _ := os.ReadFile(path)
		if bytes.Contains(data, []byte(ft.task.Token)) || bytes.Contains(data, []byte(strings.Repeat("c", 64))) {
			return fmt.Errorf("%s holds the task token", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if out := gitCommand(t, filepath.Join(dir, "repo"), "remote"); out != "" {
		t.Fatalf("working copy has remotes %q", out)
	}
}

func TestToolCommitsAreFoldedIntoOneProposal(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("MODE=selfcommit", 5*time.Minute, nil)
	h.run(t, ft)
	fin := ft.finish
	if fin.State != "succeeded" || strings.Join(fin.ChangedFiles, ",") != "ONE.txt,TWO.txt" {
		t.Fatalf("finish %+v\n%s", fin, h.logText(ft))
	}
	if got := gitCommand(t, h.f.bare, "rev-list", "--parents", "-n", "1", fin.CommitID); got != fin.CommitID+" "+h.f.base {
		t.Fatalf("parents %s", got)
	}
	// No summary from the tool: the tail of the log stands in.
	if fin.Summary == "" {
		t.Fatal("empty summary")
	}
}

func TestNoChangesAndFailure(t *testing.T) {
	h := newHarness(t)
	none := h.f.addTask("MODE=nochange", 5*time.Minute, nil)
	fail := h.f.addTask("MODE=fail", 5*time.Minute, nil)
	h.run(t, none, fail)
	if f := none.finish; f.State != "no_changes" || f.CommitID != "" || f.Summary != "Nothing needed changing." || len(f.ChangedFiles) != 0 {
		t.Fatalf("no-change finish %+v", f)
	}
	if f := fail.finish; f.State != "failed" || f.ExitCode != 3 || !strings.Contains(f.Failure, "exit 3") || !strings.Contains(f.Summary, "boom") {
		t.Fatalf("failed finish %+v", f)
	}
	for _, ft := range []*fakeTask{none, fail} {
		if out := gitCommand(t, h.f.bare, "branch", "--list", ft.task.Branch); out != "" {
			t.Fatalf("branch %s pushed without changes", ft.task.Branch)
		}
	}
}

func waitGone(t *testing.T, pidFile string) {
	t.Helper()
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("background process %d survived", pid)
}

func TestCancelFromLogKillsProcessGroup(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("MODE=cancel", 5*time.Minute, func(ft *fakeTask) { ft.cancelOnLine = "CANCEL_POINT" })
	started := time.Now()
	h.run(t, ft)
	if f := ft.finish; f.State != "cancelled" || f.CommitID != "" {
		t.Fatalf("finish %+v", f)
	}
	if time.Since(started) > 20*time.Second {
		t.Fatal("cancel was slow")
	}
	waitGone(t, h.dump+".child")
	if _, err := os.Stat(filepath.Join(h.state, "work", ft.task.ID)); !os.IsNotExist(err) {
		t.Fatal("working copy not discarded")
	}
}

func TestTaskFinishedElsewhereStopsWithoutFinish(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("MODE=cancel", 5*time.Minute, func(ft *fakeTask) { ft.goneOnLine = "CANCEL_POINT" })
	file, _ := loadHostFile(h.state)
	off := false
	hst, err := newHost(file, config{MaxConcurrent: 1, Tools: map[string]toolConfig{"codex": {Enabled: &off}, "opencode": {Enabled: &off}, "grok": {Enabled: &off}}}, h.state, h.out)
	if err != nil {
		t.Fatal(err)
	}
	hst.t = timings{heartbeat: time.Second, claim: 100 * time.Millisecond, detect: time.Hour, log: 100 * time.Millisecond, killGrace: time.Second, tick: 50 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- hst.run(ctx) }()
	for i := 0; i < 200 && !strings.Contains(h.out.String(), "stopped without a finish"); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	cancel()
	<-done
	if !strings.Contains(h.out.String(), "stopped without a finish") || ft.finish != nil {
		t.Fatalf("finish %+v\n%s", ft.finish, h.out.String())
	}
	waitGone(t, h.dump+".child")
	if _, err := os.Stat(filepath.Join(h.state, "work", ft.task.ID)); !os.IsNotExist(err) {
		t.Fatal("working copy not cleaned up")
	}
}

func TestCancelFromHeartbeatWhileToolIsSilent(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("MODE=silent", 5*time.Minute, func(ft *fakeTask) { ft.heartbeatStop = true })
	h.run(t, ft)
	if f := ft.finish; f.State != "cancelled" {
		t.Fatalf("finish %+v", f)
	}
	waitGone(t, h.dump+".child")
}

func TestCancelAtStart(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("MODE=success", 5*time.Minute, func(ft *fakeTask) { ft.cancelOnStart = true })
	h.run(t, ft)
	if f := ft.finish; f.State != "cancelled" {
		t.Fatalf("finish %+v", f)
	}
	if _, err := os.Stat(h.dump + ".env"); err == nil {
		t.Fatal("tool ran after a cancel at start")
	}
}

func TestDeadlineTimesOut(t *testing.T) {
	h := newHarness(t)
	ft := h.f.addTask("MODE=deadline", 4*time.Second, nil)
	h.run(t, ft)
	if f := ft.finish; f.State != "timed_out" || f.CommitID != "" {
		t.Fatalf("finish %+v\n%s", f, h.logText(ft))
	}
	waitGone(t, h.dump+".child")
}

func TestRefusedTasks(t *testing.T) {
	h := newHarness(t)
	wrongURL := h.f.addTask("MODE=success", 5*time.Minute, func(ft *fakeTask) { ft.task.CloneURL = "https://elsewhere.example/x.git" })
	badModel := h.f.addTask("MODE=success", 5*time.Minute, func(ft *fakeTask) { ft.task.Model = "--dangerously-skip-permissions" })
	disabled := h.f.addTask("MODE=success", 5*time.Minute, func(ft *fakeTask) { ft.task.Tool = "grok" })
	h.run(t, wrongURL, badModel, disabled)
	for _, ft := range []*fakeTask{wrongURL, badModel} {
		if ft.finish.State != "failed" || !strings.Contains(ft.finish.Failure, "host refused the task") || ft.started {
			t.Fatalf("finish %+v started %v", ft.finish, ft.started)
		}
	}
	if disabled.finish.State != "failed" || !strings.Contains(disabled.finish.Failure, "tool_unavailable") {
		t.Fatalf("finish %+v", disabled.finish)
	}
	if _, err := os.Stat(h.dump + ".env"); err == nil {
		t.Fatal("a refused task ran the tool")
	}
}

func TestLogStreamChunksResyncsAndTruncates(t *testing.T) {
	secret := "golf_agent_task_secret"
	l := &logStream{secrets: []string{secret}}
	for i := 0; i < 450; i++ {
		l.add(fmt.Sprintf("line %d \x1b[31mred\x1b[0m %s", i, secret))
	}
	l.add(strings.Repeat("x", 10000))
	var stored []string
	post := func(_ context.Context, offset int64, lines []string) (int64, bool, error) {
		if len(lines) > maxChunkLines {
			t.Fatalf("chunk of %d lines", len(lines))
		}
		data, _ := json.Marshal(map[string]any{"offset": offset, "lines": lines})
		if len(data) > 64<<10 {
			t.Fatalf("chunk of %d bytes", len(data))
		}
		if offset > int64(len(stored)) {
			n := int64(len(stored))
			return 0, false, &apiError{Status: 409, NextOffset: &n}
		}
		stored = append(stored[:offset], lines...)
		return int64(len(stored)), len(stored) > 400, nil
	}
	cancelled := false
	for !l.empty() {
		c, err := l.send(context.Background(), post)
		if err != nil {
			t.Fatal(err)
		}
		cancelled = cancelled || c
	}
	if len(stored) != 451 || !cancelled {
		t.Fatalf("stored %d cancelled %v", len(stored), cancelled)
	}
	if stored[0] != "line 0 red [redacted]" || len(stored[450]) > maxLogLine+40 {
		t.Fatalf("sanitized %q / %d", stored[0], len(stored[450]))
	}
	// Golf lost the last 10 lines: a 409 resyncs and the host continues from its count.
	stored = stored[:441]
	l.add("after resync")
	if _, err := l.send(context.Background(), post); err != nil {
		t.Fatal(err)
	}
	if _, err := l.send(context.Background(), post); err != nil {
		t.Fatal(err)
	}
	if len(stored) != 442 || stored[441] != "after resync" {
		t.Fatalf("after resync: %d %q", len(stored), stored[len(stored)-1])
	}
	// Golf stores fewer lines than sent (log full): later lines are dropped locally.
	full := &logStream{}
	full.add("a")
	full.add("b")
	_, _ = full.send(context.Background(), func(context.Context, int64, []string) (int64, bool, error) { return 1, false, nil })
	full.add("c")
	if !full.empty() || !full.full {
		t.Fatal("log kept growing after Golf stopped storing lines")
	}
}

func TestParsersReadRealOutputShapes(t *testing.T) {
	dir := "/w/repo"
	codex := newParser("codex", dir)
	for _, line := range []string{
		`{"type":"thread.started","thread_id":"x"}`,
		`{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls -la","status":"in_progress"}}`,
		`{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls -la","exit_code":0,"status":"completed"}}`,
		`{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"/w/repo/HELLO.md","kind":"add"}],"status":"completed"}}`,
		`{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Created HELLO.md."}}`,
		`{"type":"turn.completed","usage":{"input_tokens":47025,"cached_input_tokens":40064,"output_tokens":349,"reasoning_output_tokens":208}}`,
	} {
		codex.render([]byte(line))
	}
	if r := codex.result(); r.final != "Created HELLO.md." || r.usage.InputTokens != 47025 || r.usage.OutputTokens != 349 || r.usage.CostUSD != nil {
		t.Fatalf("codex %+v %+v", r, r.usage)
	}
	if got := codex.render([]byte(`{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"/w/repo/a/b.go","kind":"update"}],"status":"completed"}}`)); len(got) != 1 || got[0] != "changed a/b.go (update, completed)" {
		t.Fatalf("codex render %q", got)
	}
	oc := newParser("opencode", dir)
	for _, line := range []string{
		`{"type":"text","part":{"type":"text","text":"Creating HELLO.md."}}`,
		`{"type":"tool_use","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"content":"hello\n","filePath":"/w/repo/HELLO.md"},"title":"HELLO.md"}}}`,
		`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":12233,"input":11645,"output":90,"reasoning":498,"cache":{"write":0,"read":0}},"cost":0.0012821}}`,
		`{"type":"text","part":{"type":"text","text":"Done."}}`,
		`{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":12279,"input":113,"output":12,"reasoning":9,"cache":{"write":0,"read":12145}},"cost":0.00003979}}`,
	} {
		oc.render([]byte(line))
	}
	if r := oc.result(); r.final != "Done." || r.usage.InputTokens != 11645+113+12145 || r.usage.OutputTokens != 90+498+12+9 || r.usage.CostUSD == nil {
		t.Fatalf("opencode %+v %+v", r, r.usage)
	}
	// Grok streaming-messages-json: a cancelled write ends in an error result with exit 0.
	grok := newParser("claude", dir)
	grok.render([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c","content":"User cancelled the execution for tool write","is_error":true}]}}`))
	grok.render([]byte(`{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"stop_reason":"cancelled","total_cost_usd":0.011,"usage":{"input_tokens":15752,"output_tokens":92,"cache_read_input_tokens":2304,"cache_creation_input_tokens":0},"errors":["cancelled"]}`))
	if r := grok.result(); !r.isError || r.usage.InputTokens != 15752+2304 {
		t.Fatalf("grok %+v", r)
	}
	if got := newParser("claude", dir).render([]byte("plain text line")); len(got) != 1 || got[0] != "plain text line" {
		t.Fatalf("plain %q", got)
	}
}

func TestStatusParsers(t *testing.T) {
	signed := func(b *bool) string {
		if b == nil {
			return "null"
		}
		return strconv.FormatBool(*b)
	}
	cases := []struct {
		tool, out string
		code      int
		want      string
		account   string
	}{
		{"codex", "Logged in using ChatGPT\n", 0, "true", "ChatGPT"},
		{"codex", "Logged in using an API key - sk-proj-***ABCD\n", 0, "true", "API key"},
		{"codex", "Not logged in\n", 1, "false", ""},
		{"codex", "error: something\n", 2, "null", ""},
		{"claude", `{"loggedIn": true, "authMethod": "claude.ai", "email": "x@example.com", "subscriptionType": "max"}`, 0, "true", "claude.ai (max)"},
		{"claude", `{"loggedIn": false, "authMethod": "none"}`, 1, "false", ""},
		{"claude", `not json`, 1, "null", ""},
		{"opencode", "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \x1b[90moauth\n│\n└  4 credentials\n", 0, "true", ""},
		{"opencode", "┌  Credentials\n│\n└  0 credentials\n", 0, "null", ""},
	}
	for _, c := range cases {
		got, account := toolSpecs[c.tool].status([]byte(c.out), c.code)
		if signed(got) != c.want || account != c.account {
			t.Errorf("%s %q: got %s %q, want %s %q", c.tool, c.out, signed(got), account, c.want, c.account)
		}
	}
	if toolSpecs["grok"].status != nil {
		t.Error("grok has no status command; signed-in must stay unknown")
	}
}

func TestDetectToolsReportsVersionsAndRefusesBrokenCodexSandbox(t *testing.T) {
	bin := t.TempDir()
	scripts := map[string]string{
		"codex":  "#!/bin/sh\ncase \"$1\" in --version) echo 'codex-cli 0.162.1';; sandbox) echo 'bwrap: setting up uid map: Permission denied' >&2; exit 1;; login) echo 'Logged in using ChatGPT' >&2;; esac\n",
		"grok":   "#!/bin/sh\necho 'grok 1.0.46 (2765805b9442) [stable]'\n",
		"claude": "#!/bin/sh\nexit 1\n",
	}
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	var notes []string
	reports := detectTools(context.Background(), config{}, os.Environ(), bin, func(s string) { notes = append(notes, s) })
	if len(reports) != 1 || reports[0].Tool != "grok" || reports[0].Version != "1.0.46" || reports[0].SignedIn != nil {
		t.Fatalf("reports %+v", reports)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "workspace-write sandbox unavailable") {
		t.Fatalf("notes %q", notes)
	}
	cfg, err := loadConfig(writeConfig(t, `{"tools":{"codex":{"sandbox":"danger-full-access"},"grok":{"enabled":false}}}`))
	if err != nil {
		t.Fatal(err)
	}
	reports = detectTools(context.Background(), cfg, os.Environ(), bin, func(string) {})
	if len(reports) != 1 || reports[0].Tool != "codex" || reports[0].Version != "0.162.1" || reports[0].Account != "ChatGPT" {
		t.Fatalf("reports %+v", reports)
	}
	if args := toolSpecs["codex"].args(cfg.tool("codex"), cfg.codexSandbox(), "gpt-x", "/w", ""); strings.Join(args, " ") != "exec --json --color never --sandbox danger-full-access --ephemeral --model gpt-x -- -" {
		t.Fatalf("codex argv %q", args)
	}
}

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestConfigValidation(t *testing.T) {
	for _, bad := range []string{
		`{"maxConcurrent":9}`, `{"workRoot":"relative"}`, `{"tools":{"cursor":{}}}`, `{"tools":{"claude":{"sandbox":"danger-full-access"}}}`,
		`{"tools":{"claude":{"models":["-x"]}}}`, `{"tools":{"claude":{"extraArgs":["--"]}}}`, `{"unknown":1}`,
	} {
		if _, err := loadConfig(writeConfig(t, bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	p := writeConfig(t, `{}`)
	if err := os.Chmod(p, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(p); err == nil {
		t.Error("accepted a world-writable config file")
	}
	c, err := loadConfig("")
	if err != nil || c.MaxConcurrent != 1 || !c.enabled("grok") || c.codexSandbox() != "workspace-write" {
		t.Fatalf("defaults %+v %v", c, err)
	}
}

func TestValidateTask(t *testing.T) {
	id := newUUID()
	origin := "https://golf.example.invalid"
	good := claimedTask{ID: id, CloneURL: origin + "/native/agent-host/tasks/" + id + "/git", Branch: "golf-agent/" + id[:8],
		BaseRef: "refs/heads/main", BaseCommit: strings.Repeat("a", 40), Tool: "codex", Prompt: "p",
		Deadline: time.Now().Add(time.Hour).UnixMilli(), Token: "golf_agent_task_" + id + "_" + strings.Repeat("d", 64),
		Target: taskTarget{Kind: "pull_request", Number: 3}}
	if err := validateTask(good, origin, time.Now()); err != nil {
		t.Fatal(err)
	}
	for name, edit := range map[string]func(*claimedTask){
		"token for another task": func(c *claimedTask) { c.Token = "golf_agent_task_" + newUUID() + "_" + strings.Repeat("d", 64) },
		"branch":                 func(c *claimedTask) { c.Branch = "main" },
		"base ref traversal":     func(c *claimedTask) { c.BaseRef = "refs/heads/../x" },
		"tag base":               func(c *claimedTask) { c.BaseRef = "refs/tags/v1" },
		"short commit":           func(c *claimedTask) { c.BaseCommit = "abc" },
		"tool":                   func(c *claimedTask) { c.Tool = "sh" },
		"model flag":             func(c *claimedTask) { c.Model = "--yolo" },
		"past deadline":          func(c *claimedTask) { c.Deadline = time.Now().Add(-time.Second).UnixMilli() },
		"far deadline":           func(c *claimedTask) { c.Deadline = time.Now().Add(5 * time.Hour).UnixMilli() },
		"clone elsewhere":        func(c *claimedTask) { c.CloneURL = "https://evil.example/native/agent-host/tasks/" + id + "/git" },
		"target":                 func(c *claimedTask) { c.Target.Kind = "commit" },
	} {
		c := good
		edit(&c)
		if validateTask(c, origin, time.Now()) == nil {
			t.Errorf("accepted %s", name)
		}
	}
}

func TestToolEnvironmentScrubs(t *testing.T) {
	env := toolEnvironment([]string{"HOME=/home/u", "PATH=/bin", "GOLF_AGENT_REGISTRATION_TOKEN=x", "GIT_DIR=/x", "OPENAI_API_KEY=user-own", "X=has SECRET inside", "TERM=xterm", "PWD=/elsewhere", "OLDPWD=/x"}, []string{"SECRET"}, "EXTRA=1")
	got := strings.Join(env, " ")
	if got != "HOME=/home/u PATH=/bin OPENAI_API_KEY=user-own TERM=dumb NO_COLOR=1 GIT_TERMINAL_PROMPT=0 EXTRA=1" {
		t.Fatalf("env %q", got)
	}
}

func TestToolArgvTable(t *testing.T) {
	want := map[string]string{
		"codex":    "exec --json --color never --sandbox workspace-write --ephemeral -- -",
		"claude":   "-p --output-format stream-json --verbose --permission-mode acceptEdits --permission-prompts none --setting-sources user --no-session-persistence",
		"opencode": "run --format json --dir /w",
		"grok":     "--output-format streaming-messages-json --permission-mode acceptEdits --allow Write(./**) --allow Edit(./**) --verbatim --prompt-file /p",
	}
	for name, w := range want {
		if got := strings.Join(toolSpecs[name].args(toolConfig{}, "workspace-write", "", "/w", "/p"), " "); got != w {
			t.Errorf("%s: %q", name, got)
		}
	}
	got := strings.Join(toolSpecs["claude"].args(toolConfig{ExtraArgs: []string{"--effort", "low"}}, "", "sonnet", "/w", ""), " ")
	if !strings.HasSuffix(got, "--model sonnet --effort low") {
		t.Errorf("claude with model: %q", got)
	}
}
