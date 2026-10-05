package server

import (
	"github.com/mjtechguy/golf-git/internal/runner"
	"go.yaml.in/yaml/v3"
)

func workflowArtifactPaths(node *yaml.Node) ([]string, error) {
	if node == nil || node.Kind != yaml.MappingNode || len(node.Content) != 2 || node.Content[0].Value != "paths" {
		return nil, runner.ErrArtifacts
	}
	paths := node.Content[1]
	if paths.Kind != yaml.SequenceNode {
		return nil, runner.ErrArtifacts
	}
	result := make([]string, 0, len(paths.Content))
	for _, value := range paths.Content {
		if !workflowString(value) {
			return nil, runner.ErrArtifacts
		}
		result = append(result, value.Value)
	}
	return result, runner.ValidateArtifactPaths(result)
}
