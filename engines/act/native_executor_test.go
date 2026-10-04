package actionsengine

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/exprparser"
	"github.com/nektos/act/pkg/model"
	act "github.com/nektos/act/pkg/runner"
	"github.com/sirupsen/logrus"
)

func TestTypedNativePlanContextsAndLiteralData(t *testing.T) {
	input := typedExecution(t)
	plan, native, files, err := admit(input.Input)
	if err != nil || !validatedManualInputs(input, files) {
		t.Fatal("typed native fixture not admitted", err)
	}
	var frames []protocol.ActionFrame
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	observer := &engineObserver{ctx: ctx, cancel: cancel, send: func(f protocol.ActionFrame) error { frames = append(frames, f); return nil },
		plan: plan, started: map[string]bool{}, finished: map[string]bool{}, nativeResults: map[string]string{}}
	ctx = act.WithJobLoggerFactory(ctx, observer)
	config := &act.Config{EventName: "workflow_dispatch", Workdir: t.TempDir(), Env: map[string]string{}, Platforms: map[string]string{"linux": "unused"}}
	// Substituted executor boundary qualifies native context composition only;
	// no successful Docker/native job execution is inferred from this callback.
	called := 0
	execute := func(ctx context.Context, rc *act.RunContext) error {
		called++
		for expression, expected := range map[string]string{
			"toJSON(inputs.enabled)": "false", "toJSON(github.event.inputs.enabled)": `"false"`,
			"toJSON(inputs.count)": "0", "toJSON(github.event.inputs.count)": `"0"`,
			"inputs.message": input.ManualInputs.Submitted[0].String, "inputs.choice": "one",
		} {
			if observed := rc.ExprEval.Interpolate(ctx, "${{ "+expression+" }}"); observed != expected {
				t.Errorf("native evaluator %s = %q, want %q", expression, observed, expected)
			}
		}
		for expression, expected := range map[string]bool{"inputs.enabled": false, "github.event.inputs.enabled": true, "inputs.count": false, "github.event.inputs.count": true} {
			if observed, err := act.EvalBool(ctx, rc.ExprEval, expression, exprparser.DefaultStatusCheckNone); err != nil || observed != expected {
				t.Errorf("native condition %s = %v/%v, want %v", expression, observed, err, expected)
			}
		}
		instance, ok := observer.identify(common.Logger(ctx).(*logrus.Entry))
		if !ok {
			t.Fatal("actual native instance identity missing")
		}
		observer.mu.Lock()
		observer.started[instance.InstanceID] = true // substituted executor boundary only
		observer.nativeResults[instance.InstanceID] = "success"
		observer.mu.Unlock()
		return nil
	}
	original := append([]byte{}, input.EventJSON...)
	if err := executeNativePlan(ctx, native, config, string(input.EventJSON), observer, execute); err != nil || called != 1 {
		t.Fatal("native typed evaluator composition failed", err, called)
	}
	if !reflect.DeepEqual(original, input.EventJSON) {
		t.Fatal("native context changed original event strings")
	}
}

func TestTypedNativeFalseJobConditionSkipsBeforeDocker(t *testing.T) {
	source := strings.Replace(typedWorkflow, "if: inputs.enabled || inputs.count == 0", "if: inputs.enabled", 1)
	plan, native, _, err := admit(typedInput(t, source, nil))
	if err != nil {
		t.Fatal(err)
	}
	input := typedExecution(t)
	var frames []protocol.ActionFrame
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	observer := &engineObserver{ctx: ctx, cancel: cancel, send: func(f protocol.ActionFrame) error { frames = append(frames, f); return nil },
		plan: plan, started: map[string]bool{}, finished: map[string]bool{}, nativeResults: map[string]string{}}
	ctx = act.WithJobLoggerFactory(ctx, observer)
	// A future regression cannot reach any ordinary local Docker daemon.
	t.Setenv("DOCKER_HOST", "unix:///nonexistent-golf-typed-input-source-test.sock")
	config := &act.Config{EventName: "workflow_dispatch", Workdir: t.TempDir(), Env: map[string]string{}, Platforms: map[string]string{"linux": "unused"}}
	if err := executeNativePlan(ctx, native, config, string(input.EventJSON), observer, nativeInstanceExecutor); err != nil {
		t.Fatal("actual native false-condition skip failed", err)
	}
	if len(frames) != 1 || frames[0].Kind != "job_finished" || frames[0].State != "skipped" || len(observer.started) != 0 {
		t.Fatalf("false boolean did not remain a pre-execution skip: %#v", frames)
	}
}

// The executor callback is a substituted execution boundary: these assertions
// qualify composition/status attribution, not Docker or a native shell run.
func TestPublicExecutorOwnMatrixCompletionAndNativeConditionIsolation(t *testing.T) {
	source := `on: workflow_dispatch
jobs:
  produce:
    runs-on: linux
    outputs: {value: '${{ steps.emit.outputs.value }}'}
    steps: [{id: emit, run: 'true'}]
  cells:
    needs: produce
    runs-on: linux
    strategy: {fail-fast: false, matrix: {cell: [a,b]}}
    steps: [{id: check, run: 'true'}]
  after:
    needs: cells
    runs-on: linux
    if: '${{ always() }}'
    steps: [{id: end, run: 'true'}]
  skipped:
    needs: cells
    runs-on: linux
    steps: [{run: 'true'}]
`
	admitted, native, _, err := admit(testInput(t, source, nil))
	if err != nil {
		t.Fatal(err)
	}
	var frames []protocol.ActionFrame
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	observer := &engineObserver{ctx: ctx, cancel: cancel, send: func(f protocol.ActionFrame) error { frames = append(frames, f); return nil }, plan: admitted, started: map[string]bool{}, finished: map[string]bool{}, nativeResults: map[string]string{}}
	ctx = act.WithJobLoggerFactory(ctx, observer)
	config := &act.Config{Workdir: t.TempDir(), Platforms: map[string]string{"linux": "unused"}}
	var cells []string
	execute := func(ctx context.Context, rc *act.RunContext) error {
		if rc.Run.JobID == "skipped" {
			return nativeInstanceExecutor(ctx, rc)
		} // actual native skip/evaluator boundary, no Docker
		rc.CurrentStep = "check"
		if rc.Run.JobID != "after" {
			freshSuccess, e := act.EvalBool(ctx, rc.ExprEval, "success()", exprparser.DefaultStatusCheckNone)
			if e != nil || !freshSuccess || common.JobError(ctx) != nil || rc.Run.Job().Result != "" {
				t.Error("previous cell status leaked")
			}
			freshFailure, e := act.EvalBool(ctx, rc.ExprEval, "failure()", exprparser.DefaultStatusCheckNone)
			if e != nil || freshFailure {
				t.Error("new cell starts failed")
			}
		}
		if rc.Run.JobID == "cells" && rc.ExprEval.Interpolate(ctx, "${{ needs.produce.outputs.value }}") != "owned" {
			t.Error("native needs output missing")
		}
		if rc.Run.JobID == "after" && rc.ExprEval.Interpolate(ctx, "${{ needs.cells.result }}") != "failure" {
			t.Error("needs lacks actual completed aggregate")
		}
		job, ok := observer.identify(common.Logger(ctx).(*logrus.Entry))
		if !ok {
			t.Fatal("bound public job context missing")
		}
		observer.mu.Lock()
		observer.started[job.InstanceID] = true
		if e := observer.emit(protocol.ActionFrame{Kind: "job_started", InstanceID: job.InstanceID}); e != nil {
			t.Fatal(e)
		}
		observer.mu.Unlock()
		state := "success"
		if rc.Run.JobID == "produce" {
			rc.Run.Job().Outputs = map[string]string{"value": "owned"}
		}
		if rc.Run.JobID == "cells" {
			cell := rc.Matrix["cell"].(string)
			cells = append(cells, cell)
			if cell == "a" {
				state = "failure"
				rc.StepResults["check"] = &model.StepResult{Conclusion: model.StepStatusFailure, Outcome: model.StepStatusFailure}
				common.SetJobError(ctx, errors.New("exact own executor failure"))
				// Step-level success()/failure() use the native private step
				// evaluator inside Executor. Actual Docker fixture qualifies those;
				// this source seam proves isolated errors/results, not fake steps.
			}
		}
		observer.mu.Lock()
		for _, step := range job.Steps {
			if e := observer.emit(protocol.ActionFrame{Kind: "step_started", InstanceID: job.InstanceID, StepID: step.ID}); e != nil {
				t.Fatal(e)
			}
			if e := observer.emit(protocol.ActionFrame{Kind: "step_finished", InstanceID: job.InstanceID, StepID: step.ID, State: state}); e != nil {
				t.Fatal(e)
			}
		}
		observer.mu.Unlock()
		// Deliberately reproduce an inherited aggregate failure for successful b.
		header := state
		if rc.Run.JobID == "cells" && rc.Matrix["cell"] == "b" {
			header = "failure"
		}
		common.Logger(ctx).WithField("jobResult", header).Info("native aggregate")
		return nil
	}
	if executeNativePlan(ctx, native, config, "{}", observer, execute) == nil {
		t.Fatal("own failed cell became green overall")
	}
	if strings.Join(cells, ",") != "a,b" {
		t.Fatal("native canonical variants not executed independently")
	}
	states := map[string]string{}
	for _, f := range frames {
		if f.Kind == "job_finished" {
			states[f.InstanceID] = f.State
		}
	}
	for _, j := range admitted.Jobs {
		expected := "success"
		if j.JobID == "skipped" {
			expected = "skipped"
		}
		if j.JobID == "cells" && j.Matrix[0].Value == `"a"` {
			expected = "failure"
		}
		if states[j.InstanceID] != expected {
			t.Fatalf("wrong %s instance conclusion: %s", j.JobID, states[j.InstanceID])
		}
	}
	if len(states) != len(admitted.Jobs) {
		t.Fatal("completion inventory incomplete")
	}
}

func TestNativeMissingReceiptsRemainUnconfirmedWithClosedClassification(t *testing.T) {
	for _, tc := range []struct {
		name, stage, native string
		started, finished   bool
	}{
		{"missing_result", "engine_native_result_missing", "", true, false},
		{"missing_setup", "engine_native_setup_missing", "success", false, false},
		{"duplicate_result", "engine_native_result_conflict", "success", true, true},
		{"skip_after_start", "engine_native_result_conflict", "skipped", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := testObserver(t, func(protocol.ActionFrame) error { t.Fatal("incomplete native receipts emitted completion"); return nil })
			job := o.plan.Jobs[0]
			o.nativeResults = map[string]string{job.InstanceID: tc.native}
			o.started[job.InstanceID] = tc.started
			o.finished[job.InstanceID] = tc.finished
			state, err := o.completeInstance(job, nil, nil)
			if state != "" || !errors.Is(err, ErrExecution) || ExecutionFailureStage(err) != tc.stage {
				t.Fatal("incomplete receipt gained authority", ExecutionFailureStage(err))
			}
		})
	}
}

func TestNativeExecutorInitAndParallelFailurePreserveSafeBoundary(t *testing.T) {
	rc := &act.RunContext{Run: &model.Run{JobID: "check", Workflow: &model.Workflow{Jobs: map[string]*model.Job{"check": {Uses: "private-invalid-native-path"}}}}}
	err := nativeInstanceExecutor(t.Context(), rc)
	if ExecutionFailureStage(err) != "engine_native_executor_init" || !errors.Is(err, ErrExecution) || strings.Contains(err.Error(), "private") {
		t.Fatal("native initialization refusal lost safety/boundary")
	}
	admitted, native, _, err := admit(testInput(t, "on: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps: [{run: 'true'}]\n", nil))
	if err != nil {
		t.Fatal(err)
	}
	o := testObserver(t, func(protocol.ActionFrame) error { t.Fatal("failed init emitted receipt"); return nil })
	o.plan = admitted
	o.started = map[string]bool{}
	o.nativeResults = map[string]string{}
	ctx := act.WithJobLoggerFactory(o.ctx, o)
	err = executeNativePlan(ctx, native, &act.Config{Workdir: t.TempDir()}, "{}", o, func(context.Context, *act.RunContext) error {
		return classifyExecution("engine_native_executor_init", errors.New("private native failure"))
	})
	if ExecutionFailureStage(err) != "engine_native_executor_init" || strings.Contains(err.Error(), "private") || !errors.Is(err, ErrExecution) {
		t.Fatal("parallel wrapper flattened closed native boundary", ExecutionFailureStage(err))
	}
}
