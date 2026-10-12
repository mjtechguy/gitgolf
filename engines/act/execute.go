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
	"strconv"
	"strings"
	"sync"
	"time"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/workflowinputs"
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

// executionStageError preserves failure policy without formatting native errors.
type executionStageError struct {
	stage string
	cause error
}

func (e *executionStageError) Error() string {
	return "Actions engine failed at " + ExecutionFailureStage(e)
}
func (e *executionStageError) Unwrap() error { return e.cause }
func ExecutionFailureStage(err error) string {
	var classified *executionStageError
	if errors.As(err, &classified) && protocol.ActionsEngineFailureDiagnostic(classified.stage) != "" {
		return classified.stage
	}
	return ""
}
func classifyExecution(stage string, err error) error {
	if err == nil || ExecutionFailureStage(err) != "" {
		return err
	}
	return &executionStageError{stage, errors.Join(ErrExecution, err)}
}

// Execute runs only inside the newly owned Unix-only child daemon. Callback
// acknowledgements are synchronous; a missing/refused durable acknowledgement
// cancels execution and cannot be interpreted as a successful run.
func Execute(ctx context.Context, input protocol.ActionExecutionInput, observe func(protocol.ActionFrame) error) (err error) {
	if input.JobGit != nil {
		return ErrExecution
	}
	return ExecuteAcknowledged(ctx, input, observe, nil)
}

func ExecuteAcknowledged(ctx context.Context, input protocol.ActionExecutionInput, observe func(protocol.ActionFrame) error, credentials func(protocol.ActionFrame) (*protocol.JobGitCredential, error)) (err error) {
	phase := "engine_input_validation"
	if len(input.JobTLSCA) > 64<<10 || len(input.JobTLSCA) > 0 && (input.JobGit == nil || !validJobCA(input.JobTLSCA)) {
		return ErrExecution
	}
	if input.DependencyAccess.Validate() != nil || input.DependencyAccess != nil && input.JobGit == nil {
		return ErrExecution
	}
	if input.JobGit != nil && (input.JobGit.Validate() != nil || input.GitSource == nil || credentials == nil) {
		return ErrExecution
	}
	defer func() { err = classifyExecution(phase, err) }()
	limits := protocol.DefaultJobLimits()
	if input.JobResources != nil {
		if input.JobResources.Validate() != nil || uint32(input.TimeoutSeconds) != input.JobResources.Limits.TimeoutSeconds {
			return ErrExecution
		}
		limits = input.JobResources.Limits
	}
	if input.ExecutionEnvironment.Validate() != nil || os.Getenv("DOCKER_HOST") != "unix:///var/run/docker.sock" || os.Getenv("GOLF_OWNED_ACTIONS_DAEMON") != "1" || (input.Input.Event != "workflow_dispatch" && input.Input.Event != "push") || input.TimeoutSeconds < 1 || input.TimeoutSeconds > 900 || !fullObjectPattern.MatchString(input.CommitID) || len(input.EventJSON) > 16<<10 {
		return ErrExecution
	}
	phase = "engine_environment_validation"
	for _, env := range os.Environ() {
		key := strings.SplitN(env, "=", 2)[0]
		if strings.HasPrefix(key, "GOLF_") && key != "GOLF_OWNED_ACTIONS_DAEMON" {
			return ErrExecution
		}
	}
	phase = "engine_plan_binding"
	plan, native, files, err := admit(input.Input)
	if err != nil || !reflect.DeepEqual(plan, input.Plan) {
		return ErrExecution
	}
	if plan.Catalog == protocol.ActionsRemoteCatalog && (input.JobGit == nil || input.DependencyAccess == nil) {
		return ErrExecution
	}
	if plan.Catalog == protocol.ActionsAgentCatalog {
		prepareNativeAgentSteps(native)
	}
	phase = "engine_input_validation"
	if !validatedManualInputs(input, files) {
		return ErrExecution
	}
	gitSource, err := loadEngineGitSource(input)
	if err != nil {
		return ErrExecution
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(input.TimeoutSeconds)*time.Second)
	defer cancel()
	phase = "engine_daemon_empty"
	initial, err := docker(ctx, nil, "ps", "-aq", "--no-trunc")
	if err != nil || len(bytes.TrimSpace(initial)) != 0 {
		return ErrExecution
	}
	phase = "engine_image_map_validation"
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
	phase = "engine_image_receipt_validation"
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
	phase = "engine_workspace_open"
	if err = os.MkdirAll(workspace, 0755); err != nil {
		return ErrExecution
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return ErrExecution
	}
	defer root.Close()
	protected := protectedActionDirs(plan)
	phase = "engine_job_source_open"
	if err = os.MkdirAll(jobSource, 0755); err != nil {
		return ErrExecution
	}
	copyRoot, err := os.OpenRoot(jobSource)
	if err != nil {
		return ErrExecution
	}
	defer copyRoot.Close()
	phase = "engine_source_extract"
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
		if entry.mode == 0120000 {
			if root.Symlink(string(entry.body), name) != nil {
				return ErrExecution
			}
			continue
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
	phase = "engine_job_source_copy"
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
		if entry.mode == 0120000 {
			if copyRoot.Symlink(string(entry.body), name) != nil {
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
	options := "--user=1000:1000 --security-opt=no-new-privileges " + strings.Join(limits.DockerOptions(), " ")
	if gitSource != nil {
		options += " --read-only --tmpfs=/tmp:" + jobTemporaryTmpfs
	}
	for _, dir := range protected {
		options += " --mount=type=bind,source=" + workspace + "/" + dir + ",target=" + workspace + "/" + dir + ",readonly"
	}
	phase = "engine_event_write"
	if err = os.WriteFile("/golf/event.json", input.EventJSON, 0600); err != nil {
		return ErrExecution
	}
	observer := &engineObserver{ctx: ctx, cancel: cancel, send: observe, plan: plan, resolved: resolved, prepared: map[string]bool{}, volumes: map[string]bool{}, started: map[string]bool{}, finished: map[string]bool{}, nativeResults: map[string]string{}, limits: limits, gitSource: gitSource}
	observer.jobGit, observer.commit, observer.credentials = input.JobGit, input.CommitID, credentials
	observer.contexts = map[string]*act.RunContext{}
	observer.access = input.DependencyAccess
	observer.jobTLSCA = input.JobTLSCA
	logrus.SetOutput(io.Discard)
	logrus.SetLevel(logrus.DebugLevel)
	config := &act.Config{Actor: "unavailable", Workdir: workspace, EventName: input.Input.Event, EventPath: "/golf/event.json", Env: map[string]string{"SHA_REF": input.CommitID, "GITHUB_REF": input.Input.Ref, "GITHUB_RUN_ID": "unavailable", "GITHUB_RUN_NUMBER": "unavailable", "GITHUB_SERVER_URL": "urn:golf:platform-context-unavailable", "GITHUB_API_URL": "urn:golf:github-rest-unavailable", "GITHUB_GRAPHQL_URL": "urn:golf:github-graphql-unavailable"}, Platforms: resolved, GitHubInstance: "golf.invalid", ContainerDaemonSocket: "-", ContainerNetworkMode: "none", BindWorkdir: false, ActionOfflineMode: true, ForcePull: false, Privileged: false, AutoRemove: true, ConcurrentJobs: 2, ContainerCapDrop: []string{"ALL"}, ContainerOptions: options}
	config.ContainerCopyViaExec = gitSource != nil
	if plan.Catalog == protocol.ActionsRemoteCatalog {
		remoteActions, e := admitRemoteActions(input.Input)
		if e != nil {
			return ErrExecution
		}
		config.ActionCache = immutableActionCache{actions: remoteActions}
		for uses := range remoteActions {
			parts := protocol.RemoteActionReference.FindStringSubmatch(uses)
			config.ReplaceGheActionWithGithubCom = append(config.ReplaceGheActionWithGithubCom, parts[1]+"/"+parts[2])
		}
		config.Env["HOME"] = "/var/run/act/home"
		config.Env["XDG_CACHE_HOME"] = "/var/run/act/home/.cache"
		config.Env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
	}
	if input.JobGit != nil {
		config.Actor = input.JobGit.Actor
		config.Env["GITHUB_SERVER_URL"] = input.JobGit.Origin
		config.Env["GITHUB_REPOSITORY"] = input.JobGit.Repository
		config.Env["GITHUB_REPOSITORY_OWNER"] = strings.Split(input.JobGit.Repository, "/")[0]
		config.NoSkipCheckout = true
	}
	if input.DependencyAccess != nil {
		config.ContainerNetworkMode = "bridge"
		for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
			config.Env[name] = input.DependencyAccess.ProxyURL()
		}
		config.Env["NO_PROXY"], config.Env["no_proxy"] = "", ""
	}
	if len(input.JobTLSCA) > 0 {
		for _, key := range []string{"GIT_SSL_CAINFO", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"} {
			config.Env[key] = "/var/run/act/home/ca.crt"
		}
	}
	if gitSource != nil {
		config.ContainerVolumeOptions = map[string]map[string]string{}
		for _, destination := range []string{workspace, "/var/run/act", "/opt/hostedtoolcache"} {
			config.ContainerVolumeOptions[destination] = jobVolumeOptionsProfile(destination, plan.Catalog == protocol.ActionsRemoteCatalog)
		}
	}
	if err = applyRepositoryEnvironment(config, input.ExecutionEnvironment); err != nil {
		return err
	}
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	ctx = act.WithJobLoggerFactory(common.WithLogger(ctx, logger.WithField("engine", true)), observer)
	phase = "engine_native_execution"
	executionErr := executeNativePlan(ctx, native, config, string(input.EventJSON), observer, nativeInstanceExecutor)
	observer.mu.Lock()
	defer observer.mu.Unlock()
	if observer.err != nil {
		return observer.err
	}
	if executionErr == nil {
		phase = "engine_graph_completion"
	}
	for _, job := range plan.Jobs {
		if !observer.finished[job.InstanceID] {
			if executionErr != nil {
				return executionErr
			}
			return ErrExecution
		}
	}
	phase = "engine_inner_cleanup"
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
	phase = "engine_completion_ack"
	if err = observer.emit(protocol.ActionFrame{Kind: "complete", State: state}); err != nil {
		return ErrExecution
	}
	return nil
}

func validatedManualInputs(input protocol.ActionExecutionInput, files map[string]file) bool {
	if input.Input.Catalog == protocol.ActionsCatalog || input.Input.Catalog == protocol.ActionsRemoteCatalog {
		return input.ManualInputs == nil
	}
	m := input.ManualInputs
	if input.Input.Catalog != protocol.ActionsInputsCatalog || input.Input.Event != "workflow_dispatch" || input.CommitID != input.Input.Ref || m == nil || m.Contract != protocol.ManualInputsCapability || m.SchemaSHA256 != input.Input.ManualInputsSchemaSHA256 || m.SchemaSHA256 != input.Plan.ManualInputsSchemaSHA256 || len(input.EventJSON) == 0 || len(input.EventJSON) > 16<<10 {
		return false
	}
	schema, err := workflowinputs.Parse(files[input.Input.WorkflowPath].body)
	if err != nil || schema.SHA256 != m.SchemaSHA256 {
		return false
	}
	values, err := workflowinputs.Validate(schema, m.Submitted)
	if err != nil || values.SubmittedSHA256 != m.SubmittedSHA256 || values.EffectiveSHA256 != m.EffectiveSHA256 || !reflect.DeepEqual(values.Submitted, m.Submitted) || !reflect.DeepEqual(values.Effective, m.Effective) {
		return false
	}
	expected := make(map[string]string, len(values.Effective))
	for _, value := range values.Effective {
		switch value.Type {
		case workflowinputs.String, workflowinputs.Choice:
			expected[value.Name] = value.String
		case workflowinputs.Boolean:
			expected[value.Name] = strconv.FormatBool(value.Boolean)
		case workflowinputs.Number:
			expected[value.Name] = value.Number
		default:
			return false
		}
	}
	observed, ok := dispatchEventInputs(input.EventJSON, input.CommitID)
	return ok && reflect.DeepEqual(expected, observed)
}

func dispatchEventInputs(body []byte, commitID string) (map[string]string, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var event map[string]any
	if decoder.Decode(&event) != nil || event == nil {
		return nil, false
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || event["after"] != commitID || event["ref"] != commitID {
		return nil, false
	}
	canonical, err := json.Marshal(event)
	if err != nil || !bytes.Equal(canonical, body) {
		return nil, false // includes duplicate keys and alternate event encodings.
	}
	values, ok := event["inputs"].(map[string]any)
	if !ok {
		return nil, false
	}
	inputs := make(map[string]string, len(values))
	for name, raw := range values {
		value, ok := raw.(string)
		if !ok {
			return nil, false
		}
		inputs[name] = value
	}
	return inputs, true
}

type engineObserver struct {
	jobTLSCA                                   []byte
	access                                     *protocol.ActionDependencyAccess
	jobGit                                     *protocol.JobGitContext
	commit                                     string
	credentials                                func(protocol.ActionFrame) (*protocol.JobGitCredential, error)
	contexts                                   map[string]*act.RunContext
	gitSource                                  *engineGitSource
	limits                                     protocol.JobLimits
	mu                                         sync.Mutex
	ctx                                        context.Context
	cancel                                     context.CancelFunc
	send                                       func(protocol.ActionFrame) error
	plan                                       protocol.ActionPlan
	resolved                                   map[string]string
	prepared, volumes, started, finished       map[string]bool
	volumeOwners                               map[string]string
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
func (o *engineObserver) fail()                  { o.failWith(classifyExecution("engine_observation", ErrExecution)) }
func (o *engineObserver) failWith(err error) {
	if o.err == nil {
		o.err = classifyExecution("engine_observation", err)
		o.cancel()
	}
}
func (o *engineObserver) emit(frame protocol.ActionFrame) error {
	if o.err != nil || o.ctx.Err() != nil {
		return ErrExecution
	}
	o.sequence++
	frame.Sequence = o.sequence
	if frame.Kind != "log" && frame.Kind != "agent_requested" {
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
	_, stepReceipt := entry.Data["stepResult"]
	_, jobReceipt := entry.Data["jobResult"]
	nativeError := entry.Level == logrus.ErrorLevel && o.started[job.InstanceID] && !stepReceipt && !jobReceipt
	if entry.Data["raw_output"] == true || nativeError {
		if o.gitSource != nil && !o.started[job.InstanceID] {
			return nil
		}
		// Every pinned raw producer forwards NewLineWriter's bytes, including
		// its existing LF. Preserve blank lines, CR progress and partial ANSI;
		// do not synthesize a second line ending. Charge sanitized wire bytes.
		text := strings.ReplaceAll(strings.ToValidUTF8(entry.Message, "�"), "\x00", "�")
		if nativeError && entry.Data["raw_output"] != true {
			text += "\n"
		}
		if text == "" {
			return nil
		}
		o.logBytes += len(text)
		if len(text) > 32<<10 || o.logBytes > 256<<10 {
			o.fail()
			return nil
		}
		step := ""
		if len(ids) > 0 {
			step = ids[0]
		}
		if err := o.emit(protocol.ActionFrame{Kind: "log", InstanceID: job.InstanceID, StepID: step, Text: text}); err != nil {
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
	// Pinned act job_executor.go emits only setup/cleanup under `stepid`;
	// ordinary step/composite logs use `stepID`. Admit the exact setup sentinel,
	// never arbitrary lower-case step IDs or conflicting metadata. Raw source
	// output was handled above and cannot enter this trusted branch.
	setup := len(ids) == 1 && ids[0] == "--setup-job"
	if lower, ok := entry.Data["stepid"].([]string); ok && len(lower) == 1 && lower[0] == "--setup-job" {
		if _, ambiguous := entry.Data["stepID"]; ambiguous {
			o.fail()
			return nil
		}
		setup = true
	}
	result, present := entry.Data["stepResult"]
	if setup && present && result == model.StepStatusSuccess {
		if o.started[job.InstanceID] {
			o.fail()
			return nil
		}
		if err := o.prepare(); err != nil {
			o.failWith(err)
			return nil
		}
		if o.emit(protocol.ActionFrame{Kind: "job_started", InstanceID: job.InstanceID}) != nil {
			o.fail()
			return nil
		}
		o.started[job.InstanceID] = true
		if o.jobGit != nil && o.renewJobGit(job.InstanceID) != nil {
			o.fail()
		}
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
		for _, step := range job.Steps {
			if step.ID == ids[0] && step.AgentPrompt != "" {
				if o.plan.Catalog != protocol.ActionsAgentCatalog || o.emit(protocol.ActionFrame{Kind: "agent_requested", InstanceID: job.InstanceID, StepID: step.ID}) != nil {
					o.fail()
				}
			}
		}
	}
	return nil
}

// The trusted observer blocks this native step until the coordinator's original
// child task completes. No credentials or client RPC reach its ordinary shell.
func prepareNativeAgentSteps(plan *model.Plan) {
	seen := map[*model.Job]bool{}
	for _, stage := range plan.Stages {
		for _, run := range stage.Runs {
			job := run.Job()
			if seen[job] {
				continue
			}
			seen[job] = true
			for _, step := range job.Steps {
				if step.Uses == protocol.WorkflowAgentAction {
					step.Uses = ""
					step.With = nil
					step.Run = "true"
					step.Shell = "sh"
				}
			}
		}
	}
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
		Privileged, ReadonlyRootfs          bool
		Tmpfs                               map[string]string
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

func (o *engineObserver) prepare() (err error) {
	phase := "engine_job_inventory"
	defer func() { err = classifyExecution(phase, err) }()
	raw, err := docker(o.ctx, nil, "ps", "-q", "--no-trunc")
	if err != nil {
		return ErrExecution
	}
	for _, id := range strings.Fields(string(raw)) {
		phase = "engine_job_inventory"
		if !containerID.MatchString(id) {
			return ErrExecution
		}
		if o.prepared[id] {
			continue
		}
		phase = "engine_job_receipt"
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
		phase = "engine_job_shape"
		network := "none"
		if o.access != nil {
			network = "bridge"
			if !engineDependencyFirewall(o.ctx, o.access) {
				return ErrExecution
			}
		}
		if !allowedImage || r.ID != id || r.Config.User != "1000:1000" || r.HostConfig.NetworkMode != network || r.HostConfig.Privileged || len(r.HostConfig.Binds) > 0 || len(r.HostConfig.CapAdd) > 0 || len(r.HostConfig.Devices) > 0 || r.HostConfig.Memory != o.jobLimits().Memory() || r.HostConfig.MemorySwap != o.jobLimits().Memory() || r.HostConfig.NanoCpus != int64(o.jobLimits().CPUMillis)*1000000 || r.HostConfig.PidsLimit == nil || *r.HostConfig.PidsLimit != int64(o.jobLimits().Pids) || !contains(r.HostConfig.CapDrop, "ALL") || !contains(r.HostConfig.SecurityOpt, "no-new-privileges") {
			return ErrExecution
		}
		if o.gitSource != nil && (!r.HostConfig.ReadonlyRootfs || len(r.HostConfig.Tmpfs) != 1 || r.HostConfig.Tmpfs["/tmp"] != jobTemporaryTmpfs) {
			return ErrExecution
		}
		phase = "engine_job_environment"
		for _, env := range r.Config.Env {
			if strings.HasPrefix(env, "GOLF_") || strings.HasPrefix(env, "DOCKER_") {
				return ErrExecution
			}
		}
		protected := protectedActionDirs(o.plan)
		phase = "engine_job_mounts"
		mountShape := r
		if o.gitSource != nil {
			mountShape.Mounts = nil
			for _, mount := range r.Mounts {
				if mount.Type == "tmpfs" && mount.Destination == "/tmp" {
					continue
				}
				mountShape.Mounts = append(mountShape.Mounts, mount)
				if mount.Type == "volume" && (!mount.RW || verifyJobVolumeProfile(o.ctx, path.Base(path.Dir(mount.Source)), mount.Destination, o.plan.Catalog == protocol.ActionsRemoteCatalog) != nil) {
					return ErrExecution
				}
			}
		}
		if !validJobMounts(mountShape, protected) || !o.bindJobVolumes(mountShape) {
			return ErrExecution
		}
		phase = "engine_job_source_transfer"
		if o.gitSource != nil {
			err = transferJobSource(o.ctx, id)
		} else {
			_, err = docker(o.ctx, nil, "cp", jobSource+"/.", id+":"+workspace)
		}
		if err != nil {
			return ErrExecution
		}
		if o.gitSource != nil && o.gitSource.transfer(o.ctx, id) != nil {
			return ErrExecution
		}
		for _, mount := range r.Mounts {
			if mount.Type != "volume" {
				continue
			}
			if o.volumes[mount.Source] {
				continue
			}
			phase = "engine_job_volume_ownership"
			if (o.plan.Catalog == protocol.ActionsRemoteCatalog || len(o.jobTLSCA) > 0) && mount.Destination == "/var/run/act" {
				if os.MkdirAll(filepath.Join(mount.Source, "home"), 0755) != nil {
					return ErrExecution
				}
			}
			if err = ownVolumeProfile(o.ctx, mount.Source, o.plan.Catalog == protocol.ActionsRemoteCatalog && mount.Destination == workspace); err != nil {
				return err
			}
			phase = "engine_job_action_ancestors"
			if mount.Destination == workspace && protectActionAncestors(o.ctx, mount.Source, protected) != nil {
				return ErrExecution
			}
			o.volumes[mount.Source] = true
		}
		phase = "engine_job_source_readback"
		if len(o.jobTLSCA) > 0 {
			if _, e := docker(o.ctx, bytes.NewReader(o.jobTLSCA), "exec", "-i", id, "/bin/sh", "-ec", "cat /etc/ssl/certs/ca-certificates.crt > /var/run/act/home/ca.crt; cat >> /var/run/act/home/ca.crt; chmod 0444 /var/run/act/home/ca.crt"); e != nil {
				return ErrExecution
			}
		}
		if o.plan.Catalog == protocol.ActionsRemoteCatalog {
			version, e := docker(o.ctx, nil, "exec", id, "/usr/local/bin/node", "--version")
			if e != nil || !regexp.MustCompile(`^v24\.[0-9]+\.[0-9]+\n$`).Match(version) {
				return ErrExecution
			}
		}
		if o.gitSource != nil && o.gitSource.verifyJob(o.ctx, id) != nil {
			return ErrExecution
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
	return ownVolumeProfile(ctx, directory, false)
}
func ownVolumeProfile(ctx context.Context, directory string, links bool) error {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return ErrExecution
	}
	defer root.Close()
	names, err := ownedVolumeNamesProfile(ctx, root, links)
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
	return ownedVolumeNamesProfile(ctx, root, false)
}
func ownedVolumeNamesProfile(ctx context.Context, root *os.Root, links bool) ([]string, error) {
	var names []string
	total := 0
	err := fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
		total += len(name)
		if err != nil || ctx.Err() != nil || len(names) >= 8192 || total > 1<<20 || !links && d.Type()&os.ModeSymlink != 0 {
			return ErrExecution
		}
		info, err := root.Lstat(name)
		if err == nil && links && info.Mode()&os.ModeSymlink != 0 {
			target, e := root.Readlink(name)
			if e != nil || !protocol.ValidGitSourceLink(name, target) {
				return ErrExecution
			}
			resolved := path.Clean(path.Join(path.Dir(name), target))
			for p := resolved; p != "."; p = path.Dir(p) {
				v, e := root.Lstat(p)
				if e != nil || v.Mode()&os.ModeSymlink != 0 || p != resolved && !v.IsDir() {
					return ErrExecution
				}
			}
			names = append(names, name)
			return nil
		}
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

// Native act normally creates separate workspace and command-file volumes for
// each job. Verify that property independently before copying source or ACKing
// setup. Keep bindings for the whole attempt, including already removed jobs:
// reuse cannot carry an earlier job's files into a later dependency stage.
// Only the tool cache may be shared; immutable action binds are checked above.
// Called under the observer lock, with an inspected owned container and mounts.
func (o *engineObserver) bindJobVolumes(r inspected) bool {
	if !containerID.MatchString(r.ID) {
		return false
	}
	bindings := map[string]string{}
	for _, mount := range r.Mounts {
		if mount.Type != "volume" {
			continue
		}
		owner := r.ID
		if mount.Destination == "/opt/hostedtoolcache" {
			owner = "toolcache"
		}
		if _, duplicate := bindings[mount.Source]; duplicate {
			return false
		}
		if previous, exists := o.volumeOwners[mount.Source]; exists && previous != owner {
			return false
		}
		bindings[mount.Source] = owner
	}
	if o.volumeOwners == nil {
		o.volumeOwners = map[string]string{}
	}
	for source, owner := range bindings {
		o.volumeOwners[source] = owner
	}
	return true
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

// Validation precedes any mutation of the native job environment. Repository
// values never become the helper/controller environment or planning input.
func applyRepositoryEnvironment(config *act.Config, env *protocol.ExecutionEnvironment) error {
	if env.Validate() != nil || config == nil {
		return protocol.ErrExecutionValues
	}
	if env == nil {
		return nil
	}
	if config.Env == nil {
		config.Env = map[string]string{}
	}
	for name, value := range env.Variables {
		config.Env[name] = value
	}
	for name, value := range env.Secrets {
		config.Env[name] = value
	}
	return nil
}

func (o *engineObserver) jobLimits() protocol.JobLimits {
	if o.limits == (protocol.JobLimits{}) {
		return protocol.DefaultJobLimits()
	}
	return o.limits
}
