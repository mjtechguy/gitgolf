package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestCollaboratorOwnershipNativeObservation(t *testing.T) {
	for _, tc := range []struct {
		name, permission string
		org              bool
		body             any
		status           int
		replacement      bool
		want             *bool
		failure          bool
	}{
		{name: "personal exceptional owner is not organization proof", permission: "owner"},
		{name: "ordinary external none", permission: "none", org: true, want: ownershipBool(false)},
		{name: "ordinary read", permission: "read", org: true, want: ownershipBool(false)},
		{name: "ordinary write", permission: "write", org: true, want: ownershipBool(false)},
		{name: "ordinary admin", permission: "admin", org: true, want: ownershipBool(false)},
		{name: "unknown effective permission", permission: "administrator", org: true, failure: true},
		{name: "admin team effective owner", permission: "owner", org: true, body: map[string]bool{"is_owner": false}, status: 200, want: ownershipBool(false)},
		{name: "actual organization owner", permission: "owner", org: true, body: map[string]bool{"is_owner": true}, status: 200, want: ownershipBool(true)},
		{name: "absent proof", permission: "owner", org: true, body: map[string]bool{}, status: 200, failure: true},
		{name: "null proof", permission: "owner", org: true, body: map[string]any{"is_owner": nil}, status: 200, failure: true},
		{name: "malformed proof", permission: "owner", org: true, body: map[string]string{"is_owner": "false"}, status: 200, failure: true},
		{name: "denied proof", permission: "owner", org: true, status: 403, failure: true},
		{name: "hidden proof", permission: "owner", org: true, status: 404, failure: true},
		{name: "target replaced across no-ID proof", permission: "owner", org: true, body: map[string]bool{"is_owner": false}, status: 200, replacement: true, failure: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/v1/users/bob/orgs/acme/permissions":
					calls++
					w.WriteHeader(tc.status)
					if tc.status == 200 {
						json.NewEncoder(w).Encode(tc.body)
					}
				case "/api/v1/users/bob":
					id := int64(77)
					if tc.replacement {
						id = 78
					}
					json.NewEncoder(w).Encode(User{ID: id, Login: "bob"})
				default:
					w.WriteHeader(404)
				}
			}))
			defer provider.Close()
			s, e := New(testConfig(provider.URL), nil)
			if e != nil {
				t.Fatal(e)
			}
			value, e := s.collaboratorOrganizationOwner(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"acme", "example"}, &golfv1.RepositoryAccess{OrganizationOwned: tc.org, OwnerId: "9"}, User{ID: 77, Login: "bob"}, tc.permission)
			if (e != nil) != tc.failure {
				t.Fatalf("ownership observation error %v", e)
			}
			if e == nil && ((value == nil) != (tc.want == nil) || value != nil && *value != *tc.want) {
				t.Fatal("ownership fact invented or lost")
			}
			expected := 0
			if tc.org && tc.permission == "owner" {
				expected = 1
			}
			if calls != expected {
				t.Fatal("unnecessary or missing independent ownership observation")
			}
		})
	}
}
func ownershipBool(v bool) *bool { return &v }

func TestProtectedCollaboratorTargetSeparatesEffectiveOwner(t *testing.T) {
	for _, tc := range []struct {
		name           string
		org            bool
		id, permission string
		proof          *bool
		blocked        bool
	}{
		{"team effective owner is mutable target", true, "77", "owner", ownershipBool(false), false},
		{"actual org owner protected", true, "77", "owner", ownershipBool(true), true},
		{"unknown org ownership protected", true, "77", "owner", nil, true},
		{"own identity protected", true, "42", "owner", ownershipBool(false), true},
		{"repository owner identity protected", true, "9", "none", ownershipBool(false), true},
		{"ordinary personal admin target", false, "77", "admin", nil, false},
		{"exceptional personal owner target", false, "77", "owner", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &golfv1.RepositoryAccess{OwnerId: "9", OrganizationOwned: tc.org}
			c := &golfv1.RepositoryCollaborator{User: &golfv1.User{Id: tc.id}, Permission: tc.permission, ActualOrganizationOwner: tc.proof}
			if protectedCollaboratorTarget(a, c, 42) != tc.blocked {
				t.Fatal("target ownership conflated with native effective access")
			}
		})
	}
	if !protectedCollaboratorTarget(nil, nil, 42) {
		t.Fatal("missing target admitted")
	}
}

func TestCollaboratorOwnershipRevisionAndLegacyInvitationCompatibility(t *testing.T) {
	a := &golfv1.RepositoryAccess{RepositoryId: "17", OwnerId: "9", OrganizationOwned: true}
	c := &golfv1.RepositoryCollaborator{User: &golfv1.User{Id: "77", Login: "Bob"}, Permission: "owner", ActualOrganizationOwner: ownershipBool(false)}
	legacy := accessRevision(struct {
		RepoID, OwnerID, UserID, Login, Permission string
		Direct                                     bool
	}{"17", "9", "77", "bob", "owner", false})
	if collaboratorRevision(a, c, 0) != legacy {
		t.Fatal("proved non-owner zero-generation legacy invitation invalidated")
	}
	invitation := &golfv1.RepositoryInvitationRecipient{User: c.User, EffectivePermission: c.Permission}
	for _, generation := range []int64{0, 1, 2} {
		before := collaboratorRevision(a, c, generation)
		if invitationRecipientRevision(a, invitation, generation) != before {
			t.Fatal("current proved non-owner invitation lost target binding")
		}
		c.ActualOrganizationOwner = ownershipBool(true)
		if collaboratorRevision(a, c, generation) == before {
			t.Fatal("actual owner promotion hidden under unchanged effective owner")
		}
		c.ActualOrganizationOwner = ownershipBool(false)
	}
	if collaboratorRevision(a, c, 1) == collaboratorRevision(a, c, 2) {
		t.Fatal("retained generation omitted")
	}
}

func organizationOwnershipFixture(t *testing.T) *accessIntentFixture {
	t.Helper()
	f := newAccessIntentFixture(t)
	f.organization = true
	f.row.Owner = &User{ID: 900, Login: "acme"}
	f.row.FullName = "acme/example"
	f.row.HTMLURL = "http://forge.invalid/acme/example"
	f.floor = "owner"
	return f
}
func TestCollaboratorOwnershipMutationPostgres(t *testing.T) {
	f := organizationOwnershipFixture(t)
	a, c := f.preview(t, "alice")
	if c.ActualOrganizationOwner == nil || *c.ActualOrganizationOwner || c.Permission != "owner" {
		t.Fatal("admin team ownership not disambiguated")
	}
	r, e := f.set(t, "alice", f.request(a, c, "read"))
	if e != nil || r.Msg.Operation.Phase != "SUCCEEDED" || r.Msg.Collaborator.Permission != "owner" || f.writes != 1 {
		t.Fatal("non-owner team target direct role refused", e)
	}
}
func TestCollaboratorOwnershipTrueAndMissingProofPostgres(t *testing.T) {
	for _, mode := range []string{"actual_owner", "missing", "denied"} {
		t.Run(mode, func(t *testing.T) {
			f := organizationOwnershipFixture(t)
			a, c := f.preview(t, "alice")
			m := f.request(a, c, "read")
			f.mu.Lock()
			switch mode {
			case "actual_owner":
				f.actualOwner = true
			case "missing":
				f.ownershipMissing = true
			case "denied":
				f.ownershipStatus = 403
			}
			f.mu.Unlock()
			if _, e := f.set(t, "alice", m); e == nil || f.writes != 0 {
				t.Fatal("protected or unknown owner target admitted", e)
			}
		})
	}
}
func TestCollaboratorOwnershipPromotionAfterReservationWaitPostgres(t *testing.T) {
	f := organizationOwnershipFixture(t)
	a, c := f.preview(t, "alice")
	m := f.request(a, c, "read")
	holder, e := f.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer holder.Rollback()
	if _, e = holder.Exec(`SELECT golf_repository_access_lock($1,$2,$3)`, f.s.config.ForgeURL, int64(9007199254740993), int64(77)); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, e := f.set(t, "alice", m); done <- e }()
	waitManagementLock(t, f.db, "ConcurrentAccessTarget", 1)
	f.mu.Lock()
	f.actualOwner = true
	f.mu.Unlock()
	if e = holder.Commit(); e != nil {
		t.Fatal(e)
	}
	if e = <-done; connect.CodeOf(e) != connect.CodeFailedPrecondition || f.writes != 0 {
		t.Fatal("owner promotion hidden across reservation wait", e)
	}
}
func TestCollaboratorOwnershipPromotionAtDispatchPostgres(t *testing.T) {
	for _, at := range []int{3, 4} {
		t.Run(map[int]string{3: "before_unknown", 4: "final_before_POST"}[at], func(t *testing.T) {
			f := organizationOwnershipFixture(t)
			a, c := f.preview(t, "alice")
			m := f.request(a, c, "read")
			f.promoteOnRead = at
			r, e := f.set(t, "alice", m)
			if f.writes != 0 {
				t.Fatal("post-reservation owner promotion dispatched")
			}
			if at == 3 && (e != nil || r.Msg.Operation.Phase != "REJECTED") {
				t.Fatal("known predispatch refusal not retained", e)
			}
			if at == 4 && connect.CodeOf(e) != connect.CodeFailedPrecondition {
				t.Fatal("final native ownership loss not fenced", e)
			}
		})
	}
}
func TestInvitationRecipientOwnershipTargetPostgres(t *testing.T) {
	f := organizationOwnershipFixture(t)
	a, _ := f.preview(t, "alice")
	ctx := f.ctx(t, "alice")
	key := repositoryKey{"acme", "example"}
	token := forgeCredential{Kind: "pat", Token: "alice"}
	r, e := f.s.invitationRecipient(ctx, token, key, a, f.users["alice"], "bob")
	if e != nil || r.EffectivePermission != "owner" {
		t.Fatal("admin-team recipient invitation refused", e)
	}
	f.actualOwner = true
	if _, e = f.s.invitationRecipient(ctx, token, key, a, f.users["alice"], "bob"); e == nil {
		t.Fatal("actual owner invitation admitted")
	}
	f.actualOwner = false
	f.ownershipMissing = true
	if _, e = f.s.invitationRecipient(ctx, token, key, a, f.users["alice"], "bob"); e == nil {
		t.Fatal("unproved recipient ownership admitted")
	}
}

func TestCollaboratorOwnershipPromotionAfterNativeWritePostgres(t *testing.T) {
	f := organizationOwnershipFixture(t)
	a, c := f.preview(t, "alice")
	m := f.request(a, c, "read")
	f.promoteOnRead = 5
	r, e := f.set(t, "alice", m)
	if e != nil || r.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || r.Msg.Collaborator != nil || f.writes != 1 {
		t.Fatal("post-write actual ownership promotion must withhold verified success", e)
	}
	_, e = f.set(t, "alice", m)
	if f.writes != 1 {
		t.Fatal("uncertain ownership observation replayed native write", e)
	}
}
