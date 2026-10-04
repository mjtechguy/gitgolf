package runner

import (
	"testing"

	"github.com/nektos/act/pkg/model"
	"gopkg.in/yaml.v3"
)

// Private native step types require this same-package source regression. No
// executor, Docker boundary, public test hook, or production admission is used.
func TestGolfDispatchStepAndCompositeInputs(t *testing.T) {
	var workflow model.Workflow
	if err := yaml.Unmarshal([]byte(`on:
  workflow_dispatch:
    inputs:
      amount: {type: number, default: 2}
      enabled: {type: boolean, default: false}
jobs:
  check:
    runs-on: linux
    steps: [{uses: ./action}]
`), &workflow); err != nil {
		t.Fatal(err)
	}
	const event = `{"inputs":{"amount":"10","enabled":"false"}}`
	rc := &RunContext{Config: &Config{EventName: "workflow_dispatch", Workdir: t.TempDir(), Env: map[string]string{}},
		Run: &model.Run{JobID: "check", Workflow: &workflow}, EventJSON: event,
		Env: map[string]string{}, StepResults: map[string]*model.StepResult{}}
	action := &model.Action{Inputs: map[string]model.Input{
		"amount": {Default: "${{ inputs.amount }}"}, "enabled": {Default: "${{ inputs.enabled }}"},
		"literal": {Default: "42"},
	}}
	step := &stepActionLocal{RunContext: rc, Step: &model.Step{Uses: "./action", With: map[string]string{"literal": "unused"}},
		env: map[string]string{"INPUT_LITERAL": "20"}, action: action}
	for name, eval := range map[string]ExpressionEvaluator{
		"step":                 rc.NewStepExpressionEvaluator(t.Context(), step),
		"step_with_run_inputs": rc.NewStepExpressionEvaluatorExt(t.Context(), step, true),
	} {
		t.Run(name, func(t *testing.T) {
			if got := eval.Interpolate(t.Context(), "${{ toJSON(inputs.amount) }}"); got != "10" {
				t.Fatalf("numeric step input = %q", got)
			}
			if got := eval.Interpolate(t.Context(), "${{ toJSON(inputs.enabled) }}"); got != "false" {
				t.Fatalf("boolean step input = %q", got)
			}
			if got := eval.Interpolate(t.Context(), "${{ toJSON(github.event.inputs.amount) }}"); got != `"10"` {
				t.Fatalf("event input changed type = %q", got)
			}
		})
	}
	composite := newCompositeRunContext(t.Context(), rc, step, "action")
	if composite.Env["INPUT_AMOUNT"] != "10" || composite.Env["INPUT_ENABLED"] != "false" || composite.Env["INPUT_LITERAL"] != "20" {
		t.Fatalf("composite INPUT_ string propagation = %#v", composite.Env)
	}
	childStep := &stepActionLocal{RunContext: composite, Step: &model.Step{}, env: composite.Env}
	for name, eval := range map[string]ExpressionEvaluator{
		"composite_job":        composite.ExprEval,
		"composite_step":       composite.NewStepExpressionEvaluator(t.Context(), childStep),
		"composite_run_inputs": composite.NewStepExpressionEvaluatorExt(t.Context(), childStep, true),
	} {
		t.Run(name, func(t *testing.T) {
			for expression, want := range map[string]string{
				"toJSON(inputs.amount)": `"10"`, "toJSON(inputs.enabled)": `"false"`,
				"toJSON(inputs.literal)": `"20"`, "toJSON(github.event.inputs.amount)": `"10"`,
			} {
				if got := eval.Interpolate(t.Context(), "${{ "+expression+" }}"); got != want {
					t.Errorf("%s = %q, want %q", expression, got, want)
				}
			}
		})
	}
	if composite.EventJSON != event || rc.EventJSON != event {
		t.Fatal("composite changed event strings")
	}
}

func TestGolfDispatchInvalidNumberNeverInventsNumericValue(t *testing.T) {
	// Golf admission must reject these before execution; this patch additionally
	// never turns an invalid/nonfinite event string into zero, NaN, or infinity.
	var workflow model.Workflow
	if err := yaml.Unmarshal([]byte(`on:
  workflow_dispatch:
    inputs:
      amount: {type: number}
jobs:
  check:
    runs-on: linux
    steps: [{run: 'true'}]
`), &workflow); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"NaN", "+Inf", "-Inf", "1e999", "invalid", ""} {
		t.Run(value, func(t *testing.T) {
			rc := &RunContext{Config: &Config{EventName: "workflow_dispatch", Workdir: t.TempDir(), Env: map[string]string{}},
				Run: &model.Run{JobID: "check", Workflow: &workflow}, Env: map[string]string{}}
			gh := rc.getGithubContext(t.Context())
			gh.Event = map[string]interface{}{"inputs": map[string]interface{}{"amount": value}}
			got := getEvaluatorInputs(t.Context(), rc, nil, gh)["amount"]
			if got != value {
				t.Fatalf("invalid original string became %#v", got)
			}
		})
	}
}
