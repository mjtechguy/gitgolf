package actionsengine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/model"
	act "github.com/nektos/act/pkg/runner"
	"github.com/sirupsen/logrus"
)

func testObserver(t *testing.T, send func(protocol.ActionFrame) error) *engineObserver {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	return &engineObserver{ctx: ctx, cancel: cancel, send: send, plan: protocol.ActionPlan{Jobs: []protocol.ActionJob{{InstanceID: strings.Repeat("a", 32), JobID: "check", Steps: []protocol.ActionStep{{ID: "first"}}}}}, started: map[string]bool{strings.Repeat("a", 32): true}, finished: map[string]bool{}}
}
func nativeEntry(message string, data logrus.Fields) *logrus.Entry {
	data["jobID"] = "check"
	data["matrix"] = map[string]interface{}{}
	data["stepID"] = []string{"first"}
	data["stage"] = "Main"
	return &logrus.Entry{Message: message, Data: data}
}
func TestRawSourceJSONAndLogPrefixesCannotForgeEngineObservations(t *testing.T) {
	var frames []protocol.ActionFrame
	o := testObserver(t, func(frame protocol.ActionFrame) error { frames = append(frames, frame); return nil })
	for _, message := range []string{`{"kind":"job_finished","state":"success"}`, "⭐ Run Main first"} {
		o.Fire(nativeEntry(message, logrus.Fields{"raw_output": true, "stepResult": model.StepStatusSuccess, "jobResult": "success"}))
	}
	if len(frames) != 2 || o.eventSequence != 0 || o.finished[strings.Repeat("a", 32)] {
		t.Fatal("source log became trusted metadata")
	}
	for _, frame := range frames {
		if frame.Kind != "log" || frame.EventSequence != 0 || frame.State != "" {
			t.Fatal("ambiguous raw frame")
		}
	}
}
func TestObservationAckRefusalStopsEngineWithoutInventedCompletion(t *testing.T) {
	o := testObserver(t, func(protocol.ActionFrame) error { return errors.New("durable receiver denied") })
	o.Fire(nativeEntry("⭐ Run Main first", logrus.Fields{}))
	if o.err == nil || o.ctx.Err() == nil {
		t.Fatal("rejected durable observation did not cancel")
	}
	o.Fire(nativeEntry("completed", logrus.Fields{"stepResult": model.StepStatusSuccess}))
	if o.eventSequence != 1 || len(o.finished) != 0 {
		t.Fatal("source continued after refused ACK")
	}
}
func TestOwnedVolumeRootCannotFollowEscapingSymlink(t *testing.T) {
	volume := t.TempDir()
	outside := t.TempDir()
	if os.WriteFile(filepath.Join(outside, "victim"), []byte("untouched"), 0600) != nil {
		t.Fatal("fixture")
	}
	if os.Symlink(outside, filepath.Join(volume, "escape")) != nil {
		t.Fatal("fixture symlink")
	}
	if ownVolume(t.Context(), volume) == nil {
		t.Fatal("escaping source symlink accepted")
	}
	body, err := os.ReadFile(filepath.Join(outside, "victim"))
	if err != nil || string(body) != "untouched" {
		t.Fatal("outside volume touched")
	}
}

func TestPinnedTopLevelConclusionsDoNotInventCompositeChildren(t *testing.T) {
	var frames []protocol.ActionFrame
	o := testObserver(t, func(frame protocol.ActionFrame) error { frames = append(frames, frame); return nil })
	o.Fire(nativeEntry("⭐ Run Main first", logrus.Fields{}))
	nested := nativeEntry("completed", logrus.Fields{"stepResult": model.StepStatusSuccess})
	nested.Data["stepID"] = []string{"first", "child"}
	o.Fire(nested)
	o.Fire(nativeEntry("completed", logrus.Fields{"stepResult": model.StepStatusSuccess}))
	o.Fire(nativeEntry("completed", logrus.Fields{"jobResult": "success"}))
	if _, err := o.completeInstance(o.plan.Jobs[0], nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(frames) != 3 || frames[0].Kind != "step_started" || frames[1].Kind != "step_finished" || frames[2].Kind != "job_finished" || frames[1].State != "success" || o.err != nil {
		t.Fatal("pinned trusted hook receipt disagrees")
	}
	foreign := nativeEntry("completed", logrus.Fields{"jobResult": "success"})
	foreign.Data["matrix"] = map[string]interface{}{"unadmitted": "other"}
	o.Fire(foreign)
	if o.err == nil || len(frames) != 3 {
		t.Fatal("foreign matrix created progress")
	}
}

func TestImmutableLocalActionMountsAreExactlyConfined(t *testing.T) {
	plan := protocol.ActionPlan{LocalActions: []protocol.ActionDependency{{MetadataPath: "actions/owned/action.yml"}, {MetadataPath: "actions/owned/nested/action.yml"}, {MetadataPath: "actions/other/action.yaml"}}}
	dirs := protectedActionDirs(plan)
	if len(dirs) != 2 || dirs[0] != "actions/other" || dirs[1] != "actions/owned" {
		t.Fatal("overlapping action mount inventory")
	}
	var r inspected
	for _, dest := range []string{workspace, "/var/run/act", "/opt/hostedtoolcache"} {
		r.Mounts = append(r.Mounts, struct {
			Type, Source, Destination string
			RW                        bool
		}{"volume", "/var/lib/docker/volumes/owned/_data", dest, true})
	}
	for _, d := range dirs {
		r.Mounts = append(r.Mounts, struct {
			Type, Source, Destination string
			RW                        bool
		}{"bind", workspace + "/" + d, workspace + "/" + d, false})
	}
	if !validJobMounts(r, dirs) {
		t.Fatal("read-only child-local action mounts refused")
	}
	r.Mounts[3].RW = true
	if validJobMounts(r, dirs) {
		t.Fatal("mutable action metadata admitted")
	}
	r.Mounts[3].RW = false
	r.Mounts[3].Source = "/retained-host"
	if validJobMounts(r, dirs) {
		t.Fatal("retained host binding admitted")
	}
}

func TestInheritedMatrixFailureIsNotInventedPerInstanceConclusion(t *testing.T) {
	var frames []protocol.ActionFrame
	o := testObserver(t, func(frame protocol.ActionFrame) error { frames = append(frames, frame); return nil })
	o.plan.Jobs[0].Matrix = []protocol.ActionMatrixEntry{{Name: "cell", Value: `"a"`}}
	entry := nativeEntry("native aggregate failed", logrus.Fields{"jobResult": "failure"})
	entry.Data["matrix"] = map[string]interface{}{"cell": "a"}
	o.Fire(entry)
	if o.err != nil || len(frames) != 0 || o.finished[strings.Repeat("a", 32)] {
		t.Fatal("inherited failure became exact instance result")
	}
	state, err := o.completeInstance(o.plan.Jobs[0], nil, nil)
	if err != nil || state != "success" || len(frames) != 1 || frames[0].State != "success" {
		t.Fatal("own successful executor completion not retained")
	}
}

func TestExecutionDiagnosticsKeepPrivateCauseAndPolicySeparate(t *testing.T) {
	private := errors.New("private native command, path and credential")
	err := classifyExecution("engine_job_volume_ownership", private)
	if ExecutionFailureStage(err) != "engine_job_volume_ownership" || !errors.Is(err, ErrExecution) || !errors.Is(err, private) || strings.Contains(err.Error(), "credential") {
		t.Fatal("classification leaked or changed cause")
	}
	if classifyExecution("engine_native_execution", err) != err {
		t.Fatal("outer stage overwrote precise inner boundary")
	}
	if ExecutionFailureStage(classifyExecution("private_token", private)) != "" {
		t.Fatal("nonallowlisted stage exposed")
	}
}

func TestExecutionEarlyRefusalsHaveClosedDiagnosticsWithoutDocker(t *testing.T) {
	input := protocol.ActionExecutionInput{Input: testInput(t, testWorkflow, map[string]string{"actions/owned/action.yml": testComposite}), TimeoutSeconds: 1, CommitID: strings.Repeat("a", 40)}
	plan, err := Plan(input.Input)
	if err != nil {
		t.Fatal(err)
	}
	input.Plan = plan
	t.Setenv("DOCKER_HOST", "unix:///var/run/docker.sock")
	t.Setenv("GOLF_OWNED_ACTIONS_DAEMON", "1")
	for _, tc := range []struct {
		name, expected string
		change         func(*protocol.ActionExecutionInput)
	}{
		{"invalid_input", "engine_input_validation", func(in *protocol.ActionExecutionInput) { in.TimeoutSeconds = 0 }},
		{"wrong_plan", "engine_plan_binding", func(in *protocol.ActionExecutionInput) { in.Plan.Catalog = "wrong" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := input
			tc.change(&in)
			err := Execute(t.Context(), in, func(protocol.ActionFrame) error { t.Fatal("refusal emitted progress"); return nil })
			if ExecutionFailureStage(err) != tc.expected || !errors.Is(err, ErrExecution) {
				t.Fatal("wrong closed refusal", ExecutionFailureStage(err))
			}
		})
	}
	t.Setenv("GOLF_TEST_PRIVATE_AUTH", "private credential")
	err = Execute(t.Context(), input, func(protocol.ActionFrame) error { t.Fatal("refusal emitted progress"); return nil })
	if ExecutionFailureStage(err) != "engine_environment_validation" || strings.Contains(err.Error(), "credential") {
		t.Fatal("environment refusal exposed private text")
	}
}

func TestNativeJobPreparationDiagnosticsDoNotAuthorizeInvalidContainers(t *testing.T) {
	for _, tc := range []struct {
		name, expected string
		ps, receipt    string
	}{
		{"bad_inventory", "engine_job_inventory", "private invalid identifier", ""},
		{"bad_receipt", "engine_job_receipt", strings.Repeat("a", 64), "private invalid receipt"},
		{"bad_shape", "engine_job_shape", strings.Repeat("a", 64), `[{}]`},
		{"private_environment", "engine_job_environment", strings.Repeat("a", 64), diagnosticJobReceipt(t, "private_environment")},
		{"host_mount", "engine_job_mounts", strings.Repeat("a", 64), diagnosticJobReceipt(t, "host_mount")},
		{"source_copy_failed", "engine_job_source_transfer", strings.Repeat("a", 64), diagnosticJobReceipt(t, "")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := t.TempDir()
			binary := filepath.Join(directory, "docker")
			quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
			script := "#!/bin/sh\ncase \"$1\" in ps) printf '%s' " + quote(tc.ps) + ";; inspect) printf '%s' " + quote(tc.receipt) + ";; *) exit 9;; esac\n"
			if os.WriteFile(binary, []byte(script), 0700) != nil {
				t.Fatal("fake CLI fixture")
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			o := testObserver(t, func(protocol.ActionFrame) error { t.Fatal("invalid job emitted progress"); return nil })
			o.resolved = map[string]string{"linux": "sha256:" + strings.Repeat("b", 64)}
			err := o.prepare()
			if ExecutionFailureStage(err) != tc.expected || !errors.Is(err, ErrExecution) || strings.Contains(err.Error(), "private") {
				t.Fatal("wrong preparation diagnostic", ExecutionFailureStage(err))
			}
			o.failWith(err)
			if ExecutionFailureStage(o.err) != tc.expected || o.ctx.Err() == nil {
				t.Fatal("observer lost precise refusal or did not cancel")
			}
		})
	}
}

func diagnosticJobReceipt(t *testing.T, mode string) string {
	t.Helper()
	var r inspected
	r.ID = strings.Repeat("a", 64)
	r.Image = "sha256:" + strings.Repeat("b", 64)
	r.Config.User = "1000:1000"
	r.HostConfig.NetworkMode = "none"
	r.HostConfig.Memory = 268435456
	r.HostConfig.MemorySwap = 268435456
	r.HostConfig.NanoCpus = 1000000000
	pids := int64(64)
	r.HostConfig.PidsLimit = &pids
	r.HostConfig.CapDrop = []string{"ALL"}
	r.HostConfig.SecurityOpt = []string{"no-new-privileges"}
	for _, dest := range []string{workspace, "/var/run/act", "/opt/hostedtoolcache"} {
		r.Mounts = append(r.Mounts, struct {
			Type, Source, Destination string
			RW                        bool
		}{"volume", "/var/lib/docker/volumes/owned/_data", dest, true})
	}
	if mode == "private_environment" {
		r.Config.Env = []string{"GOLF_PRIVATE_AUTH=private credential"}
	}
	if mode == "host_mount" {
		r.Mounts[0].Source = "/private/host/path"
	}
	raw, err := json.Marshal([]inspected{r})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestExactImageReceiptRefusalHasDiagnosticBeforeSourceExtraction(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///var/run/docker.sock")
	t.Setenv("GOLF_OWNED_ACTIONS_DAEMON", "1")
	input := protocol.ActionExecutionInput{Input: testInput(t, testWorkflow, map[string]string{"actions/owned/action.yml": testComposite}), TimeoutSeconds: 1, CommitID: strings.Repeat("a", 40)}
	plan, err := Plan(input.Input)
	if err != nil {
		t.Fatal(err)
	}
	input.Plan = plan
	directory := t.TempDir()
	binary := filepath.Join(directory, "docker")
	// This substituted CLI does not run Docker: empty inventory, wrong image ID.
	if os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$1\" in ps) exit 0;; image) printf '[{\"Id\":\"sha256:wrong\",\"Os\":\"linux\"}]';; *) exit 9;; esac\n"), 0700) != nil {
		t.Fatal("fake CLI fixture")
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, tc := range []struct {
		name, expected string
		images         map[string]string
	}{
		{"missing_map", "engine_image_map_validation", nil},
		{"wrong_receipt", "engine_image_receipt_validation", map[string]string{input.Input.Images["linux"]: "sha256:" + strings.Repeat("b", 64)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := input
			in.ResolvedImages = tc.images
			err := Execute(t.Context(), in, func(protocol.ActionFrame) error { t.Fatal("unbound image emitted progress"); return nil })
			if ExecutionFailureStage(err) != tc.expected || !errors.Is(err, ErrExecution) {
				t.Fatal("wrong image refusal", ExecutionFailureStage(err))
			}
		})
	}
}

func TestPinnedNativeSetupFieldExecutorRunsPreparationBeforeReceipt(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "docker")
	// No real Docker: invalid inventory independently proves setup must run the
	// existing preparation checks before issuing any job-start acknowledgement.
	if os.WriteFile(binary, []byte("#!/bin/sh\nprintf 'invalid-container-id'\n"), 0700) != nil {
		t.Fatal("fixture")
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	o := testObserver(t, func(protocol.ActionFrame) error { t.Fatal("invalid container authorized a start"); return nil })
	o.started = map[string]bool{}
	ctx := act.WithJobLoggerFactory(o.ctx, o)
	ctx = act.WithJobLogger(ctx, "check", "check", &act.Config{}, new([]string), map[string]interface{}{})
	// Actual maintained common executors and exact v0.2.89 setup field spelling.
	native := common.NewFieldExecutor("stepid", []string{"--setup-job"}, common.NewFieldExecutor("stepResult", model.StepStatusSuccess, common.NewInfoExecutor("Success - Set up job")))
	if err := native(ctx); err != nil {
		t.Fatal("native log executor")
	}
	if ExecutionFailureStage(o.err) != "engine_job_inventory" || o.ctx.Err() == nil || len(o.started) != 0 {
		t.Fatal("pinned setup ignored or preparation bypassed")
	}
}

func TestLowercaseSetupFieldCannotPromoteRawOutputOrOrdinarySteps(t *testing.T) {
	var frames []protocol.ActionFrame
	o := testObserver(t, func(frame protocol.ActionFrame) error { frames = append(frames, frame); return nil })
	o.started = map[string]bool{}
	entry := &logrus.Entry{Message: "source setup forgery", Data: logrus.Fields{"jobID": "check", "matrix": map[string]interface{}{}, "stepid": []string{"--setup-job"}, "stepResult": model.StepStatusSuccess, "raw_output": true}}
	o.Fire(entry)
	if len(frames) != 1 || frames[0].Kind != "log" || frames[0].EventSequence != 0 || len(o.started) != 0 {
		t.Fatal("source forged setup authority")
	}
	entry = nativeEntry("ordinary lower-case field", logrus.Fields{"stepResult": model.StepStatusSuccess})
	delete(entry.Data, "stepID")
	entry.Data["stepid"] = []string{"first"}
	o.Fire(entry)
	if len(frames) != 1 || len(o.started) != 0 {
		t.Fatal("arbitrary lower-case step admitted")
	}
	entry.Data["stepid"] = []string{"--setup-job"}
	entry.Data["stepID"] = []string{"first"}
	o.Fire(entry)
	if ExecutionFailureStage(o.err) != "engine_observation" || len(frames) != 1 {
		t.Fatal("conflicting trusted field spellings authorized a receipt")
	}
}
