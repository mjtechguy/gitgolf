package actionsengine

import (
	"archive/tar"
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/workflowinputs"
)

const testWorkflowPath = ".github/workflows/graph.yml"

func typedInput(t *testing.T, source string, extra map[string]string) protocol.ActionPlanInput {
	t.Helper()
	in := testInput(t, source, extra)
	schema, err := workflowinputs.Parse([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	in.Catalog = protocol.ActionsInputsCatalog
	in.ManualInputsContract = protocol.ManualInputsCapability
	in.ManualInputsSchemaSHA256 = schema.SHA256
	return in
}

const typedWorkflow = `on:
  workflow_dispatch:
    inputs:
      enabled: {type: boolean, default: false}
      count: {type: number, default: 0}
      message: {type: string}
      choice: {type: choice, options: [one, two], default: one}
jobs:
  check:
    runs-on: linux
    if: inputs.enabled || inputs.count == 0
    env: {MESSAGE: '${{ inputs.message }}'}
    outputs: {value: '${{ steps.emit.outputs.value }}'}
    steps:
      - id: emit
        if: "${{ github['event'].inputs.count == '0' }}"
        run: echo "${{ toJSON(inputs.count) }}"
`

func TestTypedInputsCatalogExactSchemaAndLegacyBoundary(t *testing.T) {
	in := typedInput(t, typedWorkflow, nil)
	plan, err := Plan(in)
	if err != nil || plan.Catalog != protocol.ActionsInputsCatalog || plan.ManualInputsContract != protocol.ManualInputsCapability || plan.ManualInputsSchemaSHA256 != in.ManualInputsSchemaSHA256 {
		t.Fatal("typed source/schema contract not bound", err)
	}
	inspect := in
	inspect.Event = "inspect"
	if _, err := Plan(inspect); err != nil {
		t.Fatal("typed schema inspection refused", err)
	}
	for _, mutate := range []func(*protocol.ActionPlanInput){
		func(in *protocol.ActionPlanInput) { in.Catalog = protocol.ActionsCatalog },
		func(in *protocol.ActionPlanInput) { in.ManualInputsContract = "" },
		func(in *protocol.ActionPlanInput) { in.ManualInputsSchemaSHA256 = strings.Repeat("c", 64) },
		func(in *protocol.ActionPlanInput) { in.Ref = "main" },
		func(in *protocol.ActionPlanInput) { in.Event = "push"; in.Ref = "refs/heads/main" },
	} {
		changed := in
		mutate(&changed)
		if _, err := Plan(changed); err == nil {
			t.Fatal("invalid typed planning contract admitted")
		}
	}
	legacy := testInput(t, "on: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps: [{run: 'true'}]\n", nil)
	legacy.ManualInputsContract = protocol.ManualInputsCapability
	if _, err := Plan(legacy); err == nil {
		t.Fatal("v1 accepted a typed-contract extension")
	}
}

func TestTypedInputsASTPositionsAndAuthorityNamespaces(t *testing.T) {
	for _, expression := range []string{
		"inputs.message", "github.event.inputs.message", "GITHUB['EVENT']['INPUTS'].message",
		"format('github.token is literal', inputs.message)", "needs.before.outputs.value",
		"contains(toJSON(github.event.inputs), 'message')", "inputs['message']",
	} {
		source := strings.Replace(typedWorkflow, "toJSON(inputs.count)", expression, 1)
		if _, err := Plan(typedInput(t, source, nil)); err != nil {
			t.Fatalf("admitted expression %q refused: %v", expression, err)
		}
	}
	for _, expression := range []string{
		"github", "github.event", "github.token", "github.event.repository.private",
		"GITHUB['token']", "github[inputs.message].inputs", "github.event.*.inputs",
		"runner.name", "secrets.VALUE", "vars.VALUE", "strategy.max-parallel",
		"jobs.before.outputs.value", "unknown.value", "inputs.message + 1", "github.event.inputs.message || secrets.VALUE",
	} {
		source := strings.Replace(typedWorkflow, "toJSON(inputs.count)", expression, 1)
		if _, err := Plan(typedInput(t, source, nil)); err == nil {
			t.Fatalf("authority/malformed expression %q admitted", expression)
		}
	}
	for _, replacement := range []struct{ old, next string }{
		{"runs-on: linux", "runs-on: '${{ inputs.message }}'"},
		{"    runs-on: linux", "    runs-on: linux\n    needs: '${{ inputs.message }}'"},
		{"    runs-on: linux", "    runs-on: linux\n    strategy: {matrix: '${{ inputs.message }}'}"},
		{"    runs-on: linux", "    runs-on: linux\n    name: '${{ inputs.message }}'"},
		{"      - id: emit", "      - id: '${{ inputs.message }}'"},
		{"        run:", "        shell: '${{ inputs.message }}'\n        run:"},
		{"if: inputs.enabled || inputs.count == 0", "if: github.token"},
	} {
		source := strings.Replace(typedWorkflow, replacement.old, replacement.next, 1)
		if _, err := Plan(typedInput(t, source, nil)); err == nil {
			t.Fatal("input-driven graph/image/unsupported position admitted", replacement.next)
		}
	}
}

const testWorkflow = `name: Explicit graph
on: [push, workflow_dispatch]
defaults: {run: {shell: sh}}
jobs:
  build:
    runs-on: linux
    outputs: {value: '${{ steps.emit.outputs.value }}'}
    steps:
      - id: emit
        run: printf 'value=owned\n' >> "$GITHUB_OUTPUT"
  test:
    needs: build
    runs-on: linux
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        cell: [a, b]
        exclude: [{cell: b}]
        include: [{cell: c}]
    steps:
      - id: local
        uses: ./actions/owned
        with: {value: '${{ needs.build.outputs.value }}'}
      - id: skip
        if: ${{ false }}
        run: exit 99
  lint:
    needs: build
    runs-on: linux
    steps: [{run: 'true'}]
  package:
    needs: [test, lint]
    runs-on: linux
    steps: [{run: 'true'}]
`
const testComposite = `name: Owned composite
inputs: {value: {required: true}}
outputs: {value: {value: '${{ steps.emit.outputs.value }}'}}
runs:
  using: composite
  steps:
    - id: emit
      shell: sh
      env: {VALUE: '${{ inputs.value }}'}
      run: printf 'value=%s\n' "$VALUE" >> "$GITHUB_OUTPUT"
`

func testInput(t *testing.T, source string, files map[string]string) protocol.ActionPlanInput {
	t.Helper()
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	put := func(name, body string) {
		t.Helper()
		if tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0644, Size: int64(len(body))}) != nil {
			t.Fatal("fixture tar header")
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal("fixture tar body")
		}
	}
	put(testWorkflowPath, source)
	for name, body := range files {
		put(name, body)
	}
	if tw.Close() != nil {
		t.Fatal("fixture tar close")
	}
	h := sha1.Sum([]byte(fmt.Sprintf("blob %d\x00%s", len(source), source)))
	return protocol.ActionPlanInput{Catalog: protocol.ActionsCatalog, WorkflowPath: testWorkflowPath, WorkflowBlobID: hex.EncodeToString(h[:]), Archive: archive.Bytes(), Event: "workflow_dispatch", Ref: strings.Repeat("a", 40), Images: map[string]string{"linux": "alpine@sha256:" + strings.Repeat("b", 64)}}
}
func TestActualPinnedGraphMatrixAndLocalCompositeAdmission(t *testing.T) {
	input := testInput(t, testWorkflow, map[string]string{"actions/owned/action.yml": testComposite})
	plan, err := Plan(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Jobs) != 5 {
		t.Fatalf("want5 admitted instances, got%d", len(plan.Jobs))
	}
	ids := map[string]bool{}
	cells := map[string]bool{}
	for _, job := range plan.Jobs {
		if ids[job.InstanceID] {
			t.Fatal("ambiguous instance identity")
		}
		ids[job.InstanceID] = true
		if job.JobID == "test" {
			if len(job.Needs) != 1 || job.Needs[0] != "build" || len(job.Steps) != 2 || job.Steps[0].ID != "local" || len(job.Matrix) != 1 {
				t.Fatal("matrix job coordinates differ")
			}
			cells[job.Matrix[0].Value] = true
		}
	}
	if !cells[`"a"`] || !cells[`"c"`] || cells[`"b"`] {
		t.Fatal("matrix include/exclude not engine-derived")
	}
	input.Event = "push"
	input.Ref = "refs/heads/main"
	push, err := Plan(input)
	if err != nil || len(push.Jobs) != 5 {
		t.Fatal("independent push planning", err)
	}
	input.Event = "inspect"
	inspect, err := Plan(input)
	if err != nil || len(inspect.Events) != 2 || inspect.Events[0] != "push" || inspect.Events[1] != "workflow_dispatch" {
		t.Fatal("honest inspector inventory", err)
	}
}
func TestEngineAdmissionRefusesUnsupportedSemanticsAndComplexity(t *testing.T) {
	for name, source := range map[string]string{
		"continue-error":   strings.Replace(testWorkflow, "id: emit", "continue-on-error: true\n        id: emit", 1),
		"services":         strings.Replace(testWorkflow, "  build:\n", "  build:\n    services: {db: {image: postgres}}\n", 1),
		"container":        strings.Replace(testWorkflow, "  build:\n", "  build:\n    container: {image: alpine, options: --privileged}\n", 1),
		"remote-action":    strings.Replace(testWorkflow, "./actions/owned", "actions/checkout@v4", 1),
		"dynamic-matrix":   strings.Replace(testWorkflow, "cell: [a, b]", "cell: ${{ fromJSON(needs.build.outputs.cells) }}", 1),
		"ambiguous-matrix": strings.Replace(testWorkflow, "cell: [a, b]", "cell: [a, a]", 1),
		"unknown-controls": "concurrency: owned\n" + testWorkflow,
		"missing-needs":    strings.Replace(testWorkflow, "needs: build", "needs: absent", 1),
		"credentials":      "env: {GOLF_RUNNER_KEY: value}\n" + testWorkflow,
		"fake-gh-api":      "env: {VALUE: '${{ github.api_url }}'}\n" + testWorkflow,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Plan(testInput(t, source, map[string]string{"actions/owned/action.yml": testComposite})); err == nil {
				t.Fatal("unsupported source admitted")
			}
		})
	}
	input := testInput(t, testWorkflow, nil)
	if _, err := Plan(input); err == nil {
		t.Fatal("missing exact local action admitted")
	}
	input = testInput(t, testWorkflow, map[string]string{"actions/owned/action.yml": testComposite})
	input.WorkflowBlobID = strings.Repeat("c", 40)
	if _, err := Plan(input); err == nil {
		t.Fatal("workflow object mismatch admitted")
	}
}
func TestCompositeExpansionBudgetBeforeExecution(t *testing.T) {
	// Reusing the same two metadata files can expand thousands of executable
	// children. Counting only distinct action files/top-level steps is unsafe.
	var composite strings.Builder
	composite.WriteString("name: Repeat\nruns:\n  using: composite\n  steps:\n")
	for i := 0; i < 16; i++ {
		composite.WriteString("    - uses: ./actions/leaf\n")
	}
	leaf := "name: Leaf\nruns:\n  using: composite\n  steps:\n"
	for i := 0; i < 16; i++ {
		leaf += "    - shell: sh\n      run: 'true'\n"
	}
	input := testInput(t, testWorkflow, map[string]string{"actions/owned/action.yml": composite.String(), "actions/leaf/action.yml": leaf})
	if _, err := Plan(input); err == nil {
		t.Fatal("composite execution amplification admitted")
	}
}
func TestPinnedEventFilterMembershipAndLiteralBranch(t *testing.T) {
	source := "on:\n  push:\n    branches: [feature/topic]\njobs:\n  check:\n    runs-on: linux\n    steps: [{shell: sh, run: 'true'}]\n"
	input := testInput(t, source, nil)
	input.Event = "push"
	input.Ref = "refs/heads/main"
	if _, err := Plan(input); err != ErrEvent {
		t.Fatal("nonmatching branch admitted", err)
	}
	input.Ref = "refs/heads/feature/topic"
	if _, err := Plan(input); err != nil {
		t.Fatal("literal slash branch denied", err)
	}
	input.Event = "workflow_dispatch"
	if _, err := Plan(input); err != ErrEvent {
		t.Fatal("manual event invented", err)
	}
}

func TestLocalMetadataBindingAndCanonicalUnicodeArchive(t *testing.T) {
	input := testInput(t, testWorkflow, map[string]string{"actions/owned/action.yml": testComposite, "雪 %.txt": "literal ordinary bytes"})
	plan, err := Plan(input)
	if err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256([]byte(testComposite))
	if len(plan.LocalActions) != 1 || plan.LocalActions[0].MetadataPath != "actions/owned/action.yml" || plan.LocalActions[0].MetadataSHA256 != hex.EncodeToString(expected[:]) {
		t.Fatal("composite metadata identity omitted")
	}
	if ordinaryPAX(&tar.Header{Name: "safe", PAXRecords: map[string]string{"path": "safe", "comment": "invented"}}) || ordinaryPAX(&tar.Header{Name: "safe", PAXRecords: map[string]string{"path": "other"}}) {
		t.Fatal("ambiguous extended header admitted")
	}
}

func TestPreparedProductionQualificationFixtureIsAdmittedByPinnedEngine(t *testing.T) {
	source, err := os.ReadFile("testdata/production-graph.yml")
	if err != nil {
		t.Fatal(err)
	}
	composite, err := os.ReadFile("testdata/actions/owned/action.yml")
	if err != nil {
		t.Fatal(err)
	}
	input := testInput(t, string(source), map[string]string{"actions/owned/action.yml": string(composite)})
	for _, event := range []string{"workflow_dispatch", "push"} {
		input.Event = event
		input.Ref = "refs/heads/main"
		plan, e := Plan(input)
		if e != nil || len(plan.Jobs) != 5 || len(plan.LocalActions) != 1 {
			t.Fatal("prepared native fixture not admitted", event, e)
		}
	}
}

func TestDeterministicMultiDimensionMatrixAndNativeNamespaceCollision(t *testing.T) {
	source := `on: workflow_dispatch
jobs:
  check:
    runs-on: linux
    strategy: {fail-fast: false, matrix: {left: [a,b],right: [1,2]}}
    steps: [{run: 'true'}]
`
	input := testInput(t, source, nil)
	first, err := Plan(input)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 30; i++ {
		next, err := Plan(input)
		if err != nil || !reflect.DeepEqual(first, next) {
			t.Fatal("map iteration changed immutable plan", err)
		}
	}
	for _, collision := range []string{
		`on: workflow_dispatch
jobs:
  a: {name: Same, runs-on: linux, steps: [{run: 'true'}]}
  b: {name: Same, runs-on: linux, steps: [{run: 'true'}]}
`,
		`on: workflow_dispatch
jobs:
  check_1: {runs-on: linux, steps: [{run: 'true'}]}
  check-1: {runs-on: linux, steps: [{run: 'true'}]}
`,
	} {
		if _, err := Plan(testInput(t, collision, nil)); err == nil {
			t.Fatal("native container/volume alias admitted")
		}
	}
}

func TestMatrixUnimplementedCancellationAndAggregateOutputsRefuseAdmission(t *testing.T) {
	for _, strategy := range []string{"matrix: {cell: [a,b]}", "fail-fast: true, matrix: {cell: [a,b]}"} {
		source := "on: workflow_dispatch\njobs:\n  cells:\n    runs-on: linux\n    strategy: {" + strategy + "}\n    steps: [{run: 'true'}]\n"
		if _, err := Plan(testInput(t, source, nil)); err == nil {
			t.Fatal("unsupported matrix fail-fast admitted")
		}
	}
	source := "on: workflow_dispatch\njobs:\n  cells:\n    runs-on: linux\n    strategy: {fail-fast: false, matrix: {cell: [a,b]}}\n    outputs: {value: '${{ steps.first.outputs.value }}'}\n    steps: [{id: first, run: 'true'}]\n"
	if _, err := Plan(testInput(t, source, nil)); err == nil {
		t.Fatal("unqualified matrix aggregate output admitted")
	}
}
