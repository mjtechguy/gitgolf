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

func TestCompileWorkflowPushExecutionMatchingAndManualSeparation(t *testing.T) {
	actions := golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS
	gitlab := golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI
	for _, tc := range []struct {
		name, on, ref string
		match, manual bool
	}{
		{"plain", "on: push", "refs/heads/main", true, false},
		{"push list", "on: [push]", "refs/heads/main", true, false},
		{"manual list", "on: [workflow_dispatch]", "refs/heads/main", false, true},
		{"both list", "on: [push, workflow_dispatch]", "refs/heads/topic/one", true, true},
		{"reversed list", "on: [workflow_dispatch, push]", "refs/heads/main", true, true},
		{"list tag refused", "on: [push, workflow_dispatch]", "refs/tags/main", false, true},
		{"list invalid branch refused", "on: [push, workflow_dispatch]", "refs/heads/bad..name", false, true},
		{"null", "on:\n  push:", "refs/heads/main", true, false},
		{"empty", "on:\n  push: {}", "refs/heads/topic/one", true, false},
		{"exact", "on:\n  push:\n    branches: [main, topic/one]", "refs/heads/topic/one", true, false},
		{"case sensitive", "on:\n  push:\n    branches: [main]", "refs/heads/Main", false, false},
		{"not prefix", "on:\n  push:\n    branches: [main]", "refs/heads/main-next", false, false},
		{"not suffix", "on:\n  push:\n    branches: [main]", "refs/heads/topic/main", false, false},
		{"tag", "on: push", "refs/tags/main", false, false},
		{"other ref", "on: push", "refs/pull/1/head", false, false},
		{"short ref", "on: push", "main", false, false},
		{"invalid branch", "on: push", "refs/heads/../main", false, false},
		{"empty branch", "on: push", "refs/heads/", false, false},
		{"manual only", "on: workflow_dispatch", "refs/heads/main", false, true},
		{"both match", "on:\n  workflow_dispatch:\n  push:\n    branches: [main]", "refs/heads/main", true, true},
		{"both filtered", "on:\n  push:\n    branches: [main]\n  workflow_dispatch: {}", "refs/heads/other", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := []byte(strings.Replace(workflowActionsFixture, "on: workflow_dispatch", tc.on, 1))
			plan, matched, err := compileWorkflowPushExecution(actions, data, tc.ref)
			if err != nil || matched != tc.match || (plan != nil) != tc.match {
				t.Fatalf("push selection: matched=%t plan=%t err=%v", matched, plan != nil, err)
			}
			if plan != nil && (len(plan.Steps) != 1 || plan.Steps[0].Run != "echo untrusted-script" || plan.Steps[0].Shell != "sh") {
				t.Fatal("push changed the compiled shell plan")
			}
			manual, err := compileWorkflowExecution(actions, data)
			if tc.manual && (manual == nil || err != nil) || !tc.manual && (manual != nil || connect.CodeOf(err) != connect.CodeFailedPrecondition) {
				t.Fatal("push declaration changed manual eligibility")
			}
		})
	}
	data := []byte("check:\n  image: example/build@sha256:" + strings.Repeat("c", 64) + "\n  script: ['export VALUE=bound', 'test \"$VALUE\" = bound']\n")
	for _, ref := range []string{"refs/heads/main", "refs/heads/topic/one", "refs/tags/main", "main", "refs/heads/bad..name"} {
		plan, matched, err := compileWorkflowPushExecution(gitlab, data, ref)
		want := ref == "refs/heads/main" || ref == "refs/heads/topic/one"
		if err != nil || matched != want || (plan != nil) != want {
			t.Fatal("GitLab bounded branch-push mapping changed")
		}
		if plan != nil && (len(plan.Steps) != 1 || plan.Steps[0].Run != "export VALUE=bound\ntest \"$VALUE\" = bound" || plan.Steps[0].Shell != "sh") {
			t.Fatal("GitLab push must retain shared shell semantics")
		}
	}
}

func TestCompileWorkflowPushExecutionRejectsUnsupportedTriggers(t *testing.T) {
	for _, on := range []string{
		"on: []", "on: [push, push]", "on: [workflow_dispatch, workflow_dispatch]",
		"on: [push, workflow_dispatch, push]", "on: [push, pull_request]", "on: [push, schedule]",
		"on: [push, 42]", "on: [push, true]", "on: [push, null]", "on: [push, {workflow_dispatch: {}}]",
		"on: [push, ['workflow_dispatch']]", "on: [push, '${{ secrets.private }}']", "on: [Push]", "on: ['']", "on: pull_request",
		"on:\n  push: true", "on:\n  push: []", "on:\n  push: [main]",
		"on:\n  push:\n    branches: main", "on:\n  push:\n    branches: []",
		"on:\n  push:\n    branches: [main, main]", "on:\n  push:\n    branches: [42]",
		"on:\n  push:\n    branches: ['']", "on:\n  push:\n    branches: ['topic/**']",
		"on:\n  push:\n    branches: ['main?']", "on:\n  push:\n    branches: ['[ab]']",
		"on:\n  push:\n    branches: ['main+']", "on:\n  push:\n    branches: ['!main']",
		"on:\n  push:\n    branches: ['main\\+']", "on:\n  push:\n    branches: ['bad..name']",
		"on:\n  push:\n    branches: ['-main']", "on:\n  push:\n    branches: ['.hidden']",
		"on:\n  push:\n    branches: ['bad.lock']", "on:\n  push:\n    branches: ['bad//name']",
		"on:\n  push:\n    branches: [main]\n    paths: ['src/**']",
		"on:\n  push:\n    branches-ignore: [main]", "on:\n  push:\n    tags: [v1]",
		"on:\n  push:\n    paths-ignore: [README.md]", "on:\n  push:\n    types: [created]",
		"on:\n  push:\n    branches: ['${{ secrets.private }}']",
		"on:\n  push: {}\n  workflow_dispatch:\n    inputs: {token: {}}",
		"on:\n  push: {}\n  schedule: []", "on:\n  push: {}\n  pull_request: {}",
	} {
		data := []byte(strings.Replace(workflowActionsFixture, "on: workflow_dispatch", on, 1))
		// A nonmatching ref cannot turn unsupported syntax into a valid skip.
		for _, ref := range []string{"refs/heads/main", "refs/tags/main"} {
			plan, matched, err := compileWorkflowPushExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, data, ref)
			if plan != nil || matched || connect.CodeOf(err) != connect.CodeFailedPrecondition || strings.Contains(err.Error(), "secrets.private") {
				t.Fatalf("unsupported trigger produced a plan/skip or exposed source: %q", on)
			}
		}
		if plan, err := compileWorkflowExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, data); plan != nil || connect.CodeOf(err) != connect.CodeFailedPrecondition || strings.Contains(err.Error(), "secrets.private") {
			t.Fatal("unsupported declaration became manual authority or exposed source")
		}
	}
	gitlab := "check:\n  image: example/build@sha256:" + strings.Repeat("c", 64) + "\n  script: echo private-command\n"
	for _, extra := range []string{"  rules: [{if: '$CI_PIPELINE_SOURCE == \"push\"'}]\n", "  only: [branches]\n", "  except: [tags]\n", "  when: manual\n", "workflow:\n  rules: [{when: always}]\n", "include: local.yml\n"} {
		plan, matched, err := compileWorkflowPushExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI, []byte(gitlab+extra), "refs/heads/main")
		if plan != nil || matched || connect.CodeOf(err) != connect.CodeFailedPrecondition || strings.Contains(err.Error(), "private-command") {
			t.Fatal("GitLab policy syntax was silently treated as a push job")
		}
	}
}

func TestWorkflowEventListInspectionPreservesExplicitMetadata(t *testing.T) {
	for _, declaration := range []struct {
		source string
		events []string
	}{
		{"on: [push]", []string{"push"}},
		{"on: [workflow_dispatch]", []string{"workflow_dispatch"}},
		{"on: [push, workflow_dispatch]", []string{"push", "workflow_dispatch"}},
		{"on:\n  - workflow_dispatch\n  - push", []string{"workflow_dispatch", "push"}},
	} {
		config := &golfv1.WorkflowConfiguration{Format: golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS}
		inspectWorkflow(config, []byte(strings.Replace(workflowActionsFixture, "on: workflow_dispatch", declaration.source, 1)))
		if config.State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET || len(config.Diagnostics) != 0 || strings.Join(config.Events, ",") != strings.Join(declaration.events, ",") || len(config.Jobs) != 1 || strings.Contains(config.String(), "untrusted-script") {
			t.Fatal("event membership/order or private shell metadata changed")
		}
	}
}

func TestCompileWorkflowPushExecutionBranchBounds(t *testing.T) {
	for _, count := range []int{50, 51} {
		on := "on:\n  push:\n    branches:\n"
		for index := range count {
			on += "      - branch" + strings.Repeat("a", index+1) + "\n"
		}
		data := []byte(strings.Replace(workflowActionsFixture, "on: workflow_dispatch\n", on, 1))
		plan, matched, err := compileWorkflowPushExecution(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, data, "refs/heads/brancha")
		if count == 50 && (plan == nil || !matched || err != nil) || count == 51 && (plan != nil || matched || connect.CodeOf(err) != connect.CodeFailedPrecondition) {
			t.Fatal("exact branch count limit changed")
		}
	}
}
