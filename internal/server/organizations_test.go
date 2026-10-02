package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

var organizationProcedures = []string{
	golfv1connect.OrganizationServiceListOrganizationsProcedure,
	golfv1connect.OrganizationServiceGetOrganizationProcedure,
	golfv1connect.OrganizationServiceListTeamsProcedure,
	golfv1connect.OrganizationServiceGetTeamProcedure,
	golfv1connect.OrganizationServiceListTeamMembersProcedure,
	golfv1connect.OrganizationServiceListTeamRepositoriesProcedure,
}

func TestOrganizationBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range organizationProcedures {
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			r := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed"))
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
				t.Fatalf("%s decoded before authorization or lost no-store: %d", procedure, w.Code)
			}
		}
	}
}

type organizationFixture struct {
	s               *Server
	db              *sql.DB
	mode            atomic.Value
	metadataCalls   atomic.Int32
	membershipCalls atomic.Int32
	entered         chan struct{}
	resume          chan struct{}
}

func newOrganizationFixture(t *testing.T) *organizationFixture {
	t.Helper()
	f := &organizationFixture{db: testDatabase(t), entered: make(chan struct{}, 1), resume: make(chan struct{})}
	f.mode.Store("")
	provider := httptest.NewServer(http.HandlerFunc(f.serveProvider))
	t.Cleanup(provider.Close)
	t.Cleanup(func() { close(f.resume) })
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *organizationFixture) serveProvider(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/api/v1/version" {
		fmt.Fprint(w, `{"version":"1.27.3"}`)
		return
	}
	if r.Header.Get("Authorization") != "token organization-pat" && r.Header.Get("Authorization") != "Bearer organization-oauth" {
		w.WriteHeader(401)
		return
	}
	mode := f.mode.Load().(string)
	if mode == "revoked" {
		w.WriteHeader(401)
		return
	}
	if mode == "missing-scope" && r.URL.Path != "/api/v1/user" {
		w.WriteHeader(403)
		return
	}
	org := forgeOrganization{ID: 100, Name: "workshop", FullName: "Workshop", Description: "Private work", Visibility: "private"}
	team := forgeOrganizationTeam{ID: 200, Name: "Code writers", Description: "Native unit grants", Permission: "none", Visibility: "limited", UnitPermissions: map[string]string{"repo.code": "write", "repo.issues": "read"}, Organization: &org}
	write := func(value any) { _ = json.NewEncoder(w).Encode(value) }
	wait := func() {
		f.entered <- struct{}{}
		select {
		case <-f.resume:
		case <-r.Context().Done():
		}
	}
	switch r.URL.Path {
	case "/api/v1/user":
		if mode == "wait-user" {
			wait()
		}
		user := User{ID: 42, Login: "alice"}
		if mode == "wrong-identity" {
			user.ID = 43
		}
		write(user)
	case "/api/v1/user/orgs":
		if mode == "wait-list" {
			wait()
		}
		switch mode {
		case "too-many":
			write([]forgeOrganization{org, org})
			return
		case "duplicate":
			write([]forgeOrganization{org, org})
			return
		case "unknown-org-visibility":
			org.Visibility = "future"
		case "malformed":
			fmt.Fprint(w, `[{`)
			return
		case "oversized":
			fmt.Fprint(w, strings.Repeat(" ", 2<<20)+"[]")
			return
		case "null-list":
			fmt.Fprint(w, "null")
			return
		}
		if r.URL.Query().Get("page") != "2" {
			w.Header().Set("Link", `<https://untrusted.invalid/?page=2>; rel="next"`)
		}
		write([]forgeOrganization{org})
	case "/api/v1/orgs/workshop/members/alice":
		calls := f.membershipCalls.Add(1)
		switch mode {
		case "nonmember":
			w.WriteHeader(404)
		case "membership-removed":
			if calls%2 == 0 {
				w.WriteHeader(404)
			} else {
				w.WriteHeader(204)
			}
		case "membership-200":
			w.WriteHeader(200)
		case "membership-redirect":
			w.Header().Set("Location", "/api/v1/orgs/workshop")
			w.WriteHeader(302)
		default:
			w.WriteHeader(204)
		}
	case "/api/v1/orgs/workshop":
		f.metadataCalls.Add(1)
		if mode == "wrong-org-name" {
			org.Name = "elsewhere"
		}
		write(org)
	case "/api/v1/orgs/workshop/teams":
		team.Organization = nil // Native collection does not embed its organization.
		if mode == "unknown-unit" {
			team.UnitPermissions["repo.future"] = "read"
		}
		if mode == "unknown-permission" {
			team.UnitPermissions["repo.code"] = "superuser"
		}
		if mode == "unknown-team-visibility" {
			team.Visibility = "future"
		}
		write([]forgeOrganizationTeam{team})
	case "/api/v1/teams/200":
		if mode == "private-team" {
			w.WriteHeader(404)
			return
		}
		if mode == "foreign-team" {
			team.Organization = &forgeOrganization{ID: 101, Name: "elsewhere", Visibility: "public"}
		}
		if mode == "missing-team-org" {
			team.Organization = nil
		}
		if mode == "wrong-team-id" {
			team.ID = 201
		}
		write(team)
	case "/api/v1/teams/200/members":
		fmt.Fprint(w, `[{"id":42,"login":"alice","full_name":"Alice","email":"private@example.invalid","is_admin":true}]`)
	case "/api/v1/teams/200/repos":
		if r.URL.Query().Get("page") == "1" {
			w.Header().Set("Link", `</api/v1/teams/200/repos?page=2>; rel="next"`)
			fmt.Fprint(w, `[]`)
			return
		}
		write([]Repository{{ID: 300, Name: "compiler", FullName: "workshop/compiler", Private: true}})
	default:
		w.WriteHeader(404)
	}
}

func (f *organizationFixture) session(t *testing.T, kind string) loginResult {
	t.Helper()
	payload := "organization-pat"
	if kind == "oauth" {
		payload = encodeOAuth(oauthEnvelope{Version: 1, AccessToken: "organization-oauth", RefreshToken: "fixture-refresh", Expiry: time.Now().Add(time.Hour), Verified: true})
	}
	result, err := f.s.createSession(context.Background(), User{ID: 42, Login: "alice"}, kind, payload, "")
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *organizationFixture) client(t *testing.T, session loginResult) golfv1connect.OrganizationServiceClient {
	t.Helper()
	_, _, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return golfv1connect.NewOrganizationServiceClient(transport, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
			request.Header().Set("Origin", f.s.config.PublicURL)
			return next(ctx, request)
		}
	})))
}

func TestOrganizationRPCPostgres(t *testing.T) {
	f := newOrganizationFixture(t)
	ctx := context.Background()
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			client := f.client(t, f.session(t, kind))
			listed, err := client.ListOrganizations(ctx, connect.NewRequest(&golfv1.ListOrganizationsRequest{Page: &golfv1.PageRequest{Limit: 1}}))
			if err != nil || len(listed.Msg.Organizations) != 1 || listed.Msg.Page.NextPage != 2 || listed.Msg.Organizations[0].Visibility != golfv1.OrganizationVisibility_ORGANIZATION_VISIBILITY_PRIVATE {
				t.Fatal("own organizations and pagination", err)
			}
			if listed.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("private organization metadata was cacheable")
			}
			got, err := client.GetOrganization(ctx, connect.NewRequest(&golfv1.GetOrganizationRequest{Organization: "workshop"}))
			if err != nil || got.Msg.Organization.Id != "100" {
				t.Fatal("organization", err)
			}
			teams, err := client.ListTeams(ctx, connect.NewRequest(&golfv1.ListTeamsRequest{Organization: "workshop"}))
			if err != nil || len(teams.Msg.Teams) != 1 {
				t.Fatal("teams", err)
			}
			team := teams.Msg.Teams[0]
			if team.Permission != golfv1.TeamPermission_TEAM_PERMISSION_NONE || team.UnitPermissions["repo.code"] != golfv1.TeamPermission_TEAM_PERMISSION_WRITE || team.Visibility != golfv1.TeamVisibility_TEAM_VISIBILITY_LIMITED {
				t.Fatal("native unit permissions must not be flattened into a Golf role")
			}
			detail, err := client.GetTeam(ctx, connect.NewRequest(&golfv1.GetTeamRequest{Organization: "workshop", TeamId: "200"}))
			if err != nil || detail.Msg.Team.Id != team.Id {
				t.Fatal("team binding", err)
			}
			members, err := client.ListTeamMembers(ctx, connect.NewRequest(&golfv1.ListTeamMembersRequest{Organization: "workshop", TeamId: "200"}))
			if err != nil || len(members.Msg.Members) != 1 || members.Msg.Members[0].Id != "42" {
				t.Fatal("team members", err)
			}
			raw, err := protojson.Marshal(members.Msg)
			if err != nil || strings.Contains(string(raw), "private@example") || strings.Contains(string(raw), "admin") {
				t.Fatal("uncontracted provider identity fields escaped")
			}
			repositories, err := client.ListTeamRepositories(ctx, connect.NewRequest(&golfv1.ListTeamRepositoriesRequest{Organization: "workshop", TeamId: "200", Page: &golfv1.PageRequest{Limit: 1}}))
			if err != nil || len(repositories.Msg.Repositories) != 0 || repositories.Msg.Page.NextPage != 2 {
				t.Fatal("empty filtered page must retain native next page", err)
			}
			repositories, err = client.ListTeamRepositories(ctx, connect.NewRequest(&golfv1.ListTeamRepositoriesRequest{Organization: "workshop", TeamId: "200", Page: &golfv1.PageRequest{Page: 2, Limit: 1}}))
			if err != nil || len(repositories.Msg.Repositories) != 1 || !repositories.Msg.Repositories[0].Private || repositories.Msg.Page.NextPage != 0 {
				t.Fatal("accessible repository on later page", err)
			}
		})
	}
}

func TestOrganizationDenialAndProviderContractPostgres(t *testing.T) {
	f := newOrganizationFixture(t)
	client := f.client(t, f.session(t, "pat"))
	ctx := context.Background()
	for _, check := range []struct {
		mode, method string
		code         connect.Code
	}{
		{"nonmember", "org", connect.CodeNotFound},
		{"membership-removed", "org", connect.CodeNotFound},
		{"membership-200", "org", connect.CodeUnavailable},
		{"membership-redirect", "org", connect.CodeUnavailable},
		{"wrong-org-name", "org", connect.CodeUnavailable},
		{"wrong-identity", "org", connect.CodeUnauthenticated},
		{"revoked", "list", connect.CodeUnauthenticated},
		{"missing-scope", "list", connect.CodePermissionDenied},
		{"private-team", "team", connect.CodeNotFound},
		{"foreign-team", "team", connect.CodeNotFound},
		{"missing-team-org", "team", connect.CodeUnavailable},
		{"wrong-team-id", "team", connect.CodeUnavailable},
		{"unknown-unit", "teams", connect.CodeUnavailable},
		{"unknown-permission", "teams", connect.CodeUnavailable},
		{"unknown-team-visibility", "teams", connect.CodeUnavailable},
		{"unknown-org-visibility", "list", connect.CodeUnavailable},
		{"too-many", "limit", connect.CodeResourceExhausted},
		{"duplicate", "list", connect.CodeUnavailable},
		{"malformed", "list", connect.CodeUnavailable},
		{"oversized", "list", connect.CodeResourceExhausted},
	} {
		t.Run(check.mode, func(t *testing.T) {
			f.mode.Store(check.mode)
			f.membershipCalls.Store(0)
			f.metadataCalls.Store(0)
			var err error
			switch check.method {
			case "org":
				_, err = client.GetOrganization(ctx, connect.NewRequest(&golfv1.GetOrganizationRequest{Organization: "workshop"}))
			case "team":
				_, err = client.GetTeam(ctx, connect.NewRequest(&golfv1.GetTeamRequest{Organization: "workshop", TeamId: "200"}))
			case "teams":
				_, err = client.ListTeams(ctx, connect.NewRequest(&golfv1.ListTeamsRequest{Organization: "workshop"}))
			default:
				request := &golfv1.ListOrganizationsRequest{}
				if check.method == "limit" {
					request.Page = &golfv1.PageRequest{Limit: 1}
				}
				_, err = client.ListOrganizations(ctx, connect.NewRequest(request))
			}
			if connect.CodeOf(err) != check.code {
				t.Fatalf("got %v; want %v", err, check.code)
			}
			if (check.mode == "nonmember" || check.mode == "membership-redirect" || check.mode == "wrong-identity") && f.metadataCalls.Load() != 0 {
				t.Fatal("metadata fetched without membership or immutable identity")
			}
		})
	}
	f.mode.Store("")
	for _, id := range []string{"0", "-1", "+200", "0200", "200/../201", "9223372036854775808"} {
		_, err := client.GetTeam(ctx, connect.NewRequest(&golfv1.GetTeamRequest{Organization: "workshop", TeamId: id}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("noncanonical team ID accepted", id, err)
		}
	}
	for _, name := range []string{"..", "workshop/other", "workshop?x=1", ""} {
		_, err := client.GetOrganization(ctx, connect.NewRequest(&golfv1.GetOrganizationRequest{Organization: name}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid organization accepted", err)
		}
	}
	for _, page := range []uint32{10000, 10001} {
		_, err := client.ListOrganizations(ctx, connect.NewRequest(&golfv1.ListOrganizationsRequest{Page: &golfv1.PageRequest{Page: page}}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("pagination limit silently appeared complete", err)
		}
	}
}

func TestOrganizationSessionWaitPostgres(t *testing.T) {
	for _, check := range []struct {
		wait   string
		revoke bool
	}{{"wait-user", false}, {"wait-list", false}, {"wait-list", true}} {
		t.Run(fmt.Sprintf("%s-revoke-%t", check.wait, check.revoke), func(t *testing.T) {
			f := newOrganizationFixture(t)
			session := f.session(t, "pat")
			client := f.client(t, session)
			f.mode.Store(check.wait)
			outcome := make(chan error, 1)
			go func() {
				_, err := client.ListOrganizations(context.Background(), connect.NewRequest(&golfv1.ListOrganizationsRequest{}))
				outcome <- err
			}()
			select {
			case <-f.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("provider did not reach wait")
			}
			hash, _ := sessionHash(session.Value)
			statement := "UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1"
			if check.revoke {
				statement = "DELETE FROM golf_sessions WHERE token_hash=$1"
			}
			if _, err := f.db.Exec(statement, hash); err != nil {
				t.Fatal(err)
			}
			f.resume <- struct{}{}
			select {
			case err := <-outcome:
				if connect.CodeOf(err) != connect.CodeUnauthenticated {
					t.Fatal("provider wait outlived revoked/expired session", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("request failed to settle")
			}
		})
	}
}
