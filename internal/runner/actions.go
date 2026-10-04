package runner

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// actionsStageError carries an operator-only fixed classification. The cause is
// preserved for existing error policy, but never formatted into diagnostics.
type actionsStageError struct {
	stage string
	cause error
}

func (e *actionsStageError) Error() string {
	return "runner Actions lifecycle failed at " + ActionsFailureStage(e)
}
func (e *actionsStageError) Unwrap() error { return e.cause }

// ActionsFailureStage never returns provider text, commands, source or IDs.
func ActionsFailureStage(err error) string {
	var classified *actionsStageError
	if !errors.As(err, &classified) {
		return ""
	}
	switch classified.stage {
	case "input_validation", "worker_residue_check", "daemon_image_validation", "job_image_validation", "owner_generation", "volume_creation", "daemon_creation", "daemon_receipt_validation", "daemon_start", "daemon_readiness", "image_transfer", "helper_transfer", "helper_local_hash", "helper_remote_hash", "helper_process_start", "helper_input", "helper_frames", "durable_frame_ack", "helper_ack_write", "helper_completion", "container_cleanup", "volume_cleanup":
		return classified.stage
	default:
		if ActionsEngineFailureDiagnostic(classified.stage) != "" {
			return classified.stage
		}
		return "unknown"
	}
}

// The separately pinned helper owns stderr exclusively. Only this closed line
// is an operator diagnostic; arbitrary native/source stderr is never exposed.
func ActionsEngineFailureDiagnostic(stage string) string {
	switch stage {
	case "engine_input_validation", "engine_environment_validation", "engine_plan_binding",
		"engine_daemon_empty", "engine_image_map_validation", "engine_image_receipt_validation",
		"engine_workspace_open", "engine_source_extract", "engine_job_source_open", "engine_job_source_copy",
		"engine_event_write", "engine_native_execution", "engine_observation", "engine_graph_completion",
		"engine_inner_cleanup", "engine_completion_ack", "engine_job_inventory", "engine_job_receipt",
		"engine_job_shape", "engine_job_environment", "engine_job_mounts", "engine_job_source_transfer",
		"engine_job_volume_ownership", "engine_job_action_ancestors", "engine_job_source_readback",
		"engine_native_executor_init", "engine_native_executor_return", "engine_native_result_missing",
		"engine_native_setup_missing", "engine_native_result_conflict":
		return "GOLF_ACTIONS_FAILURE_STAGE=" + stage + "\n"
	default:
		return ""
	}
}

// Any overflow invalidates the entire diagnostic, including an earlier valid
// line. Consume/discard excess so stderr cannot block or grow without bound.
type actionsEngineDiagnostic struct {
	data    []byte
	invalid bool
}

func (b *actionsEngineDiagnostic) Write(p []byte) (int, error) {
	if b.invalid || len(b.data)+len(p) > 128 {
		b.invalid = true
		b.data = nil
	} else {
		b.data = append(b.data, p...)
	}
	return len(p), nil
}

func parseActionsEngineFailure(data []byte) string {
	if len(data) > 128 || !bytes.HasPrefix(data, []byte("GOLF_ACTIONS_FAILURE_STAGE=")) || !bytes.HasSuffix(data, []byte("\n")) {
		return ""
	}
	stage := string(data[len("GOLF_ACTIONS_FAILURE_STAGE=") : len(data)-1])
	if diagnostic := ActionsEngineFailureDiagnostic(stage); diagnostic != "" && diagnostic == string(data) {
		return stage
	}
	return ""
}

type ActionsExecutor struct {
	executor *Executor
	helper   string
}

func NewActions(e *Executor, helper string) (*ActionsExecutor, error) {
	if e == nil || !filepath.IsAbs(helper) || filepath.Clean(helper) != helper {
		return nil, ErrInvalidJob
	}
	info, err := os.Stat(helper)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return nil, ErrInvalidJob
	}
	return &ActionsExecutor{e, helper}, nil
}

// Execute owns a whole fresh daemon/data volume for this single attempt. It
// never restarts source on errors. Explicit existing worker recovery fences old
// attempts and removes these same enrollment/attempt/owner labeled resources.
func (a *ActionsExecutor) Execute(ctx context.Context, attempt string, input ActionExecutionInput, onFrame func(context.Context, ActionFrame) error) (result Result, err error) {
	result.ExitCode = 255
	phase := "input_validation"
	defer func() {
		if err != nil {
			err = &actionsStageError{phase, err}
		}
	}()
	if input.JobResources != nil && (input.JobResources.Validate() != nil || input.TimeoutSeconds != int(input.JobResources.Limits.TimeoutSeconds)) {
		return result, ErrInvalidJob
	}
	if input.ExecutionEnvironment.Validate() != nil || !attemptPattern.MatchString(attempt) || input.Plan.Catalog != ActionsCatalog || input.Plan.ArchiveSHA256 == "" || input.TimeoutSeconds < 1 || input.TimeoutSeconds > 900 || onFrame == nil {
		return result, ErrInvalidJob
	}
	archiveSHA := sha256.Sum256(input.Input.Archive)
	if hex.EncodeToString(archiveSHA[:]) != input.Plan.ArchiveSHA256 {
		return result, ErrInvalidJob
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(input.TimeoutSeconds)*time.Second)
	defer cancel()
	e := a.executor
	phase = "worker_residue_check"
	if err = e.RequireCleanWorker(runCtx); err != nil {
		return result, err
	}
	phase = "daemon_image_validation"
	var daemonImage []struct {
		ID, Architecture, Os string
		RepoDigests          []string
	}
	if e.inspect(runCtx, "image", ActionsDaemonImage, &daemonImage) != nil || len(daemonImage) != 1 || !imageIDPattern.MatchString(daemonImage[0].ID) || daemonImage[0].Architecture != runtime.GOARCH || daemonImage[0].Os != "linux" {
		return result, ErrInfrastructure
	}
	allowedDaemon := false
	for _, digest := range daemonImage[0].RepoDigests {
		allowedDaemon = allowedDaemon || RegistryDigestMatches(ActionsDaemonImage, digest)
	}
	if !allowedDaemon {
		return result, ErrInfrastructure
	}
	phase = "job_image_validation"
	images := map[string]string{}
	var imageBytes int64
	for _, job := range input.Plan.Jobs {
		approved := false
		for _, image := range e.config.ApprovedImages {
			approved = approved || image == job.Image
		}
		if !approved {
			return result, ErrInvalidJob
		}
		if images[job.Image] != "" {
			continue
		}

		var rows []struct {
			ID, Architecture, Os string
			RepoDigests          []string
			Size                 int64
		}
		if e.inspect(runCtx, "image", job.Image, &rows) != nil || len(rows) != 1 || !imageIDPattern.MatchString(rows[0].ID) || rows[0].Architecture != runtime.GOARCH || rows[0].Os != "linux" || rows[0].Size < 1 {
			return result, ErrInfrastructure
		}
		found := false
		for _, digest := range rows[0].RepoDigests {
			found = found || RegistryDigestMatches(job.Image, digest)
		}
		if !found {
			return result, ErrInfrastructure
		}
		images[job.Image] = rows[0].ID
		imageBytes += rows[0].Size
		if imageBytes > 1<<30 {
			return result, ErrInvalidJob
		}
	}
	phase = "owner_generation"
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		return result, ErrInfrastructure
	}
	owner := hex.EncodeToString(random)
	volume := "golf-source-" + attempt + "-" + owner
	container := ""
	defer func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if container != "" && e.removeContainer(cleanupCtx, container, attempt, owner) != nil {
			phase = "container_cleanup"
			err = ErrCleanup
			return
		}
		if e.removeVolume(cleanupCtx, volume, attempt, owner) != nil {
			phase = "volume_cleanup"
			err = ErrCleanup
		}
		result.TimedOut = errors.Is(runCtx.Err(), context.DeadlineExceeded)
		result.Cancelled = ctx.Err() != nil && !result.TimedOut
	}()
	labels := []string{"--label", managedLabel + "=true", "--label", workerLabel + "=" + e.config.WorkerID, "--label", attemptLabel + "=" + attempt, "--label", ownerLabel + "=" + owner}
	phase = "volume_creation"
	if _, err = e.command(runCtx, nil, append(append([]string{"volume", "create"}, labels...), volume)...); err != nil {
		return result, ErrInfrastructure
	}
	args := append([]string{"container", "create"}, labels...)
	args = append(args, "--network=none", "--privileged", "--memory=1073741824", "--memory-swap=1073741824", "--cpus=2", "--pids-limit=512", "--mount", "type=volume,source="+volume+",target=/var/lib/docker", "--tmpfs", "/golf:rw,size=134217728,mode=0755", "--env", "DOCKER_TLS_CERTDIR=", "--entrypoint", "dockerd-entrypoint.sh", daemonImage[0].ID, "dockerd", "--host=unix:///var/run/docker.sock", "--iptables=false", "--ip-masq=false", "--bridge=none")
	phase = "daemon_creation"
	body, err := e.command(runCtx, nil, args...)
	if err != nil {
		return result, ErrInfrastructure
	}
	container = strings.TrimSpace(string(body))
	if !containerPattern.MatchString(container) {
		container = ""
		return result, ErrInfrastructure
	}
	phase = "daemon_receipt_validation"
	if err = a.verifyDaemon(runCtx, container, daemonImage[0].ID, volume, attempt, owner); err != nil {
		return result, err
	}
	phase = "daemon_start"
	if _, err = e.command(runCtx, nil, "container", "start", container); err != nil {
		return result, ErrInfrastructure
	}
	phase = "daemon_readiness"
	deadline := time.Now().Add(30 * time.Second)
	ready := false
	for time.Now().Before(deadline) && runCtx.Err() == nil {
		if _, err = e.command(runCtx, nil, "exec", container, "docker", "info"); err == nil {
			ready = true
			break
		}
		select {
		case <-runCtx.Done():
		case <-time.After(250 * time.Millisecond):
		}
	}
	if !ready {
		return result, ErrInfrastructure
	}
	phase = "image_transfer"
	for _, image := range images {
		if err = a.copyImage(runCtx, container, image); err != nil {
			return result, ErrInfrastructure
		}
	}
	phase, err = a.transferHelper(runCtx, container)
	if err != nil {
		return result, err
	}
	input.ResolvedImages = images
	phase = "helper_process_start"
	cmd := exec.CommandContext(runCtx, e.config.DockerBinary, "exec", "-i", container, "env", "-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "DOCKER_HOST=unix:///var/run/docker.sock", "GOLF_OWNED_ACTIONS_DAEMON=1", "/usr/local/bin/golf-actions-engine", "execute")
	var diagnostic actionsEngineDiagnostic
	cmd.Stderr = &diagnostic
	cmd.WaitDelay = 2 * time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return result, ErrInfrastructure
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return result, ErrInfrastructure
	}
	if err = cmd.Start(); err != nil {
		return result, ErrInfrastructure
	}
	phase = "helper_input"
	encoder := json.NewEncoder(stdin)
	if err = encoder.Encode(input); err != nil {
		cancel()
		stdin.Close()
		cmd.Wait()
		return result, ErrInfrastructure
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 128<<10)
	sequence, observations, logBytes := 0, 0, 0
	complete := false
	phase = "helper_frames"
	for scanner.Scan() {
		phase = "helper_frames"
		var frame ActionFrame
		d := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		d.DisallowUnknownFields()
		if d.Decode(&frame) != nil || d.Decode(new(any)) != io.EOF || frame.Sequence != sequence+1 || complete || frame.Sequence > 4096 {
			err = ErrInfrastructure
			break
		}
		sequence = frame.Sequence
		if frame.Kind == "log" {
			logBytes += len(frame.Text)
			if frame.EventSequence != 0 || frame.State != "" || frame.Text == "" || logBytes > 256<<10 {
				err = ErrInfrastructure
				break
			}
		} else {
			observations++
			if frame.EventSequence != observations || frame.Text != "" {
				err = ErrInfrastructure
				break
			}
		}
		if frame.Kind == "complete" {
			if frame.State != "success" && frame.State != "failure" {
				err = ErrInfrastructure
				break
			}
			complete = true
			result.ExitCode = 0
			if frame.State == "failure" {
				result.ExitCode = 1
			}
		}
		phase = "durable_frame_ack"
		if err = onFrame(runCtx, frame); err != nil {
			break
		}
		phase = "helper_ack_write"
		if err = encoder.Encode(ActionAck{Sequence: frame.Sequence}); err != nil {
			break
		}
	}
	if err != nil {
		cancel()
	}
	stdin.Close()
	waitErr := cmd.Wait()
	if err != nil || scanner.Err() != nil || waitErr != nil || !complete {
		if err == nil {
			phase = "helper_completion"
			if runCtx.Err() == nil {
				if stage := parseActionsEngineFailure(diagnostic.data); stage != "" {
					phase = stage
				}
			}
		}
		return result, ErrInfrastructure
	}
	return result, nil
}

// /golf remains the noexec source tmpfs. The trusted helper alone is copied to
// the owned daemon's executable overlay, never a source-job mount. Hash locally,
// transfer bounded stdin bytes, and require the same full remote hash first.
func (a *ActionsExecutor) transferHelper(ctx context.Context, container string) (string, error) {
	e := a.executor
	phase := "helper_local_hash"
	file, err := os.Open(a.helper)
	if err != nil {
		return phase, ErrInfrastructure
	}
	hash := sha256.New()
	n, copyErr := io.Copy(hash, io.LimitReader(file, (128<<20)+1))
	if copyErr != nil || n < 1 || n > 128<<20 {
		file.Close()
		return phase, ErrInfrastructure
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return phase, ErrInfrastructure
	}
	// Only this fixed operator command writes the trusted helper. Repository
	// source and paths never enter shell syntax or this executable directory.
	phase = "helper_transfer"
	_, transferErr := e.command(ctx, io.LimitReader(file, n+1), "exec", "-i", container, "/bin/sh", "-c", "umask 077; cat > /usr/local/bin/golf-actions-engine && chmod 0555 /usr/local/bin/golf-actions-engine")
	closeErr := file.Close()
	if transferErr != nil || closeErr != nil {
		return phase, ErrInfrastructure
	}
	phase = "helper_remote_hash"
	actual, err := e.command(ctx, nil, "exec", container, "sha256sum", "/usr/local/bin/golf-actions-engine")
	if err != nil || !strings.HasPrefix(string(actual), hex.EncodeToString(hash.Sum(nil))+"  /usr/local/bin/golf-actions-engine") {
		return phase, ErrInfrastructure
	}
	return phase, nil
}

func (a *ActionsExecutor) copyImage(ctx context.Context, container, image string) error {
	save := exec.CommandContext(ctx, a.executor.config.DockerBinary, "image", "save", image)
	save.Stderr = io.Discard
	stdout, err := save.StdoutPipe()
	if err != nil {
		return err
	}
	load := exec.CommandContext(ctx, a.executor.config.DockerBinary, "exec", "-i", container, "docker", "image", "load")
	load.Stdin = io.LimitReader(stdout, 2<<30)
	load.Stdout = io.Discard
	load.Stderr = io.Discard
	if err = save.Start(); err != nil {
		return err
	}
	loadErr := load.Run()
	stdout.Close()
	if loadErr != nil && save.Process != nil {
		save.Process.Kill()
	}
	saveErr := save.Wait()
	if loadErr != nil || saveErr != nil {
		return ErrInfrastructure
	}
	return nil
}

// Verify the trusted daemon's actual isolation before any source transfer.
// Privilege is restricted to this disposable engine daemon, never source jobs.
func (a *ActionsExecutor) verifyDaemon(ctx context.Context, id, image, volume, attempt, owner string) error {
	var rows []actionsDaemonInspect
	if a.executor.inspect(ctx, "container", id, &rows) != nil || len(rows) != 1 || !validActionsDaemon(rows[0], id, image, volume, a.executor.config.WorkerID, attempt, owner) {
		return ErrInfrastructure
	}
	return nil
}

type actionsDaemonInspect struct {
	ID     string `json:"Id"`
	Image  string
	Config struct {
		Env             []string
		Labels          map[string]string
		Entrypoint, Cmd []string
	}
	HostConfig struct {
		NetworkMode                  string
		Privileged                   bool
		Memory, MemorySwap, NanoCpus int64
		PidsLimit                    *int64
		Binds                        []string
		PortBindings                 map[string]json.RawMessage
		Tmpfs                        map[string]string
	}
	Mounts []struct{ Type, Name, Destination string }
}

func validActionsDaemon(r actionsDaemonInspect, id, image, volume, worker, attempt, owner string) bool {
	if r.ID != id || r.Image != image || r.Config.Labels[managedLabel] != "true" || r.Config.Labels[workerLabel] != worker || r.Config.Labels[attemptLabel] != attempt || r.Config.Labels[ownerLabel] != owner || r.HostConfig.NetworkMode != "none" || !r.HostConfig.Privileged || r.HostConfig.Memory != 1<<30 || r.HostConfig.MemorySwap != 1<<30 || r.HostConfig.NanoCpus != 2000000000 || r.HostConfig.PidsLimit == nil || *r.HostConfig.PidsLimit != 512 || len(r.HostConfig.Binds) != 0 || len(r.HostConfig.PortBindings) != 0 || len(r.HostConfig.Tmpfs) != 1 || r.HostConfig.Tmpfs["/golf"] != "rw,size=134217728,mode=0755" || len(r.Config.Entrypoint) != 1 || r.Config.Entrypoint[0] != "dockerd-entrypoint.sh" || strings.Join(r.Config.Cmd, "\x00") != "dockerd\x00--host=unix:///var/run/docker.sock\x00--iptables=false\x00--ip-masq=false\x00--bridge=none" {
		return false
	}
	count := 0
	for _, m := range r.Mounts {
		if m.Type == "volume" && m.Name == volume && m.Destination == "/var/lib/docker" {
			count++
			continue
		}
		// Image-declared anonymous volumes are confined to Docker's TLS directories.
		if m.Type == "volume" && (m.Destination == "/certs/client" || m.Destination == "/certs/server") {
			continue
		}
		if m.Type == "tmpfs" && m.Destination == "/golf" {
			continue
		}
		return false
	}
	if count != 1 {
		return false
	}
	found := false
	for _, v := range r.Config.Env {
		key := strings.SplitN(v, "=", 2)[0]
		if strings.HasPrefix(key, "GOLF_") || key == "DOCKER_HOST" || key == "DOCKER_CERT_PATH" || key == "DOCKER_TLS_VERIFY" {
			return false
		}
		if key == "DOCKER_TLS_CERTDIR" {
			if v != "DOCKER_TLS_CERTDIR=" {
				return false
			}
			found = true
		}
	}
	return found
}

// Restart cannot silently coexist with an orphaned previous engine daemon.
// An operator first fences the old attempt with Golf's supported recover command,
// which then verifies ownership before deleting that entire disposable domain.
func (e *Executor) RequireCleanWorker(ctx context.Context) error {
	filters := []string{"--filter", "label=" + managedLabel + "=true", "--filter", "label=" + workerLabel + "=" + e.config.WorkerID}
	for _, kind := range []string{"container", "volume"} {
		args := []string{kind, "ls", "--quiet"}
		if kind == "container" {
			args = append(args, "--all", "--no-trunc")
		}
		args = append(args, filters...)
		data, err := e.command(ctx, nil, args...)
		if err != nil || len(bytes.TrimSpace(data)) != 0 {
			return ErrCleanup
		}
	}
	return nil
}
