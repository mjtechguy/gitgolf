package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

// Trusted engine frames alone enter here. Job stdout remains a log frame and
// never receives the enrollment key, attempt token or native provider cache.
func (c *coordinator) workflowAgentStep(ctx context.Context, a assignment, frame runner.ActionFrame) error {
	if a.EngineCatalog != runner.ActionsAgentCatalog || !c.manualInputsReady() || frame.Text != "" || frame.State != "" || frame.EventSequence != 0 {
		return errTransport
	}
	known := false
	if a.ActionsPlan != nil {
		for _, job := range a.ActionsPlan.Jobs {
			for _, step := range job.Steps {
				known = known || job.InstanceID == frame.InstanceID && step.ID == frame.StepID && step.AgentPrompt != ""
			}
		}
	}
	if !known {
		return errTransport
	}
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	task := ""
	for {
		response, err := c.request(ctx, http.MethodPost, "/internal/ci/attempt/"+a.AttemptID+"/agent", a.AttemptToken, map[string]string{"jobInstanceId": frame.InstanceID, "stepId": frame.StepID})
		if err != nil {
			return err
		}
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, 4097))
		response.Body.Close()
		var receipt struct{ State, TaskID string }
		if readErr != nil || response.StatusCode != http.StatusOK || len(raw) > 4096 || !c.manualInputsReady() || json.Unmarshal(raw, &receipt) != nil || !regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).MatchString(receipt.TaskID) || task != "" && task != receipt.TaskID {
			return errTransport
		}
		task = receipt.TaskID
		switch receipt.State {
		case "succeeded":
			return nil
		case "queued", "running":
		default:
			return errTransport
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}
