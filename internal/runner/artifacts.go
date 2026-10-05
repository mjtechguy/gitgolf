package runner

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"path"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const ArtifactCapability = "golf.workflow.shell.artifacts.v1"
const MaxArtifactArchive = 10 << 20
const maxArtifactWorkspace = 32 << 20
const MaxArtifactFiles = 128
const MaxArtifactBytes = 8 << 20

var ErrArtifacts = errors.New("build outputs exceed the bounded ordinary artifact contract")

// Paths are literal workspace-relative file/directory names, never globs,
// variables, exclusions or host paths. Overlaps have one archive identity.
func ValidateArtifactPaths(paths []string) error {
	if len(paths) < 1 || len(paths) > 8 {
		return ErrArtifacts
	}
	seen := map[string]bool{}
	for _, p := range paths {
		if !artifactPath(p) || strings.ContainsAny(p, "*?[]$\\:") || seen[p] {
			return ErrArtifacts
		}
		for previous := range seen {
			if strings.HasPrefix(p, previous+"/") || strings.HasPrefix(previous, p+"/") {
				return ErrArtifacts
			}
		}
		seen[p] = true
	}
	return nil
}

func artifactPath(p string) bool {
	return p != "" && p != "." && len(p) <= 1024 && utf8.ValidString(p) && path.IsAbs(p) == false && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../") && !strings.ContainsAny(p, "\\:") && strings.IndexFunc(p, unicode.IsControl) < 0
}

// NormalizeArtifactArchive never extracts on the worker or server. It validates
// the whole bounded workspace inventory before selecting literal outputs, so an
// unselected link cannot redirect a selected descendant. Only canonical regular
// files survive; ownership, executable modes and timestamps are discarded.
func NormalizeArtifactArchive(data []byte, paths []string) ([]byte, int, int64, error) {
	if ValidateArtifactPaths(paths) != nil || len(data) > maxArtifactWorkspace {
		return nil, 0, 0, ErrArtifacts
	}
	input := bytes.NewReader(data)
	r := tar.NewReader(input)
	seen := map[string]byte{}
	files := map[string][]byte{}
	matched := make([]bool, len(paths))
	var total int64
	for entries := 0; ; entries++ {
		h, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil || entries >= 4096 {
			return nil, 0, 0, ErrArtifacts
		}
		name := strings.TrimPrefix(h.Name, "./")
		if h.Typeflag == tar.TypeDir {
			name = strings.TrimSuffix(name, "/")
		}
		if name == "." || name == "" {
			if h.Typeflag != tar.TypeDir || h.Size != 0 {
				return nil, 0, 0, ErrArtifacts
			}
			continue
		}
		if !artifactPath(name) || seen[name] != 0 || h.Linkname != "" || (h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir) || h.Size < 0 || h.Size > maxArtifactWorkspace {
			return nil, 0, 0, ErrArtifacts
		}
		for k, value := range h.PAXRecords {
			if k != "mtime" && k != "atime" && k != "ctime" && !(k == "path" && value == h.Name) {
				return nil, 0, 0, ErrArtifacts
			}
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if kind, ok := seen[parent]; ok && kind != tar.TypeDir {
				return nil, 0, 0, ErrArtifacts
			}
		}
		if h.Typeflag == tar.TypeReg {
			for previous := range seen {
				if strings.HasPrefix(previous, name+"/") {
					return nil, 0, 0, ErrArtifacts
				}
			}
		}
		seen[name] = h.Typeflag
		selected := false
		for i, p := range paths {
			if name == p || strings.HasPrefix(name, p+"/") {
				if h.Typeflag == tar.TypeReg {
					matched[i] = true
				}
				selected = true
			}
		}
		if h.Typeflag == tar.TypeDir {
			if h.Size != 0 {
				return nil, 0, 0, ErrArtifacts
			}
			continue
		}
		if !selected {
			continue
		}
		total += h.Size
		if total > MaxArtifactBytes || len(files) >= MaxArtifactFiles {
			return nil, 0, 0, ErrArtifacts
		}
		body, err := io.ReadAll(io.LimitReader(r, h.Size+1))
		if err != nil || int64(len(body)) != h.Size {
			return nil, 0, 0, ErrArtifacts
		}
		files[name] = body
	}
	tail, _ := io.ReadAll(input)
	if len(bytes.Trim(tail, "\x00")) != 0 {
		return nil, 0, 0, ErrArtifacts
	}
	for _, found := range matched {
		if !found {
			return nil, 0, 0, ErrArtifacts
		}
	}
	if len(files) == 0 {
		return nil, 0, 0, ErrArtifacts
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	var out bytes.Buffer
	w := tar.NewWriter(&out)
	for _, name := range names {
		if w.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(files[name])), Format: tar.FormatPAX}) != nil {
			return nil, 0, 0, ErrArtifacts
		}
		if _, err := w.Write(files[name]); err != nil {
			return nil, 0, 0, ErrArtifacts
		}
	}
	if w.Close() != nil || out.Len() > MaxArtifactArchive {
		return nil, 0, 0, ErrArtifacts
	}
	return out.Bytes(), len(files), total, nil
}

func (e *Executor) collectArtifacts(ctx context.Context, container, attempt, owner string, paths []string) ([]byte, error) {
	if _, err := e.command(ctx, nil, "container", "pause", container); err != nil {
		return nil, err
	}
	var rows []struct {
		ID     string
		Config struct{ Labels map[string]string }
		State  struct{ Running, Paused bool }
	}
	if e.inspect(ctx, "container", container, &rows) != nil || len(rows) != 1 || rows[0].ID != container || !rows[0].State.Running || !rows[0].State.Paused || !owned(rows[0].Config.Labels, attempt, owner, e.config.WorkerID) {
		return nil, ErrInfrastructure
	}
	cmd := exec.CommandContext(ctx, e.config.DockerBinary, "container", "cp", container+":/workspace/.", "-")
	cmd.WaitDelay = 2 * time.Second
	out := &limitedBuffer{limit: maxArtifactWorkspace}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		return nil, ErrArtifacts
	}
	archive, _, _, err := NormalizeArtifactArchive(out.Bytes(), paths)
	return archive, err
}
