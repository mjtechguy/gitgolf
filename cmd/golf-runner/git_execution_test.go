package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
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
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

// Docker lifecycle is controlled here; index-pack and every subsequent Git
// identity/tree/fsck/export operation execute actual installed native Git.
// This harness does not establish container resource or engine qualification.
func executionPreparationDocker(t *testing.T, mode string) (string, string, string) {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("python3 required for controlled lifecycle proof")
	}
	dir := t.TempDir()
	workspace := filepath.Join(dir, "workspace")
	if err = os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(dir, "calls.jsonl")
	marker := filepath.Join(dir, "exec-started")
	configuration, _ := json.Marshal(map[string]string{"dir": dir, "workspace": workspace, "log": log, "mode": mode, "marker": marker, "arch": runtime.GOARCH})
	code := `#!` + python + `
import sys,os,json,subprocess,time
c=json.loads(` + strconv.Quote(string(configuration)) + `)
a=sys.argv[1:]
with open(c['log'],'a') as f: f.write(json.dumps(a)+'\n')
cid='c'*64
state=os.path.join(c['dir'],'state.json')
if a[:2] in [['container','ls'],['volume','ls']]: sys.exit(0)
elif a[:2]==['image','inspect']:
 print(json.dumps([{'ID':'sha256:'+'b'*64,'Os':'linux','Architecture':c['arch'],'Config':{'Volumes':{}}}]))
elif a[:2]==['container','create']:
 labels={a[i+1].split('=',1)[0]:a[i+1].split('=',1)[1] for i in range(len(a)-1) if a[i]=='--label'}
 options={v.split('=',1)[0]:v.split('=',1)[1] for v in a if '=' in v}
 row={'Id':cid,'Image':'sha256:'+'b'*64,'Config':{'Labels':labels,'User':'1000:1000','WorkingDir':'/workspace','Entrypoint':['/usr/bin/env'],'Cmd':['-i','PATH=/usr/bin:/bin','HOME=/tmp','/bin/sh','-c','while :; do sleep 3600; done']},'State':{'Running':True},'HostConfig':{'NetworkMode':'none','Privileged':False,'ReadonlyRootfs':True,'Memory':int(options['--memory']),'MemorySwap':int(options['--memory-swap']),'NanoCpus':int(float(options['--cpus'])*1000000000),'PidsLimit':int(options['--pids-limit']),'CapAdd':[],'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'Binds':[],'Devices':[],'PortBindings':{},'Tmpfs':dict(a[i+1].split(':',1) for i in range(len(a)-1) if a[i]=='--tmpfs'),'Init':True,'RestartPolicy':{'Name':'no'},'LogConfig':{'Type':'none'}},'Mounts':[]}
 with open(state,'w') as f: json.dump(row,f)
 print(cid)
elif a[:2]==['container','inspect']:
 with open(state) as f: print(json.dumps([json.load(f)]))
elif a[:2]==['container','rm']:
 if c['mode']=='cleanup': sys.exit(1)
 os.remove(state)
elif a[:2]==['container','start']: print(cid)
elif a[:2]==['container','exec']:
 with open(c['marker'],'w') as f: f.write('started')
 if c['mode']=='cancel': time.sleep(60)
 command=a[a.index(cid)+1:]
 if command[:2]!=['/usr/bin/env','-i']: sys.exit(2)
 if '/bin/tar' in command and not os.path.exists('/bin/tar'):
  i=command.index('/bin/tar'); command[i]='/usr/bin/tar'; command.insert(i+1,'--format=ustar')
 with open(c['log']+'.stderr','ab') as errors:
  sys.exit(subprocess.call(command,cwd=c['workspace'],stdin=sys.stdin.buffer,stdout=sys.stdout.buffer,stderr=errors))
else: sys.exit(3)
`
	binary := filepath.Join(dir, "docker")
	if err = os.WriteFile(binary, []byte(code), 0700); err != nil {
		t.Fatal(err)
	}
	return binary, log, marker
}

func executionSourceFixture(t *testing.T, format string, scripts ...string) (string, string, string, []byte) {
	t.Helper()
	root := t.TempDir()
	repo := filepath.Join(root, "fixture.git")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) string {
		t.Helper()
		value, err := preparedGitCommand(t.Context(), repo, 4096, args...)
		if err != nil {
			t.Fatal("native owned fixture", err)
		}
		return strings.TrimSpace(string(value))
	}
	run("init", "--template=", "--object-format="+format)
	script := "git rev-parse HEAD"
	if len(scripts) > 0 {
		script = scripts[0]
	}
	files := []struct{ name, body string }{{"workflow.yml", "name: Original source\non: workflow_dispatch\njobs:\n  check:\n    runs-on: owned\n    steps:\n      - shell: sh\n        run: " + script + "\n"}, {"README.md", "original ordinary source\n"}}
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	for _, file := range files {
		if err := os.WriteFile(filepath.Join(repo, file.name), []byte(file.body), 0600); err != nil {
			t.Fatal(err)
		}
		if err := writer.WriteHeader(&tar.Header{Name: file.name, Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(file.body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(file.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("-c", "user.name=Fixture", "-c", "user.email=fixture@golf.invalid", "commit", "-qm", "owned original source")
	return root, run("rev-parse", "HEAD"), run("rev-parse", "HEAD:workflow.yml"), archive.Bytes()
}

// Explicit launcher-only qualification. Ordinary source checks never infer
// Docker/registry/job qualification from the controlled CLI harness above.
func TestActionsGitActualEngine(t *testing.T) {
	image := os.Getenv("GOLF_TEST_GIT_JOB_IMAGE")
	if image == "" {
		t.Skip("explicit owned actual-Docker launcher required")
	}
	worker := os.Getenv("GOLF_TEST_GIT_WORKER_ID")
	planBinary := os.Getenv("GOLF_TEST_GIT_PLAN_BINARY")
	engineBinary := os.Getenv("GOLF_TEST_GIT_ENGINE_BINARY")
	if !strings.HasPrefix(worker, "golf-git-job-proof-") || planBinary == "" || engineBinary == "" {
		t.Fatal("owned launcher bindings missing")
	}
	git, err := preparedGitBinary()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"success", "wrong_tree", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
			defer cancel()
			script := "git rev-parse HEAD"
			if mode == "cancel" {
				script += "; sleep 30"
			}
			root, h, blob, archive := executionSourceFixture(t, "sha1", script)
			in := runner.ActionPlanInput{Catalog: runner.ActionsCatalog, Archive: archive, WorkflowPath: "workflow.yml", WorkflowBlobID: blob, Event: "workflow_dispatch", Ref: h, Images: map[string]string{"owned": image}}
			request, _ := json.Marshal(in)
			command := exec.CommandContext(ctx, planBinary, "plan")
			command.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + root}
			command.Stdin = bytes.NewReader(append(request, '\n'))
			out, err := command.Output()
			var plan runner.ActionPlan
			if err != nil || len(out) > 1<<20 || json.Unmarshal(out, &plan) != nil || plan.ArchiveSHA256 == "" {
				t.Fatal("actual maintained engine original-YAML admission refused")
			}
			e, err := runner.New(runner.Config{WorkerID: worker, DockerBinary: "docker", ApprovedImages: []string{image}})
			if err != nil {
				t.Fatal(err)
			}
			actions, err := runner.NewActions(e, engineBinary)
			if err != nil {
				t.Fatal(err)
			}
			event, _ := json.Marshal(map[string]any{"after": h, "ref": h, "repository": map[string]any{"name": "owned", "default_branch": "main", "owner": map[string]string{"login": "owned"}}})
			a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("t", 43), CommitID: h, SourceSHA256: plan.ArchiveSHA256, EngineCatalog: runner.ActionsCatalog, ActionsPlan: &plan, EventJSON: event, TimeoutSeconds: 900, JobResources: &runner.JobResourceBinding{Profile: runner.JobLimitsProfile, Limits: runner.DefaultJobLimits(), Bound: true, InstanceVersion: "0", PlacementVersion: "0"}}
			backend := &cgi.Handler{Path: git, Args: []string{"http-backend"}, Root: "/", Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "HOME=" + root}, Stderr: io.Discard}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.TLS == nil || r.TLS.Version != tls.VersionTLS13 || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("k", 43) || r.Header.Get("Golf-Runner-ID") != worker || r.Header.Get("Golf-Attempt-Token") != a.AttemptToken {
					t.Error("actual preparation transport credentials changed")
				}
				forward := r.Clone(r.Context())
				forward.URL.Path = "/fixture.git" + strings.TrimPrefix(r.URL.Path, "/internal/ci/attempt/"+a.AttemptID+"/git")
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
				w.Header().Set("Golf-Source-Commit", h)
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
			c := &coordinator{origin: server.URL, id: worker, key: strings.Repeat("k", 43), client: &http.Client{Transport: transport}, actions: actions}
			manifest, metadata, err := c.prepareActionsGitSource(ctx, e, a, archive, image)
			if err != nil {
				t.Fatal("actual native-container preparation refused", err)
			}
			if mode == "wrong_tree" {
				manifest.TreeID = strings.Repeat("0", len(h))
			}
			input := actionsExecutionInput(a, archive, in.Images)
			input.GitSource = manifest
			var logs strings.Builder
			started, finished, complete := false, false, false
			result, executionErr := actions.ExecuteGit(ctx, a.AttemptID, input, metadata, func(frameCtx context.Context, frame runner.ActionFrame) error {
				if mode == "wrong_tree" {
					t.Error("native identity refusal released a frame/ACK")
				}
				started = started || frame.Kind == "job_started"
				if frame.Kind == "job_started" {
					actualGitJobProfile(t, frameCtx, worker, a.AttemptID)
				}
				finished = finished || frame.Kind == "job_finished"
				complete = complete || frame.Kind == "complete"
				if logs.Len()+len(frame.Text) > 64<<10 {
					return errOutputBound
				}
				logs.WriteString(frame.Text)
				if mode == "cancel" && strings.Contains(logs.String(), h) {
					cancel()
					return frameCtx.Err()
				}
				return nil
			})
			if mode == "success" && (executionErr != nil || result.ExitCode != 0 || !started || !finished || !complete || !strings.Contains(logs.String(), h)) {
				t.Fatal("actual Git job/log/graph proof failed", runner.ActionsFailureStage(executionErr))
			}
			if mode != "success" && executionErr == nil {
				t.Fatal("actual refusal/cancellation became success")
			}
			if mode == "cancel" && (!started || !strings.Contains(logs.String(), h) || ctx.Err() == nil) {
				t.Fatal("actual running job cancellation boundary not reached")
			}
			cleanupCtx, stop := context.WithTimeout(t.Context(), 20*time.Second)
			defer stop()
			if err := e.RequireCleanWorker(cleanupCtx); err != nil {
				t.Fatal("actual owned cleanup failed", err)
			}
			t.Logf("ACTUAL_GIT_JOB case=%s H=%s workflowBlob=%s tree=%s archiveSHA=%s metadataSHA=%s frames=%t/%t/%t ownedCleanup=true nativeEngineStage=%s", mode, h, blob, manifest.TreeID, manifest.ArchiveSHA256, manifest.MetadataSHA256, started, finished, complete, runner.ActionsFailureStage(executionErr))
		})
	}
}

func actualGitJobProfile(t *testing.T, ctx context.Context, worker, attempt string) {
	t.Helper()
	run := func(args ...string) []byte {
		t.Helper()
		command := exec.CommandContext(ctx, "docker", args...)
		command.WaitDelay = 2 * time.Second
		out, err := command.Output()
		if err != nil || len(out) > 1<<20 {
			t.Fatal("actual owned job profile observation failed")
		}
		return out
	}
	parent := strings.TrimSpace(string(run("container", "ls", "-aq", "--no-trunc", "--filter", "label=io.golf.runner.worker="+worker, "--filter", "label=io.golf.runner.attempt="+attempt)))
	if !hashID.MatchString(parent) {
		t.Fatal("exact owned parent receipt missing")
	}
	job := strings.TrimSpace(string(run("exec", parent, "docker", "container", "ls", "-q", "--no-trunc")))
	if !hashID.MatchString(job) {
		t.Fatal("exact owned inner job receipt missing")
	}
	// Decode only public resource/mount observations; never emit Config.Env.
	var rows []struct {
		ID         string `json:"Id"`
		Config     struct{ User string }
		HostConfig struct {
			NetworkMode                  string
			Memory, MemorySwap, NanoCpus int64
			PidsLimit                    *int64
			Privileged, ReadonlyRootfs   bool
			CapDrop, SecurityOpt         []string
		}
		Mounts []struct{ Type, Destination string }
	}
	if json.Unmarshal(run("exec", parent, "docker", "container", "inspect", job), &rows) != nil || len(rows) != 1 || rows[0].ID != job {
		t.Fatal("actual native inner inspect receipt invalid")
	}
	r := rows[0]
	if r.Config.User != "1000:1000" || r.HostConfig.NetworkMode != "none" || r.HostConfig.Privileged || r.HostConfig.Memory != 268435456 || r.HostConfig.MemorySwap != 268435456 || r.HostConfig.NanoCpus != 1000000000 || r.HostConfig.PidsLimit == nil || *r.HostConfig.PidsLimit != 64 || len(r.Mounts) != 3 {
		t.Fatal("actual job resource/mount profile differs")
	}
	encoded, _ := json.Marshal(r)
	t.Logf("ACTUAL_GIT_JOB_PROFILE %s", encoded)
}

func TestActionsGitPreparationComposition(t *testing.T) {
	git, err := preparedGitBinary()
	if err != nil {
		t.Fatal("actual installed native Git required", err)
	}
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			root, h, blob, archive := executionSourceFixture(t, format)
			for _, mode := range []string{"success", "revoked", "receipt", "archive_tree", "cancel", "cleanup"} {
				t.Run(mode, func(t *testing.T) {
					ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
					defer cancel()
					binary, log, marker := executionPreparationDocker(t, mode)
					image := "sha256:" + strings.Repeat("b", 64)
					e, err := runner.New(runner.Config{WorkerID: "worker", DockerBinary: binary, ApprovedImages: []string{image}})
					if err != nil {
						t.Fatal(err)
					}
					actions, err := runner.NewActions(e, binary)
					if err != nil {
						t.Fatal(err)
					}
					original := append([]byte(nil), archive...)
					if mode == "archive_tree" {
						original[512] ^= 1 // Different admitted regular-file bytes.
					}
					hash := sha256.Sum256(original)
					sha := fmt.Sprintf("%x", hash)
					a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("t", 43), CommitID: h, SourceSHA256: sha, EngineCatalog: runner.ActionsCatalog, EventJSON: []byte(`{"ref":"refs/heads/main"}`), TimeoutSeconds: 900, JobResources: &runner.JobResourceBinding{Profile: runner.JobLimitsProfile, Limits: runner.DefaultJobLimits(), Bound: true, InstanceVersion: "0", PlacementVersion: "0"}, ActionsPlan: &runner.ActionPlan{Catalog: runner.ActionsCatalog, WorkflowPath: "workflow.yml", WorkflowBlobID: blob, ArchiveSHA256: sha, Event: "workflow_dispatch", Ref: h, Jobs: []runner.ActionJob{{JobID: "check"}}}}
					key := strings.Repeat("k", 43)
					backend := &cgi.Handler{Path: git, Args: []string{"http-backend"}, Root: "/", Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "HOME=" + root}, Stderr: io.Discard}
					var reads atomic.Int32
					server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						read := reads.Add(1)
						if r.TLS == nil || r.TLS.Version != tls.VersionTLS13 || r.Header.Get("Authorization") != "Bearer "+key || r.Header.Get("Golf-Runner-ID") != "worker" || r.Header.Get("Golf-Attempt-Token") != a.AttemptToken || r.Header.Get("Cookie") != "" {
							t.Error("trusted control credential boundary changed")
						}
						if read == 3 && mode == "revoked" {
							w.WriteHeader(http.StatusForbidden)
							return
						}
						forward := r.Clone(r.Context())
						forward.URL.Path = "/fixture.git" + strings.TrimPrefix(r.URL.Path, "/internal/ci/attempt/"+a.AttemptID+"/git")
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
						w.Header().Set("Golf-Source-Commit", h)
						w.Header().Set("Golf-Workflow-Blob", blob)
						if read == 3 && mode == "receipt" {
							w.Header().Set("Golf-Source-Commit", strings.Repeat("0", len(h)))
						}
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
					c := &coordinator{origin: server.URL, id: "worker", key: key, client: &http.Client{Transport: transport}, actions: actions}
					if mode == "cancel" {
						joined := make(chan struct{})
						go func() {
							defer close(joined)
							for ctx.Err() == nil {
								if _, err := os.Stat(marker); err == nil {
									cancel()
									return
								}
								time.Sleep(5 * time.Millisecond)
							}
						}()
						defer func() { cancel(); <-joined }()
					}
					manifest, metadata, err := c.prepareActionsGitSource(ctx, e, a, original, image)
					if mode == "success" {
						if err != nil || manifest == nil || len(metadata) == 0 || reads.Load() != 3 || runner.ValidateGitSource(manifest, metadata, original, h, "workflow.yml", blob) != nil {
							t.Fatal("real TLS/native preparation composition", err, "reads", reads.Load())
						}
					} else if err == nil || manifest != nil || metadata != nil {
						t.Fatal("failed preparation exposed partial metadata", err)
					}
					if mode == "cleanup" && !errors.Is(err, runner.ErrCleanup) {
						t.Fatal("cleanup failure did not fence worker reuse", err)
					}
					calls, err := os.ReadFile(log)
					if err != nil || !bytes.Contains(calls, []byte(`"--force"`)) || bytes.Contains(calls, []byte(key)) || bytes.Contains(calls, []byte(a.AttemptToken)) {
						t.Fatal("native cleanup/control-credential isolation proof missing")
					}
					if !bytes.Equal(archive, original) && mode != "archive_tree" {
						t.Fatal("original admitted source mutated")
					}
				})
			}
		})
	}
}

func TestActionsGitPreparationPreflightWithoutEffects(t *testing.T) {
	for _, mode := range []string{"missing_plan", "not_actions", "unbound", "timeout", "commit", "workflow", "blob", "archive", "digest", "empty_image", "cancelled", "nil_executor"} {
		t.Run(mode, func(t *testing.T) {
			binary, log, _ := executionPreparationDocker(t, "")
			image := "sha256:" + strings.Repeat("b", 64)
			e, _ := runner.New(runner.Config{WorkerID: "worker", DockerBinary: binary, ApprovedImages: []string{image}})
			actions, _ := runner.NewActions(e, binary)
			c := &coordinator{actions: actions} // No transport; preflight must refuse.
			archive := []byte("original")
			hash := sha256.Sum256(archive)
			sha := fmt.Sprintf("%x", hash)
			a := assignment{AttemptID: strings.Repeat("a", 32), AttemptToken: strings.Repeat("t", 43), CommitID: strings.Repeat("c", 40), SourceSHA256: sha, EngineCatalog: runner.ActionsCatalog, EventJSON: []byte(`{"ref":"refs/heads/main"}`), TimeoutSeconds: 900, JobResources: &runner.JobResourceBinding{Profile: runner.JobLimitsProfile, Limits: runner.DefaultJobLimits(), Bound: true, InstanceVersion: "0", PlacementVersion: "0"}, ActionsPlan: &runner.ActionPlan{Catalog: runner.ActionsCatalog, ArchiveSHA256: sha, WorkflowPath: "workflow.yml", WorkflowBlobID: strings.Repeat("d", 40), Jobs: []runner.ActionJob{{JobID: "check"}}}}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "missing_plan":
				a.ActionsPlan = nil
			case "not_actions":
				a.EngineCatalog = ""
			case "unbound":
				a.JobResources.Bound = false
			case "timeout":
				a.TimeoutSeconds--
			case "commit":
				a.CommitID = "HEAD"
			case "workflow":
				a.ActionsPlan.WorkflowPath = "../workflow.yml"
			case "blob":
				a.ActionsPlan.WorkflowBlobID = strings.Repeat("d", 64)
			case "archive":
				archive = append(archive, 'x')
			case "digest":
				a.SourceSHA256 = strings.Repeat("0", 64)
			case "empty_image":
				image = ""
			case "cancelled":
				cancel()
			case "nil_executor":
				e = nil
			}
			manifest, metadata, err := c.prepareActionsGitSource(ctx, e, a, archive, image)
			if err == nil || manifest != nil || metadata != nil {
				t.Fatal("invalid assignment accepted")
			}
			if _, err := os.Stat(log); !os.IsNotExist(err) {
				t.Fatal("invalid source reached Docker")
			}
		})
	}
}
