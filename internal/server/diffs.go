package server

import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

const maxCommitDiffBytes = 512 << 10
const maxCommitDiffParents = 1000

// getCommitDiff fixes both sides to commit objects. Gitea 1.27.3's supported
// .diff endpoint uses the first parent even for merges, and git show for roots.
// Keep its native text (including root metadata, filenames and binary notices),
// rather than interpreting it as a parsed patch or a merge-readiness assertion.
func (s *Server) getCommitDiff(ctx context.Context, value string, token forgeCredential, key repositoryKey, commitID string) (*golfv1.GetCommitDiffResponse, error) {
	if !objectID.MatchString(commitID) {
		return nil, invalid("Select a full lowercase 40- or 64-character commit ID.")
	}
	var result *golfv1.GetCommitDiffResponse
	err := s.withRepositoryRead(ctx, value, token, key, func(base string, repo Repository) error {
		if repo.Empty {
			return errEmptyRepository
		}
		var row struct {
			forgeCommit
			HTMLURL string `json:"html_url"`
			Parents []struct {
				SHA string `json:"sha"`
			} `json:"parents"`
		}
		_, err := s.forge(ctx, http.MethodGet, base+"/git/commits/"+commitID+"?files=false&stat=false&verification=false", token, nil, &row)
		if err != nil {
			return err
		}
		if row.SHA != commitID || !validCommitURL(row.HTMLURL, repo.HTMLURL, commitID) || row.Parents == nil || !validPullTime(row.Commit.Author.Date) {
			return errInvalidForgeResponse
		}
		if len(row.Parents) > maxCommitDiffParents {
			return errForgeResponseTooLarge
		}
		result = &golfv1.GetCommitDiffResponse{
			Commit: &golfv1.Commit{Sha: row.SHA, Message: row.Commit.Message, AuthorName: row.Commit.Author.Name, AuthoredAt: row.Commit.Author.Date},
			Base:   golfv1.CommitDiffBase_COMMIT_DIFF_BASE_ROOT,
		}
		for _, parent := range row.Parents {
			if !objectID.MatchString(parent.SHA) || len(parent.SHA) != len(commitID) || parent.SHA == commitID {
				return errInvalidForgeResponse
			}
			result.ParentCommitIds = append(result.ParentCommitIds, parent.SHA)
		}
		if len(row.Parents) > 0 {
			result.Base = golfv1.CommitDiffBase_COMMIT_DIFF_BASE_FIRST_PARENT
			result.BaseCommitId = row.Parents[0].SHA
		}
		result.RawDiff, err = s.readCommitDiff(ctx, base+"/git/commits/"+commitID+".diff", token)
		if err != nil {
			return err
		}
		result.ByteSize = uint32(len(result.RawDiff))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func validCommitURL(value, repositoryURL, commitID string) bool {
	commit, err := url.Parse(value)
	repo, repoErr := url.Parse(repositoryURL)
	if err != nil || repoErr != nil {
		return false
	}
	for _, u := range []*url.URL{commit, repo} {
		if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
			return false
		}
	}
	// Gitea 1.27.3 ToRepo calls HTMLURL(ctx), whereas ToCommit calls HTMLURL()
	// without request context. Internal and public origins can therefore differ.
	// Bind the repository path and exact object ID; never follow this metadata URL.
	return commit.EscapedPath() == strings.TrimRight(repo.EscapedPath(), "/")+"/commit/"+commitID
}

func (s *Server) readCommitDiff(ctx context.Context, path string, token forgeCredential) (string, error) {
	res, err := s.forgeRequest(ctx, http.MethodGet, path, "text/plain", token, nil)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", errInvalidForgeResponse
	}
	if contentType := res.Header.Get("Content-Type"); contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != "text/plain" {
			return "", errInvalidForgeResponse
		}
	}
	if res.ContentLength > maxCommitDiffBytes {
		return "", errForgeResponseTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxCommitDiffBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errInvalidForgeResponse
	}
	if len(data) > maxCommitDiffBytes {
		return "", errForgeResponseTooLarge
	}
	if !utf8.Valid(data) {
		return "", errDiffTextUnsupported
	}
	text := string(data)
	if strings.IndexFunc(text, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) != -1 {
		return "", errDiffTextUnsupported
	}
	return text, nil
}
