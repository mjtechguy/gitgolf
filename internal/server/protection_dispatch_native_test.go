package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestProtectionUnknownNativeProof(t *testing.T) {
	path := os.Getenv("GOLF_PROTECTION_NATIVE_PROOF")
	if path == "" {
		t.Skip("owned native fixture not supplied")
	}
	stat, e := os.Lstat(path)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private owned fixture required")
	}
	file, e := os.Open(path)
	if e != nil {
		t.Fatal("owned fixture unavailable")
	}
	defer file.Close()
	var in struct{ URL, Username, Token string }
	d := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil || d.Decode(new(any)) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Username, "golf-policy-probe-") {
		t.Fatal("owned fixture invalid")
	}
	s, e := New(testConfig(in.URL), testDatabase(t))
	if e != nil {
		t.Fatal("policy server unavailable")
	}
	credential := forgeCredential{Kind: "pat", Token: in.Token}
	var repo Repository
	if _, e = s.forgeJSON(t.Context(), http.MethodPost, "/user/repos", credential, map[string]any{"name": "policy", "private": true, "auto_init": true}, &repo, http.StatusCreated); e != nil {
		t.Fatal("owned native repository setup")
	}
	key := &golfv1.RepositoryKey{Owner: in.Username, Name: "policy"}
	base, _ := repositoryPath(keyFrom(key))
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Username, Password: localTestPassword, ForgeToken: in.Token}); e != nil {
		t.Fatal("owned policy account enrollment")
	}
	session, _, _, transport, origin := testRPCClients(t, s)
	if _, e = session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Username, Password: localTestPassword})); e != nil {
		t.Fatal("owned policy sign-in")
	}
	t.Cleanup(func() {
		if _, e := session.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
			t.Error("owned policy logout")
		}
	})
	client := golfv1connect.NewRepositoryRulesServiceClient(transport, origin.String()+"/rpc")
	accessClient := golfv1connect.NewRepositoryAccessServiceClient(transport, origin.String()+"/rpc")
	accessReq := connect.NewRequest(&golfv1.GetRepositoryAccessRequest{Repository: key})
	accessReq.Header().Set("Origin", s.config.PublicURL)
	access, e := accessClient.GetRepositoryAccess(t.Context(), accessReq)
	if e != nil {
		t.Fatal("owned native access inventory", connect.CodeOf(e))
	}
	get := connect.NewRequest(&golfv1.GetRepositoryRulesRequest{Repository: key, RepositoryId: strconv.FormatInt(repo.ID, 10), OwnerId: access.Msg.Access.OwnerId, ExpectedRevision: access.Msg.Access.Revision})
	get.Header().Set("Origin", s.config.PublicURL)
	before, e := client.GetRepositoryRules(t.Context(), get)
	if e != nil {
		t.Fatal("owned native rule inventory", connect.CodeOf(e))
	}
	var writes atomic.Int32
	s.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, e := http.DefaultTransport.RoundTrip(r)
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writes.Add(1)
		}
		if e == nil && r.Method == http.MethodPost && r.URL.Path == "/api/v1"+base+"/branch_protections" && response.StatusCode == http.StatusCreated {
			response.Body.Close()
			response.StatusCode = http.StatusInternalServerError
			response.Body = io.NopCloser(strings.NewReader(""))
			response.ContentLength = 0
		}
		return response, e
	})
	m := &golfv1.MutateRepositoryRulesRequest{Repository: key, RepositoryId: strconv.FormatInt(repo.ID, 10), OwnerId: before.Msg.OwnerId, ExpectedAccessRevision: before.Msg.AccessRevision, ExpectedRulesRevision: before.Msg.RulesRevision, OperationId: uuid.NewString(), Action: golfv1.RepositoryRuleMutationAction_REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH, DesiredBranch: &golfv1.RepositoryBranchProtection{RuleName: "golf-fence/*", Priority: "0", RequiredApprovals: "1", BlockAdminMergeOverride: true}}
	request := connect.NewRequest(m)
	request.Header().Set("Origin", s.config.PublicURL)
	original, e := client.MutateRepositoryRules(t.Context(), request)
	if e != nil || original.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || writes.Load() != 1 {
		t.Fatal("accepted native response loss not retained")
	}
	read := connect.NewRequest(&golfv1.GetRepositoryRulesRequest{Repository: key, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, ExpectedRevision: m.ExpectedAccessRevision})
	read.Header().Set("Origin", s.config.PublicURL)
	observed, e := client.GetRepositoryRules(t.Context(), read)
	if e != nil || len(observed.Msg.BranchProtections) != 1 || observed.Msg.BranchProtections[0].RuleName != "golf-fence/*" {
		t.Fatal("independent actual native rule effect not observed")
	}
	for _, route := range []string{"/contents/blocked.txt", "/pulls/1/reviews", "/wiki/new-page"} {
		if _, e = s.forge(t.Context(), http.MethodPost, base+route, credential, map[string]string{"body": "Must never dispatch"}, nil); !errors.Is(e, errLifecycleBlocked) || writes.Load() != 1 {
			t.Fatal("accepted unknown policy did not fence native dispatch")
		}
	}
	replay := connect.NewRequest(m)
	replay.Header().Set("Origin", s.config.PublicURL)
	got, e := client.MutateRepositoryRules(t.Context(), replay)
	if e != nil || got.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || writes.Load() != 1 {
		t.Fatal("native original response-loss replay dispatched")
	}
	restarted, e := New(s.config, s.db)
	if e != nil {
		t.Fatal("policy restart")
	}
	if e = restarted.protectionDispatchAllowed(t.Context(), s.db, repo.ID); !errors.Is(e, errLifecycleBlocked) {
		t.Fatal("native uncertainty fence expired after restart")
	}
	t.Log("Actual native rule accepted once; discarded acknowledgement remains unknown, independent read observes effect, original replay/restart and later managed writes are fenced. Independent native ingress and protected publication remain unqualified.")
}
