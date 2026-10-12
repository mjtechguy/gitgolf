package actionsengine

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
)

type engineGitSource struct {
	manifest          *protocol.GitSourceManifest
	metadata, archive []byte
}

// This file lives only in the owned trusted engine domain. Source containers
// never receive its path, a Docker socket or controller credentials. Git jobs use
// verified bounded tmpfs volumes and a read-only container root.
func loadEngineGitSource(input protocol.ActionExecutionInput) (*engineGitSource, error) {
	if input.GitSource == nil {
		return nil, nil
	}
	root, err := os.OpenRoot("/golf")
	if err != nil {
		return nil, ErrExecution
	}
	defer root.Close()
	return readEngineGitSource(root, input)
}
func readEngineGitSource(root *os.Root, input protocol.ActionExecutionInput) (*engineGitSource, error) {
	if input.GitSource == nil || input.JobResources == nil || input.JobResources.Validate() != nil || input.GitSource.ArchiveSHA256 != input.Plan.ArchiveSHA256 {
		return nil, ErrExecution
	}
	info, err := root.Lstat("git-source.tar")
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > protocol.GitSourceMetadataLimit {
		return nil, ErrExecution
	}
	file, err := root.Open("git-source.tar")
	if err != nil {
		return nil, ErrExecution
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return nil, ErrExecution
	}
	metadata, err := io.ReadAll(io.LimitReader(file, protocol.GitSourceMetadataLimit+1))
	if err != nil || int64(len(metadata)) != info.Size() || len(metadata) > protocol.GitSourceMetadataLimit {
		return nil, ErrExecution
	}
	if protocol.ValidateGitSource(input.GitSource, metadata, input.Input.Archive, input.CommitID, input.Input.WorkflowPath, input.Input.WorkflowBlobID) != nil {
		return nil, ErrExecution
	}
	manifest := *input.GitSource
	return &engineGitSource{manifest: &manifest, metadata: metadata, archive: input.Input.Archive}, nil
}

// The envelope has already been checked byte-for-byte against its canonical
// four regular-file grammar. Nothing is extracted into the engine workspace.
func (s *engineGitSource) transfer(ctx context.Context, id string) error {
	if !containerID.MatchString(id) {
		return ErrExecution
	}
	// Preserve the four-path inventory: do not merge metadata into an image's
	// existing repository, template hooks, remotes or a dangling symlink.
	if out, err := gitSourceCommand(ctx, id, nil, 64<<10, "/bin/sh", "-c", "test ! -e .git && test ! -L .git"); err != nil || len(out) != 0 {
		return ErrExecution
	}
	if _, err := gitSourceCommand(ctx, id, bytes.NewReader(s.metadata), 64<<10, "/bin/tar", "-xf", "-", "-C", workspace); err != nil {
		return ErrExecution
	}
	return nil
}

// Called after current owned-volume chown and before releasing any source step.
// The only new file contents are a fixed credential-free format config and a
// native index built from H. read-tree does not checkout or run source filters.
func (s *engineGitSource) verifyJob(ctx context.Context, id string) error {
	if !containerID.MatchString(id) {
		return ErrExecution
	}
	config := "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n"
	if len(s.manifest.CommitID) == 64 {
		config = "[core]\n\trepositoryformatversion = 1\n\tbare = false\n\tfilemode = true\n[extensions]\n\tobjectformat = sha256\n"
	}
	if _, err := gitSourceCommand(ctx, id, strings.NewReader(config), 64<<10, "/bin/sh", "-c", "umask 077; mkdir .git/refs && cat > .git/config"); err != nil {
		return ErrExecution
	}
	native := func(limit int, args ...string) ([]byte, error) {
		command := []string{"/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "credential.helper=", "-c", "gc.auto=0", "-c", "maintenance.auto=false"}
		return gitSourceCommand(ctx, id, nil, limit, append(command, args...)...)
	}
	checks := []struct {
		args  []string
		value string
	}{
		{[]string{"rev-parse", "--verify", "HEAD"}, s.manifest.CommitID},
		{[]string{"cat-file", "-t", s.manifest.CommitID}, "commit"},
		{[]string{"rev-parse", "--verify", s.manifest.CommitID + "^{tree}"}, s.manifest.TreeID},
		{[]string{"rev-parse", "--is-shallow-repository"}, "true"},
		{[]string{"rev-list", "--count", "HEAD"}, "1"},
		{[]string{"rev-parse", "--verify", s.manifest.CommitID + ":" + s.manifest.WorkflowPath}, s.manifest.WorkflowBlobID},
		{[]string{"cat-file", "-t", s.manifest.WorkflowBlobID}, "blob"},
	}
	for _, check := range checks {
		out, err := native(64<<10, check.args...)
		if err != nil || string(out) != check.value+"\n" {
			return ErrExecution
		}
	}
	if out, err := native(64<<10, "fsck", "--full", "--strict", "--no-reflogs"); err != nil || len(out) != 0 {
		return ErrExecution
	}
	listing, err := native(4<<20, "ls-tree", "-rz", "--full-tree", s.manifest.CommitID)
	if err != nil || protocol.VerifyGitSourceSnapshot(s.archive, listing, s.manifest.ArchiveSHA256, s.manifest.CommitID, s.manifest.WorkflowPath, s.manifest.WorkflowBlobID) != nil {
		return ErrExecution
	}
	if _, err = native(64<<10, "read-tree", s.manifest.CommitID); err != nil {
		return ErrExecution
	}
	if out, err := native(64<<10, "status", "--porcelain=v1", "--untracked-files=all"); err != nil || len(out) != 0 {
		return ErrExecution
	}
	if ctx.Err() != nil {
		return ErrExecution
	}
	return nil
}

type gitSourceOutput struct {
	bytes.Buffer
	limit int
}

func (b *gitSourceOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, ErrExecution
	}
	return b.Buffer.Write(p)
}
func gitSourceCommand(ctx context.Context, id string, input io.Reader, limit int, command ...string) ([]byte, error) {
	commandCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := []string{"exec", "--user=1000:1000", "--workdir=" + workspace}
	if input != nil {
		args = append(args, "-i")
	}
	args = append(args, id, "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "XDG_CONFIG_HOME=/tmp", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "LANG=C")
	args = append(args, command...)
	cmd := exec.CommandContext(commandCtx, "docker", args...)
	out := &gitSourceOutput{limit: limit}
	cmd.Stdin = input
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 2 * time.Second
	if cmd.Run() != nil || commandCtx.Err() != nil {
		return nil, ErrExecution
	}
	return out.Bytes(), nil
}

// Source is already extracted and validated in the owned engine domain. Both
// argv vectors are fixed; extraction occurs inside the actual bounded mount.
func transferJobSource(ctx context.Context, id string) error {
	if !containerID.MatchString(id) {
		return ErrExecution
	}
	source := exec.CommandContext(ctx, "/bin/tar", "-cf", "-", "-C", jobSource, ".")
	pipe, err := source.StdoutPipe()
	if err != nil {
		return ErrExecution
	}
	source.Stderr = io.Discard
	if source.Start() != nil {
		return ErrExecution
	}
	_, err = gitSourceCommand(ctx, id, pipe, 64<<10, "/bin/tar", "-xf", "-", "-C", workspace)
	pipe.Close()
	if err != nil {
		source.Process.Kill()
	}
	if source.Wait() != nil || err != nil {
		return ErrExecution
	}
	return nil
}
