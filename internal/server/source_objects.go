package server

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
)

// Full object IDs reach native object APIs, never the branch-first contents
// resolver. Every response and blob is independently bound to that object.
type sourceTreeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
	Size int64  `json:"size"`
}
type sourceTree struct {
	SHA       string            `json:"sha"`
	Entries   []sourceTreeEntry `json:"tree"`
	Page      int               `json:"page"`
	Total     int               `json:"total_count"`
	Truncated bool              `json:"truncated"`
}

func sourceBlobHash(data []byte, width int) string { return sourceObjectHash("blob", data, width) }
func sourceObjectHash(kind string, data []byte, width int) string {
	prefix := []byte(kind + " " + strconv.Itoa(len(data)) + "\x00")
	if width == 40 {
		h := sha1.New()
		h.Write(prefix)
		h.Write(data)
		return fmt.Sprintf("%x", h.Sum(nil))
	}
	h := sha256.New()
	h.Write(prefix)
	h.Write(data)
	return fmt.Sprintf("%x", h.Sum(nil))
}
func sourceTreeHash(entries []sourceTreeEntry, width int) string {
	ordered := append([]sourceTreeEntry(nil), entries...)
	key := func(entry sourceTreeEntry) string {
		if entry.Type == "tree" {
			return entry.Path + "/"
		}
		return entry.Path
	}
	sort.Slice(ordered, func(i, j int) bool { return key(ordered[i]) < key(ordered[j]) })
	var raw []byte
	for _, entry := range ordered {
		raw = append(raw, []byte(strings.TrimLeft(entry.Mode, "0")+" "+entry.Path+"\x00")...)
		id, _ := hex.DecodeString(entry.SHA)
		raw = append(raw, id...)
	}
	return sourceObjectHash("tree", raw, width)
}
func sourceTreeKind(entry sourceTreeEntry) string {
	switch entry.Mode {
	case "040000":
		if entry.Type == "tree" {
			return "dir"
		}
	case "100644", "100755":
		if entry.Type == "blob" {
			return "file"
		}
	case "120000":
		if entry.Type == "blob" {
			return "symlink"
		}
	case "160000":
		if entry.Type == "commit" {
			return "submodule"
		}
	}
	return ""
}
func (s *Server) sourceCommitTree(ctx context.Context, base string, token forgeCredential, sha string) (string, error) {
	if !objectID.MatchString(sha) {
		return "", invalid("Select a full lowercase commit ID.")
	}
	var row struct {
		SHA    string `json:"sha"`
		Commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
	}
	query := url.Values{"stat": {"false"}, "files": {"false"}, "verification": {"false"}}
	_, err := s.forge(ctx, http.MethodGet, base+"/git/commits/"+sha+"?"+query.Encode(), token, nil, &row)
	if err != nil {
		return "", err
	}
	if row.SHA != sha || row.Commit.Tree.SHA != sha {
		return "", errInvalidForgeResponse
	}
	return row.Commit.Tree.SHA, nil
}
func (s *Server) sourceTreeEntries(ctx context.Context, base string, token forgeCredential, sha string, commitRoot bool) ([]sourceTreeEntry, error) {
	rows := make([]sourceTreeEntry, 0)
	seen := map[string]bool{}
	total, pageSize := -1, 0
	for pageNumber := 1; pageNumber <= maxDirectoryEntries+1; pageNumber++ {
		var page sourceTree
		query := url.Values{"page": {strconv.Itoa(pageNumber)}, "per_page": {strconv.Itoa(maxDirectoryEntries)}}
		_, err := s.forge(ctx, http.MethodGet, base+"/git/trees/"+sha+"?"+query.Encode(), token, nil, &page)
		if err != nil {
			return nil, err
		}
		if page.SHA != sha || page.Page != pageNumber || page.Total < 0 || total >= 0 && page.Total != total {
			return nil, errInvalidForgeResponse
		}
		if page.Total > maxDirectoryEntries {
			return nil, errForgeResponseTooLarge
		}
		total = page.Total
		if pageNumber == 1 {
			pageSize = len(page.Entries)
		}
		remaining := total - len(rows)
		if remaining < 0 || len(page.Entries) != min(pageSize, remaining) || page.Truncated != (len(rows)+len(page.Entries) < total) || remaining > 0 && pageSize == 0 {
			return nil, errInvalidForgeResponse
		}
		for _, entry := range page.Entries {
			if entry.Path == "" || !validSourcePath(entry.Path) || path.Base(entry.Path) != entry.Path || seen[entry.Path] || sourceTreeKind(entry) == "" || !objectID.MatchString(entry.SHA) || len(entry.SHA) != len(sha) || entry.Size < 0 {
				return nil, errInvalidForgeResponse
			}
			seen[entry.Path] = true
			rows = append(rows, entry)
		}
		if len(rows) == total {
			if !commitRoot && sourceTreeHash(rows, len(sha)) != sha {
				return nil, errInvalidForgeResponse
			}
			return rows, nil
		}
	}
	return nil, errForgeResponseTooLarge
}
func (s *Server) sourceObjectAtPath(ctx context.Context, base string, token forgeCredential, commit, requestedPath string) (sourceEntry, []sourceEntry, error) {
	if !validSourcePath(requestedPath) {
		return sourceEntry{}, nil, invalid("Select a literal relative source path.")
	}
	tree, err := s.sourceCommitTree(ctx, base, token, commit)
	if err != nil {
		return sourceEntry{}, nil, err
	}
	parts := strings.Split(requestedPath, "/")
	parent := ""
	for depth := 0; ; depth++ {
		entries, err := s.sourceTreeEntries(ctx, base, token, tree, depth == 0)
		if err != nil {
			return sourceEntry{}, nil, err
		}
		converted := make([]sourceEntry, 0, len(entries))
		var selected *sourceTreeEntry
		for i, entry := range entries {
			converted = append(converted, sourceEntry{Name: entry.Path, Path: path.Join(parent, entry.Path), Type: sourceTreeKind(entry), SHA: entry.SHA, Size: entry.Size})
			if requestedPath != "" && entry.Path == parts[depth] {
				selected = &entries[i]
			}
		}
		if requestedPath == "" {
			return sourceEntry{}, converted, nil
		}
		if selected == nil {
			return sourceEntry{}, nil, errResourceNotFound
		}
		current := sourceEntry{Name: selected.Path, Path: path.Join(parent, selected.Path), Type: sourceTreeKind(*selected), SHA: selected.SHA, Size: selected.Size}
		if depth == len(parts)-1 {
			if current.Type != "dir" {
				return current, nil, nil
			}
			tree = current.SHA
			parent = current.Path
			requestedPath = ""
			continue
		}
		if current.Type != "dir" {
			return sourceEntry{}, nil, errResourceNotFound
		}
		tree = current.SHA
		parent = current.Path
	}
}
func (s *Server) sourceBlob(ctx context.Context, base string, token forgeCredential, entry sourceEntry) ([]byte, error) {
	var row struct {
		SHA      string `json:"sha"`
		Size     int64  `json:"size"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
	}
	_, err := s.forge(ctx, http.MethodGet, base+"/git/blobs/"+entry.SHA, token, nil, &row)
	if err != nil {
		return nil, err
	}
	if row.SHA != entry.SHA || row.Size != entry.Size || row.Size > maxPreviewBytes || row.Encoding != "base64" {
		return nil, errInvalidForgeResponse
	}
	data, err := base64.StdEncoding.DecodeString(row.Content)
	if err != nil || int64(len(data)) != row.Size || sourceBlobHash(data, len(entry.SHA)) != entry.SHA {
		return nil, errInvalidForgeResponse
	}
	return data, nil
}
