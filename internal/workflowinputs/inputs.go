// Package workflowinputs defines the bounded typed manual-dispatch input contract.
package workflowinputs

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

	"go.yaml.in/yaml/v3"
)

const (
	maxSourceBytes = 64 << 10
	MaxCount       = 25
	MaxValueBytes  = 2048
	MaxMapBytes    = 8 << 10
)

// These fixed errors must not include private submitted/default values.
var (
	ErrDeclaration = errors.New("Workflow dispatch input declarations are unsupported or malformed.")
	ErrValues      = errors.New("Workflow dispatch inputs are missing, unsupported or outside their declared bounds.")
	inputName      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)
	jsonNumber     = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)
)

type Type string

const (
	String  Type = "string"
	Boolean Type = "boolean"
	Number  Type = "number"
	Choice  Type = "choice"
)

// Type is explicit: an empty string, false and zero still represent presence.
// The future wire adapter must preserve its oneof and reject unknown fields.
type Value struct {
	Name    string `json:"name"`
	Type    Type   `json:"type"`
	String  string `json:"string,omitempty"`
	Boolean bool   `json:"boolean,omitempty"`
	Number  string `json:"number,omitempty"`
}
type Definition struct {
	Name        string   `json:"name"`
	Type        Type     `json:"type"`
	Description string   `json:"description,omitempty"`
	Required    bool     `json:"required"`
	Default     *Value   `json:"default,omitempty"`
	Options     []string `json:"options,omitempty"`
}
type Schema struct {
	Definitions []Definition
	SHA256      string
}
type Values struct {
	Submitted, Effective             []Value
	SubmittedSHA256, EffectiveSHA256 string
}

func text(s string, limit int) bool {
	return len(s) <= limit && utf8.ValidString(s) && strings.IndexFunc(s, func(r rune) bool {
		return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t'
	}) == -1
}
func fields(n *yaml.Node, allowed ...string) bool {
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
// expression. Document and traversal bounds are independent of execution admission.
func Parse(data []byte) (Schema, error) {
	fail := func() (Schema, error) {
		return Schema{}, ErrDeclaration
	}
	if len(data) > maxSourceBytes || !text(string(data), maxSourceBytes) {
		return fail()
	}
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	var doc, extra yaml.Node
	if decoder.Decode(&doc) != nil || len(doc.Content) != 1 || decoder.Decode(&extra) != io.EOF {
		return fail()
	}
	count := 0
	if !safeYAML(&doc, 0, &count) {
		return fail()
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode || len(root.Content) == 0 {
		return fail()
	}
	on := field(root, "on")
	var declaration *yaml.Node
	switch {
	case on != nil && on.Kind == yaml.ScalarNode && on.Tag == "!!str" && on.Value == "workflow_dispatch":
	case on != nil && on.Kind == yaml.MappingNode:
		declaration = field(on, "workflow_dispatch")
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
	schema := Schema{Definitions: []Definition{}}
	if declaration != nil && declaration.Tag != "!!null" {
		if !fields(declaration, "inputs") {
			return fail()
		}
		inputs := field(declaration, "inputs")
		if inputs != nil {
			if inputs.Kind != yaml.MappingNode || len(inputs.Content) > 2*MaxCount {
				return fail()
			}
			// Pinned act resolves map properties case-insensitively. Refuse
			// colliding names rather than let map iteration pick an input.
			seenNames := map[string]bool{}
			for i := 0; i < len(inputs.Content); i += 2 {
				name, n := inputs.Content[i].Value, inputs.Content[i+1]
				if !inputName.MatchString(name) || !fields(n, "type", "description", "required", "default", "options") {
					return fail()
				}
				foldedName := strings.ToLower(name)
				if seenNames[foldedName] {
					return fail()
				}
				seenNames[foldedName] = true
				definition := Definition{Name: name, Type: String}
				if kind := field(n, "type"); kind != nil {
					if kind.Kind != yaml.ScalarNode || kind.Tag != "!!str" {
						return fail()
					}
					definition.Type = Type(kind.Value)
				}
				switch definition.Type {
				case String, Boolean, Number, Choice:
				default:
					return fail() // environment needs a real qualified release gate.
				}
				if description := field(n, "description"); description != nil {
					if description.Kind != yaml.ScalarNode || description.Tag != "!!str" || !text(description.Value, 1024) {
						return fail()
					}
					if strings.Contains(description.Value, "${{") {
						return fail()
					}
					definition.Description = description.Value
				}
				if required := field(n, "required"); required != nil {
					if required.Kind != yaml.ScalarNode || required.Tag != "!!bool" || (required.Value != "true" && required.Value != "false") {
						return fail()
					}
					definition.Required = required.Value == "true"
				}
				if options := field(n, "options"); options != nil {
					if definition.Type != Choice || options.Kind != yaml.SequenceNode || len(options.Content) < 1 || len(options.Content) > 25 {
						return fail()
					}
					for _, option := range options.Content {
						if option.Kind != yaml.ScalarNode || option.Tag != "!!str" || strings.TrimSpace(option.Value) == "" || !text(option.Value, MaxValueBytes) || slices.Contains(definition.Options, option.Value) || strings.Contains(option.Value, "${{") {
							return fail()
						}
						definition.Options = append(definition.Options, option.Value)
					}
				}
				if definition.Type == Choice && len(definition.Options) == 0 {
					return fail()
				}
				if value := field(n, "default"); value != nil {
					if strings.Contains(value.Value, "${{") {
						return fail()
					}
					candidate := Value{Name: name, Type: definition.Type}
					if value.Kind != yaml.ScalarNode {
						return fail()
					}
					switch definition.Type {
					case String, Choice:
						if value.Tag != "!!str" {
							return fail()
						}
						candidate.String = value.Value
					case Boolean:
						if value.Tag != "!!bool" || (value.Value != "true" && value.Value != "false") {
							return fail()
						}
						candidate.Boolean = value.Value == "true"
					case Number:
						if value.Tag != "!!int" && value.Tag != "!!float" {
							return fail()
						}
						candidate.Number = value.Value
					}
					canonical, e := canonicalValue(definition, candidate)
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
	schema.SHA256 = Digest("golf.workflow.dispatch.schema.v1", schema.Definitions)
	return schema, nil
}

// Number semantics deliberately convert JSON decimals to binary64 before canonical
// JSON encoding (e.g. 0.10000000000000001 becomes 0.1); this is not exact decimal
// arithmetic. Negative zero deliberately canonicalizes to zero.
// Unsafe integral values and nonzero underflow are refused rather than silently
// losing an integer identity or changing a supplied number into zero.
func CanonicalNumber(value string) (string, error) {
	if len(value) > 64 || !jsonNumber.MatchString(value) {
		return "", ErrValues
	}
	// Bound exponent work before big.Rat can allocate arbitrary powers of ten.
	if index := strings.IndexAny(value, "eE"); index >= 0 {
		exponent, err := strconv.ParseInt(value[index+1:], 10, 32)
		if err != nil || exponent < -1024 || exponent > 1024 {
			return "", ErrValues
		}
	}
	rational, ok := new(big.Rat).SetString(value)
	if !ok || rational.IsInt() && new(big.Int).Abs(rational.Num()).Cmp(big.NewInt(9007199254740991)) > 0 {
		return "", ErrValues
	}
	number, e := strconv.ParseFloat(value, 64)
	if e != nil || math.IsInf(number, 0) || math.IsNaN(number) || math.Abs(number) > 9007199254740991 || number == 0 && rational.Sign() != 0 {
		return "", ErrValues
	}
	if number == 0 {
		number = 0
	} // canonicalize negative zero.
	body, e := json.Marshal(number)
	if e != nil {
		return "", ErrValues
	}
	return string(body), nil
}
func canonicalValue(definition Definition, value Value) (Value, error) {
	if value.Name != definition.Name || value.Type != definition.Type {
		return Value{}, ErrValues
	}
	switch definition.Type {
	case String, Choice:
		if value.Boolean || value.Number != "" || !text(value.String, MaxValueBytes) || definition.Type == Choice && !slices.Contains(definition.Options, value.String) {
			return Value{}, ErrValues
		}
	case Boolean:
		if value.String != "" || value.Number != "" {
			return Value{}, ErrValues
		}
	case Number:
		if value.String != "" || value.Boolean {
			return Value{}, ErrValues
		}
		number, e := CanonicalNumber(value.Number)
		if e != nil {
			return Value{}, e
		}
		value.Number = number
	default:
		return Value{}, ErrValues
	}
	return value, nil
}
func Digest(domain string, value any) string {
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
func Validate(schema Schema, submitted []Value) (Values, error) {
	fail := func() (Values, error) {
		return Values{}, ErrValues
	}
	if len(schema.Definitions) > MaxCount || schema.SHA256 == "" || Digest("golf.workflow.dispatch.schema.v1", schema.Definitions) != schema.SHA256 || len(submitted) > MaxCount {
		return fail()
	}
	definitions := map[string]Definition{}
	seenNames := map[string]bool{}
	for _, definition := range schema.Definitions {
		if !inputName.MatchString(definition.Name) {
			return fail()
		}
		if seenNames[strings.ToLower(definition.Name)] {
			return fail()
		}
		seenNames[strings.ToLower(definition.Name)] = true
		definitions[definition.Name] = definition
	}
	values := map[string]Value{}
	result := Values{Submitted: []Value{}, Effective: []Value{}}
	for _, value := range submitted {
		definition, exists := definitions[value.Name]
		if !exists {
			return fail()
		}
		if _, duplicate := values[value.Name]; duplicate {
			return fail()
		}
		canonical, e := canonicalValue(definition, value)
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
			case definition.Type == String || definition.Type == Boolean:
				value = Value{Name: definition.Name, Type: definition.Type}
			default:
				return fail()
			}
		}
		canonical, e := canonicalValue(definition, value)
		if e != nil {
			return fail()
		}
		result.Effective = append(result.Effective, canonical)
	}
	sort.Slice(result.Submitted, func(i, j int) bool { return result.Submitted[i].Name < result.Submitted[j].Name })
	sort.Slice(result.Effective, func(i, j int) bool { return result.Effective[i].Name < result.Effective[j].Name })
	for _, values := range [][]Value{result.Submitted, result.Effective} {
		body, e := json.Marshal(values)
		if e != nil || len(body) > MaxMapBytes {
			return fail()
		}
	}
	result.SubmittedSHA256 = Digest("golf.workflow.dispatch.inputs.v1", result.Submitted)
	result.EffectiveSHA256 = Digest("golf.workflow.dispatch.inputs.v1", result.Effective)
	return result, nil
}

// Decoding never expands aliases. Expressions outside input declarations are
// left intact; the execution consumer separately admits/evaluates its catalog.
func safeYAML(node *yaml.Node, depth int, count *int) bool {
	*count++
	if depth > 32 || *count > 4096 || node.Kind == yaml.AliasNode || node.Anchor != "" || node.Style&yaml.TaggedStyle != 0 || node.Tag == "!!merge" || !text(node.Value, maxSourceBytes) {
		return false
	}
	if node.Kind == yaml.MappingNode {
		if len(node.Content)%2 != 0 {
			return false
		}
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || strings.TrimSpace(key.Value) == "" || seen[key.Value] {
				return false
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if !safeYAML(child, depth+1, count) {
			return false
		}
	}
	return true
}
func field(node *yaml.Node, name string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i < len(node.Content); i += 2 {
		if node.Content[i].Value == name {
			return node.Content[i+1]
		}
	}
	return nil
}
