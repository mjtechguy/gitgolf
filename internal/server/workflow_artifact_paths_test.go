package server

import (
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"strings"
	"testing"
)

func TestWorkflowArtifactDeclarations(t *testing.T) {
	base := "build:\n  image: example/build@sha256:" + strings.Repeat("b", 64) + "\n  script: mkdir -p dist; printf result > dist/result.txt\n"
	plan, err := compileWorkflowExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, []byte(base+"  artifacts:\n    paths: [dist]\n"))
	if err != nil || len(plan.ArtifactPaths) != 1 || plan.ArtifactPaths[0] != "dist" {
		t.Fatal("literal declaration refused", err)
	}
	for _, declaration := range []string{"paths: [../outside]", "paths: ['dist/*']", "paths: [dist, dist/a]", "paths: [dist]\n    when: always", "paths: [dist]\n    reports: {}", "paths: []", "paths: ['$HOME']", "paths: [dist, dist]", "paths: [123]"} {
		if _, err := compileWorkflowExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, []byte(base+"  artifacts:\n    "+declaration+"\n")); err == nil {
			t.Fatal("unsupported artifact declaration admitted")
		}
	}
}
