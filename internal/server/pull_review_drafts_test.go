package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const privateDraftDiff = "diff --git a/src/example.ts b/src/example.ts\nindex aaaa..bbbb 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n"

type privateDraftFixture struct {
	*pullFixture
	diff, head, base, mergeBase, route atomic.Value
	writes, diffReads                  atomic.Int32
}

func newPrivateDraftFixture(t *testing.T) *privateDraftFixture {
	t.Helper()
	f := &privateDraftFixture{pullFixture: &pullFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}}
	f.mode.Store("")
	f.diff.Store(privateDraftDiff)
	f.head.Store(strings.Repeat("a", 40))
	f.base.Store(strings.Repeat("b", 40))
	f.mergeBase.Store(strings.Repeat("c", 40))
	f.route.Store("private")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			f.writes.Add(1)
			w.WriteHeader(405)
			return
		}
		if r.URL.Path == "/api/v1/user" && r.Header.Get("Authorization") == "token other-pat" {
			_ = json.NewEncoder(w).Encode(User{ID: 43, Login: "administrator", IsInstanceAdmin: true})
			return
		}
		if r.Header.Get("Authorization") == "token other-pat" {
			r = r.Clone(r.Context())
			r.Header = r.Header.Clone()
			r.Header.Set("Authorization", "token pull-pat")
		}
		route := "/api/v1/repos/alice/" + f.route.Load().(string)
		original := r.URL.Path
		number := int64(7)
		if strings.HasPrefix(original, route+"/pulls/") {
			segment := strings.TrimPrefix(original, route+"/pulls/")
			segment = strings.TrimSuffix(segment, ".diff")
			if n, err := strconv.ParseInt(segment, 10, 32); err == nil && n > 0 {
				number = n
			}
		}
		if strings.HasPrefix(original, "/api/v1/repos/alice/") {
			if !strings.HasPrefix(original, route) {
				w.WriteHeader(404)
				return
			}
			r = r.Clone(r.Context())
			u := *r.URL
			r.URL = &u
			r.URL.Path = strings.Replace(original, route, "/api/v1/repos/alice/private", 1)
			if number != 7 {
				r.URL.Path = strings.Replace(r.URL.Path, "/pulls/"+strconv.FormatInt(number, 10), "/pulls/7", 1)
			}
		}
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7.diff" {
			f.diffReads.Add(1)
			if f.mode.Load().(string) == "wait-diff" {
				f.entered <- struct{}{}
				select {
				case <-f.resume:
				case <-r.Context().Done():
				}
			}
			w.Header().Set("Content-Type", "text/plain")
			_, _ = io.WriteString(w, f.diff.Load().(string))
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/commits" {
			_ = json.NewEncoder(w).Encode([]forgeCommit{{SHA: f.head.Load().(string)}})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private/pulls/7" {
			recorder := httptest.NewRecorder()
			f.serveProvider(recorder, r)
			if recorder.Code != 200 {
				w.WriteHeader(recorder.Code)
				return
			}
			var row forgePull
			_ = json.Unmarshal(recorder.Body.Bytes(), &row)
			zero := int64(0)
			row.ContentVersion = &zero
			row.ID += number - 7
			row.Number = number
			row.HTMLURL = strings.Replace(row.HTMLURL, "/pulls/7", "/pulls/"+strconv.FormatInt(number, 10), 1)
			if f.mode.Load().(string) == "rebind-after-commit" {
				var count int
				_ = f.db.QueryRow("SELECT count(*) FROM golf_review_draft_versions").Scan(&count)
				if count > 0 {
					row.ID++
				}
			}
			row.MergeBase = f.mergeBase.Load().(string)
			row.Head.SHA = f.head.Load().(string)
			row.Base.SHA = f.base.Load().(string)
			row.HTMLURL = strings.Replace(row.HTMLURL, "/alice/private/", "/alice/"+f.route.Load().(string)+"/", 1)
			_ = json.NewEncoder(w).Encode(row)
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/private" {
			if f.mode.Load().(string) == "deny-after-commit" {
				var count int
				_ = f.db.QueryRow("SELECT count(*) FROM golf_review_draft_versions").Scan(&count)
				if count > 0 {
					w.WriteHeader(404)
					return
				}
			}
			recorder := httptest.NewRecorder()
			f.serveProvider(recorder, r)
			if recorder.Code != 200 {
				w.WriteHeader(recorder.Code)
				return
			}
			var row Repository
			_ = json.Unmarshal(recorder.Body.Bytes(), &row)
			row.Name = f.route.Load().(string)
			row.FullName = "alice/" + row.Name
			row.HTMLURL = "https://forge.invalid/" + row.FullName
			_ = json.NewEncoder(w).Encode(row)
			return
		}
		f.serveProvider(w, r)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	config := testConfig(provider.URL)
	config.GiteaPublicURL = provider.URL
	config.GiteaOAuthClientID = "fixture-client"
	config.GiteaOAuthClientSecret = "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *privateDraftFixture) target() *golfv1.PullReviewDraftTarget {
	return &golfv1.PullReviewDraftTarget{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: f.route.Load().(string)}, RepositoryId: "11", PullRequestId: "9007199254740993", Number: 7}
}
func (f *privateDraftFixture) create(t *testing.T, c golfv1connect.RepositoryServiceClient) *golfv1.SavePullRequestReviewDraftRequest {
	t.Helper()
	target := f.target()
	pr, err := c.GetPullRequest(context.Background(), connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: target.Repository, Number: 7}))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(f.diff.Load().(string)))
	return &golfv1.SavePullRequestReviewDraftRequest{Target: target, DraftId: uuid.NewString(), OperationId: uuid.NewString(), ExpectedVersion: "0", ExpectedTargetGeneration: "0", Comparison: &golfv1.SavePullRequestReviewDraftRequest_Capture{Capture: &golfv1.PullReviewDraftCapture{Selection: &golfv1.PullRequestSelection{Repository: target.Repository, RepositoryId: target.RepositoryId, PullRequestId: target.PullRequestId, Number: target.Number, BaseCommitId: f.base.Load().(string), HeadCommitId: f.head.Load().(string)}, ExpectedPullRevision: pr.Msg.PullRequest.Revision, MergeBaseCommitId: f.mergeBase.Load().(string), DiffSha256: hex.EncodeToString(sum[:])}}, Summary: "private summary", Entries: []*golfv1.PullReviewDraftEntry{{Id: uuid.NewString(), Coordinate: &golfv1.PullReviewDraftCoordinate{FileIndex: 0, HunkIndex: 0, Side: golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, Line: 2, Path: "src/example.ts"}, Body: "private inline body"}}}
}
func savePrivateDraft(t *testing.T, c golfv1connect.RepositoryServiceClient, m *golfv1.SavePullRequestReviewDraftRequest) *golfv1.SavePullRequestReviewDraftResponse {
	t.Helper()
	out, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(m))
	if err != nil {
		t.Fatal("save private draft", err)
	}
	return out.Msg
}
func editPrivateDraft(out *golfv1.SavePullRequestReviewDraftResponse) *golfv1.SavePullRequestReviewDraftRequest {
	return &golfv1.SavePullRequestReviewDraftRequest{Target: out.Draft.Target, DraftId: out.Draft.Id, ExpectedVersion: out.CurrentVersion, ExpectedTargetGeneration: out.TargetGeneration, OperationId: uuid.NewString(), Comparison: &golfv1.SavePullRequestReviewDraftRequest_ComparisonId{ComparisonId: out.Draft.Comparison.Id}, Summary: out.Draft.Summary, Entries: proto.Clone(&golfv1.SavePullRequestReviewDraftRequest{Entries: out.Draft.Entries}).(*golfv1.SavePullRequestReviewDraftRequest).Entries}
}
func TestPrivateDraftBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.RepositoryServiceGetPullRequestReviewDraftProcedure, golfv1connect.RepositoryServiceSavePullRequestReviewDraftProcedure, golfv1connect.RepositoryServiceDeletePullRequestReviewDraftProcedure} {
		for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader(strings.Repeat("x", 2<<20+1)))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("private body decoded before authority", procedure, w.Code)
			}
			r = httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed"))
			r.Header.Set("Origin", s.config.PublicURL)
			r.Header.Set("Authorization", "Bearer "+apiTokenPrefix+strings.Repeat("A", 43))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Connect-Protocol-Version", "1")
			w = httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatal("draft delegation was admitted", procedure, w.Code)
			}
		}
	}
}
func TestPrivateDraftCoordinates(t *testing.T) {
	c := &golfv1.PullReviewDraftComparison{RawDiff: privateDraftDiff}
	entry := &golfv1.PullReviewDraftEntry{Id: uuid.NewString(), Body: "body", Coordinate: &golfv1.PullReviewDraftCoordinate{Path: "src/example.ts", Line: 2, Side: golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW}}
	for _, side := range []golfv1.PullReviewDraftSide{golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD} {
		entry.Coordinate.Side = side
		if err := validateReviewDraftContents("", []*golfv1.PullReviewDraftEntry{entry}, c); err != nil {
			t.Fatal("ordinary side", err)
		}
	}
	for _, mutate := range []func(*golfv1.PullReviewDraftEntry){func(e *golfv1.PullReviewDraftEntry) { e.Coordinate.Line = 0 }, func(e *golfv1.PullReviewDraftEntry) { e.Coordinate.Line = 3 }, func(e *golfv1.PullReviewDraftEntry) { e.Coordinate.HunkIndex = 1 }, func(e *golfv1.PullReviewDraftEntry) { e.Coordinate.FileIndex = 1 }, func(e *golfv1.PullReviewDraftEntry) { e.Coordinate.Path = "other" }, func(e *golfv1.PullReviewDraftEntry) { e.Body = " " }, func(e *golfv1.PullReviewDraftEntry) { e.Coordinate.Side = 0 }} {
		e := proto.Clone(entry).(*golfv1.PullReviewDraftEntry)
		mutate(e)
		if validateReviewDraftContents("", []*golfv1.PullReviewDraftEntry{e}, c) == nil {
			t.Fatal("invalid coordinate admitted")
		}
	}
	duplicate := proto.Clone(entry).(*golfv1.PullReviewDraftEntry)
	duplicate.Id = uuid.NewString()
	if validateReviewDraftContents("", []*golfv1.PullReviewDraftEntry{entry, duplicate}, c) == nil {
		t.Fatal("duplicate coordinate admitted")
	}
	for _, value := range []string{"", "00", "01", "-1", "+1", "9223372036854775808"} {
		if _, err := reviewDraftCounter(value, true); err == nil {
			t.Fatal("noncanonical counter", value)
		}
	}
	if n, err := reviewDraftCounter("0", true); err != nil || n != 0 {
		t.Fatal("absent0 rejected")
	}
}
func TestPrivateDraftSaveReadDeletePostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	m := f.create(t, c)
	absent, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target()}))
	if err != nil || absent.Msg.Draft != nil || absent.Msg.TargetGeneration != "0" {
		t.Fatal("initial discovery", err)
	}
	var count int
	if err = f.db.QueryRow("SELECT count(*) FROM golf_review_draft_targets").Scan(&count); err != nil || count != 0 {
		t.Fatal("Get created metadata", err)
	}
	out := savePrivateDraft(t, c, m)
	if out.CurrentVersion != "1" || out.TargetGeneration != "1" || out.Receipt.ExpectedTargetGeneration != "0" || out.Receipt.AcceptedTargetGeneration != "1" || out.Draft.UserId != "42" || out.Draft.Comparison.RawDiff != privateDraftDiff || out.Draft.Comparison.Capture.MergeBaseCommitId == out.Draft.Comparison.Capture.Selection.BaseCommitId || out.Draft.Summary != m.Summary {
		t.Fatal("draft binding lost")
	}
	duplicate := savePrivateDraft(t, c, m)
	if !proto.Equal(out, duplicate) {
		t.Fatal("lost-ack replay changed receipt")
	}
	changed := proto.Clone(m).(*golfv1.SavePullRequestReviewDraftRequest)
	changed.Summary += " altered"
	if _, err = c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(changed)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("changed intent replay", err)
	}
	edit := editPrivateDraft(out)
	edit.Entries[0].Body = "edited private body"
	edit.Summary = ""
	edited := savePrivateDraft(t, c, edit)
	if edited.CurrentVersion != "2" || edited.TargetGeneration != "2" || edited.Draft.Comparison.Id != out.Draft.Comparison.Id {
		t.Fatal("edit rebound comparison")
	}
	historical := savePrivateDraft(t, c, m)
	if historical.Receipt.AcceptedVersion != "1" || historical.CurrentVersion != "2" || historical.Draft.Entries[0].Body != edit.Entries[0].Body {
		t.Fatal("historic receipt treated as current")
	}
	del := &golfv1.DeletePullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, ExpectedVersion: "2", ExpectedTargetGeneration: "2", OperationId: uuid.NewString()}
	deleted, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del))
	if err != nil || !deleted.Msg.Deleted || deleted.Msg.CurrentVersion != "3" || deleted.Msg.TargetGeneration != "3" {
		t.Fatal("delete", err)
	}
	deletedReplay, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del))
	if err != nil || !proto.Equal(deleted.Msg, deletedReplay.Msg) {
		t.Fatal("lost delete acknowledgement", err)
	}
	tombstone, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, OperationId: m.OperationId}))
	if err != nil || tombstone.Msg.Draft != nil || !tombstone.Msg.Deleted || tombstone.Msg.Receipt.AcceptedVersion != "1" {
		t.Fatal("deleted content disclosure", err)
	}
	historical = savePrivateDraft(t, c, m)
	if historical.Draft != nil || historical.CurrentVersion != "3" {
		t.Fatal("replay resurrected text")
	}
	absent, err = c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target()}))
	if err != nil || absent.Msg.Draft != nil || absent.Msg.TargetGeneration != "3" || absent.Msg.CurrentVersion != "0" {
		t.Fatal("generation reset", err)
	}
	replacement := f.create(t, c)
	replacement.ExpectedTargetGeneration = "3"
	newDraft := savePrivateDraft(t, c, replacement)
	late := proto.Clone(m).(*golfv1.SavePullRequestReviewDraftRequest)
	late.OperationId = uuid.NewString()
	if _, err = c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(late)); connect.CodeOf(err) != connect.CodeAborted {
		t.Fatal("old create after tombstone", err)
	}
	if newDraft.TargetGeneration != "4" || newDraft.Draft.Id == m.DraftId {
		t.Fatal("replacement identity")
	}
	var events int
	if err = f.db.QueryRow("SELECT count(*) FROM golf_repository_activity").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 || f.writes.Load() != 0 {
		t.Fatal("private state emitted native effect/shared activity")
	}
	rows, err := f.db.Query("SELECT encrypted_content FROM golf_review_contents")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var cipher []byte
		if err = rows.Scan(&cipher); err != nil {
			t.Fatal(err)
		}
		for _, plain := range []string{m.Summary, m.Entries[0].Body, "src/example.ts", "@@ -1,2", edit.Entries[0].Body} {
			if bytes.Contains(cipher, []byte(plain)) {
				t.Fatal("plaintext retained")
			}
		}
	}
}
func TestPrivateDraftCASConcurrentPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	out := savePrivateDraft(t, c, f.create(t, c))
	a := editPrivateDraft(out)
	b := editPrivateDraft(out)
	a.Summary = "device A"
	b.Summary = "device B"
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, m := range []*golfv1.SavePullRequestReviewDraftRequest{a, b} {
		wg.Add(1)
		go func(m *golfv1.SavePullRequestReviewDraftRequest) {
			defer wg.Done()
			_, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(m))
			results <- err
		}(m)
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if connect.CodeOf(err) == connect.CodeAborted {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("CAS winners", successes, conflicts)
	}
	var versions int
	_ = f.db.QueryRow("SELECT count(*) FROM golf_review_draft_versions").Scan(&versions)
	if versions != 2 {
		t.Fatal("conflict added version")
	}
}
func TestPrivateDraftRetainedSnapshotAndRenamePostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "oauth"))
	m := f.create(t, c)
	out := savePrivateDraft(t, c, m)
	reads := f.diffReads.Load()
	f.head.Store(strings.Repeat("d", 40))
	f.mergeBase.Store(strings.Repeat("e", 40))
	f.diff.Store(strings.ReplaceAll(privateDraftDiff, "+new", "+later"))
	f.route.Store("renamed")
	edit := editPrivateDraft(out)
	edit.Target = f.target()
	edit.Entries[0].Body = "saved on original comparison"
	out = savePrivateDraft(t, c, edit)
	if out.Draft.Target.Repository.Name != "renamed" || out.Draft.Comparison.Capture.Selection.Repository.Name != "private" || out.Draft.Comparison.Capture.Selection.HeadCommitId != strings.Repeat("a", 40) || out.Draft.Comparison.RawDiff != privateDraftDiff || f.diffReads.Load() != reads {
		t.Fatal("saved snapshot remapped")
	}
	f.s, _ = New(f.s.config, f.db)
	c = f.client(t, f.session(t, "pat"))
	reopened, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, OperationId: m.OperationId}))
	if err != nil || reopened.Msg.Draft.Entries[0].Body != edit.Entries[0].Body || reopened.Msg.Receipt.Target.Repository.Name != "private" {
		t.Fatal("restart/routing provenance", err)
	}
	oldTarget := proto.Clone(f.target()).(*golfv1.PullReviewDraftTarget)
	oldTarget.Repository.Name = "private"
	if _, err = c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: oldTarget, DraftId: m.DraftId})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("stale routing admitted", err)
	}
}
func TestPrivateDraftFirstCaptureDenialsPostgres(t *testing.T) {
	for _, name := range []string{"hash", "revision", "merge-base", "cross-target", "old-path", "duplicate", "head-drift"} {
		t.Run(name, func(t *testing.T) {
			f := newPrivateDraftFixture(t)
			c := f.client(t, f.session(t, "pat"))
			m := f.create(t, c)
			switch name {
			case "hash":
				m.GetCapture().DiffSha256 = strings.Repeat("d", 64)
			case "revision":
				m.GetCapture().ExpectedPullRevision = strings.Repeat("e", 64)
			case "merge-base":
				m.GetCapture().MergeBaseCommitId = strings.Repeat("f", 40)
			case "cross-target":
				m.GetCapture().Selection.RepositoryId = "12"
			case "old-path":
				m.Entries[0].Coordinate.Path = "not-in-diff"
			case "duplicate":
				m.Entries = append(m.Entries, proto.Clone(m.Entries[0]).(*golfv1.PullReviewDraftEntry))
			case "head-drift":
				f.head.Store(strings.Repeat("f", 40))
			}
			if _, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(m)); err == nil {
				t.Fatal("invalid capture accepted")
			}
			var count int
			_ = f.db.QueryRow("SELECT count(*) FROM golf_review_contents").Scan(&count)
			if count != 0 || f.writes.Load() != 0 {
				t.Fatal("denied capture retained content/effect")
			}
		})
	}
}
func TestPrivateDraftOwnerAndNativeIdentityPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	m := f.create(t, c)
	savePrivateDraft(t, c, m)
	other, err := f.s.createSession(context.Background(), User{ID: 43, Login: "administrator", IsInstanceAdmin: true}, "pat", "other-pat", "")
	if err != nil {
		t.Fatal(err)
	}
	admin := f.client(t, other)
	req := &golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, OperationId: m.OperationId}
	if _, err = admin.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(req)); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("admin read override", err)
	}
	discovery, err := admin.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target()}))
	if err != nil || discovery.Msg.Draft != nil || discovery.Msg.TargetGeneration != "0" {
		t.Fatal("otherowner discovery", err)
	}
	wrong := proto.Clone(req).(*golfv1.GetPullRequestReviewDraftRequest)
	wrong.Target.PullRequestId = "9007199254740994"
	if _, err = c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(wrong)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("native identity bypass", err)
	}
	noOp := proto.Clone(req).(*golfv1.GetPullRequestReviewDraftRequest)
	noOp.OperationId = uuid.NewString()
	if _, err = c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(noOp)); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("missing receipt treated as success", err)
	}
	for _, mode := range []string{"repository-denied", "revoked", "wrong-identity"} {
		f.mode.Store(mode)
		if result, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(req)); err == nil || result != nil {
			t.Fatal("private read after authority loss", mode, err)
		}
	}
}
func TestPrivateDraftDelayedCreateGenerationFencePostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	late := f.create(t, c)
	replacement := f.create(t, c)
	f.mode.Store("wait-diff")
	done := make(chan error, 1)
	go func() {
		_, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(late))
		done <- err
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("capture wait not reached")
	}
	f.mode.Store("")
	out := savePrivateDraft(t, c, replacement)
	del := &golfv1.DeletePullRequestReviewDraftRequest{Target: f.target(), DraftId: out.Draft.Id, ExpectedVersion: "1", ExpectedTargetGeneration: "1", OperationId: uuid.NewString()}
	if _, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del)); err != nil {
		t.Fatal(err)
	}
	fresh := f.create(t, c)
	fresh.ExpectedTargetGeneration = "2"
	savePrivateDraft(t, c, fresh)
	f.resume <- struct{}{}
	select {
	case err := <-done:
		if connect.CodeOf(err) != connect.CodeAborted {
			t.Fatal("ABA old capture admitted", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("late request did not settle")
	}
	var count int
	_ = f.db.QueryRow("SELECT count(*) FROM golf_review_drafts WHERE id=$1", late.DraftId).Scan(&count)
	if count != 0 {
		t.Fatal("late draft materialized")
	}
}
func TestPrivateDraftSessionRevokedDuringCapturePostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	m := f.create(t, c)
	f.mode.Store("wait-diff")
	done := make(chan error, 1)
	go func() {
		_, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(m))
		done <- err
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("capture wait")
	}
	hash, _ := sessionHash(session.Value)
	_, _ = f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash)
	f.resume <- struct{}{}
	select {
	case err := <-done:
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("capture outlived caller", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revocation did not settle")
	}
	var count int
	_ = f.db.QueryRow("SELECT count(*) FROM golf_review_contents").Scan(&count)
	if count != 0 {
		t.Fatal("revoked capture committed")
	}
}
func TestPrivateDraftEncryptedHistoryRotationPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	m := f.create(t, c)
	out := savePrivateDraft(t, c, m)
	edit := editPrivateDraft(out)
	edit.Summary = "second secret"
	savePrivateDraft(t, c, edit)
	keys := rotationKeys(t, f.s.config)
	status, err := KeyStatus(context.Background(), f.db, keys)
	if err != nil {
		t.Fatal(err)
	}
	uses := uint64(0)
	for _, u := range status.Keys {
		if u.KeyID == "legacy" {
			uses = u.ReviewContents
		}
	}
	if uses != 3 {
		t.Fatal("history omitted from usage", uses)
	}
	mustActivate(t, f.db, keys)
	missing := keyedConfig(f.s.config)
	missing.EncryptionKey = ""
	if _, err = New(missing, f.db); !errors.Is(err, errKeyPolicy) {
		t.Fatal("missing historic key allowed startup", err)
	}
	result, err := RotateCredentials(context.Background(), f.db, keys, 2, 10)
	if err != nil || !result.Complete || result.RotatedReviewContents != 3 {
		t.Fatal("rotation omitted history", result.RotatedReviewContents, err)
	}
	if _, err = CheckKeyRetirement(context.Background(), f.db, keys, "legacy"); err != nil {
		t.Fatal("retirement after rotation", err)
	}
	f.s, err = New(missing, f.db)
	if err != nil {
		t.Fatal(err)
	}
	c = f.client(t, session)
	reopened, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, OperationId: m.OperationId}))
	if err != nil || reopened.Msg.Draft.Summary != "second secret" || reopened.Msg.Receipt.AcceptedVersion != "1" {
		t.Fatal("rotation/restart lost original receipt", err)
	}
	replay := savePrivateDraft(t, c, m)
	if replay.CurrentVersion != "2" || replay.Receipt.AcceptedVersion != "1" {
		t.Fatal("rotated intent replay")
	}
	var audited int64
	if err = f.db.QueryRow("SELECT coalesce(sum(review_contents_count),0) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'").Scan(&audited); err != nil || audited != 3 {
		t.Fatal("safe lifecycle counters", err, audited)
	}
}
func TestPrivateDraftImmutableGuardsAndAADPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	m := f.create(t, c)
	savePrivateDraft(t, c, m)
	for _, statement := range []string{"UPDATE golf_review_draft_targets SET generation=0", "UPDATE golf_review_draft_targets SET pull_number=8,generation=generation+1", "DELETE FROM golf_review_draft_targets", "UPDATE golf_review_drafts SET comparison_id='11111111-1111-4111-8111-111111111111',current_version=current_version+1", "DELETE FROM golf_review_drafts", "UPDATE golf_review_draft_versions SET accepted_generation=99", "DELETE FROM golf_review_draft_versions", "UPDATE golf_review_contents SET content_binding=decode(repeat('00',32),'hex')", "DELETE FROM golf_review_contents", "TRUNCATE golf_review_contents CASCADE"} {
		if _, err := f.db.Exec(statement); err == nil {
			t.Fatal("immutable history accepted", statement)
		}
	}
	if _, err := f.db.Exec("UPDATE golf_review_contents SET encrypted_content=(SELECT encrypted_content FROM golf_review_contents WHERE kind='operation' LIMIT 1) WHERE kind='comparison'"); err != nil {
		t.Fatal(err)
	}
	if out, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId})); connect.CodeOf(err) != connect.CodeUnavailable || out != nil {
		t.Fatal("ciphertext transplant disclosed body", err)
	}
}
func TestPrivateDraftEncodedTransportBoundsPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	m := f.create(t, c)
	m.Summary = strings.Repeat("<", 6000)
	m.Entries[0].Body = strings.Repeat("<", 6000)
	raw, err := protojson.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	escaped := strings.ReplaceAll(string(raw), "<", `\u003c`)
	if len(escaped) <= 16<<10 {
		t.Fatal("test does not exceed prior16KiB boundary")
	}
	r := httptest.NewRequest("POST", "/rpc"+golfv1connect.RepositoryServiceSavePullRequestReviewDraftProcedure, strings.NewReader(escaped))
	r.Header.Set("Origin", f.s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	r.AddCookie(f.s.sessionCookie(session.Value, session.Expires, 3600))
	w := httptest.NewRecorder()
	f.s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("valid escape-heavy Save: %d %s", w.Code, w.Body.String())
	}
	rawGet, _ := protojson.Marshal(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target()})
	r = httptest.NewRequest("POST", "/rpc"+golfv1connect.RepositoryServiceGetPullRequestReviewDraftProcedure, strings.NewReader(string(rawGet)+strings.Repeat(" ", 16<<10)))
	r.Header.Set("Origin", f.s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	r.AddCookie(f.s.sessionCookie(session.Value, session.Expires, 3600))
	w = httptest.NewRecorder()
	f.s.ServeHTTP(w, r)
	if w.Code == 200 {
		t.Fatal("metadata body bypassed bound")
	}
	overflow := f.create(t, c)
	raw, _ = protojson.Marshal(overflow)
	r = httptest.NewRequest("POST", "/rpc"+golfv1connect.RepositoryServiceSavePullRequestReviewDraftProcedure, strings.NewReader(string(raw)+strings.Repeat(" ", 2<<20)))
	r.Header.Set("Origin", f.s.config.PublicURL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Connect-Protocol-Version", "1")
	r.AddCookie(f.s.sessionCookie(session.Value, session.Expires, 3600))
	w = httptest.NewRecorder()
	f.s.ServeHTTP(w, r)
	if w.Code == 200 {
		t.Fatal("encoded Save bound bypassed")
	}
}
func TestPrivateDraftVersionQuotaPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	out := savePrivateDraft(t, c, f.create(t, c))
	for i := 2; i <= maxReviewDraftVersions; i++ {
		m := editPrivateDraft(out)
		m.Summary = strconv.Itoa(i)
		out = savePrivateDraft(t, c, m)
	}
	if _, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(editPrivateDraft(out))); connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatal("version retention unbounded", err)
	}
	del := &golfv1.DeletePullRequestReviewDraftRequest{Target: f.target(), DraftId: out.Draft.Id, OperationId: uuid.NewString(), ExpectedVersion: out.CurrentVersion, ExpectedTargetGeneration: out.TargetGeneration}
	if _, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del)); err != nil {
		t.Fatal("quota blocked bounded tombstone", err)
	}
}

func TestPrivateDraftOwnerLockWaitRevalidatesPostgres(t *testing.T) {
	for _, action := range []string{"revoke", "expire"} {
		t.Run(action, func(t *testing.T) {
			f := newPrivateDraftFixture(t)
			session := f.session(t, "pat")
			c := f.client(t, session)
			m := f.create(t, c)
			f.mode.Store("wait-diff")
			done := make(chan error, 1)
			go func() {
				_, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(m))
				done <- err
			}()
			select {
			case <-f.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("capture wait")
			}
			tx, err := f.db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			hash, _ := sessionHash(session.Value)
			var owner int64
			if err = tx.QueryRow("SELECT u.id FROM golf_users u JOIN golf_sessions s ON u.id=s.user_id WHERE s.token_hash=$1 FOR UPDATE OF u", hash).Scan(&owner); err != nil {
				t.Fatal(err)
			}
			f.mode.Store("")
			f.resume <- struct{}{}
			deadline := time.Now().Add(5 * time.Second)
			waiting := false
			for time.Now().Before(deadline) {
				var count int
				err = f.db.QueryRow("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM golf_users u%'").Scan(&count)
				if err != nil {
					t.Fatal(err)
				}
				if count > 0 {
					waiting = true
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !waiting {
				t.Fatal("final managed owner lock wait was not observed")
			}
			statement := "DELETE FROM golf_sessions WHERE token_hash=$1"
			if action == "expire" {
				statement = "UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1"
			}
			if _, err = f.db.Exec(statement, hash); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if connect.CodeOf(err) != connect.CodeUnauthenticated {
					t.Fatal("blocked owner outlived session", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("blocked owner did not settle")
			}
			var count int
			_ = f.db.QueryRow("SELECT count(*) FROM golf_review_contents").Scan(&count)
			if count != 0 {
				t.Fatal("blocked owner committed private content")
			}
		})
	}
}
func TestPrivateDraftPostCommitAuthorityUncertaintyPostgres(t *testing.T) {
	for _, mode := range []string{"deny-after-commit", "rebind-after-commit"} {
		t.Run(mode, func(t *testing.T) {
			f := newPrivateDraftFixture(t)
			c := f.client(t, f.session(t, "pat"))
			m := f.create(t, c)
			f.mode.Store(mode)
			response, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(m))
			if err == nil || response != nil {
				t.Fatal("postcommit authority leaked body")
			}
			var ce *connect.Error
			if !errors.As(err, &ce) || ce.Meta().Get("Golf-Draft-Effect") != "" {
				t.Fatal("postcommit refusal claimed no effect", err)
			}
			if mode == "rebind-after-commit" && connect.CodeOf(err) != connect.CodeUnavailable {
				t.Fatal("committed identity uncertainty used no-effect code", err)
			}
			var versions int
			_ = f.db.QueryRow("SELECT count(*) FROM golf_review_draft_versions").Scan(&versions)
			if versions != 1 {
				t.Fatal("test did not commit before authority loss")
			}
			f.mode.Store("")
			lookup, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, OperationId: m.OperationId}))
			if err != nil || lookup.Msg.Receipt.AcceptedVersion != "1" {
				t.Fatal("restored authority lost durable receipt", err)
			}
			savePrivateDraft(t, c, m)
			_ = f.db.QueryRow("SELECT count(*) FROM golf_review_draft_versions").Scan(&versions)
			if versions != 1 {
				t.Fatal("uncertain ack replay added version")
			}
		})
	}
}
func TestPrivateDraftTombstoneHistoryRotationPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	session := f.session(t, "pat")
	c := f.client(t, session)
	m := f.create(t, c)
	out := savePrivateDraft(t, c, m)
	del := &golfv1.DeletePullRequestReviewDraftRequest{Target: f.target(), DraftId: out.Draft.Id, ExpectedVersion: "1", ExpectedTargetGeneration: "1", OperationId: uuid.NewString()}
	if _, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del)); err != nil {
		t.Fatal(err)
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	if _, err := CheckKeyRetirement(context.Background(), f.db, keys, "legacy"); !errors.Is(err, errKeyRetirement) {
		t.Fatal("tombstone history key retired", err)
	}
	rotation, err := RotateCredentials(context.Background(), f.db, keys, 2, 10)
	if err != nil || !rotation.Complete || rotation.RotatedReviewContents != 3 {
		t.Fatal("DELETE receipt history omitted", err)
	}
	config := keyedConfig(f.s.config)
	config.EncryptionKey = ""
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	c = f.client(t, session)
	lookup, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, OperationId: del.OperationId}))
	if err != nil || !lookup.Msg.Deleted || lookup.Msg.Draft != nil || lookup.Msg.Receipt.Kind != golfv1.PullReviewDraftOperationKind_PULL_REVIEW_DRAFT_OPERATION_KIND_DELETE {
		t.Fatal("rotated tombstone receipt", err)
	}
	if _, err = c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del)); err != nil {
		t.Fatal("rotated delete exact replay", err)
	}
}
func TestPrivateDraftSaturatedSaveQuotaAllowsAllTombstonesPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	records := make([]*golfv1.SavePullRequestReviewDraftResponse, 0, maxReviewOwnerRecords/2)
	for n := int64(7); n < int64(7+maxReviewOwnerRecords/2); n++ {
		m := f.create(t, c)
		m.Target.Number = uint32(n)
		m.Target.PullRequestId = strconv.FormatInt(9007199254740993+n-7, 10)
		pr, err := c.GetPullRequest(context.Background(), connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: m.Target.Repository, Number: uint32(n)}))
		if err != nil {
			t.Fatal(err)
		}
		m.GetCapture().Selection.Number = m.Target.Number
		m.GetCapture().Selection.PullRequestId = m.Target.PullRequestId
		m.GetCapture().ExpectedPullRevision = pr.Msg.PullRequest.Revision
		records = append(records, savePrivateDraft(t, c, m))
	}
	extra := f.create(t, c)
	extra.Target.Number = 900
	extra.Target.PullRequestId = strconv.FormatInt(9007199254740993+900-7, 10)
	pr, err := c.GetPullRequest(context.Background(), connect.NewRequest(&golfv1.GetPullRequestRequest{Repository: extra.Target.Repository, Number: 900}))
	if err != nil {
		t.Fatal(err)
	}
	extra.GetCapture().Selection.Number = 900
	extra.GetCapture().Selection.PullRequestId = extra.Target.PullRequestId
	extra.GetCapture().ExpectedPullRevision = pr.Msg.PullRequest.Revision
	if _, err = c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(extra)); connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatal("save quota bypass", err)
	}
	for _, out := range records {
		del := &golfv1.DeletePullRequestReviewDraftRequest{Target: out.Draft.Target, DraftId: out.Draft.Id, ExpectedVersion: "1", ExpectedTargetGeneration: "1", OperationId: uuid.NewString()}
		if _, err = c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del)); err != nil {
			t.Fatal("saturated quota prevented tombstone", err)
		}
	}
	var count, active int
	_ = f.db.QueryRow("SELECT count(*) FROM golf_review_contents").Scan(&count)
	_ = f.db.QueryRow("SELECT count(*) FROM golf_review_drafts WHERE NOT deleted").Scan(&active)
	if count != 1500 || active != 0 {
		t.Fatal("tombstone reserve count", count, active)
	}
}

func TestPrivateDraftLiteralCoordinateInventory(t *testing.T) {
	cases := []struct {
		name, raw, path string
		side            golfv1.PullReviewDraftSide
		line            uint32
		allowed         bool
	}{
		{"add-new", "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000..aaaa\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n", "new.txt", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, 1, true},
		{"add-old-missing", "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000..aaaa\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n", "new.txt", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD, 1, false},
		{"delete-old", "diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\nindex aaaa..0000\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n", "deleted.txt", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD, 1, true},
		{"delete-new-missing", "diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\nindex aaaa..0000\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n", "deleted.txt", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, 1, false},
		{"rename-old-literal", "diff --git a/old.txt b/new.txt\nsimilarity index 50%\nrename from old.txt\nrename to new.txt\nindex aaaa..bbbb 100644\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n", "old.txt", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD, 1, true},
		{"rename-wrong-side-path", "diff --git a/old.txt b/new.txt\nsimilarity index 50%\nrename from old.txt\nrename to new.txt\nindex aaaa..bbbb 100644\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n", "old.txt", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, 1, false},
		{"quoted-unicode", "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"\nindex aaaa..bbbb 100644\n--- \"a/caf\\303\\251.txt\"\n+++ \"b/caf\\303\\251.txt\"\n@@ -1 +1 @@\n-old\n+new\n", "café.txt", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, 1, true},
		{"binary", "diff --git a/image b/image\nBinary files a/image and b/image differ\n", "image", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, 1, false},
		{"submodule", "diff --git a/module b/module\nindex aaaa..bbbb 160000\n--- a/module\n+++ b/module\n@@ -1 +1 @@\n-Subproject commit aaaa\n+Subproject commit bbbb\n", "module", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, 1, false},
		{"unsafe-cr", strings.Replace(privateDraftDiff, "+new\n", "+new\r\n", 1), "src/example.ts", golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW, 2, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := &golfv1.PullReviewDraftEntry{Id: uuid.NewString(), Body: "body", Coordinate: &golfv1.PullReviewDraftCoordinate{Path: tc.path, Side: tc.side, Line: tc.line}}
			err := validateReviewDraftContents("", []*golfv1.PullReviewDraftEntry{e}, &golfv1.PullReviewDraftComparison{RawDiff: tc.raw})
			if (err == nil) != tc.allowed {
				t.Fatal("literal coordinate admission", err)
			}
		})
	}
	// Original inventory indices survive client sorting/filtering; the second
	// native file cannot be selected through index0 with its literal path.
	raw := strings.ReplaceAll(privateDraftDiff, "src/example.ts", "z.ts") + strings.ReplaceAll(privateDraftDiff, "src/example.ts", "a.ts")
	entry := &golfv1.PullReviewDraftEntry{Id: uuid.NewString(), Body: "body", Coordinate: &golfv1.PullReviewDraftCoordinate{FileIndex: 1, Path: "a.ts", Line: 2, Side: golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW}}
	if err := validateReviewDraftContents("", []*golfv1.PullReviewDraftEntry{entry}, &golfv1.PullReviewDraftComparison{RawDiff: raw}); err != nil {
		t.Fatal("original index", err)
	}
	entry.Coordinate.FileIndex = 0
	if validateReviewDraftContents("", []*golfv1.PullReviewDraftEntry{entry}, &golfv1.PullReviewDraftComparison{RawDiff: raw}) == nil {
		t.Fatal("filtered inventory remapped coordinate")
	}
}
func TestPrivateDraftExactTypedReplayAndTombstoneUUIDPostgres(t *testing.T) {
	f := newPrivateDraftFixture(t)
	c := f.client(t, f.session(t, "pat"))
	m := f.create(t, c)
	// Two explicit sides on one unchanged context row are different coordinates.
	contextEntry := &golfv1.PullReviewDraftEntry{Id: uuid.NewString(), Body: "old context", Coordinate: &golfv1.PullReviewDraftCoordinate{Path: "src/example.ts", Line: 1, Side: golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD}}
	m.Entries = append(m.Entries, contextEntry)
	out := savePrivateDraft(t, c, m)
	reordered := proto.Clone(m).(*golfv1.SavePullRequestReviewDraftRequest)
	reordered.Entries[0], reordered.Entries[1] = reordered.Entries[1], reordered.Entries[0]
	if _, err := c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(reordered)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("entry order changed accepted intent", err)
	}
	del := &golfv1.DeletePullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId, ExpectedVersion: "1", ExpectedTargetGeneration: "1", OperationId: uuid.NewString()}
	deleted, err := c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(del))
	if err != nil {
		t.Fatal(err)
	}
	resurrect := proto.Clone(m).(*golfv1.SavePullRequestReviewDraftRequest)
	resurrect.OperationId = uuid.NewString()
	resurrect.ExpectedTargetGeneration = deleted.Msg.TargetGeneration
	if _, err = c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(resurrect)); connect.CodeOf(err) != connect.CodeAborted {
		t.Fatal("deleted UUID reused at current generation", err)
	}
	inspect, err := c.GetPullRequestReviewDraft(context.Background(), connect.NewRequest(&golfv1.GetPullRequestReviewDraftRequest{Target: f.target(), DraftId: m.DraftId}))
	if err != nil || !inspect.Msg.Deleted || inspect.Msg.Draft != nil || inspect.Msg.TargetGeneration != "2" {
		t.Fatal("refusal changed tombstone", err)
	}
	stale := editPrivateDraft(out)
	stale.OperationId = uuid.NewString()
	_, err = c.SavePullRequestReviewDraft(context.Background(), connect.NewRequest(stale))
	var ce *connect.Error
	if connect.CodeOf(err) != connect.CodeAborted || !errors.As(err, &ce) || ce.Meta().Get("Golf-Draft-Effect") != "none" {
		t.Fatal("CAS refusal lost definitive no-effect metadata", err)
	}
	changedDelete := proto.Clone(del).(*golfv1.DeletePullRequestReviewDraftRequest)
	changedDelete.ExpectedTargetGeneration = "2"
	_, err = c.DeletePullRequestReviewDraft(context.Background(), connect.NewRequest(changedDelete))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !errors.As(err, &ce) || ce.Meta().Get("Golf-Draft-Effect") != "" {
		t.Fatal("accepted intent conflict invented no-effect replacement", err)
	}
}
