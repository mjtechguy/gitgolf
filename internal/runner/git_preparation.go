package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"path"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const gitPackLimit = 64 << 20
const gitMetadataLimit = 80 << 20
const gitWorkspaceTmpfs = "rw,nosuid,nodev,size=134217728,mode=0700,uid=1000,gid=1000"
const gitTemporaryTmpfs = "rw,nosuid,nodev,noexec,size=33554432,mode=1777"

// GitPreparation is a trusted worker-only input. Pack must already be bound to
// the current attempt's exact depth-one source by the enrolled TLS transport.
// No controller or forge credentials enter the disposable, network-free sandbox.
type GitPreparation struct {
	AttemptID, ImageDigest, CommitID, WorkflowPath, WorkflowBlobID string
	Pack                                                           []byte
	JobResources                                                   *JobResourceBinding
}
type GitPreparationResult struct {
	TreeID            string
	Listing, Metadata []byte
}

func gitPreparationPath(value string) bool {
	if value == "" || len(value) > 1024 || path.Clean(value) != value || strings.HasPrefix(value, "/") || value == ".." || strings.HasPrefix(value, "../") || strings.Contains(value, "\\") || !utf8.ValidString(value) || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if strings.EqualFold(part, ".git") {
			return false
		}
	}
	return true
}

// Only the pack header/trailer is inspected here. Native index-pack remains the
// sole object/delta/index decoder and applies strict consistency verification.
func gitPackIdentity(pack []byte, commit string) (string, error) {
	n := len(commit) / 2
	if !commitPattern.MatchString(commit) || len(pack) < 12+n || len(pack) > gitPackLimit || string(pack[:4]) != "PACK" || (binary.BigEndian.Uint32(pack[4:8]) != 2 && binary.BigEndian.Uint32(pack[4:8]) != 3) || (binary.BigEndian.Uint32(pack[8:12]) == 0 || binary.BigEndian.Uint32(pack[8:12]) > 8194) {
		return "", ErrSource
	}
	var actual []byte
	if n == 20 {
		h := sha1.Sum(pack[:len(pack)-n])
		actual = h[:]
	} else {
		h := sha256.Sum256(pack[:len(pack)-n])
		actual = h[:]
	}
	if !bytes.Equal(actual, pack[len(pack)-n:]) {
		return "", ErrSource
	}
	return hex.EncodeToString(actual), nil
}

func (e *Executor) PrepareGit(ctx context.Context, p GitPreparation) (result GitPreparationResult, err error) {
	allowed := false
	for _, image := range e.config.ApprovedImages {
		allowed = allowed || image == p.ImageDigest
	}
	if !allowed || !attemptPattern.MatchString(p.AttemptID) || !commitPattern.MatchString(p.CommitID) || !commitPattern.MatchString(p.WorkflowBlobID) || len(p.CommitID) != len(p.WorkflowBlobID) || !gitPreparationPath(p.WorkflowPath) || p.JobResources == nil || p.JobResources.Validate() != nil {
		return result, ErrInvalidJob
	}
	packID, err := gitPackIdentity(p.Pack, p.CommitID)
	if err != nil {
		return result, err
	}
	limits := MinimumJobLimits(p.JobResources.Limits, JobLimits{1000, "268435456", 32, 30})
	prepCtx, cancel := context.WithTimeout(ctx, time.Duration(limits.TimeoutSeconds)*time.Second)
	defer cancel()
	if err = e.RequireCleanWorker(prepCtx); err != nil {
		return result, err
	}
	var images []struct {
		ID, Os, Architecture string
		RepoDigests          []string
		Config               struct{ Volumes map[string]json.RawMessage }
	}
	if e.inspect(prepCtx, "image", p.ImageDigest, &images) != nil || len(images) != 1 || !imageIDPattern.MatchString(images[0].ID) || images[0].Os != "linux" || images[0].Architecture != runtime.GOARCH || len(images[0].Config.Volumes) != 0 {
		return result, ErrInfrastructure
	}
	image := images[0].ID
	identity := p.ImageDigest == image
	for _, digest := range images[0].RepoDigests {
		identity = identity || RegistryDigestMatches(p.ImageDigest, digest)
	}
	if !identity {
		return result, ErrInfrastructure
	}
	ownerBytes := make([]byte, 16)
	if _, err = rand.Read(ownerBytes); err != nil {
		return result, ErrInfrastructure
	}
	owner := hex.EncodeToString(ownerBytes)
	var container string
	defer func() {
		if container != "" {
			cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
			defer stop()
			if e.removeContainer(cleanup, container, p.AttemptID, owner) != nil {
				result = GitPreparationResult{}
				err = ErrCleanup
			}
		}
		if err != nil || prepCtx.Err() != nil {
			result = GitPreparationResult{}
			if err == nil {
				err = ErrInfrastructure
			}
		}
	}()
	args := []string{"container", "create", "--pull=never", "--network=none", "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", "--no-healthcheck", "--log-driver=none", "--read-only", "--init", "--tmpfs", "/workspace:" + gitWorkspaceTmpfs, "--tmpfs", "/tmp:" + gitTemporaryTmpfs, "--workdir=/workspace"}
	args = append(args, limits.DockerOptions()...)
	for _, label := range []string{workerLabel + "=" + e.config.WorkerID, managedLabel + "=true", attemptLabel + "=" + p.AttemptID, ownerLabel + "=" + owner} {
		args = append(args, "--label", label)
	}
	args = append(args, "--entrypoint=/usr/bin/env", image, "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "/bin/sh", "-c", "while :; do sleep 3600; done")
	data, createErr := e.command(prepCtx, nil, args...)
	container = strings.TrimSpace(string(data))
	if createErr != nil || !containerPattern.MatchString(container) {
		container = ""
		return result, ErrInfrastructure
	}
	if _, err = e.command(prepCtx, nil, "container", "start", container); err != nil {
		return
	}
	var records []gitPreparationInspect
	if e.inspect(prepCtx, "container", container, &records) != nil || len(records) != 1 || !validGitPreparationContainer(records[0], container, image, e.config.WorkerID, p.AttemptID, owner, limits) {
		return result, ErrInfrastructure
	}
	execCommand := func(input io.Reader, limit int, command ...string) ([]byte, error) {
		args := []string{"container", "exec", "--user=1000:1000", "--workdir=/workspace"}
		if input != nil {
			args = append(args, "-i")
		}
		args = append(args, container, "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "XDG_CONFIG_HOME=/tmp", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "LANG=C")
		args = append(args, command...)
		return e.commandLimit(prepCtx, input, limit, args...)
	}
	git := func(input io.Reader, limit int, command ...string) ([]byte, error) {
		args := []string{"/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "credential.helper=", "-c", "gc.auto=0", "-c", "maintenance.auto=false"}
		return execCommand(input, limit, append(args, command...)...)
	}
	objectFormat := "sha1"
	if len(p.CommitID) == 64 {
		objectFormat = "sha256"
	}
	if _, err = git(nil, 64<<10, "init", "--quiet", "--template=", "--object-format="+objectFormat, "."); err != nil {
		return
	}
	if _, err = execCommand(nil, 64<<10, "/bin/sh", "-c", `printf '%s\n' "$1" > .git/shallow`, "--", p.CommitID); err != nil {
		return
	}
	out, indexErr := git(bytes.NewReader(p.Pack), 64<<10, "index-pack", "--strict", "--stdin", "--threads=1", "--max-input-size=67108864", "--no-rev-index", "--index-version=2")
	if indexErr != nil || string(out) != "pack\t"+packID+"\n" {
		return result, ErrSource
	}
	if _, err = git(nil, 64<<10, "update-ref", "--no-deref", "HEAD", p.CommitID); err != nil {
		return
	}
	checks := []struct {
		args  []string
		value string
	}{
		{[]string{"rev-parse", "--verify", "HEAD"}, p.CommitID},
		{[]string{"cat-file", "-t", p.CommitID}, "commit"},
		{[]string{"rev-list", "--count", "HEAD"}, "1"},
		{[]string{"rev-parse", "--is-shallow-repository"}, "true"},
		{[]string{"rev-parse", "--verify", p.CommitID + ":" + p.WorkflowPath}, p.WorkflowBlobID},
		{[]string{"cat-file", "-t", p.WorkflowBlobID}, "blob"},
	}
	for _, check := range checks {
		out, checkErr := git(nil, 64<<10, check.args...)
		if checkErr != nil || string(out) != check.value+"\n" {
			return GitPreparationResult{}, ErrSource
		}
	}
	out, err = git(nil, 64<<10, "rev-parse", "--verify", p.CommitID+"^{tree}")
	if err != nil {
		return GitPreparationResult{}, err
	}
	result.TreeID = strings.TrimSuffix(string(out), "\n")
	if !commitPattern.MatchString(result.TreeID) || len(result.TreeID) != len(p.CommitID) {
		return GitPreparationResult{}, ErrSource
	}
	if out, err = git(nil, 64<<10, "fsck", "--full", "--strict", "--no-reflogs"); err != nil || len(out) != 0 {
		return GitPreparationResult{}, ErrSource
	}
	result.Listing, err = git(nil, 4<<20, "ls-tree", "-rz", "--full-tree", p.CommitID)
	if err != nil {
		return GitPreparationResult{}, err
	}
	packPath := ".git/objects/pack/pack-" + packID
	out, err = execCommand(nil, gitMetadataLimit, "/bin/tar", "-cf", "-", ".git/HEAD", ".git/shallow", packPath+".pack", packPath+".idx")
	if err != nil {
		return GitPreparationResult{}, err
	}
	result.Metadata, err = normalizeGitMetadata(out, p.Pack, p.CommitID, packID)
	if err != nil || prepCtx.Err() != nil {
		if err == nil {
			err = ErrInfrastructure
		}
		return GitPreparationResult{}, err
	}
	return
}

type gitPreparationInspect struct {
	ID     string `json:"Id"`
	Image  string
	Config struct {
		User, WorkingDir string
		Labels           map[string]string
		Entrypoint, Cmd  []string
	}
	State      struct{ Running bool }
	HostConfig struct {
		NetworkMode                                  string
		Privileged, ReadonlyRootfs                   bool
		Memory, MemorySwap, NanoCpus                 int64
		PidsLimit                                    *int64
		CapAdd, CapDrop, SecurityOpt, Binds, Devices []string
		PortBindings                                 map[string]json.RawMessage
		Tmpfs                                        map[string]string
		Init                                         *bool
		RestartPolicy                                struct{ Name string }
		LogConfig                                    struct{ Type string }
	}
	Mounts []struct{ Type, Destination string }
}

func validGitPreparationContainer(r gitPreparationInspect, id, image, worker, attempt, owner string, l JobLimits) bool {
	h := r.HostConfig
	if r.ID != id || r.Image != image || !r.State.Running || !owned(r.Config.Labels, attempt, owner, worker) || r.Config.User != "1000:1000" || r.Config.WorkingDir != "/workspace" || strings.Join(r.Config.Entrypoint, "\x00") != "/usr/bin/env" || strings.Join(r.Config.Cmd, "\x00") != "-i\x00PATH=/usr/bin:/bin\x00HOME=/tmp\x00/bin/sh\x00-c\x00while :; do sleep 3600; done" || h.NetworkMode != "none" || h.Privileged || !h.ReadonlyRootfs || h.Memory != l.Memory() || h.MemorySwap != l.Memory() || h.NanoCpus != int64(l.CPUMillis)*1000000 || h.PidsLimit == nil || *h.PidsLimit != int64(l.Pids) || h.Init == nil || !*h.Init || len(h.CapAdd) != 0 || len(h.CapDrop) != 1 || !strings.EqualFold(h.CapDrop[0], "ALL") || len(h.SecurityOpt) != 1 || (h.SecurityOpt[0] != "no-new-privileges" && h.SecurityOpt[0] != "no-new-privileges:true") || len(h.Binds) != 0 || len(h.Devices) != 0 || len(h.PortBindings) != 0 || h.RestartPolicy.Name != "no" || h.LogConfig.Type != "none" || len(h.Tmpfs) != 2 || h.Tmpfs["/workspace"] != gitWorkspaceTmpfs || h.Tmpfs["/tmp"] != gitTemporaryTmpfs {
		return false
	}
	seen := map[string]bool{}
	for _, m := range r.Mounts {
		if m.Type != "tmpfs" || (m.Destination != "/workspace" && m.Destination != "/tmp") || seen[m.Destination] {
			return false
		}
		seen[m.Destination] = true
	}
	// Some Docker versions report --tmpfs only in HostConfig, others in Mounts.
	return len(r.Mounts) == 0 || len(seen) == 2
}

func normalizeGitMetadata(raw, pack []byte, commit, packID string) ([]byte, error) {
	id, err := gitPackIdentity(pack, commit)
	if err != nil || id != packID || len(raw) > gitMetadataLimit {
		return nil, ErrSource
	}
	packPath := ".git/objects/pack/pack-" + packID
	expected := map[string][]byte{".git/HEAD": []byte(commit + "\n"), ".git/shallow": []byte(commit + "\n"), packPath + ".pack": pack, packPath + ".idx": nil}
	seen := map[string]bool{}
	input := bytes.NewReader(raw)
	reader := tar.NewReader(input)
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil || h.Typeflag != tar.TypeReg || h.Linkname != "" || h.Size < 1 || h.Size > gitPackLimit || len(h.PAXRecords) != 0 {
			return nil, ErrSource
		}
		want, ok := expected[h.Name]
		if !ok || seen[h.Name] {
			return nil, ErrSource
		}
		seen[h.Name] = true
		data, err := io.ReadAll(io.LimitReader(reader, h.Size+1))
		if err != nil || int64(len(data)) != h.Size {
			return nil, ErrSource
		}
		if want != nil && !bytes.Equal(data, want) {
			return nil, ErrSource
		}
		if want == nil {
			if !validGitPackIndex(data, packID, len(commit)/2) {
				return nil, ErrSource
			}
		}
		if writer.WriteHeader(&tar.Header{Name: h.Name, Typeflag: tar.TypeReg, Mode: 0444, Size: h.Size}) != nil {
			return nil, ErrSource
		}
		if _, err = writer.Write(data); err != nil {
			return nil, ErrSource
		}
	}
	trailing, err := io.ReadAll(input)
	if err != nil || len(bytes.Trim(trailing, "\x00")) != 0 || len(seen) != 4 || writer.Close() != nil || output.Len() > gitMetadataLimit {
		return nil, ErrSource
	}
	return output.Bytes(), nil
}
func validGitPackIndex(index []byte, packID string, n int) bool {
	if len(index) < 8+256*4+2*n || !bytes.Equal(index[:4], []byte{255, 116, 79, 99}) || binary.BigEndian.Uint32(index[4:8]) != 2 || hex.EncodeToString(index[len(index)-2*n:len(index)-n]) != packID {
		return false
	}
	if n == 20 {
		sum := sha1.Sum(index[:len(index)-n])
		return bytes.Equal(sum[:], index[len(index)-n:])
	}
	sum := sha256.Sum256(index[:len(index)-n])
	return bytes.Equal(sum[:], index[len(index)-n:])
}
