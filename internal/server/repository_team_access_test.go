package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestRepositoryTeamAccessPresenceAndRevision(t *testing.T) {
	org := forgeOrganization{ID: 77, Name: "workshop", Visibility: "private"}
	team := forgeOrganizationTeam{ID: 100, Name: "Builders", Permission: "write", Visibility: "private", UnitPermissions: map[string]string{"repo.code": "write"}, Organization: &org}
	body, _ := json.Marshal(team)
	var valid repositoryNativeTeam
	if err := json.Unmarshal(body, &valid); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"includes_all_repositories", "units_map", "permission", "visibility"} {
		for _, null := range []bool{false, true} {
			var fields map[string]any
			json.Unmarshal(body, &fields)
			if null {
				fields[field] = nil
			} else {
				delete(fields, field)
			}
			malformed, _ := json.Marshal(fields)
			if err := json.Unmarshal(malformed, &repositoryNativeTeam{}); err == nil {
				t.Fatalf("unknown %s accepted null=%v", field, null)
			}
		}
	}
	access := &golfv1.RepositoryAccess{RepositoryId: "17", OwnerId: "77", Revision: strings.Repeat("a", 64)}
	first := repositoryTeamProjection(access, org, team, false, true)
	attached := repositoryTeamProjection(access, org, team, true, true)
	if !first.CanAttach || first.CanDetach || !attached.CanDetach || first.Revision == attached.Revision {
		t.Fatal("association/eligibility omitted")
	}
	team.UnitPermissions["repo.code"] = "read"
	if repositoryTeamProjection(access, org, team, false, true).Revision == first.Revision {
		t.Fatal("unit configuration omitted")
	}
	for _, protect := range []func(*forgeOrganizationTeam){func(t *forgeOrganizationTeam) { t.Name = "Owners" }, func(t *forgeOrganizationTeam) { t.IncludesAllRepositories = true }, func(t *forgeOrganizationTeam) { t.Permission = "owner" }, func(t *forgeOrganizationTeam) { t.UnitPermissions["repo.code"] = "owner" }} {
		value := valid.forgeOrganizationTeam
		value.UnitPermissions = map[string]string{"repo.code": "write"}
		protect(&value)
		for _, association := range []bool{false, true} {
			projected := repositoryTeamProjection(access, org, value, association, true)
			if projected.CanAttach || projected.CanDetach {
				t.Fatal("protected team became mutable")
			}
		}
	}
}
func TestRepositoryTeamAccessBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"ListRepositoryTeamAccess", "AttachRepositoryTeam", "DetachRepositoryTeam"} {
		path := "/golf.v1.RepositoryTeamAccessService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal(method, w.Code)
			}
		}
		if got := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); got.Code != 403 {
			t.Fatal("bearer reached association", got.Code)
		}
	}
}

type repositoryTeamFixture struct {
	mu                         sync.Mutex
	s                          *Server
	ctx                        context.Context
	cookie                     string
	row                        forgeRepositorySettings
	org                        forgeOrganization
	team                       forgeOrganizationTeam
	owner, member, attached    bool
	permission, mode, listMode string
	writes, teamReads          int
	onTeams                    func()
	onWrite                    func()
	sessionHash                []byte
}

func newRepositoryTeamFixture(t *testing.T) *repositoryTeamFixture {
	t.Helper()
	db := testDatabase(t)
	f := &repositoryTeamFixture{org: forgeOrganization{ID: 77, Name: "workshop", Visibility: "private"}, row: settingsFixtureRow(), owner: true, member: true, permission: "admin"}
	f.row.FullName = "workshop/example"
	f.row.Owner = &User{ID: 77, Login: "workshop"}
	f.row.Private = true
	f.team = forgeOrganizationTeam{ID: 100, Name: "Builders", Permission: "write", Visibility: "private", UnitPermissions: map[string]string{"repo.code": "write"}, Organization: &f.org}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/settings/api":
			json.NewEncoder(w).Encode(map[string]int{"max_response_items": 50})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{}})
		case "/api/v1/orgs/workshop":
			json.NewEncoder(w).Encode(f.org)
		case "/api/v1/orgs/workshop/members/alice":
			if f.member {
				w.WriteHeader(204)
			} else {
				w.WriteHeader(404)
			}
		case "/api/v1/users/alice/orgs/workshop/permissions":
			json.NewEncoder(w).Encode(map[string]bool{"is_owner": f.owner})
		case "/api/v1/repos/workshop/example":
			json.NewEncoder(w).Encode(f.row)
		case "/api/v1/repos/workshop/example/collaborators/alice/permission":
			json.NewEncoder(w).Encode(map[string]any{"permission": f.permission, "user": User{ID: 42, Login: "alice"}})
		case "/api/v1/orgs/workshop/teams":
			var value map[string]any
			body, _ := json.Marshal(f.team)
			json.Unmarshal(body, &value)
			delete(value, "organization")
			if f.listMode == "unknown-inheritance" {
				delete(value, "includes_all_repositories")
			}
			rows := []map[string]any{value}
			total := "1"
			switch f.listMode {
			case "duplicate":
				rows = append(rows, value)
				total = "2"
			case "missing":
				rows = nil
			case "bad-count":
				total = "01"
			case "wrong-org":
				value["organization"] = map[string]any{"id": 78, "username": "another", "visibility": "private"}
			}
			w.Header().Set("X-Total-Count", total)
			json.NewEncoder(w).Encode(rows)
		case "/api/v1/teams/100":
			f.teamReads++
			if f.mode == "foreign-team" {
				copy := f.team
				copy.Organization = &forgeOrganization{ID: 78, Name: "another", Visibility: "private"}
				json.NewEncoder(w).Encode(copy)
			} else {
				json.NewEncoder(w).Encode(f.team)
			}
		case "/api/v1/repos/workshop/example/teams":
			if f.onTeams != nil {
				f.onTeams()
			}
			rows := []forgeOrganizationTeam{}
			if f.attached {
				rows = append(rows, f.team)
			}
			if f.listMode == "association-link" {
				w.Header().Set("Link", `<next>; rel="next"`)
			}
			if f.listMode == "association-cap" {
				for i := int64(1); i <= 501; i++ {
					value := f.team
					value.ID = i
					rows = append(rows, value)
				}
			}
			json.NewEncoder(w).Encode(rows)
		case "/api/v1/teams/100/repos/workshop/example":
			if r.Method != "PUT" && r.Method != "DELETE" {
				t.Error("unexpected native association method", r.Method)
				w.WriteHeader(405)
				return
			}
			f.writes++
			if f.onWrite != nil {
				f.onWrite()
			}
			f.attached = r.Method == "PUT"
			if f.mode == "lost" {
				w.WriteHeader(500)
				return
			}
			if f.mode == "wrong-ack" {
				w.WriteHeader(200)
				return
			}
			if f.mode == "wrong-readback" {
				f.attached = !f.attached
			}
			if f.mode == "config-after" {
				f.team.Permission = "read"
			}
			if f.mode == "owner-after" {
				f.owner = false
			}
			if f.mode == "repo-after" {
				f.row.ID++
			}
			w.WriteHeader(204)
		default:
			t.Error("unexpected provider request", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(provider.Close)
	var err error
	f.s, err = New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	caller := User{ID: 42, Login: "alice"}
	session, err := f.s.createSession(t.Context(), caller, "pat", "team-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	f.ctx = context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "team-fixture"})
	f.cookie = f.s.sessionCookie(session.Value, session.Expires, 3600).String()
	f.sessionHash, _ = sessionHash(session.Value)
	return f
}
func (f *repositoryTeamFixture) access(t *testing.T) *golfv1.RepositoryAccess {
	t.Helper()
	r := connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: &golfv1.RepositoryKey{Owner: "workshop", Name: "example"}})
	r.Header().Set("Cookie", f.cookie)
	got, e := f.s.GetRepositoryAccess(f.ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	return got.Msg.Access
}
func (f *repositoryTeamFixture) list(a *golfv1.RepositoryAccess) (*connect.Response[golfv1.ListRepositoryTeamAccessResponse], error) {
	r := connect.NewRequest(&golfv1.ListRepositoryTeamAccessRequest{Repository: &golfv1.RepositoryKey{Owner: "workshop", Name: "example"}, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, Page: &golfv1.PageRequest{Page: 1, Limit: 20}})
	r.Header().Set("Cookie", f.cookie)
	return f.s.ListRepositoryTeamAccess(f.ctx, r)
}
func (f *repositoryTeamFixture) change(a *golfv1.RepositoryAccess, row *golfv1.RepositoryTeamAccess, attach bool) (*golfv1.RepositoryTeamAccess, error) {
	if attach {
		r := connect.NewRequest(&golfv1.AttachRepositoryTeamRequest{Repository: &golfv1.RepositoryKey{Owner: "workshop", Name: "example"}, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, TeamId: row.Team.Id, ExpectedTeamRevision: row.Revision})
		r.Header().Set("Cookie", f.cookie)
		got, e := f.s.AttachRepositoryTeam(f.ctx, r)
		if e != nil {
			return nil, e
		}
		return got.Msg.Team, nil
	}
	r := connect.NewRequest(&golfv1.DetachRepositoryTeamRequest{Repository: &golfv1.RepositoryKey{Owner: "workshop", Name: "example"}, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.Revision, TeamId: row.Team.Id, ExpectedTeamRevision: row.Revision})
	r.Header().Set("Cookie", f.cookie)
	got, e := f.s.DetachRepositoryTeam(f.ctx, r)
	if e != nil {
		return nil, e
	}
	return got.Msg.Team, nil
}
func TestRepositoryTeamAccessPostgres(t *testing.T) {
	f := newRepositoryTeamFixture(t)
	a := f.access(t)
	got, e := f.list(a)
	if e != nil {
		t.Fatal(e)
	}
	if !got.Msg.CanManage || len(got.Msg.Teams) != 1 || !got.Msg.Teams[0].CanAttach || got.Msg.Teams[0].Attached {
		t.Fatal("inventory did not separate grant from global team permission")
	}
	first := got.Msg.Teams[0]
	attached, e := f.change(a, first, true)
	if e != nil || !attached.Attached || !attached.CanDetach || f.writes != 1 {
		t.Fatal("attach receipt", e)
	}
	if f.team.Permission != "write" || f.team.UnitPermissions["repo.code"] != "write" {
		t.Fatal("global permissions changed")
	}
	if _, e = f.change(a, first, true); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.writes != 1 {
		t.Fatal("stale association dispatched", e)
	}
	detached, e := f.change(a, attached, false)
	if e != nil || detached.Attached || f.writes != 2 {
		t.Fatal("detach receipt", e)
	}
	if _, e = f.change(a, attached, false); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.writes != 2 {
		t.Fatal("stale detach dispatched", e)
	}
	f.mu.Lock()
	f.team.Permission = "read"
	f.mu.Unlock()
	if _, e = f.change(a, detached, true); connect.CodeOf(e) != connect.CodeFailedPrecondition || f.writes != 2 {
		t.Fatal("changed team config dispatched", e)
	}
}
func TestRepositoryTeamAccessAuthoritiesPostgres(t *testing.T) {
	for _, kind := range []string{"org-owner-denied", "repo-admin-denied", "archived", "mirror", "hidden-org", "foreign-team", "owner-team", "inherits-all", "wrong-repo", "wrong-org", "stale-access"} {
		t.Run(kind, func(t *testing.T) {
			f := newRepositoryTeamFixture(t)
			a := f.access(t)
			got, e := f.list(a)
			if e != nil {
				t.Fatal(e)
			}
			row := got.Msg.Teams[0]
			f.mu.Lock()
			switch kind {
			case "org-owner-denied":
				f.owner = false
			case "repo-admin-denied":
				f.row.Permissions.Admin = false
				f.permission = "read"
			case "archived":
				*f.row.Archived = true
			case "mirror":
				*f.row.Mirror = true
			case "hidden-org":
				f.member = false
			case "foreign-team":
				f.mode = "foreign-team"
			case "owner-team":
				f.team.Name = "Owners"
			case "inherits-all":
				f.team.IncludesAllRepositories = true
			case "wrong-repo":
				a.RepositoryId = "18"
			case "wrong-org":
				a.OwnerId = "78"
			case "stale-access":
				a.Revision = strings.Repeat("b", 64)
			}
			f.mu.Unlock()
			if _, e = f.change(a, row, true); e == nil || f.writes != 0 {
				t.Fatal("unauthorized association dispatched", e)
			}
			if kind == "org-owner-denied" || kind == "repo-admin-denied" {
				current, e := f.list(f.access(t))
				if e != nil || current.Msg.CanManage || current.Msg.Teams[0].CanAttach {
					t.Fatal("reader falsely became manager", e)
				}
			}
		})
	}
}
func TestRepositoryTeamAccessMalformedInventoryPostgres(t *testing.T) {
	for _, mode := range []string{"duplicate", "missing", "bad-count", "unknown-inheritance", "wrong-org", "association-link", "association-cap"} {
		t.Run(mode, func(t *testing.T) {
			f := newRepositoryTeamFixture(t)
			a := f.access(t)
			f.mu.Lock()
			f.listMode = mode
			f.mu.Unlock()
			if _, e := f.list(a); e == nil || f.writes != 0 {
				t.Fatal("incomplete native inventory accepted", e)
			}
		})
	}
}
func TestRepositoryTeamAccessUncertainPostgres(t *testing.T) {
	for _, mode := range []string{"lost", "wrong-ack", "wrong-readback", "config-after", "owner-after", "repo-after"} {
		t.Run(mode, func(t *testing.T) {
			f := newRepositoryTeamFixture(t)
			a := f.access(t)
			got, e := f.list(a)
			if e != nil {
				t.Fatal(e)
			}
			f.mu.Lock()
			f.mode = mode
			f.mu.Unlock()
			if _, e = f.change(a, got.Msg.Teams[0], true); e == nil || f.writes != 1 {
				t.Fatal("unqualified receipt or retry", e)
			}
			if mode == "lost" && !f.attached {
				t.Fatal("fixture did not establish accepted native effect")
			}
		})
	}
}
func TestRepositoryTeamAccessLatePermissionLossPostgres(t *testing.T) {
	f := newRepositoryTeamFixture(t)
	a := f.access(t)
	f.mu.Lock()
	f.onTeams = func() { f.owner = false }
	f.mu.Unlock()
	if _, e := f.list(a); e == nil {
		t.Fatal("late grant loss returned private rows")
	}
}

func TestRepositoryTeamAccessValidation(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "validation-only"})
	for _, mutate := range []func(*golfv1.ListRepositoryTeamAccessRequest){func(r *golfv1.ListRepositoryTeamAccessRequest) { r.RepositoryId = "017" }, func(r *golfv1.ListRepositoryTeamAccessRequest) { r.OwnerId = "0" }, func(r *golfv1.ListRepositoryTeamAccessRequest) { r.ExpectedRevision = "bad" }, func(r *golfv1.ListRepositoryTeamAccessRequest) { r.Page.Limit = 21 }, func(r *golfv1.ListRepositoryTeamAccessRequest) { r.Page.Page = 10001 }} {
		req := &golfv1.ListRepositoryTeamAccessRequest{Repository: &golfv1.RepositoryKey{Owner: "workshop", Name: "example"}, RepositoryId: "17", OwnerId: "77", ExpectedRevision: strings.Repeat("a", 64), Page: &golfv1.PageRequest{Page: 1, Limit: 20}}
		mutate(req)
		if _, e = s.ListRepositoryTeamAccess(ctx, connect.NewRequest(req)); connect.CodeOf(e) != connect.CodeInvalidArgument {
			t.Fatal("invalid read reached provider", e)
		}
	}
	for _, input := range [][2]string{{"0100", strings.Repeat("b", 64)}, {"100", "bad"}} {
		if _, e = s.changeRepositoryTeam(ctx, http.Header{}, repositoryKey{"workshop", "example"}, "17", "77", strings.Repeat("a", 64), input[0], input[1], true); connect.CodeOf(e) != connect.CodeInvalidArgument {
			t.Fatal("invalid write reached provider", e)
		}
	}
}
func TestRepositoryTeamAccessSessionLossPostgres(t *testing.T) {
	for _, write := range []bool{false, true} {
		t.Run(map[bool]string{false: "during-read", true: "after-accepted-write"}[write], func(t *testing.T) {
			f := newRepositoryTeamFixture(t)
			a := f.access(t)
			got, e := f.list(a)
			if e != nil {
				t.Fatal(e)
			}
			expire := func() {
				if _, e := f.s.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", f.sessionHash); e != nil {
					t.Error(e)
				}
			}
			f.mu.Lock()
			if write {
				f.onWrite = expire
			} else {
				f.onTeams = expire
			}
			f.mu.Unlock()
			if write {
				if _, e = f.change(a, got.Msg.Teams[0], true); connect.CodeOf(e) != connect.CodeUnauthenticated || f.writes != 1 || !f.attached {
					t.Fatal("accepted effect replayed or disclosed after expiry", e)
				}
			} else {
				if _, e = f.list(a); connect.CodeOf(e) != connect.CodeUnauthenticated || f.writes != 0 {
					t.Fatal("expired private inventory disclosed", e)
				}
			}
		})
	}
}
