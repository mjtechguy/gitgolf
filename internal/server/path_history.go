package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The native path endpoint ignores limit and its Link header uses that ignored
// value. Discover its actual span from page one, then slice exact Golf pages.
// Immutable ref + repeated count/row checks detect observed pagination drift.
func (s *Server) listPathCommits(ctx context.Context, session string, token forgeCredential, key repositoryKey, repositoryID int64, ref, filePath string, paging pageRequest) ([]forgeCommit, uint32, error) {
	if !objectID.MatchString(ref) || filePath == "" || !validSourcePath(filePath) {
		return nil, 0, invalid("Path history requires a repository-relative path and full lowercase commit ID.")
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var result []forgeCommit
	var next uint32
	err = s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if repo.ID != repositoryID {
			return errIssueTargetChanged
		}
		read := func(nativePage uint32) ([]forgeCommit, int64, error) {
			query := pageQuery(nativePage, 100)
			query.Set("sha", ref)
			// The native API passes this value to Git's pathspec parser. Explicit
			// literal magic keeps '*', '[' and leading ':' in filenames literal.
			query.Set("path", ":(literal)"+filePath)
			for _, field := range []string{"stat", "verification", "files"} {
				query.Set(field, "false")
			}
			rows := []forgeCommit{}
			headers, err := s.forge(ctx, http.MethodGet, base+"/commits?"+query.Encode(), token, nil, &rows)
			if err != nil {
				return nil, 0, err
			}
			count := headers.Get("X-Total")
			total, e := strconv.ParseInt(count, 10, 64)
			if e != nil || total <= 0 || strconv.FormatInt(total, 10) != count || len(rows) == 0 || len(rows) > 100 || int64(len(rows)) > total {
				return nil, 0, errInvalidForgeResponse
			}
			seen := map[string]bool{}
			for _, row := range rows {
				if !objectID.MatchString(row.SHA) || len(row.SHA) != len(ref) || seen[row.SHA] || !discussionText(row.Commit.Message, 256<<10) || !validPullTime(row.Commit.Author.Date) || !utf8.ValidString(row.Commit.Author.Name) || len(row.Commit.Author.Name) > 1024 || strings.IndexFunc(row.Commit.Author.Name, unicode.IsControl) >= 0 {
					return nil, 0, errInvalidForgeResponse
				}
				seen[row.SHA] = true
			}
			return rows, total, nil
		}
		first, total, err := read(1)
		if err != nil {
			return err
		}
		span := int64(len(first))
		start := int64(page-1) * int64(limit)
		end := min(start+int64(limit), total)
		seen := map[string]bool{}
		for offset := start; offset < end; {
			nativePage := uint32(offset/span + 1)
			rows := first
			if nativePage != 1 {
				var count int64
				rows, count, err = read(nativePage)
				if err != nil {
					return err
				}
				if count != total || int64(len(rows)) != min(span, total-int64(nativePage-1)*span) {
					return errInvalidForgeResponse
				}
			}
			local := offset % span
			take := min(int64(len(rows))-local, end-offset)
			for _, row := range rows[local : local+take] {
				if seen[row.SHA] {
					return errInvalidForgeResponse
				}
				seen[row.SHA] = true
				result = append(result, row)
			}
			offset += take
		}
		if end < total {
			if page == 10000 {
				return invalid("Path history exceeds the 10000-page limit. Increase the page size before continuing.")
			}
			next = page + 1
		}
		return nil
	})
	return result, next, err
}
