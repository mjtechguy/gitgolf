package server

import (
	"strings"
	"testing"
)

const usefulIssueForm = `name: Bug report
description: Reproduce a problem
title: '[Bug]'
body:
  - type: markdown
    attributes:
      value: Please describe the problem.
  - type: input
    id: version
    attributes:
      label: Version
      placeholder: 1.2.3
    validations:
      required: true
      min_length: 3
  - type: textarea
    id: logs
    attributes:
      label: Logs
      render: shell
  - type: dropdown
    id: platform
    attributes:
      label: Platform
      options: [Linux, macOS]
      default: 0
    validations:
      required: true
  - type: checkboxes
    id: agreement
    attributes:
      label: Agreement
      options:
        - label: I checked existing issues.
          required: true
`

func TestYAMLIssueFormBoundaries(t *testing.T) {
	entry := sourceEntry{Name: "bug.yml", Path: ".github/ISSUE_TEMPLATE/bug.yml", SHA: strings.Repeat("a", 40)}
	out, e := yamlIssueTemplate(entry, usefulIssueForm)
	if e != nil || len(out.Fields) != 5 || out.Fields[3].GetDefaultOption() != 0 || !out.Fields[4].Options[0].Required || !out.Fields[1].Required || out.Fields[1].MinLength != 3 {
		t.Fatal("useful form rejected", e)
	}
	for _, bad := range []string{strings.Replace(usefulIssueForm, "type: textarea", "type: upload", 1), strings.Replace(usefulIssueForm, "id: logs", "id: version", 1), strings.Replace(usefulIssueForm, "default: 0", "default: 9", 1), strings.Replace(usefulIssueForm, "render: shell", "render: '`bad`'", 1), usefulIssueForm + "\n---\nname: ignored\n", strings.Replace(usefulIssueForm, "value: Please describe the problem.", "value: &x please", 1), strings.Replace(usefulIssueForm, "required: true", "unknown_validation: true", 1), strings.Replace(usefulIssueForm, "options: [Linux, macOS]", "options: [Linux, Linux]", 1), strings.Repeat("x", 6001)} {
		if _, e := yamlIssueTemplate(entry, bad); e == nil {
			t.Fatal("unsupported/invalid form silently accepted")
		}
	}
}
