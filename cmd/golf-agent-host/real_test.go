package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestRealTools runs each installed CLI once through the whole host flow (claim, clone,
// headless run, commit, push, finish) against the fake Golf server and a throwaway
// repository. It uses the machine owner's own subscriptions, so it runs only when
// GOLF_AGENT_HOST_REAL_TOOLS lists tools, e.g. GOLF_AGENT_HOST_REAL_TOOLS=codex,claude,opencode,grok.
// The host configuration is the default one (Codex keeps its workspace-write sandbox).
func TestRealTools(t *testing.T) {
	list := os.Getenv("GOLF_AGENT_HOST_REAL_TOOLS")
	if list == "" {
		t.Skip("set GOLF_AGENT_HOST_REAL_TOOLS=codex,claude,opencode,grok to run the real CLIs")
	}
	const prompt = "Create a file named HELLO.md containing the word hello. Do not do anything else."
	for _, tool := range strings.Split(list, ",") {
		tool = strings.TrimSpace(tool)
		t.Run(tool, func(t *testing.T) {
			if toolSpecs[tool] == nil {
				t.Fatalf("unknown tool %q", tool)
			}
			f := newFakeGolf(t)
			state := filepath.Join(t.TempDir(), "state")
			t.Setenv("GOLF_AGENT_REGISTRATION_TOKEN", f.regToken)
			if err := cmdRegister([]string{"--origin", f.srv.URL, "--name", "real " + tool, "--state", state}, os.Stderr); err != nil {
				t.Fatal(err)
			}
			file, err := loadHostFile(state)
			if err != nil {
				t.Fatal(err)
			}
			cfg := config{MaxConcurrent: 1, Tools: map[string]toolConfig{}}
			off := false
			for _, other := range toolOrder {
				if other != tool {
					cfg.Tools[other] = toolConfig{Enabled: &off}
				}
			}
			out := &syncBuffer{}
			hst, err := newHost(file, cfg, state, out)
			if err != nil {
				t.Fatal(err)
			}
			hst.t.claim, hst.t.tick = 200*time.Millisecond, 100*time.Millisecond
			ft := f.addTask(prompt, 10*time.Minute, func(ft *fakeTask) { ft.task.Tool = tool })
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			began := time.Now()
			go func() { done <- hst.run(ctx) }()
			select {
			case <-ft.done:
			case <-time.After(11 * time.Minute):
				cancel()
				t.Fatalf("no finish; host output:\n%s", out.String())
			}
			cancel()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			logLines := slices.Clone(ft.lines)
			reports := slices.Clone(f.heartbeats[0])
			f.mu.Unlock()
			fin := ft.finish
			t.Logf("heartbeat tools: %+v", reports)
			for _, r := range reports {
				if r.SignedIn != nil {
					t.Logf("%s %s signedIn=%v account=%q", r.Tool, r.Version, *r.SignedIn, r.Account)
				} else {
					t.Logf("%s %s signedIn=unknown", r.Tool, r.Version)
				}
			}
			t.Logf("finish after %s: state=%s exit=%d commit=%s files=%v failure=%q", time.Since(began).Round(time.Second), fin.State, fin.ExitCode, fin.CommitID, fin.ChangedFiles, fin.Failure)
			t.Logf("summary: %q", fin.Summary)
			if fin.Usage != nil {
				cost := "not reported"
				if fin.Usage.CostUSD != nil {
					cost = strconv.FormatFloat(*fin.Usage.CostUSD, 'f', -1, 64)
				}
				t.Logf("usage: in=%d out=%d cost=%s", fin.Usage.InputTokens, fin.Usage.OutputTokens, cost)
			}
			t.Logf("log (%d lines):\n%s", len(logLines), strings.Join(logLines, "\n"))
			if strings.Contains(fin.Failure, "tool_unavailable") {
				t.Skipf("%s is not usable on this host: %s\nhost output:\n%s", tool, fin.Failure, out.String())
			}
			if fin.State != "succeeded" || !slices.Contains(fin.ChangedFiles, "HELLO.md") {
				t.Fatalf("%s did not produce HELLO.md\nhost output:\n%s", tool, out.String())
			}
			if got := gitCommand(t, f.bare, "show", fin.CommitID+":HELLO.md"); !strings.Contains(strings.ToLower(got), "hello") {
				t.Fatalf("HELLO.md holds %q", got)
			}
		})
	}
}
