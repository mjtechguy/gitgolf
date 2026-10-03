package server

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Opt-in actual supported-native read proof. The credential envelope is created
// by a bounded disposable API/Git fixture harness, owner-only and always purged.
// Golf sessions exist only in testDatabase's disposable PostgreSQL schema.
func TestRepositoryInventoryNativeProof(t *testing.T) {
	path := os.Getenv("GOLF_INVENTORY_NATIVE_PROOF")
	if path == "" {
		t.Skip("requires bounded supported-native fixture envelope")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("native envelope unavailable")
	}
	var proof struct {
		URL, Owner, Repository, Token, Head string
		UserID, RepositoryID                int64
		Tags                                map[string]struct{ ID, CommitID string }
		Branches                            map[string]string
	}
	if json.Unmarshal(data, &proof) != nil || len(proof.Tags) <= 50 || len(proof.Branches) <= 50 || proof.RepositoryID <= 0 || proof.UserID <= 0 {
		t.Fatal("invalid bounded native proof")
	}
	config := testConfig(proof.URL)
	s, err := New(config, testDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: proof.UserID, Login: proof.Owner}, "pat", proof.Token, "")
	if err != nil {
		t.Fatal("native read session unavailable")
	}
	_, client, _, transport, origin := testRPCClients(t, s)
	transport.Jar.SetCookies(origin, []*http.Cookie{s.sessionCookie(session.Value, session.Expires, 3600)})
	key := &golfv1.RepositoryKey{Owner: proof.Owner, Name: proof.Repository}
	id := strconv.FormatInt(proof.RepositoryID, 10)
	for _, limit := range []uint32{1, 20, 100} {
		seen := map[string]bool{}
		for page := uint32(1); ; page++ {
			response, err := client.ListTags(t.Context(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: key, RepositoryId: id, Page: &golfv1.PageRequest{Page: page, Limit: limit}}))
			if err != nil {
				t.Fatal("supported native tags failed", err)
			}
			if response.Msg.RepositoryId != id || response.Msg.TotalCount == nil || *response.Msg.TotalCount != strconv.Itoa(len(proof.Tags)) || len(response.Msg.Tags) > int(limit) || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("native tag receipt/count invalid")
			}
			for _, row := range response.Msg.Tags {
				actual, ok := proof.Tags[row.Name]
				if !ok || seen[row.Name] || row.Id != actual.ID || row.CommitId != actual.CommitID {
					t.Fatal("native tag differs from independent supported Git objects")
				}
				seen[row.Name] = true
			}
			if response.Msg.Page.NextPage == 0 {
				break
			}
			if response.Msg.Page.NextPage != page+1 {
				t.Fatal("native continuation invalid")
			}
		}
		if len(seen) != len(proof.Tags) {
			t.Fatal("native tags truncated")
		}
	}
	branches, err := client.ListBranches(t.Context(), connect.NewRequest(&golfv1.ListBranchesRequest{Repository: key, RepositoryId: id, Page: &golfv1.PageRequest{Limit: 100}}))
	if err != nil || branches.Msg.TotalCount == nil || branches.Msg.GetTotalCount() != strconv.Itoa(len(proof.Branches)) || len(branches.Msg.Branches) != len(proof.Branches) || branches.Msg.Page.NextPage != 0 {
		t.Fatal("native clamped branch total/read failed", err)
	}
	for _, row := range branches.Msg.Branches {
		if proof.Branches[row.Name] != row.CommitId {
			t.Fatal("native branch differs from independent Git ref")
		}
	}
	latest, err := client.ListCommits(t.Context(), connect.NewRequest(&golfv1.ListCommitsRequest{Repository: key, RepositoryId: id, Ref: proof.Head, Page: &golfv1.PageRequest{Limit: 1}}))
	if err != nil || latest.Msg.RepositoryId != id || latest.Msg.CommitId != proof.Head || len(latest.Msg.Commits) != 1 || latest.Msg.Commits[0].Sha != proof.Head {
		t.Fatal("native exact latest commit receipt failed", err)
	}
	wrong, err := client.ListTags(t.Context(), connect.NewRequest(&golfv1.ListTagsRequest{Repository: key, RepositoryId: strconv.FormatInt(proof.RepositoryID+1, 10)}))
	if wrong != nil || connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("wrong native identity released tags")
	}
}
