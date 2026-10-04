package server

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func dispatchInputWorkflow(definitions string) []byte {
	return []byte("on:\n  workflow_dispatch:\n    inputs:\n" + definitions + "jobs:\n  check:\n    runs-on: linux\n    steps: [{run: 'echo ${{ inputs.text }}'}]\n")
}
func dispatchInputSchema(t *testing.T, definitions string) workflowDispatchInputSchema {
	t.Helper()
	schema, e := parseWorkflowDispatchInputs(dispatchInputWorkflow(definitions))
	if e != nil {
		t.Fatal(e)
	}
	return schema
}
func TestWorkflowDispatchInputsPresenceDefaultsAndCanonicalDigests(t *testing.T) {
	schema := dispatchInputSchema(t, `      text: {required: true}
      flag: {type: boolean, required: true}
      count: {type: number, default: 2.0}
      option: {type: choice, options: [warning, info], default: warning}
      empty: {}
      off: {type: boolean}
`)
	submitted := []workflowDispatchInputValue{{Name: "text", Type: workflowDispatchString, String: ""}, {Name: "flag", Type: workflowDispatchBoolean, Boolean: false}}
	result, e := validateWorkflowDispatchInputs(schema, submitted)
	if e != nil {
		t.Fatal(e)
	}
	if len(result.Submitted) != 2 || len(result.Effective) != 6 || result.SubmittedSHA256 == result.EffectiveSHA256 {
		t.Fatalf("defaults must be separate from submitted presence: %#v", result)
	}
	expected := []workflowDispatchInputValue{{Name: "count", Type: workflowDispatchNumber, Number: "2"}, {Name: "empty", Type: workflowDispatchString}, {Name: "flag", Type: workflowDispatchBoolean}, {Name: "off", Type: workflowDispatchBoolean}, {Name: "option", Type: workflowDispatchChoice, String: "warning"}, {Name: "text", Type: workflowDispatchString}}
	for i, value := range expected {
		if result.Effective[i] != value {
			t.Fatalf("value%d: %#v", i, result.Effective[i])
		}
	}
	reversed, e := validateWorkflowDispatchInputs(schema, []workflowDispatchInputValue{submitted[1], submitted[0]})
	if e != nil || reversed.SubmittedSHA256 != result.SubmittedSHA256 || reversed.EffectiveSHA256 != result.EffectiveSHA256 {
		t.Fatal("submission order changed canonical identity", e)
	}
	submitted[0].String = "modified after validation"
	if result.Submitted[1].String != "" {
		t.Fatal("caller mutated validated snapshot")
	}
	if _, e = validateWorkflowDispatchInputs(schema, nil); !errors.Is(e, errWorkflowDispatchInputValues) {
		t.Fatal("required absence was accepted", e)
	}
	changed := dispatchInputSchema(t, `      text: {required: true}
      flag: {type: boolean, required: true}
      count: {type: number, default: 3}
      option: {type: choice, options: [warning, info], default: warning}
      empty: {}
      off: {type: boolean}
`)
	other, e := validateWorkflowDispatchInputs(changed, []workflowDispatchInputValue{{Name: "text", Type: workflowDispatchString}, {Name: "flag", Type: workflowDispatchBoolean}})
	if e != nil || changed.SHA256 == schema.SHA256 || other.SubmittedSHA256 != result.SubmittedSHA256 || other.EffectiveSHA256 == result.EffectiveSHA256 {
		t.Fatal("schema/default digest boundaries", e)
	}
	schema.Definitions[0].Required = !schema.Definitions[0].Required
	if _, e = validateWorkflowDispatchInputs(schema, nil); !errors.Is(e, errWorkflowDispatchInputValues) {
		t.Fatal("changed schema passed original digest", e)
	}
}
func TestWorkflowDispatchInputsDeclarations(t *testing.T) {
	valid := []string{"on: workflow_dispatch\njobs: {}\n", "on: [push, workflow_dispatch]\njobs: {}\n", "on: {push: {}, workflow_dispatch: null}\njobs: {}\n", "on: {workflow_dispatch: {}}\njobs: {}\n"}
	var emptyDigest string
	for _, source := range valid {
		schema, e := parseWorkflowDispatchInputs([]byte(source))
		if e != nil || len(schema.Definitions) != 0 {
			t.Fatal("valid empty declaration", source, e)
		}
		if emptyDigest != "" && emptyDigest != schema.SHA256 {
			t.Fatal("empty input schema depends on unrelated source")
		}
		emptyDigest = schema.SHA256
	}
	sorted := dispatchInputSchema(t, "      z: {type: boolean}\n      a: {}\n")
	reordered := dispatchInputSchema(t, "      a: {}\n      z: {type: boolean}\n")
	if sorted.SHA256 != reordered.SHA256 {
		t.Fatal("definition order changed schema digest")
	}
	cases := []string{
		"      x: {type: environment}\n", "      x: {type: unknown}\n", "      x: {required: 'false'}\n", "      x: {default: false}\n", "      x: {type: boolean, default: 'false'}\n", "      x: {type: number, default: '2'}\n", "      x: {type: number, default: .nan}\n", "      x: {type: number, default: 0x10}\n", "      x: {type: choice}\n", "      x: {type: choice, options: []}\n", "      x: {type: choice, options: [a, a]}\n", "      x: {type: choice, options: [a], default: b}\n", "      x: {type: choice, options: [a, 1]}\n", "      x: {options: [a]}\n", "      x: {type: string, extra: false}\n", "      x: {}\n      x: {}\n", "      Foo: {}\n      foo: {}\n", "      'bad.name': {}\n", "      x: {default: '${{ secrets.value }}'}\n", "      x: {description: '${{ inputs.y }}'}\n", "      x: {type: choice, options: ['${{ inputs.y }}']}\n",
	}
	for _, definition := range cases {
		if _, e := parseWorkflowDispatchInputs(dispatchInputWorkflow(definition)); !errors.Is(e, errWorkflowDispatchInputDeclaration) {
			t.Fatalf("accepted invalid declaration %q: %v", definition, e)
		}
	}
	documents := []string{"on: push\njobs: {}", "on: [workflow_dispatch, workflow_dispatch]", "on: {workflow_dispatch: {unknown: true}}", "on: {workflow_dispatch: {inputs: null}}", "on: {workflow_dispatch: &value {}}", "on: {workflow_dispatch: !!map {}}", "on: {workflow_dispatch: {}}\n---\non: push", "on: {workflow_dispatch: {}}\nname: \"\\0\"", "on: {workflow_dispatch: {}}\njobs: &jobs {}\n"}
	for _, source := range documents {
		if _, e := parseWorkflowDispatchInputs([]byte(source)); !errors.Is(e, errWorkflowDispatchInputDeclaration) {
			t.Fatalf("accepted malformed document %q %v", source, e)
		}
	}
}
func TestWorkflowDispatchInputsNumbers(t *testing.T) {
	for source, want := range map[string]string{"0": "0", "-0": "0", "1.0": "1", "1e3": "1000", "-12.5": "-12.5", "0.10000000000000001": "0.1", "9007199254740991": "9007199254740991", "1e-300": "1e-300"} {
		got, e := canonicalWorkflowDispatchNumber(source)
		if e != nil || got != want {
			t.Fatalf("%q -> %q expected%q (%v)", source, got, want, e)
		}
		if again, err := canonicalWorkflowDispatchNumber(got); err != nil || again != got {
			t.Fatal("number normalization is not idempotent", source, err)
		}
	}
	for _, source := range []string{"", "null", "true", "+1", "01", "1.", ".1", "NaN", "Infinity", "1e999", "1e-999", "0e999999999", "0e-999999999", "9007199254740992", "-9007199254740992", "9007199254740991.5", "90071992547409920e-1", " 1", "1\n", "0x10", strings.Repeat("1", 65)} {
		if _, e := canonicalWorkflowDispatchNumber(source); !errors.Is(e, errWorkflowDispatchInputValues) {
			t.Fatalf("number %q accepted: %v", source, e)
		}
	}
	schema := dispatchInputSchema(t, "      x: {type: number, required: true}\n")
	a, e := validateWorkflowDispatchInputs(schema, []workflowDispatchInputValue{{Name: "x", Type: workflowDispatchNumber, Number: "1.0"}})
	if e != nil {
		t.Fatal(e)
	}
	b, e := validateWorkflowDispatchInputs(schema, []workflowDispatchInputValue{{Name: "x", Type: workflowDispatchNumber, Number: "1"}})
	if e != nil || a.SubmittedSHA256 != b.SubmittedSHA256 {
		t.Fatal("equivalent binary64 numbers have different identities", e)
	}
}
func TestWorkflowDispatchInputsRefusalsAndLiteralValues(t *testing.T) {
	schema := dispatchInputSchema(t, "      text: {}\n      flag: {type: boolean}\n      option: {type: choice, options: [a, b], default: a}\n      count: {type: number, default: 0}\n")
	cases := [][]workflowDispatchInputValue{
		{{Name: "unknown", Type: workflowDispatchString}},
		{{Name: "TEXT", Type: workflowDispatchString}},
		{{Name: "text", Type: workflowDispatchString}, {Name: "text", Type: workflowDispatchString}},
		{{Name: "flag", Type: workflowDispatchString, String: "false"}},
		{{Name: "option", Type: workflowDispatchChoice, String: "A"}},
		{{Name: "text", Type: workflowDispatchString, Boolean: true}},
		{{Name: "flag", Type: workflowDispatchBoolean, Number: "0"}},
		{{Name: "text", Type: workflowDispatchString, String: "private\x00sentinel"}},
		{{Name: "text", Type: workflowDispatchString, String: string([]byte{0xff})}},
		{{Name: "text", Type: workflowDispatchString, String: strings.Repeat("x", 2049)}},
	}
	for _, values := range cases {
		if _, e := validateWorkflowDispatchInputs(schema, values); e != errWorkflowDispatchInputValues || strings.Contains(e.Error(), "private") {
			t.Fatal("invalid/private error contract", e)
		}
	}
	literal := "${{ secrets.value }} $(touch /tmp/nope) 'quoted'\nπ\t  "
	result, e := validateWorkflowDispatchInputs(schema, []workflowDispatchInputValue{{Name: "text", Type: workflowDispatchString, String: literal}})
	if e != nil || result.Submitted[0].String != literal {
		t.Fatal("literal value changed or evaluated", e)
	}
	for _, definition := range []string{"      x: {type: number}\n", "      x: {type: choice, options: [a, b]}\n"} {
		ambiguous := dispatchInputSchema(t, definition)
		if _, e := validateWorkflowDispatchInputs(ambiguous, nil); e != errWorkflowDispatchInputValues {
			t.Fatal("invented optional numeric/choice fallback", e)
		}
	}
}
func TestWorkflowDispatchInputsSizeAndComplexityBounds(t *testing.T) {
	var definitions strings.Builder
	values := []workflowDispatchInputValue{}
	for i := 0; i < 25; i++ {
		name := fmt.Sprintf("v%d", i)
		fmt.Fprintf(&definitions, "      %s: {}\n", name)
		values = append(values, workflowDispatchInputValue{Name: name, Type: workflowDispatchString, String: "okay"})
	}
	schema := dispatchInputSchema(t, definitions.String())
	if _, e := validateWorkflowDispatchInputs(schema, values); e != nil {
		t.Fatal("25 values refused", e)
	}
	if _, e := parseWorkflowDispatchInputs(dispatchInputWorkflow(definitions.String() + "      v25: {}\n")); e != errWorkflowDispatchInputDeclaration {
		t.Fatal("26 declarations accepted", e)
	}
	if _, e := validateWorkflowDispatchInputs(schema, append(values, values[0])); e != errWorkflowDispatchInputValues {
		t.Fatal("26 values accepted", e)
	}
	// Raw strings satisfy individual bounds; JSON HTML escaping still exceeds the
	// aggregate limit. Both supplied values and declaration defaults are checked.
	small := dispatchInputSchema(t, "      x: {}\n")
	if _, e := validateWorkflowDispatchInputs(small, []workflowDispatchInputValue{{Name: "x", Type: workflowDispatchString, String: strings.Repeat("<", 2048)}}); e != errWorkflowDispatchInputValues {
		t.Fatal("escaped JSON aggregate limit missing", e)
	}
	defaults := dispatchInputSchema(t, "      x: {default: '"+strings.Repeat("<", 2048)+"'}\n")
	if _, e := validateWorkflowDispatchInputs(defaults, nil); e != errWorkflowDispatchInputValues {
		t.Fatal("effective JSON aggregate limit missing", e)
	}
	for _, source := range []string{strings.Repeat("x", maxWorkflowBytes+1), "on: workflow_dispatch\njobs: " + strings.Repeat("[", 34) + "x" + strings.Repeat("]", 34), "on: workflow_dispatch\njobs: [" + strings.Repeat("x,", 4096) + "x]"} {
		if _, e := parseWorkflowDispatchInputs([]byte(source)); e != errWorkflowDispatchInputDeclaration {
			t.Fatal("source complexity bound missing", e)
		}
	}
}
func FuzzWorkflowDispatchInputs(f *testing.F) {
	f.Add([]byte("on: workflow_dispatch\njobs: {}"))
	f.Add(dispatchInputWorkflow("      x: {type: number, default: 0}\n"))
	f.Fuzz(func(t *testing.T, data []byte) {
		schema, e := parseWorkflowDispatchInputs(data)
		if e != nil {
			if e != errWorkflowDispatchInputDeclaration {
				t.Fatal("unbounded declaration error")
			}
			return
		}
		if len(schema.Definitions) > 25 || len(schema.SHA256) != 64 {
			t.Fatal("invalid admitted schema")
		}
		result, e := validateWorkflowDispatchInputs(schema, nil)
		if e != nil {
			if e != errWorkflowDispatchInputValues {
				t.Fatal("unbounded value error")
			}
			return
		}
		if len(result.SubmittedSHA256) != 64 || len(result.EffectiveSHA256) != 64 {
			t.Fatal("invalid digests")
		}
	})
}
