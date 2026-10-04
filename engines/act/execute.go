package actionsengine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/model"
	act "github.com/nektos/act/pkg/runner"
	"github.com/sirupsen/logrus"
)

const workspace = "/golf/workspace"
const jobSource = "/golf/job-source"

var imageID = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var containerID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var ErrExecution = errors.New("Actions engine execution or observation failed")

// Execute runs only inside the newly owned Unix-only child daemon. Callback
// acknowledgements are synchronous; a missing/refused durable acknowledgement
// cancels execution and cannot be interpreted as a successful run.
func Execute(ctx context.Context, input protocol.ActionExecutionInput, observe func(protocol.ActionFrame) error) error {
	if os.Getenv("DOCKER_HOST") != "unix:///var/run/docker.sock" || os.Getenv("GOLF_OWNED_ACTIONS_DAEMON") != "1" || (input.Input.Event != "workflow_dispatch" && input.Input.Event != "push") || input.TimeoutSeconds < 1 || input.TimeoutSeconds > 900 || !fullObjectPattern.MatchString(input.CommitID) || len(input.EventJSON) > 16<<10 {
		return ErrExecution
	}
	for _, env := range os.Environ() {
		key := strings.SplitN(env, "=", 2)[0]
		if strings.HasPrefix(key, "GOLF_") && key != "GOLF_OWNED_ACTIONS_DAEMON" {
			return ErrExecution
		}
	}
	plan, native, files, err := admit(input.Input)
	if err != nil || !reflect.DeepEqual(plan, input.Plan) {
		return ErrExecution
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(input.TimeoutSeconds)*time.Second)
	defer cancel()
	initial, err := docker(ctx, nil, "ps", "-aq", "--no-trunc")
	if err != nil || len(bytes.TrimSpace(initial)) != 0 {
		return ErrExecution
	}
	if len(input.ResolvedImages) < 1 || len(input.ResolvedImages) > 12 {
		return ErrExecution
	}
	for digest, id := range input.ResolvedImages {
		known := false
		for _, job := range plan.Jobs {
			known = known || job.Image == digest
		}
		if !known || !imageID.MatchString(id) {
			return ErrExecution
		}
	}
	resolved := map[string]string{}
	for label, digest := range input.Input.Images {
		used := false
		for _, job := range plan.Jobs {
			used = used || job.Image == digest
		}
		if !used {
			continue
		}
		expected := input.ResolvedImages[digest]
		if !imageID.MatchString(expected) {
			return ErrExecution
		}
		raw, err := docker(ctx, nil, "image", "inspect", expected)
		var rows []struct {
			ID string `json:"Id"`
			Os string
		}
		if err != nil || json.Unmarshal(raw, &rows) != nil || len(rows) != 1 || rows[0].ID != expected || rows[0].Os != "linux" {
			return ErrExecution
		}
		resolved[label] = rows[0].ID
	}
	if err = os.MkdirAll(workspace, 0755); err != nil {
		return ErrExecution
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return ErrExecution
	}
	defer root.Close()
	protected := protectedActionDirs(plan)
	if err = os.MkdirAll(jobSource, 0755); err != nil {
		return ErrExecution
	}
	copyRoot, err := os.OpenRoot(jobSource)
	if err != nil {
		return ErrExecution
	}
	defer copyRoot.Close()
	for name, entry := range files {
		if entry.directory {
			if err = root.MkdirAll(name, 0755); err != nil {
				return ErrExecution
			}
			continue
		}
		if err = root.MkdirAll(filepath.Dir(name), 0755); err != nil {
			return ErrExecution
		}
		f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(entry.mode))
		if err != nil {
			return ErrExecution
		}
		_, writeErr := f.Write(entry.body)
		closeErr := f.Close()
		if writeErr != nil || closeErr != nil {
			return ErrExecution
		}
	}
	for name, entry := range files {
		omit := false
		for _, dir := range protected {
			omit = omit || name == dir || strings.HasPrefix(name, dir+"/")
		}
		if omit {
			continue
		}
		if err = copyRoot.MkdirAll(filepath.Dir(name), 0755); err != nil {
			return ErrExecution
		}
		if entry.directory {
			if err = copyRoot.MkdirAll(name, 0755); err != nil {
				return ErrExecution
			}
			continue
		}
		f, e := copyRoot.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(entry.mode))
		if e != nil {
			return ErrExecution
		}
		_, e = f.Write(entry.body)
		closeErr := f.Close()
		if e != nil || closeErr != nil {
			return ErrExecution
		}
	}
	options := "--user=1000:1000 --security-opt=no-new-privileges --cpus=1 --memory=268435456 --memory-swap=268435456 --pids-limit=64"
	for _, dir := range protected {
		options += " --mount=type=bind,source=" + workspace + "/" + dir + ",target=" + workspace + "/" + dir + ",readonly"
	}
	if err = os.WriteFile("/golf/event.json", input.EventJSON, 0600); err != nil {
		return ErrExecution
	}
	observer := &engineObserver{ctx: ctx, cancel: cancel, send: observe, plan: plan, resolved: resolved, prepared: map[string]bool{}, volumes: map[string]bool{}, started: map[string]bool{}, finished: map[string]bool{}, nativeResults: map[string]string{}}
	logrus.SetOutput(io.Discard)
	logrus.SetLevel(logrus.DebugLevel)
	config := &act.Config{Actor: "unavailable", Workdir: workspace, EventName: input.Input.Event, EventPath: "/golf/event.json", Env: map[string]string{"SHA_REF": input.CommitID, "GITHUB_REF": input.Input.Ref, "GITHUB_RUN_ID": "unavailable", "GITHUB_RUN_NUMBER": "unavailable", "GITHUB_SERVER_URL": "urn:golf:platform-context-unavailable", "GITHUB_API_URL": "urn:golf:github-rest-unavailable", "GITHUB_GRAPHQL_URL": "urn:golf:github-graphql-unavailable"}, Platforms: resolved, GitHubInstance: "golf.invalid", ContainerDaemonSocket: "-", ContainerNetworkMode: "none", BindWorkdir: false, ActionOfflineMode: true, ForcePull: false, Privileged: false, AutoRemove: true, ConcurrentJobs: 2, ContainerCapDrop: []string{"ALL"}, ContainerOptions: options}
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	ctx = act.WithJobLoggerFactory(common.WithLogger(ctx, logger.WithField("engine", true)), observer)
	executionErr := executeNativePlan(ctx, native, config, string(input.EventJSON), observer, nativeInstanceExecutor)
	observer.mu.Lock()
	defer observer.mu.Unlock()
	if observer.err != nil {
		return ErrExecution
	}
	for _, job := range plan.Jobs {
		if !observer.finished[job.InstanceID] {
			return ErrExecution
		}
	}
	cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	left, err := docker(cleanupCtx, nil, "ps", "-aq", "--no-trunc")
	if err != nil || len(bytes.TrimSpace(left)) != 0 {
		return ErrExecution
	}
	state := "success"
	if executionErr != nil {
		state = "failure"
	}
	if err = observer.emit(protocol.ActionFrame{Kind: "complete", State: state}); err != nil {
		return ErrExecution
	}
	return nil
}

type engineObserver struct {
	mu                                         sync.Mutex
	ctx                                        context.Context
	cancel                                     context.CancelFunc
	send                                       func(protocol.ActionFrame) error
	plan                                       protocol.ActionPlan
	resolved                                   map[string]string
	prepared, volumes, started, finished       map[string]bool
	nativeResults                              map[string]string
	sequence, eventSequence, logBytes, entries int
	err                                        error
}

func (o *engineObserver) WithJobLogger() *logrus.Logger {
	l := logrus.New()
	l.SetOutput(io.Discard)
	l.SetLevel(logrus.DebugLevel)
	l.AddHook(o)
	return l
}
func (o *engineObserver) Levels() []logrus.Level { return logrus.AllLevels }
func (o *engineObserver) fail() {
	if o.err == nil {
		o.err = ErrExecution
		o.cancel()
	}
}
func (o *engineObserver) emit(frame protocol.ActionFrame) error {
	if o.err != nil || o.ctx.Err() != nil {
		return ErrExecution
	}
	o.sequence++
	frame.Sequence = o.sequence
	if frame.Kind != "log" {
		o.eventSequence++
		frame.EventSequence = o.eventSequence
	}
	if o.sequence > 4096 || o.send(frame) != nil {
		o.fail()
		return ErrExecution
	}
	return nil
}
func (o *engineObserver) identify(entry *logrus.Entry) (protocol.ActionJob, bool) {
	id, ok := entry.Data["jobID"].(string)
	matrix, mok := entry.Data["matrix"].(map[string]interface{})
	if !ok || !mok {
		return protocol.ActionJob{}, false
	}
	var values []protocol.ActionMatrixEntry
	for key, value := range matrix {
		b, err := json.Marshal(value)
		if err != nil {
			return protocol.ActionJob{}, false
		}
		values = append(values, protocol.ActionMatrixEntry{Name: key, Value: string(b)})
	}
	for _, job := range o.plan.Jobs {
		if job.JobID != id || len(job.Matrix) != len(values) {
			continue
		}
		match := true
		for _, expected := range job.Matrix {
			found := false
			for _, actual := range values {
				found = found || actual == expected
			}
			match = match && found
		}
		if match {
			return job, true
		}
	}
	return protocol.ActionJob{}, false
}
func (o *engineObserver) Fire(entry *logrus.Entry) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.entries++
	if o.entries > 8192 || len(entry.Message) > 32<<10 {
		o.fail()
		return nil
	}
	if o.err != nil {
		return nil
	}
	job, ok := o.identify(entry)
	if !ok {
		o.fail()
		return nil
	}
	ids, _ := entry.Data["stepID"].([]string)
	if entry.Data["raw_output"] == true {
		o.logBytes += len(entry.Message) + 1
		if o.logBytes > 256<<10 {
			o.fail()
			return nil
		}
		step := ""
		if len(ids) > 0 {
			step = ids[0]
		}
		if err := o.emit(protocol.ActionFrame{Kind: "log", InstanceID: job.InstanceID, StepID: step, Text: strings.ReplaceAll(strings.ToValidUTF8(entry.Message, "�"), "\x00", "�") + "\n"}); err != nil {
			o.fail()
		}
		return nil
	}
	if result, present := entry.Data["jobResult"]; present {
		state, ok := result.(string)
		if !ok || (state != "success" && state != "failure" && state != "skipped") || o.nativeResults[job.InstanceID] != "" {
			o.fail()
			return nil
		}
		// The matrix aggregate is not a per-instance receipt. Only a native
		// skip receipt is consumed here; terminal errors come from Executor.
		if o.nativeResults == nil {
			o.nativeResults = map[string]string{}
		}
		o.nativeResults[job.InstanceID] = state
		return nil
	}
	result, present := entry.Data["stepResult"]
	if len(ids) == 1 && ids[0] == "--setup-job" && present && result == model.StepStatusSuccess {
		if o.started[job.InstanceID] || o.prepare() != nil {
			o.fail()
			return nil
		}
		if o.emit(protocol.ActionFrame{Kind: "job_started", InstanceID: job.InstanceID}) != nil {
			o.fail()
			return nil
		}
		o.started[job.InstanceID] = true
		return nil
	}
	if len(ids) != 1 {
		return nil
	} // Composite child stages are not invented top-level steps.
	if !o.started[job.InstanceID] {
		return nil
	}
	known := false
	for _, step := range job.Steps {
		known = known || step.ID == ids[0]
	}
	if !known {
		return nil
	}
	stage, _ := entry.Data["stage"].(string)
	if stage != "Main" {
		return nil
	}
	if present {
		state := ""
		switch result {
		case model.StepStatusSuccess:
			state = "success"
		case model.StepStatusFailure:
			state = "failure"
		case model.StepStatusSkipped:
			state = "skipped"
		default:
			o.fail()
			return nil
		}
		if o.emit(protocol.ActionFrame{Kind: "step_finished", InstanceID: job.InstanceID, StepID: ids[0], State: state}) != nil {
			o.fail()
		}
		return nil
	}
	if strings.HasPrefix(entry.Message, "⭐ Run Main ") {
		if o.emit(protocol.ActionFrame{Kind: "step_started", InstanceID: job.InstanceID, StepID: ids[0]}) != nil {
			o.fail()
		}
	}
	return nil
}

type inspected struct {
	ID     string `json:"Id"`
	Image  string
	Config struct {
		User string
		Env  []string
	}
	HostConfig struct {
		NetworkMode                         string
		Privileged                          bool
		Binds, CapAdd, CapDrop, SecurityOpt []string
		Memory, MemorySwap, NanoCpus        int64
		PidsLimit                           *int64
		Devices                             []json.RawMessage
	}
	Mounts []struct {
		Type, Source, Destination string
		RW                        bool
	}
}

func (o *engineObserver) prepare() error {
	raw, err := docker(o.ctx, nil, "ps", "-q", "--no-trunc")
	if err != nil {
		return ErrExecution
	}
	for _, id := range strings.Fields(string(raw)) {
		if !containerID.MatchString(id) {
			return ErrExecution
		}
		if o.prepared[id] {
			continue
		}
		body, err := docker(o.ctx, nil, "inspect", id)
		var rows []inspected
		if err != nil || json.Unmarshal(body, &rows) != nil || len(rows) != 1 {
			return ErrExecution
		}
		r := rows[0]
		allowedImage := false
		for _, image := range o.resolved {
			allowedImage = allowedImage || image == r.Image
		}
		if !allowedImage || r.ID != id || r.Config.User != "1000:1000" || r.HostConfig.NetworkMode != "none" || r.HostConfig.Privileged || len(r.HostConfig.Binds) > 0 || len(r.HostConfig.CapAdd) > 0 || len(r.HostConfig.Devices) > 0 || r.HostConfig.Memory != 268435456 || r.HostConfig.MemorySwap != 268435456 || r.HostConfig.NanoCpus != 1000000000 || r.HostConfig.PidsLimit == nil || *r.HostConfig.PidsLimit != 64 || !contains(r.HostConfig.CapDrop, "ALL") || !contains(r.HostConfig.SecurityOpt, "no-new-privileges") {
			return ErrExecution
		}
		for _, env := range r.Config.Env {
			if strings.HasPrefix(env, "GOLF_") || strings.HasPrefix(env, "DOCKER_") {
				return ErrExecution
			}
		}
		protected := protectedActionDirs(o.plan)
		if !validJobMounts(r, protected) {
			return ErrExecution
		}
		if _, err = docker(o.ctx, nil, "cp", jobSource+"/.", id+":"+workspace); err != nil {
			return ErrExecution
		}
		for _, mount := range r.Mounts {
			if mount.Type != "volume" {
				continue
			}
			if o.volumes[mount.Source] {
				continue
			}
			if err = ownVolume(o.ctx, mount.Source); err != nil {
				return err
			}
			if mount.Destination == workspace && protectActionAncestors(o.ctx, mount.Source, protected) != nil {
				return ErrExecution
			}
			o.volumes[mount.Source] = true
		}
		// Independent source readback occurs before ACK releases any source step.
		sourcePaths := []string{o.plan.WorkflowPath}
		for _, dependency := range o.plan.LocalActions {
			sourcePaths = append(sourcePaths, dependency.MetadataPath)
		}
		for _, name := range sourcePaths {
			expected, err := os.ReadFile(filepath.Join(workspace, name))
			if err != nil {
				return ErrExecution
			}
			actual, err := docker(o.ctx, nil, "exec", "--user=1000:1000", id, "/bin/cat", workspace+"/"+name)
			if err != nil || !bytes.Equal(actual, expected) {
				return ErrExecution
			}
		}
		o.prepared[id] = true
	}
	return nil
}
func ownVolume(ctx context.Context, directory string) error {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return ErrExecution
	}
	defer root.Close()
	names, err := ownedVolumeNames(ctx, root)
	if err != nil {
		return err
	}
	// Root.Lchown changes a raced final symlink itself, never its external target.
	// Root confinement also prevents raced parent directories escaping this tree.
	for _, name := range names {
		if ctx.Err() != nil {
			return ErrExecution
		}
		if err = root.Lchown(name, 1000, 1000); err != nil {
			return err
		}
	}
	return nil
}
func ownedVolumeNames(ctx context.Context, root *os.Root) ([]string, error) {
	var names []string
	total := 0
	err := fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
		total += len(name)
		if err != nil || ctx.Err() != nil || len(names) >= 8192 || total > 1<<20 || d.Type()&os.ModeSymlink != 0 {
			return ErrExecution
		}
		info, err := root.Lstat(name)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) {
			return ErrExecution
		}
		names = append(names, name)
		return nil
	})
	return names, err
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

type limitedOutput struct{ bytes.Buffer }

func (b *limitedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1<<20 {
		return 0, ErrExecution
	}
	return b.Buffer.Write(p)
}
func docker(ctx context.Context, input io.Reader, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdin = input
	var out limitedOutput
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	err := cmd.Run()
	return out.Bytes(), err
}

// Minimal enclosing immutable directories avoid overlapping bind mounts.
func protectedActionDirs(plan protocol.ActionPlan) []string {
	var dirs []string
	for _, d := range plan.LocalActions {
		dir := path.Dir(d.MetadataPath)
		covered := false
		for _, other := range plan.LocalActions {
			ancestor := path.Dir(other.MetadataPath)
			if ancestor != dir && strings.HasPrefix(dir, ancestor+"/") {
				covered = true
			}
		}
		if !covered && !contains(dirs, dir) {
			dirs = append(dirs, dir)
		}
	}
	sort.Strings(dirs)
	return dirs
}
func validJobMounts(r inspected, protected []string) bool {
	if len(r.Mounts) != 3+len(protected) {
		return false
	}
	seen := map[string]bool{}
	for _, m := range r.Mounts {
		if seen[m.Destination] {
			return false
		}
		seen[m.Destination] = true
		if m.Type == "volume" {
			if (m.Destination != workspace && m.Destination != "/var/run/act" && m.Destination != "/opt/hostedtoolcache") || !regexp.MustCompile(`^/var/lib/docker/volumes/[A-Za-z0-9_.-]{1,200}/_data$`).MatchString(m.Source) {
				return false
			}
			continue
		}
		known := false
		for _, d := range protected {
			known = known || m.Destination == workspace+"/"+d
		}
		if m.Type != "bind" || m.RW || !known || m.Source != m.Destination {
			return false
		}
	}
	return seen[workspace] && seen["/var/run/act"] && seen["/opt/hostedtoolcache"]
}
func protectActionAncestors(ctx context.Context, directory string, protected []string) error {
	if len(protected) == 0 {
		return nil
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return ErrExecution
	}
	defer root.Close()
	parents := map[string]bool{".": true}
	for _, d := range protected {
		for p := path.Dir(d); p != "."; p = path.Dir(p) {
			parents[p] = true
		}
	}
	for name := range parents {
		if ctx.Err() != nil {
			return ErrExecution
		}
		info, err := root.Lstat(name)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ErrExecution
		}
		if root.Lchown(name, 0, 0) != nil || root.Chmod(name, 0777|os.ModeSticky) != nil {
			return ErrExecution
		}
	}
	return nil
}
