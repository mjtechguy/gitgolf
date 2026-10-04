package workflowinputs_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/workflowinputs"
)

func TestCanonicalContractGolden(t *testing.T) {
	source := []byte(`on:
  workflow_dispatch:
    inputs:
      text: {required: true}
      option: {type: choice, options: [a, b], default: b}
      flag: {type: boolean, required: true}
      count: {type: number, default: 2.0}
jobs:
  check:
    steps: [{run: 'echo ${{ inputs.text }}'}]
`)
	schema, err := workflowinputs.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	// Independently fixed JSON bytes and digests: field order/omission, sorted
	// declarations, binary64 defaults and false/empty presence are durable identity.
	schemaJSON := `[{"name":"count","type":"number","required":false,"default":{"name":"count","type":"number","number":"2"}},{"name":"flag","type":"boolean","required":true},{"name":"option","type":"choice","required":false,"default":{"name":"option","type":"choice","string":"b"},"options":["a","b"]},{"name":"text","type":"string","required":true}]`
	body, _ := json.Marshal(schema.Definitions)
	if string(body) != schemaJSON || schema.SHA256 != "e329319e226ad287cd73e76ca92e98ffcd77b7ac5b64ee420c545c75e2ac603d" {
		t.Fatal("schema identity changed")
	}
	values, err := workflowinputs.Validate(schema, []workflowinputs.Value{{Name: "text", Type: workflowinputs.String}, {Name: "flag", Type: workflowinputs.Boolean}})
	if err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(values.Submitted)
	if string(body) != `[{"name":"flag","type":"boolean"},{"name":"text","type":"string"}]` || values.SubmittedSHA256 != "7005d90be6862c19127c7f0e27e4de2e8ce00bbd3624a5542da20c0880fbbbf0" {
		t.Fatal("submitted identity changed")
	}
	body, _ = json.Marshal(values.Effective)
	if string(body) != `[{"name":"count","type":"number","number":"2"},{"name":"flag","type":"boolean"},{"name":"option","type":"choice","string":"b"},{"name":"text","type":"string"}]` || values.EffectiveSHA256 != "d84434d40b60a7d242c6f2d52169e466a68e39347ebbee91c919fff3b4cc63b3" {
		t.Fatal("effective identity changed")
	}
	if _, err = workflowinputs.Validate(schema, nil); !errors.Is(err, workflowinputs.ErrValues) {
		t.Fatal("required absence admitted")
	}
	schema.Definitions[0].Default.Number = "3"
	if _, err = workflowinputs.Validate(schema, values.Submitted); !errors.Is(err, workflowinputs.ErrValues) {
		t.Fatal("changed declaration retained old identity")
	}
}

func TestIndependentDocumentFences(t *testing.T) {
	for _, source := range []string{
		"on: workflow_dispatch\njobs: &j {}", "on: workflow_dispatch\njobs: {x: 1, x: 2}",
		"on: workflow_dispatch\njobs: {!!int 1: x}", "on: workflow_dispatch\njobs: {x: !!str hi}",
		"on: workflow_dispatch\njobs: {x: \"\\0\"}", "on: workflow_dispatch\n---\non: workflow_dispatch",
		"on: workflow_dispatch\njobs: " + strings.Repeat("[", 34) + "x" + strings.Repeat("]", 34),
		"on: workflow_dispatch\njobs: [" + strings.Repeat("x,", 4096) + "x]",
		strings.Repeat("x", (64<<10)+1),
		"on: {workflow_dispatch: {inputs: {Foo: {}, foo: {}}}}",
	} {
		if _, err := workflowinputs.Parse([]byte(source)); err != workflowinputs.ErrDeclaration {
			t.Fatal("document fence failed", err)
		}
	}
	// Whole-document expression admission belongs to the selected execution engine.
	if _, err := workflowinputs.Parse([]byte("on: workflow_dispatch\njobs: {if: '${{ inputs.flag }}'}")); err != nil {
		t.Fatal("unrelated expression was rejected", err)
	}
}

func TestCanonicalNumbersAndEscapedValueBounds(t *testing.T) {
	for input, want := range map[string]string{"-0": "0", "1.0": "1", "0.10000000000000001": "0.1", "9007199254740991": "9007199254740991", "1e-300": "1e-300"} {
		if got, err := workflowinputs.CanonicalNumber(input); err != nil || got != want {
			t.Fatal("number contract changed", input, got, err)
		}
	}
	for _, input := range []string{"9007199254740992", "90071992547409920e-1", "1e-999", "0e999999999", "01", "+1"} {
		if _, err := workflowinputs.CanonicalNumber(input); err != workflowinputs.ErrValues {
			t.Fatal("unsafe number accepted")
		}
	}
	schema, err := workflowinputs.Parse([]byte("on: {workflow_dispatch: {inputs: {text: {}}}}"))
	if err != nil {
		t.Fatal(err)
	}
	literal := "${{ secrets.value }} $(command)\nπ\t "
	result, err := workflowinputs.Validate(schema, []workflowinputs.Value{{Name: "text", Type: workflowinputs.String, String: literal}})
	if err != nil || result.Submitted[0].String != literal {
		t.Fatal("literal value changed", err)
	}
	for _, value := range []string{strings.Repeat("<", workflowinputs.MaxValueBytes), strings.Repeat("x", workflowinputs.MaxValueBytes+1)} {
		if _, err := workflowinputs.Validate(schema, []workflowinputs.Value{{Name: "text", Type: workflowinputs.String, String: value}}); err != workflowinputs.ErrValues {
			t.Fatal("escaped aggregate/individual value fence missing")
		}
	}
}
