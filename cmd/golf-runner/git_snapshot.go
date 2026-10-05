package main

import "github.com/mjtechguy/golf-git/internal/runner"

// Worker and engine share the same admitted archive/native-tree boundary.
func verifyGitSnapshot(archive, listing []byte, archiveSHA, commit, workflowPath, workflowBlob string) error {
	if runner.VerifyGitSourceSnapshot(archive, listing, archiveSHA, commit, workflowPath, workflowBlob) != nil {
		return errTransport
	}
	return nil
}
