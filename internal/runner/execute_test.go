package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testID() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func testArchive(t *testing.T, headers []*tar.Header) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "source.tar")
	f, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	w := tar.NewWriter(f)
	for _, h := range headers {
		if err = w.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Size > 0 {
			if _, err = w.Write(bytes.Repeat([]byte("x"), int(h.Size))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}
func testJob(t *testing.T) Job {
	return Job{AttemptID: testID(), JobID: "check", SourceCommit: strings.Repeat("a", 40), ImageDigest: "alpine@sha256:" + strings.Repeat("b", 64), Timeout: 10 * time.Second, Steps: []Step{{Script: "true", Shell: "sh"}}, SourceArchivePath: testArchive(t, []*tar.Header{{Name: "hello.txt", Typeflag: tar.TypeReg, Mode: 0777, Size: 3}})}
}
func TestSnapshotRejectsUnsafePathsAndLimits(t *testing.T) {
	cases := map[string][]*tar.Header{
		"parent": {{Name: "../escape", Typeflag: tar.TypeReg}}, "absolute": {{Name: "/escape", Typeflag: tar.TypeReg}}, "alias": {{Name: "a/../b", Typeflag: tar.TypeReg}}, "control": {{Name: "a\nb", Typeflag: tar.TypeReg}}, "symlink": {{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}}, "hardlink": {{Name: "link", Typeflag: tar.TypeLink, Linkname: "hello"}}, "device": {{Name: "device", Typeflag: tar.TypeChar}}, "duplicate": {{Name: "a", Typeflag: tar.TypeReg}, {Name: "a", Typeflag: tar.TypeReg}}, "file_parent": {{Name: "a", Typeflag: tar.TypeReg}, {Name: "a/b", Typeflag: tar.TypeReg}}, "late_file_parent": {{Name: "a/b", Typeflag: tar.TypeReg}, {Name: "a", Typeflag: tar.TypeReg}}, "bytes": {{Name: "a", Typeflag: tar.TypeReg, Size: 5}}, "entries": {{Name: "a", Typeflag: tar.TypeReg}, {Name: "b", Typeflag: tar.TypeReg}},
	}
	for name, headers := range cases {
		t.Run(name, func(t *testing.T) {
			job := testJob(t)
			job.SourceArchivePath = testArchive(t, headers)
			config := Config{WorkerID: "test-" + testID(), DockerBinary: "must-not-execute", ApprovedImages: []string{job.ImageDigest}}
			if name == "bytes" {
				config.MaxSourceBytes = 4
			}
			if name == "entries" {
				config.MaxSourceEntries = 1
			}
			e, _ := New(config)
			if _, err := e.Execute(context.Background(), job, nil); !errors.Is(err, ErrSource) {
				t.Fatalf("got %v", err)
			}
		})
	}
}
func TestSnapshotRewritesOwnershipAndNamespaces(t *testing.T) {
	job := testJob(t)
	e, _ := New(Config{WorkerID: "test-" + testID(), ApprovedImages: []string{job.ImageDigest}})
	data, err := e.snapshot(job)
	if err != nil {
		t.Fatal(err)
	}
	r := tar.NewReader(bytes.NewReader(data))
	files := map[string]*tar.Header{}
	for {
		h, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		files[h.Name] = h
		if h.Uid != 0 || h.Gid != 0 || h.Mode&0222 != 0 || h.Linkname != "" {
			t.Fatal("unsafe reconstructed metadata")
		}
	}
	if files["source/hello.txt"] == nil || files["source/hello.txt"].Mode != 0555 || files["steps/0"] == nil {
		t.Fatal("source and control namespaces missing")
	}
}
func TestRunnerRejectsUnapprovedOrMalformedJobsBeforeDocker(t *testing.T) {
	job := testJob(t)
	e, _ := New(Config{WorkerID: "test-" + testID(), DockerBinary: "must-not-execute", ApprovedImages: []string{job.ImageDigest}})
	for _, edit := range []func(*Job){func(j *Job) { j.ImageDigest = "alpine:latest" }, func(j *Job) { j.AttemptID = "../bad" }, func(j *Job) { j.SourceCommit = "main" }, func(j *Job) { j.Timeout = 16 * time.Minute }, func(j *Job) { j.Steps[0].Shell = "zsh" }, func(j *Job) { j.JobID = "bad\njob" }} {
		copy := job
		copy.Steps = append([]Step(nil), job.Steps...)
		edit(&copy)
		if _, err := e.Execute(context.Background(), copy, nil); !errors.Is(err, ErrInvalidJob) {
			t.Fatalf("got %v", err)
		}
	}
}

// Opt-in qualification uses only synthetic scripts on a local Docker daemon.
func TestDockerIsolation(t *testing.T) {
	image := os.Getenv("GOLF_RUNNER_TEST_IMAGE")
	if image == "" {
		t.Skip("set GOLF_RUNNER_TEST_IMAGE to an approved local Linux digest")
	}
	docker := os.Getenv("GOLF_RUNNER_TEST_DOCKER")
	if docker == "" {
		docker = "docker"
	}
	e, err := New(Config{WorkerID: "test-" + testID(), DockerBinary: docker, ApprovedImages: []string{image}})
	if err != nil {
		t.Fatal(err)
	}
	native := func(args ...string) []byte {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		data, err := exec.CommandContext(ctx, docker, args...).Output()
		if err != nil {
			t.Fatalf("native Docker %s failed", args[0])
		}
		return data
	}
	_ = native("image", "inspect", image) // Missing operator-preloaded images fail before any job case.
	clean := func(attempt string) {
		t.Helper()
		if len(bytes.TrimSpace(native("container", "ls", "--all", "--quiet", "--filter", "label="+attemptLabel+"="+attempt))) > 0 || len(bytes.TrimSpace(native("volume", "ls", "--quiet", "--filter", "label="+attemptLabel+"="+attempt))) > 0 {
			t.Fatal("owned fixture resource leaked")
		}
	}
	t.Setenv("GOLF_RUNNER_PRIVATE_SENTINEL", "not-a-job-credential")
	t.Run("nonroot_source_environment_resources_and_independent_steps", func(t *testing.T) {
		job := testJob(t)
		job.ImageDigest = image
		job.Timeout = 20 * time.Second
		job.Steps = []Step{{Shell: "default", Script: `test "$(id -u)" = 1000
 test -z "${GOLF_RUNNER_PRIVATE_SENTINEL:-}"
 test "$GOLF_SOURCE_COMMIT" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
 test "$GOLF_JOB_ID" = check
 test ! -S /var/run/docker.sock
 test ! -w /golf/source/hello.txt
 test ! -w /golf/source
 test ! -w /
 test "$(cat hello.txt)" = xxx
 printf changed >>hello.txt
 test "$(cat /golf/source/hello.txt)" = xxx
 test "$(ls /sys/class/net)" = lo
 grep -q 'NoNewPrivs:[[:space:]]*1' /proc/self/status
 grep -q 'CapEff:[[:space:]]*0000000000000000' /proc/self/status
 export STEP_PRIVATE=first
 printf 'stdout-marker\n'
 printf 'stderr-marker\n' >&2`}, {Shell: "sh", Script: `test -z "${STEP_PRIVATE:-}"; test "$(cat hello.txt)" = xxxchanged; printf 'second-step\n'`}}
		var events []StepEvent
		job.OnProgress = func(_ context.Context, e StepEvent) error { events = append(events, e); return nil }
		var stdout, stderr bytes.Buffer
		verified := false
		result, err := e.Execute(context.Background(), job, func(_ context.Context, c LogChunk) error {
			if c.Stream == "stdout" {
				stdout.Write(c.Data)
			} else {
				stderr.Write(c.Data)
			}
			if !verified {
				read := func(args ...string) ([]byte, error) {
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					return exec.CommandContext(ctx, docker, args...).Output()
				}
				rawIDs, err := read("container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label="+attemptLabel+"="+job.AttemptID)
				if err != nil {
					return err
				}
				ids := strings.Fields(string(rawIDs))
				if len(ids) != 1 {
					return errors.New("only one actual job container expected")
				}
				var values []struct {
					Config     struct{ User string }
					HostConfig struct {
						NetworkMode    string
						ReadonlyRootfs bool
						Privileged     bool
						CapDrop        []string
						SecurityOpt    []string
						NanoCpus       int64
						Memory         int64
						MemorySwap     int64
						PidsLimit      int64
						Binds          []string
						LogConfig      struct{ Type string }
					}
					Mounts []struct {
						Type, Destination string
						RW                bool
					}
				}
				inspection, err := read("container", "inspect", ids[0])
				if err != nil {
					return err
				}
				if json.Unmarshal(inspection, &values) != nil || len(values) != 1 {
					return errors.New("invalid inspection")
				}
				v := values[0]
				h := v.HostConfig
				if v.Config.User != "1000:1000" || h.NetworkMode != "none" || !h.ReadonlyRootfs || h.Privileged || h.Memory != 268435456 || h.MemorySwap != h.Memory || h.NanoCpus != 1_000_000_000 || h.PidsLimit != 64 || len(h.Binds) != 0 || h.LogConfig.Type != "none" || !strings.Contains(strings.Join(h.CapDrop, ","), "ALL") || !strings.Contains(strings.Join(h.SecurityOpt, ","), "no-new-privileges") {
					return errors.New("container isolation configuration differs")
				}
				for _, m := range v.Mounts {
					if m.Type == "bind" || (m.Destination == "/golf" && m.RW) {
						return errors.New("host bind or writable snapshot")
					}
				}
				verified = true
			}
			return nil
		})
		clean(job.AttemptID)
		if len(events) != 4 || events[0].Index != 0 || events[0].Kind != "started" || events[1].Kind != "finished" || events[1].ExitCode != 0 || events[2].Index != 1 || events[3].ExitCode != 0 {
			t.Fatal("worker progress differs", events)
		}
		if err != nil || result.ExitCode != 0 || !verified || !strings.Contains(stdout.String(), "second-step") || !strings.Contains(stderr.String(), "stderr-marker") {
			t.Fatalf("isolation failed result=%+v err=%v stdout=%q stderr=%q", result, err, stdout.String(), stderr.String())
		}
	})
	t.Run("nonzero_stops_later_steps", func(t *testing.T) {
		job := testJob(t)
		job.ImageDigest = image
		job.Steps = []Step{{Shell: "sh", Script: `printf '{"kind":"finished","stepIndex":1,"exitCode":0}'; exit 7`}, {Shell: "sh", Script: "printf must-not-run"}}
		var events []StepEvent
		job.OnProgress = func(_ context.Context, e StepEvent) error { events = append(events, e); return nil }
		var logs bytes.Buffer
		r, err := e.Execute(context.Background(), job, func(_ context.Context, c LogChunk) error { logs.Write(c.Data); return nil })
		clean(job.AttemptID)
		if len(events) != 2 || events[0].Index != 0 || events[1].Kind != "finished" || events[1].ExitCode != 7 {
			t.Fatal("stdout spoofed progress or later step ran", events)
		}
		if err != nil || r.ExitCode != 7 || strings.Contains(logs.String(), "must-not-run") {
			t.Fatalf("result=%+v err=%v", r, err)
		}
	})
	t.Run("shared_gitlab_shell", func(t *testing.T) {
		job := testJob(t)
		job.ImageDigest = image
		job.Steps = []Step{{Shell: "sh", Script: "value=shared\ntest \"$value\" = shared"}}
		r, err := e.Execute(context.Background(), job, nil)
		clean(job.AttemptID)
		if err != nil || r.ExitCode != 0 {
			t.Fatalf("result=%+v err=%v", r, err)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		job := testJob(t)
		job.ImageDigest = image
		job.Timeout = 2 * time.Second
		job.Steps = []Step{{Shell: "sh", Script: "sleep 30"}}
		r, err := e.Execute(context.Background(), job, nil)
		clean(job.AttemptID)
		if err != nil || !r.TimedOut || r.ExitCode == 0 {
			t.Fatalf("result=%+v err=%v", r, err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		job := testJob(t)
		job.ImageDigest = image
		job.Steps = []Step{{Shell: "sh", Script: "printf ready; sleep 30"}}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		r, err := e.Execute(ctx, job, func(_ context.Context, c LogChunk) error { cancel(); return nil })
		clean(job.AttemptID)
		if err != nil || !r.Cancelled || r.ExitCode == 0 {
			t.Fatalf("result=%+v err=%v", r, err)
		}
	})
	t.Run("bounded_logs_kill", func(t *testing.T) {
		job := testJob(t)
		job.ImageDigest = image
		job.Steps = []Step{{Shell: "sh", Script: "while true; do printf 'excessive-output-'; done"}}
		bounded, _ := New(Config{WorkerID: "test-" + testID(), DockerBinary: docker, ApprovedImages: []string{image}, MaxLogBytes: 32})
		count := 0
		r, err := bounded.Execute(context.Background(), job, func(_ context.Context, c LogChunk) error { count += len(c.Data); return nil })
		clean(job.AttemptID)
		if err != nil || !r.LogLimitExceeded || !r.LogsTruncated || count > 32 || r.ExitCode == 0 {
			t.Fatalf("result=%+v bytes=%d err=%v", r, count, err)
		}
	})
	t.Run("callback_failure_kills", func(t *testing.T) {
		job := testJob(t)
		job.ImageDigest = image
		job.Steps = []Step{{Shell: "sh", Script: "printf ready; sleep 30"}}
		_, err := e.Execute(context.Background(), job, func(context.Context, LogChunk) error { return errors.New("fixture delivery failure") })
		clean(job.AttemptID)
		if !errors.Is(err, ErrInfrastructure) {
			t.Fatalf("err=%v", err)
		}
	})
}

func TestRunnerCrashChild(t *testing.T) {
	if os.Getenv("GOLF_RUNNER_CRASH_CHILD") != "yes" {
		t.Skip("subprocess fixture only")
	}
	image := os.Getenv("GOLF_RUNNER_TEST_IMAGE")
	e, err := New(Config{WorkerID: os.Getenv("GOLF_RUNNER_CRASH_WORKER"), DockerBinary: os.Getenv("GOLF_RUNNER_TEST_DOCKER"), ApprovedImages: []string{image}})
	if err != nil {
		t.Fatal(err)
	}
	job := Job{AttemptID: os.Getenv("GOLF_RUNNER_CRASH_ATTEMPT"), JobID: "crash", SourceCommit: strings.Repeat("a", 40), ImageDigest: image, SourceArchivePath: os.Getenv("GOLF_RUNNER_CRASH_ARCHIVE"), Timeout: 60 * time.Second, Steps: []Step{{Shell: "sh", Script: "sleep 60"}}}
	if _, err = e.Execute(context.Background(), job, nil); err != nil {
		t.Fatal(err)
	}
}

func TestDockerExplicitCrashRecovery(t *testing.T) {
	image := os.Getenv("GOLF_RUNNER_TEST_IMAGE")
	if image == "" {
		t.Skip("set GOLF_RUNNER_TEST_IMAGE to qualify native crash recovery")
	}
	docker := os.Getenv("GOLF_RUNNER_TEST_DOCKER")
	if docker == "" {
		docker = "docker"
	}
	worker, attempt := "crash-"+testID(), testID()
	e, err := New(Config{WorkerID: worker, DockerBinary: docker, ApprovedImages: []string{image}})
	if err != nil {
		t.Fatal(err)
	}
	archive := testArchive(t, []*tar.Header{{Name: "file", Typeflag: tar.TypeReg, Mode: 0644, Size: 1}})
	child := exec.Command(os.Args[0], "-test.run=^TestRunnerCrashChild$", "-test.timeout=70s")
	child.Env = append(os.Environ(), "GOLF_RUNNER_CRASH_CHILD=yes", "GOLF_RUNNER_CRASH_WORKER="+worker, "GOLF_RUNNER_CRASH_ATTEMPT="+attempt, "GOLF_RUNNER_CRASH_ARCHIVE="+archive)
	child.Stdout = io.Discard
	child.Stderr = io.Discard
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if child.ProcessState == nil {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
		if err := e.CleanupWorker(context.Background()); err != nil {
			t.Error("crash fixture cleanup failed")
		}
	}()
	read := func(args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, docker, args...).Output()
	}

	otherWorker, otherAttempt, otherOwner := "other-"+testID(), testID(), testID()
	otherVolume := "golf-source-" + otherAttempt + "-" + otherOwner
	labels := []string{"--label", managedLabel + "=true", "--label", workerLabel + "=" + otherWorker, "--label", attemptLabel + "=" + otherAttempt, "--label", ownerLabel + "=" + otherOwner}
	args := append([]string{"volume", "create"}, labels...)
	args = append(args, otherVolume)
	if _, err := read(args...); err != nil {
		t.Fatal("other-worker volume fixture failed")
	}
	defer func() {
		if _, err := read("volume", "rm", otherVolume); err != nil {
			t.Error("other-worker volume cleanup failed")
		}
	}()
	args = append([]string{"container", "create", "--network=none", "--read-only", "--user=1000:1000", "--cap-drop=ALL"}, labels...)
	args = append(args, "--entrypoint=/bin/sh", image, "-c", "true")
	otherContainerBytes, err := read(args...)
	if err != nil {
		t.Fatal("other-worker stopped fixture failed")
	}
	otherContainer := strings.TrimSpace(string(otherContainerBytes))
	defer func() {
		if _, err := read("container", "rm", otherContainer); err != nil {
			t.Error("other-worker container cleanup failed")
		}
	}()
	deadline := time.Now().Add(15 * time.Second)
	running := ""
	for time.Now().Before(deadline) {
		data, err := read("container", "ls", "--quiet", "--no-trunc", "--filter", "label="+workerLabel+"="+worker)
		if err != nil {
			t.Fatal("native list failed")
		}
		running = strings.TrimSpace(string(data))
		if running != "" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !containerPattern.MatchString(running) {
		t.Fatal("crash job never entered running state")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	var records []containerInfo
	data, err := read("container", "inspect", running)
	if err != nil || json.Unmarshal(data, &records) != nil || len(records) != 1 || !records[0].State.Running {
		t.Fatal("test did not observe the SIGKILL orphan")
	}
	// Recovery is local cleanup only here; coordinator fencing is tested separately
	// by its real PostgreSQL transport contract before the command invokes it.
	if err = e.CleanupWorker(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := read("container", "inspect", otherContainer); err != nil {
		t.Fatal("recovery deleted another worker container")
	}
	if _, err := read("volume", "inspect", otherVolume); err != nil {
		t.Fatal("recovery deleted another worker volume")
	}
	for _, kind := range []string{"container", "volume"} {
		args := []string{kind, "ls", "--quiet", "--filter", "label=" + workerLabel + "=" + worker}
		if kind == "container" {
			args = append(args, "--all")
		}
		data, err := read(args...)
		if err != nil || len(bytes.TrimSpace(data)) != 0 {
			t.Fatal("crashed worker resources remain")
		}
	}
}
