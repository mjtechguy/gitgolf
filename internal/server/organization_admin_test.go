package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestOrganizationAdminValidation(t *testing.T) {
	org := forgeOrganization{ID: 77, Name: "workshop", Visibility: "private"}
	team := forgeOrganizationTeam{ID: 100, Name: "Developers", Permission: "none", Visibility: "limited", Organization: &org, UnitPermissions: map[string]string{"repo.code": "read"}}
	revision := teamAdministrationRevision(org, team)
	if ownerTeam(team) || len(revision) != 64 || validateTeamAdministration("workshop", "77", "100", "bob", revision) != nil {
		t.Fatal("valid team rejected")
	}
	team.UnitPermissions["repo.code"] = "write"
	if teamAdministrationRevision(org, team) == revision {
		t.Fatal("changed grants kept revision")
	}
	for _, value := range []string{"Owner", "Owners", "owners"} {
		team.Name = value
		if value != "Owner" && !ownerTeam(team) {
			t.Fatal("owner name not blocked")
		}
	}
	team.Name = "Developers"
	team.Permission = "owner"
	if !ownerTeam(team) {
		t.Fatal("owner permission not blocked")
	}
	team.Permission = "none"
	team.UnitPermissions["repo.code"] = "owner"
	if !ownerTeam(team) {
		t.Fatal("owner unit not blocked")
	}
	for _, input := range [][5]string{{"bad/name", "77", "100", "bob", revision}, {"workshop", "077", "100", "bob", revision}, {"workshop", "77", "0100", "bob", revision}, {"workshop", "77", "100", "../bob", revision}, {"workshop", "77", "100", "bob", strings.ToUpper(revision)}} {
		if validateTeamAdministration(input[0], input[1], input[2], input[3], input[4]) == nil {
			t.Fatal("invalid administration input accepted")
		}
	}
}

func TestOrganizationAdminBoundary(t *testing.T) {
	s, err := New(testConfig("http://forgejo.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GetTeamAdministration", "ResolveTeamMember", "AddTeamMember", "RemoveTeamMember"} {
		path := "/golf.v1.OrganizationAdminService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			req := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			s.ServeHTTP(recorder, req)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if recorder.Code != want || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s boundary: %d", method, recorder.Code)
			}
		}
		if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); response.Code != 403 {
			t.Fatalf("bearer reached administration: %d", response.Code)
		}
	}
}

func TestOrganizationAdminPostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	org := forgeOrganization{ID: 77, Name: "workshop", Visibility: "private"}
	team := forgeOrganizationTeam{ID: 100, Name: "Developers", Permission: "none", Visibility: "limited", Organization: &org, UnitPermissions: map[string]string{"repo.code": "read"}}
	target := User{ID: 9007199254740993, Login: "bob"}
	isOwner, member, lost := true, false, false
	writes := 0
	var onTarget func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
		case "/api/v1/orgs/workshop/members/alice":
			w.WriteHeader(204)
		case "/api/v1/orgs/workshop":
			json.NewEncoder(w).Encode(org)
		case "/api/v1/teams/100":
			json.NewEncoder(w).Encode(team)
		case "/api/v1/users/alice/orgs/workshop/permissions":
			json.NewEncoder(w).Encode(map[string]bool{"is_owner": isOwner, "is_admin": true})
		case "/api/v1/users/bob":
			if onTarget != nil {
				onTarget()
			}
			json.NewEncoder(w).Encode(target)
		case "/api/v1/teams/100/members/bob":
			if r.Method == "GET" {
				if !member {
					w.WriteHeader(404)
				} else {
					json.NewEncoder(w).Encode(target)
				}
				return
			}
			if r.Method != "PUT" && r.Method != "DELETE" {
				w.WriteHeader(405)
				return
			}
			writes++
			member = r.Method == "PUT"
			if lost {
				w.WriteHeader(500)
			} else {
				w.WriteHeader(204)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "org-admin-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "org-admin-fixture"})
	cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
	get := func() *golfv1.GetTeamAdministrationResponse {
		req := connect.NewRequest(&golfv1.GetTeamAdministrationRequest{Organization: "workshop", TeamId: "100"})
		req.Header().Set("Cookie", cookie)
		got, err := s.GetTeamAdministration(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return got.Msg
	}
	administration := get()
	if !administration.CanManageMembers || administration.OrganizationId != "77" {
		t.Fatal("owner not authorized")
	}
	resolve := func() (*connect.Response[golfv1.ResolveTeamMemberResponse], error) {
		req := connect.NewRequest(&golfv1.ResolveTeamMemberRequest{Organization: "workshop", OrganizationId: "77", TeamId: "100", UserLogin: "bob", ExpectedRevision: administration.Revision})
		req.Header().Set("Cookie", cookie)
		return s.ResolveTeamMember(ctx, req)
	}
	candidate, err := resolve()
	if err != nil || candidate.Msg.IsMember || candidate.Msg.User.Id != "9007199254740993" {
		t.Fatal("candidate identity", err)
	}
	add := func(userID string) (*connect.Response[golfv1.AddTeamMemberResponse], error) {
		req := connect.NewRequest(&golfv1.AddTeamMemberRequest{Organization: "workshop", OrganizationId: "77", TeamId: "100", UserLogin: "bob", UserId: userID, ExpectedRevision: administration.Revision})
		req.Header().Set("Cookie", cookie)
		return s.AddTeamMember(ctx, req)
	}
	if _, err := add("43"); connect.CodeOf(err) != connect.CodeFailedPrecondition || writes != 0 {
		t.Fatal("wrong target identity dispatched", err)
	}
	added, err := add(strconv.FormatInt(target.ID, 10))
	if err != nil || !added.Msg.IsMember || writes != 1 {
		t.Fatal("addition/readback", err)
	}
	if _, err := add(strconv.FormatInt(target.ID, 10)); connect.CodeOf(err) != connect.CodeFailedPrecondition || writes != 1 {
		t.Fatal("duplicate state dispatched", err)
	}
	req := connect.NewRequest(&golfv1.RemoveTeamMemberRequest{Organization: "workshop", OrganizationId: "77", TeamId: "100", UserLogin: "bob", UserId: strconv.FormatInt(target.ID, 10), ExpectedRevision: administration.Revision})
	req.Header().Set("Cookie", cookie)
	removed, err := s.RemoveTeamMember(ctx, req)
	if err != nil || removed.Msg.IsMember || writes != 2 {
		t.Fatal("removal/readback", err)
	}
	mu.Lock()
	isOwner = false
	mu.Unlock()
	if get().CanManageMembers {
		t.Fatal("native admin substituted for owner")
	}
	if _, err := add(strconv.FormatInt(target.ID, 10)); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 2 {
		t.Fatal("nonowner dispatched", err)
	}
	mu.Lock()
	isOwner = true
	team.Permission = "owner"
	mu.Unlock()
	if !get().IsOwnerTeam || get().CanManageMembers {
		t.Fatal("owner team enabled")
	}
	if _, err := resolve(); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("owner team candidate admitted", err)
	}
	mu.Lock()
	team.Permission = "none"
	team.UnitPermissions["repo.code"] = "write"
	mu.Unlock()
	if _, err := add(strconv.FormatInt(target.ID, 10)); connect.CodeOf(err) != connect.CodeFailedPrecondition || writes != 2 {
		t.Fatal("stale grants dispatched", err)
	}
	administration = get()
	mu.Lock()
	lost = true
	mu.Unlock()
	if _, err := add(strconv.FormatInt(target.ID, 10)); connect.CodeOf(err) != connect.CodeUnavailable || writes != 3 {
		t.Fatal("lost write confirmed/retried", err)
	}
	candidate, err = resolve()
	if err != nil || !candidate.Msg.IsMember || writes != 3 {
		t.Fatal("actual uncertain outcome missing", err)
	}
	mu.Lock()
	lost = false
	member = false
	foreign := forgeOrganization{ID: 88, Name: "foreign", Visibility: "private"}
	team.Organization = &foreign
	mu.Unlock()
	if _, err := add(strconv.FormatInt(target.ID, 10)); connect.CodeOf(err) != connect.CodeNotFound || writes != 3 {
		t.Fatal("foreign organization team admitted", err)
	}
	mu.Lock()
	team.Organization = &org
	onTarget = func() { onTarget = nil; isOwner = false }
	mu.Unlock()
	if _, err := add(strconv.FormatInt(target.ID, 10)); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 3 {
		t.Fatal("owner revoked during lookup dispatched", err)
	}
	mu.Lock()
	isOwner = true
	onTarget = func() {
		onTarget = nil
		if err := s.logoutSession(t.Context(), session.Value); err != nil {
			t.Error(err)
		}
	}
	mu.Unlock()
	if _, err := add(strconv.FormatInt(target.ID, 10)); connect.CodeOf(err) != connect.CodeUnauthenticated || writes != 3 {
		t.Fatal("revoked caller dispatched", err)
	}
}
