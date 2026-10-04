package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type tagProofFixture struct {
	row            forgeRepositorySettings
	org            forgeOrganization
	users          map[string]User
	direct         map[string]bool
	permissions    map[string]string
	teams          []repositoryNativeTeam
	members        map[string]bool
	fault          string
	writes, probes atomic.Int64
	provider       *httptest.Server
}

func newTagProofFixture(t *testing.T, organization bool) *tagProofFixture {
	f := &tagProofFixture{row: settingsFixtureRow(), org: forgeOrganization{ID: 67, Name: "workshop", Visibility: "private"}, users: map[string]User{"alice": {ID: 42, Login: "alice"}, "direct": {ID: 43, Login: "direct"}, "teamuser": {ID: 9007199254740995, Login: "teamuser"}}, direct: map[string]bool{"direct": true}, permissions: map[string]string{"direct": "read"}, teams: []repositoryNativeTeam{}, members: map[string]bool{}}
	if organization {
		f.row.FullName = "workshop/example"
		f.row.Owner = &User{ID: 67, Login: "workshop"}
	}
	f.provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet {
			f.writes.Add(1)
			w.WriteHeader(405)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/v1")
		base := "/repos/" + f.row.Owner.Login + "/example"
		switch {
		case path == base:
			json.NewEncoder(w).Encode(f.row)
		case strings.HasPrefix(path, "/users/"):
			name := strings.TrimPrefix(path, "/users/")
			user, ok := f.users[name]
			if !ok {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(user)
		case strings.HasPrefix(path, base+"/collaborators/"):
			name := strings.TrimPrefix(path, base+"/collaborators/")
			if strings.HasSuffix(name, "/permission") {
				name = strings.TrimSuffix(name, "/permission")
				json.NewEncoder(w).Encode(map[string]any{"permission": f.permissions[name], "user": f.users[name]})
				return
			}
			if !f.direct[name] {
				w.WriteHeader(404)
				return
			}
			w.WriteHeader(204)
		case path == "/orgs/workshop":
			json.NewEncoder(w).Encode(f.org)
		case path == base+"/teams":
			if f.fault == "partial" {
				w.Header().Set("Link", "</next>; rel=\"next\"")
			}
			if f.fault == "count" {
				w.Header().Set("X-Total-Count", "99")
			}
			if f.fault == "null" {
				w.Write([]byte("null"))
				return
			}
			if f.fault == "denied" {
				w.WriteHeader(403)
				return
			}
			if f.fault == "timeout" {
				<-r.Context().Done()
				return
			}
			json.NewEncoder(w).Encode(f.teams)
		case strings.HasPrefix(path, "/teams/"):
			parts := strings.Split(strings.TrimPrefix(path, "/teams/"), "/")
			id, _ := strconv.ParseInt(parts[0], 10, 64)
			for _, team := range f.teams {
				if team.ID != id {
					continue
				}
				if len(parts) == 3 && parts[1] == "members" {
					f.probes.Add(1)
					if !f.members[parts[0]+"/"+parts[2]] {
						w.WriteHeader(404)
						return
					}
					member := f.users[parts[2]]
					if f.fault == "wrong-member" {
						member.ID++
					}
					json.NewEncoder(w).Encode(member)
					return
				}
				if len(parts) != 1 {
					break
				}
				full := team.forgeOrganizationTeam
				full.Organization = &f.org
				if f.fault == "replaced-team" {
					full.ID++
				}
				if f.fault == "team-unit-drift" {
					full.UnitPermissions = map[string]string{"repo.issues": "write"}
				}
				json.NewEncoder(w).Encode(full)
				return
			}
			w.WriteHeader(404)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.provider.Close)
	return f
}
func (f *tagProofFixture) team(id int64, name, unit string) {
	f.teams = append(f.teams, repositoryNativeTeam{forgeOrganizationTeam{ID: id, Name: name, Permission: "none", UnitPermissions: map[string]string{unit: "read"}, Visibility: "private"}})
}
func (f *tagProofFixture) proof(ctx context.Context, users, teams []string) (string, error) {
	s := &Server{config: testConfig(f.provider.URL), client: f.provider.Client()}
	m := &golfv1.MutateRepositoryRulesRequest{RepositoryId: strconv.FormatInt(f.row.ID, 10), OwnerId: strconv.FormatInt(f.row.Owner.ID, 10), DesiredTag: &golfv1.RepositoryTagProtection{AllowedUsernames: users, AllowedTeams: teams}}
	return s.tagAllowlistProof(ctx, forgeCredential{Kind: "pat", Token: "source-only"}, repositoryKey{f.row.Owner.Login, "example"}, m, f.row.Owner.ID == 67)
}
func TestTagAllowlistPositivePreflight(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		organization, private   bool
		users, teams            []string
		permission, unit, fault string
		member, want            bool
	}{
		{name: "actual personal owner", users: []string{"alice"}, want: true},
		{name: "private direct read", private: true, users: []string{"direct"}, permission: "read", want: true},
		{name: "public direct read omitted", users: []string{"direct"}, permission: "read"},
		{name: "public native-admin direct read remains unproved", users: []string{"direct"}, permission: "owner"},
		{name: "private native-admin explicit direct read retained", private: true, users: []string{"direct"}, permission: "owner", want: true},
		{name: "public direct write", users: []string{"direct"}, permission: "write", want: true},
		{name: "private organization explicit direct read", organization: true, private: true, users: []string{"direct"}, permission: "read", want: true},
		{name: "public organization direct read insufficient", organization: true, users: []string{"direct"}, permission: "read"},
		{name: "public organization direct read via eligible team", organization: true, users: []string{"direct"}, permission: "read", unit: "repo.code", member: true, want: true},
		{name: "unknown user", users: []string{"absent"}},
		{name: "exact spelling", users: []string{"Alice"}},
		{name: "unsafe name", users: []string{"direct/permission"}},
		{name: "code-only team member", organization: true, users: []string{"teamuser"}, unit: "repo.code", member: true, want: true},
		{name: "pull-only team member", organization: true, users: []string{"teamuser"}, unit: "repo.pulls", member: true, want: true},
		{name: "issue-only inherited permission insufficient", organization: true, users: []string{"teamuser"}, unit: "repo.issues", member: true},
		{name: "eligible nonmember", organization: true, users: []string{"teamuser"}, unit: "repo.code"},
		{name: "exact attached team", organization: true, teams: []string{"Readers"}, unit: "repo.code", want: true},
		{name: "unattached team", organization: true, teams: []string{"Other"}, unit: "repo.code"},
		{name: "team exact spelling", organization: true, teams: []string{"readers"}, unit: "repo.code"},
		{name: "issue-only selected team", organization: true, teams: []string{"Readers"}, unit: "repo.issues"},
		{name: "personal teams", teams: []string{"Readers"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTagProofFixture(t, tc.organization)
			f.row.Private = tc.private
			if tc.permission != "" {
				f.permissions["direct"] = tc.permission
			}
			if tc.unit != "" {
				f.team(100, "Readers", tc.unit)
			}
			f.members["100/teamuser"] = tc.member
			f.members["100/direct"] = tc.member
			// Wrong-case native lookup still returns its actual canonical spelling.
			f.users["Alice"] = f.users["alice"]
			value, err := f.proof(t.Context(), tc.users, tc.teams)
			if tc.want {
				if err != nil || !validAccessRevision(value) {
					t.Fatal("positive exact tag proof", err)
				}
			} else if !errors.Is(err, errTagAllowlistUnsupported) {
				t.Fatal("selection must be refused", err)
			}
			if f.writes.Load() != 0 {
				t.Fatal("proof attempted native mutation")
			}
		})
	}
}
func TestTagAllowlistProofRefusesIncompleteOrLostNativeEvidence(t *testing.T) {
	for _, fault := range []string{"partial", "count", "null", "denied", "wrong-member", "replaced-team", "team-unit-drift"} {
		t.Run(fault, func(t *testing.T) {
			f := newTagProofFixture(t, true)
			f.team(100, "Readers", "repo.code")
			f.members["100/teamuser"] = true
			f.fault = fault
			if _, err := f.proof(t.Context(), []string{"teamuser"}, nil); err == nil || errors.Is(err, errTagAllowlistUnsupported) {
				t.Fatal("incomplete/malformed/denied proof cannot become absence", err)
			}
			if f.writes.Load() != 0 {
				t.Fatal("unexpected write")
			}
		})
	}
	for _, fault := range []string{"duplicate ID", "duplicate folded name", "missing units"} {
		t.Run(fault, func(t *testing.T) {
			f := newTagProofFixture(t, true)
			f.team(100, "Readers", "repo.code")
			f.team(101, "Other", "repo.code")
			switch fault {
			case "duplicate ID":
				f.teams[1].ID = 100
			case "duplicate folded name":
				f.teams[1].Name = "readers"
			case "missing units":
				f.teams[0].UnitPermissions = nil
			}
			if _, err := f.proof(t.Context(), nil, []string{"Readers"}); err == nil || errors.Is(err, errTagAllowlistUnsupported) {
				t.Fatal("malformed whole inventory admitted", err)
			}
			if f.writes.Load() != 0 {
				t.Fatal("unexpected write")
			}
		})
	}
	t.Run("team inventory cap", func(t *testing.T) {
		f := newTagProofFixture(t, true)
		for i := int64(1); i <= 501; i++ {
			f.team(i, "team"+strconv.FormatInt(i, 10), "repo.code")
		}
		if _, e := f.proof(t.Context(), nil, []string{"team1"}); !errors.Is(e, errForgeResponseTooLarge) {
			t.Fatal("bounded inventory", e)
		}
		if f.probes.Load() != 0 {
			t.Fatal("overbound inventory read members")
		}
	})
	t.Run("member probe cap", func(t *testing.T) {
		f := newTagProofFixture(t, true)
		for i := int64(1); i <= 500; i++ {
			f.team(i, "team"+strconv.FormatInt(i, 10), "repo.code")
		}
		f.members["500/teamuser"] = true
		f.users["another"] = User{ID: 111, Login: "another"}
		if _, e := f.proof(t.Context(), []string{"teamuser", "another"}, nil); !errors.Is(e, errForgeResponseTooLarge) {
			t.Fatal("bounded membership probes", e)
		}
		if f.probes.Load() != 500 {
			t.Fatal("probe cap exceeded")
		}
	})
	t.Run("deadline", func(t *testing.T) {
		f := newTagProofFixture(t, true)
		f.fault = "timeout"
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
		defer cancel()
		if _, e := f.proof(ctx, nil, []string{"Readers"}); e == nil {
			t.Fatal("deadline treated as absence")
		}
	})
}
func TestTagAllowlistProofIdentityAndEligibilityReobservation(t *testing.T) {
	for _, change := range []string{"account ID", "team ID", "membership loss", "direct read loss", "public visibility", "team unit loss"} {
		t.Run(change, func(t *testing.T) {
			f := newTagProofFixture(t, true)
			f.team(100, "Readers", "repo.code")
			f.members["100/teamuser"] = true
			users := []string{"teamuser"}
			if change == "direct read loss" || change == "public visibility" {
				users = []string{"direct"}
				f.row.Private = true
			}
			original, err := f.proof(t.Context(), users, nil)
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "account ID":
				user := f.users["teamuser"]
				user.ID++
				f.users["teamuser"] = user
			case "team ID":
				f.teams[0].ID++
				f.members["101/teamuser"] = true
			case "membership loss":
				f.members["100/teamuser"] = false
			case "direct read loss":
				f.direct["direct"] = false
			case "public visibility":
				f.row.Private = false
			case "team unit loss":
				f.teams[0].UnitPermissions = map[string]string{"repo.issues": "read"}
			}
			current, err := f.proof(t.Context(), users, nil)
			if err == nil && current == original {
				t.Fatal("old positive identity survived changed evidence")
			}
			if f.writes.Load() != 0 {
				t.Fatal("unexpected write")
			}
		})
	}
}
