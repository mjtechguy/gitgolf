package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPreparedGitActualTLSBoundSourceAndCleanup(t *testing.T) {
	git, err := preparedGitBinary()
	if err != nil {
		t.Skip("installed Git is required for the actual trusted preparation consumer check")
	}
	root := t.TempDir()
	work := filepath.Join(root, "work")
	if err = os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	command := func(dir string, args ...string) string {
		t.Helper()
		out, err := preparedGitCommand(t.Context(), dir, 4096, args...)
		if err != nil {
			t.Fatal("owned source fixture Git command failed", args[0])
		}
		return strings.TrimSpace(string(out))
	}
	command(work, "init", "--template=", "--initial-branch=main")
	workflowPath := ".github/workflows/owned.yml"
	if err = os.MkdirAll(filepath.Dir(filepath.Join(work, workflowPath)), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(work, workflowPath), []byte("on: push\njobs: {proof: {runs-on: linux, steps: [{run: true}]}}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"older source", "exact admitted source"} {
		if err = os.WriteFile(filepath.Join(work, "README.md"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		command(work, "add", "README.md", workflowPath)
		command(work, "-c", "user.name=Golf fixture", "-c", "user.email=fixture@golf.invalid", "commit", "-m", "owned source")
	}
	commit := command(work, "rev-parse", "HEAD")
	blob := command(work, "rev-parse", "HEAD:"+workflowPath)
	command(root, "-c", "protocol.file.allow=always", "clone", "--bare", "--no-hardlinks", work, filepath.Join(root, "fixture.git"))
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	for _, name := range []string{workflowPath, "README.md"} {
		content, err := os.ReadFile(filepath.Join(work, name))
		if err != nil || writer.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(content))}) != nil {
			t.Fatal("owned original source archive")
		}
		if _, err := writer.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if writer.Close() != nil {
		t.Fatal("owned original archive close")
	}
	digest := sha256.Sum256(archive.Bytes())
	archiveSHA := hex.EncodeToString(digest[:])
	for _, scenario := range []string{"success", "receipt-drift", "duplicate-receipt", "bad-mime", "compressed-response", "native-denial", "redirect", "cancel", "insecure-client"} {
		t.Run(scenario, func(t *testing.T) {
			// Every Git subprocess must ignore inherited config/trace/credential env.
			t.Setenv("GIT_CONFIG_COUNT", "1")
			t.Setenv("GIT_CONFIG_KEY_0", "protocol.http.allow")
			t.Setenv("GIT_CONFIG_VALUE_0", "never")
			t.Setenv("GIT_TRACE", filepath.Join(root, "must-not-be-written"))
			a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43), CommitID: commit, SourceSHA256: archiveSHA}
			key := strings.Repeat("k", 43)
			backend := &cgi.Handler{Path: git, Args: []string{"http-backend"}, Root: "/", Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "HOME=" + root}, Stderr: io.Discard}
			var reads atomic.Int32
			entered := make(chan struct{}, 1)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reads.Add(1)
				if r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || r.Header.Get("Authorization") != "Bearer "+key || r.Header.Get("Golf-Runner-ID") != "worker" || r.Header.Get("Golf-Attempt-Token") != a.AttemptToken || r.Header.Get("Cookie") != "" || r.Header.Get("Git-Protocol") != "" {
					t.Error("trusted TLS/control header boundary")
				}
				if scenario == "cancel" {
					select {
					case entered <- struct{}{}:
					default:
					}
					<-r.Context().Done()
					return
				}
				if scenario == "native-denial" {
					w.WriteHeader(403)
					return
				}
				if scenario == "redirect" {
					w.Header().Set("Location", "https://unrelated.invalid/")
					w.WriteHeader(302)
					return
				}
				prefix := "/internal/ci/attempt/" + a.AttemptID + "/git"
				if r.URL.Path != prefix+"/info/refs" && r.URL.Path != prefix+"/git-upload-pack" {
					t.Error("unexpected coordinator route")
					w.WriteHeader(400)
					return
				}
				forward := r.Clone(r.Context())
				forward.URL.Path = "/fixture.git" + strings.TrimPrefix(r.URL.Path, prefix)
				forward.Header = http.Header{}
				if r.Method == http.MethodPost {
					forward.Header.Set("Content-Type", "application/x-git-upload-pack-request")
				}
				recorder := httptest.NewRecorder()
				backend.ServeHTTP(recorder, forward)
				for name, values := range recorder.Header() {
					w.Header()[name] = values
				}
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("Golf-Source-Commit", commit)
				w.Header().Set("Golf-Workflow-Blob", blob)
				if scenario == "receipt-drift" {
					w.Header().Set("Golf-Workflow-Blob", strings.Repeat("e", 40))
				}
				if scenario == "duplicate-receipt" {
					w.Header().Add("Golf-Source-Commit", commit)
				}
				if scenario == "bad-mime" {
					w.Header().Set("Content-Type", "application/octet-stream")
				}
				if scenario == "compressed-response" {
					w.Header().Set("Content-Encoding", "gzip")
					var compressed bytes.Buffer
					zip := gzip.NewWriter(&compressed)
					zip.Write(recorder.Body.Bytes())
					zip.Close()
					w.WriteHeader(recorder.Code)
					w.Write(compressed.Bytes())
					return
				}
				w.WriteHeader(recorder.Code)
				w.Write(recorder.Body.Bytes())
			}))
			server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
			server.StartTLS()
			t.Cleanup(server.Close)
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}}
			defer transport.CloseIdleConnections()
			if scenario == "insecure-client" {
				transport.TLSClientConfig.InsecureSkipVerify = true
			}
			c := coordinator{origin: server.URL, id: "worker", key: key, client: &http.Client{Transport: transport, Timeout: 5 * time.Second}}
			parent := t.TempDir()
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			if scenario == "cancel" {
				go func() {
					select {
					case <-entered:
						cancel()
					case <-ctx.Done():
					}
				}()
			}
			workspace, err := c.prepareGitSource(ctx, a, parent, workflowPath, blob)
			if scenario != "success" {
				if err == nil || workspace != "" {
					t.Fatal("unsafe or canceled source preparation succeeded")
				}
				entries, err := os.ReadDir(parent)
				if err != nil || len(entries) != 0 {
					t.Fatal("failed preparation workspace remains", err)
				}
				if scenario == "insecure-client" && reads.Load() != 0 {
					t.Fatal("insecure TLS sent control credentials")
				}
				if scenario != "insecure-client" && reads.Load() == 0 {
					t.Fatal("negative scenario never reached actual coordinator boundary")
				}
				return
			}
			if err != nil || reads.Load() < 2 {
				t.Fatal("actual TLS/native Git preparation failed", err, "coordinator reads", reads.Load())
			}
			if command(workspace, "rev-parse", "HEAD") != commit || command(workspace, "rev-list", "--count", "HEAD") != "1" || command(workspace, "rev-parse", "HEAD:"+workflowPath) != blob {
				t.Fatal("prepared Git identity differs")
			}
			listing, err := preparedGitCommand(t.Context(), workspace, 4<<20, "ls-tree", "-rz", "--full-tree", commit)
			if err != nil || verifyGitSnapshot(archive.Bytes(), listing, a.SourceSHA256, a.CommitID, workflowPath, blob) != nil {
				t.Fatal("actual fetched tree did not bind original admitted archive", err)
			}
			if _, err := os.Stat(filepath.Join(workspace, "README.md")); !os.IsNotExist(err) {
				t.Fatal("source materialized before archive comparison")
			}
			if _, err := os.Stat(filepath.Join(workspace, ".git", "FETCH_HEAD")); !os.IsNotExist(err) {
				t.Fatal("local read capability persisted in FETCH_HEAD")
			}
			if err := filepath.WalkDir(workspace, func(path string, entry os.DirEntry, err error) error {
				if err != nil || entry.IsDir() {
					return err
				}
				data, err := os.ReadFile(path)
				if err == nil && (bytes.Contains(data, []byte(key)) || bytes.Contains(data, []byte(a.AttemptToken))) {
					t.Error("Golf control credential persisted in prepared repository")
				}
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(root, "must-not-be-written")); !os.IsNotExist(err) {
				t.Fatal("ambient Git tracing executed")
			}
			if err := os.RemoveAll(workspace); err != nil {
				t.Fatal(err)
			}
		})
	}
}
