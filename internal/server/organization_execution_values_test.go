package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func TestOrganizationExecutionSelectedIdentity(t *testing.T) {
	target := &golfv1.OrganizationExecutionValueTarget{Organization: "club", OrganizationId: "9007199254740993"}
	if got, e := parseOrganizationExecutionTarget(target); e != nil || got.id != 9007199254740993 {
		t.Fatal("full-width organization ID", e)
	}
	for _, bad := range []*golfv1.OrganizationExecutionValueTarget{nil, {Organization: "club", OrganizationId: "01"}, {Organization: "../club", OrganizationId: "73"}, {Organization: "club", OrganizationId: "9223372036854775808"}} {
		if _, e := parseOrganizationExecutionTarget(bad); e == nil {
			t.Fatal("invalid organization target admitted")
		}
	}
	first := &golfv1.OrganizationExecutionRepository{Repository: &golfv1.RepositoryKey{Owner: "club", Name: "one"}, RepositoryId: "9007199254740993"}
	second := &golfv1.OrganizationExecutionRepository{Repository: &golfv1.RepositoryKey{Owner: "club", Name: "two"}, RepositoryId: "74"}
	selected, e := organizationExecutionSelections([]*golfv1.OrganizationExecutionRepository{first, second}, "club")
	if e != nil || selected[0].ID != first.RepositoryId || selected[1].ID != second.RepositoryId {
		t.Fatal("original selected order/identity changed", e)
	}
	if empty, e := organizationExecutionSelections(nil, "club"); e != nil || empty == nil {
		t.Fatal("empty policy must be explicit array", e)
	}
	duplicateRoute := proto.Clone(second).(*golfv1.OrganizationExecutionRepository)
	duplicateRoute.Repository.Name = "ONE"
	for _, bad := range [][]*golfv1.OrganizationExecutionRepository{{nil}, {first, first}, {first, duplicateRoute}, {{Repository: &golfv1.RepositoryKey{Owner: "other", Name: "one"}, RepositoryId: "73"}}, {{Repository: first.Repository, RepositoryId: "073"}}, make([]*golfv1.OrganizationExecutionRepository, 21)} {
		if _, e = organizationExecutionSelections(bad, "club"); e == nil {
			t.Fatal("foreign/duplicate/unbounded selected identity accepted")
		}
	}
}
func TestOrganizationExecutionCipherIdentity(t *testing.T) {
	keys, e := ParseKeyring(base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))), "", "")
	if e != nil {
		t.Fatal(e)
	}
	r := organizationExecutionRecord{id: "2d40f2fd-c269-4acb-85ad-7acf4d71daaa", name: "BUILD_CREDENTIAL", kind: "secret", version: 1, size: 12, selected: []organizationExecutionSelection{{"club", "one", "73"}, {"club", "two", "74"}}, approver: 3, native: 42, session: bytes.Repeat([]byte{1}, 32), expires: time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)}
	forge := "https://native.example"
	org := int64(9007199254740993)
	r.binding = organizationExecutionBinding(r.id, 1, forge, org, r.name, r.kind, r.size, r.selected, r.approver, r.native, r.session, r.expires)
	r.cipher, r.key, e = keys.seal(organizationExecutionValueDomain, "private-test", r.binding)
	if e != nil {
		t.Fatal(e)
	}
	if plain, e := openOrganizationExecutionContent(keys, forge, org, 1, r); e != nil || plain != "private-test" {
		t.Fatal("bound org ciphertext unreadable", e)
	}
	for name, change := range map[string]func(*organizationExecutionRecord){
		"recipient ID":    func(v *organizationExecutionRecord) { v.selected[0].ID = "75" },
		"recipient order": func(v *organizationExecutionRecord) { slices.Reverse(v.selected) },
		"recipient route": func(v *organizationExecutionRecord) { v.selected[0].Name = "other" },
		"approver":        func(v *organizationExecutionRecord) { v.approver++ },
		"native owner":    func(v *organizationExecutionRecord) { v.native++ },
		"session":         func(v *organizationExecutionRecord) { v.session = bytes.Repeat([]byte{2}, 32) },
		"expiry":          func(v *organizationExecutionRecord) { v.expires = v.expires.Add(time.Minute) },
		"name":            func(v *organizationExecutionRecord) { v.name = "OTHER_CREDENTIAL" },
		"kind":            func(v *organizationExecutionRecord) { v.kind = "variable" },
		"size":            func(v *organizationExecutionRecord) { v.size++ },
	} {
		t.Run(name, func(t *testing.T) {
			bad := r
			bad.selected = slices.Clone(r.selected)
			change(&bad)
			if _, e := openOrganizationExecutionContent(keys, forge, org, 1, bad); !errors.Is(e, errCredentialUnavailable) {
				t.Fatal("cipher transplant accepted", e)
			}
		})
	}
	for _, change := range []struct {
		forge        string
		org, version int64
	}{{forge, org + 1, 1}, {forge, org, 2}, {"https://other.example", org, 1}} {
		if _, e := openOrganizationExecutionContent(keys, change.forge, change.org, change.version, r); !errors.Is(e, errCredentialUnavailable) {
			t.Fatal("wrong scope/version accepted")
		}
	}
	if _, e := keys.open(r.key, executionValueDomain, r.cipher, r.binding); e == nil {
		t.Fatal("org ciphertext accepted under repository domain")
	}
}
func TestOrganizationExecutionActualOwnerReadProof(t *testing.T) {
	for _, mode := range []string{"owner", "member", "missing owner", "wrong org", "nonmember", "changed caller"} {
		t.Run(mode, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					t.Fatal("owner proof mutated native state")
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/v1/user":
					id := int64(42)
					if mode == "changed caller" {
						id = 43
					}
					json.NewEncoder(w).Encode(User{ID: id, Login: "alice"})
				case "/api/v1/orgs/club/members/alice":
					if mode == "nonmember" {
						w.WriteHeader(404)
					} else {
						w.WriteHeader(204)
					}
				case "/api/v1/orgs/club":
					id := int64(73)
					if mode == "wrong org" {
						id = 74
					}
					json.NewEncoder(w).Encode(forgeOrganization{ID: id, Name: "club", Visibility: "private"})
				case "/api/v1/users/alice/orgs/club/permissions":
					if mode == "missing owner" {
						json.NewEncoder(w).Encode(map[string]bool{})
					} else {
						json.NewEncoder(w).Encode(map[string]bool{"is_owner": mode == "owner"})
					}
				default:
					w.WriteHeader(404)
				}
			}))
			defer provider.Close()
			s := &Server{config: testConfig(provider.URL), client: provider.Client()}
			e := s.checkOrganizationExecutionOwner(context.Background(), forgeCredential{Kind: "pat", Token: "source-only"}, organizationExecutionTarget{"club", 73}, User{ID: 42, Login: "alice"})
			if (mode == "owner") != (e == nil) {
				t.Fatal("actual-owner identity proof", mode, e)
			}
		})
	}
}
