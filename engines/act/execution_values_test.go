package actionsengine

import (
	protocol "github.com/mjtechguy/golf-git/internal/runner"
	act "github.com/nektos/act/pkg/runner"
	"os"
	"testing"
)

func TestRepositoryEnvironmentReachesOnlyValidatedNativeJobConfig(t *testing.T) {
	t.Setenv("BUILD_CREDENTIAL", "controller-fixture")
	config := &act.Config{Env: map[string]string{"GITHUB_REF": "refs/heads/main", "SHA_REF": "fixture-object"}}
	values := &protocol.ExecutionEnvironment{Variables: map[string]string{"BUILD_REGION": "ordinary"}, Secrets: map[string]string{"BUILD_CREDENTIAL": "private-fixture"}}
	if e := applyRepositoryEnvironment(config, values); e != nil {
		t.Fatal(e)
	}
	if config.Env["BUILD_CREDENTIAL"] != "private-fixture" || config.Env["BUILD_REGION"] != "ordinary" || config.Env["GITHUB_REF"] != "refs/heads/main" || os.Getenv("BUILD_CREDENTIAL") != "controller-fixture" {
		t.Fatal("native job values or controller isolation lost")
	}
	invalid := &protocol.ExecutionEnvironment{Variables: map[string]string{"BUILD_NEW": "ordinary", "GITHUB_REF": "untrusted"}}
	if e := applyRepositoryEnvironment(config, invalid); e == nil {
		t.Fatal("reserved controller context admitted")
	}
	if _, exists := config.Env["BUILD_NEW"]; exists || config.Env["GITHUB_REF"] != "refs/heads/main" {
		t.Fatal("invalid envelope partially injected")
	}
}
