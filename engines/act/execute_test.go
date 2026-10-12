package actionsengine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/workflowinputs"
	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/model"
	act "github.com/nektos/act/pkg/runner"
	"github.com/sirupsen/logrus"
)

func typedExecution(t *testing.T) protocol.ActionExecutionInput {
	t.Helper()
	in := typedInput(t, typedWorkflow, nil)
	plan, err := Plan(in)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := workflowinputs.Parse([]byte(typedWorkflow))
	if err != nil {
		t.Fatal(err)
	}
	values, err := workflowinputs.Validate(schema, []workflowinputs.Value{
		{Name: "message", Type: workflowinputs.String, String: "literal ${{ secrets.VALUE }}; 'quote' & <tag>"},
	})
	if err != nil {
		t.Fatal(err)
	}
	event := map[string]string{}
	for _, value := range values.Effective {
		switch value.Type {
		case workflowinputs.Boolean:
			event[value.Name] = strconv.FormatBool(value.Boolean)
		case workflowinputs.Number:
			event[value.Name] = value.Number
		default:
			event[value.Name] = value.String
		}
	}
	body, err := json.Marshal(map[string]any{"inputs": event, "after": in.Ref, "ref": in.Ref})
	if err != nil {
		t.Fatal(err)
	}
	return protocol.ActionExecutionInput{Input: in, Plan: plan, EventJSON: body, CommitID: in.Ref, TimeoutSeconds: 1,
		ManualInputs: &protocol.ActionManualInputs{Contract: protocol.ManualInputsCapability, SchemaSHA256: schema.SHA256,
			SubmittedSHA256: values.SubmittedSHA256, EffectiveSHA256: values.EffectiveSHA256, Submitted: values.Submitted, Effective: values.Effective}}
}

func TestTypedExecutionBindsCanonicalValuesAndEventWithoutEffects(t *testing.T) {
	input := typedExecution(t)
	_, _, files, err := admit(input.Input)
	if err != nil || !validatedManualInputs(input, files) {
		t.Fatal("complete typed execution contract refused", err)
	}
	// A binary marker proves invalid input cannot reach even Docker's first read.
	directory := t.TempDir()
	marker := filepath.Join(directory, "docker-called")
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte("#!/bin/sh\nprintf called > '"+marker+"'\nexit 91\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("DOCKER_HOST", "unix:///var/run/docker.sock")
	t.Setenv("GOLF_OWNED_ACTIONS_DAEMON", "1")
	for _, tc := range []struct {
		name   string
		change func(*protocol.ActionExecutionInput)
	}{
		{"missing_envelope", func(in *protocol.ActionExecutionInput) { in.ManualInputs = nil }},
		{"wrong_contract", func(in *protocol.ActionExecutionInput) { in.ManualInputs.Contract = "other" }},
		{"wrong_schema", func(in *protocol.ActionExecutionInput) { in.ManualInputs.SchemaSHA256 = strings.Repeat("d", 64) }},
		{"wrong_submitted_digest", func(in *protocol.ActionExecutionInput) { in.ManualInputs.SubmittedSHA256 = strings.Repeat("d", 64) }},
		{"wrong_effective_digest", func(in *protocol.ActionExecutionInput) { in.ManualInputs.EffectiveSHA256 = strings.Repeat("d", 64) }},
		{"changed_effective", func(in *protocol.ActionExecutionInput) { in.ManualInputs.Effective[0].String = "two" }},
		{"wrong_type", func(in *protocol.ActionExecutionInput) { in.ManualInputs.Submitted[0].Type = workflowinputs.Boolean }},
		{"unknown_name", func(in *protocol.ActionExecutionInput) { in.ManualInputs.Submitted[0].Name = "other" }},
		{"missing_event_value", func(in *protocol.ActionExecutionInput) { in.EventJSON = []byte(`{"inputs":{}}`) }},
		{"event_boolean_not_string", func(in *protocol.ActionExecutionInput) { in.EventJSON = []byte(`{"inputs":{"enabled":false}}`) }},
		{"duplicate_event_key", func(in *protocol.ActionExecutionInput) { in.EventJSON = []byte(`{"inputs":{},"inputs":{}}`) }},
		{"duplicate_input_key", func(in *protocol.ActionExecutionInput) {
			in.EventJSON = []byte(`{"inputs":{"message":"one","message":"two"}}`)
		}},
		{"event_null", func(in *protocol.ActionExecutionInput) { in.EventJSON = []byte(`{"inputs":null}`) }},
		{"event_extra_document", func(in *protocol.ActionExecutionInput) { in.EventJSON = append(in.EventJSON, []byte(` {}`)...) }},
		{"event_noncanonical_spacing", func(in *protocol.ActionExecutionInput) { in.EventJSON = append([]byte(" "), in.EventJSON...) }},
		{"event_wrong_after", func(in *protocol.ActionExecutionInput) {
			var event map[string]any
			if json.Unmarshal(in.EventJSON, &event) != nil {
				t.Fatal("fixture event decode failed")
			}
			event["after"] = strings.Repeat("d", 40)
			in.EventJSON, _ = json.Marshal(event)
		}},
		{"event_wrong_ref", func(in *protocol.ActionExecutionInput) {
			var event map[string]any
			if json.Unmarshal(in.EventJSON, &event) != nil {
				t.Fatal("fixture event decode failed")
			}
			event["ref"] = "refs/heads/main"
			in.EventJSON, _ = json.Marshal(event)
		}},
		{"event_oversized", func(in *protocol.ActionExecutionInput) { in.EventJSON = []byte(strings.Repeat(" ", 16<<10+1)) }},
		{"different_commit", func(in *protocol.ActionExecutionInput) { in.CommitID = strings.Repeat("d", 40) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(input)
			var changed protocol.ActionExecutionInput
			if json.Unmarshal(body, &changed) != nil {
				t.Fatal("fixture clone failed")
			}
			tc.change(&changed)
			if validatedManualInputs(changed, files) {
				t.Fatal("malformed contract accepted")
			}
			err := Execute(t.Context(), changed, func(protocol.ActionFrame) error { t.Fatal("invalid inputs emitted an observation"); return nil })
			if err == nil || ExecutionFailureStage(err) != "engine_input_validation" {
				t.Fatalf("invalid typed contract did not fail before execution: %v", err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("invalid inputs reached Docker")
			}
		})
	}
	// A canonicalized-but-unreviewed value is not the original submitted map.
	changed := input
	copy := *input.ManualInputs
	changed.ManualInputs = &copy
	copy.Submitted = []workflowinputs.Value{{Name: "count", Type: workflowinputs.Number, Number: "0.0"}, input.ManualInputs.Submitted[0]}
	copy.SubmittedSHA256 = workflowinputs.Digest("golf.workflow.dispatch.inputs.v1", copy.Submitted)
	if validatedManualInputs(changed, files) || !reflect.DeepEqual(input.ManualInputs.Submitted, []workflowinputs.Value{{Name: "message", Type: workflowinputs.String, String: "literal ${{ secrets.VALUE }}; 'quote' & <tag>"}}) {
		t.Fatal("uncanonical original map adopted or original changed")
	}
}

func TestTypedExecutionExplicitPresenceAndFiniteNumbers(t *testing.T) {
	input := typedExecution(t)
	_, _, files, err := admit(input.Input)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := workflowinputs.Parse(files[input.Input.WorkflowPath].body)
	if err != nil {
		t.Fatal(err)
	}
	absent, err := workflowinputs.Validate(schema, []workflowinputs.Value{})
	if err != nil {
		t.Fatal(err)
	}
	falsePresent, err := workflowinputs.Validate(schema, []workflowinputs.Value{{Name: "enabled", Type: workflowinputs.Boolean, Boolean: false}})
	if err != nil || falsePresent.SubmittedSHA256 == absent.SubmittedSHA256 || falsePresent.EffectiveSHA256 != absent.EffectiveSHA256 {
		t.Fatal("explicit false presence lost despite identical effective values", err)
	}
	for _, tc := range []struct {
		name, number string
		enabled      bool
	}{
		{"explicit_false_and_zero", "0", false},
		{"true_and_decimal", "0.125", true},
		{"negative", "-2.5", true},
		{"binary64_canonical_decimal", "0.1", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			values, err := workflowinputs.Validate(schema, []workflowinputs.Value{
				{Name: "enabled", Type: workflowinputs.Boolean, Boolean: tc.enabled},
				{Name: "count", Type: workflowinputs.Number, Number: tc.number},
				{Name: "message", Type: workflowinputs.String, String: "${{ inputs.count }} & 'literal'"},
				{Name: "choice", Type: workflowinputs.Choice, String: "two"},
			})
			if err != nil || values.SubmittedSHA256 == absent.SubmittedSHA256 {
				t.Fatal("explicit value presence not bound", err)
			}
			changed := input
			changed.ManualInputs = &protocol.ActionManualInputs{Contract: protocol.ManualInputsCapability, SchemaSHA256: schema.SHA256,
				SubmittedSHA256: values.SubmittedSHA256, EffectiveSHA256: values.EffectiveSHA256,
				Submitted: values.Submitted, Effective: values.Effective}
			changed.EventJSON, err = json.Marshal(map[string]any{"after": changed.CommitID, "ref": changed.CommitID, "inputs": map[string]string{
				"enabled": strconv.FormatBool(tc.enabled), "count": tc.number, "message": "${{ inputs.count }} & 'literal'", "choice": "two",
			}})
			if err != nil || !validatedManualInputs(changed, files) {
				t.Fatal("canonical typed values refused", err)
			}
			// Event maps stay strings, even when equivalent JSON numbers/bools
			// would otherwise appear to have the same displayed content.
			changed.EventJSON, _ = json.Marshal(map[string]any{"after": changed.CommitID, "ref": changed.CommitID, "inputs": map[string]any{
				"enabled": tc.enabled, "count": tc.number, "message": "${{ inputs.count }} & 'literal'", "choice": "two",
			}})
			if validatedManualInputs(changed, files) {
				t.Fatal("typed event boolean adopted in the string event map")
			}
		})
	}
	legacy := input
	legacy.Input.Catalog = protocol.ActionsCatalog
	if validatedManualInputs(legacy, files) {
		t.Fatal("v1 accepted a typed execution envelope")
	}
}

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

// Exercise the actual pinned writer -> raw logrus -> observer path: the writer
// retains each LF before calling the raw logger, whose hook precedes formatting.
func TestNativeRawLineWriterPreservesExistingLineEndings(t *testing.T) {
	var frames []protocol.ActionFrame
	o := testObserver(t, func(frame protocol.ActionFrame) error { frames = append(frames, frame); return nil })
	logger := o.WithJobLogger().WithFields(nativeEntry("", logrus.Fields{"raw_output": true}).Data)
	writer := common.NewLineWriter(func(s string) bool { logger.Infof("%s", s); return true })
	chunks := []string{"first\n", "\n", "intentional\n\n", "\x1b[3", "2mPASS\x1b[0m\rprogress 100%\n"}
	for _, chunk := range chunks {
		if n, err := writer.Write([]byte(chunk)); err != nil || n != len(chunk) {
			t.Fatal("native writer refused chunk", err)
		}
	}
	var joined strings.Builder
	for _, frame := range frames {
		if frame.Kind != "log" || frame.InstanceID != strings.Repeat("a", 32) || frame.StepID != "first" {
			t.Fatal("raw log scope changed")
		}
		joined.WriteString(frame.Text)
	}
	expected := strings.Join(chunks, "")
	if o.err != nil || joined.String() != expected || o.logBytes != len(expected) || len(frames) != 5 {
		t.Fatalf("native raw bytes changed: %q (bytes %d, frames %d)", joined.String(), o.logBytes, len(frames))
	}
}

func TestRawLogChunksPreservePartialANSIProgressAndNoLF(t *testing.T) {
	var frames []protocol.ActionFrame
	o := testObserver(t, func(frame protocol.ActionFrame) error { frames = append(frames, frame); return nil })
	chunks := []string{"single\n", "\n\n", "\x1b[3", "2mcolored\x1b[0m", "\rprogress 50%", "\r\x1b[2Kprogress 100%", "tail without LF", "", "valid ☃\x00invalid\xff"}
	for _, chunk := range chunks {
		o.Fire(nativeEntry(chunk, logrus.Fields{"raw_output": true}))
	}
	var joined strings.Builder
	for _, frame := range frames {
		joined.WriteString(frame.Text)
	}
	expected := strings.ReplaceAll(strings.ToValidUTF8(strings.Join(chunks, ""), "�"), "\x00", "�")
	if o.err != nil || joined.String() != expected || o.logBytes != len(expected) || len(frames) != len(chunks)-1 {
		t.Fatalf("raw chunk changed: %q (bytes %d, frames %d)", joined.String(), o.logBytes, len(frames))
	}
}

func TestRawLogBoundsChargeSanitizedBytesWithoutInventedLF(t *testing.T) {
	t.Run("exact total", func(t *testing.T) {
		count := 0
		o := testObserver(t, func(protocol.ActionFrame) error { count++; return nil })
		for i := 0; i < 8; i++ {
			o.Fire(nativeEntry(strings.Repeat("x", 32<<10), logrus.Fields{"raw_output": true}))
		}
		if o.err != nil || count != 8 || o.logBytes != 256<<10 {
			t.Fatal("exact byte budget refused")
		}
		o.Fire(nativeEntry("", logrus.Fields{"raw_output": true}))
		if o.err != nil || count != 8 {
			t.Fatal("empty input fabricated output")
		}
		o.Fire(nativeEntry("x", logrus.Fields{"raw_output": true}))
		if o.err == nil || count != 8 {
			t.Fatal("over-budget byte emitted")
		}
	})
	t.Run("sanitizer expansion", func(t *testing.T) {
		count := 0
		o := testObserver(t, func(protocol.ActionFrame) error { count++; return nil })
		o.Fire(nativeEntry(strings.Repeat("\x00", 32<<10), logrus.Fields{"raw_output": true}))
		if o.err == nil || count != 0 {
			t.Fatal("expanded wire chunk escaped byte bound")
		}
	})
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
	if ownVolumeProfile(t.Context(), volume, true) == nil {
		t.Fatal("remote profile followed escaping source symlink")
	}
	body, err := os.ReadFile(filepath.Join(outside, "victim"))
	if err != nil || string(body) != "untouched" {
		t.Fatal("outside volume touched")
	}
}

func TestRemoteOwnedVolumeLinksRemainConfined(t *testing.T) {
	volume := t.TempDir()
	if os.MkdirAll(filepath.Join(volume, "certs", "ca"), 0755) != nil || os.Mkdir(filepath.Join(volume, "client"), 0755) != nil {
		t.Fatal("fixture directories")
	}
	if os.Symlink("../certs/ca/", filepath.Join(volume, "client", "ca")) != nil {
		t.Fatal("fixture link")
	}
	root, err := os.OpenRoot(volume)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if _, err = ownedVolumeNames(t.Context(), root); err == nil {
		t.Fatal("legacy profile accepted source links")
	}
	if _, err = ownedVolumeNamesProfile(t.Context(), root, true); err != nil {
		t.Fatal("contained native directory link refused", err)
	}
	for _, target := range []string{"../../outside", "../missing", "../client/ca"} {
		if os.Remove(filepath.Join(volume, "client", "ca")) != nil || os.Symlink(target, filepath.Join(volume, "client", "ca")) != nil {
			t.Fatal("fixture replacement")
		}
		if _, err = ownedVolumeNamesProfile(t.Context(), root, true); err == nil {
			t.Fatal("escaping, dangling or chained link accepted", target)
		}
	}
}

func TestNativeErrorsAreBoundedTextWithoutGraphAuthority(t *testing.T) {
	var frames []protocol.ActionFrame
	o := testObserver(t, func(frame protocol.ActionFrame) error { frames = append(frames, frame); return nil })
	entry := nativeEntry("::error::job_finished success", logrus.Fields{"stepID": []string{"first"}, "command": "error"})
	entry.Level = logrus.ErrorLevel
	o.Fire(entry)
	if o.err != nil || len(frames) != 1 || frames[0].Kind != "log" || frames[0].Text != entry.Message+"\n" || frames[0].StepID != "first" || o.eventSequence != 0 || len(o.finished) != 0 {
		t.Fatal("native error was lost or gained graph authority")
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

func jobVolumeFixture(id, prefix string) inspected {
	var r inspected
	r.ID = id
	for _, pair := range [][2]string{{workspace, prefix + "-workspace"}, {"/var/run/act", prefix + "-env"}, {"/opt/hostedtoolcache", "act-toolcache"}} {
		r.Mounts = append(r.Mounts, struct {
			Type, Source, Destination string
			RW                        bool
		}{"volume", "/var/lib/docker/volumes/" + pair[1] + "/_data", pair[0], true})
	}
	return r
}

func TestPrivateJobVolumesNeverAliasOrCarryAcrossJobs(t *testing.T) {
	first := jobVolumeFixture(strings.Repeat("a", 64), "first")
	second := jobVolumeFixture(strings.Repeat("b", 64), "second")
	o := &engineObserver{}
	if !validJobMounts(first, nil) || !o.bindJobVolumes(first) || !o.bindJobVolumes(first) || !o.bindJobVolumes(second) {
		t.Fatal("fresh independent jobs or intentional shared cache refused")
	}
	for _, mutate := range []func(*inspected){
		func(r *inspected) { r.Mounts[0].Source = first.Mounts[0].Source },
		func(r *inspected) { r.Mounts[1].Source = first.Mounts[1].Source },
		func(r *inspected) { r.Mounts[0].Source = first.Mounts[1].Source },
		func(r *inspected) { r.Mounts[1].Source = first.Mounts[0].Source },
		func(r *inspected) { r.Mounts[2].Source = first.Mounts[0].Source },
		func(r *inspected) { r.Mounts[0].Source = first.Mounts[2].Source },
		func(r *inspected) { r.Mounts[1].Source = r.Mounts[0].Source },
		func(r *inspected) { r.Mounts[2].Source = r.Mounts[1].Source },
	} {
		third := jobVolumeFixture(strings.Repeat("c", 64), "third")
		mutate(&third)
		before := len(o.volumeOwners)
		if !validJobMounts(third, nil) || o.bindJobVolumes(third) || len(o.volumeOwners) != before {
			t.Fatal("private volume reuse/alias accepted or partial binding escaped")
		}
	}
	// There is deliberately no deletion/unbind on job cleanup: a later job must
	// not reuse the first workspace after the first container has been removed.
	later := jobVolumeFixture(strings.Repeat("d", 64), "later")
	later.Mounts[0].Source = first.Mounts[0].Source
	if o.bindJobVolumes(later) {
		t.Fatal("cleaned job's retained workspace accepted")
	}
}

func TestPrivateVolumeRefusalPrecedesSourceTransferAndSetupAck(t *testing.T) {
	for _, reuse := range []bool{false, true} {
		t.Run(strconv.FormatBool(reuse), func(t *testing.T) {
			row := jobVolumeFixture(strings.Repeat("b", 64), "second")
			row.Image = "sha256:" + strings.Repeat("1", 64)
			row.Config.User = "1000:1000"
			row.HostConfig.NetworkMode = "none"
			limits := protocol.DefaultJobLimits()
			row.HostConfig.Memory, row.HostConfig.MemorySwap = limits.Memory(), limits.Memory()
			row.HostConfig.NanoCpus = int64(limits.CPUMillis) * 1000000
			pids := int64(limits.Pids)
			row.HostConfig.PidsLimit = &pids
			row.HostConfig.CapDrop = []string{"ALL"}
			row.HostConfig.SecurityOpt = []string{"no-new-privileges"}
			observer := &engineObserver{ctx: t.Context(), resolved: map[string]string{"linux": row.Image}, prepared: map[string]bool{}}
			if reuse {
				observer.volumeOwners = map[string]string{row.Mounts[0].Source: strings.Repeat("a", 64)}
			} else {
				row.Mounts[1].Source = row.Mounts[0].Source
			}
			raw, err := json.Marshal([]inspected{row})
			if err != nil {
				t.Fatal(err)
			}
			directory := t.TempDir()
			marker := filepath.Join(directory, "unexpected-transfer")
			// The only executable named Docker is this controlled two-read fixture.
			// Any cp/exec/permission operation records a marker and fails closed.
			script := "#!/bin/sh\ncase \"$1\" in\nps) printf '%s\\n' '" + row.ID + "';;\ninspect) printf '%s\\n' '" + string(raw) + "';;\n*) printf called > '" + marker + "'; exit 91;;\nesac\n"
			if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", directory)
			if err := observer.prepare(); ExecutionFailureStage(err) != "engine_job_mounts" || len(observer.prepared) != 0 {
				t.Fatal("private alias crossed preparation boundary", err)
			}
			if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("invalid mount reached source transfer")
			}
		})
	}
}

func TestTwoJobNeedsNativePlannerAndDependencySkip(t *testing.T) {
	source, err := os.ReadFile("testdata/two-job-needs.yml")
	if err != nil {
		t.Fatal(err)
	}
	for _, failedFirst := range []bool{false, true} {
		t.Run(strconv.FormatBool(failedFirst), func(t *testing.T) {
			admitted, native, _, err := admit(testInput(t, string(source), nil))
			if err != nil || len(admitted.Jobs) != 2 || len(native.Stages) != 2 || admitted.Jobs[0].JobID != "first" || admitted.Jobs[1].JobID != "second" || !reflect.DeepEqual(admitted.Jobs[1].Needs, []string{"first"}) {
				t.Fatal("literal two-job graph not retained", err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var frames []protocol.ActionFrame
			observer := &engineObserver{ctx: ctx, cancel: cancel, send: func(f protocol.ActionFrame) error { frames = append(frames, f); return nil }, plan: admitted, started: map[string]bool{}, finished: map[string]bool{}, nativeResults: map[string]string{}}
			ctx = act.WithJobLoggerFactory(ctx, observer)
			config := &act.Config{EventName: "workflow_dispatch", Workdir: t.TempDir(), Env: map[string]string{}, Platforms: map[string]string{"linux": "unused"}}
			// No source execution or Docker success is inferred. The first executor
			// is substituted; the failure branch runs the real public native second
			// executor to prove its default dependency skip occurs before Docker.
			t.Setenv("DOCKER_HOST", "unix:///nonexistent-golf-two-job-source-test.sock")
			var calls []string
			execute := func(ctx context.Context, rc *act.RunContext) error {
				calls = append(calls, rc.Run.JobID)
				if rc.Run.JobID == "second" {
					if native.Stages[0].Runs[0].Job().Result == "" {
						t.Fatal("dependency started before first result")
					}
					if failedFirst {
						return nativeInstanceExecutor(ctx, rc)
					}
				}
				job, ok := observer.identify(common.Logger(ctx).(*logrus.Entry))
				if !ok {
					t.Fatal("actual native job context lost")
				}
				observer.started[job.InstanceID] = true
				state := "success"
				if rc.Run.JobID == "first" && failedFirst {
					state = "failure"
					common.SetJobError(ctx, errors.New("controlled first failure"))
				}
				common.Logger(ctx).WithField("jobResult", state).Info("controlled executor receipt")
				return nil
			}
			err = executeNativePlan(ctx, native, config, `{}`, observer, execute)
			if (err != nil) != failedFirst || !reflect.DeepEqual(calls, []string{"first", "second"}) || len(frames) != 2 || frames[0].InstanceID == frames[1].InstanceID {
				t.Fatal("two-job order/conclusion failed", err, frames)
			}
			wantFirst, wantSecond := "success", "success"
			if failedFirst {
				wantFirst, wantSecond = "failure", "skipped"
			}
			if frames[0].Kind != "job_finished" || frames[1].Kind != "job_finished" || frames[0].State != wantFirst || frames[1].State != wantSecond {
				t.Fatal("real dependency skip/conclusions lost", frames)
			}
		})
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
	r := jobVolumeFixture(strings.Repeat("a", 64), "owned")
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

func TestAdmittedJobLimitsAreInspectedBeforeSourceTransfer(t *testing.T) {
	limits := protocol.JobLimits{CPUMillis: 250, MemoryBytes: "67108864", Pids: 16, TimeoutSeconds: 30}
	for _, match := range []bool{false, true} {
		t.Run(map[bool]string{false: "wrong", true: "exact"}[match], func(t *testing.T) {
			var receipt []inspected
			if json.Unmarshal([]byte(diagnosticJobReceipt(t, "")), &receipt) != nil {
				t.Fatal("fixture")
			}
			if match {
				receipt[0].HostConfig.Memory = 67108864
				receipt[0].HostConfig.MemorySwap = 67108864
				receipt[0].HostConfig.NanoCpus = 250000000
				pids := int64(16)
				receipt[0].HostConfig.PidsLimit = &pids
			}
			raw, _ := json.Marshal(receipt)
			directory := t.TempDir()
			trace := filepath.Join(directory, "trace")
			binary := filepath.Join(directory, "docker")
			script := "#!/bin/sh\ncase \"$1\" in ps) printf '%s' '" + strings.Repeat("a", 64) + "';; inspect) printf '%s' '" + string(raw) + "';; cp) printf 'transfer' > '" + trace + "'; exit 9;; *) exit 9;; esac\n"
			if os.WriteFile(binary, []byte(script), 0700) != nil {
				t.Fatal("fixture")
			}
			t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
			o := testObserver(t, func(protocol.ActionFrame) error { t.Fatal("invalid job emitted progress"); return nil })
			o.limits = limits
			o.resolved = map[string]string{"linux": "sha256:" + strings.Repeat("b", 64)}
			err := o.prepare()
			_, sent := os.Stat(trace)
			want := "engine_job_shape"
			if match {
				want = "engine_job_source_transfer"
			}
			if ExecutionFailureStage(err) != want || (sent == nil) != match {
				t.Fatal("source released without exact effective resource receipt", ExecutionFailureStage(err))
			}
		})
	}
}
