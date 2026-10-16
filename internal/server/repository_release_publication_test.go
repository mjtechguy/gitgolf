package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

func releasePublicationFixtureRequest() *golfv1.SubmitRepositoryReleasePublicationRequest {
	return &golfv1.SubmitRepositoryReleasePublicationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "private"}, RepositoryId: "11", OwnerId: "42", AccessRevision: strings.Repeat("a", 64), OperationId: uuid.NewString(), TagName: "release/α", TagObjectId: strings.Repeat("b", 40), CommitId: strings.Repeat("c", 40), Title: "Explicit release α", BodyMarkdown: "Literal ${{ untouched }} notes\n", Prerelease: true}
}
func TestReleasePublicationInputAndFingerprint(t *testing.T) {
	m := releasePublicationFixtureRequest()
	if e := validateReleasePublication(m); e != nil {
		t.Fatal(e)
	}
	h := releasePublicationFingerprint(m)
	m.OperationId = uuid.NewString()
	if !bytes.Equal(h, releasePublicationFingerprint(m)) {
		t.Fatal("operation key changed semantic fingerprint")
	}
	for _, field := range []string{"title", "notes", "tag", "object", "commit", "owner", "repo", "revision", "prerelease"} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryReleasePublicationRequest)
		switch field {
		case "title":
			c.Title = "Another title"
		case "notes":
			c.BodyMarkdown += "x"
		case "tag":
			c.TagName = "different"
		case "object":
			c.TagObjectId = strings.Repeat("d", 40)
		case "commit":
			c.CommitId = strings.Repeat("d", 40)
		case "owner":
			c.OwnerId = "43"
		case "repo":
			c.RepositoryId = "12"
		case "revision":
			c.AccessRevision = strings.Repeat("d", 64)
		case "prerelease":
			c.Prerelease = false
		}
		if bytes.Equal(h, releasePublicationFingerprint(c)) {
			t.Fatal("intent field unbound", field)
		}
	}
	for _, field := range []string{"id", "key", "revision", "ref", "object", "width", "title", "titlebytes", "notes", "control"} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryReleasePublicationRequest)
		switch field {
		case "id":
			c.RepositoryId = "011"
		case "key":
			c.OperationId = "bad"
		case "revision":
			c.AccessRevision = "bad"
		case "ref":
			c.TagName = "refs/tags/v1"
		case "object":
			c.TagObjectId = "v1"
		case "width":
			c.CommitId = strings.Repeat("c", 64)
		case "title":
			c.Title = " title"
		case "titlebytes":
			c.Title = strings.Repeat("α", 128)
		case "notes":
			c.BodyMarkdown = strings.Repeat("x", (16<<10)+1)
		case "control":
			c.BodyMarkdown = "bad\x00"
		}
		if validateReleasePublication(c) == nil {
			t.Fatal("invalid input admitted", field)
		}
	}
}
func TestReleasePublicationExactNativeReceipt(t *testing.T) {
	m := releasePublicationFixtureRequest()
	r := releasePublicationRecord{ActorID: 42, Tag: m.TagName, Commit: m.CommitId, TitleSHA: releasePublicationTextHash(m.Title), BodySHA: releasePublicationTextHash(m.BodyMarkdown), Prerelease: true}
	row := releaseFixtureRow()
	no, yes := false, true
	row.TagName = m.TagName
	row.TargetCommitish = m.CommitId
	row.Title = m.Title
	row.Body = m.BodyMarkdown
	row.Draft = &no
	row.Prerelease = &yes
	row.Assets = []forgeReleaseAsset{}
	if !releasePublicationMatches(row, r) {
		t.Fatal("exact native publication refused")
	}
	for _, field := range []string{"author", "tag", "target", "title", "notes", "draft", "prerelease", "assets", "timestamp", "flags"} {
		c := row
		c.Author = &User{ID: 42, Login: "alice"}
		switch field {
		case "author":
			c.Author.ID = 43
		case "tag":
			c.TagName = "another"
		case "target":
			c.TargetCommitish = "main"
		case "title":
			c.Title += "x"
		case "notes":
			c.Body += "x"
		case "draft":
			c.Draft = &yes
		case "prerelease":
			c.Prerelease = &no
		case "assets":
			c.Assets = releaseFixtureRow().Assets
		case "timestamp":
			c.CreatedAt = ""
		case "flags":
			c.Draft = nil
		}
		if releasePublicationMatches(c, r) {
			t.Fatal("foreign/malformed receipt adopted", field)
		}
	}
}
func TestReleasePublicationManagedOuterBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, procedure := range []string{golfv1connect.RepositoryReleasePublicationServiceSubmitRepositoryReleasePublicationProcedure, golfv1connect.RepositoryReleasePublicationServiceGetRepositoryReleasePublicationOperationProcedure} {
		for _, kind := range []string{"anonymous", "origin", "bearer"} {
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/rpc"+procedure, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Connect-Protocol-Version", "1")
			req.Header.Set("Origin", s.config.PublicURL)
			want := 401
			if kind == "origin" {
				req.Header.Set("Origin", "https://other.invalid")
				want = 403
			}
			if kind == "bearer" {
				req.Header.Set("Authorization", "Bearer golf_ro_"+strings.Repeat("A", 43))
				want = 403
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("managed-only boundary", kind, w.Code)
			}
		}
	}
}

type releasePublicationFixture struct {
	*pullFixture
	calls      atomic.Int32
	state      sync.Mutex
	mode       atomic.Value
	published  *forgeRepositoryRelease
	mergeCalls atomic.Int32
}

func newReleasePublicationFixture(t *testing.T) *releasePublicationFixture {
	t.Helper()
	f := &releasePublicationFixture{pullFixture: &pullFixture{db: testDatabase(t)}}
	f.mode.Store("")
	f.pullFixture.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mode := f.mode.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		if mode == "revoked" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/v1/user":
			id := int64(42)
			login := "alice"
			if r.Header.Get("Authorization") == "token other-pat" {
				id = 43
				login = "bob"
			}
			if mode == "actor" {
				id++
			}
			json.NewEncoder(w).Encode(map[string]any{"id": id, "login": login, "is_admin": false})
			return
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{{ID: 42, Login: "alice"}}})
			return
		case "/api/v1/repos/alice/private":
			if mode == "denied" {
				w.WriteHeader(404)
				return
			}
			row := settingsFixtureRow()
			row.ID = 11
			row.Name = "private"
			row.FullName = "alice/private"
			row.HTMLURL = "https://forge.invalid/alice/private"
			if mode == "replacement" {
				row.ID++
			}
			if mode == "transfer" {
				row.Owner.ID++
			}
			if mode == "archived" {
				yes := true
				row.Archived = &yes
			}
			if mode == "mirror" {
				yes := true
				row.Mirror = &yes
			}
			if mode == "reader" {
				row.Permissions.Admin = false
			}
			has := mode != "disabled"
			var releases *bool = &has
			if mode == "unknown-unit" {
				releases = nil
			}
			config := rulesRepositoryFixture()
			config.forgeRepositorySettings = row
			raw, _ := json.Marshal(config)
			var observed map[string]any
			json.Unmarshal(raw, &observed)
			observed["has_releases"] = releases
			observed["has_actions"] = false
			observed["permissions"] = map[string]bool{"admin": row.Permissions.Admin, "push": mode != "reader", "pull": true}
			json.NewEncoder(w).Encode(observed)
			return
		case "/api/v1/repos/alice/private/collaborators/alice/permission":
			permission := "owner"
			if mode == "reader" {
				permission = "read"
			}
			if mode == "global" {
				permission = "admin"
			}
			json.NewEncoder(w).Encode(map[string]any{"permission": permission, "user": User{ID: 42, Login: "alice"}})
			return
		case "/api/v1/repos/alice/private/collaborators/bob/permission":
			json.NewEncoder(w).Encode(map[string]any{"permission": "admin", "user": User{ID: 43, Login: "bob"}})
			return
		case "/api/v1/repos/alice/private/collaborators/bob":
			if mode == "global" {
				w.WriteHeader(404)
				return
			}
			w.WriteHeader(204)
			return
		case "/api/v1/repos/alice/private/pulls/7":
			json.NewEncoder(w).Encode(standardMergeFixturePull(false))
			return
		case "/api/v1/repos/alice/private/commits":
			json.NewEncoder(w).Encode([]any{workspaceCommit(strings.Repeat("a", 40))})
			return
		case "/api/v1/repos/alice/private/branches/main":
			json.NewEncoder(w).Encode(map[string]any{"name": "main", "commit": map[string]string{"id": strings.Repeat("b", 40)}, "protected": false, "user_can_merge": true})
			return
		case "/api/v1/repos/alice/private/git/refs/heads/feature/slash", "/api/v1/repos/alice/private/git/refs/heads/main":
			name := strings.TrimPrefix(r.URL.Path, "/api/v1/repos/alice/private/git/refs/heads/")
			sha := strings.Repeat("a", 40)
			if name == "main" {
				sha = strings.Repeat("b", 40)
			}
			json.NewEncoder(w).Encode([]any{map[string]any{"ref": "refs/heads/" + name, "object": map[string]string{"type": "commit", "sha": sha}}})
			return
		case "/api/v1/repos/alice/private/pulls/7/merge":
			if r.Method != http.MethodPost {
				w.WriteHeader(405)
				return
			}
			f.mergeCalls.Add(1)
			w.WriteHeader(500)
			return
		case "/api/v1/repos/alice/private/tag_protections":
			rows := []forgeTagProtection{}
			if mode == "protected" {
				rows = append(rows, rulesTagFixture())
			}
			json.NewEncoder(w).Encode(rows)
			return
		case "/api/v1/repos/alice/private/tags/release/α":
			tag := suffixTag("release/α", strings.Repeat("c", 40))
			tag.ID = strings.Repeat("b", 40)
			if mode == "tag-drift" {
				tag.ID = strings.Repeat("d", 40)
			}
			if mode == "head-drift" {
				tag.Commit.SHA = strings.Repeat("d", 40)
			}
			if mode == "moved-after" && f.calls.Load() > 0 {
				tag.ID = strings.Repeat("d", 40)
			}
			json.NewEncoder(w).Encode(tag)
			return
		case "/api/v1/repos/alice/private/releases/tags/release/α":
			f.state.Lock()
			p := f.published
			f.state.Unlock()
			if p == nil && mode != "existing" {
				w.WriteHeader(404)
				return
			}
			if p == nil {
				row := releaseFixtureRow()
				p = &row
			}
			json.NewEncoder(w).Encode(p)
			return
		case "/api/v1/repos/alice/private/releases":
			if r.Method != http.MethodPost {
				w.WriteHeader(405)
				return
			}
			var payload struct {
				Tag        string `json:"tag_name"`
				Target     string `json:"target_commitish"`
				Title      string `json:"name"`
				Body       string `json:"body"`
				Draft      *bool  `json:"draft"`
				Prerelease *bool  `json:"prerelease"`
			}
			if json.NewDecoder(r.Body).Decode(&payload) != nil || payload.Tag != "release/α" || payload.Target != strings.Repeat("c", 40) || payload.Draft == nil || *payload.Draft || payload.Prerelease == nil {
				t.Error("unsupported native release payload")
				w.WriteHeader(400)
				return
			}
			f.calls.Add(1)
			no := false
			row := releaseFixtureRow()
			row.Title = payload.Title
			row.Body = payload.Body
			row.TagName = payload.Tag
			row.TargetCommitish = payload.Target
			row.Draft = &no
			row.Prerelease = payload.Prerelease
			row.Assets = []forgeReleaseAsset{}
			if r.Header.Get("Authorization") == "token other-pat" {
				row.Author = &User{ID: 43, Login: "bob"}
			}
			f.state.Lock()
			f.published = &row
			f.state.Unlock()
			if mode == "lost-response" {
				w.WriteHeader(500)
				return
			}
			if mode == "late-denied" {
				f.mode.Store("denied")
			}
			if mode == "bad-author" {
				row.Author = &User{ID: 43, Login: "other"}
			}
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(row)
			return
		case "/api/v1/repos/alice/private/releases/9007199254740993":
			if mode == "read-failed" {
				w.WriteHeader(503)
				return
			}
			f.state.Lock()
			p := f.published
			f.state.Unlock()
			if p == nil {
				w.WriteHeader(404)
				return
			}
			row := *p
			if mode == "bad-notes" {
				row.Body += "wrong"
			}
			json.NewEncoder(w).Encode(row)
			return
		}
		f.serveProvider(w, r)
	}))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.ForgePublicURL = provider.URL
	config.ForgeOAuthClientID = "fixture-client"
	config.ForgeOAuthClientSecret = "fixture-secret"
	var e error
	f.s, e = New(config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *releasePublicationFixture) scope(session loginResult) (context.Context, forgeCredential, http.Header) {
	token := forgeCredential{Kind: "pat", Token: "pull-pat"}
	header := http.Header{}
	header.Set("Cookie", f.s.sessionCookie(session.Value, session.Expires, 3600).String())
	header.Set("Origin", f.s.config.PublicURL)
	return context.WithValue(context.Background(), sessionTokenKey{}, token), token, header
}
func (f *releasePublicationFixture) request(t *testing.T, session loginResult) *golfv1.SubmitRepositoryReleasePublicationRequest {
	t.Helper()
	m := releasePublicationFixtureRequest()
	ctx, token, header := f.scope(session)
	var actor User
	if e := f.s.withForgeCaller(ctx, session.Value, token, func(u User) error { actor = u; return nil }); e != nil {
		t.Fatal(e)
	}
	access, e := f.s.readRepositoryAccess(ctx, token, keyFrom(m.Repository), actor)
	if e != nil {
		t.Fatal(e)
	}
	m.AccessRevision = access.Revision
	_ = header
	return m
}
func (f *releasePublicationFixture) client(t *testing.T, session loginResult) golfv1connect.RepositoryReleasePublicationServiceClient {
	t.Helper()
	_, _, _, c, origin := testRPCClients(t, f.s)
	c.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return golfv1connect.NewRepositoryReleasePublicationServiceClient(c, origin.String()+"/rpc")
}
func (f *releasePublicationFixture) submit(t *testing.T, session loginResult, m *golfv1.SubmitRepositoryReleasePublicationRequest) (*golfv1.RepositoryReleasePublicationOperation, error) {
	t.Helper()
	req := connect.NewRequest(m)
	req.Header().Set("Origin", f.s.config.PublicURL)
	r, e := f.client(t, session).SubmitRepositoryReleasePublication(context.Background(), req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func (f *releasePublicationFixture) status(t *testing.T, session loginResult, m *golfv1.SubmitRepositoryReleasePublicationRequest) (*golfv1.RepositoryReleasePublicationOperation, error) {
	t.Helper()
	req := connect.NewRequest(releasePublicationStatus(m))
	req.Header().Set("Origin", f.s.config.PublicURL)
	r, e := f.client(t, session).GetRepositoryReleasePublicationOperation(context.Background(), req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func TestReleasePublicationOnceAndOriginalPostgres(t *testing.T) {
	f := newReleasePublicationFixture(t)
	session := f.session(t, "pat")
	m := f.request(t, session)
	// Exact allowed16KiB decoded notes exceed the ordinary16KiB outer RPC cap
	// after JSON escaping; exercise the actual managed ServeHTTP path.
	m.BodyMarkdown = strings.Repeat("\t", 16<<10)
	first, e := f.submit(t, session, m)
	if e != nil {
		t.Fatal(e)
	}
	if first.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED || first.ReleaseId != "9007199254740993" || first.TitleSha256 != releasePublicationTextHash(m.Title) || first.BodySha256 != releasePublicationTextHash(m.BodyMarkdown) {
		t.Fatal("native independent receipt")
	}
	replay, e := f.submit(t, session, m)
	if e != nil || !proto.Equal(first, replay) || f.calls.Load() != 1 {
		t.Fatal("original replay wrote", e)
	}
	for _, field := range []string{"title", "body", "tag", "object", "commit", "prerelease"} {
		c := proto.Clone(m).(*golfv1.SubmitRepositoryReleasePublicationRequest)
		switch field {
		case "title":
			c.Title += "x"
		case "body":
			c.BodyMarkdown = "x" + c.BodyMarkdown[1:]
		case "tag":
			c.TagName = "different"
		case "object":
			c.TagObjectId = strings.Repeat("d", 40)
		case "commit":
			c.CommitId = strings.Repeat("d", 40)
		case "prerelease":
			c.Prerelease = false
		}
		if e := validateReleasePublication(c); e != nil {
			t.Fatal("changed intent must remain valid", field, e)
		}
		if _, e = f.submit(t, session, c); connect.CodeOf(e) != connect.CodeFailedPrecondition {
			t.Fatal("changed intent accepted", field, e)
		}
	}
	other, e := f.s.createSession(context.Background(), User{ID: 43, Login: "bob"}, "pat", "other-pat", "")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.status(t, other, m); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("other ordinary admin discovered original", e)
	}
	for _, mode := range []string{"archived", "mirror"} {
		f.mode.Store(mode)
		historical, e := f.status(t, session, m)
		if e != nil || !proto.Equal(first, historical) {
			t.Fatal("current ordinary admin historical metadata denied", mode, e)
		}
	}
	f.mode.Store("tag-drift")
	observed, e := f.status(t, session, m)
	if e != nil || !proto.Equal(first, observed) || f.calls.Load() != 1 {
		t.Fatal("historical receipt recomputed from moved tag", e)
	}
	var stored string
	var count int
	if e = f.db.QueryRow(`SELECT row_to_json(t)::text FROM golf_repository_release_publications t`).Scan(&stored); e != nil || strings.Contains(stored, m.Title) || strings.Contains(stored, m.BodyMarkdown) {
		t.Fatal("plaintext journal", e)
	}
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_repository_release_publication_events`).Scan(&count); e != nil || count != 3 {
		t.Fatal("event phases", e, count)
	}
	if _, e = f.db.Exec(`UPDATE golf_repository_release_publications SET tag_object_id=$1`, strings.Repeat("d", 40)); e == nil {
		t.Fatal("immutable publication altered")
	}
}
func TestReleasePublicationRefusalAndUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"protected", "tag-drift", "head-drift", "disabled", "unknown-unit", "existing", "archived", "mirror", "lost-response", "read-failed", "bad-author", "bad-notes", "moved-after", "late-denied"} {
		t.Run(mode, func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			session := f.session(t, "pat")
			m := f.request(t, session)
			f.mode.Store(mode)
			first, e := f.submit(t, session, m)
			if mode == "late-denied" {
				if connect.CodeOf(e) != connect.CodeNotFound {
					t.Fatal("late privacy denial", e)
				}
				f.mode.Store("")
				first, e = f.status(t, session, m)
			}
			if e != nil {
				t.Fatal(e)
			}
			known := mode == "protected" || mode == "tag-drift" || mode == "head-drift" || mode == "disabled" || mode == "unknown-unit" || mode == "existing" || mode == "archived" || mode == "mirror"
			phase := golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_DISPATCH_UNKNOWN
			calls := int32(1)
			if known {
				phase = golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_REJECTED
				calls = 0
			}
			if first.Phase != phase || f.calls.Load() != calls || first.ReleaseId != "" {
				t.Fatal("effect classification", mode, first.Phase, f.calls.Load())
			}
			f.mode.Store("")
			replay, e := f.submit(t, session, m)
			if e != nil || replay.Phase != phase || f.calls.Load() != calls {
				t.Fatal("unknown adopted/replayed", e)
			}
			if !known {
				var blocked bool
				var active int
				if e = f.db.QueryRow(`SELECT golf_repository_lifecycle_blocked($1,11),golf_repository_lifecycle_active($1,11)`, f.s.config.ForgeURL).Scan(&blocked, &active); e != nil || !blocked || active < 1 {
					t.Fatal("unresolved exclusion missing", e)
				}
				c := proto.Clone(m).(*golfv1.SubmitRepositoryReleasePublicationRequest)
				c.OperationId = uuid.NewString()
				if _, e = f.submit(t, session, c); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.calls.Load() != 1 {
					t.Fatal("new key bypassed unknown", e)
				}
				// A generic managed repository write cannot reuse the internally scoped permit.
				ctx, token, _ := f.scope(session)
				_, e = f.s.forge(ctx, http.MethodPatch, "/repos/alice/private", token, map[string]any{"description": "blocked"}, nil)
				if !errors.Is(e, errLifecycleBlocked) {
					t.Fatal("generic write bypassed unknown", e)
				}
			}
		})
	}
}
func TestReleasePublicationAuthorityAndConcurrencyPostgres(t *testing.T) {
	for _, mode := range []string{"reader", "replacement", "transfer", "actor", "revoked"} {
		f := newReleasePublicationFixture(t)
		session := f.session(t, "pat")
		m := f.request(t, session)
		f.mode.Store(mode)
		if _, e := f.submit(t, session, m); e == nil || f.calls.Load() != 0 {
			t.Fatal("current authority/identity lost", mode, e)
		}
	}
	f := newReleasePublicationFixture(t)
	session := f.session(t, "pat")
	m := f.request(t, session)
	var wg sync.WaitGroup
	results := make(chan *golfv1.RepositoryReleasePublicationOperation, 2)
	failures := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); r, e := f.submit(t, session, m); results <- r; failures <- e }()
	}
	wg.Wait()
	close(results)
	close(failures)
	for e := range failures {
		if e != nil {
			t.Fatal(e)
		}
	}
	for r := range results {
		if r.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED && r.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_RESERVED && r.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_DISPATCH_UNKNOWN {
			t.Fatal("invalid concurrent original")
		}
	}
	if f.calls.Load() != 1 {
		t.Fatal("same original dispatched more than once")
	}
	f.mode.Store("reader")
	if _, e := f.status(t, session, m); e == nil {
		t.Fatal("reader retained private status")
	}
	f.mode.Store("")
	ctx, _, _ := f.scope(session)
	if e := f.s.logoutSession(ctx, session.Value); e != nil {
		t.Fatal(e)
	}
	if _, e := f.status(t, session, m); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("logout retained original", e)
	}
	var count int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_repository_release_publications`).Scan(&count); e != nil || count != 1 {
		t.Fatal("authority denials admitted", e, strconv.Itoa(count))
	}
}

func TestReleasePublicationOrdinaryDirectAdminPostgres(t *testing.T) {
	for _, exceptionOnly := range []bool{false, true} {
		t.Run(strconv.FormatBool(exceptionOnly), func(t *testing.T) {
			f := newReleasePublicationFixture(t)
			owner := f.session(t, "pat")
			m := f.request(t, owner)
			bob, e := f.s.createSession(context.Background(), User{ID: 43, Login: "bob"}, "pat", "other-pat", "")
			if e != nil {
				t.Fatal(e)
			}
			if exceptionOnly {
				f.mode.Store("global")
			}
			r, e := f.submit(t, bob, m)
			if exceptionOnly {
				if connect.CodeOf(e) != connect.CodePermissionDenied || f.calls.Load() != 0 {
					t.Fatal("exceptional native aggregate administration supplied publication authority", e)
				}
				return
			}
			if e != nil || r.ActorId != "43" || r.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_SUCCEEDED || f.calls.Load() != 1 {
				t.Fatal("current direct admin publication", e)
			}
		})
	}
}

// These source-PG fixtures reserve the existing Golf journal, never mutate the
// native database/refs. Fork-source cases exercise the SQL admission boundary.
func (f *releasePublicationFixture) seedPendingMerge(t *testing.T, session loginResult, m *golfv1.SubmitStandardPullMergeRequest, phase string) error {
	t.Helper()
	target, _ := discussionID(m.Selection.RepositoryId)
	owner, _ := discussionID(m.OwnerId)
	source, _ := discussionID(m.SourceRepositoryId)
	sourceOwner, _ := discussionID(m.SourceOwnerId)
	sourceKey := keyFrom(m.SourceRepository)
	return f.s.workflowTransaction(context.Background(), session.Value, 42, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := f.s.lockStandardMergeLifecycles(context.Background(), tx, target, source, true)
		if e != nil {
			return e
		}
		var id int64
		e = tx.QueryRowContext(held, `INSERT INTO golf_standard_pull_merges(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,pull_request_id,number,expected_pull_revision,head_commit_id,observed_base_commit_id,source_ref,target_ref,input_fingerprint,source_repository_id,source_owner_id,source_repository_owner,source_repository_name) VALUES($1,$2,42,$3,$4,$5,$6,$7,9007199254740993,7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`, c.UserID, f.s.config.ForgeURL, m.OperationId, target, owner, m.Selection.Repository.Owner, m.Selection.Repository.Name, m.ExpectedPullRevision, m.Selection.HeadCommitId, m.Selection.BaseCommitId, m.SourceRef, m.TargetRef, standardMergeFingerprint(m), source, sourceOwner, sourceKey.Owner, sourceKey.Name).Scan(&id)
		if e != nil {
			return e
		}
		if phase == "DISPATCH_UNKNOWN" {
			_, e = tx.ExecContext(held, `UPDATE golf_standard_pull_merges SET phase='DISPATCH_UNKNOWN' WHERE id=$1`, id)
		}
		return e
	})
}
func (f *releasePublicationFixture) submitMerge(t *testing.T, session loginResult, m *golfv1.SubmitStandardPullMergeRequest) (*golfv1.StandardPullMergeOperation, error) {
	t.Helper()
	_, _, _, client, origin := testRPCClients(t, f.s)
	client.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	req := connect.NewRequest(m)
	req.Header().Set("Origin", f.s.config.PublicURL)
	r, e := golfv1connect.NewStandardPullMergeServiceClient(client, origin.String()+"/rpc").SubmitStandardPullMerge(context.Background(), req)
	if e != nil {
		return nil, e
	}
	return r.Msg.Operation, nil
}
func TestReleasePublicationMergeExclusionPostgres(t *testing.T) {
	for _, phase := range []string{"RESERVED", "DISPATCH_UNKNOWN"} {
		for _, coordinate := range []string{"target", "fork-source"} {
			t.Run(phase+"/"+coordinate, func(t *testing.T) {
				f := newReleasePublicationFixture(t)
				session := f.session(t, "pat")
				publication := f.request(t, session)
				merge := standardMergeFixtureRequest()
				if coordinate == "fork-source" {
					merge.Selection.Repository = &golfv1.RepositoryKey{Owner: "alice", Name: "other"}
					merge.Selection.RepositoryId = "12"
					merge.SourceRepository = &golfv1.RepositoryKey{Owner: "alice", Name: "private"}
					merge.SourceRepositoryId = "11"
					merge.SourceOwnerId = "42"
				}
				if e := f.seedPendingMerge(t, session, merge, phase); e != nil {
					t.Fatal(e)
				}
				if _, e := f.submit(t, session, publication); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.calls.Load() != 0 {
					t.Fatal("publication bypassed unresolved merge", e)
				}
				var stored string
				if e := f.db.QueryRow(`SELECT phase FROM golf_standard_pull_merges WHERE operation_id=$1`, merge.OperationId).Scan(&stored); e != nil || stored != phase {
					t.Fatal("competing admission changed original", e)
				}
				var n int
				if e := f.db.QueryRow(`SELECT count(*) FROM golf_repository_release_publications`).Scan(&n); e != nil || n != 0 {
					t.Fatal("competing publication admitted", e)
				}
				if coordinate == "target" {
					original, e := f.submitMerge(t, session, merge)
					if e != nil || original.Phase.String() != "STANDARD_PULL_MERGE_PHASE_"+phase || f.mergeCalls.Load() != 0 {
						t.Fatal("original merge status/replay dispatched", e)
					}
				}
			})
		}
	}
	t.Run("publication-first", func(t *testing.T) {
		f := newReleasePublicationFixture(t)
		owner := f.session(t, "pat")
		publication := f.request(t, owner)
		f.mode.Store("lost-response")
		r, e := f.submit(t, owner, publication)
		if e != nil || r.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_DISPATCH_UNKNOWN {
			t.Fatal(e)
		}
		bob, e := f.s.createSession(context.Background(), User{ID: 43, Login: "bob"}, "pat", "other-pat", "")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.submitMerge(t, bob, standardMergeFixtureRequest()); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.mergeCalls.Load() != 0 {
			t.Fatal("merge bypassed publication exclusion", e)
		}
		original, e := f.status(t, owner, publication)
		if e != nil || !proto.Equal(r, original) || f.calls.Load() != 1 {
			t.Fatal("original publication changed/dispatched", e)
		}
		var n int
		if e = f.db.QueryRow(`SELECT count(*) FROM golf_standard_pull_merges`).Scan(&n); e != nil || n != 0 {
			t.Fatal("competing merge admitted", e)
		}
	})
}
func TestReleasePublicationDistinctActorMergeContentionPostgres(t *testing.T) {
	f := newReleasePublicationFixture(t)
	owner := f.session(t, "pat")
	publication := f.request(t, owner)
	bob, e := f.s.createSession(context.Background(), User{ID: 43, Login: "bob"}, "pat", "other-pat", "")
	if e != nil {
		t.Fatal(e)
	}
	f.mode.Store("lost-response")
	begin := make(chan struct{})
	var wg sync.WaitGroup
	var pub *golfv1.RepositoryReleasePublicationOperation
	var merge *golfv1.StandardPullMergeOperation
	var pubErr, mergeErr error
	wg.Add(2)
	go func() { defer wg.Done(); <-begin; pub, pubErr = f.submit(t, owner, publication) }()
	go func() {
		defer wg.Done()
		<-begin
		merge, mergeErr = f.submitMerge(t, bob, standardMergeFixtureRequest())
	}()
	close(begin)
	wg.Wait()
	if pubErr == nil {
		if pub.Phase != golfv1.RepositoryReleasePublicationPhase_REPOSITORY_RELEASE_PUBLICATION_PHASE_DISPATCH_UNKNOWN || connect.CodeOf(mergeErr) != connect.CodeFailedPrecondition {
			t.Fatal("publication winner did not exclude merge", mergeErr)
		}
	} else if mergeErr == nil {
		if merge.Phase != golfv1.StandardPullMergePhase_STANDARD_PULL_MERGE_PHASE_DISPATCH_UNKNOWN || connect.CodeOf(pubErr) != connect.CodeFailedPrecondition {
			t.Fatal("merge winner did not exclude publication", pubErr)
		}
	} else {
		t.Fatal("neither independent current actor admitted", pubErr, mergeErr)
	}
	if f.calls.Load()+f.mergeCalls.Load() != 1 {
		t.Fatal("competing native writes forwarded", f.calls.Load(), f.mergeCalls.Load())
	}
	var n int
	if e = f.db.QueryRow(`SELECT (SELECT count(*) FROM golf_repository_release_publications WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN'))+(SELECT count(*) FROM golf_standard_pull_merges WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN'))`).Scan(&n); e != nil || n != 1 {
		t.Fatal("mutual admission exclusion", e, n)
	}
}
