// golf-runner is an operator process for a dedicated Docker host. Its enrollment
// and attempt credentials stay in this process, never in an untrusted container.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/mjtechguy/golf-git/internal/runner"
)

const sourceLimit = 16 << 20
const logLimit = 256 << 10

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var attemptID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var hashID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var commitID = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var errTransport = errors.New("runner coordinator request failed")
var errUnauthorized = errors.New("runner enrollment is not authorized")
var errOutputBound = errors.New("normalized output exceeds its bound")

type coordinator struct {
	origin, id, key string
	client          *http.Client
	actions         *runner.ActionsExecutor
	verifiedTLS     atomic.Bool
}
type assignment struct {
	ArtifactPaths        []string                     `json:"artifactPaths,omitempty"`
	JobResources         *runner.JobResourceBinding   `json:"jobResources"`
	RunID                string                       `json:"runId"`
	AttemptID            string                       `json:"attemptId"`
	AttemptToken         string                       `json:"attemptToken"`
	JobID                string                       `json:"jobId"`
	ImageDigest          string                       `json:"imageDigest"`
	CommitID             string                       `json:"commitId"`
	SourceSHA256         string                       `json:"sourceSha256"`
	EngineCatalog        string                       `json:"engineCatalog"`
	ActionsPlan          *runner.ActionPlan           `json:"actionsPlan"`
	EventJSON            []byte                       `json:"eventJson"`
	ManualInputs         *runner.ActionManualInputs   `json:"manualInputs,omitempty"`
	ExecutionEnvironment *runner.ExecutionEnvironment `json:"executionEnvironment,omitempty"`
	Steps                []struct {
		Name  string
		Run   string
		Shell string
	} `json:"steps"`
	TimeoutSeconds int `json:"timeoutSeconds"`
	LeaseSeconds   int `json:"leaseSeconds"`
}
type finish struct {
	ExitCode            int    `json:"exitCode"`
	EngineConclusion    string `json:"engineConclusion,omitempty"`
	TimedOut            bool   `json:"timedOut"`
	Cancelled           bool   `json:"cancelled"`
	InfrastructureError bool   `json:"infrastructureError"`
	LogsTruncated       bool   `json:"logsTruncated"`
}

func tokenOK(s string) bool {
	return len(s) >= 32 && len(s) <= 1024 && !strings.ContainsAny(s, "\r\n\t ")
}
func coordinatorURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" {
		return "", errTransport
	}
	host := u.Hostname()
	if u.Scheme != "https" && (u.Scheme != "http" || (host != "localhost" && host != "127.0.0.1" && host != "::1")) {
		return "", errTransport
	}
	u.Path = ""
	return u.String(), nil
}
func (c *coordinator) request(ctx context.Context, method, route, attemptToken string, body any) (*http.Response, error) {
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, errTransport
		}
		input = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+route, input)
	if err != nil {
		return nil, errTransport
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Golf-Runner-ID", c.id)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if attemptToken != "" {
		req.Header.Set("Golf-Attempt-Token", attemptToken)
	}
	response, err := c.client.Do(req)
	c.verifiedTLS.Store(err == nil && c.verifiedResponseTLS(response))
	if err != nil {
		return nil, errTransport
	}
	return response, nil
}
func (c *coordinator) post(ctx context.Context, a assignment, action string, body any) error {
	response, err := c.request(ctx, http.MethodPost, "/internal/ci/attempt/"+a.AttemptID+"/"+action, a.AttemptToken, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return &coordinatorPostError{status: response.StatusCode}
	}
	return nil
}

// Only a numeric response status is retained; never response bytes or headers.
type coordinatorPostError struct{ status int }

func (e *coordinatorPostError) Error() string { return errTransport.Error() }
func (e *coordinatorPostError) Unwrap() error { return errTransport }

func (c *coordinator) poll(ctx context.Context) (*assignment, error) {
	response, err := c.request(ctx, http.MethodPost, "/internal/ci/poll", "", c.pollCapabilities())
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return nil, errUnauthorized
	}
	if response.StatusCode != http.StatusOK {
		return nil, errTransport
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 768<<10+1))
	if err != nil || len(data) > 768<<10 {
		return nil, errTransport
	}
	var a assignment
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&a) != nil || decoder.Decode(new(any)) != io.EOF || !safeID.MatchString(a.RunID) || !attemptID.MatchString(a.AttemptID) || !tokenOK(a.AttemptToken) || !commitID.MatchString(a.CommitID) || !hashID.MatchString(a.SourceSHA256) || a.TimeoutSeconds < 1 || a.TimeoutSeconds > 900 || a.LeaseSeconds < 30 || a.LeaseSeconds > 300 || !c.validAssignment(a) {
		return nil, errTransport
	}
	return &a, nil
}
func (c *coordinator) source(ctx context.Context, a assignment, directory string) (string, error) {
	response, err := c.request(ctx, http.MethodGet, "/internal/ci/attempt/"+a.AttemptID+"/source", a.AttemptToken, nil)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > sourceLimit {
		return "", errTransport
	}
	if len(a.ArtifactPaths) > 0 && !c.verifiedResponseTLS(response) {
		return "", errTransport
	}
	file, err := os.OpenFile(filepath.Join(directory, "source.tar"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", errTransport
	}
	digest := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(file, digest), io.LimitReader(response.Body, sourceLimit+1))
	closeErr := file.Close()
	expected, _ := hex.DecodeString(a.SourceSHA256)
	if copyErr != nil || closeErr != nil || size > sourceLimit || subtle.ConstantTimeCompare(digest.Sum(nil), expected) != 1 {
		return "", errTransport
	}
	return file.Name(), nil
}

// Each stream retains only its incomplete UTF-8 suffix. Invalid bytes become
// replacement characters; chunks sent to the API end at rune boundaries.
type logForwarder struct {
	c                     *coordinator
	a                     assignment
	sequence              int
	total                 int
	pending               map[string][]byte
	jobInstanceID, stepID string
}

func (l *logForwarder) send(ctx context.Context, text string) error {
	if text == "" {
		return nil
	}
	if l.total+len(text) > logLimit {
		return errOutputBound
	}
	next := l.sequence + 1
	if err := l.c.post(ctx, l.a, "logs", struct {
		Sequence      int    `json:"sequence"`
		Text          string `json:"text"`
		JobInstanceID string `json:"jobInstanceId,omitempty"`
		StepID        string `json:"stepId,omitempty"`
	}{next, text, l.jobInstanceID, l.stepID}); err != nil {
		return err
	}
	l.sequence = next
	l.total += len(text)
	return nil
}
func (l *logForwarder) write(ctx context.Context, chunk runner.LogChunk, final bool) error {
	if l.pending == nil {
		l.pending = map[string][]byte{}
	}
	data := append(l.pending[chunk.Stream], chunk.Data...)
	var output strings.Builder
	for len(data) > 0 {
		if !utf8.FullRune(data) && !final {
			break
		}
		value, size := utf8.DecodeRune(data)
		if !utf8.FullRune(data) {
			value, size = utf8.RuneError, len(data)
		}
		if value == 0 {
			value = utf8.RuneError
		}
		width := utf8.RuneLen(value)
		if output.Len()+width > 4<<10 {
			if err := l.send(ctx, output.String()); err != nil {
				return err
			}
			output.Reset()
		}
		output.WriteRune(value)
		data = data[size:]
	}
	l.pending[chunk.Stream] = append([]byte(nil), data...)
	return l.send(ctx, output.String())
}
func (c *coordinator) execute(parent context.Context, e *runner.Executor, a assignment) bool {
	ctx, cancel := context.WithTimeout(parent, time.Duration(a.TimeoutSeconds)*time.Second)
	defer cancel()
	var heartbeatFailed atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := c.post(ctx, a, "heartbeat", struct{}{}); err != nil {
					if ctx.Err() == nil {
						heartbeatFailed.Store(true)
						cancel()
					}
					return
				}
			}
		}
	}()
	result := finish{ExitCode: 255}
	directory, err := os.MkdirTemp("", "golf-runner-")
	if err == nil {
		defer os.RemoveAll(directory)
	}
	var source string
	if err == nil {
		source, err = c.source(ctx, a, directory)
	}
	forward := logForwarder{c: c, a: a}
	var outputBound atomic.Bool
	if err == nil && a.ActionsPlan != nil {
		var execution runner.Result
		execution, err = c.executeActions(ctx, a, source, &forward)
		reportActionsFailure(os.Stderr, err)
		result = finish{ExitCode: 0, TimedOut: execution.TimedOut, Cancelled: execution.Cancelled, InfrastructureError: err != nil}
		if err == nil {
			result.EngineConclusion = "success"
			if execution.ExitCode != 0 {
				result.EngineConclusion = "failure"
			}
		}
	} else if err == nil {
		job := runner.Job{AttemptID: a.AttemptID, JobID: a.JobID, SourceCommit: a.CommitID, ImageDigest: a.ImageDigest, Timeout: time.Duration(a.TimeoutSeconds) * time.Second, SourceArchivePath: source, Resources: &a.JobResources.Limits, ArtifactPaths: a.ArtifactPaths}
		if len(a.ArtifactPaths) > 0 {
			job.OnArtifacts = func(ctx context.Context, data []byte) error { return c.uploadArtifact(ctx, a, data) }
		}
		for _, step := range a.Steps {
			job.Steps = append(job.Steps, runner.Step{Script: step.Run, Shell: step.Shell})
		}
		job.OnProgress = func(ctx context.Context, event runner.StepEvent) error {
			sequence := event.Index*2 + 1
			if event.Kind == "finished" {
				sequence++
				// Close incomplete UTF-8 suffixes before recording the step's immutable
				// log boundary. A suffix cannot drift into the next step's output.
				for _, stream := range []string{"stdout", "stderr"} {
					if err := forward.write(ctx, runner.LogChunk{Stream: stream}, true); err != nil {
						return err
					}
				}
			}
			return c.post(ctx, a, "progress", struct {
				Sequence  int    `json:"sequence"`
				StepIndex int    `json:"stepIndex"`
				Kind      string `json:"kind"`
				ExitCode  int    `json:"exitCode"`
			}{sequence, event.Index, event.Kind, event.ExitCode})
		}
		var execution runner.Result
		execution, err = e.Execute(ctx, job, func(ctx context.Context, chunk runner.LogChunk) error {
			err := forward.write(ctx, chunk, false)
			if errors.Is(err, errOutputBound) {
				outputBound.Store(true)
			}
			return err
		})
		result = finish{ExitCode: execution.ExitCode, TimedOut: execution.TimedOut, Cancelled: execution.Cancelled, LogsTruncated: execution.LogsTruncated || outputBound.Load()}
		if err == nil && ctx.Err() == nil {
			for _, stream := range []string{"stdout", "stderr"} {
				if flushErr := forward.write(ctx, runner.LogChunk{Stream: stream}, true); flushErr != nil {
					err = flushErr
					result.LogsTruncated = result.LogsTruncated || errors.Is(flushErr, errOutputBound)
					break
				}
			}
		}
	}
	result.TimedOut = result.TimedOut || errors.Is(ctx.Err(), context.DeadlineExceeded)
	result.Cancelled = result.Cancelled || parent.Err() != nil || heartbeatFailed.Load()
	result.InfrastructureError = err != nil || heartbeatFailed.Load()
	if result.ExitCode < 0 || result.ExitCode > 255 {
		result.ExitCode = 255
	}
	cancel()
	<-done
	finalCtx, stop := context.WithTimeout(context.Background(), 8*time.Second)
	defer stop()
	state := "finished"
	if c.post(finalCtx, a, "finish", result) != nil {
		state = "result_unconfirmed"
	}
	report(a, state)
	return !errors.Is(err, runner.ErrCleanup)
}
func report(a assignment, state string) {
	_ = json.NewEncoder(os.Stdout).Encode(struct {
		RunID     string `json:"runId"`
		AttemptID string `json:"attemptId"`
		State     string `json:"state"`
	}{a.RunID, a.AttemptID, state})
}
func run(ctx context.Context) error {
	origin, err := coordinatorURL(os.Getenv("GOLF_RUNNER_URL"))
	if err != nil {
		return err
	}
	id, key := os.Getenv("GOLF_RUNNER_ID"), os.Getenv("GOLF_RUNNER_KEY")
	if !safeID.MatchString(id) || !tokenOK(key) {
		return errTransport
	}
	var images []string
	if json.Unmarshal([]byte(os.Getenv("GOLF_RUNNER_APPROVED_IMAGES")), &images) != nil {
		return errTransport
	}
	executor, err := runner.New(runner.Config{WorkerID: id, DockerBinary: os.Getenv("GOLF_RUNNER_DOCKER_BINARY"), ApprovedImages: images})
	if err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig, err = runnerTLSConfig(origin, os.Getenv("GOLF_RUNNER_TLS_CA_FILE"))
	if err != nil {
		return err
	}
	defer transport.CloseIdleConnections()
	c := &coordinator{origin: origin, id: id, key: key, client: &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if binary := os.Getenv("GOLF_RUNNER_ACTIONS_ENGINE_BINARY"); binary != "" {
		c.actions, err = runner.NewActions(executor, binary)
		if err != nil {
			return err
		}
	}
	if len(os.Args) > 1 {
		if len(os.Args) != 2 || os.Args[1] != "recover" {
			return errTransport
		}
		response, err := c.request(ctx, http.MethodPost, "/internal/ci/recover", "", struct{}{})
		if err != nil {
			return err
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			return errTransport
		}
		if err := executor.CleanupWorker(ctx); err != nil {
			return err
		}
		report(assignment{}, "recovered")
		return nil
	}
	if c.actions != nil {
		if err = executor.RequireCleanWorker(ctx); err != nil {
			return err
		}
	}
	for ctx.Err() == nil {
		a, err := c.poll(ctx)
		if errors.Is(err, errUnauthorized) {
			return err
		}
		if err == nil && a != nil {
			report(*a, "assigned")
			if !c.execute(ctx, executor, *a) {
				return runner.ErrCleanup
			}
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(2 * time.Second):
		}
	}
	return nil
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "Golf runner could not start or its enrollment was denied; check operator configuration.")
		os.Exit(1)
	}
}

// Typed input advertisement follows an actual verified response, never a URL
// prefix or forwarded assertion. Every response refreshes this observation.
func (c *coordinator) verifyingHTTPS() bool {
	origin, err := coordinatorURL(c.origin)
	if err != nil || origin != c.origin || !strings.HasPrefix(origin, "https://") || c.client == nil {
		return false
	}
	transport, ok := c.client.Transport.(*http.Transport)
	return ok && transport.TLSClientConfig != nil && !transport.TLSClientConfig.InsecureSkipVerify && transport.TLSClientConfig.MinVersion >= tls.VersionTLS13
}
func (c *coordinator) verifiedResponseTLS(response *http.Response) bool {
	if !c.verifyingHTTPS() || response == nil || response.TLS == nil || response.TLS.Version < tls.VersionTLS13 || len(response.TLS.VerifiedChains) == 0 || len(response.TLS.PeerCertificates) == 0 {
		return false
	}
	parsed, _ := url.Parse(c.origin)
	return response.TLS.PeerCertificates[0].VerifyHostname(parsed.Hostname()) == nil
}
func (c *coordinator) manualInputsReady() bool { return c.verifiedTLS.Load() && c.verifyingHTTPS() }

func (c *coordinator) pollCapabilities() any {
	out := struct {
		Catalogs     []string `json:"catalogs"`
		Capabilities []string `json:"capabilities,omitempty"`
	}{Capabilities: []string{runner.JobLimitsCapability}}
	if c.actions != nil {
		out.Catalogs = []string{runner.ActionsCatalog}
	}
	if c.actions != nil && strings.HasPrefix(c.origin, "https://") {
		out.Capabilities = append(out.Capabilities, runner.ExecutionValuesCapability)
	}
	if c.actions != nil && c.manualInputsReady() {
		out.Catalogs = append(out.Catalogs, runner.ActionsInputsCatalog)
		if os.Getenv("GOLF_RUNNER_ACTIONS_AGENTS088") == "1" {
			out.Catalogs = append(out.Catalogs, runner.ActionsAgentCatalog)
		}
		out.Capabilities = append(out.Capabilities, runner.ManualInputsCapability)
	}
	if c.manualInputsReady() {
		out.Capabilities = append(out.Capabilities, runner.ArtifactCapability)
	}
	return out
}
func (c *coordinator) validAssignment(a assignment) bool {
	if a.EngineCatalog == runner.ActionsAgentCatalog && (os.Getenv("GOLF_RUNNER_ACTIONS_AGENTS088") != "1" || !c.manualInputsReady()) {
		return false
	}
	if len(a.ArtifactPaths) > 0 && (!c.manualInputsReady() || runner.ValidateArtifactPaths(a.ArtifactPaths) != nil || a.ActionsPlan != nil || a.ManualInputs != nil || a.ExecutionEnvironment != nil || a.EngineCatalog != "") {
		return false
	}
	if a.JobResources == nil || a.JobResources.Validate() != nil || a.TimeoutSeconds != int(a.JobResources.Limits.TimeoutSeconds) {
		return false
	}
	if a.ExecutionEnvironment != nil && (!strings.HasPrefix(c.origin, "https://") || a.ExecutionEnvironment.Validate() != nil || !runner.IsActionsCatalog(a.EngineCatalog)) {
		return false
	}
	if a.EngineCatalog == "" {
		return a.ManualInputs == nil && a.ActionsPlan == nil && len(a.Steps) >= 1 && len(a.Steps) <= 50
	}
	return c.actions != nil && (runner.IsActionsCatalog(a.EngineCatalog) && (a.EngineCatalog != runner.ActionsInputsCatalog || c.manualInputsReady())) && a.ActionsPlan != nil && len(a.Steps) == 0 && a.ActionsPlan.Catalog == a.EngineCatalog && runner.ValidateActionManualInputs(*a.ActionsPlan, a.ManualInputs, a.EventJSON, a.CommitID) == nil && a.ActionsPlan.ArchiveSHA256 == a.SourceSHA256 && len(a.ActionsPlan.Jobs) >= 1 && len(a.ActionsPlan.Jobs) <= 12 && len(a.EventJSON) > 0 && len(a.EventJSON) <= 16<<10
}

// Operator diagnostic only: never format untrusted error strings or run data.
func reportActionsFailure(output io.Writer, err error) {
	if err == nil {
		return
	}
	phase := runner.ActionsFailureStage(err)
	if phase == "" {
		phase = "coordinator_preparation"
	}
	fmt.Fprintln(output, "Golf Actions lifecycle failure: stage="+phase)
	var ack *actionFrameAckError
	if errors.As(err, &ack) {
		kind := "unknown"
		switch ack.kind {
		case "log", "job_started", "job_finished", "step_started", "step_finished", "complete":
			kind = ack.kind
		}
		scope := "unknown"
		switch ack.scope {
		case "job", "step", "run":
			scope = ack.scope
		}
		status := "unknown"
		var response *coordinatorPostError
		if errors.As(ack.cause, &response) && response.status >= 100 && response.status <= 599 {
			status = fmt.Sprint(response.status)
		}
		fmt.Fprintln(output, "Golf Actions acknowledgement failure: kind="+kind+"; scope="+scope+"; http_status="+status)
	}
}

// Construct the engine request from the original accepted assignment; neither
// defaults nor a newer source/schema are substituted by the worker.
func actionsExecutionInput(a assignment, archive []byte, images map[string]string) runner.ActionExecutionInput {
	return runner.ActionExecutionInput{ManualInputs: a.ManualInputs, Input: runner.ActionPlanInput{Catalog: a.EngineCatalog, ManualInputsContract: a.ActionsPlan.ManualInputsContract, ManualInputsSchemaSHA256: a.ActionsPlan.ManualInputsSchemaSHA256, WorkflowPath: a.ActionsPlan.WorkflowPath, WorkflowBlobID: a.ActionsPlan.WorkflowBlobID, Archive: archive, Event: a.ActionsPlan.Event, Ref: a.ActionsPlan.Ref, Images: images}, Plan: *a.ActionsPlan, EventJSON: a.EventJSON, CommitID: a.CommitID, TimeoutSeconds: a.TimeoutSeconds, ExecutionEnvironment: a.ExecutionEnvironment, JobResources: a.JobResources}
}

func (c *coordinator) executeActions(ctx context.Context, a assignment, source string, forward *logForwarder) (runner.Result, error) {
	archive, err := os.ReadFile(source)
	if err != nil || len(archive) > sourceLimit {
		return runner.Result{}, errTransport
	}
	images := map[string]string{}
	// Each frozen job image receives an internal label. The helper must derive
	// the same admitted graph from the original YAML, so original runs-on labels
	// are supplied from the independent operator map, never fabricated here.
	if json.Unmarshal([]byte(os.Getenv("GOLF_RUNNER_ACTIONS_PLATFORMS")), &images) != nil || len(images) == 0 {
		return runner.Result{}, errTransport
	}
	input := actionsExecutionInput(a, archive, images)
	var acknowledgementFailure error
	result, err := c.actions.Execute(ctx, a.AttemptID, input, func(ctx context.Context, frame runner.ActionFrame) error {
		acknowledgementFailure = c.acknowledgeActionFrame(ctx, a, forward, frame)
		return acknowledgementFailure
	})
	// The executor intentionally returns a closed infrastructure error on failure.
	// Retain only our bounded acknowledgement classification beside that policy.
	if err != nil && acknowledgementFailure != nil {
		return result, errors.Join(err, acknowledgementFailure)
	}
	return result, err
}

type actionFrameAckError struct {
	kind, scope string
	cause       error
}

func (e *actionFrameAckError) Error() string { return "Actions durable acknowledgement refused" }
func (e *actionFrameAckError) Unwrap() error { return e.cause }

func (c *coordinator) acknowledgeActionFrame(ctx context.Context, a assignment, forward *logForwarder, frame runner.ActionFrame) error {
	var err error
	if frame.Kind == "agent_requested" {
		err = c.workflowAgentStep(ctx, a, frame)
	} else if frame.Kind == "log" {
		forward.jobInstanceID, forward.stepID = frame.InstanceID, frame.StepID
		err = forward.write(ctx, runner.LogChunk{Stream: "stdout", Data: []byte(frame.Text)}, true)
	} else {
		err = c.post(ctx, a, "graph", struct {
			Sequence      int    `json:"sequence"`
			JobInstanceID string `json:"jobInstanceId"`
			StepID        string `json:"stepId"`
			Kind          string `json:"kind"`
			State         string `json:"state"`
		}{frame.EventSequence, frame.InstanceID, frame.StepID, frame.Kind, frame.State})
	}
	if err == nil {
		return nil
	}
	scope := "run"
	if frame.InstanceID != "" {
		scope = "job"
	}
	if frame.StepID != "" {
		scope = "step"
	}
	return &actionFrameAckError{kind: frame.Kind, scope: scope, cause: err}
}

// HTTPS identity is verified by net/http using system roots plus an optional
// operator-mounted public CA. No forwarded assertion or insecure verification.
func runnerTLSConfig(origin, caFile string) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS13}
	if caFile == "" {
		return config, nil
	}
	if !strings.HasPrefix(origin, "https://") || !filepath.IsAbs(caFile) || filepath.Clean(caFile) != caFile {
		return nil, errTransport
	}
	file, e := os.Open(caFile)
	if e != nil {
		return nil, errTransport
	}
	defer file.Close()
	stat, e := file.Stat()
	if e != nil || !stat.Mode().IsRegular() || stat.Size() < 1 || stat.Size() > 64<<10 {
		return nil, errTransport
	}
	data, e := io.ReadAll(io.LimitReader(file, 64<<10+1))
	if e != nil || len(data) > 64<<10 {
		return nil, errTransport
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		return nil, errTransport
	}
	if !roots.AppendCertsFromPEM(data) {
		return nil, errTransport
	}
	config.RootCAs = roots
	return config, nil
}
