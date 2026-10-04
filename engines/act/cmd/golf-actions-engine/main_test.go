package main

import (
	"bytes"
	"errors"
	engine "github.com/mjtechguy/golf-git/engines/act"
	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"strings"
	"testing"
)

func TestHelperReportsOnlyClosedExecutionDiagnostic(t *testing.T) {
	// Invoke an actual pre-Docker refusal, not a manufactured execution error.
	t.Setenv("DOCKER_HOST", "private native endpoint")
	err := engine.Execute(t.Context(), protocol.ActionExecutionInput{}, func(protocol.ActionFrame) error { t.Fatal("invalid input emitted a frame"); return nil })
	var output bytes.Buffer
	if reportFailure(&output, err) != 1 || output.String() != protocol.ActionsEngineFailureDiagnostic("engine_input_validation") {
		t.Fatal("helper did not serialize the exact fixed diagnostic")
	}
	output.Reset()
	if reportFailure(&output, errors.New("private path/source/credential")) != 1 || strings.Contains(output.String(), "credential") || strings.Contains(output.String(), "GOLF_ACTIONS_FAILURE_STAGE") {
		t.Fatal("unclassified native error leaked or was attributed")
	}
	for _, tc := range []struct {
		err   error
		exit  int
		fixed string
	}{{engine.ErrEvent, 2, "Actions event not matched.\n"}, {engine.ErrProfile, 3, "Actions source is outside the selected profile.\n"}} {
		output.Reset()
		if reportFailure(&output, tc.err) != tc.exit || output.String() != tc.fixed {
			t.Fatal("planning exit contract changed")
		}
	}
}
