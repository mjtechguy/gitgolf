// This source-only AC-0 qualification imports the actual pinned engine planner.
// It never imports runner, assigns a job, invokes source commands or accesses Docker.
package actionsengineproof

import (
	"bytes"
	"fmt"
	"reflect"
	"sort"
	"testing"

	"github.com/nektos/act/pkg/model"
)

func planner(t *testing.T, source string) model.WorkflowPlanner {
	t.Helper()
	p, err := model.NewSingleWorkflowPlanner("owned-qualification.yml", bytes.NewBufferString(source))
	if err != nil {
		t.Fatal("owned fixture could not be planned")
	}
	return p
}

func stageIDs(plan *model.Plan) [][]string {
	stages := make([][]string, len(plan.Stages))
	for i, stage := range plan.Stages {
		stages[i] = stage.GetJobIDs()
		sort.Strings(stages[i])
	}
	return stages
}

// Event membership only: this does NOT establish path/branch filters, event
// context evaluation or Golf policy admission, which the planner does not do.
func TestPinnedPlannerIndependentManualAndPush(t *testing.T) {
	cases := []struct {
		name, on     string
		manual, push bool
	}{
		{"manual", "workflow_dispatch", true, false},
		{"push", "push", false, true},
		{"both", "[workflow_dispatch, push]", true, true},
		{"neither", "pull_request", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := planner(t, "on: "+tc.on+"\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: 'true'\n")
			for event, expected := range map[string]bool{"workflow_dispatch": tc.manual, "push": tc.push} {
				plan, err := p.PlanEvent(event)
				if err != nil || (len(plan.Stages) > 0) != expected {
					t.Fatalf("%s membership does not match declaration", event)
				}
			}
		})
	}
}

func TestPinnedPlannerDependencyDiamond(t *testing.T) {
	p := planner(t, `on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: linux
    steps:
      - run: 'true'
  test:
    needs: build
    runs-on: linux
    steps:
      - run: 'true'
  lint:
    needs: [build]
    runs-on: linux
    steps:
      - run: 'true'
  package:
    needs: [test, lint]
    runs-on: linux
    steps:
      - run: 'true'
`)
	for _, event := range []string{"push", "workflow_dispatch"} {
		plan, err := p.PlanEvent(event)
		if err != nil {
			t.Fatal("diamond planning failed")
		}
		want := [][]string{{"build"}, {"lint", "test"}, {"package"}}
		if !reflect.DeepEqual(stageIDs(plan), want) {
			t.Fatal("dependency stages differ from required diamond")
		}
	}
	plan, err := p.PlanJob("package")
	if err != nil || !reflect.DeepEqual(stageIDs(plan), [][]string{{"build"}, {"lint", "test"}, {"package"}}) {
		t.Fatal("selected job omitted required dependencies")
	}
}

func TestPinnedPlannerRejectsUnresolvableDependencies(t *testing.T) {
	for name, jobs := range map[string]string{
		"cycle":   "  a:\n    needs: b\n    runs-on: linux\n    steps: [{run: 'true'}]\n  b:\n    needs: a\n    runs-on: linux\n    steps: [{run: 'true'}]\n",
		"missing": "  a:\n    needs: absent\n    runs-on: linux\n    steps: [{run: 'true'}]\n",
	} {
		t.Run(name, func(t *testing.T) {
			p := planner(t, "on: push\njobs:\n"+jobs)
			plan, err := p.PlanEvent("push")
			if err == nil || len(plan.Stages) != 0 {
				t.Fatal("unresolvable graph produced an executable plan")
			}
		})
	}
}

func TestPinnedStaticMatrixIncludeExclude(t *testing.T) {
	p := planner(t, `on: push
jobs:
  check:
    runs-on: linux
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        language: [go, javascript]
        suite: [unit, integration]
        exclude:
          - language: javascript
            suite: integration
        include:
          - language: go
            suite: unit
            extra: explicit
          - language: rust
            suite: unit
    steps:
      - run: 'true'
`)
	plan, err := p.PlanEvent("push")
	if err != nil || len(plan.Stages) != 1 || len(plan.Stages[0].Runs) != 1 {
		t.Fatal("matrix workflow planning failed")
	}
	job := plan.Stages[0].Runs[0].Job()
	variants, err := job.GetMatrixes()
	if err != nil {
		t.Fatal("static matrix expansion failed")
	}
	var got []string
	for _, v := range variants {
		got = append(got, fmt.Sprintf("%v/%v/%v", v["language"], v["suite"], v["extra"]))
	}
	sort.Strings(got)
	want := []string{"go/integration/<nil>", "go/unit/explicit", "javascript/unit/<nil>", "rust/unit/<nil>"}
	if !reflect.DeepEqual(got, want) || job.Strategy.GetFailFast() || job.Strategy.GetMaxParallel() != 2 {
		t.Fatal("matrix membership or configured strategy differs")
	}
	// Expansion is separate from PlanEvent: one planner run is not one job
	// instance. Golf must enforce a matrix budget at the engine boundary.
	if len(plan.Stages[0].Runs) == len(variants) {
		t.Fatal("fixture no longer demonstrates planner versus matrix identity")
	}
}

func TestPinnedSchemaAcceptsControlsWithoutExecutionProof(t *testing.T) {
	// Known schema fields can disappear from model ownership or remain unused
	// by execution. Acceptance is an observation, NEVER an admission grant.
	source := `on: workflow_dispatch
concurrency:
  group: owned-group
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  check:
    runs-on: linux
    timeout-minutes: 1
    environment: production
    permissions:
      contents: read
    steps:
      - run: 'true'
`
	w, err := model.ReadWorkflow(bytes.NewBufferString(source), true)
	if err != nil || w.GetJob("check").TimeoutMinutes != "1" {
		t.Fatal("strict model did not accept documented control fixture")
	}
	p := planner(t, source)
	plan, err := p.PlanEvent("workflow_dispatch")
	if err != nil || !reflect.DeepEqual(stageIDs(plan), [][]string{{"check"}}) {
		t.Fatal("accepted controls changed structural event planning unexpectedly")
	}
	// No runner is called; this cannot establish enforcement of timeout,
	// production approval, permissions or concurrency.
}

func TestPinnedStrictSchemaRejectsUnknownRootField(t *testing.T) {
	_, err := model.ReadWorkflow(bytes.NewBufferString("on: push\ngolf_unknown: true\njobs:\n  check:\n    runs-on: linux\n    steps: [{run: 'true'}]\n"), true)
	if err == nil {
		t.Fatal("unknown syntax silently passed strict schema")
	}
}

func TestPinnedEventPlanDoesNotApplyBranchFilter(t *testing.T) {
	p := planner(t, "on:\n  push:\n    branches: [main]\njobs:\n  check:\n    runs-on: linux\n    steps: [{run: 'true'}]\n")
	plan, err := p.PlanEvent("push")
	if err != nil || len(plan.Stages) != 1 {
		t.Fatal("structural event planning failed")
	}
	// PlanEvent accepts only an event name, not a branch/event payload. This
	// positive result cannot admit a push to a different branch.
	declaration := plan.Stages[0].Runs[0].Workflow.OnEvent("push")
	if declaration == nil {
		t.Fatal("branch-filter declaration was not retained for later admission")
	}
}

func TestPinnedMatrixHasNoGolfExpansionBudget(t *testing.T) {
	p := planner(t, "on: push\njobs:\n  check:\n    runs-on: linux\n    strategy:\n      matrix:\n        a: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]\n        b: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]\n    steps: [{run: 'true'}]\n")
	plan, err := p.PlanEvent("push")
	if err != nil || len(plan.Stages) != 1 {
		t.Fatal("owned matrix fixture could not be planned")
	}
	variants, err := plan.Stages[0].Runs[0].Job().GetMatrixes()
	if err != nil || len(variants) != 400 {
		t.Fatal("pinned engine expansion characterization changed")
	}
	// This is an owned, bounded 400-element fixture, not an implementation of
	// a production limit. Golf still needs a pre-expansion resource guard.
}
