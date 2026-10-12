package runner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"
)

// The outer archive has one fixed operator-owned file. Its contents remain the
// canonical four-file Git metadata archive, outside execution JSON and source.
// The engine independently checks it and withholds setup ACK until native job
// identity/index/source checks finish. Staging never manufactures success frames.
func (a *ActionsExecutor) transferGitSource(ctx context.Context, container string, manifest *GitSourceManifest, metadata []byte) (string, error) {
	phase := "git_source_transfer"
	if !containerPattern.MatchString(container) || manifest == nil || manifest.Profile != GitSourceProfile || len(metadata) < 1 || len(metadata) > GitSourceMetadataLimit {
		return phase, ErrInfrastructure
	}
	sum := sha256.Sum256(metadata)
	expected := hex.EncodeToString(sum[:])
	if expected != manifest.MetadataSHA256 {
		return phase, ErrInfrastructure
	}
	transferCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// Docker cp can acknowledge writes beneath a running tmpfs on rootless
	// daemons. Exec writes through the actual mount; bytes remain stdin and
	// neither source paths nor source contents become command syntax.
	_, err := a.executor.command(transferCtx, bytes.NewReader(metadata), "exec", "-i", container, "/bin/sh", "-c", "umask 077; cat > /golf/git-source.tar && chmod 0444 /golf/git-source.tar")
	if err != nil || transferCtx.Err() != nil {
		return phase, ErrInfrastructure
	}
	phase = "git_source_remote_hash"
	actual, err := a.executor.command(transferCtx, nil, "exec", container, "sha256sum", GitSourceMetadataPath)
	if err != nil || string(actual) != expected+"  "+GitSourceMetadataPath+"\n" || transferCtx.Err() != nil {
		return phase, ErrInfrastructure
	}
	return phase, nil
}
