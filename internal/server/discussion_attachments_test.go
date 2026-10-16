package server

import (
	"context"
	"encoding/json"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func TestDiscussionAttachmentCurrentBytes(t *testing.T) {
	a := releaseDownloadFixture()
	mode := ""
	rawReads := 0
	sinkReads := 0
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sinkReads++; w.Write([]byte("secret")) }))
	defer sink.Close()
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawReads++
		if r.URL.Path != "/attachments/"+a.UUID || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer exact" || r.Header.Get("Cookie") != "" {
			t.Error("attachment credential boundary")
		}
		if mode == "redirect" {
			http.Redirect(w, r, sink.URL, 302)
			return
		}
		if mode == "short" {
			w.Write([]byte("no"))
			return
		}
		w.Write([]byte("zip"))
	}))
	defer native.Close()
	s, e := New(testConfig(native.URL), nil)
	if e != nil {
		t.Fatal(e)
	}
	h := discussionAttachmentRevision(a)
	if h == "" {
		t.Fatal("valid attachment")
	}
	count := int64(9)
	b := a
	b.DownloadCount = &count
	if discussionAttachmentRevision(b) != h {
		t.Fatal("download count invalidated identity")
	}
	b.Name = "changed"
	if discussionAttachmentRevision(b) == h {
		t.Fatal("unbound filename")
	}
	for _, v := range []string{"", "short", "redirect"} {
		mode = v
		data, e := s.discussionAttachmentBytes(t.Context(), forgeCredential{Kind: "pat", Token: "exact"}, a)
		if v == "" {
			if e != nil || string(data) != "zip" {
				t.Fatal("bytes", e)
			}
		} else if e == nil {
			t.Fatal("accepted unsafe bytes", v)
		}
	}
	if sinkReads != 0 || rawReads != 3 {
		t.Fatal("redirect followed")
	}
	size := int64(repositoryReleaseAssetMaxBytes + 1)
	a.Size = &size
	if _, e = s.discussionAttachmentBytes(t.Context(), forgeCredential{Kind: "pat", Token: "exact"}, a); e == nil || rawReads != 3 {
		t.Fatal("oversized native read")
	}
}
func TestDiscussionAttachmentAssociationPostgres(t *testing.T) {
	f := newEngagementFixture(t)
	a := releaseDownloadFixture()
	a.ID = 91
	mode := ""
	reads := 0
	revoked := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if revoked && r.URL.Path == "/api/v1/repos/alice/private" {
			w.WriteHeader(404)
			return
		}
		if strings.Contains(r.URL.Path, "/assets") {
			w.Header().Set("Content-Type", "application/json")
			if strings.HasSuffix(r.URL.Path, "/assets") {
				json.NewEncoder(w).Encode([]forgeReleaseDownloadAsset{a})
				return
			}
			if mode == "foreign" {
				changed := a
				changed.ID = 92
				json.NewEncoder(w).Encode(changed)
				return
			}
			json.NewEncoder(w).Encode(a)
			return
		}
		if r.URL.Path == "/attachments/"+a.UUID {
			reads++
			if mode == "revoked" {
				revoked = true
			}
			w.Write([]byte("zip"))
			return
		}
		f.serveEngagement(w, r)
	}))
	t.Cleanup(provider.Close)
	config := f.s.config
	config.ForgeURL = provider.URL
	config.ForgePublicURL = provider.URL
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	session := f.session(t, "pat")
	_, _, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	client := golfv1connect.NewDiscussionAttachmentServiceClient(transport, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", f.s.config.PublicURL)
			return next(ctx, req)
		}
	})))
	ctx := t.Context()
	target := &golfv1.DiscussionTarget{Repository: pullKey, RepositoryId: "11", IssueId: "77", Number: 7, PullRequest: true}
	list := connect.NewRequest(&golfv1.ListDiscussionAttachmentsRequest{Target: target})

	listed, e := client.ListDiscussionAttachments(ctx, list)
	if e != nil || len(listed.Msg.Attachments) != 1 {
		t.Fatal("inventory", e)
	}
	download := func(target *golfv1.DiscussionTarget, revision string) error {
		req := connect.NewRequest(&golfv1.DownloadDiscussionAttachmentRequest{Target: target, AttachmentId: "91", ExpectedRevision: revision})

		out, e := client.DownloadDiscussionAttachment(ctx, req)
		if e == nil && (string(out.Msg.Content) != "zip" || out.Msg.ContentSha256 != fileMutationHash([]byte("zip"))) {
			t.Fatal("wrong bytes")
		}
		return e
	}
	if e = download(target, listed.Msg.Attachments[0].Revision); e != nil {
		t.Fatal(e)
	}
	wrong := proto.Clone(target).(*golfv1.DiscussionTarget)
	wrong.IssueId = "999"
	before := reads
	if download(wrong, discussionAttachmentRevision(a)) == nil || reads != before {
		t.Fatal("wrong association read")
	}
	if download(target, strings.Repeat("f", 64)) == nil || reads != before {
		t.Fatal("stale revision read")
	}
	mode = "foreign"
	if download(target, discussionAttachmentRevision(a)) == nil || reads != before {
		t.Fatal("foreign attachment read")
	}
	mode = "revoked"
	if download(target, discussionAttachmentRevision(a)) == nil {
		t.Fatal("revoked data escaped")
	}
}
