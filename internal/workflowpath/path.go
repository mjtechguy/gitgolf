// Package workflowpath defines the literal workflow locations supported by Golf.
package workflowpath

import (
	"errors"
	"strings"
)

const ForgejoDirectories = ".forgejo/workflows,.github/workflows"

const DefaultDirectories = ForgejoDirectories

// Directories preserves the operator's order. Custom locations remain unavailable
// until discovery, policy and worker contracts qualify them together.
func Directories(setting string) ([]string, error) {
	if setting == "" {
		setting = DefaultDirectories
	}
	seen := map[string]bool{}
	var result []string
	for _, part := range strings.Split(setting, ",") {
		dir := strings.TrimSpace(part)
		if (dir != ".forgejo/workflows" && dir != ".github/workflows") || seen[dir] {
			return nil, errors.New("GOLF_FORGE_WORKFLOW_DIRS supports only distinct .forgejo/workflows and .github/workflows directories in the selected order; custom locations are unsupported")
		}
		seen[dir] = true
		result = append(result, dir)
	}
	return result, nil
}

func Actions(value string) bool {
	if len(value) > 255 {
		return false
	}
	dir, name, found := strings.Cut(value, "/workflows/")
	if !found || (dir != ".forgejo" && dir != ".github") || name == "" || strings.Contains(name, "..") || (!strings.HasSuffix(name, ".yml") && !strings.HasSuffix(name, ".yaml")) {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}

func Valid(value string) bool { return value == ".gitlab-ci.yml" || Actions(value) }
