package main

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

func gitSnapshotPath(name string) bool {
	if name == "" || name == "." || len(name) > 4096 || strings.HasPrefix(name, "/") || path.Clean(name) != name || strings.Contains(name, "\\") || !utf8.ValidString(name) || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".git" || part == ".." {
			return false
		}
	}
	return true
}

// Compare the admitted ordinary archive against the fetched H tree, without
// extracting source or running checkout filters. ls-tree must be produced by
// the hermetic trusted Git process, not a coordinator-supplied file inventory.
func verifyGitSnapshot(archive, listing []byte, archiveSHA, commit, workflowPath, workflowBlob string) error {
	digest := sha256.Sum256(archive)
	if len(archive) > sourceLimit || !hashID.MatchString(archiveSHA) || hex.EncodeToString(digest[:]) != archiveSHA || !commitID.MatchString(commit) || len(listing) > 4<<20 || len(listing) == 0 || listing[len(listing)-1] != 0 || !gitSnapshotPath(workflowPath) || !commitID.MatchString(workflowBlob) || len(workflowBlob) != len(commit) {
		return errTransport
	}
	type object struct{ mode, id string }
	files := map[string]object{}
	directories := map[string]bool{}
	for _, row := range bytes.Split(listing[:len(listing)-1], []byte{0}) {
		meta, name, ok := bytes.Cut(row, []byte{'\t'})
		fields := strings.Split(string(meta), " ")
		if !ok || len(fields) != 3 || fields[1] != "blob" || fields[0] != "100644" && fields[0] != "100755" || !commitID.MatchString(fields[2]) || len(fields[2]) != len(commit) || !gitSnapshotPath(string(name)) || len(files)+len(directories) >= 4096 {
			return errTransport
		}
		if _, duplicate := files[string(name)]; duplicate {
			return errTransport
		}
		files[string(name)] = object{fields[0], fields[2]}
		for parent := path.Dir(string(name)); parent != "."; parent = path.Dir(parent) {
			if directories[parent] {
				break
			}
			if len(files)+len(directories) >= 4096 {
				return errTransport
			}
			directories[parent] = true
		}
	}
	if files[workflowPath].id != workflowBlob {
		return errTransport
	}
	for name := range files {
		if directories[name] {
			return errTransport
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
			return errTransport
		}
		name := header.Name
		if !gitSnapshotPath(name) || seen[name] || len(seen) >= 4096 || header.Linkname != "" || header.Size < 0 || header.Size > 8<<20 {
			return errTransport
		}
		seen[name] = true
		if header.Typeflag == tar.TypeDir {
			if !directories[name] || header.Size != 0 {
				return errTransport
			}
			continue
		}
		file, ok := files[name]
		if !ok || header.Typeflag != tar.TypeReg || (header.Mode&0111 != 0) != (file.mode == "100755") {
			return errTransport
		}
		payload += header.Size
		if payload > sourceLimit {
			return errTransport
		}
		var objectHash hash.Hash = sha256.New()
		if len(commit) == 40 {
			objectHash = sha1.New()
		}
		_, _ = io.WriteString(objectHash, "blob "+strconv.FormatInt(header.Size, 10)+"\x00")
		if _, err := io.CopyN(objectHash, tr, header.Size); err != nil || hex.EncodeToString(objectHash.Sum(nil)) != file.id {
			return errTransport
		}
		delete(files, name)
	}
	if len(files) != 0 || len(bytes.Trim(archive[len(archive)-reader.Len():], "\x00")) != 0 {
		return errTransport
	}
	return nil
}
