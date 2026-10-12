package runner

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// Operator-acquired immutable action bytes travel separately from the original
// repository archive. Git commit/tree validation and the frozen plan bind them
// again inside the native engine; no source-selected network resolver is used.
type ActionBundle struct {
	Uses          string `json:"uses"`
	CommitID      string `json:"commitId"`
	Commit        []byte `json:"commit"`
	Archive       []byte `json:"archive"`
	ArchiveSHA256 string `json:"archiveSha256"`
}
type ActionRemoteIdentity struct {
	Uses           string `json:"uses"`
	CommitID       string `json:"commitId"`
	TreeID         string `json:"treeId"`
	ArchiveSHA256  string `json:"archiveSha256"`
	MetadataSHA256 string `json:"metadataSha256"`
}

var RemoteActionReference = regexp.MustCompile(`^([A-Za-z0-9_-]{1,64})/([A-Za-z0-9_.-]{1,64})(/[A-Za-z0-9_./-]{1,256})?@([A-Za-z0-9_./-]{1,128})$`)

func (b ActionBundle) Validate() error {
	ref := RemoteActionReference.FindStringSubmatch(b.Uses)
	hash := sha256.Sum256(b.Archive)
	commit := sha1.Sum(append([]byte(fmt.Sprintf("commit %d\x00", len(b.Commit))), b.Commit...))
	if len(ref) != 5 || len(b.CommitID) != 40 || hex.EncodeToString(commit[:]) != b.CommitID || len(b.Commit) == 0 || len(b.Commit) > 64<<10 || len(b.Archive) == 0 || len(b.Archive) > 16<<20 || hex.EncodeToString(hash[:]) != b.ArchiveSHA256 {
		return ErrInvalidJob
	}
	if len(ref[4]) == 40 && ref[4] != b.CommitID {
		return ErrInvalidJob
	}
	return nil
}

func ReadActionBundles(filename string) ([]ActionBundle, error) {
	if !filepath.IsAbs(filename) || filepath.Clean(filename) != filename {
		return nil, ErrInvalidJob
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, ErrInfrastructure
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 32<<20 {
		return nil, ErrInvalidJob
	}
	data, err := io.ReadAll(io.LimitReader(file, 32<<20+1))
	if err != nil || len(data) > 32<<20 {
		return nil, ErrInvalidJob
	}
	var bundles []ActionBundle
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&bundles) != nil || d.Decode(new(any)) != io.EOF || len(bundles) == 0 || len(bundles) > 8 {
		return nil, ErrInvalidJob
	}
	seen := map[string]bool{}
	for _, bundle := range bundles {
		if bundle.Validate() != nil || seen[bundle.Uses] {
			return nil, ErrInvalidJob
		}
		seen[bundle.Uses] = true
	}
	return bundles, nil
}
