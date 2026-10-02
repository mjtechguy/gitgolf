package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

const maxPreviewBytes = 256 << 10
const maxDirectoryEntries = 1000

var repositoryComponent = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
var objectID = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// Browser routes accept data, never an upstream URL or a Git revision expression.
func browserInput(w http.ResponseWriter, r *http.Request, allowed ...string) (string, url.Values, bool) {
	owner, repo := chi.URLParam(r, "owner"), chi.URLParam(r, "repo")
	for _, name := range []string{owner, repo} {
		if !repositoryComponent.MatchString(name) || name == "." || name == ".." {
			problem(w, 400, "invalid_repository", "Owner and repository must be valid name components.")
			return "", nil, false
		}
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(r.URL.RawQuery) > 8192 {
		problem(w, 400, "invalid_query", "The query is malformed or too long.")
		return "", nil, false
	}
	for name, values := range query {
		known := false
		for _, candidate := range allowed {
			known = known || name == candidate
		}
		if !known || len(values) != 1 {
			problem(w, 400, "invalid_query", "Use only the documented query parameters, once each.")
			return "", nil, false
		}
	}
	return "/repos/" + owner + "/" + repo, query, true
}

func browserPage(w http.ResponseWriter, query url.Values) (int, int, bool) {
	page, limit := 1, 20
	for _, item := range []struct {
		key string
		max int
		dst *int
	}{{"page", 10000, &page}, {"limit", 100, &limit}} {
		if values, exists := query[item.key]; exists {
			value, err := strconv.Atoi(values[0])
			if err != nil || value < 1 || value > item.max || strconv.Itoa(value) != values[0] {
				problem(w, 400, "invalid_pagination", "Page must be 1–10000 and limit must be 1–100.")
				return 0, 0, false
			}
			*item.dst = value
		}
	}
	return page, limit, true
}

func validRef(ref string) bool {
	if ref == "" {
		return true
	}
	if len(ref) > 1024 || !utf8.ValidString(ref) || ref == "@" || strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, " ~^:?*[\\") || strings.Contains(ref, "..") || strings.Contains(ref, "@{") {
		return false
	}
	for _, part := range strings.Split(ref, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return strings.IndexFunc(ref, unicode.IsControl) == -1
}

func validSourcePath(value string) bool {
	if len(value) > 4096 || !utf8.ValidString(value) || strings.Contains(value, "\\") || strings.IndexFunc(value, unicode.IsControl) != -1 {
		return false
	}
	if value == "" {
		return true
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func pageResponse(w http.ResponseWriter, key string, value any, headers http.Header, page int) {
	result := map[string]any{key: value}
	if strings.Contains(headers.Get("Link"), `rel="next"`) && page < 10000 {
		result["next_page"] = page + 1
	}
	respond(w, 200, result)
}

func (s *Server) repository(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	base, _, ok := browserInput(w, r)
	if !ok {
		return
	}
	repo, err := s.readRepository(r.Context(), base, token)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	respond(w, 200, map[string]any{"repository": repo})
}

func (s *Server) readRepository(ctx context.Context, base, token string) (Repository, error) {
	var repo Repository
	_, err := s.forge(ctx, "GET", base, token, nil, &repo)
	if err == nil && (repo.ID <= 0 || repo.Name == "" || repo.FullName == "") {
		err = errors.New("invalid repository metadata")
	}
	return repo, err
}

type branch struct {
	Name      string `json:"name"`
	CommitID  string `json:"commit_id"`
	Protected bool   `json:"protected"`
}

func (s *Server) branches(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	base, query, ok := browserInput(w, r, "page", "limit")
	if !ok {
		return
	}
	page, limit, ok := browserPage(w, query)
	if !ok {
		return
	}
	// Gitea 1.27.3 can fail branch reads while its first-push metadata is
	// still empty. Honor that state; a later refresh observes the new head.
	repo, err := s.readRepository(r.Context(), base, token)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	if repo.Empty {
		respond(w, 200, map[string]any{"branches": []branch{}})
		return
	}
	query.Set("page", strconv.Itoa(page))
	query.Set("limit", strconv.Itoa(limit))
	var rows []struct {
		Name      string `json:"name"`
		Protected bool   `json:"protected"`
		Commit    struct {
			ID string `json:"id"`
		} `json:"commit"`
	}
	headers, err := s.forge(r.Context(), "GET", base+"/branches?"+query.Encode(), token, nil, &rows)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	if len(rows) > limit {
		s.forgeProblem(w, errForgeResponseTooLarge)
		return
	}
	result := make([]branch, 0, len(rows))
	for _, row := range rows {
		if row.Name == "" || !validRef(row.Name) || !objectID.MatchString(row.Commit.ID) {
			problem(w, 502, "invalid_forge_response", "Gitea returned invalid branch metadata.")
			return
		}
		result = append(result, branch{row.Name, row.Commit.ID, row.Protected})
	}
	pageResponse(w, "branches", result, headers, page)
}

type forgeCommit struct {
	SHA    string `json:"sha"`
	Commit struct {
		Message string `json:"message"`
		Author  struct {
			Name string `json:"name"`
			Date string `json:"date"`
		} `json:"author"`
	} `json:"commit"`
}

func (s *Server) readCommits(ctx context.Context, base, token, ref string, page, limit int) ([]forgeCommit, http.Header, error) {
	query := url.Values{"page": {strconv.Itoa(page)}, "limit": {strconv.Itoa(limit)}, "stat": {"false"}, "verification": {"false"}, "files": {"false"}}
	if ref != "" {
		query.Set("sha", ref)
	}
	rows := []forgeCommit{}
	headers, err := s.forge(ctx, "GET", base+"/commits?"+query.Encode(), token, nil, &rows)
	if err == nil && len(rows) > limit {
		err = errForgeResponseTooLarge
	}
	for _, row := range rows {
		if !objectID.MatchString(row.SHA) {
			err = errors.New("invalid commit metadata")
		}
	}
	return rows, headers, err
}

func (s *Server) commitProblem(w http.ResponseWriter, err error) {
	var upstream forgeError
	if errors.As(err, &upstream) && upstream.status == 409 {
		problem(w, 409, "empty_repository", "This repository has no commits yet.")
		return
	}
	s.forgeProblem(w, err)
}

func (s *Server) commits(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	base, query, ok := browserInput(w, r, "ref", "page", "limit")
	if !ok {
		return
	}
	page, limit, ok := browserPage(w, query)
	if !ok {
		return
	}
	if !validRef(query.Get("ref")) {
		problem(w, 400, "invalid_ref", "Select a branch, tag or commit ID, not a revision expression.")
		return
	}
	rows, headers, err := s.readCommits(r.Context(), base, token, query.Get("ref"), page, limit)
	if err != nil {
		var upstream forgeError
		if errors.As(err, &upstream) && upstream.status == 409 {
			respond(w, 200, map[string]any{"commits": []forgeCommit{}})
			return
		}
		s.commitProblem(w, err)
		return
	}
	type commit struct {
		SHA        string `json:"sha"`
		Message    string `json:"message"`
		AuthorName string `json:"author_name"`
		AuthoredAt string `json:"authored_at"`
	}
	result := make([]commit, 0, len(rows))
	for _, row := range rows {
		result = append(result, commit{row.SHA, row.Commit.Message, row.Commit.Author.Name, row.Commit.Author.Date})
	}
	pageResponse(w, "commits", result, headers, page)
}

type sourceEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
	Size int64  `json:"size"`
}

type forgeContents struct {
	sourceEntry
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
	LFSOID   string `json:"lfs_oid"`
}

type contentsEnvelope struct {
	Directory []forgeContents `json:"dir_contents"`
	File      *forgeContents  `json:"file_contents"`
}

type sourceFile struct {
	sourceEntry
	Content       *string `json:"content,omitempty"`
	PreviewReason string  `json:"preview_reason,omitempty"`
}

func validEntry(entry sourceEntry) bool {
	return entry.Path != "" && validSourcePath(entry.Path) && path.Base(entry.Path) == entry.Name && objectID.MatchString(entry.SHA) && entry.Size >= 0 && (entry.Type == "dir" || entry.Type == "file" || entry.Type == "symlink" || entry.Type == "submodule")
}

func escapedSourcePath(value string) string {
	if value == "" {
		return "."
	}
	parts := strings.Split(value, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

func (s *Server) contents(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	base, query, ok := browserInput(w, r, "ref", "path")
	if !ok {
		return
	}
	ref, requestedPath := query.Get("ref"), query.Get("path")
	if !validRef(ref) || !validSourcePath(requestedPath) {
		problem(w, 400, "invalid_source", "Use a valid ref and a relative repository path without dot segments.")
		return
	}
	commits, _, err := s.readCommits(r.Context(), base, token, ref, 1, 1)
	if err != nil {
		s.commitProblem(w, err)
		return
	}
	if len(commits) != 1 {
		problem(w, 404, "not_found", "No commit is available for this ref.")
		return
	}
	commitID := commits[0].SHA
	query = url.Values{"ref": {commitID}, "includes": {"lfs_metadata"}}
	endpoint := base + "/contents-ext/" + escapedSourcePath(requestedPath)
	var metadata contentsEnvelope
	if _, err := s.forge(r.Context(), "GET", endpoint+"?"+query.Encode(), token, nil, &metadata); err != nil {
		s.forgeProblem(w, err)
		return
	}
	result := map[string]any{"commit_id": commitID, "path": requestedPath}
	if metadata.File == nil {
		if metadata.Directory == nil {
			problem(w, 502, "invalid_forge_response", "Gitea returned no source metadata.")
			return
		}
		if len(metadata.Directory) > maxDirectoryEntries {
			s.forgeProblem(w, errForgeResponseTooLarge)
			return
		}
		entries := make([]sourceEntry, 0, len(metadata.Directory))
		for _, entry := range metadata.Directory {
			parent := path.Dir(entry.Path)
			if parent == "." {
				parent = ""
			}
			if !validEntry(entry.sourceEntry) || parent != requestedPath {
				problem(w, 502, "invalid_forge_response", "Gitea returned inconsistent directory metadata.")
				return
			}
			entries = append(entries, entry.sourceEntry)
		}
		result["kind"], result["entries"] = "directory", entries
		respond(w, 200, result)
		return
	}
	entry := metadata.File
	if !validEntry(entry.sourceEntry) || entry.Path != requestedPath || entry.Type == "dir" || metadata.Directory != nil {
		problem(w, 502, "invalid_forge_response", "Gitea returned inconsistent file metadata.")
		return
	}
	file := sourceFile{sourceEntry: entry.sourceEntry}
	switch {
	case entry.Type == "symlink":
		file.PreviewReason = "Symbolic links are metadata-only; Golf does not follow their targets."
	case entry.Type == "submodule":
		file.PreviewReason = "Submodules are metadata-only; Golf does not fetch another repository."
	case entry.LFSOID != "":
		file.PreviewReason = "Git LFS objects are metadata-only; Golf does not download the large object."
	case entry.Size > maxPreviewBytes:
		file.PreviewReason = "This file exceeds the 256 KiB preview limit."
	default:
		query.Set("includes", "file_content,lfs_metadata")
		var content contentsEnvelope
		if _, err := s.forge(r.Context(), "GET", endpoint+"?"+query.Encode(), token, nil, &content); err != nil {
			s.forgeProblem(w, err)
			return
		}
		if content.File == nil || content.File.sourceEntry != entry.sourceEntry || content.Directory != nil {
			problem(w, 502, "invalid_forge_response", "Gitea returned content that does not match its pinned metadata.")
			return
		}
		if content.File.LFSOID != "" {
			file.PreviewReason = "Git LFS objects are metadata-only; Golf does not download the large object."
		} else if content.File.Encoding != "base64" {
			problem(w, 502, "invalid_forge_response", "Gitea returned an unsupported file encoding.")
			return
		} else {
			data, err := base64.StdEncoding.DecodeString(content.File.Content)
			if err != nil || int64(len(data)) != entry.Size {
				problem(w, 502, "invalid_forge_response", "Gitea returned inconsistent file contents.")
				return
			}
			switch {
			case len(data) > maxPreviewBytes:
				file.PreviewReason = "This file exceeds the 256 KiB preview limit."
			case strings.HasPrefix(string(data), "version https://git-lfs.github.com/spec/v1\n") || strings.HasPrefix(string(data), "version https://git-lfs.github.com/spec/v1\r\n"):
				file.PreviewReason = "Git LFS pointers are metadata-only."
			case !utf8.Valid(data) || strings.IndexFunc(string(data), func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) != -1:
				file.PreviewReason = "Binary or non-text content cannot be previewed."
			default:
				text := string(data)
				file.Content = &text
			}
		}
	}
	result["kind"], result["file"] = entry.Type, file
	respond(w, 200, result)
}

type Issue struct {
	ID        int64  `json:"id"`
	Number    int64  `json:"number"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	State     string `json:"state"`
	User      User   `json:"user"`
	Comments  int64  `json:"comments"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	HTMLURL   string `json:"html_url"`
}

type forgeIssue struct {
	Issue
	PullRequest json.RawMessage `json:"pull_request"`
}

func (issue forgeIssue) isPullRequest() bool {
	return len(issue.PullRequest) != 0 && string(issue.PullRequest) != "null"
}

func validIssue(issue Issue) bool {
	return issue.ID > 0 && issue.Number > 0 && (issue.State == "open" || issue.State == "closed") && issue.Comments >= 0
}

func (s *Server) issues(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	base, query, ok := browserInput(w, r, "state", "page", "limit")
	if !ok {
		return
	}
	page, limit, ok := browserPage(w, query)
	if !ok {
		return
	}
	state := query.Get("state")
	if state == "" {
		state = "open"
	}
	if state != "open" && state != "closed" && state != "all" {
		problem(w, 400, "invalid_state", "Issue state must be open, closed or all.")
		return
	}
	query.Set("state", state)
	query.Set("type", "issues")
	query.Set("page", strconv.Itoa(page))
	query.Set("limit", strconv.Itoa(limit))
	var rows []forgeIssue
	headers, err := s.forge(r.Context(), "GET", base+"/issues?"+query.Encode(), token, nil, &rows)
	if err != nil {
		s.forgeProblem(w, err)
		return
	}
	if len(rows) > limit {
		s.forgeProblem(w, errForgeResponseTooLarge)
		return
	}
	result := make([]Issue, 0, len(rows))
	for _, row := range rows {
		if row.isPullRequest() {
			continue
		}
		if !validIssue(row.Issue) {
			problem(w, 502, "invalid_forge_response", "Gitea returned invalid issue metadata.")
			return
		}
		result = append(result, row.Issue)
	}
	pageResponse(w, "issues", result, headers, page)
}

func (s *Server) issue(w http.ResponseWriter, r *http.Request) {
	token, ok := s.token(w, r)
	if !ok {
		return
	}
	base, _, ok := browserInput(w, r)
	if !ok {
		return
	}
	raw := chi.URLParam(r, "number")
	number, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || number < 1 || strconv.FormatInt(number, 10) != raw {
		problem(w, 400, "invalid_issue", "Issue number must be a positive integer.")
		return
	}
	var row forgeIssue
	if _, err := s.forge(r.Context(), "GET", base+"/issues/"+raw, token, nil, &row); err != nil {
		s.forgeProblem(w, err)
		return
	}
	if row.isPullRequest() {
		problem(w, 404, "not_found", "This resource does not exist or is not accessible.")
		return
	}
	if !validIssue(row.Issue) || row.Number != number {
		problem(w, 502, "invalid_forge_response", "Gitea returned invalid issue metadata.")
		return
	}
	respond(w, 200, map[string]any{"issue": row.Issue})
}
