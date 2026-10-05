package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type preparedGitOutput struct {
	bytes.Buffer
	limit int
}

const preparedGitPATH = "/usr/local/bin:/usr/bin:/bin:/sbin"

func preparedGitBinary() (string, error) {
	for _, directory := range strings.Split(preparedGitPATH, ":") {
		candidate := filepath.Join(directory, "git")
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
			return candidate, nil
		}
	}
	return "", errTransport
}

func (b *preparedGitOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errTransport
	}
	return b.Buffer.Write(p)
}

// The dedicated trusted worker runs installed Git, never source-selected Git,
// hooks, filters, credential helpers, user configuration or inherited env.
func preparedGitCommand(ctx context.Context, directory string, limit int, args ...string) ([]byte, error) {
	if limit < 1 || limit > 4<<20 || !filepath.IsAbs(directory) {
		return nil, errTransport
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	binary, err := preparedGitBinary()
	if err != nil {
		return nil, errTransport
	}
	options := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.http.allow=always", "-c", "http.followRedirects=false", "-c", "http.proxy=", "-c", "core.autocrlf=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"}
	cmd := exec.CommandContext(ctx, binary, append(options, args...)...)
	cmd.Dir = directory
	cmd.Env = []string{"PATH=" + preparedGitPATH, "HOME=" + filepath.Join(directory, ".git", "private-home"), "XDG_CONFIG_HOME=" + filepath.Join(directory, ".git", "private-home"), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "LANG=C"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	output := &preparedGitOutput{limit: limit}
	cmd.Stdout, cmd.Stderr = output, io.Discard
	if cmd.Run() != nil {
		return nil, errTransport
	}
	return output.Bytes(), nil
}

// A fresh unmaterialized repository: no checkout, submodules, LFS, source
// filters or job execution. The caller owns successful workspace removal.
func (c *coordinator) prepareGitSource(ctx context.Context, a assignment, parent, workflowPath, workflowBlobID string) (workspace string, err error) {
	if !c.verifyingHTTPS() || !safeID.MatchString(c.id) || !tokenOK(c.key) || !attemptID.MatchString(a.AttemptID) || !tokenOK(a.AttemptToken) || !commitID.MatchString(a.CommitID) || !gitSnapshotPath(workflowPath) || !commitID.MatchString(workflowBlobID) || len(a.CommitID) != len(workflowBlobID) || !filepath.IsAbs(parent) {
		return "", errTransport
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	directory, err := os.MkdirTemp(parent, "git-preparation-")
	if err != nil {
		return "", errTransport
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(directory)
		}
	}()
	format := "sha1"
	if len(a.CommitID) == 64 {
		format = "sha256"
	}
	if _, err = preparedGitCommand(ctx, directory, 4096, "init", "--template=", "--object-format="+format); err != nil {
		return "", err
	}
	var random [32]byte
	if _, err = rand.Read(random[:]); err != nil {
		return "", errTransport
	}
	// This short-lived local read nonce is separate from every Golf credential.
	// No-write-fetch-head prevents the loopback capability entering repo files.
	prefix := "/" + hex.EncodeToString(random[:]) + "/repo"
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", errTransport
	}
	broker := &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, MaxHeaderBytes: 4096, BaseContext: func(net.Listener) context.Context { return ctx }}
	broker.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fail := func() { http.Error(w, "Git preparation unavailable.", 502) }
		if r.Host != listener.Addr().String() || r.URL.RawPath != "" || r.URL.Fragment != "" || r.URL.User != nil || r.URL.IsAbs() || strings.ContainsAny(r.URL.Path, "%\\") || !strings.HasPrefix(r.URL.Path, prefix+"/") {
			fail()
			return
		}
		for name, values := range r.Header {
			if len(values) != 1 {
				fail()
				return
			}
			switch name {
			case "User-Agent", "Accept", "Accept-Language", "Accept-Encoding", "Pragma", "Cache-Control", "Content-Type", "Content-Length":
			default:
				fail()
				return
			}
		}
		suffix := strings.TrimPrefix(r.URL.Path, prefix)
		var body []byte
		content, limit := "application/x-git-upload-pack-advertisement", int64(2<<20)
		if r.Method == http.MethodGet && suffix == "/info/refs" && r.URL.RawQuery == "service=git-upload-pack" && r.ContentLength == 0 {
			suffix += "?service=git-upload-pack"
		} else if r.Method == http.MethodPost && suffix == "/git-upload-pack" && r.URL.RawQuery == "" && r.Header.Get("Content-Type") == "application/x-git-upload-pack-request" {
			var readErr error
			body, readErr = io.ReadAll(io.LimitReader(r.Body, 4097))
			if readErr != nil || len(body) == 0 || len(body) > 4096 {
				fail()
				return
			}
			content, limit = "application/x-git-upload-pack-result", 64<<20
		} else {
			fail()
			return
		}
		data, e := c.gitPreparationRead(r.Context(), a, workflowBlobID, suffix, body)
		if e != nil || int64(len(data)) > limit || ctx.Err() != nil {
			fail()
			return
		}
		w.Header().Set("Content-Type", content)
		_, _ = w.Write(data)
	})
	finished := make(chan struct{})
	go func() { defer close(finished); _ = broker.Serve(listener) }()
	defer func() {
		cancel()
		cleanup, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		if broker.Shutdown(cleanup) != nil {
			_ = broker.Close()
			workspace, err = "", errTransport
		}
		<-finished
	}()
	url := "http://" + listener.Addr().String() + prefix
	if _, err = preparedGitCommand(ctx, directory, 4096, "-c", "protocol.version=0", "fetch", "--no-auto-maintenance", "--no-write-fetch-head", "--no-tags", "--depth=1", url, a.CommitID); err != nil {
		return "", err
	}
	if _, err = preparedGitCommand(ctx, directory, 4096, "update-ref", "--no-deref", "HEAD", a.CommitID); err != nil {
		return "", err
	}
	for _, check := range []struct {
		args     []string
		expected string
	}{
		{[]string{"rev-parse", "--verify", "HEAD"}, a.CommitID},
		{[]string{"cat-file", "-t", a.CommitID}, "commit"},
		{[]string{"rev-parse", "--is-shallow-repository"}, "true"},
		{[]string{"rev-list", "--count", "HEAD"}, "1"},
		{[]string{"rev-parse", "--verify", a.CommitID + ":" + workflowPath}, workflowBlobID},
	} {
		var output []byte
		output, err = preparedGitCommand(ctx, directory, 4096, check.args...)
		if err != nil || strings.TrimSpace(string(output)) != check.expected {
			return "", errTransport
		}
	}
	if _, err = preparedGitCommand(ctx, directory, 4096, "fsck", "--full", "--strict", "--no-reflogs"); err != nil {
		return "", err
	}
	if ctx.Err() != nil {
		return "", errTransport
	}
	return directory, nil
}
