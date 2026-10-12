package actionsengine

import (
	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"time"
)

// Caller holds the observer mutex. Delivery follows durable job_started and
// precedes native pre/main/post environment and expression evaluation.
func (o *engineObserver) renewJobGit(job string) error {
	rc := o.contexts[job]
	if o.err != nil || o.ctx.Err() != nil || !o.started[job] || o.finished[job] || rc == nil || o.credentials == nil {
		return ErrExecution
	}
	o.sequence++
	if o.sequence > 4096 {
		return ErrExecution
	}
	c, err := o.credentials(protocol.ActionFrame{Sequence: o.sequence, Kind: "job_git_credential", InstanceID: job})
	if err != nil || c.Validate(o.jobGit, o.commit, o.plan.WorkflowBlobID, job, time.Now()) != nil {
		return ErrExecution
	}
	rc.Config.Token = c.GitToken
	rc.Config.Secrets["GITHUB_TOKEN"] = c.GitToken
	return nil
}
