package server

import (
	"bytes"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"go.yaml.in/yaml/v3"
)

var issueFormID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var issueFormLanguage = regexp.MustCompile(`^[a-zA-Z0-9_+.-]{1,40}$`)

// Native issue creation still owns the submitted Markdown. This parser supplies
// a bounded form consumer, never executes YAML or silently skips unknown inputs.
func yamlIssueTemplate(entry sourceEntry, text string) (*golfv1.IssueTemplate, error) {
	if len(text) > 6000 || !discussionText(text, 6000) {
		return nil, errForgeResponseTooLarge
	}
	var tree yaml.Node
	if e := yaml.Unmarshal([]byte(text), &tree); e != nil {
		return nil, errInvalidForgeResponse
	}
	var safe func(*yaml.Node, int) bool
	safe = func(n *yaml.Node, depth int) bool {
		if depth > 12 || n.Kind == yaml.AliasNode || n.Anchor != "" {
			return false
		}
		for _, c := range n.Content {
			if !safe(c, depth+1) {
				return false
			}
		}
		return true
	}
	if !safe(&tree, 0) {
		return nil, errInvalidForgeResponse
	}
	var doc struct {
		Name        string    `yaml:"name"`
		Description string    `yaml:"description"`
		About       string    `yaml:"about"`
		Title       string    `yaml:"title"`
		Labels      yaml.Node `yaml:"labels"`
		Assignees   yaml.Node `yaml:"assignees"`
		Projects    yaml.Node `yaml:"projects"`
		Body        []struct {
			Type       string `yaml:"type"`
			ID         string `yaml:"id"`
			Attributes struct {
				Label       string      `yaml:"label"`
				Description string      `yaml:"description"`
				Placeholder string      `yaml:"placeholder"`
				Value       string      `yaml:"value"`
				Render      string      `yaml:"render"`
				Multiple    bool        `yaml:"multiple"`
				Options     []yaml.Node `yaml:"options"`
				Default     *uint32     `yaml:"default"`
			} `yaml:"attributes"`
			Validations struct {
				Required  bool   `yaml:"required"`
				MinLength uint32 `yaml:"min_length"`
			} `yaml:"validations"`
		} `yaml:"body"`
	}
	decoder := yaml.NewDecoder(strings.NewReader(text))
	decoder.KnownFields(true)
	if e := decoder.Decode(&doc); e != nil {
		return nil, errInvalidForgeResponse
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errInvalidForgeResponse
	}
	about := doc.Description
	if about == "" {
		about = doc.About
	}
	if !discussionMetadataName(doc.Name) || !discussionText(about, 1024) || !discussionText(doc.Title, 255) || strings.TrimSpace(doc.Title) != doc.Title || len(doc.Body) == 0 || len(doc.Body) > 30 {
		return nil, errInvalidForgeResponse
	}
	out := &golfv1.IssueTemplate{Path: entry.Path, Name: doc.Name, About: about, Title: doc.Title, BlobId: entry.SHA}
	seen := map[string]bool{}
	inputs := 0
	for index, v := range doc.Body {
		f := &golfv1.IssueFormField{Id: v.ID, Type: v.Type, Label: v.Attributes.Label, Description: v.Attributes.Description, Placeholder: v.Attributes.Placeholder, Value: v.Attributes.Value, Required: v.Validations.Required, Multiple: v.Attributes.Multiple, Render: v.Attributes.Render, MinLength: v.Validations.MinLength, DefaultOption: v.Attributes.Default}
		if f.Id == "" {
			f.Id = "field_" + strconv.Itoa(index)
		}
		if !issueFormID.MatchString(f.Id) || seen[f.Id] {
			return nil, errInvalidForgeResponse
		}
		seen[f.Id] = true
		if !discussionText(f.Description, 1024) || !discussionText(f.Placeholder, 1024) || !discussionText(f.Value, 6000) || f.MinLength > 6000 {
			return nil, errInvalidForgeResponse
		}
		if f.Type == "markdown" {
			if f.Value == "" || f.Label != "" || f.Required || len(v.Attributes.Options) > 0 || f.Multiple || f.Render != "" || f.DefaultOption != nil || f.MinLength != 0 {
				return nil, errInvalidForgeResponse
			}
			out.Fields = append(out.Fields, f)
			continue
		}
		inputs++
		if !discussionMetadataName(f.Label) {
			return nil, errInvalidForgeResponse
		}
		switch f.Type {
		case "input", "textarea":
			if len(v.Attributes.Options) > 0 || f.Multiple || f.DefaultOption != nil || f.Type == "input" && strings.ContainsAny(f.Value, "\r\n") {
				return nil, errInvalidForgeResponse
			}
			if f.Render != "" && (f.Type != "textarea" || !issueFormLanguage.MatchString(f.Render)) {
				return nil, errInvalidForgeResponse
			}
		case "dropdown", "checkboxes":
			if len(v.Attributes.Options) == 0 || len(v.Attributes.Options) > 50 || f.Value != "" || f.Placeholder != "" || f.Render != "" || f.MinLength != 0 {
				return nil, errInvalidForgeResponse
			}
			if f.Type == "checkboxes" && (f.Multiple || f.DefaultOption != nil) {
				return nil, errInvalidForgeResponse
			}
			labels := map[string]bool{}
			for _, option := range v.Attributes.Options {
				var o golfv1.IssueFormOption
				if f.Type == "dropdown" {
					if option.Kind != yaml.ScalarNode || option.Tag != "!!str" {
						return nil, errInvalidForgeResponse
					}
					o.Label = option.Value
				} else {
					var typed struct {
						Label    string `yaml:"label"`
						Required bool   `yaml:"required"`
					}
					var b bytes.Buffer
					if yaml.NewEncoder(&b).Encode(&option) != nil {
						return nil, errInvalidForgeResponse
					}
					d := yaml.NewDecoder(&b)
					d.KnownFields(true)
					if d.Decode(&typed) != nil {
						return nil, errInvalidForgeResponse
					}
					o.Label, o.Required = typed.Label, typed.Required
				}
				if !discussionText(o.Label, 1024) || strings.TrimSpace(o.Label) == "" || labels[o.Label] {
					return nil, errInvalidForgeResponse
				}
				labels[o.Label] = true
				f.Options = append(f.Options, &o)
			}
			if f.DefaultOption != nil && int(*f.DefaultOption) >= len(f.Options) {
				return nil, errInvalidForgeResponse
			}
		default:
			return nil, errInvalidForgeResponse
		}
		out.Fields = append(out.Fields, f)
	}
	if inputs == 0 {
		return nil, errInvalidForgeResponse
	}
	return out, nil
}
func issueTemplate(entry sourceEntry, text string) (*golfv1.IssueTemplate, error) {
	if strings.EqualFold(path.Ext(entry.Name), ".md") {
		return markdownIssueTemplate(entry, text)
	}
	return yamlIssueTemplate(entry, text)
}
