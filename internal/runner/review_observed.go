package runner

import (
	"context"
	"io"
	"os/exec"
	"time"
)

// Parse stdout while the native process runs. A rejected journal acknowledgement
// cancels the process; buffering until exit would hide all progress. Neither raw
// stderr nor native error payloads enter the conversation.
func (e *Executor) reviewObservedCommand(ctx context.Context, input io.Reader, j AgentJob, args ...string) (AgentResult, error) {
	run, stop := context.WithCancel(ctx)
	defer stop()
	cmd := exec.CommandContext(run, e.config.DockerBinary, args...)
	cmd.Stdin = input
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 2 * time.Second
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return AgentResult{State: "lost", Stage: "review-observer-pipe"}, ErrInfrastructure
	}
	if err = cmd.Start(); err != nil {
		return AgentResult{State: "lost", Stage: "review-observer-start"}, ErrInfrastructure
	}
	out, parseErr := parseObservedReviewEvents(run, pipe, j.TokenBudget, j.Observe)
	if parseErr != nil {
		stop()
	}
	waitErr := cmd.Wait()
	if parseErr != nil || waitErr != nil {
		out.State = "lost"
		out.Summary = ""
		out.Stage = "review-observer-failed"
		return out, ErrInfrastructure
	}
	if ctx.Err() != nil {
		out.State = "cancelled"
		out.Summary = ""
		return out, ctx.Err()
	}
	return out, nil
}
