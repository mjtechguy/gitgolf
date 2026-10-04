package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// This is a positive selected-head observation, not a directory history scan.
// The native first-parent file status cannot prove merge path-history semantics.
func (s *Server) projectHeadChanges(ctx context.Context, base string, token forgeCredential, head string, entries []sourceEntry) error {
	query := url.Values{"files": {"true"}, "stat": {"false"}, "verification": {"false"}}
	response, err := s.forgeRequest(ctx, http.MethodGet, base+"/git/commits/"+head+"?"+query.Encode(), "application/json", token, nil)
	if err != nil {
		var upstream forgeError
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.As(err, &upstream) && (upstream.status == 401 || upstream.status == 403 || upstream.status == 404) {
			return err
		}
		return nil // Optional malformed/unavailable metadata never invents a change.
	}
	defer response.Body.Close()
	if response.ContentLength > 256<<10 {
		return nil
	}
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, (256<<10)+1))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if readErr != nil || len(raw) > 256<<10 {
		return nil
	}
	row, paths, ok := validatedHeadChanges(raw, head)
	if !ok {
		return nil
	}
	matched := make([]int, 0, len(entries))
	for i := range entries {
		entry := &entries[i]
		for name, status := range paths {
			if entry.Type == "dir" && strings.HasPrefix(name, entry.Path+"/") || entry.Type != "dir" && name == entry.Path && status != "removed" {
				matched = append(matched, i)
				break
			}
		}
	}
	// Repeating a large commit body across a wide directory must stay bounded.
	encoded, err := json.Marshal(row)
	if err != nil || len(encoded)*len(matched) > 1<<20 {
		return nil
	}
	for _, i := range matched {
		entries[i].LatestChange = &row
	}
	return nil
}

func validatedHeadChanges(raw []byte, head string) (forgeCommit, map[string]string, bool) {
	var row struct {
		forgeCommit
		Parents *[]struct {
			SHA string `json:"sha"`
		} `json:"parents"`
		Files *[]struct {
			Filename string `json:"filename"`
			Status   string `json:"status"`
		} `json:"files"`
		Truncated bool `json:"truncated"`
	}
	if len(raw) > 256<<10 || json.Unmarshal(raw, &row) != nil || row.SHA != head || !objectID.MatchString(head) || !validHistoryCommit(row.forgeCommit) || row.Parents == nil || len(*row.Parents) > 1 || row.Files == nil || len(*row.Files) > maxDirectoryEntries || row.Truncated {
		return forgeCommit{}, nil, false
	}
	for _, parent := range *row.Parents {
		if !objectID.MatchString(parent.SHA) || len(parent.SHA) != len(head) || parent.SHA == head {
			return forgeCommit{}, nil, false
		}
	}
	paths := make(map[string]string, len(*row.Files))
	for _, file := range *row.Files {
		if file.Filename == "" || !validSourcePath(file.Filename) || paths[file.Filename] != "" || (file.Status != "added" && file.Status != "modified" && file.Status != "removed") {
			return forgeCommit{}, nil, false
		}
		paths[file.Filename] = file.Status
	}
	return row.forgeCommit, paths, true
}
