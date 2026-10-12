package server

import (
	"crypto/tls"
	"encoding/json"
	"testing"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestRunnerGitSourceCapabilityPostgres(t *testing.T) {
	for _, version := range []uint16{0, tls.VersionTLS12, tls.VersionTLS13} {
		t.Run(tls.VersionName(version), func(t *testing.T) {
			f := engineRunFixture(t)
			if _, err := f.dispatch(t, "12345678-1234-4234-8234-123456789abc"); err != nil {
				t.Fatal(err)
			}
			caps := []string{runner.JobLimitsCapability, runner.ExecutionValuesCapability, runner.ManualInputsCapability, runner.ArtifactCapability, runner.GitSourceProfile}
			request := map[string]any{"catalogs": []string{runner.ActionsCatalog}, "capabilities": caps}
			for _, invalid := range [][]string{append(append([]string{}, caps...), runner.GitSourceProfile), {runner.JobLimitsCapability, "golf.runner.git-source.future"}} {
				request["capabilities"] = invalid
				if executionWorkerCall(f, engineLease{}, "poll", request, version).Code != 400 {
					t.Fatal("duplicate or unknown Git capability consumed an assignment")
				}
			}
			request["capabilities"] = caps
			response := executionWorkerCall(f, engineLease{}, "poll", request, version)
			var assigned struct {
				AttemptID        string `json:"attemptId"`
				GitSourceProfile string `json:"gitSourceProfile"`
			}
			if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &assigned) != nil || assigned.AttemptID == "" || (assigned.GitSourceProfile == runner.GitSourceProfile) != (version == tls.VersionTLS13) {
				t.Fatal("Git source assignment did not bind the advertised verified TLS consumer", response.Code)
			}
		})
	}
}
