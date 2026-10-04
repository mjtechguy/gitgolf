// Package runner executes Golf's bounded shell subset on a dedicated Docker host.
// It has no forge credentials, scheduler authority or provider-engine compatibility claim.
package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const workerLabel = "io.golf.runner.worker"
const managedLabel = "io.golf.runner.managed"
const attemptLabel = "io.golf.runner.attempt"
const ownerLabel = "io.golf.runner.owner"

var workerPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
var attemptPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var commitPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var imagePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$`)
var imageIDPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var containerPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

var ErrInvalidJob = errors.New("runner job or operator configuration is invalid")
var ErrInfrastructure = errors.New("runner Docker operation failed")
var ErrCleanup = errors.New("runner cleanup failed; inspect labeled resources before reusing the host")
var ErrSource = errors.New("source archive exceeds the supported safe snapshot contract")

// Images must already exist on the dedicated daemon; jobs cannot cause registry pulls.
type Config struct {
	WorkerID         string
	DockerBinary     string
	ApprovedImages   []string
	MaxSourceBytes   int64
	MaxSourceEntries int
	MaxLogBytes      int64
}
type Step struct {
	Script string `json:"script"`
	Shell  string `json:"shell"`
}
type StepEvent struct {
	Index    int
	Kind     string
	ExitCode int
}
type Job struct {
	AttemptID         string                                 `json:"attempt_id"`
	JobID             string                                 `json:"job_id"`
	SourceCommit      string                                 `json:"source_commit"`
	ImageDigest       string                                 `json:"image_digest"`
	Steps             []Step                                 `json:"steps"`
	Timeout           time.Duration                          `json:"-"`
	SourceArchivePath string                                 `json:"-"`
	OnProgress        func(context.Context, StepEvent) error `json:"-"`
}
type LogChunk struct {
	Stream string `json:"stream"`
	Data   []byte `json:"data"`
}
type Result struct {
	ExitCode         int  `json:"exit_code"`
	TimedOut         bool `json:"timed_out"`
	Cancelled        bool `json:"cancelled"`
	LogsTruncated    bool `json:"logs_truncated"`
	LogLimitExceeded bool `json:"log_limit_exceeded"`
}
type Executor struct{ config Config }

func New(config Config) (*Executor, error) {
	if !workerPattern.MatchString(config.WorkerID) {
		return nil, ErrInvalidJob
	}
	if config.DockerBinary == "" {
		config.DockerBinary = "docker"
	}
	if config.MaxSourceBytes == 0 {
		config.MaxSourceBytes = 16 << 20
	}
	if config.MaxSourceEntries == 0 {
		config.MaxSourceEntries = 4096
	}
	if config.MaxLogBytes == 0 {
		config.MaxLogBytes = 256 << 10
	}
	if config.MaxSourceBytes < 1 || config.MaxSourceBytes > 16<<20 || config.MaxSourceEntries < 1 || config.MaxSourceEntries > 4096 || config.MaxLogBytes < 1 || config.MaxLogBytes > 1<<20 || len(config.ApprovedImages) == 0 {
		return nil, ErrInvalidJob
	}
	for _, image := range config.ApprovedImages {
		if !imagePattern.MatchString(image) && !imageIDPattern.MatchString(image) {
			return nil, ErrInvalidJob
		}
	}
	config.ApprovedImages = append([]string(nil), config.ApprovedImages...)
	return &Executor{config}, nil
}
func (e *Executor) validate(job Job) error {
	allowed := false
	for _, image := range e.config.ApprovedImages {
		allowed = allowed || image == job.ImageDigest
	}
	if !allowed || !attemptPattern.MatchString(job.AttemptID) || !commitPattern.MatchString(job.SourceCommit) || job.JobID == "" || len(job.JobID) > 255 || !utf8.ValidString(job.JobID) || strings.IndexFunc(job.JobID, unicode.IsControl) >= 0 || job.Timeout < time.Second || job.Timeout > 15*time.Minute || len(job.Steps) < 1 || len(job.Steps) > 50 {
		return ErrInvalidJob
	}
	total := 0
	for _, step := range job.Steps {
		total += len(step.Script)
		if strings.TrimSpace(step.Script) == "" || !utf8.ValidString(step.Script) || strings.IndexByte(step.Script, 0) >= 0 || (step.Shell != "default" && step.Shell != "sh" && step.Shell != "bash") {
			return ErrInvalidJob
		}
	}
	if total > 64<<10 {
		return ErrInvalidJob
	}
	return nil
}

// snapshot reconstructs a new tar in memory. It never extracts repository paths
// on the host and strips caller-supplied ownership, links and metadata.
func (e *Executor) snapshot(job Job) ([]byte, error) {
	file, err := os.Open(job.SourceArchivePath)
	if err != nil {
		return nil, ErrSource
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > e.config.MaxSourceBytes+int64(e.config.MaxSourceEntries)*2048+10240 {
		return nil, ErrSource
	}
	reader := tar.NewReader(file)
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	seen := map[string]byte{}
	total := int64(0)
	entries := 0
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, ErrSource
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" || name == "." || path.Clean(name) != name || strings.HasPrefix(name, "/") || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") || len(name) > 1024 || !utf8.ValidString(name) || strings.IndexFunc(name, unicode.IsControl) >= 0 || header.Linkname != "" || (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir) || header.Size < 0 || header.Size > 8<<20 {
			return nil, ErrSource
		}
		entries++
		total += header.Size
		if entries > e.config.MaxSourceEntries || total > e.config.MaxSourceBytes {
			return nil, ErrSource
		}
		if _, ok := seen[name]; ok {
			return nil, ErrSource
		}
		seen[name] = header.Typeflag
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if kind, ok := seen[parent]; ok && kind != tar.TypeDir {
				return nil, ErrSource
			}
		}
		if header.Typeflag == tar.TypeReg {
			for previous := range seen {
				if strings.HasPrefix(previous, name+"/") {
					return nil, ErrSource
				}
			}
		}
		mode := int64(0444)
		if header.Mode&0111 != 0 {
			mode = 0555
		}
		if header.Typeflag == tar.TypeDir {
			if header.Size != 0 {
				return nil, ErrSource
			}
			mode = 0555
		}
		clean := &tar.Header{Name: "source/" + name, Typeflag: header.Typeflag, Mode: mode, Size: header.Size, Uid: 0, Gid: 0}
		if err := writer.WriteHeader(clean); err != nil {
			return nil, ErrSource
		}
		if _, err := io.CopyN(writer, reader, header.Size); err != nil {
			return nil, ErrSource
		}
	}
	trailing, err := io.ReadAll(io.LimitReader(file, int64(e.config.MaxSourceEntries)*2048+10241))
	if err != nil || len(bytes.Trim(trailing, "\x00")) != 0 {
		return nil, ErrSource
	}
	// Source may be empty, but its directory always exists. Parent directories not
	// explicitly represented in a tar are created by Docker's native extraction.
	if err := writer.WriteHeader(&tar.Header{Name: "source/", Typeflag: tar.TypeDir, Mode: 0555}); err != nil {
		return nil, ErrSource
	}
	for index, step := range job.Steps {
		if err := writer.WriteHeader(&tar.Header{Name: fmt.Sprintf("steps/%d", index), Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(step.Script))}); err != nil {
			return nil, ErrSource
		}
		if _, err := writer.Write([]byte(step.Script)); err != nil {
			return nil, ErrSource
		}
	}
	if err := writer.Close(); err != nil {
		return nil, ErrSource
	}
	return buffer.Bytes(), nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len()+n > b.limit {
		return 0, errors.New("bounded Docker output exceeded")
	}
	return b.Buffer.Write(p)
}
func (e *Executor) command(ctx context.Context, input io.Reader, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, e.config.DockerBinary, args...)
	out := &limitedBuffer{limit: 64 << 10}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.Stdin = input
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		return nil, ErrInfrastructure
	}
	return out.Bytes(), nil
}
func (e *Executor) inspect(ctx context.Context, kind, id string, target any) error {
	data, err := e.command(ctx, nil, kind, "inspect", id)
	if err != nil {
		return err
	}
	if json.Unmarshal(data, target) != nil {
		return ErrInfrastructure
	}
	return nil
}

type containerInfo struct {
	ID     string
	Config struct{ Labels map[string]string }
	State  struct {
		Running  bool
		ExitCode int
	}
}
type volumeInfo struct {
	Name   string
	Labels map[string]string
}

func owned(labels map[string]string, attempt, owner, worker string) bool {
	return labels[managedLabel] == "true" && labels[attemptLabel] == attempt && labels[ownerLabel] == owner && labels[workerLabel] == worker
}
func (e *Executor) removeContainer(ctx context.Context, id, attempt, owner string) error {
	var records []containerInfo
	if e.inspect(ctx, "container", id, &records) != nil || len(records) != 1 || records[0].ID != id || !owned(records[0].Config.Labels, attempt, owner, e.config.WorkerID) {
		return ErrCleanup
	}
	_, err := e.command(ctx, nil, "container", "rm", "--force", "--volumes", id)
	return err
}
func (e *Executor) removeVolume(ctx context.Context, id, attempt, owner string) error {
	var records []volumeInfo
	if e.inspect(ctx, "volume", id, &records) != nil || len(records) != 1 || records[0].Name != id || !owned(records[0].Labels, attempt, owner, e.config.WorkerID) {
		return ErrCleanup
	}
	_, err := e.command(ctx, nil, "volume", "rm", id)
	return err
}
func stepCommand(index int, step Step) string {
	file := "/golf/steps/" + strconv.Itoa(index)
	switch step.Shell {
	case "sh":
		return "exec /bin/sh -e " + file
	case "bash":
		return "exec /bin/bash --noprofile --norc -e -o pipefail " + file
	default:
		return "if command -v bash >/dev/null 2>&1; then exec bash -e " + file + "; else exec /bin/sh -e " + file + "; fi"
	}
}

type logSink struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	limit    int64
	count    int64
	exceeded bool
	failed   bool
	onLog    func(context.Context, LogChunk) error
}
type streamWriter struct {
	sink   *logSink
	stream string
}

func (w streamWriter) Write(p []byte) (int, error) {
	s := w.sink
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(p)
	if s.exceeded || s.failed {
		return n, nil
	}
	if int64(n) > s.limit-s.count {
		s.exceeded = true
		s.cancel()
		return n, nil
	}
	s.count += int64(n)
	for len(p) > 0 {
		size := min(len(p), 8192)
		if s.onLog != nil && s.onLog(s.ctx, LogChunk{Stream: w.stream, Data: append([]byte(nil), p[:size]...)}) != nil {
			s.failed = true
			s.cancel()
			break
		}
		p = p[size:]
	}
	return n, nil
}

// Execute never forwards runner environment variables into the job. The callback
// must honor its context and finish promptly; its error cancels the attempt.
func (e *Executor) Execute(ctx context.Context, job Job, onLog func(context.Context, LogChunk) error) (result Result, err error) {
	result.ExitCode = -1
	if err = e.validate(job); err != nil {
		return
	}
	archive, archiveErr := e.snapshot(job)
	if archiveErr != nil {
		return result, archiveErr
	}
	ownerBytes := make([]byte, 16)
	if _, err = rand.Read(ownerBytes); err != nil {
		return result, ErrInfrastructure
	}
	owner := hex.EncodeToString(ownerBytes)
	volume := "golf-source-" + job.AttemptID + "-" + owner
	var helper, container string
	volumeCreated := false
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		failed := false
		if container != "" {
			failed = e.removeContainer(cleanup, container, job.AttemptID, owner) != nil || failed
		}
		if helper != "" {
			failed = e.removeContainer(cleanup, helper, job.AttemptID, owner) != nil || failed
		}
		if volumeCreated {
			failed = e.removeVolume(cleanup, volume, job.AttemptID, owner) != nil || failed
		}
		if failed {
			err = ErrCleanup
		}
	}()
	runCtx, stop := context.WithTimeout(ctx, job.Timeout)
	defer stop()
	var images []struct {
		ID     string
		Os     string
		Config struct{ Volumes map[string]json.RawMessage }
	}
	if e.inspect(runCtx, "image", job.ImageDigest, &images) != nil || len(images) != 1 || !imageIDPattern.MatchString(images[0].ID) || images[0].Os != "linux" || len(images[0].Config.Volumes) != 0 {
		return result, ErrInfrastructure
	}
	labels := []string{"--label", workerLabel + "=" + e.config.WorkerID, "--label", managedLabel + "=true", "--label", attemptLabel + "=" + job.AttemptID, "--label", ownerLabel + "=" + owner}
	args := append([]string{"volume", "create"}, labels...)
	args = append(args, volume)
	if _, err = e.command(runCtx, nil, args...); err != nil {
		return
	}
	volumeCreated = true
	create := func(readonly bool) (string, error) {
		args := []string{"container", "create", "--pull=never", "--network=none", "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--cpus=1", "--memory=268435456", "--memory-swap=268435456", "--pids-limit=64", "--restart=no", "--no-healthcheck", "--log-driver=none"}
		args = append(args, labels...)
		mount := "type=volume,src=" + volume + ",dst=/golf,volume-nocopy"
		if readonly {
			mount += ",readonly"
			args = append(args, "--read-only", "--init", "--tmpfs", "/workspace:rw,nosuid,nodev,size=134217728,mode=0700,uid=1000,gid=1000", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=33554432,mode=1777", "--workdir=/workspace")
		}
		args = append(args, "--mount", mount, "--entrypoint=/usr/bin/env", images[0].ID, "-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/tmp", "GOLF_SOURCE_COMMIT="+job.SourceCommit, "GOLF_JOB_ID="+job.JobID, "/bin/sh", "-c", "while :; do sleep 3600; done")
		data, err := e.command(runCtx, nil, args...)
		id := strings.TrimSpace(string(data))
		if err != nil || !containerPattern.MatchString(id) {
			return "", ErrInfrastructure
		}
		return id, nil
	}
	if helper, err = create(false); err != nil {
		return
	}
	if _, err = e.command(runCtx, bytes.NewReader(archive), "container", "cp", "-a", "-", helper+":/golf"); err != nil {
		return
	}
	if err = e.removeContainer(runCtx, helper, job.AttemptID, owner); err != nil {
		return
	}
	helper = ""
	if container, err = create(true); err != nil {
		return
	}
	if _, err = e.command(runCtx, nil, "container", "start", container); err != nil {
		return
	}
	// Each native exec has a fresh explicit environment. Docker exec otherwise
	// inherits image/container variables; worker credentials never enter the job.
	execArgs := func(command string) []string {
		return []string{"container", "exec", "--user=1000:1000", "--workdir=/workspace", container, "/usr/bin/env", "-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/tmp", "GOLF_SOURCE_COMMIT=" + job.SourceCommit, "GOLF_JOB_ID=" + job.JobID, "/bin/sh", "-c", command}
	}
	if _, err = e.command(runCtx, nil, execArgs("set -e\ncp -R /golf/source/. /workspace/\nchmod -R u+w /workspace")...); err != nil {
		return
	}
	attachCtx, cancel := context.WithCancel(runCtx)
	defer cancel()
	sink := &logSink{ctx: attachCtx, cancel: cancel, limit: e.config.MaxLogBytes, onLog: onLog}
	for index, step := range job.Steps {
		if job.OnProgress != nil && job.OnProgress(attachCtx, StepEvent{Index: index, Kind: "started"}) != nil {
			return result, ErrInfrastructure
		}
		cmd := exec.CommandContext(attachCtx, e.config.DockerBinary, execArgs(stepCommand(index, step))...)
		cmd.Stdout = streamWriter{sink, "stdout"}
		cmd.Stderr = streamWriter{sink, "stderr"}
		cmd.WaitDelay = 2 * time.Second
		commandErr := cmd.Run()
		sink.mu.Lock()
		result.LogLimitExceeded = sink.exceeded
		result.LogsTruncated = sink.exceeded
		callbackFailed := sink.failed
		sink.mu.Unlock()
		result.TimedOut = errors.Is(runCtx.Err(), context.DeadlineExceeded)
		result.Cancelled = ctx.Err() != nil && !result.TimedOut
		if callbackFailed {
			return result, ErrInfrastructure
		}
		if result.LogLimitExceeded || result.TimedOut || result.Cancelled {
			return result, nil
		}
		// A lost/removed/stopped container is infrastructure loss, not a completed
		// step. Report native CLI outcomes only while the owned job remains alive.
		var records []containerInfo
		if e.inspect(runCtx, "container", container, &records) != nil || len(records) != 1 || records[0].ID != container || !records[0].State.Running || !owned(records[0].Config.Labels, job.AttemptID, owner, e.config.WorkerID) {
			return result, ErrInfrastructure
		}
		result.ExitCode = 0
		if commandErr != nil {
			var exited *exec.ExitError
			if !errors.As(commandErr, &exited) || exited.ExitCode() < 0 || exited.ExitCode() > 255 {
				return result, ErrInfrastructure
			}
			result.ExitCode = exited.ExitCode()
		}
		if job.OnProgress != nil && job.OnProgress(attachCtx, StepEvent{Index: index, Kind: "finished", ExitCode: result.ExitCode}) != nil {
			return result, ErrInfrastructure
		}
		if result.ExitCode != 0 {
			return result, nil
		}
	}

	return result, nil
}

// CleanupWorker is an explicit operator recovery action, not an automatic startup
// sweep. Fence the coordinator's old attempts and stop all processes sharing this
// worker enrollment before calling it. It never touches other workers' labels.
func (e *Executor) CleanupWorker(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	filters := []string{"--filter", "label=" + managedLabel + "=true", "--filter", "label=" + workerLabel + "=" + e.config.WorkerID}
	args := append([]string{"container", "ls", "--all", "--quiet", "--no-trunc"}, filters...)
	data, err := e.command(ctx, nil, args...)
	if err != nil {
		return ErrCleanup
	}
	for _, id := range strings.Fields(string(data)) {
		if !containerPattern.MatchString(id) {
			return ErrCleanup
		}
		var values []containerInfo
		if e.inspect(ctx, "container", id, &values) != nil || len(values) != 1 {
			return ErrCleanup
		}
		labels := values[0].Config.Labels
		if !attemptPattern.MatchString(labels[attemptLabel]) || !attemptPattern.MatchString(labels[ownerLabel]) || e.removeContainer(ctx, id, labels[attemptLabel], labels[ownerLabel]) != nil {
			return ErrCleanup
		}
	}
	args = append([]string{"volume", "ls", "--quiet"}, filters...)
	data, err = e.command(ctx, nil, args...)
	if err != nil {
		return ErrCleanup
	}
	for _, name := range strings.Fields(string(data)) {
		var values []volumeInfo
		if e.inspect(ctx, "volume", name, &values) != nil || len(values) != 1 {
			return ErrCleanup
		}
		labels := values[0].Labels
		if !attemptPattern.MatchString(labels[attemptLabel]) || !attemptPattern.MatchString(labels[ownerLabel]) || name != "golf-source-"+labels[attemptLabel]+"-"+labels[ownerLabel] || e.removeVolume(ctx, name, labels[attemptLabel], labels[ownerLabel]) != nil {
			return ErrCleanup
		}
	}
	return nil
}
