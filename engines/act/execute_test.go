package actionsengine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/nektos/act/pkg/model"
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
