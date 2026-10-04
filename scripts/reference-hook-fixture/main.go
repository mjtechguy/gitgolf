// This operator-owned qualification fixture is not a Golf policy service.
// It never edits provider repository files. Native delegates retain their exact
// protocol streams; only reference-transaction records are inspected.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	bundlePath    = "/opt/golf-hook-fixture"
	telemetryPath = "/run/golf-hook-telemetry"
	maxInput      = 64 << 10
	maxRows       = 64
	maxEvents     = 512
)

type configuration struct {
	Receiver  string `json:"receiver"`
	DeniedRef string `json:"deniedRef"`
}

type gitObservation struct {
	Directory string
	Version   string
	HooksPath string
}

type update struct {
	Old string `json:"old"`
	New string `json:"new"`
	Ref string `json:"ref"`
}

type event struct {
	Version           int      `json:"version"`
	Sequence          int      `json:"sequence"`
	Hook              string   `json:"hook"`
	State             string   `json:"state,omitempty"`
	Context           string   `json:"context"`
	GitVersion        string   `json:"gitVersion"`
	HooksPathVerified bool     `json:"hooksPathVerified"`
	Decision          string   `json:"decision"`
	Updates           []update `json:"updates,omitempty"`
	DelegateExit      *int     `json:"delegateExit,omitempty"`
}

var receiverPattern = regexp.MustCompile(`^/var/lib/gitea/git/repositories/golf-hook-[0-9a-f]{10}-owner/native-hook\.git$`)
var oidPattern = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

func loadConfiguration(path string) (configuration, error) {
	var c configuration
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 4096 {
		return c, errors.New("configuration")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || d.Decode(new(any)) != io.EOF || !receiverPattern.MatchString(c.Receiver) || c.DeniedRef != "refs/heads/main" {
		return c, errors.New("configuration")
	}
	return c, nil
}

// Full OIDs and symbolic values are valid in Git 2.54 reference transactions.
// This is syntax validation, not authentication of native actor environment.
func validRef(s string) bool {
	if s == "HEAD" {
		return true
	}
	if len(s) > 512 || !strings.HasPrefix(s, "refs/") || strings.HasSuffix(s, "/") || strings.HasSuffix(s, ".") || strings.Contains(s, "..") || strings.Contains(s, "@{") || strings.Contains(s, "//") {
		return false
	}
	for _, part := range strings.Split(s, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	for _, r := range s {
		if r < 33 || r > 126 || strings.ContainsRune(`~^:?*[\`, r) {
			return false
		}
	}
	return true
}

func validValue(s string) bool {
	return oidPattern.MatchString(s) || strings.HasPrefix(s, "ref:") && validRef(strings.TrimPrefix(s, "ref:"))
}

func parseUpdates(r io.Reader) ([]update, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxInput+1))
	if err != nil || len(data) > maxInput || len(data) == 0 || data[len(data)-1] != '\n' {
		return nil, errors.New("records")
	}
	lines := strings.Split(string(data[:len(data)-1]), "\n")
	if len(lines) > maxRows {
		return nil, errors.New("records")
	}
	rows := make([]update, 0, len(lines))
	seen := make(map[string]bool)
	width := 0
	for _, line := range lines {
		parts := strings.Split(line, " ")
		if len(parts) != 3 || !validValue(parts[0]) || !validValue(parts[1]) || !validRef(parts[2]) || seen[parts[2]] {
			return nil, errors.New("records")
		}
		for _, value := range parts[:2] {
			if oidPattern.MatchString(value) {
				if width != 0 && width != len(value) {
					return nil, errors.New("records")
				}
				width = len(value)
			}
		}
		seen[parts[2]] = true
		rows = append(rows, update{parts[0], parts[1], parts[2]})
	}
	return rows, nil
}

// Metadata commands are read-only and use the current Git context. Their error
// output is never exposed. HOME/GIT_* are not used to decide actor authority.
func inspectGit(ctx context.Context) (gitObservation, error) {
	read := func(args ...string) (string, error) {
		var out limitedBuffer
		cmd := exec.CommandContext(ctx, "/usr/bin/git", args...)
		cmd.Stdout = &out
		cmd.Stderr = io.Discard
		if err := cmd.Run(); err != nil || out.exceeded {
			return "", errors.New("git_metadata")
		}
		return strings.TrimSuffix(out.String(), "\n"), nil
	}
	directory, err := read("rev-parse", "--absolute-git-dir")
	if err != nil {
		return gitObservation{}, err
	}
	version, err := read("--version")
	if err != nil {
		return gitObservation{}, err
	}
	hooks, err := read("config", "--get", "core.hooksPath")
	if err != nil {
		return gitObservation{}, err
	}
	real, err := filepath.EvalSymlinks(directory)
	if err != nil || !filepath.IsAbs(real) || filepath.Clean(real) != directory || version != "git version 2.54.0" || hooks != bundlePath {
		return gitObservation{}, errors.New("git_metadata")
	}
	return gitObservation{real, version, hooks}, nil
}

type limitedBuffer struct {
	bytes.Buffer
	exceeded bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 4096 {
		b.exceeded = true
		return 0, errors.New("output_bound")
	}
	return b.Buffer.Write(p)
}

func classify(c configuration, directory string) string {
	if directory == c.Receiver {
		return "owned_receiver"
	}
	// This is a fresh operator-owned instance path classification only. It does
	// not authenticate a production temporary clone or bypass receiver policy.
	if strings.HasPrefix(directory, "/var/lib/gitea/data/tmp/local-repo/") {
		return "temporary_clone"
	}
	return "unclassified"
}

func appendEvent(directory string, value event) error {
	// A separate fixed tmpfs holds bounded metadata. Native repository files are
	// neither created nor rewritten. Shared flock makes the bound concurrency-safe.
	lock, err := os.OpenFile(filepath.Join(directory, "lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) >= maxEvents+1 {
		return errors.New("telemetry_bound")
	}
	value.Sequence = len(entries)
	data, err := json.Marshal(value)
	if err != nil || len(data) > 16<<10 {
		return errors.New("telemetry_bound")
	}
	total := len(data) + 1
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("telemetry_bound")
		}
		total += int(info.Size())
	}
	if total > 512<<10 {
		return errors.New("telemetry_bound")
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(directory, hex.EncodeToString(nonce[:])+".json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(append(data, '\n'))
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

type dependencies struct {
	Inspect  func(context.Context) (gitObservation, error)
	Record   func(event) error
	Delegate func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) int
}

func nativeDelegate(ctx context.Context, path string, args []string, in io.Reader, out, stderr io.Writer) int {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || info.Mode().Perm()&0022 != 0 {
		return 125
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = in
	cmd.Stdout = out
	cmd.Stderr = stderr
	err = cmd.Run()
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() >= 0 {
		return exit.ExitCode()
	}
	return 125
}

func runHook(ctx context.Context, c configuration, hook string, args []string, in io.Reader, out, stderr io.Writer, d dependencies) int {
	allowed := hook == "reference-transaction" || hook == "pre-receive" || hook == "update" || hook == "post-receive" || hook == "proc-receive"
	if !allowed {
		return 125
	}
	g, err := d.Inspect(ctx)
	if err != nil {
		return 125
	}
	kind := classify(c, g.Directory)
	e := event{Version: 1, Hook: hook, Context: kind, GitVersion: g.Version, HooksPathVerified: g.HooksPath == bundlePath}
	if hook == "reference-transaction" {
		if len(args) != 1 || (args[0] != "preparing" && args[0] != "prepared" && args[0] != "committed" && args[0] != "aborted") {
			return 125
		}
		e.State = args[0]
		rows, err := parseUpdates(in)
		if err != nil {
			return 125
		}
		e.Updates = rows
		e.Decision = "observe"
		if kind == "unclassified" {
			e.Decision = "refuse_context"
		}
		if kind == "owned_receiver" && e.State == "prepared" {
			for _, row := range rows {
				if row.Ref == c.DeniedRef {
					e.Decision = "reject_marker"
				}
			}
		}
		if d.Record(e) != nil {
			return 125
		}
		if e.Decision != "observe" {
			return 1
		}
		return 0
	}
	// Receive hooks cannot silently skip their generated native delegates.
	if kind != "owned_receiver" {
		e.Decision = "refuse_context"
		_ = d.Record(e)
		return 125
	}
	if hook == "update" {
		if len(args) != 3 || !validRef(args[0]) || !oidPattern.MatchString(args[1]) || !oidPattern.MatchString(args[2]) || len(args[1]) != len(args[2]) {
			return 125
		}
	} else if len(args) != 0 {
		return 125
	}
	e.Decision = "delegate_enter"
	if d.Record(e) != nil {
		return 125
	}
	code := d.Delegate(ctx, filepath.Join(g.Directory, "hooks", hook), args, in, out, stderr)
	e.Decision = "delegate_exit"
	e.DelegateExit = &code
	if d.Record(e) != nil {
		return 125
	}
	return code
}

func main() {
	hook := flag.String("hook", "", "fixed hook name")
	config := flag.String("config", bundlePath+"/fixture.json", "operator fixture descriptor")
	flag.Parse()
	c, err := loadConfiguration(*config)
	if err != nil {
		fmt.Fprintln(os.Stderr, "golf_hook_fixture_refused")
		os.Exit(125)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	code := runHook(ctx, c, *hook, flag.Args(), os.Stdin, os.Stdout, os.Stderr, dependencies{
		Inspect: inspectGit, Record: func(e event) error { return appendEvent(telemetryPath, e) }, Delegate: nativeDelegate,
	})
	if code != 0 {
		fmt.Fprintln(os.Stderr, "golf_hook_fixture_refused")
	}
	os.Exit(code)
}
