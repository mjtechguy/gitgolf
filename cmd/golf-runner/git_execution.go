package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

// prepareActionsGitSource composes the existing trusted transport and native
// sandbox. The original admitted archive remains unchanged. Only public source
// identity and credential-free metadata can enter the later ExecuteGit call.
// Assignment/capability activation and job-image qualification are separate.
func (c *coordinator) prepareActionsGitSource(ctx context.Context, e *runner.Executor, a assignment, archive []byte, approvedPrepImage string) (*runner.GitSourceManifest, []byte, error) {
	if c == nil || e == nil || approvedPrepImage == "" || ctx.Err() != nil || a.ActionsPlan == nil || !c.validAssignment(a) || !commitID.MatchString(a.CommitID) || !commitID.MatchString(a.ActionsPlan.WorkflowBlobID) || len(a.CommitID) != len(a.ActionsPlan.WorkflowBlobID) || !runner.ValidGitSourcePath(a.ActionsPlan.WorkflowPath) || len(archive) == 0 || len(archive) > sourceLimit {
		return nil, nil, errTransport
	}
	digest := sha256.Sum256(archive)
	if !hashID.MatchString(a.SourceSHA256) || hex.EncodeToString(digest[:]) != a.SourceSHA256 || a.ActionsPlan.ArchiveSHA256 != a.SourceSHA256 {
		return nil, nil, errTransport
	}
	prepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pack, err := c.fetchGitPack(prepCtx, a, a.ActionsPlan.WorkflowBlobID)
	if err != nil {
		return nil, nil, err
	}
	prepared, err := e.PrepareGit(prepCtx, runner.GitPreparation{AttemptID: a.AttemptID, ImageDigest: approvedPrepImage, CommitID: a.CommitID, WorkflowPath: a.ActionsPlan.WorkflowPath, WorkflowBlobID: a.ActionsPlan.WorkflowBlobID, Pack: pack, JobResources: a.JobResources})
	if err != nil {
		// In particular, preserve ErrCleanup so the caller fences worker reuse.
		return nil, nil, err
	}
	manifest, err := runner.NewGitSourceManifest(prepared, archive, a.SourceSHA256, a.CommitID, a.ActionsPlan.WorkflowPath, a.ActionsPlan.WorkflowBlobID)
	if err != nil {
		return nil, nil, err
	}
	// Re-observe the original live attempt/source through the same supported
	// authority path after potentially slow native preparation. This is a
	// bounded observation, not an atomic native authorization/dispatch fence.
	refs, err := c.gitPreparationRead(prepCtx, a, a.ActionsPlan.WorkflowBlobID, "/info/refs?service=git-upload-pack", nil)
	if err != nil {
		return nil, nil, err
	}
	if _, err = gitPackAdvertisement(refs, a.CommitID); err != nil || prepCtx.Err() != nil {
		return nil, nil, errTransport
	}
	return manifest, prepared.Metadata, nil
}
