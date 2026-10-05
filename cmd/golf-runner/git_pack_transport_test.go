package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestGitPackNativeTLSFraming(t *testing.T) {
	git, err := preparedGitBinary()
	if err != nil {
		t.Fatal("installed native Git required", err)
	}
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			root := t.TempDir()
			repo := filepath.Join(root, "fixture.git")
			if err := os.Mkdir(repo, 0700); err != nil {
				t.Fatal(err)
			}
			command := func(args ...string) string {
				t.Helper()
				out, err := preparedGitCommand(t.Context(), repo, 4096, args...)
				if err != nil {
					t.Fatal("native fixture", args, err)
				}
				return strings.TrimSpace(string(out))
			}
			command("init", "--template=", "--object-format="+format)
			if err := os.WriteFile(filepath.Join(repo, "workflow.yml"), []byte("name: owned native transport\n"), 0600); err != nil {
				t.Fatal(err)
			}
			command("add", "workflow.yml")
			command("-c", "user.name=Fixture", "-c", "user.email=fixture@golf.invalid", "commit", "-qm", "root")
			first := command("rev-parse", "HEAD")
			blob := command("rev-parse", "HEAD:workflow.yml")
			if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("child source\n"), 0600); err != nil {
				t.Fatal(err)
			}
			command("add", "README.md")
			command("-c", "user.name=Fixture", "-c", "user.email=fixture@golf.invalid", "commit", "-qm", "child")
			child := command("rev-parse", "HEAD")
			for _, item := range []struct{ name, h string }{{"root-historical", first}, {"child", child}} {
				t.Run(item.name, func(t *testing.T) {
					a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("b", 43), CommitID: item.h}
					key := strings.Repeat("k", 43)
					backend := &cgi.Handler{Path: git, Args: []string{"http-backend"}, Root: "/", Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "HOME=" + root}, Stderr: io.Discard}
					var reads atomic.Int32
					server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						reads.Add(1)
						if r.TLS == nil || r.TLS.Version != tls.VersionTLS13 || r.Header.Get("Authorization") != "Bearer "+key || r.Header.Get("Golf-Attempt-Token") != a.AttemptToken || r.Header.Get("Golf-Runner-ID") != "worker" || r.Header.Get("Cookie") != "" || r.Header.Get("Git-Protocol") != "" {
							t.Error("trusted TLS/control credential boundary")
						}
						if r.Method == http.MethodPost {
							body, _ := io.ReadAll(r.Body)
							if !bytes.Contains(body, []byte("want "+item.h+" no-progress ofs-delta")) || !bytes.Contains(body, []byte("deepen 1\n")) || !bytes.HasSuffix(body, preparedGitPacket("done\n")) || bytes.Contains(body, []byte("thin-pack")) || bytes.Contains(body, []byte("side-band")) || bytes.Contains(body, []byte("have ")) {
								t.Error("closed exact-H depth1 request")
							}
							r.Body = io.NopCloser(bytes.NewReader(body))
						}
						prefix := "/internal/ci/attempt/" + a.AttemptID + "/git"
						forward := r.Clone(r.Context())
						forward.URL.Path = "/fixture.git" + strings.TrimPrefix(r.URL.Path, prefix)
						forward.Header = http.Header{}
						if r.Method == http.MethodPost {
							forward.Header.Set("Content-Type", "application/x-git-upload-pack-request")
						}
						recorder := httptest.NewRecorder()
						backend.ServeHTTP(recorder, forward)
						if r.Method == http.MethodPost {
							t.Logf("native control prefix: %q", recorder.Body.Bytes()[:min(100, recorder.Body.Len())])
						}
						for name, values := range recorder.Header() {
							w.Header()[name] = values
						}
						w.Header().Set("Cache-Control", "no-store")
						w.Header().Set("Golf-Source-Commit", item.h)
						w.Header().Set("Golf-Workflow-Blob", blob)
						w.WriteHeader(recorder.Code)
						_, _ = w.Write(recorder.Body.Bytes())
					}))
					server.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
					server.StartTLS()
					defer server.Close()
					roots := x509.NewCertPool()
					roots.AddCert(server.Certificate())
					transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}}
					defer transport.CloseIdleConnections()
					jar, _ := cookiejar.New(nil)
					target, _ := http.NewRequest(http.MethodGet, server.URL, nil)
					jar.SetCookies(target.URL, []*http.Cookie{{Name: "ambient", Value: "must-not-forward"}})
					c := &coordinator{origin: server.URL, id: "worker", key: key, client: &http.Client{Transport: transport, Jar: jar}}
					ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
					defer cancel()
					pack, err := c.fetchGitPack(ctx, a, blob)
					if err != nil || reads.Load() != 2 {
						t.Fatal("actual native TLS PACK framing", err, "reads", reads.Load())
					}
					if format == "sha1" {
						hash := sha1.Sum(pack[:len(pack)-20])
						if !bytes.Equal(hash[:], pack[len(pack)-20:]) {
							t.Fatal("opaque SHA1 PACK changed")
						}
					} else {
						hash := sha256.Sum256(pack[:len(pack)-32])
						if !bytes.Equal(hash[:], pack[len(pack)-32:]) {
							t.Fatal("opaque SHA256 PACK changed")
						}
					}
					// Explicit opt-in to the actual locally cached Docker qualification;
					// ordinary runs prove native TLS/framing, not Docker isolation.
					if image := os.Getenv("GOLF_TEST_GIT_PREPARATION_IMAGE"); image != "" {
						t.Run("native-container", func(t *testing.T) {
							executor, err := runner.New(runner.Config{WorkerID: "golf-git-preparation-qualification", DockerBinary: os.Getenv("GOLF_TEST_GIT_PREPARATION_DOCKER"), ApprovedImages: []string{image}})
							if err != nil {
								t.Fatal(err)
							}
							binding := &runner.JobResourceBinding{Profile: runner.JobLimitsProfile, Limits: runner.DefaultJobLimits(), Bound: true, InstanceVersion: "0", PlacementVersion: "0"}
							prepared, err := executor.PrepareGit(t.Context(), runner.GitPreparation{AttemptID: a.AttemptID, ImageDigest: image, CommitID: item.h, WorkflowPath: "workflow.yml", WorkflowBlobID: blob, Pack: pack, JobResources: binding})
							if err != nil || len(prepared.Metadata) == 0 || len(prepared.Listing) == 0 {
								t.Fatal("native resource-bounded preparation", err)
							}
							// Golf admits a regular-file source tar, not native archive's
							// global PAX commit header. Keep that original contract here.
							var archive bytes.Buffer
							writer := tar.NewWriter(&archive)
							files := []string{"workflow.yml"}
							if item.name == "child" {
								files = append(files, "README.md")
							}
							for _, name := range files {
								content, err := preparedGitCommand(t.Context(), repo, 4096, "show", item.h+":"+name)
								if err != nil || writer.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(content))}) != nil {
									t.Fatal("original admitted archive fixture", err)
								}
								if _, err := writer.Write(content); err != nil {
									t.Fatal(err)
								}
							}
							if err := writer.Close(); err != nil {
								t.Fatal(err)
							}
							hash := sha256.Sum256(archive.Bytes())
							if verifyGitSnapshot(archive.Bytes(), prepared.Listing, fmt.Sprintf("%x", hash), item.h, "workflow.yml", blob) != nil || prepared.TreeID != command("rev-parse", item.h+"^{tree}") {
								t.Fatal("original archive and native tree differ")
							}
						})
					}
				})
			}
		})
	}
}

func TestGitPackClosedControlFraming(t *testing.T) {
	h := strings.Repeat("a", 40)
	pack := append([]byte("PACK\x00\x00\x00\x02\x00\x00\x00\x01"), make([]byte, 20)...)
	shallow, nak := preparedGitPacket("shallow "+h+"\n"), preparedGitPacket("NAK\n")
	join := func(parts ...[]byte) []byte { return bytes.Join(parts, nil) }
	for _, control := range [][]byte{join(shallow, []byte("0000"), nak, pack), join(preparedGitPacket("shallow "+h), []byte("0000"), nak, pack), join([]byte("0000"), nak, pack)} {
		got, err := gitPackResult(control, h)
		if err != nil || !bytes.Equal(got, pack) {
			t.Fatal("permitted shallow/NAK raw PACK", err)
		}
	}
	for _, control := range [][]byte{
		join(shallow, shallow, []byte("0000"), nak, pack),
		join(preparedGitPacket("unshallow "+h+"\n"), []byte("0000"), nak, pack),
		join(preparedGitPacket("shallow "+strings.Repeat("b", 40)+"\n"), []byte("0000"), nak, pack),
		join([]byte("0000"), preparedGitPacket("ACK "+h+"\n"), pack),
		join([]byte("0000"), preparedGitPacket("ERR denied\n"), pack),
		join([]byte("0000"), nak, preparedGitPacket("\x01"+string(pack))),
		join([]byte("0000"), nak, []byte("PACK")),
		join([]byte("0000"), nak, []byte("0000"), pack),
		[]byte("0001"), []byte("zzzz"),
	} {
		if _, err := gitPackResult(control, h); err == nil {
			t.Fatal("unsupported negotiation accepted")
		}
	}
	advert := func(caps string) []byte {
		return join(preparedGitPacket("# service=git-upload-pack\n"), []byte("0000"), preparedGitPacket(h+" refs/heads/main\x00"+caps+"\n"), []byte("0000"))
	}
	for _, caps := range []string{"shallow no-progress ofs-delta", "shallow no-progress ofs-delta object-format=sha1"} {
		if _, err := gitPackAdvertisement(advert(caps), h); err != nil {
			t.Fatal("valid capabilities", err)
		}
	}
	for _, caps := range []string{"shallow ofs-delta", "no-progress ofs-delta", "shallow no-progress", "shallow no-progress ofs-delta shallow", "shallow no-progress ofs-delta object-format=sha256"} {
		if _, err := gitPackAdvertisement(advert(caps), h); err == nil {
			t.Fatal("unsupported capabilities accepted", caps)
		}
	}
}
