package server

import (
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestCompileWorkflowExecutionPreservesActionsStepBoundaries(t *testing.T) {
	data := []byte("name: Manual\non: workflow_dispatch\njobs:\n  check:\n    name: Check source\n    runs-on: ubuntu-24.04\n    steps:\n      - name: First\n        run: |\n          printf 'first\\n'\n          export LOCAL=step-only\n      - run: 'test -f source.txt'\n        shell: sh\n      - run: 'false | true'\n        shell: bash\n")
	plan, err := compileWorkflowExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, data)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Name != "Manual" || plan.JobID != "check" || plan.JobName != "Check source" || plan.RunnerLabel != "ubuntu-24.04" || plan.ImageDigest != "" || len(plan.Steps) != 3 {
		t.Fatal("compiled job metadata or independent step boundaries changed")
	}
	if plan.Steps[0].Name != "First" || plan.Steps[0].Run != "printf 'first\\n'\nexport LOCAL=step-only\n" || plan.Steps[0].Shell != "default" || plan.Steps[1].Run != "test -f source.txt" || plan.Steps[1].Shell != "sh" || plan.Steps[2].Run != "false | true" || plan.Steps[2].Shell != "bash" {
		t.Fatal("command text, shell distinction or ordered steps changed")
	}
	inspection := &golfv1.WorkflowConfiguration{Format: plan.Format}
	inspectWorkflow(inspection, data)
	if len(inspection.Jobs) != 1 || inspection.Jobs[0].StepCount != 3 || strings.Contains(inspection.String(), "step-only") {
		t.Fatal("private command text leaked into public inspection metadata")
	}
}

func TestCompileWorkflowExecutionGitLabSharedShell(t *testing.T) {
	image := "example.test/build@sha256:" + strings.Repeat("a", 64)
	for _, script := range []struct{ yaml, want string }{
		{"'printf single'", "printf single"},
		{"\n    - 'export LOCAL=value'\n    - 'test \"$LOCAL\" = value'\n    - |\n      printf 'done\\n'\n", "export LOCAL=value\ntest \"$LOCAL\" = value\nprintf 'done\\n'\n"},
	} {
		data := []byte("stages: [verify]\ncheck:\n  stage: verify\n  image: " + image + "\n  script: " + script.yaml + "\n")
		plan, err := compileWorkflowExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, data)
		if err != nil {
			t.Fatal(err)
		}
		if plan.Stage != "verify" || plan.JobID != "check" || plan.ImageDigest != image || plan.RunnerLabel != "" || len(plan.Steps) != 1 || plan.Steps[0].Run != script.want || plan.Steps[0].Shell != "sh" {
			t.Fatal("GitLab script must preserve order and shared shell state")
		}
	}
}

func TestCompileWorkflowExecutionRejectsWholeUnsupportedInput(t *testing.T) {
	actions := workflowActionsFixture
	gitlab := "check:\n  image: example/build@sha256:" + strings.Repeat("b", 64) + "\n  script: 'echo private-command-marker'\n"
	for _, tc := range []struct {
		name   string
		format golfv1.WorkflowFormat
		data   string
	}{
		{"unknown format", golfv1.WorkflowFormat_WORKFLOW_FORMAT_UNSPECIFIED, actions},
		{"future format", golfv1.WorkflowFormat(999), actions},
		{"event", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, strings.Replace(actions, "workflow_dispatch", "push", 1)},
		{"inputs", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, strings.Replace(actions, "on: workflow_dispatch", "on:\n  workflow_dispatch:\n    inputs:\n      token: {}", 1)},
		{"non-Linux", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, strings.Replace(actions, "runs-on: linux", "runs-on: windows-latest", 1)},
		{"unqualified label", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, strings.Replace(actions, "runs-on: linux", "runs-on: prod-admin", 1)},
		{"action dependency", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, strings.Replace(actions, "run: echo untrusted-script", "uses: actions/checkout@v6", 1)},
		{"continue after failure", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, actions + "        continue-on-error: true\n"},
		{"unknown policy", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, actions + "permissions: write-all\n"},
		{"expression", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, strings.Replace(actions, "echo untrusted-script", "echo ${{ secrets.private }}", 1)},
		{"alias", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, strings.Replace(actions, "run: echo untrusted-script", "run: &script echo untrusted-script", 1)},
		{"duplicate", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, actions + "name: duplicate\n"},
		{"multiple documents", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, actions + "---\nsecret: private-command-marker\n"},
		{"oversize", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, actions + strings.Repeat("#", maxWorkflowBytes)},
		{"invalid UTF8", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, actions + string([]byte{255})},
		{"control", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, actions + "\x00"},
		{"GitLab image not pinned", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, strings.Replace(gitlab, "@sha256:"+strings.Repeat("b", 64), ":latest", 1)},
		{"GitLab control job name", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, strings.Replace(gitlab, "check:", "\"bad\\njob\":", 1)},
		{"GitLab include", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, gitlab + "include: private.yml\n"},
		{"GitLab after_script", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, gitlab + "  after_script: echo cleanup\n"},
		{"GitLab inheritance", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, gitlab + "  extends: .template\n"},
		{"GitLab list nesting", golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, strings.Replace(gitlab, "'echo private-command-marker'", "[[echo nested]]", 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := compileWorkflowExecution(tc.format, []byte(tc.data))
			if plan != nil || connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Fatal("unsupported input produced a partial plan or incorrect denial")
			}
			if strings.Contains(err.Error(), "private-command-marker") || strings.Contains(err.Error(), "secrets.private") {
				t.Fatal("denial echoed private source")
			}
		})
	}
}

func TestCompileWorkflowExecutionStepBounds(t *testing.T) {
	for _, format := range []golfv1.WorkflowFormat{golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI} {
		for _, count := range []int{50, 51} {
			data := "on: workflow_dispatch\njobs:\n  check:\n    runs-on: linux\n    steps:\n" + strings.Repeat("      - run: echo bounded\n", count)
			if format == golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI {
				data = "check:\n  image: example/build@sha256:" + strings.Repeat("c", 64) + "\n  script:\n" + strings.Repeat("    - echo bounded\n", count)
			}
			plan, err := compileWorkflowExecution(format, []byte(data))
			if count == 50 && (plan == nil || err != nil) || count == 51 && (plan != nil || connect.CodeOf(err) != connect.CodeFailedPrecondition) {
				t.Fatal("execution step bound was not enforced")
			}
		}
	}
}
