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
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func TestOrganizationCreationDeny(t *testing.T) {
	for _, test := range []struct {
		mode     string
		selected []int64
		admin    bool
		id       int64
		allow    bool
	}{
		{"administrators_only", nil, false, 42, false}, {"administrators_only", nil, true, 42, true}, {"selected_users", []int64{42}, false, 42, true}, {"selected_users", []int64{43}, false, 42, false}, {"all_users", nil, false, 42, true}, {"all_users", nil, false, 0, false}, {"invalid", nil, false, 42, false},
	} {
		if organizationCreationPermits(test.mode, test.selected, test.admin, test.id) != test.allow {
			t.Fatal("creation permission", test)
		}
	}
}
func TestOrganizationCreationPolicyPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	administrator := localLogin(t, f, "alice")
	ordinary := localLogin(t, f, "bob")
	callGet := func(session loginResult, local bool) *golfv1.OrganizationCreationPolicy {
		token := forgeCredential{Kind: "pat", Token: "alice-management-token", Local: local}
		if session.Value == ordinary.Value {
			token.Token = "bob-management-token"
		}
		ctx := context.WithValue(t.Context(), sessionTokenKey{}, token)
		req := connect.NewRequest(&golfv1.GetOrganizationCreationPolicyRequest{})
		req.Header().Set("Cookie", f.s.sessionCookie(session.Value, session.Expires, 3600).String())
		got, err := f.s.GetOrganizationCreationPolicy(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return got.Msg.Policy
	}
	update := func(policy *golfv1.OrganizationCreationPolicy) (*connect.Response[golfv1.UpdateOrganizationCreationPolicyResponse], error) {
		req := connect.NewRequest(&golfv1.UpdateOrganizationCreationPolicyRequest{ExpectedRevision: policy.Revision, Mode: golfv1.OrganizationCreationMode_ORGANIZATION_CREATION_MODE_SELECTED_USERS, SelectedGolfUserIds: []string{bob.UserID}})
		req.Header().Set("Cookie", f.s.sessionCookie(administrator.Value, administrator.Expires, 3600).String())
		ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "alice-management-token", Local: true})
		return f.s.UpdateOrganizationCreationPolicy(ctx, req)
	}
	initial := callGet(administrator, true)
	if !initial.CanCreate || !initial.CanEdit || initial.NativeAuthorityKnown || initial.EnforcementScope != "Golf API" || initial.Revision != "0" {
		t.Fatal("initial administrator policy")
	}
	if callGet(ordinary, true).CanCreate {
		t.Fatal("ordinary default permitted")
	}
	updated, err := update(initial)
	if err != nil || updated.Msg.Policy.Revision != "1" || updated.Msg.Policy.RevocationEpoch != "1" {
		t.Fatal("selected update", err)
	}
	normal := callGet(ordinary, true)
	if !normal.CanCreate || normal.CanEdit || len(normal.SelectedGolfUserIds) > 0 {
		t.Fatal("selection privacy or permission")
	}
	if _, err = update(initial); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale update", err)
	}
	current := callGet(administrator, true)
	var wait sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() { defer wait.Done(); _, err := update(current); results <- err }()
	}
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if connect.CodeOf(err) == connect.CodeFailedPrecondition {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("CAS concurrency", successes, conflicts)
	}
	var count int
	var epoch int64
	if err = f.db.QueryRowContext(t.Context(), "SELECT count(*) FROM golf_organization_creation_policy_events").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err = f.db.QueryRowContext(t.Context(), "SELECT revocation_epoch FROM golf_organization_creation_policies").Scan(&epoch); err != nil || count != 2 || epoch != 2 {
		t.Fatal("atomic audit/epoch", err)
	}
}
func TestOrganizationCreationNativePostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	writes := 0
	lost := false
	deny := false
	row := forgeOrganization{}
	var revoke func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case r.URL.Path == "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
		case r.URL.Path == "/api/v1/orgs" && r.Method == "POST":
			writes++
			if deny {
				w.WriteHeader(403)
				return
			}
			var body struct {
				Username    string `json:"username"`
				FullName    string `json:"full_name"`
				Description string `json:"description"`
				Visibility  string `json:"visibility"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			row = forgeOrganization{ID: 9007199254740997, Name: body.Username, FullName: body.FullName, Description: body.Description, Visibility: body.Visibility}
			if revoke != nil {
				revoke()
				revoke = nil
			}
			if lost {
				w.WriteHeader(500)
				return
			}
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(row)
		case strings.HasPrefix(r.URL.Path, "/api/v1/orgs/"):
			json.NewEncoder(w).Encode(row)
		case strings.HasSuffix(r.URL.Path, "/permissions"):
			json.NewEncoder(w).Encode(map[string]bool{"is_owner": true})
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	q := database.New(db)
	if err = q.EnsureOrganizationCreationPolicy(t.Context(), s.config.GiteaURL); err != nil {
		t.Fatal(err)
	}
	if _, err = q.UpdateOrganizationCreationPolicy(t.Context(), database.UpdateOrganizationCreationPolicyParams{ForgeURL: s.config.GiteaURL, Mode: "all_users", Revision: 0}); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "fixture"})
	createOrg := func(name string) (*connect.Response[golfv1.CreateOrganizationResponse], error) {
		req := connect.NewRequest(&golfv1.CreateOrganizationRequest{Username: name, FullName: "Developers", Description: "Fixture", Visibility: "private", ExpectedPolicyRevision: "1"})
		req.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
		return s.CreateOrganization(ctx, req)
	}
	mu.Lock()
	deny = true
	mu.Unlock()
	if _, err = createOrg("native-denied"); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 1 {
		t.Fatal("native permission ignored", err)
	}
	mu.Lock()
	deny = false
	lost = true
	mu.Unlock()
	if _, err = createOrg("lost-receipt"); connect.CodeOf(err) != connect.CodeUnavailable || writes != 2 {
		t.Fatal("lost POST retried or success", err)
	}
	mu.Lock()
	lost = false
	mu.Unlock()
	created, err := createOrg("qualified-org")
	if err != nil || created.Msg.Organization.Id != strconv.FormatInt(row.ID, 10) || writes != 3 {
		t.Fatal("native receipt/readback", err)
	}
	revoke = func() {
		if _, err := q.UpdateOrganizationCreationPolicy(t.Context(), database.UpdateOrganizationCreationPolicyParams{ForgeURL: s.config.GiteaURL, Mode: "administrators_only", Revision: 1}); err != nil {
			t.Error(err)
		}
	}
	if _, err = createOrg("revoked-after-dispatch"); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 4 {
		t.Fatal("late policy revoke ignored", err)
	}
	if _, err = createOrg("denied-new-call"); connect.CodeOf(err) != connect.CodePermissionDenied || writes != 4 {
		t.Fatal("revoked policy dispatched", err)
	}
}

func TestOrganizationCreationBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GetOrganizationCreationPolicy", "UpdateOrganizationCreationPolicy", "CreateOrganization"} {
		path := "/golf.v1.OrganizationCreationService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			req := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			s.ServeHTTP(response, req)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if response.Code != want || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("predecode boundary", method, response.Code)
			}
		}
		if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); response.Code != 403 {
			t.Fatal("bearer reached organization creation", method, response.Code)
		}
	}
}
