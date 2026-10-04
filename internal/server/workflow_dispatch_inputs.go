package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"go.yaml.in/yaml/v3"
)

const (
	maxWorkflowDispatchInputs      = 25
	maxWorkflowDispatchInputBytes  = 2048
	maxWorkflowDispatchInputsBytes = 8 << 10
)

// These fixed errors must not include private submitted/default values.
var (
	errWorkflowDispatchInputDeclaration = errors.New("Workflow dispatch input declarations are unsupported or malformed.")
	errWorkflowDispatchInputValues      = errors.New("Workflow dispatch inputs are missing, unsupported or outside their declared bounds.")
	workflowDispatchInputName           = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)
	workflowDispatchJSONNumber          = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)
)

type workflowDispatchInputType string

const (
	workflowDispatchString  workflowDispatchInputType = "string"
	workflowDispatchBoolean workflowDispatchInputType = "boolean"
	workflowDispatchNumber  workflowDispatchInputType = "number"
	workflowDispatchChoice  workflowDispatchInputType = "choice"
)

// Type is explicit: an empty string, false and zero still represent presence.
// The future wire adapter must preserve its oneof and reject unknown fields.
type workflowDispatchInputValue struct {
	Name    string                    `json:"name"`
	Type    workflowDispatchInputType `json:"type"`
	String  string                    `json:"string,omitempty"`
	Boolean bool                      `json:"boolean,omitempty"`
	Number  string                    `json:"number,omitempty"`
}
type workflowDispatchInputDefinition struct {
	Name        string                      `json:"name"`
	Type        workflowDispatchInputType   `json:"type"`
	Description string                      `json:"description,omitempty"`
	Required    bool                        `json:"required"`
	Default     *workflowDispatchInputValue `json:"default,omitempty"`
	Options     []string                    `json:"options,omitempty"`
}
type workflowDispatchInputSchema struct {
	Definitions []workflowDispatchInputDefinition
	SHA256      string
}
type workflowDispatchInputValues struct {
	Submitted, Effective             []workflowDispatchInputValue
	SubmittedSHA256, EffectiveSHA256 string
}

func workflowDispatchInputText(s string, limit int) bool {
	return len(s) <= limit && utf8.ValidString(s) && strings.IndexFunc(s, func(r rune) bool {
		return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t'
	}) == -1
}
func workflowDispatchInputFields(n *yaml.Node, allowed ...string) bool {
	if n == nil || n.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i < len(n.Content); i += 2 {
		if !slices.Contains(allowed, n.Content[i].Value) {
			return false
		}
	}
	return true
}

// This is declaration parsing only. It does not validate other workflow fields,
// admit the selected catalog, resolve source, authorize execution or evaluate an
// expression. Reuse the existing workflow parser's document/complexity fences.
func parseWorkflowDispatchInputs(data []byte) (workflowDispatchInputSchema, error) {
	fail := func() (workflowDispatchInputSchema, error) {
		return workflowDispatchInputSchema{}, errWorkflowDispatchInputDeclaration
	}
	if len(data) > maxWorkflowBytes || !workflowDispatchInputText(string(data), maxWorkflowBytes) {
		return fail()
	}
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	var doc, extra yaml.Node
	if decoder.Decode(&doc) != nil || len(doc.Content) != 1 || decoder.Decode(&extra) != io.EOF {
		return fail()
	}
	count := 0
	inspector := workflowInspector{config: &golfv1.WorkflowConfiguration{}}
	if !inspector.safeYAML(&doc, 0, &count) {
		return fail()
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode || len(root.Content) == 0 {
		return fail()
	}
	on := workflowField(root, "on")
	var declaration *yaml.Node
	switch {
	case on != nil && on.Kind == yaml.ScalarNode && on.Tag == "!!str" && on.Value == "workflow_dispatch":
	case on != nil && on.Kind == yaml.MappingNode:
		declaration = workflowField(on, "workflow_dispatch")
		if declaration == nil {
			return fail()
		}
	case on != nil && on.Kind == yaml.SequenceNode:
		seen := map[string]bool{}
		for _, event := range on.Content {
			if event.Kind != yaml.ScalarNode || event.Tag != "!!str" || seen[event.Value] {
				return fail()
			}
			seen[event.Value] = true
		}
		if !seen["workflow_dispatch"] {
			return fail()
		}
	default:
		return fail()
	}
	schema := workflowDispatchInputSchema{Definitions: []workflowDispatchInputDefinition{}}
	if declaration != nil && declaration.Tag != "!!null" {
		if !workflowDispatchInputFields(declaration, "inputs") {
			return fail()
		}
		inputs := workflowField(declaration, "inputs")
		if inputs != nil {
			if inputs.Kind != yaml.MappingNode || len(inputs.Content) > 2*maxWorkflowDispatchInputs {
				return fail()
			}
			// Pinned act resolves map properties case-insensitively. Refuse
			// colliding names rather than let map iteration pick an input.
			seenNames := map[string]bool{}
			for i := 0; i < len(inputs.Content); i += 2 {
				name, n := inputs.Content[i].Value, inputs.Content[i+1]
				if !workflowDispatchInputName.MatchString(name) || !workflowDispatchInputFields(n, "type", "description", "required", "default", "options") {
					return fail()
				}
				foldedName := strings.ToLower(name)
				if seenNames[foldedName] {
					return fail()
				}
				seenNames[foldedName] = true
				definition := workflowDispatchInputDefinition{Name: name, Type: workflowDispatchString}
				if kind := workflowField(n, "type"); kind != nil {
					if kind.Kind != yaml.ScalarNode || kind.Tag != "!!str" {
						return fail()
					}
					definition.Type = workflowDispatchInputType(kind.Value)
				}
				switch definition.Type {
				case workflowDispatchString, workflowDispatchBoolean, workflowDispatchNumber, workflowDispatchChoice:
				default:
					return fail() // environment needs a real qualified release gate.
				}
				if description := workflowField(n, "description"); description != nil {
					if description.Kind != yaml.ScalarNode || description.Tag != "!!str" || !workflowDispatchInputText(description.Value, 1024) {
						return fail()
					}
					if strings.Contains(description.Value, "${{") {
						return fail()
					}
					definition.Description = description.Value
				}
				if required := workflowField(n, "required"); required != nil {
					if required.Kind != yaml.ScalarNode || required.Tag != "!!bool" || (required.Value != "true" && required.Value != "false") {
						return fail()
					}
					definition.Required = required.Value == "true"
				}
				if options := workflowField(n, "options"); options != nil {
					if definition.Type != workflowDispatchChoice || options.Kind != yaml.SequenceNode || len(options.Content) < 1 || len(options.Content) > 25 {
						return fail()
					}
					for _, option := range options.Content {
						if option.Kind != yaml.ScalarNode || option.Tag != "!!str" || strings.TrimSpace(option.Value) == "" || !workflowDispatchInputText(option.Value, maxWorkflowDispatchInputBytes) || slices.Contains(definition.Options, option.Value) || strings.Contains(option.Value, "${{") {
							return fail()
						}
						definition.Options = append(definition.Options, option.Value)
					}
				}
				if definition.Type == workflowDispatchChoice && len(definition.Options) == 0 {
					return fail()
				}
				if value := workflowField(n, "default"); value != nil {
					if strings.Contains(value.Value, "${{") {
						return fail()
					}
					candidate := workflowDispatchInputValue{Name: name, Type: definition.Type}
					if value.Kind != yaml.ScalarNode {
						return fail()
					}
					switch definition.Type {
					case workflowDispatchString, workflowDispatchChoice:
						if value.Tag != "!!str" {
							return fail()
						}
						candidate.String = value.Value
					case workflowDispatchBoolean:
						if value.Tag != "!!bool" || (value.Value != "true" && value.Value != "false") {
							return fail()
						}
						candidate.Boolean = value.Value == "true"
					case workflowDispatchNumber:
						if value.Tag != "!!int" && value.Tag != "!!float" {
							return fail()
						}
						candidate.Number = value.Value
					}
					canonical, e := canonicalWorkflowDispatchInput(definition, candidate)
					if e != nil {
						return fail()
					}
					definition.Default = &canonical
				}
				schema.Definitions = append(schema.Definitions, definition)
			}
		}
	}
	sort.Slice(schema.Definitions, func(i, j int) bool { return schema.Definitions[i].Name < schema.Definitions[j].Name })
	schema.SHA256 = workflowDispatchDigest("golf.workflow.dispatch.schema.v1", schema.Definitions)
	return schema, nil
}

// Number semantics deliberately convert JSON decimals to binary64 before canonical
// JSON encoding (e.g. 0.10000000000000001 becomes 0.1); this is not exact decimal
// arithmetic. Negative zero deliberately canonicalizes to zero.
// Unsafe integral values and nonzero underflow are refused rather than silently
// losing an integer identity or changing a supplied number into zero.
func canonicalWorkflowDispatchNumber(value string) (string, error) {
	if len(value) > 64 || !workflowDispatchJSONNumber.MatchString(value) {
		return "", errWorkflowDispatchInputValues
	}
	// Bound exponent work before big.Rat can allocate arbitrary powers of ten.
	if index := strings.IndexAny(value, "eE"); index >= 0 {
		exponent, err := strconv.ParseInt(value[index+1:], 10, 32)
		if err != nil || exponent < -1024 || exponent > 1024 {
			return "", errWorkflowDispatchInputValues
		}
	}
	rational, ok := new(big.Rat).SetString(value)
	if !ok || rational.IsInt() && new(big.Int).Abs(rational.Num()).Cmp(big.NewInt(9007199254740991)) > 0 {
		return "", errWorkflowDispatchInputValues
	}
	number, e := strconv.ParseFloat(value, 64)
	if e != nil || math.IsInf(number, 0) || math.IsNaN(number) || math.Abs(number) > 9007199254740991 || number == 0 && rational.Sign() != 0 {
		return "", errWorkflowDispatchInputValues
	}
	if number == 0 {
		number = 0
	} // canonicalize negative zero.
	body, e := json.Marshal(number)
	if e != nil {
		return "", errWorkflowDispatchInputValues
	}
	return string(body), nil
}
func canonicalWorkflowDispatchInput(definition workflowDispatchInputDefinition, value workflowDispatchInputValue) (workflowDispatchInputValue, error) {
	if value.Name != definition.Name || value.Type != definition.Type {
		return workflowDispatchInputValue{}, errWorkflowDispatchInputValues
	}
	switch definition.Type {
	case workflowDispatchString, workflowDispatchChoice:
		if value.Boolean || value.Number != "" || !workflowDispatchInputText(value.String, maxWorkflowDispatchInputBytes) || definition.Type == workflowDispatchChoice && !slices.Contains(definition.Options, value.String) {
			return workflowDispatchInputValue{}, errWorkflowDispatchInputValues
		}
	case workflowDispatchBoolean:
		if value.String != "" || value.Number != "" {
			return workflowDispatchInputValue{}, errWorkflowDispatchInputValues
		}
	case workflowDispatchNumber:
		if value.String != "" || value.Boolean {
			return workflowDispatchInputValue{}, errWorkflowDispatchInputValues
		}
		number, e := canonicalWorkflowDispatchNumber(value.Number)
		if e != nil {
			return workflowDispatchInputValue{}, e
		}
		value.Number = number
	default:
		return workflowDispatchInputValue{}, errWorkflowDispatchInputValues
	}
	return value, nil
}
func workflowDispatchDigest(domain string, value any) string {
	body, _ := json.Marshal(value)
	sum := sha256.Sum256(append([]byte(domain+"\x00"), body...))
	return hex.EncodeToString(sum[:])
}

// Only a parser-produced schema with its unchanged digest is accepted. Returned
// maps are sorted, independent copies. Required checks presence, not truthiness.
// Optional missing strings/booleans become empty/false. Optional missing number
// or choice without a default is refused: no invented zero/first-option behavior.
// Both submitted and effective canonical JSON are capped, including JSON escaping.
// Nothing here stores values, evaluates expressions, logs them, or admits a run.
func validateWorkflowDispatchInputs(schema workflowDispatchInputSchema, submitted []workflowDispatchInputValue) (workflowDispatchInputValues, error) {
	fail := func() (workflowDispatchInputValues, error) {
		return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
	}
	if len(schema.Definitions) > maxWorkflowDispatchInputs || schema.SHA256 == "" || workflowDispatchDigest("golf.workflow.dispatch.schema.v1", schema.Definitions) != schema.SHA256 || len(submitted) > maxWorkflowDispatchInputs {
		return fail()
	}
	definitions := map[string]workflowDispatchInputDefinition{}
	seenNames := map[string]bool{}
	for _, definition := range schema.Definitions {
		if !workflowDispatchInputName.MatchString(definition.Name) {
			return fail()
		}
		if seenNames[strings.ToLower(definition.Name)] {
			return fail()
		}
		seenNames[strings.ToLower(definition.Name)] = true
		definitions[definition.Name] = definition
	}
	values := map[string]workflowDispatchInputValue{}
	result := workflowDispatchInputValues{Submitted: []workflowDispatchInputValue{}, Effective: []workflowDispatchInputValue{}}
	for _, value := range submitted {
		definition, exists := definitions[value.Name]
		if !exists {
			return fail()
		}
		if _, duplicate := values[value.Name]; duplicate {
			return fail()
		}
		canonical, e := canonicalWorkflowDispatchInput(definition, value)
		if e != nil {
			return fail()
		}
		values[value.Name] = canonical
		result.Submitted = append(result.Submitted, canonical)
	}
	for _, definition := range schema.Definitions {
		value, present := values[definition.Name]
		if !present {
			switch {
			case definition.Default != nil:
				value = *definition.Default
			case definition.Required:
				return fail()
			case definition.Type == workflowDispatchString || definition.Type == workflowDispatchBoolean:
				value = workflowDispatchInputValue{Name: definition.Name, Type: definition.Type}
			default:
				return fail()
			}
		}
		canonical, e := canonicalWorkflowDispatchInput(definition, value)
		if e != nil {
			return fail()
		}
		result.Effective = append(result.Effective, canonical)
	}
	sort.Slice(result.Submitted, func(i, j int) bool { return result.Submitted[i].Name < result.Submitted[j].Name })
	sort.Slice(result.Effective, func(i, j int) bool { return result.Effective[i].Name < result.Effective[j].Name })
	for _, values := range [][]workflowDispatchInputValue{result.Submitted, result.Effective} {
		body, e := json.Marshal(values)
		if e != nil || len(body) > maxWorkflowDispatchInputsBytes {
			return fail()
		}
	}
	result.SubmittedSHA256 = workflowDispatchDigest("golf.workflow.dispatch.inputs.v1", result.Submitted)
	result.EffectiveSHA256 = workflowDispatchDigest("golf.workflow.dispatch.inputs.v1", result.Effective)
	return result, nil
}
