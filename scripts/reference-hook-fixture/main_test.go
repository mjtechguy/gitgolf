package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const oldID = "1111111111111111111111111111111111111111"
const newID = "2222222222222222222222222222222222222222"
const receiver = "/var/lib/gitea/git/repositories/golf-hook-0123456789-owner/native-hook.git"

func TestTransactionRecords(t *testing.T) {
	good := oldID + " " + newID + " refs/heads/main\n"
	for name, input := range map[string]string{
		"ordinary": good,
		"symbolic": "ref:refs/heads/main ref:refs/heads/allowed HEAD\n",
		"sha256":   strings.Repeat("a", 64) + " " + strings.Repeat("b", 64) + " refs/heads/topic/nested\n",
	} {
		t.Run(name, func(t *testing.T) {
			rows, err := parseUpdates(strings.NewReader(input))
			if err != nil || len(rows) != 1 {
				t.Fatal("valid independently specified frame refused")
			}
		})
	}
	for name, input := range map[string]string{
		"extra field": strings.TrimSuffix(good, "\n") + " extra\n", "extra separator": oldID + "  " + newID + " refs/heads/main\n",
		"control": oldID + " " + newID + " refs/heads/a\r\n", "missing final LF": strings.TrimSuffix(good, "\n"),
		"duplicate": good + good, "mixed object formats": oldID + " " + strings.Repeat("b", 64) + " refs/heads/main\n",
		"path escape": oldID + " " + newID + " refs/heads/../main\n", "empty": "", "oversize": strings.Repeat("x", maxInput+1),
		"too many": func() string {
			var b strings.Builder
			for i := 0; i < maxRows+1; i++ {
				b.WriteString(oldID + " " + newID + " refs/heads/r" + strings.Repeat("a", i+1) + "\n")
			}
			return b.String()
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseUpdates(strings.NewReader(input)); err == nil {
				t.Fatal("malformed frame admitted")
			}
		})
	}
}

func hookDeps(directory string, records *[]event) dependencies {
	return dependencies{
		Inspect: func(context.Context) (gitObservation, error) {
			return gitObservation{directory, "git version 2.54.0", bundlePath}, nil
		},
		Record:   func(e event) error { *records = append(*records, e); return nil },
		Delegate: func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) int { return 0 },
	}
}

func TestPreparedMarkerAndTemporaryCloneSeparation(t *testing.T) {
	// Neither native internal-flag nor user environment is an admission bypass.
	t.Setenv("GITEA_INTERNAL_PUSH", "true")
	t.Setenv("GITEA_PUSHER_ID", "1")
	c := configuration{receiver, "refs/heads/main"}
	frame := oldID + " " + newID + " refs/heads/main\n"
	for _, tc := range []struct {
		directory, state string
		want             int
		decision         string
	}{
		{receiver, "preparing", 0, "observe"}, {receiver, "prepared", 1, "reject_marker"},
		{receiver, "committed", 0, "observe"}, {receiver, "aborted", 0, "observe"},
		{"/var/lib/gitea/data/tmp/local-repo/upload.git-fixture/.git", "prepared", 0, "observe"},
		{receiver + "-replacement", "prepared", 1, "refuse_context"},
		{"/tmp/untrusted/.git", "prepared", 1, "refuse_context"},
	} {
		var records []event
		got := runHook(context.Background(), c, "reference-transaction", []string{tc.state}, strings.NewReader(frame), io.Discard, io.Discard, hookDeps(tc.directory, &records))
		if got != tc.want || len(records) != 1 || records[0].Decision != tc.decision {
			t.Fatalf("state/context gate failed: %s %s", tc.state, tc.decision)
		}
	}
	var records []event
	if got := runHook(context.Background(), c, "reference-transaction", []string{"prepared"}, strings.NewReader(oldID+" "+newID+" refs/heads/allowed\n"), io.Discard, io.Discard, hookDeps(receiver, &records)); got != 0 {
		t.Fatal("unrelated owned branch denied")
	}
	// Zero old is also rejected after activation; the fixture seeds before hooks.
	records = nil
	if got := runHook(context.Background(), c, "reference-transaction", []string{"prepared"}, strings.NewReader(strings.Repeat("0", 40)+" "+newID+" refs/heads/main\n"), io.Discard, io.Discard, hookDeps(receiver, &records)); got != 1 {
		t.Fatal("zero-old marker bypass")
	}
}

func TestReceiveDelegateTransparencyAndFailClosed(t *testing.T) {
	c := configuration{receiver, "refs/heads/main"}
	for _, hook := range []string{"pre-receive", "post-receive", "proc-receive", "update"} {
		t.Run(hook, func(t *testing.T) {
			var records []event
			d := hookDeps(receiver, &records)
			args := []string{}
			if hook == "update" {
				args = []string{"refs/heads/allowed", oldID, newID}
			}
			payload := []byte("0010version=1\x00\n0000\xff\x00")
			var out, stderr bytes.Buffer
			d.Delegate = func(_ context.Context, path string, gotArgs []string, in io.Reader, stdout, errout io.Writer) int {
				if path != receiver+"/hooks/"+hook || strings.Join(gotArgs, "|") != strings.Join(args, "|") {
					t.Fatal("delegate identity/arguments changed")
				}
				raw, _ := io.ReadAll(in)
				if !bytes.Equal(raw, payload) {
					t.Fatal("binary protocol modified")
				}
				stdout.Write([]byte("native protocol"))
				errout.Write([]byte("native stderr"))
				return 17
			}
			got := runHook(context.Background(), c, hook, args, bytes.NewReader(payload), &out, &stderr, d)
			if got != 17 || out.String() != "native protocol" || stderr.String() != "native stderr" || len(records) != 2 || records[1].DelegateExit == nil || *records[1].DelegateExit != 17 {
				t.Fatal("native exit/stream not preserved")
			}
			for _, dir := range []string{"/tmp/untrusted", "/var/lib/gitea/data/tmp/local-repo/upload.git-x/.git"} {
				records = nil
				d.Inspect = hookDeps(dir, &records).Inspect
				d.Delegate = func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) int {
					t.Fatal("temp/missing receiver delegated")
					return 0
				}
				if runHook(context.Background(), c, hook, args, bytes.NewReader(payload), io.Discard, io.Discard, d) != 125 {
					t.Fatal("unknown receiver not refused")
				}
			}
		})
	}
	if nativeDelegate(context.Background(), filepath.Join(t.TempDir(), "missing"), nil, strings.NewReader(""), io.Discard, io.Discard) != 125 {
		t.Fatal("missing native delegate skipped")
	}
	var records []event
	d := hookDeps(receiver, &records)
	d.Record = func(event) error { return errors.New("fixture full") }
	d.Delegate = func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) int {
		t.Fatal("delegate ran after telemetry failed")
		return 0
	}
	if runHook(context.Background(), c, "pre-receive", nil, strings.NewReader(""), io.Discard, io.Discard, d) != 125 {
		t.Fatal("telemetry failure admitted")
	}
}

func TestConcurrentTelemetryBoundAndSequence(t *testing.T) {
	dir := t.TempDir()
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- appendEvent(dir, event{Version: 1, Hook: "reference-transaction", Context: "owned_receiver", Decision: "observe"})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	files, _ := os.ReadDir(dir)
	seen := map[int]bool{}
	for _, file := range files {
		if file.Name() == "lock" {
			continue
		}
		info, _ := file.Info()
		if info.Mode().Perm() != 0600 {
			t.Fatal("telemetry permissions")
		}
		data, _ := os.ReadFile(filepath.Join(dir, file.Name()))
		var e event
		if json.Unmarshal(data, &e) != nil || e.Sequence < 1 || e.Sequence > 32 || seen[e.Sequence] {
			t.Fatal("sequence not unique contiguous")
		}
		seen[e.Sequence] = true
	}
	if len(seen) != 32 {
		t.Fatal("telemetry count")
	}
	if err := os.WriteFile(filepath.Join(dir, "full.json"), make([]byte, 512<<10), 0600); err != nil {
		t.Fatal(err)
	}
	if appendEvent(dir, event{Version: 1}) == nil {
		t.Fatal("aggregate telemetry bound bypass")
	}
}

func TestActualDelegateStreamsExitAndSafeFileShape(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "native-delegate")
	// This is a local test executable, never a provider hook or repository file.
	if err := os.WriteFile(path, []byte("#!/bin/sh\ncat\nprintf '%s' \"$1\"\nprintf 'synthetic-native-stderr' >&2\nexit 19\n"), 0755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("0000\x00\xff\n")
	var out, stderr bytes.Buffer
	code := nativeDelegate(context.Background(), path, []string{"fixed-argument"}, bytes.NewReader(payload), &out, &stderr)
	if code != 19 || !bytes.Equal(out.Bytes(), append(append([]byte{}, payload...), []byte("fixed-argument")...)) || stderr.String() != "synthetic-native-stderr" {
		t.Fatal("real process delegate protocol/exit changed")
	}
	link := filepath.Join(dir, "symlink")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if nativeDelegate(context.Background(), link, nil, bytes.NewReader(payload), io.Discard, io.Discard) != 125 {
		t.Fatal("symlink native delegate accepted")
	}
	for _, mode := range []os.FileMode{0644, 0777} {
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		if nativeDelegate(context.Background(), path, nil, bytes.NewReader(payload), io.Discard, io.Discard) != 125 {
			t.Fatal("unsafe delegate mode accepted")
		}
	}
}

func TestDescriptorAndRefControls(t *testing.T) {
	file := filepath.Join(t.TempDir(), "fixture.json")
	for _, data := range []string{`{"receiver":"` + receiver + `","deniedRef":"refs/heads/main"}`, `{"receiver":"/tmp/replacement","deniedRef":"refs/heads/main"}`, `{"receiver":"` + receiver + `","deniedRef":"refs/heads/main","bypass":true}`} {
		if err := os.WriteFile(file, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := loadConfiguration(file)
		if strings.Contains(data, "replacement") || strings.Contains(data, "bypass") {
			if err == nil {
				t.Fatal("unscoped configuration accepted")
			}
		} else if err != nil {
			t.Fatal(err)
		}
	}
	for _, ref := range []string{"refs/heads/a.lock", "refs/heads/a..b", "refs/heads/a b", "refs/heads/a\\b", "refs/heads/a\t", "refs/heads/.hidden", "refs/heads/a@{b"} {
		if validRef(ref) {
			t.Fatal("unsafe ref admitted")
		}
	}
}
