package actionsengineproof

import (
	"bytes"
	"errors"
	"strings"

	"github.com/nektos/act/pkg/model"
	"gopkg.in/yaml.v3"
)

// This narrow qualification gate is NOT a production Actions policy/parser.
// Refuse before handing even an owned YAML document to engine expansion.
func runtimePlan(source, event string) (*model.Plan, error) {
	if len(source) == 0 || len(source) > 32<<10 || (event != "push" && event != "workflow_dispatch") {
		return nil, errors.New("qualification input bounds")
	}
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(source), &root); err != nil {
		return nil, errors.New("qualification YAML invalid")
	}
	nodes := 0
	var bounded func(*yaml.Node, int) bool
	bounded = func(n *yaml.Node, depth int) bool {
		nodes++
		if nodes > 2048 || depth > 16 || n.Kind == yaml.AliasNode || len(n.Value) > 4096 {
			return false
		}
		if n.Kind == yaml.MappingNode {
			seen := map[string]bool{}
			for i := 0; i < len(n.Content); i += 2 {
				k := n.Content[i]
				if k.Kind != yaml.ScalarNode || seen[k.Value] {
					return false
				}
				seen[k.Value] = true
			}
		}
		for _, child := range n.Content {
			if !bounded(child, depth+1) {
				return false
			}
		}
		return true
	}
	if !bounded(&root, 0) {
		return nil, errors.New("qualification YAML complexity")
	}
	if len(root.Content) != 1 || !allowedMapping(root.Content[0], "name", "on", "env", "defaults", "jobs") {
		return nil, errors.New("qualification root controls refused")
	}
	for i := 0; i < len(root.Content[0].Content); i += 2 {
		if root.Content[0].Content[i].Value != "jobs" {
			continue
		}
		jobs := root.Content[0].Content[i+1]
		if jobs.Kind != yaml.MappingNode {
			return nil, errors.New("qualification jobs shape")
		}
		for j := 1; j < len(jobs.Content); j += 2 {
			if !allowedMapping(jobs.Content[j], "name", "needs", "runs-on", "steps", "strategy", "env", "outputs", "if", "defaults") {
				return nil, errors.New("qualification job controls refused")
			}
			for k := 0; k < len(jobs.Content[j].Content); k += 2 {
				if jobs.Content[j].Content[k].Value != "steps" {
					continue
				}
				steps := jobs.Content[j].Content[k+1]
				if steps.Kind != yaml.SequenceNode {
					return nil, errors.New("qualification steps shape")
				}
				for _, step := range steps.Content {
					if !allowedMapping(step, "id", "name", "run", "shell", "env", "if", "uses", "with") {
						return nil, errors.New("qualification step controls refused")
					}
				}
			}
		}
	}
	w, err := model.ReadWorkflow(bytes.NewBufferString(source), true)
	if err != nil {
		return nil, errors.New("qualification schema refused")
	}
	if len(w.Jobs) == 0 || len(w.Jobs) > 8 {
		return nil, errors.New("qualification graph bounds")
	}
	totalSteps, totalInstances := 0, 0
	for _, job := range w.Jobs {
		if job.Uses != "" || job.RawContainer.Kind != 0 || len(job.Services) != 0 ||
			job.RawRunsOn.Kind != yaml.ScalarNode || job.RawRunsOn.Value != "golf-qualification" {
			return nil, errors.New("qualification executor refused")
		}
		if len(job.Steps) == 0 || len(job.Steps) > 8 {
			return nil, errors.New("qualification step bounds")
		}
		totalSteps += len(job.Steps)
		instances := 1
		if job.Strategy != nil && job.Strategy.RawMatrix.Kind != 0 {
			n := job.Strategy.RawMatrix
			if n.Kind != yaml.MappingNode {
				return nil, errors.New("qualification dynamic matrix refused")
			}
			for i := 0; i < len(n.Content); i += 2 {
				key, values := n.Content[i].Value, n.Content[i+1]
				if key == "include" || key == "exclude" || values.Kind != yaml.SequenceNode || len(values.Content) == 0 || len(values.Content) > 8 {
					return nil, errors.New("qualification matrix shape refused")
				}
				for _, value := range values.Content {
					if value.Kind != yaml.ScalarNode || strings.Contains(value.Value, "${{") {
						return nil, errors.New("qualification matrix expression refused")
					}
				}
				if instances > 8/len(values.Content) {
					return nil, errors.New("qualification matrix budget")
				}
				instances *= len(values.Content)
			}
		}
		totalInstances += instances
		for _, step := range job.Steps {
			if step == nil || len(step.Run) > 2048 ||
				(step.Uses != "" && step.Uses != "./actions/owned-composite") ||
				(step.Shell != "" && step.Shell != "sh") ||
				(step.Run != "" && step.Shell == "" && job.Defaults.Run.Shell != "sh" && w.Defaults.Run.Shell != "sh") {
				return nil, errors.New("qualification action or shell refused")
			}
		}
	}
	if totalSteps > 32 || totalInstances > 12 {
		return nil, errors.New("qualification aggregate budget")
	}
	p, err := model.NewSingleWorkflowPlanner("owned-runtime.yml", bytes.NewBufferString(source))
	if err != nil {
		return nil, errors.New("qualification planner refused")
	}
	plan, err := p.PlanEvent(event)
	if err != nil || len(plan.Stages) == 0 {
		return nil, errors.New("qualification event or graph refused")
	}
	return plan, nil
}

func allowedMapping(node *yaml.Node, keys ...string) bool {
	if node.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i < len(node.Content); i += 2 {
		found := false
		for _, key := range keys {
			if node.Content[i].Value == key {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
