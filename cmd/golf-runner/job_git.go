package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

// Issue through the authenticated control origin. The capsule's independent
// public Git origin and frozen job/source binding must match the assignment.
func (c *coordinator) issueJobGit(ctx context.Context, a assignment, job string) (*runner.JobGitCredential, error) {
	known := false
	if a.ActionsPlan != nil {
		for _, j := range a.ActionsPlan.Jobs {
			known = known || job == j.InstanceID
		}
	}
	if !known || !c.manualInputsReady() || a.JobGit == nil || a.JobGit.Validate() != nil {
		return nil, errTransport
	}
	r, err := c.request(ctx, http.MethodPost, "/internal/ci/attempt/"+a.AttemptID+"/job-git-credential", a.AttemptToken, struct {
		JobInstanceID string `json:"jobInstanceId"`
	}{job})
	if err != nil {
		return nil, errTransport
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK || !c.verifiedResponseTLS(r) || r.Header.Get("Cache-Control") != "no-store" {
		return nil, errTransport
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 8193))
	if err != nil || len(data) > 8192 {
		return nil, errTransport
	}
	var credential runner.JobGitCredential
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&credential) != nil || d.Decode(new(any)) != io.EOF || credential.Validate(a.JobGit, a.CommitID, a.ActionsPlan.WorkflowBlobID, job, time.Now()) != nil || credential.GitToken == c.key || credential.GitToken == a.AttemptToken {
		return nil, errTransport
	}
	return &credential, nil
}

// Job credentials are renewed during execution. Hold only the bounded private
// transcript, mask every issued token and its Basic form across frame boundaries,
// then release with original coordinates before the terminal completion ACK.
type jobGitTranscript struct {
	frames  []runner.ActionFrame
	bytes   int
	secrets map[string]string
}

func (t *jobGitTranscript) issued(c *runner.JobGitCredential) {
	if t.secrets == nil {
		t.secrets = map[string]string{}
	}
	for _, secret := range []string{c.GitToken, base64.StdEncoding.EncodeToString([]byte("x-access-token:" + c.GitToken))} {
		t.secrets[strconv.Itoa(len(t.secrets))] = secret
	}
}
func (t *jobGitTranscript) append(f runner.ActionFrame) error {
	t.bytes += len(f.Text)
	if f.Kind != "log" || t.bytes > logLimit || len(t.frames) >= 4096 {
		return errOutputBound
	}
	t.frames = append(t.frames, f)
	return nil
}
func (t *jobGitTranscript) release(ctx context.Context, forward *logForwarder) error {
	chunks := make([]string, len(t.frames))
	for i, f := range t.frames {
		chunks[i] = f.Text
	}
	masked, err := runner.MaskExecutionOutput(chunks, t.secrets)
	if err != nil {
		return errOutputBound
	}
	for i, f := range t.frames {
		forward.jobInstanceID, forward.stepID = f.InstanceID, f.StepID
		if err = forward.write(ctx, runner.LogChunk{Stream: "stdout", Data: []byte(masked[i])}, true); err != nil {
			return err
		}
	}
	t.frames = nil
	return nil
}
