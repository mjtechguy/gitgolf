package actionsengine

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"
)

// This is deliberately a refusal proof, not a substitute execution of Requests.
// The archive is constructed in memory; no source command or dependency fetch runs.
func TestPinnedRequestsLintRefusal(t *testing.T) {
	body, err := os.ReadFile("../../docs/compatibility/fixtures/requests-lint.yml")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != "2adbd62821e06ee622aff3e1e6e283a9cf3e2dcf694a04040b43fd4291d96f99" {
		t.Fatal("unchanged upstream fixture drift")
	}
	input := testInput(t, string(body), nil)
	input.Event, input.Ref = "push", "refs/heads/main"
	input.Images = map[string]string{"ubuntu-24.04": "example/runtime@sha256:" + strings.Repeat("b", 64)}
	plan, err := Plan(input)
	if !errors.Is(err, ErrProfile) || len(plan.Jobs) != 0 {
		t.Fatal("unsupported unchanged source returned partial executable plan", err)
	}
}

func TestGiteaWorkflowPlanBinding(t *testing.T) {
	input := testInputAtPath(t, ".gitea/workflows/graph.yml", "on: [workflow_dispatch, push]\njobs:\n  check:\n    runs-on: linux\n    steps:\n      - run: echo owned\n", nil)
	for _, event := range []string{"workflow_dispatch", "push"} {
		input.Event = event
		if event == "push" {
			input.Ref = "refs/heads/main"
		}
		plan, err := Plan(input)
		if err != nil || plan.WorkflowPath != input.WorkflowPath || plan.WorkflowBlobID != input.WorkflowBlobID || plan.Event != event || len(plan.Jobs) != 1 {
			t.Fatal("native path changed admission binding", err)
		}
	}
}
