package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func assigneeInventoryInput() *golfv1.ListRepositoryAssigneesRequest {
	return &golfv1.ListRepositoryAssigneesRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10"}
}
func TestRepositoryAssigneeInventoryPostgres(t *testing.T) {
	f := newAssigneesFixture(t)
	client, _ := f.client(t, "alice")
	req := assigneeInventoryInput()
	out, err := client.ListRepositoryAssignees(t.Context(), connect.NewRequest(req))
	if err != nil || len(out.Msg.Assignees) != 2 || !out.Msg.CanEditAssignees || out.Msg.Assignees[1].Id != "43" {
		t.Fatal("native inventory mismatch", err, out)
	}
	f.admin = false
	read, err := client.ListRepositoryAssignees(t.Context(), connect.NewRequest(req))
	if err != nil || read.Msg.CanEditAssignees {
		t.Fatal("author/read admitted", err)
	}
}
func TestRepositoryAssigneeInventoryDenialsPostgres(t *testing.T) {
	for _, mode := range []string{"replacement", "duplicate-id", "duplicate-login", "bad-login", "bad-name", "overflow", "null-list", "admin-during-list", "forbidden", "revoked-during-list", "empty", "limit", "huge-id"} {
		t.Run(mode, func(t *testing.T) {
			f := newAssigneesFixture(t)
			client, source := f.client(t, "alice")
			f.source = source.Value
			req := assigneeInventoryInput()
			f.mode = mode
			switch mode {
			case "replacement":
				req.RepositoryId = "11"
			case "duplicate-id":
				f.candidates[1].ID = f.candidates[0].ID
			case "duplicate-login":
				f.candidates[1].Login = "ALICE"
			case "bad-login":
				f.candidates[0].Login = "../private"
			case "bad-name":
				f.candidates[0].FullName = "bad\x00name"
			case "forbidden":
				f.readStatus.Store(403)
			case "empty":
				f.candidates = []User{}
			case "limit", "overflow":
				f.candidates = nil
				count := 1000
				if mode == "overflow" {
					count++
				}
				for i := 1; i <= count; i++ {
					f.candidates = append(f.candidates, User{ID: int64(i), Login: fmt.Sprint("user", i)})
				}
			case "huge-id":
				f.candidates[0].ID = 9223372036854775807
			}
			out, err := client.ListRepositoryAssignees(t.Context(), connect.NewRequest(req))
			if mode == "empty" || mode == "limit" || mode == "huge-id" {
				want := len(f.candidates)
				if err != nil || len(out.Msg.Assignees) != want || !out.Msg.CanEditAssignees {
					t.Fatal("valid complete inventory refused", err)
				}
				return
			}
			if err == nil {
				t.Fatal("malformed/denied inventory exposed", out)
			}
		})
	}
}
func TestRepositoryAssigneeBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/rpc"+golfv1connect.RepositoryServiceListRepositoryAssigneesProcedure, strings.NewReader("malformed"))
	request.Header.Set("Origin", s.config.PublicURL)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Connect-Protocol-Version", "1")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != 401 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("decoded before authority", response.Code)
	}
	if !apiReadProcedure(golfv1connect.RepositoryServiceListRepositoryAssigneesProcedure) {
		t.Fatal("inventory missing read allowlist")
	}
	response = apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), golfv1connect.RepositoryServiceUpdateIssueProcedure, "malformed")
	if response.Code != 403 {
		t.Fatal("API metadata write accepted", response.Code)
	}
}
func TestRepositoryAssigneeApiCredentialPostgres(t *testing.T) {
	f := newAssigneesFixture(t)
	_, source := f.client(t, "alice")
	credential := issueApiCredential(t, apiManagementClient(t, &managementFixture{s: f.s, db: f.db}, source), "assignees read", 0)
	raw, err := protojson.Marshal(assigneeInventoryInput())
	if err != nil {
		t.Fatal(err)
	}
	response := apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceListRepositoryAssigneesProcedure, string(raw))
	var out golfv1.ListRepositoryAssigneesResponse
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || protojson.Unmarshal(response.Body.Bytes(), &out) != nil || len(out.Assignees) != 2 || out.CanEditAssignees {
		t.Fatal("read-only inventory scope", response.Code)
	}
	response = apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceUpdateIssueProcedure, "malformed")
	if response.Code != 403 || f.patches.Load() != 0 {
		t.Fatal("API write reached native", response.Code)
	}
	if err := f.s.logoutSession(t.Context(), source.Value); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceListRepositoryAssigneesProcedure, string(raw))
	if response.Code != 401 || strings.Contains(response.Body.String(), "Alice") {
		t.Fatal("revoked source exposed private list", response.Code)
	}
}
