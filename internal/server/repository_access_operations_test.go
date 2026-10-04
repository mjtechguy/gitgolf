package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

type accessIntentFixture struct {
	s                   *Server
	db                  *sql.DB
	mu                  sync.Mutex
	sessions            map[string]loginResult
	users               map[string]User
	row                 forgeRepositorySettings
	direct              bool
	role, floor         string
	writes              int
	lost                bool
	revokeAfterReadback bool
	organization        bool
	actualOwner         bool
	ownershipStatus     int
	ownershipMissing    bool
	ownershipReads      int
	promoteOnRead       int
	hold, entered       chan struct{}
}

func newAccessIntentFixture(t *testing.T) *accessIntentFixture {
	t.Helper()
	f := &accessIntentFixture{db: testDatabase(t), row: settingsFixtureRow(), sessions: map[string]loginResult{}, users: map[string]User{"alice": {ID: 42, Login: "alice"}, "eve": {ID: 88, Login: "eve"}, "bob": {ID: 77, Login: "bob"}}, floor: "admin"}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		who := strings.TrimPrefix(r.Header.Get("Authorization"), "token ")
		actor := f.users[who]
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/api/v1/user":
			json.NewEncoder(w).Encode(actor)
		case r.URL.Path == "/api/v1/settings/api":
			json.NewEncoder(w).Encode(map[string]int{"max_response_items": 50})
		case r.URL.Path == "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case r.URL.Path == "/api/v1/repos/"+f.row.Owner.Login+"/example":
			json.NewEncoder(w).Encode(f.row)
		case r.URL.Path == "/api/v1/users/search":
			data := []User{*f.row.Owner}
			if f.organization {
				data = nil
			}
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": data})
		case r.URL.Path == "/api/v1/orgs/acme":
			json.NewEncoder(w).Encode(forgeOrganization{ID: f.row.Owner.ID, Name: "acme", Visibility: "private"})
		case strings.HasPrefix(r.URL.Path, "/api/v1/orgs/acme/members/"):
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/orgs/acme/permissions"):
			login := strings.Split(r.URL.Path, "/")[4]
			if login == "bob" {
				f.ownershipReads++
				if f.promoteOnRead > 0 && f.ownershipReads >= f.promoteOnRead {
					f.actualOwner = true
				}
				if f.ownershipStatus != 0 {
					w.WriteHeader(f.ownershipStatus)
					return
				}
				if f.ownershipMissing {
					json.NewEncoder(w).Encode(map[string]bool{})
					return
				}
			}
			json.NewEncoder(w).Encode(map[string]bool{"is_owner": login == "alice" || login == "bob" && f.actualOwner})
		case strings.HasPrefix(r.URL.Path, "/api/v1/users/"):
			u, ok := f.users[strings.TrimPrefix(r.URL.Path, "/api/v1/users/")]
			if !ok {
				w.WriteHeader(404)
			} else {
				json.NewEncoder(w).Encode(u)
			}
		case strings.HasSuffix(r.URL.Path, "/permission"):
			login := strings.Split(r.URL.Path, "/")[7]
			p := "admin"
			if login == "alice" {
				p = "owner"
			}
			if login == "bob" {
				p = f.floor
				if p == "" {
					p = f.role
					if p == "" {
						p = "none"
					}
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"user": f.users[login], "permission": p})
		case strings.Contains(r.URL.Path, "/collaborators/"):
			login := strings.TrimPrefix(r.URL.Path, "/api/v1/repos/"+f.row.Owner.Login+"/example/collaborators/")
			if r.Method == "GET" {
				if login == "eve" || login == "bob" && f.direct {
					if login == "bob" && f.writes > 0 && f.revokeAfterReadback {
						f.row.Permissions.Admin = false
					}
					w.WriteHeader(204)
				} else {
					w.WriteHeader(404)
				}
				return
			}
			if login != "bob" {
				w.WriteHeader(403)
				return
			}
			f.writes++
			if r.Method == "PUT" {
				var body map[string]string
				json.NewDecoder(r.Body).Decode(&body)
				f.role = body["permission"]
				f.direct = true
			} else if r.Method == "DELETE" {
				f.direct = false
				f.role = ""
			} else {
				w.WriteHeader(405)
				return
			}
			if f.entered != nil {
				close(f.entered)
				f.entered = nil
			}
			hold := f.hold
			lost := f.lost
			if hold != nil {
				f.mu.Unlock()
				<-hold
				f.mu.Lock()
			}
			if lost {
				w.WriteHeader(500)
			} else {
				w.WriteHeader(204)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(provider.Close)
	var e error
	f.s, e = New(testConfig(provider.URL), f.db)
	if e != nil {
		t.Fatal(e)
	}
	for _, login := range []string{"alice", "eve"} {
		f.sessions[login], e = f.s.createSession(t.Context(), f.users[login], "pat", login, "")
		if e != nil {
			t.Fatal(e)
		}
	}
	return f
}
func (f *accessIntentFixture) ctx(t *testing.T, login string) context.Context {
	return context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: login})
}
func (f *accessIntentFixture) headers(h http.Header, login string) {
	v := f.sessions[login]
	h.Set("Cookie", f.s.sessionCookie(v.Value, v.Expires, 3600).String())
	h.Set("Origin", f.s.config.PublicURL)
}
func (f *accessIntentFixture) preview(t *testing.T, login string) (*golfv1.RepositoryAccess, *golfv1.RepositoryCollaborator) {
	t.Helper()
	ctx := f.ctx(t, login)
	key := &golfv1.RepositoryKey{Owner: f.row.Owner.Login, Name: "example"}
	r := connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: key})
	f.headers(r.Header(), login)
	a, e := f.s.GetRepositoryAccess(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	q := connect.NewRequest(&golfv1.ResolveRepositoryCollaboratorRequest{Repository: key, RepositoryId: a.Msg.Access.RepositoryId, OwnerId: a.Msg.Access.OwnerId, ExpectedRevision: a.Msg.Access.Revision, UserLogin: "bob"})
	f.headers(q.Header(), login)
	c, e := f.s.ResolveRepositoryCollaborator(ctx, q)
	if e != nil {
		t.Fatal(e)
	}
	return a.Msg.Access, c.Msg.Collaborator
}
func (f *accessIntentFixture) request(a *golfv1.RepositoryAccess, c *golfv1.RepositoryCollaborator, role string) *golfv1.SetRepositoryCollaboratorRequest {
	return &golfv1.SetRepositoryCollaboratorRequest{Repository: &golfv1.RepositoryKey{Owner: f.row.Owner.Login, Name: "example"}, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, UserLogin: "bob", UserId: "77", ExpectedCollaboratorRevision: c.Revision, Permission: role, IdempotencyKey: uuid.NewString()}
}
func (f *accessIntentFixture) set(t *testing.T, login string, m *golfv1.SetRepositoryCollaboratorRequest) (*connect.Response[golfv1.SetRepositoryCollaboratorResponse], error) {
	r := connect.NewRequest(m)
	f.headers(r.Header(), login)
	return f.s.SetRepositoryCollaborator(f.ctx(t, login), r)
}
func (f *accessIntentFixture) inspect(t *testing.T, login string, m *golfv1.SetRepositoryCollaboratorRequest) (*connect.Response[golfv1.GetRepositoryAccessOperationResponse], error) {
	r := connect.NewRequest(&golfv1.GetRepositoryAccessOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, ExpectedRevision: m.ExpectedRevision, UserId: m.UserId, IdempotencyKey: m.IdempotencyKey})
	f.headers(r.Header(), login)
	return f.s.GetRepositoryAccessOperation(f.ctx(t, login), r)
}
func TestRepositoryAccessIntentReplayAndUncertainPostgres(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(map[bool]string{false: "acknowledged", true: "lost_ack"}[lost], func(t *testing.T) {
			f := newAccessIntentFixture(t)
			f.lost = lost
			a, c := f.preview(t, "alice")
			m := f.request(a, c, "read")
			r, e := f.set(t, "alice", m)
			if e != nil {
				t.Fatal(e)
			}
			phase := "SUCCEEDED"
			if lost {
				phase = "DISPATCH_UNKNOWN"
			}
			if r.Msg.Operation.Phase != phase || r.Msg.Operation.Generation != "1" || f.writes != 1 {
				t.Fatal("incorrect original outcome", r, e)
			}
			if lost && r.Msg.Collaborator != nil {
				t.Fatal("uncertain readback presented as receipt")
			}
			if !lost && (r.Msg.Operation.ObservedEffectivePermission != "admin" || !r.Msg.Operation.ObservedDirectMembership || r.Msg.Collaborator.Permission != "admin") {
				t.Fatal("lower requested mode invented direct readback")
			}
			replay, e := f.set(t, "alice", m)
			if e != nil || replay.Msg.Operation.Phase != phase || f.writes != 1 {
				t.Fatal("original replay dispatched", e)
			}
			status, e := f.inspect(t, "alice", m)
			if e != nil || status.Msg.Operation.Phase != phase || status.Msg.Collaborator != nil {
				t.Fatal("historical receipt changed", e)
			}
			if _, e = f.inspect(t, "eve", m); connect.CodeOf(e) != connect.CodeNotFound {
				t.Fatal("foreign actor receipt disclosed", e)
			}
			changed := proto.Clone(m).(*golfv1.SetRepositoryCollaboratorRequest)
			changed.Permission = "write"
			if _, e = f.set(t, "alice", changed); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.writes != 1 {
				t.Fatal("same key changed intent accepted", e)
			}
			_, fresh := f.preview(t, "eve")
			if fresh.Generation != "1" || fresh.Revision == c.Revision {
				t.Fatal("higher inherited access masked generation")
			}
			next := f.request(a, fresh, "write")
			if lost {
				if _, e = f.set(t, "eve", next); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.writes != 1 {
					t.Fatal("unknown replaced", e)
				}
			} else {
				if _, e = f.set(t, "eve", next); e != nil || f.writes != 2 {
					t.Fatal("explicit fresh generation failed", e)
				}
			}
			var active int64
			f.db.QueryRow(`SELECT golf_repository_lifecycle_active($1,$2)`, f.s.config.GiteaURL, int64(9007199254740993)).Scan(&active)
			if lost && active == 0 {
				t.Fatal("unresolved access did not fence archive")
			}
			f.row.Permissions.Admin = false
			if _, e = f.inspect(t, "alice", m); connect.CodeOf(e) != connect.CodePermissionDenied {
				t.Fatal("revoked authority received historical intent", e)
			}
		})
	}
}
func TestRepositoryAccessIntentConcurrentMaskedModePostgres(t *testing.T) {
	f := newAccessIntentFixture(t)
	a, c := f.preview(t, "alice")
	b, d := f.preview(t, "eve")
	if c.Revision != d.Revision {
		t.Fatal("initial shared target differs")
	}
	f.hold = make(chan struct{})
	f.entered = make(chan struct{})
	entered := f.entered
	first := f.request(a, c, "read")
	second := f.request(b, d, "write")
	done := make(chan error, 2)
	go func() { _, e := f.set(t, "alice", first); done <- e }()
	<-entered
	go func() { _, e := f.set(t, "eve", second); done <- e }()
	waitManagementLock(t, f.db, "ConcurrentAccessTarget", 1)
	close(f.hold)
	success, stale := 0, 0
	for range 2 {
		e := <-done
		if e == nil {
			success++
		} else if connect.CodeOf(e) == connect.CodeFailedPrecondition {
			stale++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || stale != 1 || f.writes != 1 {
		t.Fatal("competing masked-role save overwrote accepted intent", success, stale, f.writes)
	}
}

func TestRepositoryAccessIntentGenerationABAAndNoEffectPostgres(t *testing.T) {
	f := newAccessIntentFixture(t)
	a, original := f.preview(t, "alice")
	first := f.request(a, original, "read")
	if _, e := f.set(t, "alice", first); e != nil {
		t.Fatal(e)
	}
	a, current := f.preview(t, "alice")
	remove := connect.NewRequest(&golfv1.RemoveRepositoryCollaboratorRequest{Repository: first.Repository, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, UserLogin: "bob", UserId: "77", ExpectedCollaboratorRevision: current.Revision, IdempotencyKey: uuid.NewString()})
	f.headers(remove.Header(), "alice")
	r, e := f.s.RemoveRepositoryCollaborator(f.ctx(t, "alice"), remove)
	if e != nil || r.Msg.Operation.Phase != "SUCCEEDED" || r.Msg.Operation.Generation != "2" {
		t.Fatal("removal receipt", r, e)
	}
	_, now := f.preview(t, "alice")
	if now.IsDirect || now.Permission != original.Permission || now.Generation != "2" || now.Revision == original.Revision {
		t.Fatal("native ABA lost retained generation", now)
	}
	stale := f.request(a, original, "write")
	_, e = f.set(t, "alice", stale)
	var ce *connect.Error
	if connect.CodeOf(e) != connect.CodeFailedPrecondition || !errors.As(e, &ce) || ce.Meta().Get("Golf-Access-Effect") != "none" || f.writes != 2 {
		t.Fatal("absent stale intent no-effect proof", e)
	}
	changed := proto.Clone(first).(*golfv1.SetRepositoryCollaboratorRequest)
	changed.Permission = "write"
	_, e = f.set(t, "alice", changed)
	if !errors.As(e, &ce) || ce.Meta().Get("Golf-Access-Effect") != "" || f.writes != 2 {
		t.Fatal("existing key mismatch advertised no effect", e)
	}
	if _, e = f.set(t, "alice", f.request(a, now, "write")); e != nil || f.writes != 3 {
		t.Fatal("explicit current preview refused", e)
	}
}
func TestRepositoryAccessIntentLateAuthorityAndStorageFailurePostgres(t *testing.T) {
	for _, mode := range []string{"authority", "storage"} {
		t.Run(mode, func(t *testing.T) {
			f := newAccessIntentFixture(t)
			a, c := f.preview(t, "alice")
			m := f.request(a, c, "write")
			if mode == "authority" {
				f.revokeAfterReadback = true
			} else {
				if _, e := f.db.Exec(`CREATE FUNCTION fail_access_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='SUCCEEDED' THEN RAISE EXCEPTION 'fixture receipt unavailable'; END IF; RETURN NEW;END;$$; CREATE TRIGGER fail_access_receipt BEFORE UPDATE ON golf_repository_access_operations FOR EACH ROW EXECUTE FUNCTION fail_access_receipt()`); e != nil {
					t.Fatal(e)
				}
			}
			_, e := f.set(t, "alice", m)
			if e == nil || f.writes != 1 {
				t.Fatal("unqualified terminal receipt", e)
			}
			if mode == "authority" {
				if connect.CodeOf(e) != connect.CodePermissionDenied {
					t.Fatal(e)
				}
				f.revokeAfterReadback = false
				f.row.Permissions.Admin = true
			}
			receipt, e := f.inspect(t, "alice", m)
			if e != nil || receipt.Msg.Operation.Phase != "DISPATCH_UNKNOWN" {
				t.Fatal("original dispatch uncertainty lost", receipt, e)
			}
			if _, e = f.set(t, "alice", m); e != nil || f.writes != 1 {
				t.Fatal("original key resumed after uncertain completion", e)
			}
			var count int
			if e = f.db.QueryRow(`SELECT count(*) FROM golf_repository_activity WHERE repository_id=$1`, a.RepositoryId).Scan(&count); e != nil || count != 0 {
				t.Fatal("uncertain direct change emitted shared activity", count, e)
			}
		})
	}
}
func TestRepositoryInvitationAccessGenerationFencePostgres(t *testing.T) {
	f := newInvitationFixture(t)
	invite := f.create(t)
	actor := f.actors["alice"]
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, actor.token)
	key := repositoryKey{"alice", "example"}
	a, e := f.s.readRepositoryAccess(ctx, actor.token, key, actor.user)
	if e != nil {
		t.Fatal(e)
	}
	target, e := f.s.readRepositoryCollaborator(ctx, actor.token, key, a, "bob")
	if e != nil {
		t.Fatal(e)
	}
	_, req := invitationReq(f, "alice", &golfv1.SetRepositoryCollaboratorRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: a.Revision, UserLogin: "bob", UserId: "43", ExpectedCollaboratorRevision: target.Revision, Permission: "write", IdempotencyKey: uuid.NewString()})
	written, e := f.s.SetRepositoryCollaborator(ctx, req)
	if e != nil || written.Msg.Operation.Phase != "SUCCEEDED" {
		t.Fatal(written, e)
	}
	current, e := f.s.readRepositoryCollaborator(ctx, actor.token, key, a, "bob")
	if e != nil {
		t.Fatal(e)
	}
	_, remove := invitationReq(f, "alice", &golfv1.RemoveRepositoryCollaboratorRequest{Repository: req.Msg.Repository, RepositoryId: "17", OwnerId: "42", ExpectedRevision: a.Revision, UserLogin: "bob", UserId: "43", ExpectedCollaboratorRevision: current.Revision, IdempotencyKey: uuid.NewString()})
	removed, e := f.s.RemoveRepositoryCollaborator(ctx, remove)
	if e != nil || removed.Msg.Operation.Phase != "SUCCEEDED" || removed.Msg.Operation.Generation != "2" {
		t.Fatal(removed, e)
	}
	// Both native membership and effective permission now match the original
	// absence preview. The monotone generation must still fence this ABA.

	result, e := f.respond("bob", invite, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
	if e != nil || result.Msg.Operation.Phase != "REJECTED" || f.writes != 2 {
		t.Fatal("old invitation overwrote competing direct grant", result, e)
	}
	var generation int64
	if e = f.db.QueryRow(`SELECT generation FROM golf_repository_access_generations WHERE forge_url=$1 AND repository_id=17 AND recipient_id=43`, f.s.config.GiteaURL).Scan(&generation); e != nil || generation != 2 {
		t.Fatal("rejection changed target generation", generation, e)
	}
}
