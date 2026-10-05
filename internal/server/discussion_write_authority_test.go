package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDiscussionWriteAuthority(t *testing.T) {
	for _, tc := range []struct {
		name                                string
		org, direct, member, pull, archived bool
		permission, issueGrant, pullGrant   string
		want                                bool
	}{
		{name: "personal-writer", permission: "write", want: true},
		{name: "personal-reader", permission: "read"},
		{name: "missing-owner", permission: "write"},
		{name: "org-direct-writer", org: true, direct: true, permission: "write", want: true},
		{name: "code-only-team", org: true, member: true, permission: "write", issueGrant: "read", pullGrant: "read"},
		{name: "issue-team-writer", org: true, member: true, permission: "write", issueGrant: "write", pullGrant: "read", want: true},
		{name: "issue-team-not-member", org: true, permission: "write", issueGrant: "write"},
		{name: "issue-team-not-pull-writer", org: true, member: true, pull: true, permission: "write", issueGrant: "write", pullGrant: "read"},
		{name: "pull-team-writer", org: true, member: true, pull: true, permission: "write", issueGrant: "read", pullGrant: "write", want: true},
		{name: "archived-writer", permission: "write", archived: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			owner, caller := User{ID: 7, Login: "club"}, User{ID: 8, Login: "bob"}
			org := forgeOrganization{ID: 7, Name: "club", Visibility: "public"}
			team := forgeOrganizationTeam{ID: 10, Name: "developers", Permission: "write", Visibility: "public", Organization: &org, UnitPermissions: map[string]string{"repo.code": "write", "repo.issues": tc.issueGrant, "repo.pulls": tc.pullGrant}}
			if team.UnitPermissions["repo.issues"] == "" {
				team.UnitPermissions["repo.issues"] = "read"
			}
			if team.UnitPermissions["repo.pulls"] == "" {
				team.UnitPermissions["repo.pulls"] = "read"
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
				switch r.URL.Path {
				case "/api/v1/repos/club/project":
					write(map[string]any{"id": 11, "name": "project", "full_name": "club/project", "owner": func() any {
						if tc.name == "missing-owner" {
							return nil
						}
						return owner
					}(), "permissions": map[string]bool{"admin": false, "push": true}, "archived": tc.archived, "has_issues": true, "has_pull_requests": true})
				case "/api/v1/user":
					write(caller)
				case "/api/v1/users/search":
					if tc.org {
						write(map[string]any{"ok": true, "data": []User{}})
					} else {
						write(map[string]any{"ok": true, "data": []User{owner}})
					}
				case "/api/v1/orgs/club":
					write(org)
				case "/api/v1/repos/club/project/collaborators/bob/permission":
					write(map[string]any{"permission": tc.permission, "user": caller})
				case "/api/v1/repos/club/project/collaborators/bob":
					if tc.direct {
						w.WriteHeader(204)
					} else {
						w.WriteHeader(404)
					}
				case "/api/v1/repos/club/project/teams":
					write([]forgeOrganizationTeam{team})
				case "/api/v1/teams/10":
					write(team)
				case "/api/v1/teams/10/members/bob":
					if tc.member {
						write(caller)
					} else {
						w.WriteHeader(404)
					}
				default:
					t.Errorf("unexpected native authority read %s", r.URL)
					w.WriteHeader(404)
				}
			}))
			defer provider.Close()
			s, err := New(testConfig(provider.URL), nil)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.WithValue(t.Context(), pullDiscussionKey{}, tc.pull)
			allowed, err := s.milestoneEditAuthority(ctx, forgeCredential{Kind: "pat", Token: "fixture"}, "/repos/club/project", Repository{ID: 11, Name: "project", FullName: "club/project"})
			if err != nil || allowed != tc.want {
				t.Fatalf("unit authority got %v,%v; want %v", allowed, err, tc.want)
			}
		})
	}
}
