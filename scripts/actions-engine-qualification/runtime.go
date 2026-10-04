package actionsengineproof

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/model"
	"github.com/nektos/act/pkg/runner"
	"github.com/sirupsen/logrus"
)

const runtimeWorkspace = "/qualification/workspace"

var imageIDPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type RuntimeReceipt struct {
	Case                         string   `json:"case"`
	Event                        string   `json:"event"`
	ImageID                      string   `json:"imageId"`
	FixtureSHA256                string   `json:"fixtureSha256"`
	EventSHA256                  string   `json:"eventSha256"`
	Effects                      []string `json:"effects"`
	ObservedContainers           int      `json:"observedContainers"`
	RawOutputCount               int      `json:"rawOutputCount"`
	TrustedFinishedSteps         int      `json:"trustedFinishedSteps"`
	NativeCleanup                bool     `json:"nativeCleanup"`
	SkippedSteps                 int      `json:"skippedSteps"`
	EngineFailure                string   `json:"engineFailure,omitempty"`
	TrustedVolumeInitializations int      `json:"trustedVolumeInitializations"`
	FailedSteps                  []string `json:"failedSteps,omitempty"`
}

// RunOffline is a qualification entry point, never a Golf assignment adapter.
// The launcher must own the entire daemon; ambient/public daemon hosts refuse.
func RunOffline(image, caseName, event string) (RuntimeReceipt, error) {
	receipt := RuntimeReceipt{Case: caseName, Event: event, ImageID: image}
	if !imageIDPattern.MatchString(image) || os.Getenv("DOCKER_HOST") != "unix:///var/run/docker.sock" ||
		os.Getenv("GOLF_OWNED_ENGINE_DAEMON") != "1" {
		return receipt, errors.New("owned offline daemon required")
	}
	for _, item := range os.Environ() {
		key := strings.SplitN(item, "=", 2)[0]
		if strings.HasPrefix(key, "GOLF_") && key != "GOLF_OWNED_ENGINE_DAEMON" {
			return receipt, errors.New("control credentials refused")
		}
	}
	source := graphFixture
	if caseName == "cancel" || caseName == "terminate" {
		source = hangFixture
	} else if caseName == "failure" {
		source = failureFixture
	} else if caseName != "graph" {
		return receipt, errors.New("unknown owned fixture")
	}
	plan, err := runtimePlan(source, event)
	if err != nil {
		return receipt, err
	}
	if err = os.MkdirAll(filepath.Join(runtimeWorkspace, "actions/owned-composite"), 0o755); err != nil {
		return receipt, errors.New("fixture directory")
	}
	if err = os.WriteFile(filepath.Join(runtimeWorkspace, "actions/owned-composite/action.yml"), []byte(compositeFixture), 0o644); err != nil {
		return receipt, errors.New("fixture action")
	}
	hash := sha256.Sum256([]byte(source + "\x00" + compositeFixture))
	receipt.FixtureSHA256 = hex.EncodeToString(hash[:])
	eventBody := []byte(`{"ref":"refs/heads/main","repository":{"name":"offline","default_branch":"main","owner":{"login":"owned"}},"inputs":{"owned":"explicit"}}`)
	eventHash := sha256.Sum256(eventBody)
	receipt.EventSHA256 = hex.EncodeToString(eventHash[:])
	if err = os.WriteFile("/qualification/event.json", eventBody, 0o600); err != nil {
		return receipt, errors.New("owned event fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if caseName == "cancel" {
		ctx, cancel = context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
	}
	initial, err := docker(ctx, "ps", "-aq")
	if err != nil || strings.TrimSpace(string(initial)) != "" {
		return receipt, errors.New("daemon not empty")
	}
	imageRaw, err := docker(ctx, "image", "inspect", image)
	var images []struct {
		ID string `json:"Id"`
	}
	if err != nil || json.Unmarshal(imageRaw, &images) != nil || len(images) != 1 || images[0].ID != image {
		return receipt, errors.New("exact preinstalled image missing")
	}
	observer := &runtimeObserver{image: image, cancel: cancel, effects: map[string]bool{}, containers: map[string]bool{}, prepared: map[string]bool{}}
	logrus.SetOutput(io.Discard)
	logrus.SetLevel(logrus.DebugLevel)
	r, err := runner.New(&runner.Config{
		Actor: "owned-qualification", Workdir: runtimeWorkspace, EventName: event,
		EventPath: "/qualification/event.json", Env: map[string]string{"OWNED_EVENT": event},
		Platforms: map[string]string{"golf-qualification": image}, ContainerDaemonSocket: "-",
		ContainerNetworkMode: "none", BindWorkdir: false, ActionOfflineMode: true,
		ForcePull: false, Privileged: false, AutoRemove: true, ConcurrentJobs: 2,
		ContainerCapDrop: []string{"ALL"}, ContainerOptions: "--user=1000:1000 --security-opt=no-new-privileges --cpus=1 --memory=268435456 --memory-swap=268435456 --pids-limit=64",
	})
	if err != nil {
		return receipt, errors.New("engine configuration")
	}
	ctx = runner.WithJobLoggerFactory(ctx, observer)
	controlLogger := logrus.New()
	controlLogger.SetOutput(io.Discard)
	ctx = common.WithLogger(ctx, controlLogger.WithField("qualification", true))
	// Kill qualification is externally terminated by the trusted launcher.
	if caseName == "terminate" {
		if err := os.WriteFile("/qualification/engine.pid", []byte(strings.TrimSpace(pidString())), 0o600); err != nil {
			return receipt, errors.New("owned pid receipt")
		}
	}
	err = r.NewPlanExecutor(plan)(ctx)
	if err != nil {
		receipt.EngineFailure = err.Error()
		if len(receipt.EngineFailure) > 512 {
			receipt.EngineFailure = receipt.EngineFailure[:512]
		}
	}
	observer.mu.Lock()
	for effect := range observer.effects {
		receipt.Effects = append(receipt.Effects, effect)
	}
	receipt.ObservedContainers = len(observer.containers)
	receipt.RawOutputCount, receipt.TrustedFinishedSteps, receipt.SkippedSteps = observer.raw, observer.finished, observer.skipped
	receipt.TrustedVolumeInitializations = observer.initialized
	receipt.FailedSteps = append([]string(nil), observer.failed...)
	observationError := observer.err
	observer.mu.Unlock()
	sort.Strings(receipt.Effects)
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cleanupCancel()
	remaining, cleanupErr := docker(cleanupCtx, "ps", "-aq")
	receipt.NativeCleanup = cleanupErr == nil && strings.TrimSpace(string(remaining)) == ""
	if observationError != nil {
		return receipt, observationError
	}
	if !receipt.NativeCleanup {
		return receipt, errors.New("engine cleanup incomplete")
	}
	switch caseName {
	case "graph":
		if err != nil || strings.Join(receipt.Effects, ",") != "build,lint,matrix-a,matrix-b,package" || receipt.ObservedContainers != 5 || receipt.RawOutputCount < 2 || receipt.SkippedSteps < 2 {
			return receipt, errors.New("owned graph effects differ")
		}
	case "cancel":
		if err == nil || strings.Join(receipt.Effects, ",") != "hang-started" {
			return receipt, errors.New("hard deadline not observed")
		}
	case "failure":
		if err == nil || len(receipt.Effects) != 0 {
			return receipt, errors.New("failure or skipped effect differs")
		}
	}
	return receipt, nil
}

func pidString() string { return strconv.Itoa(os.Getpid()) }

type runtimeObserver struct {
	mu                                           sync.Mutex
	image                                        string
	cancel                                       context.CancelFunc
	effects, containers                          map[string]bool
	prepared                                     map[string]bool
	raw, finished, entries, skipped, initialized int
	err                                          error
	failed                                       []string
}

func (o *runtimeObserver) WithJobLogger() *logrus.Logger {
	l := logrus.New()
	l.SetOutput(io.Discard)
	l.SetLevel(logrus.DebugLevel)
	l.AddHook(o)
	return l
}
func (o *runtimeObserver) Levels() []logrus.Level { return logrus.AllLevels }
func (o *runtimeObserver) Fire(entry *logrus.Entry) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.entries++
	if o.entries > 4096 || len(entry.Message) > 16<<10 {
		o.fail("engine output bound")
		return nil
	}
	if entry.Data["raw_output"] == true {
		o.raw++
		return nil
	}
	if entry.Data["jobID"] == "invented" {
		o.fail("untrusted output became engine identity")
		return nil
	}
	if _, ok := entry.Data["stepResult"]; !ok {
		return nil
	}
	o.finished++
	if entry.Data["stepResult"] == "skipped" || entry.Data["stepResult"] == model.StepStatusSkipped {
		o.skipped++
	}
	ids, ok := entry.Data["stepID"].([]string)
	if !ok {
		ids, ok = entry.Data["stepid"].([]string)
	}
	if entry.Data["stepResult"] == model.StepStatusFailure && ok && len(o.failed) < 32 {
		job, _ := entry.Data["jobID"].(string)
		o.failed = append(o.failed, job+"/"+strings.Join(ids, "/"))
	}
	if ok && len(ids) == 1 && ids[0] == "--setup-job" {
		if entry.Data["stepResult"] != model.StepStatusSuccess {
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		raw, err := docker(ctx, "ps", "-q")
		if err != nil || len(strings.Fields(string(raw))) == 0 {
			o.fail("setup container observation")
			return nil
		}
		for _, id := range strings.Fields(string(raw)) {
			if o.prepared[id] {
				continue
			}
			inspect, err := docker(ctx, "inspect", id)
			if err != nil {
				continue
			}
			if verifyContainer(inspect, o.image) != nil {
				o.fail("setup container isolation receipt")
				return nil
			}
			count, initErr := initializeOwnedVolumes(inspect)
			if initErr != nil {
				o.fail("trusted volume initialization")
				return nil
			}
			o.initialized += count
			if _, err = docker(ctx, "cp", runtimeWorkspace+"/actions", id+":"+runtimeWorkspace+"/actions"); err != nil {
				o.fail("owned source transfer")
				return nil
			}
			copied, copyErr := docker(ctx, "exec", "--user=1000:1000", id, "cat", runtimeWorkspace+"/actions/owned-composite/action.yml")
			if copyErr != nil || !bytes.Equal(copied, []byte(compositeFixture)) {
				o.fail("owned source identity receipt")
				return nil
			}
			o.prepared[id] = true
			o.containers[id] = true
		}
		return nil
	}
	if !ok || len(ids) != 1 || (ids[0] != "proof" && ids[0] != "started") {
		return nil
	}
	if entry.Data["stepResult"] != model.StepStatusSuccess {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := docker(ctx, "ps", "-q")
	if err != nil {
		o.fail("container observation")
		return nil
	}
	matched := false
	expected, _ := entry.Data["jobID"].(string)
	if expected == "hang" {
		expected = "hang-started"
	}
	if expected == "matrix" {
		matrix, ok := entry.Data["matrix"].(map[string]interface{})
		cell, cellOK := matrix["cell"].(string)
		if !ok || !cellOK || (cell != "a" && cell != "b") {
			o.fail("matrix observation identity")
			return nil
		}
		expected = "matrix-" + cell
	}
	for _, id := range strings.Fields(string(raw)) {
		if !regexp.MustCompile(`^[0-9a-f]{12,64}$`).MatchString(id) {
			o.fail("container identity")
			return nil
		}
		inspect, err := docker(ctx, "inspect", id)
		if err != nil {
			continue
		} // Another completed job may have been removed.
		if verifyContainer(inspect, o.image) != nil {
			o.fail("container isolation receipt")
			return nil
		}
		o.containers[id] = true
		body, err := docker(ctx, "exec", "--user=1000:1000", id, "cat", runtimeWorkspace+"/.proof")
		if err != nil {
			continue
		}
		effect := strings.TrimSpace(string(body))
		if effect != "build" && effect != "lint" && effect != "matrix-a" && effect != "matrix-b" && effect != "package" && effect != "hang-started" {
			o.fail("unexpected independent effect")
			return nil
		}
		o.effects[effect] = true
		if effect == expected {
			matched = true
		}
	}
	if !matched {
		o.fail("finished source step lacks independent effect")
	}
	return nil
}
func (o *runtimeObserver) fail(message string) {
	if o.err == nil {
		o.err = errors.New(message)
		o.cancel()
	}
}

func verifyContainer(raw []byte, image string) error {
	var rows []struct {
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
		Mounts []struct{ Type, Destination string }
	}
	if json.Unmarshal(raw, &rows) != nil || len(rows) != 1 {
		return errors.New("invalid container observation")
	}
	r := rows[0]
	if r.Image != image || r.Config.User != "1000:1000" || r.HostConfig.NetworkMode != "none" || r.HostConfig.Privileged || len(r.HostConfig.Binds) != 0 || len(r.HostConfig.CapAdd) != 0 ||
		r.HostConfig.Memory != 268435456 || r.HostConfig.MemorySwap != 268435456 || r.HostConfig.NanoCpus != 1000000000 || r.HostConfig.PidsLimit == nil || *r.HostConfig.PidsLimit != 64 || len(r.HostConfig.Devices) != 0 ||
		!has(r.HostConfig.CapDrop, "ALL") || !has(r.HostConfig.SecurityOpt, "no-new-privileges") {
		return errors.New("unsafe container observation")
	}
	for _, mount := range r.Mounts {
		if mount.Type != "volume" || (mount.Destination != runtimeWorkspace && mount.Destination != "/var/run/act" && mount.Destination != "/opt/hostedtoolcache") {
			return errors.New("unexpected mount")
		}
	}
	for _, env := range r.Config.Env {
		if strings.HasPrefix(env, "DOCKER_") || strings.HasPrefix(env, "GOLF_") {
			return errors.New("control environment exposed")
		}
	}
	return nil
}
func has(values []string, desired string) bool {
	for _, value := range values {
		if value == desired {
			return true
		}
	}
	return false
}

// Act ignores its root-exec chown failure after capdrop ALL. Prepare only
// freshly owned volume directories from the trusted daemon process, before
// source steps; never grant CHOWN/privileged mode to an untrusted job.
func initializeOwnedVolumes(raw []byte) (int, error) {
	var rows []struct {
		Mounts []struct{ Type, Source string }
	}
	if json.Unmarshal(raw, &rows) != nil || len(rows) != 1 {
		return 0, errors.New("owned volume observation")
	}
	count := 0
	for _, mount := range rows[0].Mounts {
		if mount.Type != "volume" || !regexp.MustCompile(`^/var/lib/docker/volumes/[A-Za-z0-9_.-]{1,200}/_data$`).MatchString(mount.Source) {
			return 0, errors.New("owned volume path")
		}
		if err := filepath.WalkDir(mount.Source, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return errors.New("owned setup symlink")
			}
			return os.Chown(path, 1000, 1000)
		}); err != nil {
			return 0, errors.New("owned volume setup failed")
		}
		count++
	}
	return count, nil
}

type boundedOutput struct {
	bytes.Buffer
	exceeded bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1<<20 {
		b.exceeded = true
		return 0, errors.New("qualification command output bound")
	}
	return b.Buffer.Write(p)
}
func docker(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var out boundedOutput
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	err := cmd.Run()
	if out.exceeded {
		return nil, errors.New("qualification command output bound")
	}
	return out.Bytes(), err
}
