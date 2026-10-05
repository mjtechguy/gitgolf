package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func wikiFixturePage(slug string) nativeWikiPage {
	var row nativeWikiPage
	raw := `{"title":"Useful page","sub_url":"` + slug + `","html_url":"https://forge.invalid/alice/private/wiki/` + slug + `","last_commit":{"sha":"` + strings.Repeat("a", 40) + `","message":"Useful docs","author":{"name":"Docs author","date":"2026-10-05T12:00:00Z"}},"content_base64":"` + base64.StdEncoding.EncodeToString([]byte("# Useful documentation\n")) + `","commit_count":2}`
	json.Unmarshal([]byte(raw), &row)
	return row
}
func TestWikiSlugAndMetadata(t *testing.T) {
	for _, slug := range []string{"Home", "100%25-Free-%E9%9B%AA", "feature%2Fpage", "a-b.-"} {
		if !validWikiSlug(slug) {
			t.Fatal("valid opaque native segment", slug)
		}
	}
	for _, slug := range []string{"", ".", "..", "a/b", "a?query", "a#fragment", "%zz", "%00", "%5Cfoo"} {
		if validWikiSlug(slug) {
			t.Fatal("unsafe segment", slug)
		}
	}
	repo := Repository{HTMLURL: "https://forge.invalid/alice/private"}
	row := wikiFixturePage("Home")
	if _, e := wikiMetadata(row.nativeWikiPageMetadata, repo); e != nil {
		t.Fatal(e)
	}
	row.HTMLURL = "https://foreign.invalid/wiki/Home"
	if _, e := wikiMetadata(row.nativeWikiPageMetadata, repo); e == nil {
		t.Fatal("foreign wiki receipt")
	}
}
func TestWikiReadsPostgres(t *testing.T) {
	for _, mode := range []string{"", "ambiguous-empty", "large", "bad-base64", "unknown-count", "wiki-unit-denied", "late-unit-denied", "changed", "wrong-slug"} {
		t.Run(mode, func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			target, _ := url.Parse(f.s.config.GiteaURL)
			proxy := httputil.NewSingleHostReverseProxy(target)
			var reads atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				base := "/api/v1/repos/alice/private"
				if strings.HasPrefix(r.URL.Path, base+"/wiki/") {
					w.Header().Set("Content-Type", "application/json")
					n := reads.Add(1)
					if mode == "wiki-unit-denied" || mode == "late-unit-denied" && n > 1 {
						w.WriteHeader(404)
						return
					}
					row := wikiFixturePage("Home")
					if mode == "changed" && n > 1 {
						row.Commit.SHA = strings.Repeat("b", 40)
					}
					if mode == "wrong-slug" {
						row = wikiFixturePage("Foreign")
					}
					if r.URL.Path == base+"/wiki/pages" {
						w.Header().Set("X-Total-Count", "1")
						json.NewEncoder(w).Encode([]nativeWikiPageMetadata{row.nativeWikiPageMetadata})
						return
					}
					if mode == "ambiguous-empty" {
						row.Content = ""
					}
					if mode == "large" {
						row.Content = base64.StdEncoding.EncodeToString(make([]byte, 256<<10+1))
					}
					if mode == "bad-base64" {
						row.Content = "!!!!"
					}
					if mode == "unknown-count" {
						row.Count = nil
					}
					json.NewEncoder(w).Encode(row)
					return
				}
				proxy.ServeHTTP(w, r)
			}))
			t.Cleanup(provider.Close)
			config := f.s.config
			config.GiteaURL, config.GiteaPublicURL = provider.URL, provider.URL
			var e error
			f.s, e = New(config, f.db)
			if e != nil {
				t.Fatal(e)
			}
			session := f.session(t, "pat")
			_, _, _, transport, origin := testRPCClients(t, f.s)
			transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
			client := golfv1connect.NewRepositoryWikiServiceClient(transport, origin.String()+"/rpc")
			req := connect.NewRequest(&golfv1.GetRepositoryWikiPageRequest{Repository: pullKey, RepositoryId: "11", Slug: "Home"})
			req.Header().Set("Origin", f.s.config.PublicURL)
			page, e := client.GetRepositoryWikiPage(t.Context(), req)
			if mode == "bad-base64" || mode == "unknown-count" || mode == "wiki-unit-denied" || mode == "late-unit-denied" || mode == "changed" || mode == "wrong-slug" {
				if e == nil {
					t.Fatal("invalid/denied native page exposed")
				}
				return
			}
			if e != nil || page.Msg.Page.Slug != "Home" {
				t.Fatal(e, page)
			}
			if mode == "ambiguous-empty" || mode == "large" {
				if page.Msg.Markdown != nil || page.Msg.ContentUnavailableReason == "" {
					t.Fatal("fabricated content")
				}
			} else if page.Msg.GetMarkdown() != "# Useful documentation\n" {
				t.Fatal("exact text lost")
			}
			list := connect.NewRequest(&golfv1.ListRepositoryWikiPagesRequest{Repository: pullKey, RepositoryId: "11"})
			list.Header().Set("Origin", f.s.config.PublicURL)
			inventory, e := client.ListRepositoryWikiPages(t.Context(), list)
			if e != nil || len(inventory.Msg.Pages) != 1 || inventory.Msg.NativeEntryCount != "1" {
				t.Fatal("inventory", e, inventory)
			}
			f.mode.Store("denied")
			if _, e = client.GetRepositoryWikiPage(t.Context(), req); e == nil {
				t.Fatal("revoked repository wiki exposed")
			}
		})
	}
}
