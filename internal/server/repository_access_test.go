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

func TestRepositoryAccessValidation(t *testing.T) {
	key := repositoryKey{"alice", "example"}
	revision := accessRevision("fixture")
	if err := validateRepositoryAccess(key, "9007199254740993", "42", revision, "bob"); err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct{ repo, owner, revision, login string }{{"01", "42", revision, "bob"}, {"1", "0", revision, "bob"}, {"1", "42", strings.ToUpper(revision), "bob"}, {"1", "42", revision, "../bob"}} {
		if validateRepositoryAccess(key, input.repo, input.owner, input.revision, input.login) == nil {
			t.Fatal("invalid access binding accepted")
		}
	}
	for _, permission := range []string{"", "administrator", "READ", "maintain"} {
		if validRepositoryPermission(permission) {
			t.Fatal("unexpected permission", permission)
		}
	}
}
func TestRepositoryAccessPagination(t *testing.T) {
	for _, test := range []struct {
		total             string
		page, limit, next uint32
		valid             bool
	}{
		{"3", 1, 1, 2, true}, {"3", 2, 1, 3, true}, {"3", 3, 1, 0, true}, {"0", 1, 20, 0, true},
		{"200001", 10000, 20, 0, false}, {"", 1, 20, 0, false}, {"03", 1, 1, 0, false}, {"-1", 1, 1, 0, false}, {"9223372036854775808", 1, 20, 0, false},
	} {
		next, err := repositoryCollaboratorNextPage(http.Header{"X-Total-Count": []string{test.total}}, test.page, test.limit)
		if (err == nil) != test.valid || next != test.next {
			t.Fatalf("pagination %q page%d: next%d err%v", test.total, test.page, next, err)
		}
	}
}

func TestRepositoryAccessBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GetRepositoryAccess", "ListRepositoryCollaborators", "ResolveRepositoryCollaborator", "SetRepositoryCollaborator", "RemoveRepositoryCollaborator"} {
		path := "/golf.v1.RepositoryAccessService/" + method
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
				t.Fatalf("%s boundary %d", method, recorder.Code)
			}
		}
		if got := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); got.Code != 403 {
			t.Fatalf("bearer reached %s: %d", method, got.Code)
		}
	}
}

func TestRepositoryAccessNativeProjection(t *testing.T) {
	row := settingsFixtureRow()
	caller := User{ID: 42, Login: "alice"}
	kind := "personal"
	permission := "owner"
	direct := false
	member, orgOwner := true, false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/settings/api":
			json.NewEncoder(w).Encode(map[string]int{"max_response_items": 50})
		case r.URL.Path == "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case r.URL.Path == "/api/v1/repos/alice/example":
			json.NewEncoder(w).Encode(row)
		case r.URL.Path == "/api/v1/users/search":
			users := []User{}
			if kind == "personal" {
				users = append(users, *row.Owner)
			}
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": users})
		case r.URL.Path == "/api/v1/orgs/alice":
			if kind == "org" {
				json.NewEncoder(w).Encode(forgeOrganization{ID: 42, Name: "alice", Visibility: "private"})
			} else {
				w.WriteHeader(404)
			}
		case strings.Contains(r.URL.Path, "/members/"):
			if member {
				w.WriteHeader(204)
			} else {
				w.WriteHeader(404)
			}
		case strings.HasSuffix(r.URL.Path, "/permissions"):
			json.NewEncoder(w).Encode(map[string]bool{"is_owner": orgOwner})
		case strings.HasSuffix(r.URL.Path, "/permission"):
			json.NewEncoder(w).Encode(map[string]any{"permission": permission, "user": caller})
		case strings.Contains(r.URL.Path, "/collaborators/"):
			if direct {
				w.WriteHeader(204)
			} else {
				w.WriteHeader(404)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	read := func() *golfv1.RepositoryAccess {
		access, err := s.readRepositoryAccess(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"alice", "example"}, caller)
		if err != nil {
			t.Fatal(err)
		}
		return access
	}
	if !read().CanManage {
		t.Fatal("actual owner cannot manage")
	}
	caller = User{ID: 43, Login: "bob"}
	permission = "owner"
	direct = true
	if read().CanManage {
		t.Fatal("native global administrator owner permission bypassed actual ownership")
	}
	permission = "admin"
	direct = false
	if read().CanManage {
		t.Fatal("effective role alone bypassed direct membership")
	}
	direct = true
	if !read().CanManage {
		t.Fatal("explicit native administrator cannot manage")
	}
	permission = "read"
	if read().CanManage {
		t.Fatal("reader can manage")
	}
	kind = "org"
	permission = "admin"
	if access := read(); !access.OrganizationOwned || !access.CanManage {
		t.Fatal("current organization member/direct admin cannot manage")
	}
	direct = false
	if read().CanManage {
		t.Fatal("effective team administration bypassed direct/owner evidence")
	}
	orgOwner = true
	permission = "owner"
	if !read().CanManage {
		t.Fatal("current organization owner cannot manage")
	}
	orgOwner = false
	direct = true
	if read().CanManage {
		t.Fatal("native site owner-level permission bypassed organization ownership")
	}
	permission = "admin"
	member = false
	if _, err = s.readRepositoryAccess(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"alice", "example"}, caller); err == nil {
		t.Fatal("nonmember native direct admin acquired organization delegation")
	}
	member = true
	row.Archived = func() *bool { v := true; return &v }()
	if read().CanManage {
		t.Fatal("archived organization editable")
	}
	row.Archived = func() *bool { v := false; return &v }()
	row.Mirror = func() *bool { v := true; return &v }()
	if read().CanManage {
		t.Fatal("mirror organization editable")
	}
	row.Mirror = func() *bool { v := false; return &v }()
	kind = "hidden-org"
	if _, err = s.readRepositoryAccess(t.Context(), forgeCredential{Kind: "pat", Token: "fixture"}, repositoryKey{"alice", "example"}, caller); err == nil {
		t.Fatal("hidden organization 404 became personal owner")
	}
}

func TestRepositoryAccessPostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	row := settingsFixtureRow()
	row.Private = true
	caller := User{ID: 42, Login: "alice"}
	target := User{ID: 77, Login: "bob"}
	direct := false
	permission := "none"
	inherited := ""
	writes := 0
	lost := false
	var onTarget func()
	var onRepository func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/v1/settings/api":
			json.NewEncoder(w).Encode(map[string]int{"max_response_items": 50})
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(caller)
		case "/api/v1/repos/alice/example":
			if onRepository != nil {
				onRepository()
			}
			json.NewEncoder(w).Encode(row)
		case "/api/v1/users/search":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{*row.Owner}})
		case "/api/v1/users/bob":
			if onTarget != nil {
				onTarget()
			}
			json.NewEncoder(w).Encode(target)
		case "/api/v1/users/alice":
			json.NewEncoder(w).Encode(*row.Owner)
		case "/api/v1/repos/alice/example/collaborators/alice/permission":
			json.NewEncoder(w).Encode(map[string]any{"permission": "owner", "user": *row.Owner})
		case "/api/v1/repos/alice/example/collaborators/alice":
			w.WriteHeader(404)
		case "/api/v1/repos/alice/example/collaborators/bob/permission":
			observed := permission
			if inherited != "" {
				observed = inherited
			}
			json.NewEncoder(w).Encode(map[string]any{"permission": observed, "user": target})
		case "/api/v1/repos/alice/example/collaborators/bob":
			if r.Method == "GET" {
				if direct {
					w.WriteHeader(204)
				} else {
					w.WriteHeader(404)
				}
				return
			}
			writes++
			if r.Method == "PUT" {
				var body map[string]string
				json.NewDecoder(r.Body).Decode(&body)
				permission = body["permission"]
				direct = true
			} else if r.Method == "DELETE" {
				direct = false
				permission = "none"
				if row.Private == false {
					permission = "read"
				}
			} else {
				w.WriteHeader(405)
				return
			}
			if lost {
				w.WriteHeader(500)
			} else {
				w.WriteHeader(204)
			}
		case "/api/v1/repos/alice/example/collaborators":
			w.Header().Set("X-Total-Count", "0")
			if direct {
				w.Header().Set("X-Total-Count", "1")
			}
			users := []User{}
			if direct {
				users = append(users, target)
			}
			json.NewEncoder(w).Encode(users)
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), caller, "pat", "fixture-access", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "fixture-access"})
	cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
	key := &golfv1.RepositoryKey{Owner: "alice", Name: "example"}
	get := func() *golfv1.RepositoryAccess {
		req := connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: key})
		req.Header().Set("Cookie", cookie)
		got, err := s.GetRepositoryAccess(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return got.Msg.Access
	}
	resolve := func(access *golfv1.RepositoryAccess, login string) *golfv1.RepositoryCollaborator {
		req := connect.NewRequest(&golfv1.ResolveRepositoryCollaboratorRequest{Repository: key, RepositoryId: access.RepositoryId, OwnerId: access.OwnerId, ExpectedRevision: access.Revision, UserLogin: login})
		req.Header().Set("Cookie", cookie)
		got, err := s.ResolveRepositoryCollaborator(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return got.Msg.Collaborator
	}
	set := func(access *golfv1.RepositoryAccess, member *golfv1.RepositoryCollaborator, grant string) (*connect.Response[golfv1.SetRepositoryCollaboratorResponse], error) {
		req := connect.NewRequest(&golfv1.SetRepositoryCollaboratorRequest{Repository: key, RepositoryId: access.RepositoryId, OwnerId: access.OwnerId, ExpectedRevision: access.Revision, UserLogin: member.User.Login, UserId: member.User.Id, ExpectedCollaboratorRevision: member.Revision, Permission: grant})
		req.Header().Set("Cookie", cookie)
		return s.SetRepositoryCollaborator(ctx, req)
	}
	remove := func(access *golfv1.RepositoryAccess, member *golfv1.RepositoryCollaborator) (*connect.Response[golfv1.RemoveRepositoryCollaboratorResponse], error) {
		req := connect.NewRequest(&golfv1.RemoveRepositoryCollaboratorRequest{Repository: key, RepositoryId: access.RepositoryId, OwnerId: access.OwnerId, ExpectedRevision: access.Revision, UserLogin: member.User.Login, UserId: member.User.Id, ExpectedCollaboratorRevision: member.Revision})
		req.Header().Set("Cookie", cookie)
		return s.RemoveRepositoryCollaborator(ctx, req)
	}
	access := get()
	candidate := resolve(access, "bob")
	if candidate.IsDirect || candidate.Permission != "none" {
		t.Fatal("absent candidate")
	}
	for _, grant := range []string{"read", "write", "admin"} {
		got, err := set(access, candidate, grant)
		if err != nil || !got.Msg.Collaborator.IsDirect || got.Msg.Collaborator.Permission != grant {
			t.Fatal("native role change", grant, err)
		}
		if _, err = set(access, candidate, grant); connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatal("stale target dispatched", err)
		}
		candidate = got.Msg.Collaborator
	}
	if writes != 3 {
		t.Fatal("unexpected write count", writes)
	}
	// A lower requested direct role can coexist with higher observed access.
	// Native GET does not expose the stored direct mode, so acknowledge the
	// exact PUT204 separately from the bound effective observation.
	mu.Lock()
	inherited = "admin"
	mu.Unlock()
	for _, requested := range []string{"read", "write"} {
		candidate = resolve(access, "bob")
		got, e := set(access, candidate, requested)
		if e != nil || !got.Msg.Collaborator.IsDirect || got.Msg.Collaborator.Permission != "admin" {
			t.Fatal("inherited effective access mistaken for rejected direct role", requested, e)
		}
	}
	if writes != 5 {
		t.Fatal("inherited requests repeated or missing", writes)
	}
	mu.Lock()
	inherited = ""
	mu.Unlock()
	candidate = resolve(access, "bob")
	owner := resolve(access, "alice")
	if _, err = set(access, owner, "read"); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("owner downgrade accepted", err)
	}
	if _, err = remove(access, owner); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("owner removal accepted", err)
	}
	bad := &golfv1.RepositoryCollaborator{User: &golfv1.User{Id: "78", Login: "bob"}, Revision: candidate.Revision}
	if _, err = set(access, bad, "write"); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("wrong immutable target accepted", err)
	}
	mu.Lock()
	row.Private = false
	mu.Unlock()
	public := get()
	if _, err = set(access, candidate, "write"); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("changed repository scope accepted", err)
	}
	candidate = resolve(public, "bob")
	removed, err := remove(public, candidate)
	if err != nil || removed.Msg.Collaborator.IsDirect || removed.Msg.Collaborator.Permission != "read" {
		t.Fatal("public readability mistaken for direct membership", err)
	}
	candidate = removed.Msg.Collaborator
	mu.Lock()
	lost = true
	mu.Unlock()
	if _, err = set(public, candidate, "write"); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("lost write was success", err)
	}
	if writes != 7 || !resolve(public, "bob").IsDirect {
		t.Fatal("lost write retried or disappeared", writes)
	}
	mu.Lock()
	lost = false
	permission = "admin"
	caller = target
	mu.Unlock()
	adminSession, err := s.createSession(t.Context(), caller, "pat", "fixture-access", "")
	if err != nil {
		t.Fatal(err)
	}
	originalCookie := cookie
	cookie = s.sessionCookie(adminSession.Value, adminSession.Expires, 3600).String()
	adminAccess := get()
	self := resolve(adminAccess, "bob")
	if !adminAccess.CanManage {
		t.Fatal("direct admin cannot manage")
	}
	if _, err := set(adminAccess, self, "read"); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("admin self downgrade accepted", err)
	}
	if _, err := remove(adminAccess, self); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("admin self removal accepted", err)
	}
	if writes != 7 {
		t.Fatal("self mutation dispatched")
	}
	if err := s.logoutSession(t.Context(), adminSession.Value); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	caller = User{ID: 42, Login: "alice"}
	permission = "write"
	mu.Unlock()
	cookie = originalCookie
	candidate = resolve(public, "bob")
	// Native revocation after target lookup and before fresh authority read.
	onTarget = func() { onTarget = nil; row.Permissions.Admin = false }
	if _, err = set(public, candidate, "admin"); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 7 {
		t.Fatal("revoked authority dispatched", err)
	}
	mu.Lock()
	row.Permissions.Admin = true
	mu.Unlock()
	candidate = resolve(public, "bob")
	onTarget = func() {
		onTarget = nil
		if err := s.logoutSession(t.Context(), session.Value); err != nil {
			t.Error(err)
		}
	}
	if _, err = set(public, candidate, "admin"); connect.CodeOf(err) != connect.CodeUnauthenticated || writes != 7 {
		t.Fatal("revoked session dispatched", err)
	}
}

func TestRepositoryAccessEffectivePermission(t *testing.T) {
	for _, tc := range []struct {
		actual, requested string
		allow             bool
	}{{"admin", "read", true}, {"write", "read", true}, {"owner", "admin", true}, {"read", "admin", false}, {"none", "read", false}, {"ADMIN", "read", false}, {"admin", "owner", false}, {"admin", "", false}} {
		if observedAccessAllows(tc.actual, tc.requested) != tc.allow {
			t.Fatalf("effective %q/request %q", tc.actual, tc.requested)
		}
	}
}
