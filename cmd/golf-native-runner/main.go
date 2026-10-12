// golf-native-runner is a customer-host supervisor for Cloudflare native PR jobs.
// Its machine credential remains on the host; job code only enters isolated Docker containers.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

const workflowContract = "golf.native.workflow-shell.v1"
const moduleContract = "golf.native.pr-test.v1"

var uuid = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
var sha = regexp.MustCompile(`^[a-f0-9]{40}$`)
var image = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var branch = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`)
var module = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,8}$`)
var workflowPath = regexp.MustCompile(`^\.github/workflows/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.ya?ml$`)

type config struct {
	Origin         string `json:"origin"`
	MachineID      string `json:"machineId"`
	ImageID        string `json:"imageId"`
	StateDirectory string `json:"stateDirectory"`
}
type step struct {
	Name  string `json:"name"`
	Run   string `json:"run"`
	Shell string `json:"shell"`
}
type plan struct {
	Format      string `json:"format"`
	Name        string `json:"name"`
	JobID       string `json:"jobId"`
	Steps       []step `json:"steps"`
	Image       string `json:"image"`
	AfterScript string `json:"afterScript"`
}
type assignment struct {
	Contract       string `json:"contract"`
	JobID          string `json:"jobId"`
	Generation     int    `json:"generation"`
	Lease          string `json:"lease"`
	LeaseExpiresAt int64  `json:"leaseExpiresAt"`
	Deadline       int64  `json:"deadline"`
	CommitID       string `json:"commitId"`
	TreeID         string `json:"treeId"`
	Branch         string `json:"branch"`
	ImageID        string `json:"imageId"`
	PolicySHA256   string `json:"policySha256"`
	WorkflowSHA256 string `json:"workflowSha256"`
	Workflow       struct {
		Path   string `json:"path"`
		BlobID string `json:"blobId"`
		Plan   plan   `json:"plan"`
	} `json:"workflow"`
	Module   string `json:"module"`
	CloneURL string `json:"cloneUrl"`
}
type client struct {
	config     config
	credential string
	http       *http.Client
}
type attemptJournal struct {
	ClaimID    string         `json:"claimId"`
	JobID      string         `json:"jobId,omitempty"`
	Generation int            `json:"generation,omitempty"`
	State      string         `json:"state"`
	Lease      string         `json:"lease,omitempty"`
	Finish     map[string]any `json:"finish,omitempty"`
}

func newUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]), nil
}
func validConfig(value config, credential string) error {
	u, err := url.Parse(value.Origin)
	if err != nil || u.String() != value.Origin || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" ||
		(u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) ||
		!uuid.MatchString(value.MachineID) || !image.MatchString(value.ImageID) || !filepath.IsAbs(value.StateDirectory) ||
		!regexp.MustCompile(`^golf_runner_[a-f0-9-]{36}_[a-f0-9]{64}$`).MatchString(credential) || !strings.HasPrefix(credential, "golf_runner_"+value.MachineID+"_") {
		return errors.New("use an exact HTTPS origin, enrolled machine credential, approved image ID and absolute private state directory")
	}
	return nil
}
func decode(body io.Reader, limit int64, target any) error {
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return errors.New("bounded native runner response required")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid native runner response")
	}
	return nil
}
func (c *client) call(ctx context.Context, path, lease string, input any, output any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.config.Origin+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.credential)
	request.Header.Set("Content-Type", "application/json")
	if lease != "" {
		request.Header.Set("X-Golf-Runner-Lease", lease)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return errors.New("native runner request unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("native runner request refused: HTTP %d", response.StatusCode)
	}
	return decode(response.Body, 128<<10, output)
}
func validate(a assignment, c config) error {
	if (a.Contract != workflowContract && a.Contract != moduleContract) || !uuid.MatchString(a.JobID) || a.Generation < 1 || a.Generation > 1000000 ||
		len(a.Lease) != 64 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(a.Lease) ||
		a.LeaseExpiresAt <= time.Now().UnixMilli() || a.Deadline <= time.Now().UnixMilli() || a.Deadline > time.Now().Add(10*time.Minute).UnixMilli() ||
		!sha.MatchString(a.CommitID) || !sha.MatchString(a.TreeID) || !branch.MatchString(a.Branch) ||
		strings.Contains(a.Branch, "..") || strings.Contains(a.Branch, "//") || a.ImageID != c.ImageID ||
		a.CloneURL != c.Origin+"/native/runner-machine/"+a.JobID+"/git" ||
		!regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(a.PolicySHA256) {
		return errors.New("native assignment differs from approved source and execution contract")
	}
	if a.Contract == moduleContract {
		if !module.MatchString(a.Module) || len(a.Module) > 128 || a.WorkflowSHA256 != "" || a.Workflow.Path != "" || a.Workflow.BlobID != "" || a.Workflow.Plan.Format != "" || a.Workflow.Plan.Name != "" || a.Workflow.Plan.JobID != "" || a.Workflow.Plan.Image != "" || a.Workflow.Plan.AfterScript != "" || len(a.Workflow.Plan.Steps) != 0 {
			return errors.New("invalid native Python module assignment")
		}
		return nil
	}
	if a.Module != "" || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(a.WorkflowSHA256) || !sha.MatchString(a.Workflow.BlobID) ||
		!(a.Workflow.Path == ".gitlab-ci.yml" && a.Workflow.Plan.Format == "gitlab" || workflowPath.MatchString(a.Workflow.Path) && a.Workflow.Plan.Format == "actions") ||
		len(a.Workflow.Plan.Steps) < 1 || len(a.Workflow.Plan.Steps) > 10 || !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`).MatchString(a.Workflow.Plan.JobID) ||
		len(a.Workflow.Plan.Name) > 128 || strings.ContainsAny(a.Workflow.Plan.Name, "\x00\r\n") ||
		(a.Workflow.Plan.Format == "actions" && (a.Workflow.Plan.AfterScript != "" || a.Workflow.Plan.Image != "")) ||
		(a.Workflow.Plan.Format == "gitlab" && (len(a.Workflow.Plan.Steps) != 1 || a.Workflow.Plan.Steps[0].Shell != "sh")) ||
		(a.Workflow.Plan.Image != "" && !regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,127}:[a-z0-9][a-z0-9._-]{0,63}@sha256:[a-f0-9]{64}$`).MatchString(a.Workflow.Plan.Image)) ||
		len(a.Workflow.Plan.AfterScript) > 8192 || strings.ContainsRune(a.Workflow.Plan.AfterScript, 0) || strings.Contains(a.Workflow.Plan.AfterScript, "${{") {
		return errors.New("invalid native workflow assignment")
	}
	total := len(a.Workflow.Plan.AfterScript)
	for _, step := range a.Workflow.Plan.Steps {
		total += len(step.Run)
		if strings.TrimSpace(step.Run) == "" || len(step.Run) > 8192 || strings.ContainsRune(step.Run, 0) || strings.Contains(step.Run, "${{") ||
			len(step.Name) > 128 || strings.ContainsAny(step.Name, "\x00\r\n") ||
			(step.Shell != "default" && step.Shell != "sh" && step.Shell != "bash") {
			return errors.New("invalid native shell step")
		}
	}
	if total > 16384 {
		return errors.New("native workflow script limit exceeded")
	}
	return nil
}
func command(ctx context.Context, dir string, environment []string, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = environment
	cmd.Stderr = io.Discard
	data, err := cmd.Output()
	if err != nil || len(data) > 4096 {
		return "", errors.New("trusted source preparation failed")
	}
	return strings.TrimSpace(string(data)), nil
}
func (c *client) source(ctx context.Context, a assignment, directory string) (string, error) {
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + directory, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_COUNT=4",
		"GIT_CONFIG_KEY_0=http.extraHeader", "GIT_CONFIG_VALUE_0=Authorization: Bearer " + c.credential,
		"GIT_CONFIG_KEY_1=http.extraHeader", "GIT_CONFIG_VALUE_1=X-Golf-Runner-Lease: " + a.Lease,
		"GIT_CONFIG_KEY_2=http.followRedirects", "GIT_CONFIG_VALUE_2=false",
		"GIT_CONFIG_KEY_3=core.hooksPath", "GIT_CONFIG_VALUE_3=/dev/null"}
	repo := filepath.Join(directory, "repo")
	if _, err := command(ctx, directory, env, "git", "clone", "--depth", "1", "--branch", a.Branch, "--", a.CloneURL, repo); err != nil {
		return "", err
	}
	head, err := command(ctx, repo, env, "git", "rev-parse", "HEAD")
	if err != nil || head != a.CommitID {
		return "", errors.New("selected commit moved")
	}
	tree, err := command(ctx, repo, env, "git", "rev-parse", "HEAD^{tree}")
	if err != nil || tree != a.TreeID {
		return "", errors.New("selected tree moved")
	}
	if a.Contract == workflowContract {
		blob, err := command(ctx, repo, env, "git", "rev-parse", "HEAD:"+a.Workflow.Path)
		if err != nil || blob != a.Workflow.BlobID {
			return "", errors.New("selected workflow moved")
		}
	}
	archive := filepath.Join(directory, "source.tar")
	if _, err := command(ctx, repo, env, "git", "archive", "--format=tar", "--output", archive, a.TreeID); err != nil {
		return "", err
	}
	return archive, nil
}
func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("runner state directory must be private")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("runner state directory must be owned by this process")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != filepath.Clean(path) {
		return errors.New("runner state directory cannot contain symlinks")
	}
	return nil
}
func journal(file string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".journal-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), file); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(file))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (c *client) finish(ctx context.Context, file string, record attemptJournal) error {
	var completed struct {
		Result struct {
			State string `json:"state"`
		} `json:"result"`
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err = c.call(callCtx, "/native/runner-machine/"+record.JobID+"/finish", record.Lease, record.Finish, &completed)
		cancel()
		if err == nil {
			break
		}
	}
	if err != nil {
		return err
	}
	if completed.Result.State != record.Finish["state"] {
		return errors.New("runner completion receipt differs")
	}
	return os.Remove(file)
}

func (c *client) recover(ctx context.Context) error {
	if err := privateDirectory(c.config.StateDirectory); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(c.config.StateDirectory, "runner.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("stop the native runner before local recovery")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	file := filepath.Join(c.config.StateDirectory, "active.json")
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	var record attemptJournal
	err = decode(f, 4096, &record)
	f.Close()
	if err != nil || (record.State != "claimed" && record.State != "cleanup-confirmed") || !uuid.MatchString(record.ClaimID) || !uuid.MatchString(record.JobID) || record.Generation < 1 {
		return errors.New("local recovery requires one inspectable attempt")
	}
	executor, err := runner.New(runner.Config{WorkerID: c.config.MachineID, ApprovedImages: []string{c.config.ImageID}})
	if err != nil {
		return err
	}
	if err = executor.CleanupWorker(ctx); err != nil {
		return err
	}
	entries, err := os.ReadDir(c.config.StateDirectory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "job-") {
			continue
		}
		path := filepath.Join(c.config.StateDirectory, entry.Name())
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("local source workspace needs manual inspection")
		}
		if err = os.RemoveAll(path); err != nil {
			return err
		}
	}
	if err = executor.RequireCleanWorker(ctx); err != nil {
		return err
	}
	if err = journal(file, attemptJournal{ClaimID: record.ClaimID, JobID: record.JobID, Generation: record.Generation, State: "locally-cleaned"}); err != nil {
		return err
	}
	fmt.Printf("Local cleanup confirmed for job %s generation %d. Inspect the workspace admin inventory. Reconcile this attempt if it is still active and terminal; once the machine shows no active job and confirmed cleanup, remove active.json before restarting.\n", record.JobID, record.Generation)
	return nil
}
func (c *client) runOnce(ctx context.Context) (bool, error) {
	if err := privateDirectory(c.config.StateDirectory); err != nil {
		return false, err
	}
	lock, err := os.OpenFile(filepath.Join(c.config.StateDirectory, "runner.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return false, errors.New("native runner state is already in use")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	executor, err := runner.New(runner.Config{WorkerID: c.config.MachineID, ApprovedImages: []string{c.config.ImageID}, MaxLogBytes: 64 << 10})
	if err != nil {
		return false, err
	}
	if err := executor.RequireCleanWorker(ctx); err != nil {
		return false, err
	}
	file := filepath.Join(c.config.StateDirectory, "active.json")
	var previous attemptJournal
	if existing, readErr := os.Open(file); readErr == nil {
		defer existing.Close()
		if decode(existing, 4096, &previous) != nil || !uuid.MatchString(previous.ClaimID) {
			return false, errors.New("prior runner journal needs operator inspection")
		}
		if previous.State == "cleanup-confirmed" && uuid.MatchString(previous.JobID) && previous.Generation > 0 && len(previous.Lease) == 64 && previous.Finish != nil {
			return true, c.finish(context.Background(), file, previous)
		}
		if previous.State != "claiming" {
			return false, errors.New("prior runner attempt requires cleanup reconciliation")
		}
	} else if !os.IsNotExist(readErr) {
		return false, readErr
	}
	imageID, err := command(ctx, c.config.StateDirectory, os.Environ(), "docker", "image", "inspect", "--format", "{{.Id}}", c.config.ImageID)
	if err != nil || imageID != c.config.ImageID {
		return false, errors.New("approved native runner image is unavailable")
	}
	claimID := previous.ClaimID
	if claimID == "" {
		claimID, err = newUUID()
		if err != nil {
			return false, err
		}
		f, createErr := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0600)
		if createErr != nil {
			return false, errors.New("prior runner attempt requires reconciliation")
		}
		_, err = f.WriteString(`{"claimId":"` + claimID + `","state":"claiming"}`)
		if err == nil {
			err = f.Sync()
		}
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return false, err
		}
	}
	var claimed struct {
		Assignment *assignment `json:"assignment"`
	}
	for attempt := 0; attempt < 3; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err = c.call(callCtx, "/native/runner-machine/claim", "", map[string]string{"claimId": claimID}, &claimed)
		cancel()
		if err == nil {
			break
		}
	}
	if err != nil {
		return false, err
	}
	if claimed.Assignment == nil {
		return false, os.Remove(file)
	}
	a := *claimed.Assignment
	if err = validate(a, c.config); err != nil {
		return false, err
	}
	if err = journal(file, attemptJournal{ClaimID: claimID, JobID: a.JobID, Generation: a.Generation, State: "claimed"}); err != nil {
		return false, err
	}
	working, err := os.MkdirTemp(c.config.StateDirectory, "job-")
	if err != nil {
		return false, err
	}
	runCtx, stop := context.WithDeadline(ctx, time.UnixMilli(a.Deadline))
	defer stop()
	heartbeatError := make(chan error, 1)
	done := make(chan struct{})
	heartbeatStopped := make(chan struct{})
	go func() {
		defer close(heartbeatStopped)
		timer := time.NewTicker(20 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			case <-runCtx.Done():
				return
			case <-timer.C:
				var response struct {
					LeaseExpiresAt int64 `json:"leaseExpiresAt"`
					Deadline       int64 `json:"deadline"`
				}
				callCtx, cancel := context.WithTimeout(runCtx, 15*time.Second)
				e := c.call(callCtx, "/native/runner-machine/"+a.JobID+"/heartbeat", a.Lease, map[string]any{}, &response)
				cancel()
				if e != nil || response.Deadline != a.Deadline || response.LeaseExpiresAt <= time.Now().UnixMilli() {
					heartbeatError <- errors.New("runner heartbeat lost")
					stop()
					return
				}
			}
		}
	}()
	archive, sourceErr := c.source(runCtx, a, working)
	var id [16]byte
	if _, err = rand.Read(id[:]); err != nil {
		return true, err
	}
	steps := make([]runner.Step, 0, len(a.Workflow.Plan.Steps)+1)
	jobName := a.Workflow.Plan.JobID
	if a.Contract == moduleContract {
		jobName = a.JobID
		steps = append(steps, runner.Step{Script: "python3 -m unittest -v " + a.Module, Shell: "sh"})
	} else {
		for _, value := range a.Workflow.Plan.Steps {
			steps = append(steps, runner.Step{Script: value.Run, Shell: value.Shell})
		}
	}
	job := runner.Job{AttemptID: hex.EncodeToString(id[:]), JobID: jobName, SourceCommit: a.CommitID, ImageDigest: a.ImageID,
		Steps: steps, AfterScript: a.Workflow.Plan.AfterScript, Timeout: time.Until(time.UnixMilli(a.Deadline)), SourceArchivePath: archive}
	var stdout, stderr bytes.Buffer
	result := runner.Result{ExitCode: -1}
	runErr := sourceErr
	if sourceErr == nil {
		result, runErr = executor.Execute(runCtx, job, func(_ context.Context, chunk runner.LogChunk) error {
			target := &stdout
			if chunk.Stream == "stderr" {
				target = &stderr
			}
			if target.Len()+len(chunk.Data) > 32<<10 {
				return errors.New("runner log limit")
			}
			_, e := target.Write(chunk.Data)
			return e
		})
	}
	if runErr != nil {
		fmt.Fprintln(os.Stderr, "native runner stage:", runErr)
	}
	close(done)
	<-heartbeatStopped
	select {
	case e := <-heartbeatError:
		return true, e
	default:
	}
	if errors.Is(runErr, runner.ErrCleanup) {
		return true, runErr
	}
	if runCtx.Err() != nil {
		return true, errors.New("runner deadline or authority ended; reconcile cleanup")
	}
	state := "PASSED"
	code := result.ExitCode
	if runErr != nil {
		state = "LOST"
		code = -1
	} else if result.TimedOut {
		state = "TIMED_OUT"
		code = 124
	} else if result.Cancelled {
		state = "LOST"
		code = -1
	} else if code != 0 {
		state = "FAILED"
	}
	finish := map[string]any{"state": state, "stdout": stdout.String(), "stderr": stderr.String(), "cleanup": "confirmed"}
	if code < 0 {
		finish["exitCode"] = nil
	} else {
		finish["exitCode"] = code
	}
	if err = os.RemoveAll(working); err != nil {
		return true, errors.New("local source cleanup failed; reconcile before reusing runner")
	}
	if err = journal(file, attemptJournal{ClaimID: claimID, JobID: a.JobID, Generation: a.Generation, State: "cleanup-confirmed", Lease: a.Lease, Finish: finish}); err != nil {
		return true, err
	}
	return true, c.finish(context.Background(), file, attemptJournal{JobID: a.JobID, Lease: a.Lease, Finish: finish})
}
func main() {
	recovery := len(os.Args) == 3 && os.Args[1] == "recover"
	if len(os.Args) != 2 && !recovery {
		fmt.Fprintln(os.Stderr, "usage: golf-native-runner [recover] CONFIG_JSON")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[len(os.Args)-1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner configuration unavailable")
		os.Exit(1)
	}
	var config config
	if decode(bytes.NewReader(data), 4096, &config) != nil {
		fmt.Fprintln(os.Stderr, "invalid runner configuration")
		os.Exit(1)
	}
	credential := os.Getenv("GOLF_NATIVE_RUNNER_CREDENTIAL")
	os.Unsetenv("GOLF_NATIVE_RUNNER_CREDENTIAL")
	if err = validConfig(config, credential); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	c := client{config: config, credential: credential, http: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if recovery {
		if err := c.recover(ctx); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	for ctx.Err() == nil {
		worked, e := c.runOnce(ctx)
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
		if worked {
			fmt.Println("native runner job completed")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}
