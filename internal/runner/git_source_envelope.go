package runner

import (
	"archive/tar"
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"io"
	"path"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ValidGitSourcePath rejects paths unsafe for native Git metadata and checkout.
func ValidGitSourcePath(name string) bool {
	if name == "" || name == "." || len(name) > 4096 || strings.HasPrefix(name, "/") || path.Clean(name) != name || strings.Contains(name, "\\") || !utf8.ValidString(name) || strings.IndexFunc(name, func(value rune) bool { return unicode.IsControl(value) || unicode.Is(unicode.Cf, value) }) >= 0 {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.EqualFold(strings.TrimRight(part, " ."), ".git") || part == ".." || strings.TrimRight(part, " .") != part {
			return false
		}
	}
	return true
}

func ValidGitSourceLink(name, target string) bool {
	return ValidGitSourcePath(name) && target != "" && len(target) <= 1024 && path.Clean(target) == strings.TrimSuffix(target, "/") && !strings.HasPrefix(target, "/") && !strings.ContainsAny(target, "\\\x00\r\n") && ValidGitSourcePath(path.Clean(path.Join(path.Dir(name), target)))
}

// Compare the admitted ordinary archive against the fetched H tree, without
// extracting source or running checkout filters. ls-tree must be produced by
// the hermetic trusted Git process, not a coordinator-supplied file inventory.
func VerifyGitSourceSnapshot(archive, listing []byte, archiveSHA, commit, workflowPath, workflowBlob string) error {
	if validateGitSourceArchivePaths(archive) != nil {
		return ErrSource
	}
	digest := sha256.Sum256(archive)
	if len(archive) > (16<<20) || !(commitPattern.MatchString(archiveSHA) && len(archiveSHA) == 64) || hex.EncodeToString(digest[:]) != archiveSHA || !commitPattern.MatchString(commit) || len(listing) > 4<<20 || len(listing) == 0 || listing[len(listing)-1] != 0 || !ValidGitSourcePath(workflowPath) || !commitPattern.MatchString(workflowBlob) || len(workflowBlob) != len(commit) {
		return ErrSource
	}
	type object struct{ mode, id string }
	files := map[string]object{}
	directories := map[string]bool{}
	spellings := map[string]string{}
	canonical := func(name string) bool {
		key := strings.ToLower(name)
		if previous, ok := spellings[key]; ok && previous != name {
			return false
		}
		spellings[key] = name
		return true
	}
	for _, row := range bytes.Split(listing[:len(listing)-1], []byte{0}) {
		meta, name, ok := bytes.Cut(row, []byte{'\t'})
		fields := strings.Split(string(meta), " ")
		if !ok || len(fields) != 3 || fields[1] != "blob" || fields[0] != "100644" && fields[0] != "100755" && fields[0] != "120000" || !commitPattern.MatchString(fields[2]) || len(fields[2]) != len(commit) || (!ValidGitSourcePath(string(name)) || !canonical(string(name))) || len(files)+len(directories) >= 4096 {
			return ErrSource
		}
		if _, duplicate := files[string(name)]; duplicate {
			return ErrSource
		}
		files[string(name)] = object{fields[0], fields[2]}
		for parent := path.Dir(string(name)); parent != "."; parent = path.Dir(parent) {
			if !canonical(parent) {
				return ErrSource
			}
			if directories[parent] {
				break
			}
			if len(files)+len(directories) >= 4096 {
				return ErrSource
			}
			directories[parent] = true
		}
	}
	if files[workflowPath].id != workflowBlob || files[workflowPath].mode == "120000" {
		return ErrSource
	}
	for name := range files {
		if directories[name] {
			return ErrSource
		}
	}
	reader := bytes.NewReader(archive)
	tr := tar.NewReader(reader)
	seen := map[string]bool{}
	payload := int64(0)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return ErrSource
		}
		name := header.Name
		if !ValidGitSourcePath(name) || seen[name] || len(seen) >= 4096 || header.Size < 0 || header.Size > 8<<20 {
			return ErrSource
		}
		seen[name] = true
		if header.Typeflag == tar.TypeDir {
			if !directories[name] || header.Size != 0 {
				return ErrSource
			}
			continue
		}
		file, ok := files[name]
		link := header.Typeflag == tar.TypeSymlink && file.mode == "120000" && header.Size == 0 && ValidGitSourceLink(name, header.Linkname)
		if !ok || !link && (header.Typeflag != tar.TypeReg || header.Linkname != "" || file.mode == "120000" || (header.Mode&0111 != 0) != (file.mode == "100755")) {
			return ErrSource
		}
		payload += header.Size
		if payload > (16 << 20) {
			return ErrSource
		}
		var objectHash hash.Hash = sha256.New()
		if len(commit) == 40 {
			objectHash = sha1.New()
		}
		size := header.Size
		var body io.Reader = tr
		if link {
			size, body = int64(len(header.Linkname)), strings.NewReader(header.Linkname)
		}
		_, _ = io.WriteString(objectHash, "blob "+strconv.FormatInt(size, 10)+"\x00")
		if _, err := io.CopyN(objectHash, body, size); err != nil || hex.EncodeToString(objectHash.Sum(nil)) != file.id {
			return ErrSource
		}
		delete(files, name)
	}
	if len(files) != 0 || len(bytes.Trim(archive[len(archive)-reader.Len():], "\x00")) != 0 {
		return ErrSource
	}
	return nil
}

const GitSourceProfile = "golf.runner.git-source.exact-h.v1"
const GitSourceMetadataPath = "/golf/git-source.tar"
const GitSourceMetadataLimit = gitMetadataLimit

// This manifest contains public source identities only. Metadata is transferred
// separately to the fixed engine-owned file, never inserted into the admitted
// ordinary source archive or received from source actions.
type GitSourceManifest struct {
	Profile        string `json:"profile"`
	CommitID       string `json:"commitId"`
	TreeID         string `json:"treeId"`
	ArchiveSHA256  string `json:"archiveSha256"`
	WorkflowPath   string `json:"workflowPath"`
	WorkflowBlobID string `json:"workflowBlobId"`
	MetadataSHA256 string `json:"metadataSha256"`
}

// The caller must obtain prepared from the trusted sandbox for this same live
// attempt. This constructor independently binds its native tree listing to every
// admitted ordinary source byte/mode; no transformed source is substituted.
func NewGitSourceManifest(prepared GitPreparationResult, archive []byte, archiveSHA, commit, workflowPath, workflowBlob string) (*GitSourceManifest, error) {
	if VerifyGitSourceSnapshot(archive, prepared.Listing, archiveSHA, commit, workflowPath, workflowBlob) != nil {
		return nil, ErrSource
	}
	digest := sha256.Sum256(prepared.Metadata)
	manifest := &GitSourceManifest{Profile: GitSourceProfile, CommitID: commit, TreeID: prepared.TreeID, ArchiveSHA256: archiveSHA, WorkflowPath: workflowPath, WorkflowBlobID: workflowBlob, MetadataSHA256: hex.EncodeToString(digest[:])}
	if ValidateGitSource(manifest, prepared.Metadata, archive, commit, workflowPath, workflowBlob) != nil {
		return nil, ErrSource
	}
	return manifest, nil
}

// ValidateGitSource authenticates the immutable handoff bytes and closed metadata
// grammar. Native job Git must additionally prove the H/tree/workflow identities
// and compare its real ls-tree to the original archive before source steps run.
func ValidateGitSource(manifest *GitSourceManifest, metadata, archive []byte, commit, workflowPath, workflowBlob string) error {
	if manifest == nil || manifest.Profile != GitSourceProfile || !commitPattern.MatchString(commit) || manifest.CommitID != commit || !commitPattern.MatchString(manifest.TreeID) || len(manifest.TreeID) != len(commit) || manifest.WorkflowPath != workflowPath || !ValidGitSourcePath(workflowPath) || manifest.WorkflowBlobID != workflowBlob || !commitPattern.MatchString(workflowBlob) || len(workflowBlob) != len(commit) || !commitPattern.MatchString(manifest.ArchiveSHA256) || len(manifest.ArchiveSHA256) != 64 || !commitPattern.MatchString(manifest.MetadataSHA256) || len(manifest.MetadataSHA256) != 64 || len(archive) == 0 || len(archive) > 16<<20 || len(metadata) == 0 || len(metadata) > GitSourceMetadataLimit {
		return ErrSource
	}
	if validateGitSourceArchivePaths(archive) != nil {
		return ErrSource
	}
	sourceSHA := sha256.Sum256(archive)
	metadataSHA := sha256.Sum256(metadata)
	if hex.EncodeToString(sourceSHA[:]) != manifest.ArchiveSHA256 || hex.EncodeToString(metadataSHA[:]) != manifest.MetadataSHA256 {
		return ErrSource
	}
	reader := tar.NewReader(bytes.NewReader(metadata))
	var pack []byte
	var packID string
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil || h.Typeflag != tar.TypeReg || h.Size < 1 || h.Size > gitPackLimit || h.Linkname != "" || len(h.PAXRecords) != 0 {
			return ErrSource
		}
		if strings.HasSuffix(h.Name, ".pack") {
			if pack != nil {
				return ErrSource
			}
			id := strings.TrimSuffix(strings.TrimPrefix(h.Name, ".git/objects/pack/pack-"), ".pack")
			if !commitPattern.MatchString(id) || len(id) != len(commit) || h.Name != ".git/objects/pack/pack-"+id+".pack" {
				return ErrSource
			}
			pack, err = io.ReadAll(io.LimitReader(reader, h.Size+1))
			if err != nil || int64(len(pack)) != h.Size {
				return ErrSource
			}
			packID = id
		}
	}
	normalized, err := normalizeGitMetadata(metadata, pack, commit, packID)
	if err != nil || !bytes.Equal(normalized, metadata) {
		return ErrSource
	}
	return nil
}

// Reject materialization aliases before source bytes are copied. This remains a
// conservative Linux-container profile, not general cross-filesystem checkout.
func validateGitSourceArchivePaths(archive []byte) error {
	return ValidateGitSourceArchive(archive)
}

// Links must terminate at an admitted ordinary file/directory without traversing
// another link. This avoids cycles and lexical-versus-native path escapes.
func ValidateGitSourceArchive(archive []byte) error {
	if len(archive) == 0 || len(archive) > 16<<20 {
		return ErrSource
	}
	reader := tar.NewReader(bytes.NewReader(archive))
	seen := map[string]bool{}
	kinds, links := map[string]byte{}, map[string]string{}
	spellings := map[string]string{}
	entries := 0
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		link := h != nil && h.Typeflag == tar.TypeSymlink && h.Size == 0 && ValidGitSourceLink(h.Name, h.Linkname)
		if err != nil || !ValidGitSourcePath(h.Name) || seen[h.Name] || h.Linkname != "" && !link || h.Size < 0 || h.Size > 8<<20 || (h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir && !link) || h.Typeflag == tar.TypeDir && h.Size != 0 || len(h.PAXRecords) > 1 || len(h.PAXRecords) == 1 && h.PAXRecords["path"] != h.Name {
			return ErrSource
		}
		seen[h.Name] = true
		kinds[h.Name] = h.Typeflag
		if link {
			links[h.Name] = path.Clean(path.Join(path.Dir(h.Name), h.Linkname))
		}
		entries++
		if entries > 4096 {
			return ErrSource
		}
		for name := h.Name; name != "."; name = path.Dir(name) {
			key := strings.ToLower(name)
			if previous, exists := spellings[key]; exists && previous != name {
				return ErrSource
			}
			spellings[key] = name
			if len(spellings) > 4096 {
				return ErrSource
			}
		}
	}
	for name, kind := range kinds {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if k, exists := kinds[parent]; exists && k != tar.TypeDir {
				return ErrSource
			}
		}
		if kind == tar.TypeSymlink {
			target := links[name]
			if !seen[target] || kinds[target] == tar.TypeSymlink {
				return ErrSource
			}
			for parent := path.Dir(target); parent != "."; parent = path.Dir(parent) {
				if k, exists := kinds[parent]; exists && k != tar.TypeDir {
					return ErrSource
				}
			}
		}
	}
	return nil
}
