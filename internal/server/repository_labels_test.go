package server

import (
	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func labelInventoryInput() *golfv1.ListRepositoryLabelsRequest {
	return &golfv1.ListRepositoryLabelsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "10", Page: &golfv1.PageRequest{Page: 1, Limit: 100}}
}
func TestRepositoryLabelInventoryPostgres(t *testing.T) {
	f := newLabelsFixture(t)
	client, _ := f.client(t, "alice")
	req := labelInventoryInput()
	first, err := client.ListRepositoryLabels(t.Context(), connect.NewRequest(req))
	if err != nil || len(first.Msg.Labels) != 50 || first.Msg.Page.NextPage != 2 || !first.Msg.CanEditLabels || first.Msg.Labels[0].Color != "abc123" {
		t.Fatal("native inventory/capability mismatch", err, first)
	}
	req.Page.Page = 2
	second, err := client.ListRepositoryLabels(t.Context(), connect.NewRequest(req))
	if err != nil || len(second.Msg.Labels) != 10 || second.Msg.Page.NextPage != 0 {
		t.Fatal("page completion mismatch", err, second)
	}
	f.admin = false
	req.Page.Page = 1
	read, err := client.ListRepositoryLabels(t.Context(), connect.NewRequest(req))
	if err != nil || read.Msg.CanEditLabels {
		t.Fatal("issue author/read wrongly admitted", err, read)
	}
}
func TestRepositoryLabelInventoryDenialsPostgres(t *testing.T) {
	for _, mode := range []string{"replacement", "duplicate", "color", "bad-total", "admin-during-list", "forbidden", "empty"} {
		t.Run(mode, func(t *testing.T) {
			f := newLabelsFixture(t)
			client, _ := f.client(t, "alice")
			req := labelInventoryInput()
			f.mode = mode
			switch mode {
			case "replacement":
				req.RepositoryId = "11"
			case "duplicate":
				f.rows[1].ID = f.rows[0].ID
			case "color":
				f.rows[0].Color = "var(--private)"
			case "forbidden":
				f.readStatus.Store(403)
			case "empty":
				f.rows = []forgeDiscussionLabel{}
			}
			out, err := client.ListRepositoryLabels(t.Context(), connect.NewRequest(req))
			if mode == "empty" {
				if err != nil || len(out.Msg.Labels) != 0 || out.Msg.Page.NextPage != 0 || !out.Msg.CanEditLabels {
					t.Fatal("explicit empty inventory rejected", err, out)
				}
				return
			}
			if err == nil {
				t.Fatal("invalid inventory/authority leaked", out)
			}
		})
	}
}
func TestRepositoryLabelBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/rpc"+golfv1connect.RepositoryServiceListRepositoryLabelsProcedure, strings.NewReader("malformed"))
	request.Header.Set("Origin", s.config.PublicURL)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Connect-Protocol-Version", "1")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	if response.Code != 401 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("inventory decoded before authority", response.Code)
	}
	response = apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), golfv1connect.RepositoryServiceUpdateIssueProcedure, "malformed")
	if response.Code != 403 {
		t.Fatal("API credential write decoded/allowed", response.Code)
	}
	if !apiReadProcedure(golfv1connect.RepositoryServiceListRepositoryLabelsProcedure) {
		t.Fatal("inventory excluded from reviewed API read scope")
	}
}

func TestRepositoryLabelApiCredentialPostgres(t *testing.T) {
	f := newLabelsFixture(t)
	_, session := f.client(t, "alice")
	credential := issueApiCredential(t, apiManagementClient(t, &managementFixture{s: f.s, db: f.db}, session), "labels read", 0)
	raw, err := protojson.Marshal(labelInventoryInput())
	if err != nil {
		t.Fatal(err)
	}
	response := apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceListRepositoryLabelsProcedure, string(raw))
	var out golfv1.ListRepositoryLabelsResponse
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || protojson.Unmarshal(response.Body.Bytes(), &out) != nil || len(out.Labels) != 50 || out.CanEditLabels {
		t.Fatal("read-only API inventory boundary", response.Code)
	}
	response = apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceUpdateIssueProcedure, "malformed")
	if response.Code != 403 || f.patches.Load() != 0 {
		t.Fatal("API credential labels write accepted", response.Code)
	}
	if err := f.s.logoutSession(t.Context(), session.Value); err != nil {
		t.Fatal(err)
	}
	response = apiRequest(f.s, credential.Token, golfv1connect.RepositoryServiceListRepositoryLabelsProcedure, string(raw))
	if response.Code != 401 || strings.Contains(response.Body.String(), "native label") {
		t.Fatal("expired source exposed inventory", response.Code)
	}
}
