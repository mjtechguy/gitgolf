package server

import (
	"context"
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

	"github.com/mjtechguy/golf-git/internal/gitinput"
)

const maxPreviewBytes = 256 << 10
const maxDirectoryEntries = 1000

var repositoryComponent = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
var repositoryName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
var objectID = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

type repositoryKey struct{ Owner, Name string }
type pageRequest struct{ Page, Limit uint32 }

func repositoryPath(key repositoryKey) (string, error) {
	for _, name := range []string{key.Owner, key.Name} {
		if !repositoryComponent.MatchString(name) || name == "." || name == ".." {
			return "", invalid("Owner and repository must be valid name components.")
		}
	}
	return "/repos/" + key.Owner + "/" + key.Name, nil
}
func pagination(page pageRequest) (uint32, uint32, error) {
	if page.Page == 0 {
		page.Page = 1
	}
	if page.Limit == 0 {
		page.Limit = 20
	}
	if page.Page > 10000 || page.Limit > 100 {
		return 0, 0, invalid("Page must be 1–10000 and limit must be 1–100.")
	}
	return page.Page, page.Limit, nil
}
func pageQuery(page, limit uint32) url.Values {
	return url.Values{"page": {strconv.FormatUint(uint64(page), 10)}, "limit": {strconv.FormatUint(uint64(limit), 10)}}
}
func nextPage(headers http.Header, page uint32) uint32 {
	if strings.Contains(headers.Get("Link"), `rel="next"`) && page < 10000 {
		return page + 1
	}
	return 0
}
func validRef(ref string) bool          { return gitinput.ValidRef(ref) }
func validSourcePath(value string) bool { return gitinput.ValidSourcePath(value) }
func (s *Server) listRepositories(ctx context.Context, token forgeCredential, paging pageRequest) ([]Repository, uint32, error) {
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	repos := []Repository{}
	headers, err := s.forge(ctx, "GET", "/user/repos?"+pageQuery(page, limit).Encode(), token, nil, &repos)
	if err != nil {
		return nil, 0, err
	}
	if len(repos) > int(limit) {
		return nil, 0, errForgeResponseTooLarge
	}
	for _, repo := range repos {
		if !validRepository(repo) {
			return nil, 0, errInvalidForgeResponse
		}
	}
	return repos, nextPage(headers, page), nil
}
func validRepository(repo Repository) bool {
	return repo.ID > 0 && repo.Name != "" && repo.FullName != ""
}
func (s *Server) getRepository(ctx context.Context, token forgeCredential, key repositoryKey) (Repository, error) {
	base, err := repositoryPath(key)
	if err != nil {
		return Repository{}, err
	}
	return s.readRepository(ctx, base, token)
}
func (s *Server) readRepository(ctx context.Context, base string, token forgeCredential) (Repository, error) {
	var repo Repository
	_, err := s.forge(ctx, "GET", base, token, nil, &repo)
	if err == nil && !validRepository(repo) {
		err = errInvalidForgeResponse
	}
	return repo, err
}

type branch struct {
	Name      string `json:"name"`
	CommitID  string `json:"commit_id"`
	Protected bool   `json:"protected"`
}

func (s *Server) listBranches(ctx context.Context, token forgeCredential, key repositoryKey, paging pageRequest) ([]branch, uint32, error) {
	base, err := repositoryPath(key)
	if err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	// Gitea 1.27.3 can fail branch reads while first-push metadata is still empty.
	repo, err := s.readRepository(ctx, base, token)
	if err != nil {
		return nil, 0, err
	}
	if repo.Empty {
		return []branch{}, 0, nil
	}
	var rows []struct {
		Name      string `json:"name"`
		Protected bool   `json:"protected"`
		Commit    struct {
			ID string `json:"id"`
		} `json:"commit"`
	}
	headers, err := s.forge(ctx, "GET", base+"/branches?"+pageQuery(page, limit).Encode(), token, nil, &rows)
	if err != nil {
		return nil, 0, err
	}
	if len(rows) > int(limit) {
		return nil, 0, errForgeResponseTooLarge
	}
	result := make([]branch, 0, len(rows))
	for _, row := range rows {
		if row.Name == "" || !validRef(row.Name) || !objectID.MatchString(row.Commit.ID) {
			return nil, 0, errInvalidForgeResponse
		}
		result = append(result, branch{row.Name, row.Commit.ID, row.Protected})
	}
	return result, nextPage(headers, page), nil
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

func (s *Server) readCommits(ctx context.Context, base string, token forgeCredential, ref string, page, limit uint32) ([]forgeCommit, http.Header, error) {
	query := pageQuery(page, limit)
	query.Set("stat", "false")
	query.Set("verification", "false")
	query.Set("files", "false")
	if ref != "" {
		query.Set("sha", ref)
	}
	rows := []forgeCommit{}
	headers, err := s.forge(ctx, "GET", base+"/commits?"+query.Encode(), token, nil, &rows)
	var upstream forgeError
	if errors.As(err, &upstream) && upstream.status == 409 {
		err = errEmptyRepository
	}
	if err == nil && len(rows) > int(limit) {
		err = errForgeResponseTooLarge
	}
	for _, row := range rows {
		if !objectID.MatchString(row.SHA) {
			err = errInvalidForgeResponse
		}
	}
	return rows, headers, err
}
func (s *Server) listCommits(ctx context.Context, token forgeCredential, key repositoryKey, ref string, paging pageRequest) ([]forgeCommit, uint32, error) {
	base, err := repositoryPath(key)
	if err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	if !validRef(ref) {
		return nil, 0, invalid("Select a branch, tag or commit ID, not a revision expression.")
	}
	rows, headers, err := s.readCommits(ctx, base, token, ref, page, limit)
	if errors.Is(err, errEmptyRepository) {
		return []forgeCommit{}, 0, nil
	}
	return rows, nextPage(headers, page), err
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
type sourceResult struct {
	RepositoryID         int64
	CommitID, Path, Kind string
	Entries              []sourceEntry
	File                 *sourceFile
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
func (s *Server) getContents(ctx context.Context, token forgeCredential, key repositoryKey, ref, requestedPath string) (sourceResult, error) {
	return s.getBoundContents(ctx, "", token, key, 0, ref, requestedPath)
}
func (s *Server) readContentsAtCommit(ctx context.Context, base string, token forgeCredential, commit, requestedPath string) (sourceResult, error) {
	result := sourceResult{CommitID: commit, Path: requestedPath}
	entry, entries, err := s.sourceObjectAtPath(ctx, base, token, commit, requestedPath)
	if err != nil {
		return sourceResult{}, err
	}
	if entries != nil {
		result.Kind, result.Entries = "dir", entries
		return result, nil
	}
	file := &sourceFile{sourceEntry: entry}
	switch {
	case entry.Type == "symlink":
		file.PreviewReason = "Symbolic links are metadata-only; Golf does not follow their targets."
	case entry.Type == "submodule":
		file.PreviewReason = "Submodules are metadata-only; Golf does not fetch another repository."
	case entry.Size > maxPreviewBytes:
		file.PreviewReason = "This file exceeds the 256 KiB preview limit."
	default:
		data, err := s.sourceBlob(ctx, base, token, entry)
		if err != nil {
			return sourceResult{}, err
		}
		switch {
		case strings.HasPrefix(string(data), "version https://git-lfs.github.com/spec/v1\n") || strings.HasPrefix(string(data), "version https://git-lfs.github.com/spec/v1\r\n"):
			file.PreviewReason = "Git LFS pointers are metadata-only."
		case !utf8.Valid(data) || strings.IndexFunc(string(data), func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) != -1:
			file.PreviewReason = "Binary or non-text content cannot be previewed."
		default:
			text := string(data)
			file.Content = &text
		}
	}
	result.Kind, result.File = entry.Type, file
	return result, nil
}

type Issue struct {
	ContentVersion *int64 `json:"content_version"`
	ID             int64  `json:"id"`
	Number         int64  `json:"number"`
	Title          string `json:"title"`
	Body           string `json:"body"`
	State          string `json:"state"`
	User           User   `json:"user"`
	Comments       int64  `json:"comments"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
	HTMLURL        string `json:"html_url"`
}
type forgeIssue struct {
	Issue
	PullRequest json.RawMessage `json:"pull_request"`
}

func (issue forgeIssue) isPullRequest() bool {
	return len(issue.PullRequest) != 0 && string(issue.PullRequest) != "null"
}
func validIssue(issue Issue) bool {
	return issue.ID > 0 && issue.Number > 0 && issue.Number <= 2147483647 && (issue.State == "open" || issue.State == "closed") && issue.Comments >= 0 && issue.Comments <= 4294967295 && (issue.ContentVersion == nil || *issue.ContentVersion >= 0)
}
func (s *Server) listIssues(ctx context.Context, token forgeCredential, key repositoryKey, state string, paging pageRequest) ([]Issue, uint32, error) {
	base, err := repositoryPath(key)
	if err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	if state == "" {
		state = "open"
	}
	if state != "open" && state != "closed" && state != "all" {
		return nil, 0, invalid("Issue state must be open, closed or all.")
	}
	query := pageQuery(page, limit)
	query.Set("state", state)
	query.Set("type", "issues")
	var rows []forgeIssue
	headers, err := s.forge(ctx, "GET", base+"/issues?"+query.Encode(), token, nil, &rows)
	if err != nil {
		return nil, 0, err
	}
	if len(rows) > int(limit) {
		return nil, 0, errForgeResponseTooLarge
	}
	result := make([]Issue, 0, len(rows))
	for _, row := range rows {
		if row.isPullRequest() {
			continue
		}
		if !validIssue(row.Issue) {
			return nil, 0, errInvalidForgeResponse
		}
		result = append(result, row.Issue)
	}
	return result, nextPage(headers, page), nil
}
func (s *Server) getIssue(ctx context.Context, token forgeCredential, key repositoryKey, number uint32) (Issue, error) {
	base, err := repositoryPath(key)
	if err != nil {
		return Issue{}, err
	}
	if number == 0 || number > 2147483647 {
		return Issue{}, invalid("Issue number must be 1–2147483647.")
	}
	var row forgeIssue
	if _, err := s.forge(ctx, "GET", base+"/issues/"+strconv.FormatUint(uint64(number), 10), token, nil, &row); err != nil {
		return Issue{}, err
	}
	if row.isPullRequest() {
		return Issue{}, errResourceNotFound
	}
	if !validIssue(row.Issue) || row.Number != int64(number) {
		return Issue{}, errInvalidForgeResponse
	}
	return row.Issue, nil
}
