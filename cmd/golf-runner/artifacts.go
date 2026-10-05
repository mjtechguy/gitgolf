package main

import (
	"bytes"
	"context"
	"github.com/mjtechguy/golf-git/internal/runner"
	"net/http"
)

// One upload only; an uncertain response ends the attempt as lost. Retained
// server bytes are not published unless an independently fenced finish succeeds.
func (c *coordinator) uploadArtifact(ctx context.Context, a assignment, data []byte) error {
	if !c.manualInputsReady() || len(data) > runner.MaxArtifactArchive || len(data) == 0 || !attemptID.MatchString(a.AttemptID) || !tokenOK(a.AttemptToken) {
		return errTransport
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+"/internal/ci/attempt/"+a.AttemptID+"/artifact", bytes.NewReader(data))
	if err != nil {
		return errTransport
	}
	r.Header.Set("Authorization", "Bearer "+c.key)
	r.Header.Set("Golf-Runner-ID", c.id)
	r.Header.Set("Golf-Attempt-Token", a.AttemptToken)
	r.Header.Set("Content-Type", "application/x-tar")
	response, err := c.client.Do(r)
	if err != nil {
		return errTransport
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent || !c.verifiedResponseTLS(response) {
		return errTransport
	}
	return nil
}
