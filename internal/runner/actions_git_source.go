package runner

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
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
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		archive := tar.NewWriter(writer)
		err := archive.WriteHeader(&tar.Header{Name: "git-source.tar", Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(metadata)), Uid: 0, Gid: 0})
		if err == nil {
			_, err = archive.Write(metadata)
		}
		if err == nil {
			err = archive.Close()
		}
		writer.CloseWithError(err)
		done <- err
	}()
	_, copyErr := a.executor.command(transferCtx, reader, "container", "cp", "-", container+":/golf")
	// Command failure/cancellation must also release a producer blocked on stdin.
	reader.CloseWithError(copyErr)
	produceErr := <-done
	if copyErr != nil || produceErr != nil || transferCtx.Err() != nil {
		return phase, ErrInfrastructure
	}
	phase = "git_source_remote_hash"
	actual, err := a.executor.command(transferCtx, nil, "exec", container, "sha256sum", GitSourceMetadataPath)
	if err != nil || string(actual) != expected+"  "+GitSourceMetadataPath+"\n" || transferCtx.Err() != nil {
		return phase, ErrInfrastructure
	}
	return phase, nil
}
