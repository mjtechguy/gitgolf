package server

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errWikiUnavailable = errors.New("native internal wiki is unavailable")

func validWikiSlug(v string) bool {
	if v == "" || len(v) > 1024 || v == "." || v == ".." {
		return false
	}
	for _, c := range v {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("_.~+%-", c)) {
			return false
		}
	}
	decoded, e := url.QueryUnescape(v)
	return e == nil && utf8.ValidString(decoded) && discussionText(decoded, 1024) && strings.TrimSpace(decoded) != "" && !strings.ContainsAny(decoded, "\x00\\")
}

type nativeWikiCommit struct {
	SHA     string `json:"sha"`
	Message string `json:"message"`
	Author  *struct {
		Name string `json:"name"`
		Date string `json:"date"`
	} `json:"author"`
}
type nativeWikiPageMetadata struct {
	Title   string            `json:"title"`
	HTMLURL string            `json:"html_url"`
	Slug    string            `json:"sub_url"`
	Commit  *nativeWikiCommit `json:"last_commit"`
}
type nativeWikiPage struct {
	nativeWikiPageMetadata
	Content string `json:"content_base64"`
	Count   *int64 `json:"commit_count"`
}

func wikiMetadata(row nativeWikiPageMetadata, repo Repository) (*golfv1.RepositoryWikiPageMetadata, error) {
	if !validWikiSlug(row.Slug) || !discussionText(row.Title, 1024) || strings.TrimSpace(row.Title) == "" || row.Commit == nil || !objectID.MatchString(row.Commit.SHA) || !discussionText(row.Commit.Message, 16384) || row.Commit.Author == nil || !discussionText(row.Commit.Author.Name, 1024) || !validPullTime(row.Commit.Author.Date) {
		return nil, errInvalidForgeResponse
	}
	want := strings.TrimRight(repo.HTMLURL, "/") + "/wiki/" + row.Slug
	if row.HTMLURL != want {
		return nil, errInvalidForgeResponse
	}
	return &golfv1.RepositoryWikiPageMetadata{Slug: row.Slug, Title: row.Title, LastCommitId: row.Commit.SHA, AuthorName: row.Commit.Author.Name, UpdatedAt: row.Commit.Author.Date, CommitMessage: row.Commit.Message}, nil
}

// Native mustEnableWiki enforces current wiki-unit reads independently of code.
// Neither has_wiki nor a repository read substitutes for that endpoint check.
func (s *Server) withWikiRead(ctx context.Context, session string, token forgeCredential, key repositoryKey, id string, fn func(string, Repository) error) error {
	if _, e := discussionID(id); e != nil {
		return e
	}
	return s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if strconv.FormatInt(repo.ID, 10) != id {
			return errResourceNotFound
		}
		row, _, e := s.readRepositorySettings(ctx, token, key)
		if e != nil {
			return e
		}
		if row.ID != repo.ID || row.HasWiki == nil || !*row.HasWiki || row.ExternalWiki != nil {
			return errWikiUnavailable
		}
		if e = fn(base, repo); e != nil {
			return e
		}
		after, _, e := s.readRepositorySettings(ctx, token, key)
		if e != nil {
			return e
		}
		if after.ID != row.ID || after.HasWiki == nil || !*after.HasWiki || after.ExternalWiki != nil {
			return errWikiUnavailable
		}
		return nil
	})
}
func wikiRPCError(e error) error {
	if errors.Is(e, errPullSnapshotChanged) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("Wiki changed while being read. Refresh to select its current pages."))
	}
	if errors.Is(e, errWikiUnavailable) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("This repository's internal wiki is disabled or unavailable. External wiki URLs are not followed."))
	}
	return rpcError(e)
}
func (s *Server) ListRepositoryWikiPages(ctx context.Context, req *connect.Request[golfv1.ListRepositoryWikiPagesRequest]) (*connect.Response[golfv1.ListRepositoryWikiPagesResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	page, limit, e := pagination(pageFrom(m.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	if limit < 2 {
		return nil, rpcError(invalid("Wiki page size must be at least 2."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryWikiPagesResponse{RepositoryId: m.RepositoryId, Page: &golfv1.PageResponse{}}
	e = s.withWikiRead(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, func(base string, repo Repository) error {
		var rows []nativeWikiPageMetadata
		headers, e := s.forge(ctx, http.MethodGet, base+"/wiki/pages?"+pageQuery(page, limit).Encode(), token, nil, &rows)
		if e != nil {
			return e
		}
		if rows == nil || len(rows) > int(limit) {
			return errInvalidForgeResponse
		}
		count := headers.Get("X-Total-Count")
		total, e := strconv.ParseInt(count, 10, 64)
		if e != nil || total < 0 || strconv.FormatInt(total, 10) != count || int64(len(rows)) > total {
			return errInvalidForgeResponse
		}
		seen := map[string]bool{}
		for _, row := range rows {
			wire, e := wikiMetadata(row, repo)
			if e != nil {
				return e
			}
			if seen[wire.Slug] {
				return errInvalidForgeResponse
			}
			seen[wire.Slug] = true
			result.Pages = append(result.Pages, wire)
		}
		result.NativeEntryCount = count
		result.Page.NextPage = nextPage(headers, page)
		// Recheck the same native unit after data waits, including empty inventories.
		var repeat []nativeWikiPageMetadata
		h, e := s.forge(ctx, http.MethodGet, base+"/wiki/pages?"+pageQuery(page, limit).Encode(), token, nil, &repeat)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(rows, repeat) || h.Get("X-Total-Count") != count {
			return errPullSnapshotChanged
		}
		return nil
	})
	if e != nil {
		return nil, wikiRPCError(e)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) GetRepositoryWikiPage(ctx context.Context, req *connect.Request[golfv1.GetRepositoryWikiPageRequest]) (*connect.Response[golfv1.GetRepositoryWikiPageResponse], error) {
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if !validWikiSlug(m.Slug) {
		return nil, rpcError(invalid("Select an exact native wiki page segment."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.GetRepositoryWikiPageResponse{RepositoryId: m.RepositoryId}
	e = s.withWikiRead(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), m.RepositoryId, func(base string, repo Repository) error {
		path := base + "/wiki/page/" + m.Slug
		var row nativeWikiPage
		if _, e := s.forge(ctx, http.MethodGet, path, token, nil, &row); e != nil {
			return e
		}
		page, e := wikiMetadata(row.nativeWikiPageMetadata, repo)
		if e != nil {
			return e
		}
		if page.Slug != m.Slug || row.Count == nil || *row.Count < 1 {
			return errInvalidForgeResponse
		}
		result.Page = page
		result.CommitCount = strconv.FormatInt(*row.Count, 10)
		// Empty native content also represents omitted oversized blobs; never claim
		// exact empty bytes or invent Markdown from a provider's omission.
		result.ContentUnavailableReason = "The native API supplied no page content. Empty and omitted oversized pages cannot be distinguished."
		if row.Content != "" {
			decoded, e := base64.StdEncoding.Strict().DecodeString(row.Content)
			if e != nil {
				return errInvalidForgeResponse
			}
			if len(decoded) > 256<<10 {
				result.ContentUnavailableReason = "Page preview exceeds 256 KiB."
			} else if !utf8.Valid(decoded) || !discussionText(string(decoded), 256<<10) {
				result.ContentUnavailableReason = "Page preview requires safe UTF-8 Markdown."
			} else {
				text := string(decoded)
				result.Markdown = &text
				result.ContentUnavailableReason = ""
			}
		}
		var after nativeWikiPage
		if _, e := s.forge(ctx, http.MethodGet, path, token, nil, &after); e != nil {
			return e
		}
		if !reflect.DeepEqual(row, after) {
			return errPullSnapshotChanged
		}
		return nil
	})
	if e != nil {
		return nil, wikiRPCError(e)
	}
	return connect.NewResponse(result), nil
}
