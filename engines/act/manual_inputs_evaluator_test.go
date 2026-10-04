package actionsengine

import (
	"context"
	"testing"

	"github.com/nektos/act/pkg/exprparser"
	"github.com/nektos/act/pkg/model"
	act "github.com/nektos/act/pkg/runner"
	"gopkg.in/yaml.v3"
)

// Source evaluator evidence only: this does not enable a typed-input catalog or
// execute Docker, a native job, or a workflow admitted by Golf's current profile.
func TestManualInputsPublicEvaluators(t *testing.T) {
	const source = `on:
  workflow_dispatch:
    inputs:
      count: {type: number, default: 12}
      small: {type: number, default: 2}
      zero: {type: number, default: 0}
      decimal: {type: number, default: 0.125}
      exponent: {type: number, default: 1e3}
      enabled: {type: boolean, default: true}
      disabled: {type: boolean, default: false}
      default_true: {type: boolean, default: true}
      default_false: {type: boolean, default: false}
      text: {type: string, default: '12'}
      choice: {type: choice, default: '12', options: ['12', '2']}
jobs:
  check:
    runs-on: linux
    steps: [{run: 'true'}]
`
	var workflow model.Workflow
	if err := yaml.Unmarshal([]byte(source), &workflow); err != nil {
		t.Fatal(err)
	}
	const event = `{"inputs":{"count":"10","small":"2","zero":"0","decimal":"0.25","exponent":"1000","enabled":"true","disabled":"false","text":"12","choice":"12"}}`
	rc := &act.RunContext{
		Config: &act.Config{EventName: "workflow_dispatch", Workdir: t.TempDir(), Env: map[string]string{}},
		Run:    &model.Run{JobID: "check", Workflow: &workflow}, EventJSON: event,
		Env: map[string]string{"INPUT_OTHER": "42"}, StepResults: map[string]*model.StepResult{},
	}
	for name, create := range map[string]func(context.Context) act.ExpressionEvaluator{
		"job": rc.NewExpressionEvaluator,
		"job_with_environment": func(ctx context.Context) act.ExpressionEvaluator {
			return rc.NewExpressionEvaluatorWithEnv(ctx, map[string]string{"TEST": "yes"})
		},
	} {
		t.Run(name, func(t *testing.T) {
			eval := create(t.Context())
			for expression, want := range map[string]string{
				"toJSON(inputs.count)": "10", "toJSON(inputs.decimal)": "0.25",
				"toJSON(inputs.exponent)": "1000", "toJSON(inputs.zero)": "0",
				"toJSON(inputs.enabled)": "true", "toJSON(inputs.disabled)": "false",
				"toJSON(inputs.default_true)": "true", "toJSON(inputs.default_false)": "false",
				"toJSON(inputs.text)": `"12"`, "toJSON(inputs.choice)": `"12"`,
				"toJSON(inputs.other)": `"42"`, "toJSON(github.event.inputs.count)": `"10"`,
				"toJSON(github.event.inputs.enabled)": `"true"`,
			} {
				if got := eval.Interpolate(t.Context(), "${{ "+expression+" }}"); got != want {
					t.Errorf("%s = %q, want %q", expression, got, want)
				}
			}
			for expression, want := range map[string]bool{
				"inputs.count < inputs.small": false, "inputs.zero": false,
				"inputs.enabled": true, "inputs.disabled": false,
				"inputs.default_true": true, "inputs.default_false": false,
			} {
				if got, err := act.EvalBool(t.Context(), eval, expression, exprparser.DefaultStatusCheckNone); err != nil || got != want {
					t.Errorf("%s = %v, %v; want %v", expression, got, err, want)
				}
			}
			if rc.EventJSON != event {
				t.Fatal("evaluator rewrote the event payload")
			}
		})
	}
	// Missing submitted numeric values use the declared numeric default.
	rc.EventJSON = `{}`
	if got := rc.NewExpressionEvaluator(t.Context()).Interpolate(t.Context(), "${{ toJSON(inputs.count) }}"); got != "12" {
		t.Fatalf("numeric default = %q", got)
	}
}
