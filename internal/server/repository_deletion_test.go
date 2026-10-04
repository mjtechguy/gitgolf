package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestRepositoryDeletionFingerprint(t *testing.T) {
	m := &golfv1.DeleteRepositoryRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: strings.Repeat("a", 64)}
	initial := deletionFingerprint(m)
	m.CurrentPassword = "different secret"
	m.IdempotencyKey = uuid.NewString()
	m.ConfirmationName = "alice/example"
	if !bytes.Equal(initial, deletionFingerprint(m)) {
		t.Fatal("credential or replay-key leaked into semantic intent")
	}
	m.RepositoryId = "18"
	if bytes.Equal(initial, deletionFingerprint(m)) {
		t.Fatal("immutable replacement identity not bound")
	}
	m.RepositoryId = "17"
	m.ExpectedRevision = strings.Repeat("b", 64)
	if bytes.Equal(initial, deletionFingerprint(m)) {
		t.Fatal("displayed revision not bound")
	}
}
func TestRepositoryDeletionDefaultBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	row := lifecycleNativeRepository{forgeRepositorySettings: settingsFixtureRow(), NativeActions: lifecycleActionsFixture("")}
	for _, c := range []managedGitConfiguration{{}, {Enabled: true}, {Enabled: true, Incarnation: uuid.NewString()}} {
		s.managedGit = c
		if !errors.Is(s.deletionBoundary(t.Context(), nil, managementToken(), repositoryKey{"alice", "example"}, row), errDeletionBoundary) {
			t.Fatal("configuration/UUID manufactured enrollment")
		}
	}
}
func TestRepositoryDeletionBrowserCaller(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, managementToken())
	for _, variant := range []string{"origin", "bearer", "delegated", "session"} {
		r := connect.NewRequest(&golfv1.DeleteRepositoryRequest{})
		r.Header().Set("Origin", s.config.PublicURL)
		r.Header().Set("Cookie", "golf_session=fixture")
		callCtx := ctx
		switch variant {
		case "origin":
			r.Header().Set("Origin", "https://other.invalid")
		case "bearer":
			r.Header().Set("Authorization", "Bearer fixture")
		case "delegated":
			callCtx = context.WithValue(ctx, apiAuthKey{}, apiAuth{})
		case "session":
			r.Header().Del("Cookie")
		}
		_, e = s.DeleteRepository(callCtx, r)
		want := connect.CodePermissionDenied
		if variant == "session" {
			want = connect.CodeUnauthenticated
		}
		if connect.CodeOf(e) != want {
			t.Fatal(variant, e)
		}
		q := connect.NewRequest(&golfv1.GetRepositoryDeletionOperationRequest{})
		q.Header().Add("Origin", r.Header().Get("Origin"))
		q.Header().Add("Cookie", r.Header().Get("Cookie"))
		q.Header().Add("Authorization", r.Header().Get("Authorization"))
		_, e = s.GetRepositoryDeletionOperation(callCtx, q)
		if connect.CodeOf(e) != want {
			t.Fatal("status", variant, e)
		}
	}
}

type repositoryDeletionFixture struct {
	mu                              sync.Mutex
	row                             forgeRepositorySettings
	organization, organizationOwner bool
	orgID                           int64
	actor                           User
	mode                            string
	deletes, repoReadsAfterDelete   int
	deleted                         bool
	s                               *Server
	session                         loginResult
	credential                      forgeCredential
	beforeDelete                    func()
}

func newRepositoryDeletionFixture(t *testing.T, organization bool) *repositoryDeletionFixture {
	t.Helper()
	f := &repositoryDeletionFixture{row: settingsFixtureRow(), organization: organization, organizationOwner: true, orgID: 77, actor: User{ID: 42, Login: "alice"}}
	if organization {
		f.row.Owner = &User{ID: 77, Login: "acme"}
		f.row.FullName = "acme/example"
	}
	f.row.HTMLURL = "http://forge.invalid/" + f.row.FullName
	db := testDatabase(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
			return
		case "/api/v1/user":
			json.NewEncoder(w).Encode(f.actor)
			return
		case "/api/v1/users/search":
			data := []User{}
			if r.URL.Query().Get("uid") != "77" {
				data = append(data, User{ID: f.row.Owner.ID, Login: f.row.Owner.Login})
			}
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": data})
			return
		case "/api/v1/orgs/acme":
			json.NewEncoder(w).Encode(forgeOrganization{ID: f.orgID, Name: "acme", Visibility: "private"})
			return
		case "/api/v1/orgs/acme/members/alice":
			if f.organizationOwner {
				w.WriteHeader(204)
			} else {
				w.WriteHeader(404)
			}
			return
		case "/api/v1/users/alice/orgs/acme/permissions":
			json.NewEncoder(w).Encode(map[string]bool{"is_owner": f.organizationOwner})
			return
		}
		base := "/api/v1/repos/" + f.row.Owner.Login + "/example"
		if strings.HasPrefix(r.URL.Path, base+"/") && r.Method == http.MethodGet {
			switch strings.TrimPrefix(r.URL.Path, base) {
			case "/branch_protections", "/tag_protections", "/push_mirrors":
				w.Header().Set("X-Total-Count", "0")
				json.NewEncoder(w).Encode([]any{})
				return
			}
		}
		if r.URL.Path != base {
			w.WriteHeader(404)
			return
		}
		if r.Method == http.MethodGet {
			if f.deleted {
				f.repoReadsAfterDelete++
				if f.mode != "replacement" {
					w.WriteHeader(404)
					return
				}
			}
			row := f.row
			if f.deleted && f.mode == "replacement" {
				row.ID++
			}
			json.NewEncoder(w).Encode(lifecycleNativeRepository{forgeRepositorySettings: row, NativeActions: lifecycleActionsFixture(f.mode)})
			return
		}
		if r.Method != http.MethodDelete {
			w.WriteHeader(405)
			return
		}
		if f.beforeDelete != nil {
			f.beforeDelete()
		}
		f.deletes++
		f.deleted = true
		switch f.mode {
		case "lost":
			w.WriteHeader(500)
			return
		case "false-404":
			w.WriteHeader(404)
			return
		case "false-200":
			w.WriteHeader(200)
			return
		case "actor-after":
			f.actor.ID++
		case "org-after":
			f.orgID++
		case "owner-after":
			f.organizationOwner = false
		}
		w.WriteHeader(204)
	}))
	t.Cleanup(provider.Close)
	var e error
	f.s, e = New(testConfig(provider.URL), db)
	if e != nil {
		t.Fatal(e)
	}
	mf := &managementFixture{s: f.s, db: db}
	enrollLocal(t, mf, "alice", true)
	f.session = localLogin(t, mf, "alice")
	f.credential, e = f.s.sessionCredential(t.Context(), f.session.Value)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *repositoryDeletionFixture) profile(t *testing.T) {
	t.Helper()
	incarnation := uuid.NewString()
	f.s.managedGit = managedGitConfiguration{Enabled: true, Incarnation: incarnation}
	// Only an owned Golf source fixture. This synthetic row does not qualify native
	// bootstrap, ingress, producers or any retained installation.
	if _, e := f.s.db.Exec(`INSERT INTO golf_git_transport_profiles(forge_url,incarnation,native_version,receipt_sha256,qualifier_source_commit,golf_image_digest,native_image_digest,native_runtime_id) VALUES($1,$2,'1.27.3',$3,$4,$5,$5,$3)`, f.s.config.GiteaURL, incarnation, strings.Repeat("a", 64), strings.Repeat("b", 40), "sha256:"+strings.Repeat("c", 64)); e != nil {
		t.Fatal(e)
	}
}
func (f *repositoryDeletionFixture) ctx(t *testing.T) context.Context {
	return context.WithValue(t.Context(), sessionTokenKey{}, f.credential)
}
func (f *repositoryDeletionFixture) header(h http.Header) {
	h.Set("Origin", f.s.config.PublicURL)
	h.Set("Cookie", f.s.sessionCookie(f.session.Value, f.session.Expires, 3600).String())
}
func (f *repositoryDeletionFixture) get(t *testing.T) *golfv1.RepositoryLifecycle {
	t.Helper()
	q := connect.NewRequest(&golfv1.GetRepositoryLifecycleRequest{Repository: &golfv1.RepositoryKey{Owner: f.row.Owner.Login, Name: "example"}, RepositoryId: strconv.FormatInt(f.row.ID, 10)})
	f.header(q.Header())
	out, e := f.s.GetRepositoryLifecycle(f.ctx(t), q)
	if e != nil {
		t.Fatal(e)
	}
	return out.Msg.Lifecycle
}
func (f *repositoryDeletionFixture) request(l *golfv1.RepositoryLifecycle, key string) *connect.Request[golfv1.DeleteRepositoryRequest] {
	q := connect.NewRequest(&golfv1.DeleteRepositoryRequest{Repository: l.Repository, RepositoryId: l.RepositoryId, OwnerId: l.OwnerId, ExpectedRevision: l.Revision, ConfirmationName: l.Repository.Owner + "/" + l.Repository.Name, CurrentPassword: localTestPassword, IdempotencyKey: key})
	f.header(q.Header())
	return q
}
func (f *repositoryDeletionFixture) status(t *testing.T, l *golfv1.RepositoryLifecycle, key string) (*golfv1.RepositoryLifecycleOperation, error) {
	t.Helper()
	q := connect.NewRequest(&golfv1.GetRepositoryDeletionOperationRequest{Repository: l.Repository, RepositoryId: l.RepositoryId, OwnerId: l.OwnerId, IdempotencyKey: key})
	f.header(q.Header())
	out, e := f.s.GetRepositoryDeletionOperation(f.ctx(t), q)
	if e != nil {
		return nil, e
	}
	return out.Msg.Operation, nil
}
func TestRepositoryDeletionUnavailablePostgres(t *testing.T) {
	f := newRepositoryDeletionFixture(t, false)
	l := f.get(t)
	if l.DeleteAvailable || l.DeleteNotice != "managed_native_boundary_unqualified" {
		t.Fatal("default adopted native qualified")
	}
	if _, e := f.s.DeleteRepository(f.ctx(t), f.request(l, uuid.NewString())); !errors.Is(e, errDeletionBoundary) {
		t.Fatal(e)
	}
	var count int
	if e := f.s.db.QueryRow(`SELECT count(*) FROM golf_repository_lifecycle_operations`).Scan(&count); e != nil || count != 0 || f.deletes != 0 {
		t.Fatal("unqualified effect", e, count)
	}
}
func TestRepositoryDeletionExactReceiptPostgres(t *testing.T) {
	for _, org := range []bool{false, true} {
		t.Run(strconv.FormatBool(org), func(t *testing.T) {
			f := newRepositoryDeletionFixture(t, org)
			f.profile(t)
			l := f.get(t)
			if !l.DeleteAvailable {
				t.Fatal("source fixture unavailable")
			}
			key := uuid.NewString()
			q := f.request(l, key)
			q.Msg.CurrentPassword = "wrong"
			if _, e := f.s.DeleteRepository(f.ctx(t), q); connect.CodeOf(e) != connect.CodePermissionDenied || f.deletes != 0 {
				t.Fatal("step-up", e)
			}
			q.Msg.CurrentPassword = localTestPassword
			out, e := f.s.DeleteRepository(f.ctx(t), q)
			if e != nil || out.Msg.Operation.Phase != "SUCCEEDED" || out.Msg.Operation.Action != "delete" || out.Msg.Operation.FromArchived != out.Msg.Operation.ToArchived || f.deletes != 1 {
				t.Fatal("204 receipt", e)
			}
			if f.repoReadsAfterDelete != 0 {
				t.Fatal("deleted/replacement route reobserved")
			}
			q.Msg.CurrentPassword = "not needed for status replay"
			replayed, e := f.s.DeleteRepository(f.ctx(t), q)
			if e != nil || replayed.Msg.Operation.Phase != "SUCCEEDED" || f.deletes != 1 {
				t.Fatal("original replay", e)
			}
			f.mode = "replacement"
			status, e := f.status(t, l, key)
			if e != nil || status.RepositoryId != l.RepositoryId || status.Phase != "SUCCEEDED" || f.repoReadsAfterDelete != 0 || f.deletes != 1 {
				t.Fatal("replacement adoption", e)
			}
			q.Msg.ExpectedRevision = strings.Repeat("f", 64)
			if _, e = f.s.DeleteRepository(f.ctx(t), q); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.deletes != 1 {
				t.Fatal("changed key intent", e)
			}
			var phases, activity int
			var blocked bool
			f.s.db.QueryRow(`SELECT count(*) FROM golf_repository_lifecycle_events`).Scan(&phases)
			f.s.db.QueryRow(`SELECT count(*) FROM golf_repository_activity WHERE topic='source'`).Scan(&activity)
			f.s.db.QueryRow(`SELECT golf_repository_lifecycle_blocked($1,$2)`, f.s.config.GiteaURL, f.row.ID).Scan(&blocked)
			if phases != 3 || activity != 1 || !blocked {
				t.Fatal("durable phases/activity/original-ID fence", phases, activity, blocked)
			}
			if _, e = f.s.db.Exec(`UPDATE golf_repository_lifecycle_operations SET owner_is_organization=NOT owner_is_organization`); e == nil {
				t.Fatal("historical ownership altered")
			}
			if _, e = f.s.db.Exec(`DELETE FROM golf_repository_lifecycle_operations`); e == nil {
				t.Fatal("retained deletion removed")
			}
		})
	}
}
func TestRepositoryDeletionUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "false-200", "false-404", "actor-after", "org-after", "owner-after"} {
		t.Run(mode, func(t *testing.T) {
			org := mode == "org-after" || mode == "owner-after"
			f := newRepositoryDeletionFixture(t, org)
			f.profile(t)
			l := f.get(t)
			key := uuid.NewString()
			f.mode = mode
			out, e := f.s.DeleteRepository(f.ctx(t), f.request(l, key))
			if mode == "lost" || mode == "false-200" || mode == "false-404" {
				if e != nil || out.Msg.Operation.Phase != "DISPATCH_UNKNOWN" {
					t.Fatal("unknown", e)
				}
			} else if e == nil {
				t.Fatal("posteffect authority loss exposed success")
			}
			var phase string
			var activities int
			f.s.db.QueryRow(`SELECT phase FROM golf_repository_lifecycle_operations WHERE idempotency_key=$1`, key).Scan(&phase)
			f.s.db.QueryRow(`SELECT count(*) FROM golf_repository_activity`).Scan(&activities)
			if phase != "DISPATCH_UNKNOWN" || f.deletes != 1 || activities != 0 {
				t.Fatal("uncertainty released", phase, f.deletes, activities)
			}
			f.actor = User{ID: 42, Login: "alice"}
			f.orgID = 77
			f.organizationOwner = true
			f.mode = "replacement"
			if _, e = f.s.DeleteRepository(f.ctx(t), f.request(l, key)); e != nil || f.deletes != 1 {
				t.Fatal("unknown replay resends", e)
			}
			if _, e = f.s.DeleteRepository(f.ctx(t), f.request(l, uuid.NewString())); e == nil || f.deletes != 1 {
				t.Fatal("fresh-key replacement bypass", e)
			}
		})
	}
}
func TestRepositoryDeletionOrdinaryOwnerPostgres(t *testing.T) {
	f := newRepositoryDeletionFixture(t, false)
	f.profile(t)
	l := f.get(t)
	// Golf global admin plus native effective admin is not personal ownership.
	f.row.Owner = &User{ID: 84, Login: "alice"}
	l.OwnerId = "84"
	if _, e := f.s.DeleteRepository(f.ctx(t), f.request(l, uuid.NewString())); e == nil || f.deletes != 0 {
		t.Fatal("immutable owner shadow", e)
	}
	f.row.Owner.ID = 42
	l.OwnerId = "42"
	f.row.Permissions.Admin = false
	if _, e := f.s.DeleteRepository(f.ctx(t), f.request(l, uuid.NewString())); connect.CodeOf(e) != connect.CodePermissionDenied || f.deletes != 0 {
		t.Fatal("reader owner", e)
	}
	f.row.Permissions.Admin = true
	if _, e := f.s.db.Exec(`UPDATE golf_git_transport_profiles SET suspended_at=clock_timestamp()`); e != nil {
		t.Fatal(e)
	}
	if f.get(t).DeleteAvailable {
		t.Fatal("suspended profile qualified")
	}
}
func TestRepositoryDeletionStaleAndActivePostgres(t *testing.T) {
	f := newRepositoryDeletionFixture(t, false)
	f.profile(t)
	l := f.get(t)
	f.row.Description = "External change"
	out, e := f.s.DeleteRepository(f.ctx(t), f.request(l, uuid.NewString()))
	if e != nil || out.Msg.Operation.Phase != "REJECTED" || f.deletes != 0 {
		t.Fatal("stale reservation", e)
	}
	l = f.get(t)
	var userID int64
	f.s.db.QueryRow(`SELECT id FROM golf_users WHERE forge_user_id=42`).Scan(&userID)
	if _, e = f.s.db.Exec(`INSERT INTO golf_issue_mutations(user_id,actor_forge_user_id,idempotency_key,payload_fingerprint,kind,repository_id,repository_owner,repository_name,issue_id,issue_number,state) VALUES($1,42,$2,decode(repeat('00',32),'hex'),'CREATE_ISSUE',9007199254740993,'alice','example',0,0,'OUTCOME_UNKNOWN')`, userID, uuid.NewString()); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.DeleteRepository(f.ctx(t), f.request(l, uuid.NewString())); !errors.Is(e, errDeletionBoundary) || f.deletes != 0 {
		t.Fatal("active work not refused", e)
	}
	var active int64
	f.s.db.QueryRow(`SELECT golf_repository_lifecycle_active($1,$2)`, f.s.config.GiteaURL, f.row.ID).Scan(&active)
	if active != 1 {
		t.Fatal("previous active-family wrapper lost", active)
	}
}

func TestRepositoryDeletionConcurrentReplayPostgres(t *testing.T) {
	f := newRepositoryDeletionFixture(t, false)
	f.profile(t)
	l := f.get(t)
	key := uuid.NewString()
	entered, release := make(chan struct{}), make(chan struct{})
	f.beforeDelete = func() { close(entered); <-release }
	type result struct {
		response *connect.Response[golfv1.DeleteRepositoryResponse]
		err      error
	}
	first, second := make(chan result, 1), make(chan result, 1)
	go func() { r, e := f.s.DeleteRepository(f.ctx(t), f.request(l, key)); first <- result{r, e} }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native DELETE not reached")
	}
	go func() { r, e := f.s.DeleteRepository(f.ctx(t), f.request(l, key)); second <- result{r, e} }()
	close(release)
	for _, ch := range []chan result{first, second} {
		select {
		case r := <-ch:
			if r.err != nil || r.response.Msg.Operation.Phase != "SUCCEEDED" {
				t.Fatal("same operation", r.err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("same-key contender stuck")
		}
	}
	if f.deletes != 1 {
		t.Fatal("duplicate native dispatch", f.deletes)
	}
	var operations int
	f.s.db.QueryRow(`SELECT count(*) FROM golf_repository_lifecycle_operations`).Scan(&operations)
	if operations != 1 {
		t.Fatal("duplicate reservations", operations)
	}
}
func TestRepositoryDeletionLogoutFencePostgres(t *testing.T) {
	f := newRepositoryDeletionFixture(t, false)
	f.profile(t)
	l := f.get(t)
	key := uuid.NewString()
	entered, release := make(chan struct{}), make(chan struct{})
	f.beforeDelete = func() { close(entered); <-release }
	result := make(chan error, 1)
	go func() { _, e := f.s.DeleteRepository(f.ctx(t), f.request(l, key)); result <- e }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native DELETE not reached")
	}
	hash, e := f.s.authSessionHash(t.Context(), f.session.Value, nil)
	if e != nil {
		t.Fatal(e)
	}
	logout := make(chan error, 1)
	go func() {
		_, e := f.s.db.ExecContext(t.Context(), `DELETE FROM golf_sessions WHERE token_hash=$1`, hash)
		logout <- e
	}()
	select {
	case e := <-logout:
		close(release)
		t.Fatal("session revocation passed held dispatch", e)
	case <-time.After(40 * time.Millisecond):
	}
	close(release)
	select {
	case <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch never settled")
	}
	select {
	case e := <-logout:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("logout waiter stuck")
	}
	var phase string
	f.s.db.QueryRow(`SELECT phase FROM golf_repository_lifecycle_operations WHERE idempotency_key=$1`, key).Scan(&phase)
	if phase != "SUCCEEDED" || f.deletes != 1 {
		t.Fatal("completed original effect erased", phase, f.deletes)
	}
	if _, e = f.status(t, l, key); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("logged-out receipt exposed", e)
	}
}
func TestRepositoryDeletionCanceledResponsePostgres(t *testing.T) {
	f := newRepositoryDeletionFixture(t, false)
	f.profile(t)
	l := f.get(t)
	key := uuid.NewString()
	ctx, cancel := context.WithCancel(f.ctx(t))
	defer cancel()
	effect := make(chan struct{})
	f.beforeDelete = func() { cancel(); close(effect) }
	if _, e := f.s.DeleteRepository(ctx, f.request(l, key)); e == nil {
		t.Fatal("canceled request returned success")
	}
	select {
	case <-effect:
	case <-time.After(time.Second):
		t.Fatal("supported write not observed")
	}
	status, e := f.status(t, l, key)
	if e != nil || status.Phase != "DISPATCH_UNKNOWN" || f.deletes != 1 {
		t.Fatal("cancellation erased committed uncertainty", e)
	}
	if out, e := f.s.DeleteRepository(f.ctx(t), f.request(l, key)); e != nil || out.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || f.deletes != 1 {
		t.Fatal("cancellation replay dispatch", e)
	}
}
