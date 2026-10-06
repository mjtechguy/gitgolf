package server

import (
	"context"
	"net/http"
	"reflect"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Revisions are current native history observations. The native endpoint does
// not serve historical page bytes, so these are not historical content links.
func (s *Server) ListRepositoryWikiRevisions(ctx context.Context, req *connect.Request[golfv1.ListRepositoryWikiRevisionsRequest]) (*connect.Response[golfv1.ListRepositoryWikiRevisionsResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if !validWikiSlug(m.Slug) || m.Page > 10000 {
		return nil, rpcError(invalid("Select an exact wiki page and bounded history page."))
	}
	page := m.Page
	if page == 0 {
		page = 1
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryWikiRevisionsResponse{RepositoryId: m.RepositoryId, Slug: m.Slug}
	e = s.withWikiRead(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, func(base string, repo Repository) error {
		var before nativeWikiPage
		if _, e := s.forge(ctx, http.MethodGet, base+"/wiki/page/"+m.Slug, token, nil, &before); e != nil {
			return e
		}
		wire, e := wikiMetadata(before.nativeWikiPageMetadata, repo)
		if e != nil || wire.Slug != m.Slug || before.Count == nil || *before.Count < 1 {
			return errInvalidForgeResponse
		}
		result.ObservedCommitId = wire.LastCommitId
		type history struct {
			Count   *int64             `json:"count"`
			Commits []nativeWikiCommit `json:"commits"`
		}
		var rows history
		path := base + "/wiki/revisions/" + m.Slug + "?page=" + strconv.FormatUint(uint64(page), 10)
		if _, e = s.forge(ctx, http.MethodGet, path, token, nil, &rows); e != nil {
			return e
		}
		if rows.Count == nil || *rows.Count < 0 || rows.Commits == nil || len(rows.Commits) > 100 || int64(len(rows.Commits)) > *rows.Count {
			return errInvalidForgeResponse
		}
		result.NativeCommitCount = strconv.FormatInt(*rows.Count, 10)
		seen := map[string]bool{}
		for _, r := range rows.Commits {
			if !objectID.MatchString(r.SHA) || seen[r.SHA] || !discussionText(r.Message, 16384) || r.Author == nil || !discussionText(r.Author.Name, 1024) || !validPullTime(r.Author.Date) {
				return errInvalidForgeResponse
			}
			seen[r.SHA] = true
			result.Revisions = append(result.Revisions, &golfv1.RepositoryWikiRevision{CommitId: r.SHA, AuthorName: r.Author.Name, UpdatedAt: r.Author.Date, Message: r.Message})
		}
		// The documented endpoint accepts page only and uses native fixed pagination.
		// A nonempty page permits probing the next page; totals are not guessed.
		if len(rows.Commits) > 0 {
			result.NextPage = page + 1
		}
		var after nativeWikiPage
		if _, e = s.forge(ctx, http.MethodGet, base+"/wiki/page/"+m.Slug, token, nil, &after); e != nil {
			return e
		}
		if !reflect.DeepEqual(before, after) {
			return errPullSnapshotChanged
		}
		return nil
	})
	if e != nil {
		return nil, wikiRPCError(e)
	}
	return connect.NewResponse(result), nil
}
