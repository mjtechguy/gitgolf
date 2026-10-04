package server

import (
	"errors"
	"strings"
	"unicode"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"go.yaml.in/yaml/v3"
)

const workflowExecutionCatalog = "golf.workflow.shell.v1"

var errWorkflowExecutionUnsupported = errors.New("Workflow is outside the bounded Linux shell execution subset for this trigger.")

var errWorkflowTriggerNotMatched = errors.New("Workflow does not match the selected trigger.")

// Commands are private execution input, never an inspection response. Compilation
// does not admit a run, approve an image, or execute anything on the server host.
type workflowExecutionPlan struct {
	Actions     *runner.ActionPlan `json:",omitempty"`
	Format      golfv1.WorkflowFormat
	Name        string
	JobID       string
	JobName     string
	Stage       string
	RunnerLabel string
	ImageDigest string
	Steps       []workflowExecutionStep
}

type workflowExecutionStep struct {
	Name  string
	Run   string
	Shell string
}

func compileWorkflowExecution(format golfv1.WorkflowFormat, data []byte) (*workflowExecutionPlan, error) {
	plan, err := compileWorkflowForTrigger(format, data, false, "")
	if errors.Is(err, errWorkflowTriggerNotMatched) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
	}
	return plan, err
}

// Matching is compilation only. The caller must separately verify a nondeleted
// after-commit, immutable source, durable grant and current execution policy.
// Valid but nonmatching configurations return (nil, false, nil); unsupported
// configurations never produce a partial executable plan.
func compileWorkflowPushExecution(format golfv1.WorkflowFormat, data []byte, ref string) (*workflowExecutionPlan, bool, error) {
	plan, err := compileWorkflowForTrigger(format, data, true, ref)
	if errors.Is(err, errWorkflowTriggerNotMatched) {
		return nil, false, nil
	}
	return plan, plan != nil && err == nil, err
}

func compileWorkflowForTrigger(format golfv1.WorkflowFormat, data []byte, push bool, ref string) (*workflowExecutionPlan, error) {
	if format != golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS && format != golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
	}
	// The existing inspector is the single safe-YAML and field-catalog authority.
	// Do not extract or partly execute an unsupported configuration.
	config := &golfv1.WorkflowConfiguration{Format: format}
	inspectWorkflow(config, data)
	if config.State != golfv1.WorkflowInspectionState_WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
	}
	var document yaml.Node
	if err := yaml.NewDecoder(strings.NewReader(string(data))).Decode(&document); err != nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
	}
	root := document.Content[0]
	if push && (!strings.HasPrefix(ref, "refs/heads/") || !validRef(ref)) {
		return nil, errWorkflowTriggerNotMatched
	}
	if format == golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS {
		event := "workflow_dispatch"
		if push {
			event = "push"
		}
		on := workflowField(root, "on")
		declaration := workflowField(on, event)
		if !(workflowString(on) && on.Value == event) && declaration == nil {
			return nil, errWorkflowTriggerNotMatched
		}
		if push {
			if branches := workflowField(declaration, "branches"); branches != nil {
				matched := false
				for _, branch := range branches.Content {
					matched = matched || ref == "refs/heads/"+branch.Value
				}
				if !matched {
					return nil, errWorkflowTriggerNotMatched
				}
			}
		}
	}
	job := config.Jobs[0]
	if strings.IndexFunc(job.Id, unicode.IsControl) >= 0 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
	}
	plan := &workflowExecutionPlan{Format: format, Name: config.Name, JobID: job.Id, JobName: job.Name, Stage: job.Stage}
	if format == golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS {
		value := workflowField(root, "jobs").Content[1]
		plan.RunnerLabel = workflowField(value, "runs-on").Value
		switch plan.RunnerLabel {
		case "linux", "ubuntu-latest", "ubuntu-22.04", "ubuntu-24.04":
		default:
			return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
		}
		steps := workflowField(value, "steps")
		if len(steps.Content) > 50 {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
		}
		for _, step := range steps.Content {
			compiled := workflowExecutionStep{Run: workflowField(step, "run").Value, Shell: "default"}
			if name := workflowField(step, "name"); name != nil {
				compiled.Name = name.Value
			}
			if shell := workflowField(step, "shell"); shell != nil {
				compiled.Shell = shell.Value
			}
			plan.Steps = append(plan.Steps, compiled)
		}
	} else {
		value := workflowField(root, job.Id)
		plan.ImageDigest = workflowField(value, "image").Value
		script := workflowField(value, "script")
		commands := []string{script.Value}
		if script.Kind == yaml.SequenceNode {
			if len(script.Content) > 50 {
				return nil, connect.NewError(connect.CodeFailedPrecondition, errWorkflowExecutionUnsupported)
			}
			commands = nil
			for _, command := range script.Content {
				commands = append(commands, command.Value)
			}
		}
		// GitLab script entries share a shell context. Separate processes would
		// silently lose variables, cwd and shell functions between list items.
		plan.Steps = []workflowExecutionStep{{Name: job.Name, Run: strings.Join(commands, "\n"), Shell: "sh"}}
	}
	return plan, nil
}
