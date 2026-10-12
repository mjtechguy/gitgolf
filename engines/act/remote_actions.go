package actionsengine

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"gopkg.in/yaml.v3"
)

type admittedRemoteAction struct {
	bundle   protocol.ActionBundle
	identity protocol.ActionRemoteIdentity
	files    map[string]file
	metadata *yaml.Node
}

func gitObject(kind string, body []byte) []byte {
	h := sha1.Sum(append([]byte(fmt.Sprintf("%s %d\x00", kind, len(body))), body...))
	return h[:]
}

// Reconstruct all ordinary Git trees from exact bytes and executable modes.
// A matching tar digest alone cannot establish a claimed immutable Git commit.
func actionTree(files map[string]file, directory string) []byte {
	type entry struct {
		name, mode string
		hash       []byte
		directory  bool
	}
	entries := map[string]entry{}
	prefix := directory
	if prefix != "" {
		prefix += "/"
	}
	for name, f := range files {
		if !strings.HasPrefix(name, prefix) || f.directory {
			continue
		}
		relative := strings.TrimPrefix(name, prefix)
		first, _, nested := strings.Cut(relative, "/")
		if nested {
			entries[first] = entry{name: first, mode: "40000", directory: true}
			continue
		}
		mode := "100644"
		if f.mode == 0120000 {
			mode = "120000"
		} else if f.mode&0111 != 0 {
			mode = "100755"
		}
		entries[first] = entry{name: first, mode: mode, hash: gitObject("blob", f.body)}
	}
	ordered := make([]entry, 0, len(entries))
	for _, e := range entries {
		ordered = append(ordered, e)
	}
	sort.Slice(ordered, func(i, j int) bool {
		a, b := ordered[i].name, ordered[j].name
		if ordered[i].directory {
			a += "/"
		}
		if ordered[j].directory {
			b += "/"
		}
		return a < b
	})
	var body []byte
	for _, e := range ordered {
		if e.directory {
			e.hash = actionTree(files, path.Join(directory, e.name))
		}
		body = append(body, []byte(e.mode+" "+e.name+"\x00")...)
		body = append(body, e.hash...)
	}
	return gitObject("tree", body)
}

func admitRemoteActions(input protocol.ActionPlanInput) (map[string]*admittedRemoteAction, error) {
	out := map[string]*admittedRemoteAction{}
	if input.Catalog != protocol.ActionsRemoteCatalog {
		if len(input.RemoteActions) != 0 {
			return nil, ErrProfile
		}
		return out, nil
	}
	if len(input.RemoteActions) == 0 || len(input.RemoteActions) > 8 {
		return nil, ErrProfile
	}
	var total int
	for _, bundle := range input.RemoteActions {
		total += len(bundle.Archive)
		if total > 20<<20 || bundle.Validate() != nil || out[bundle.Uses] != nil {
			return nil, ErrProfile
		}
		files, err := archiveFiles(bundle.Archive, true)
		if err != nil {
			return nil, ErrProfile
		}
		treeID := hex.EncodeToString(actionTree(files, ""))
		if !bytes.HasPrefix(bundle.Commit, []byte("tree "+treeID+"\n")) {
			return nil, ErrProfile
		}
		ref := protocol.RemoteActionReference.FindStringSubmatch(bundle.Uses)
		directory := strings.TrimPrefix(ref[3], "/")
		if directory != "" && !safePath(directory) {
			return nil, ErrProfile
		}
		metadataName := path.Join(directory, "action.yml")
		metadata, ok := files[metadataName]
		if !ok {
			metadataName = path.Join(directory, "action.yaml")
			metadata, ok = files[metadataName]
		}
		if !ok || metadata.directory || metadata.mode == 0120000 {
			return nil, ErrProfile
		}
		root, err := tree(metadata.body)
		if err != nil || !mapping(root, "name", "description", "author", "inputs", "outputs", "runs", "branding") {
			return nil, ErrProfile
		}
		runs := field(root, "runs")
		if !mapping(runs, "using", "main", "pre", "pre-if", "post", "post-if") || !scalar(field(runs, "using")) || field(runs, "using").Value != "node24" {
			return nil, ErrProfile
		}
		for _, key := range []string{"main", "pre", "post"} {
			v := field(runs, key)
			if v == nil {
				if key == "main" {
					return nil, ErrProfile
				}
				continue
			}
			if !scalar(v) || !safePath(v.Value) || strings.Contains(v.Value, "${{") {
				return nil, ErrProfile
			}
			f, found := files[path.Join(directory, v.Value)]
			if !found || f.directory || f.mode == 0120000 || len(f.body) == 0 {
				return nil, ErrProfile
			}
		}
		identity := protocol.ActionRemoteIdentity{Uses: bundle.Uses, CommitID: bundle.CommitID, TreeID: treeID, ArchiveSHA256: bundle.ArchiveSHA256, MetadataSHA256: digest(metadata.body)}
		out[bundle.Uses] = &admittedRemoteAction{bundle: bundle, identity: identity, files: files, metadata: root}
	}
	return out, nil
}

func digest(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }

// Native act's cache interface is an offline byte consumer. The requested
// action stays remote and executes its genuine pre/main/post entrypoints.
type immutableActionCache struct {
	actions map[string]*admittedRemoteAction
}

func remoteActionInputs(step *yaml.Node, action *admittedRemoteAction) bool {
	with := field(step, "with")
	if with == nil {
		return true
	}
	if with.Kind != yaml.MappingNode || len(with.Content) > 64 {
		return false
	}
	for i := 0; i < len(with.Content); i += 2 {
		key, value := with.Content[i].Value, with.Content[i+1]
		if field(field(action.metadata, "inputs"), key) == nil || value.Kind != yaml.ScalarNode || strings.Contains(value.Value, "${{") {
			return false
		}
		// Exact-H/depth1 capabilities must not silently accept broader checkout.
		if strings.HasPrefix(action.bundle.Uses, "actions/checkout@") {
			switch key {
			case "persist-credentials", "clean", "show-progress", "set-safe-directory":
				if value.Value != "true" && value.Value != "false" {
					return false
				}
			case "fetch-depth":
				if value.Value != "1" {
					return false
				}
			case "fetch-tags", "lfs", "submodules":
				if value.Value != "false" {
					return false
				}
			case "path":
				if !safePath(value.Value) {
					return false
				}
			default:
				return false
			}
		}
		if strings.HasPrefix(action.bundle.Uses, "actions/setup-python@") && key == "cache" {
			return false
		}
	}
	return true
}

func (c immutableActionCache) Fetch(ctx context.Context, cacheDir, url, ref, token string) (string, error) {
	if ctx.Err() != nil {
		return "", ErrExecution
	}
	for uses, action := range c.actions {
		parts := protocol.RemoteActionReference.FindStringSubmatch(uses)
		if cacheDir == parts[1]+"/"+parts[2] && ref == parts[4] && url == "https://github.com/"+cacheDir {
			return action.bundle.CommitID, nil
		}
	}
	return "", ErrExecution
}
func (c immutableActionCache) GetTarArchive(ctx context.Context, cacheDir, commit, prefix string) (io.ReadCloser, error) {
	var selected *admittedRemoteAction
	for uses, action := range c.actions {
		parts := protocol.RemoteActionReference.FindStringSubmatch(uses)
		if cacheDir == parts[1]+"/"+parts[2] && commit == action.bundle.CommitID {
			selected = action
			break
		}
	}
	if selected == nil || ctx.Err() != nil {
		return nil, ErrExecution
	}
	prefix = path.Clean(prefix)
	if prefix != "." && !safePath(prefix) {
		return nil, ErrExecution
	}
	var names []string
	for name, f := range selected.files {
		if !f.directory && (prefix == "." || name == prefix || strings.HasPrefix(name, prefix+"/")) {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil, ErrExecution
	}
	sort.Strings(names)
	var out bytes.Buffer
	tw := tar.NewWriter(&out)
	for _, name := range names {
		f := selected.files[name]
		target := name
		if prefix != "." {
			target = strings.TrimPrefix(name, prefix+"/")
		}
		header := &tar.Header{Name: target, Mode: f.mode, Size: int64(len(f.body)), Typeflag: tar.TypeReg}
		if f.mode == 0120000 {
			header.Mode = 0777
			header.Size = 0
			header.Typeflag = tar.TypeSymlink
			header.Linkname = string(f.body)
		}
		if tw.WriteHeader(header) != nil {
			return nil, ErrExecution
		}
		if f.mode == 0120000 {
			continue
		}
		if _, err := tw.Write(f.body); err != nil {
			return nil, ErrExecution
		}
	}
	if tw.Close() != nil {
		return nil, ErrExecution
	}
	return io.NopCloser(bytes.NewReader(out.Bytes())), nil
}
