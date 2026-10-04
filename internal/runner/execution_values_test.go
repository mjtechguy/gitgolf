package runner

import (
	"strings"
	"testing"
)

func TestExecutionEnvironmentBoundary(t *testing.T) {
	for _, name := range []string{"PATH", "HOME", "BASH_ENV", "LD_PRELOAD", "GITHUB_TOKEN", "GOLF_ATTEMPT_TOKEN", "ACTIONS_RUNTIME_TOKEN", "RUNNER_TEMP", "DOCKER_HOST", "SSH_AUTH_SOCK", "NODE_OPTIONS", "HTTP_PROXY", "CI", "TMPDIR", "Mixed_CASE", "A-B", "1NAME"} {
		if ExecutionValueName(name) {
			t.Fatalf("unsafe name admitted: %s", name)
		}
	}
	env := ExecutionEnvironment{Variables: map[string]string{"DEPLOY_REGION": "test-only"}, Secrets: map[string]string{"BUILD_CREDENTIAL": "abcdefghijk"}}
	if env.Validate() != nil {
		t.Fatal("valid user environment refused")
	}
	env.Variables["BUILD_CREDENTIAL"] = "different"
	if env.Validate() == nil {
		t.Fatal("shared namespace collision admitted")
	}
	delete(env.Variables, "BUILD_CREDENTIAL")
	for _, body := range []string{"short", "abcdefgh\n", "abcdefgh\x00", string([]byte{0xff}), strings.Repeat("a", 8193)} {
		env.Secrets["BUILD_CREDENTIAL"] = body
		if env.Validate() == nil {
			t.Fatal("invalid secret body admitted")
		}
	}
	env.Secrets = map[string]string{}
	env.Variables = map[string]string{}
	for i := 0; i < 9; i++ {
		env.Variables["VALUE_"+string(rune('A'+i))] = strings.Repeat("x", 8192)
	}
	if env.Validate() == nil {
		t.Fatal("aggregate environment bound ignored")
	}
}
