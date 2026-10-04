package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

func TestRepositoryInvitationValidation(t *testing.T) {
	now := time.Now()
	m := &golfv1.CreateRepositoryInvitationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: strings.Repeat("a", 64), RecipientId: "43", RecipientUsername: "bob", RecipientRevision: strings.Repeat("b", 64), Permission: "write", ExpiresAt: now.Add(time.Hour).UTC().Format(time.RFC3339Nano), PersistentConsent: true, IdempotencyKey: uuid.NewString()}
	if _, _, _, _, e := validateInvitationCreate(m, now); e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*golfv1.CreateRepositoryInvitationRequest){func(r *golfv1.CreateRepositoryInvitationRequest) { r.PersistentConsent = false }, func(r *golfv1.CreateRepositoryInvitationRequest) { r.Permission = "owner" }, func(r *golfv1.CreateRepositoryInvitationRequest) { r.RecipientId = "043" }, func(r *golfv1.CreateRepositoryInvitationRequest) {
		r.ExpiresAt = now.Add(8 * 24 * time.Hour).Format(time.RFC3339)
	}, func(r *golfv1.CreateRepositoryInvitationRequest) { r.RecipientUsername = "../bob" }, func(r *golfv1.CreateRepositoryInvitationRequest) { r.RecipientRevision = "" }} {
		copy := proto.Clone(m).(*golfv1.CreateRepositoryInvitationRequest)
		mutate(copy)
		if _, _, _, _, e := validateInvitationCreate(copy, now); e == nil {
			t.Fatal("invalid consent/identity accepted")
		}
	}
	row := database.GolfRepositoryInvitation{ID: uuid.New(), RepositoryID: 17, OwnerID: 42, RepositoryOwner: "alice", RepositoryName: "private-name", IssuerNativeID: 42, IssuerLogin: "private-issuer", RecipientNativeID: 43, RecipientLogin: "bob", Permission: "admin", Revision: 1, State: "PENDING", ExpiresAt: now.Add(time.Hour), CreatedAt: now}
	hidden := invitationWire(row, false)
	if hidden.Repository != nil || hidden.Issuer != nil || hidden.Recipient != nil || hidden.RepositoryId != "" || hidden.Permission != "" || hidden.DetailsAvailable {
		t.Fatal("withheld inbox exposed private details")
	}
	if hidden.Id != row.ID.String() || hidden.Revision != "1" {
		t.Fatal("own metadata missing")
	}
}

type invitationTestActor struct {
	session loginResult
	token   forgeCredential
	user    User
}
type invitationFixture struct {
	mu       sync.Mutex
	s        *Server
	db       *sql.DB
	actors   map[string]invitationTestActor
	row      forgeRepositorySettings
	direct   map[string]string
	writes   int
	mode     string
	provider *httptest.Server
}

func newInvitationFixture(t *testing.T) *invitationFixture {
	t.Helper()
	f := &invitationFixture{db: testDatabase(t), actors: map[string]invitationTestActor{}, row: settingsFixtureRow(), direct: map[string]string{}}
	f.row.ID = 17
	f.row.HTMLURL = "http://forge.invalid/alice/example"
	users := map[string]User{"alice": {ID: 42, Login: "alice"}, "bob": {ID: 43, Login: "bob"}, "carol": {ID: 44, Login: "carol"}, "dave": {ID: 45, Login: "dave"}}
	f.provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		login := strings.TrimSuffix(strings.TrimPrefix(r.Header.Get("Authorization"), "token "), "-invitation-token")
		caller, ok := users[login]
		if !ok {
			w.WriteHeader(401)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		p := r.URL.Path
		if p == "/api/v1/user" {
			json.NewEncoder(w).Encode(caller)
			return
		}
		if p == "/api/v1/version" {
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
			return
		}
		if p == "/api/v1/users/search" {
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{users["alice"]}})
			return
		}
		if strings.HasPrefix(p, "/api/v1/users/") {
			u, ok := users[strings.TrimPrefix(p, "/api/v1/users/")]
			if !ok {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(u)
			return
		}
		if p == "/api/v1/repos/alice/example" {
			if f.mode == "denied" {
				w.WriteHeader(404)
				return
			}
			row := f.row
			row.Permissions.Admin = login == "alice" || login == "carol"
			json.NewEncoder(w).Encode(lifecycleNativeRepository{forgeRepositorySettings: row, NativeActions: pointerFalse()})
			return
		}
		prefix := "/api/v1/repos/alice/example/collaborators/"
		if strings.HasPrefix(p, prefix) {
			target := strings.TrimPrefix(p, prefix)
			if strings.HasSuffix(target, "/permission") {
				target = strings.TrimSuffix(target, "/permission")
				permission := f.direct[target]
				if target == "alice" || target == "carol" && f.direct["carol"] != "admin" {
					permission = "owner"
				}
				if permission == "" {
					permission = "none"
				}
				json.NewEncoder(w).Encode(map[string]any{"permission": permission, "user": users[target]})
				return
			}
			if r.Method == "GET" {
				if f.direct[target] == "" {
					w.WriteHeader(404)
				} else {
					w.WriteHeader(204)
					if target == "bob" && f.writes > 0 {
						if f.mode == "deny-readback" {
							f.mode = "denied"
						} else if f.mode == "changed-readback" {
							f.row.Private = !f.row.Private
							f.mode = "changed-after"
						}
					}
				}
				return
			}
			if r.Method == "PUT" {
				if login != "alice" {
					w.WriteHeader(403)
					return
				}
				var payload map[string]string
				if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload) != 1 || payload["permission"] != "write" {
					t.Error("unexpected grant payload")
					w.WriteHeader(400)
					return
				}
				f.writes++
				f.direct[target] = payload["permission"]
				if f.mode == "lost" {
					w.WriteHeader(500)
					return
				}
				w.WriteHeader(204)
				if f.mode == "deny-after" {
					f.mode = "denied"
				}
				return
			}
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(f.provider.Close)
	var e error
	f.s, e = New(testConfig(f.provider.URL), f.db)
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"alice", "bob", "carol"} {
		token := name + "-invitation-token"
		if _, e := ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.GiteaURL, "create", LocalAccountInput{Username: name, Password: localTestPassword, ForgeToken: token}); e != nil {
			t.Fatal(e)
		}
		session, e := f.s.loginLocalSession(t.Context(), name, localTestPassword, "")
		if e != nil {
			t.Fatal(e)
		}
		f.actors[name] = invitationTestActor{session, forgeCredential{Kind: "pat", Token: token, Local: true}, users[name]}
	}
	return f
}
func pointerFalse() *bool { v := false; return &v }
func invitationReq[T any](f *invitationFixture, name string, m *T) (context.Context, *connect.Request[T]) {
	actor := f.actors[name]
	ctx := context.WithValue(context.Background(), sessionTokenKey{}, actor.token)
	req := connect.NewRequest(m)
	req.Header().Set("Origin", f.s.config.PublicURL)
	req.Header().Set("Cookie", f.s.sessionCookie(actor.session.Value, actor.session.Expires, 3600).String())
	return ctx, req
}
func (f *invitationFixture) create(t *testing.T) *golfv1.RepositoryInvitation {
	t.Helper()
	ctx, req := invitationReq(f, "alice", &golfv1.PreviewRepositoryInvitationRecipientRequest{})
	a, e := f.s.invitationAdmin(ctx, f.actors["alice"].token, repositoryKey{"alice", "example"}, f.actors["alice"].user)
	if e != nil {
		t.Fatal(e)
	}
	req.Msg = &golfv1.PreviewRepositoryInvitationRecipientRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: a.Revision, Username: "bob"}
	preview, e := f.s.PreviewRepositoryInvitationRecipient(ctx, req)
	if e != nil {
		t.Fatal(e)
	}
	ctx, create := invitationReq(f, "alice", &golfv1.CreateRepositoryInvitationRequest{Repository: req.Msg.Repository, RepositoryId: "17", OwnerId: "42", ExpectedRevision: a.Revision, RecipientId: "43", RecipientUsername: "bob", RecipientRevision: preview.Msg.Recipient.Revision, Permission: "write", PersistentConsent: true, ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), IdempotencyKey: uuid.NewString()})
	result, e := f.s.CreateRepositoryInvitation(ctx, create)
	if e != nil {
		t.Fatal(e)
	}
	if !result.Msg.Invitation.DetailsAvailable || f.writes != 0 {
		t.Fatal("invitation granted before acceptance")
	}
	return result.Msg.Invitation
}
func (f *invitationFixture) respond(name string, i *golfv1.RepositoryInvitation, key string, decision golfv1.RepositoryInvitationDecision) (*connect.Response[golfv1.RespondRepositoryInvitationResponse], error) {
	ctx, req := invitationReq(f, name, &golfv1.RespondRepositoryInvitationRequest{InvitationId: i.Id, ExpectedRevision: i.Revision, IdempotencyKey: key, Decision: decision})
	return f.s.RespondRepositoryInvitation(ctx, req)
}
func (f *invitationFixture) inspect(name string, i *golfv1.RepositoryInvitation, key string) (*connect.Response[golfv1.GetRepositoryInvitationOperationResponse], error) {
	ctx, req := invitationReq(f, name, &golfv1.GetRepositoryInvitationOperationRequest{InvitationId: i.Id, IdempotencyKey: key})
	return f.s.GetRepositoryInvitationOperation(ctx, req)
}
func TestRepositoryInvitationAcceptConsentPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	invite := f.create(t)
	issuer := f.actors["alice"]
	hash, e := f.s.authSessionHash(t.Context(), issuer.session.Value, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, hash); e != nil {
		t.Fatal(e)
	}
	key := uuid.NewString()
	result, e := f.respond("bob", invite, key, golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
	if e != nil {
		t.Fatal(e)
	}
	if result.Msg.Operation.Phase != "SUCCEEDED" || result.Msg.Invitation.State != "ACCEPTED" || f.writes != 1 {
		t.Fatal("grant receipt", result.Msg, f.writes)
	}
	replay, e := f.respond("bob", invite, key, golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
	if e != nil || replay.Msg.Operation.Phase != "SUCCEEDED" || f.writes != 1 {
		t.Fatal("replay", e)
	}
	if _, e = f.respond("bob", invite, key, golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_REJECT); e == nil {
		t.Fatal("changed exact-key intent accepted")
	}
	if _, e = f.inspect("carol", invite, key); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("foreign receipt", e)
	}
	var count int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_repository_activity WHERE repository_id=17 AND topic='source'`).Scan(&count); e != nil || count != 1 {
		t.Fatal("success activity", count, e)
	}
}
func TestRepositoryInvitationUnknownPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "deny-after", "deny-readback", "changed-readback"} {
		t.Run(mode, func(t *testing.T) {
			f := newInvitationFixture(t)
			i := f.create(t)
			f.mode = mode
			key := uuid.NewString()
			r, e := f.respond("bob", i, key, golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
			if mode == "lost" {
				if e != nil || r.Msg.Operation.Phase != "DISPATCH_UNKNOWN" {
					t.Fatal(e, r)
				}
			} else if e == nil {
				t.Fatal("late authority loss released private receipt")
			}
			if f.writes != 1 {
				t.Fatal("write count")
			}
			f.mode = ""
			status, e := f.inspect("bob", i, key)
			if e != nil || status.Msg.Operation.Phase != "DISPATCH_UNKNOWN" {
				t.Fatal(e)
			}
			replay, e := f.respond("bob", i, key, golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
			if e != nil || replay.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || f.writes != 1 {
				t.Fatal(e)
			}
			if _, e = f.respond("bob", i, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT); e == nil {
				t.Fatal("new key bypassed unresolved")
			}
			var count int
			f.db.QueryRow(`SELECT count(*) FROM golf_repository_activity WHERE repository_id=17`).Scan(&count)
			if count != 0 {
				t.Fatal("unknown activity")
			}
			var active int
			f.db.QueryRow(`SELECT golf_repository_lifecycle_active($1,17)`, f.s.config.GiteaURL).Scan(&active)
			if active != 1 {
				t.Fatal("archive did not count unresolved grant", active)
			}
		})
	}
}
func TestRepositoryInvitationLocalVersionAndRejectPostgres(t *testing.T) {
	for _, action := range []string{"disable", "reset-password", "reject"} {
		t.Run(action, func(t *testing.T) {
			f := newInvitationFixture(t)
			i := f.create(t)
			if action == "reject" {
				r, e := f.respond("bob", i, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_REJECT)
				if e != nil || r.Msg.Invitation.State != "REJECTED" || r.Msg.Operation.Phase != "SUCCEEDED" {
					t.Fatal(e)
				}
			} else {
				input := LocalAccountInput{Username: "alice"}
				if action == "reset-password" {
					input.Password = localTestPassword + " replacement"
				}
				if _, e := ManageLocalAccount(t.Context(), f.db, f.s.keyring, f.s.config.GiteaURL, action, input); e != nil {
					t.Fatal(e)
				}
				if _, e := f.respond("bob", i, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT); e == nil {
					t.Fatal("expired authority accepted")
				}
				ctx, req := invitationReq(f, "bob", &golfv1.ListOwnRepositoryInvitationsRequest{Page: &golfv1.PageRequest{Limit: 20}})
				list, e := f.s.ListOwnRepositoryInvitations(ctx, req)
				if e != nil || len(list.Msg.Invitations) != 1 || list.Msg.Invitations[0].State != "EXPIRED" || list.Msg.Invitations[0].DetailsAvailable {
					t.Fatal("expiry privacy", e, list)
				}
			}
			if f.writes != 0 {
				t.Fatal("native write")
			}
		})
	}
}
func TestRepositoryInvitationConcurrentPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	i := f.create(t)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.respond("bob", i, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if f.writes != 1 || success != 1 {
		t.Fatal("duplicate grants", f.writes, success)
	}
}
func TestRepositoryInvitationNativeRoleAndTargetPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	i := f.create(t)
	ctx, req := invitationReq(f, "carol", &golfv1.PreviewRepositoryInvitationRecipientRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: strings.Repeat("a", 64), Username: "bob"})
	if _, e := f.s.PreviewRepositoryInvitationRecipient(ctx, req); connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("native exceptional owner bypass", e)
	}
	f.row.Private = !f.row.Private
	r, e := f.respond("bob", i, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
	if e != nil || r.Msg.Operation.Phase != "REJECTED" || f.writes != 0 {
		t.Fatal("changed target", e, r)
	}
}
func TestRepositoryInvitationJournalIdentityPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	i := f.create(t)
	for _, statement := range []string{`UPDATE golf_repository_invitations SET recipient_native_id=44 WHERE id=$1`, `UPDATE golf_repository_invitations SET state='ACCEPTED',revision=revision+1 WHERE id=$1`, `DELETE FROM golf_repository_invitations WHERE id=$1`} {
		if _, e := f.db.Exec(statement, i.Id); e == nil {
			t.Fatal("journal rewrite accepted")
		}
	}
	if _, e := f.db.Exec(`UPDATE golf_repository_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, i.Id); e == nil {
		t.Fatal("expiry identity mutated")
	}
}

func TestRepositoryInvitationInventoryAndRevocationPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	i := f.create(t)
	for _, name := range []string{"alice", "bob", "carol"} {
		a, e := f.s.readRepositoryAccess(t.Context(), f.actors[name].token, repositoryKey{"alice", "example"}, f.actors[name].user)
		if e != nil {
			t.Fatal(e)
		}
		ctx, req := invitationReq(f, name, &golfv1.ListRepositoryInvitationsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: a.Revision, Page: &golfv1.PageRequest{Limit: 20}})
		r, e := f.s.ListRepositoryInvitations(ctx, req)
		if e != nil {
			t.Fatal(e)
		}
		if r.Msg.CanManage != (name == "alice") || r.Msg.LocalIssuerAvailable != (name == "alice") || (name == "alice" && len(r.Msg.Invitations) != 1) || (name != "alice" && len(r.Msg.Invitations) != 0) {
			t.Fatal("inventory authority", name, r.Msg)
		}
	}
	a, e := f.s.invitationAdmin(t.Context(), f.actors["alice"].token, repositoryKey{"alice", "example"}, f.actors["alice"].user)
	if e != nil {
		t.Fatal(e)
	}
	ctx, req := invitationReq(f, "alice", &golfv1.RevokeRepositoryInvitationRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: a.Revision, InvitationId: i.Id, InvitationRevision: i.Revision})
	r, e := f.s.RevokeRepositoryInvitation(ctx, req)
	if e != nil || r.Msg.Invitation.State != "REVOKED" {
		t.Fatal(e, r)
	}
	if _, e = f.respond("bob", i, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT); e == nil {
		t.Fatal("revoked invitation granted")
	}
	if f.writes != 0 {
		t.Fatal("revocation wrote native grant")
	}
	if _, e = f.db.Exec(`INSERT INTO golf_repository_invitations(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,issuer_user_id,issuer_native_id,issuer_login,issuer_account_id,issuer_account_version,recipient_native_id,recipient_login,recipient_revision,permission,access_revision,persistent_consent,expires_at,create_key,input_hash) SELECT $2,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,issuer_user_id,issuer_native_id,issuer_login,issuer_account_id,issuer_account_version,recipient_native_id,recipient_login,recipient_revision,permission,access_revision,persistent_consent,clock_timestamp()-interval '1 second',$3,input_hash FROM golf_repository_invitations WHERE id=$1`, i.Id, uuid.New(), uuid.NewString()); e != nil {
		t.Fatal(e)
	}
	ctx, own := invitationReq(f, "bob", &golfv1.ListOwnRepositoryInvitationsRequest{Page: &golfv1.PageRequest{Limit: 20}})
	list, e := f.s.ListOwnRepositoryInvitations(ctx, own)
	if e != nil || len(list.Msg.Invitations) != 2 || list.Msg.Invitations[0].State != "EXPIRED" {
		t.Fatal("wall clock expiry", e, list)
	}
}
func TestRepositoryInvitationWaitThenSessionLossPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	i := f.create(t)
	tx, e := f.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	var id int64
	if e = tx.QueryRow(`SELECT id FROM golf_users WHERE forge_user_id=42 FOR UPDATE`).Scan(&id); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() {
		_, e := f.respond("bob", i, uuid.NewString(), golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT)
		done <- e
	}()
	deadline := time.Now().Add(3 * time.Second)
	waiting := false
	for time.Now().Before(deadline) {
		if e = f.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%ORDER BY id FOR UPDATE%')`).Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("recipient did not reach owner-lock wait")
	}
	hash, e := f.s.authSessionHash(t.Context(), f.actors["bob"].session.Value, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, hash); e != nil {
		t.Fatal(e)
	}
	if e = tx.Rollback(); e != nil {
		t.Fatal(e)
	}
	select {
	case e = <-done:
		if connect.CodeOf(e) != connect.CodeUnauthenticated {
			t.Fatal("late revoked recipient", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter did not finish")
	}
	var count int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_repository_invitation_operations`).Scan(&count); e != nil || count != 0 || f.writes != 0 {
		t.Fatal("revoked caller admitted", e, count, f.writes)
	}
}
func TestRepositoryInvitationBrowserBoundaryPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	i := f.create(t)
	for _, mode := range []string{"bearer", "origin"} {
		ctx, req := invitationReq(f, "bob", &golfv1.RespondRepositoryInvitationRequest{InvitationId: i.Id, ExpectedRevision: i.Revision, Decision: golfv1.RepositoryInvitationDecision_REPOSITORY_INVITATION_DECISION_ACCEPT, IdempotencyKey: uuid.NewString()})
		if mode == "bearer" {
			req.Header().Set("Authorization", "Bearer unsupported")
		} else {
			req.Header().Set("Origin", "https://other.invalid")
		}
		if _, e := f.s.RespondRepositoryInvitation(ctx, req); e == nil {
			t.Fatal("browser fence", mode)
		}
	}
	if f.writes != 0 {
		t.Fatal("boundary issued grant")
	}
}

func TestRepositoryInvitationOrganizationIndividualAuthority(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		owner, direct, member, hidden bool
		permission                    string
		allowed                       bool
	}{{"organization owner", true, false, true, false, "admin", true}, {"current member direct admin", false, true, true, false, "admin", true}, {"team admin only", false, false, true, false, "admin", false}, {"direct admin not member", false, true, false, false, "admin", false}, {"exceptional native owner", false, false, true, false, "owner", false}, {"hidden organization unknown", false, true, true, true, "admin", false}} {
		t.Run(tc.name, func(t *testing.T) {
			row := settingsFixtureRow()
			row.ID = 17
			row.Owner = &User{ID: 42, Login: "workshop"}
			row.FullName = "workshop/example"
			row.HTMLURL = "http://forge.invalid/workshop/example"
			caller := User{ID: 43, Login: "alice"}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/v1/repos/workshop/example":
					json.NewEncoder(w).Encode(row)
				case "/api/v1/users/search":
					json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{}})
				case "/api/v1/orgs/workshop":
					if tc.hidden {
						w.WriteHeader(404)
						return
					}
					json.NewEncoder(w).Encode(forgeOrganization{ID: 42, Name: "workshop", Visibility: "private"})
				case "/api/v1/orgs/workshop/members/alice":
					if tc.member {
						w.WriteHeader(204)
					} else {
						w.WriteHeader(404)
					}
				case "/api/v1/users/alice/orgs/workshop/permissions":
					json.NewEncoder(w).Encode(map[string]bool{"is_owner": tc.owner})
				case "/api/v1/repos/workshop/example/collaborators/alice/permission":
					json.NewEncoder(w).Encode(map[string]any{"permission": tc.permission, "user": caller})
				case "/api/v1/repos/workshop/example/collaborators/alice":
					if tc.direct {
						w.WriteHeader(204)
					} else {
						w.WriteHeader(404)
					}
				default:
					t.Errorf("unexpected native route %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer provider.Close()
			s := &Server{config: testConfig(provider.URL), client: provider.Client()}
			_, e := s.invitationAdmin(t.Context(), forgeCredential{Kind: "pat", Token: "source-only"}, repositoryKey{"workshop", "example"}, caller)
			if (e == nil) != tc.allowed {
				t.Fatalf("individual organization authority %v", e)
			}
		})
	}
}

// Different managed issuers must share the repository quota, rather than
// serializing only their own user/account rows. Hold that repository gate to
// prove both transactions wait before counting the last available slot.
func TestRepositoryInvitationConcurrentIssuerQuotaPostgres(t *testing.T) {
	f := newInvitationFixture(t)
	seed := f.create(t)
	if _, err := f.db.Exec(`UPDATE golf_repository_invitations SET state='REVOKED',revision=revision+1 WHERE id=$1`, seed.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO golf_repository_invitations(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,issuer_user_id,issuer_native_id,issuer_login,issuer_account_id,issuer_account_version,recipient_native_id,recipient_login,recipient_revision,permission,access_revision,persistent_consent,expires_at,create_key,input_hash)
 SELECT gen_random_uuid(),forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,issuer_user_id,issuer_native_id,issuer_login,issuer_account_id,issuer_account_version,1000+n,'seed-'||n,recipient_revision,permission,access_revision,persistent_consent,expires_at,gen_random_uuid()::text,input_hash FROM golf_repository_invitations CROSS JOIN generate_series(1,99) AS n WHERE id=$1`, seed.Id); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.direct["carol"] = "admin" // Ordinary direct administrator, not site-owner permission.
	f.mu.Unlock()
	type attempt struct {
		ctx context.Context
		req *connect.Request[golfv1.CreateRepositoryInvitationRequest]
	}
	attempts := make([]attempt, 0, 2)
	for _, names := range [][2]string{{"alice", "bob"}, {"carol", "dave"}} {
		issuer, recipient := names[0], names[1]
		ctx, req := invitationReq(f, issuer, &golfv1.PreviewRepositoryInvitationRecipientRequest{})
		access, err := f.s.invitationAdmin(ctx, f.actors[issuer].token, repositoryKey{"alice", "example"}, f.actors[issuer].user)
		if err != nil {
			t.Fatal(err)
		}
		req.Msg = &golfv1.PreviewRepositoryInvitationRecipientRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "17", OwnerId: "42", ExpectedRevision: access.Revision, Username: recipient}
		preview, err := f.s.PreviewRepositoryInvitationRecipient(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		ctx, create := invitationReq(f, issuer, &golfv1.CreateRepositoryInvitationRequest{Repository: req.Msg.Repository, RepositoryId: "17", OwnerId: "42", ExpectedRevision: access.Revision, RecipientId: preview.Msg.Recipient.User.Id, RecipientUsername: recipient, RecipientRevision: preview.Msg.Recipient.Revision, Permission: "write", PersistentConsent: true, ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), IdempotencyKey: uuid.NewString()})
		attempts = append(attempts, attempt{ctx, create})
	}
	holder, err := f.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback()
	if _, err = holder.Exec(`SELECT pg_advisory_xact_lock(hashtextextended($1||'/repository-invitation-quota/'||$2::bigint::text,0))`, f.s.config.GiteaURL, int64(17)); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 2)
	for _, a := range attempts {
		go func() {
			_, err := f.s.CreateRepositoryInvitation(a.ctx, a.req)
			done <- err
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	waiting := 0
	for time.Now().Before(deadline) {
		if err = f.db.QueryRow(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%repository-invitation-quota%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("creation bypassed the repository quota gate: %v", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if waiting != 2 {
		t.Fatalf("both independent issuers must wait before quota admission; waiting=%d", waiting)
	}
	if err = holder.Rollback(); err != nil {
		t.Fatal(err)
	}
	succeeded, refused := 0, 0
	for range attempts {
		select {
		case err := <-done:
			if err == nil {
				succeeded++
			} else if connect.CodeOf(err) == connect.CodeInvalidArgument {
				refused++
			} else {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("quota admission deadlocked")
		}
	}
	var count, operations int
	if err = f.db.QueryRow(`SELECT count(*) FROM golf_repository_invitations WHERE state IN ('PENDING','GRANTING')`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err = f.db.QueryRow(`SELECT count(*) FROM golf_repository_invitation_operations`).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if succeeded != 1 || refused != 1 || count != 100 || operations != 0 || f.writes != 0 {
		t.Fatal(fmt.Sprintf("quota outcomes: admitted=%d refused=%d pending=%d operations=%d nativeWrites=%d", succeeded, refused, count, operations, f.writes))
	}
}
