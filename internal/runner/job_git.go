package runner

import (
	"net/url"
	"strings"
	"time"
)

const JobGitCapability = "golf.runner.job-git.exact-h.v1"

// Public execution context and a job-only capsule. Neither field may contain
// worker enrollment, attempt or native forge credentials.
type JobGitContext struct {
	Origin     string `json:"origin"`
	Repository string `json:"repository"`
	Actor      string `json:"actor"`
}

type JobGitCredential struct {
	GitToken       string `json:"gitToken"`
	Origin         string `json:"origin"`
	RepositoryURL  string `json:"repositoryUrl"`
	ExpiresAt      string `json:"expiresAt"`
	CommitID       string `json:"commitId"`
	WorkflowBlobID string `json:"workflowBlobId"`
	JobInstanceID  string `json:"jobInstanceId"`
}

func (c *JobGitContext) Validate() error {
	if c == nil {
		return nil
	}
	u, err := url.Parse(c.Origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || u.ForceQuery || u.String() != c.Origin {
		return ErrInvalidJob
	}
	parts := strings.Split(c.Repository, "/")
	if len(parts) != 2 || !ValidGitSourcePath(c.Repository) || strings.ContainsAny(c.Repository, "%?#:@") || c.Actor == "" || len(c.Actor) > 128 || strings.ContainsAny(c.Actor, "\r\n\x00") {
		return ErrInvalidJob
	}
	return nil
}

func (c *JobGitCredential) Validate(binding *JobGitContext, commit, blob, job string, now time.Time) error {
	if c == nil || binding == nil || binding.Validate() != nil || c.Origin != binding.Origin || c.RepositoryURL != binding.Origin+"/"+binding.Repository || c.CommitID != commit || c.WorkflowBlobID != blob || c.JobInstanceID != job || !attemptPattern.MatchString(job) || !commitPattern.MatchString(commit) || !commitPattern.MatchString(blob) || len(commit) != len(blob) || !strings.HasPrefix(c.GitToken, "golf_job_git_") || len(c.GitToken) < 32 || len(c.GitToken) > 4096 || strings.ContainsAny(c.GitToken, "\r\n\t \x00") {
		return ErrInvalidJob
	}
	expires, err := time.Parse(time.RFC3339, c.ExpiresAt)
	if err != nil || c.ExpiresAt != expires.UTC().Format(time.RFC3339) || !expires.After(now) || expires.After(now.Add(5*time.Minute)) {
		return ErrInvalidJob
	}
	return nil
}
