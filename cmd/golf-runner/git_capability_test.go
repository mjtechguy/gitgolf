package main

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func TestGitCapabilityRequiresConfiguredConsumerAndVerifiedTLS(t *testing.T) {
	c := &coordinator{origin: "https://golf.invalid", client: &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13}}}, actions: &runner.ActionsExecutor{}, executor: &runner.Executor{}}
	a := typedManualAssignment(t)
	c.verifiedTLS.Store(true)
	a.GitSourceProfile = runner.GitSourceProfile
	for _, mode := range []string{"unset", "ready", "unverified", "insecure", "no_executor", "unknown_profile", "shell", "downgrade"} {
		t.Run(mode, func(t *testing.T) {
			c.gitPrepImage = "alpine/git@sha256:" + strings.Repeat("a", 64)
			c.executor = &runner.Executor{}
			c.client.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify = false
			c.verifiedTLS.Store(true)
			assignment := a
			switch mode {
			case "unset":
				c.gitPrepImage = ""
			case "unverified":
				c.verifiedTLS.Store(false)
			case "insecure":
				c.client.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify = true
			case "no_executor":
				c.executor = nil
			case "unknown_profile":
				assignment.GitSourceProfile = "future"
			case "downgrade":
				assignment.GitSourceProfile = ""
			case "shell":
				assignment.ActionsPlan = nil
				assignment.EngineCatalog = ""
			}
			if c.validAssignment(assignment) != (mode == "ready") {
				t.Fatal("Git assignment silently bypassed its consumer/TLS/profile binding")
			}
			encoded, _ := json.Marshal(c.pollCapabilities())
			var poll struct{ Capabilities []string }
			if json.Unmarshal(encoded, &poll) != nil || slices.Contains(poll.Capabilities, runner.GitSourceProfile) != (mode == "ready" || mode == "unknown_profile" || mode == "shell" || mode == "downgrade") {
				t.Fatal("Git advertisement differs from actual consumer readiness")
			}
		})
	}
}

func TestJobGitAssignmentCannotDowngrade(t *testing.T) {
	t.Setenv("GOLF_RUNNER_JOB_GIT", "1")
	t.Setenv("GOLF_RUNNER_ACTIONS_REMOTE_BUNDLES", "/operator/actions.json")
	c := &coordinator{origin: "https://control.invalid", client: &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13}}}, actions: &runner.ActionsExecutor{}, executor: &runner.Executor{}, gitPrepImage: "git@sha256:" + strings.Repeat("a", 64)}
	c.verifiedTLS.Store(true)
	a := typedManualAssignment(t)
	a.GitSourceProfile = runner.GitSourceProfile
	if c.validAssignment(a) {
		t.Fatal("job Git consumer accepted an assignment without its capsule binding")
	}
	a.JobGit = &runner.JobGitContext{Origin: "https://public.invalid", Repository: "owner/repository", Actor: "unavailable"}
	if !c.validAssignment(a) {
		t.Fatal("independent public/control context rejected")
	}
	a.JobGit.Repository = "../foreign"
	if c.validAssignment(a) {
		t.Fatal("invalid repository accepted")
	}
}
