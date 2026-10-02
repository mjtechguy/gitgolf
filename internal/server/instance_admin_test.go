package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func instanceAccountsRequest(s *Server, session loginResult, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/rpc"+golfv1connect.InstanceAdminServiceListLocalAccountsProcedure, strings.NewReader(body))
	req.Header.Set("Origin", s.config.PublicURL)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	if session.Value != "" {
		req.AddCookie(s.sessionCookie(session.Value, session.Expires, 3600))
	}
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	return response
}

func TestInstanceAdminBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{s.config.PublicURL, "https://other.invalid", ""} {
		req := httptest.NewRequest("POST", "/rpc"+golfv1connect.InstanceAdminServiceListLocalAccountsProcedure, strings.NewReader("malformed"))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, req)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if response.Code != want || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("inventory bypassed predecode authentication/origin/no-store", response.Code)
		}
	}
	response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), golfv1connect.InstanceAdminServiceListLocalAccountsProcedure, "malformed")
	if response.Code != 403 {
		t.Fatal("delegated bearer reached inventory", response.Code)
	}
}

func TestInstanceAdminInventoryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := t.Context()
	alice := enrollLocal(t, f, "alice", true)
	bob := enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	ordinary := localLogin(t, f, "bob")
	for _, session := range []loginResult{ordinary, f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		response := instanceAccountsRequest(f.s, session, "{}")
		if response.Code != 403 || strings.Contains(response.Body.String(), "bob") {
			t.Fatal("non-admin/nonlocal session read inventory", response.Code)
		}
	}
	delegated := issueApiCredential(t, apiManagementClient(t, f, admin), "admin read delegate", 0)
	if response := apiRequest(f.s, delegated.Token, golfv1connect.InstanceAdminServiceListLocalAccountsProcedure, "{}"); response.Code != 403 {
		t.Fatal("local administrator delegation acquired administration", response.Code)
	}
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.GiteaURL, "set-email", LocalAccountInput{Username: "bob", Email: "bob@example.invalid"}); err != nil {
		t.Fatal(err)
	}
	disabled, err := ManageLocalAccount(ctx, f.db, f.s.keyring, f.s.config.GiteaURL, "disable", LocalAccountInput{Username: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	// A separately configured forge can reuse a native numeric ID; it must not
	// enter this installation's account inventory merely by sharing the DB.
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "other-forge", "is_admin": true})
	}))
	defer other.Close()
	if _, err := ManageLocalAccount(ctx, f.db, f.s.keyring, other.URL, "create", LocalAccountInput{Username: "foreign", Password: localTestPassword, ForgeToken: "other-forge-token", IsInstanceAdmin: true}); err != nil {
		t.Fatal(err)
	}
	var hash string
	var ciphertext []byte
	if err := f.db.QueryRow("SELECT password_hash,encrypted_forge_token FROM golf_local_accounts WHERE username='alice'").Scan(&hash, &ciphertext); err != nil {
		t.Fatal(err)
	}
	for page := 1; page <= 3; page++ {
		body := `{"page":{"page":` + strconv.Itoa(page) + `,"limit":1}}`
		response := instanceAccountsRequest(f.s, admin, body)
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("admin inventory failed", response.Code)
		}
		for _, secret := range []string{localTestPassword, hash, base64.StdEncoding.EncodeToString(ciphertext), "alice-management-token", admin.Value, delegated.Token, "foreign", "encrypted", "passwordHash", "credentialKeyId", "credentialBinding"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatal("inventory exposed secret/non-metadata/foreign record")
			}
		}
		var result golfv1.ListLocalAccountsResponse
		if err := protojson.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if page == 3 {
			if len(result.Accounts) != 0 || result.GetPage().GetNextPage() != 0 {
				t.Fatal("inventory did not terminate")
			}
			continue
		}
		if len(result.Accounts) != 1 {
			t.Fatal("page size was not honored")
		}
		row := result.Accounts[0]
		if row.CreatedAt == "" || row.GolfUserId == "" {
			t.Fatal("missing persisted identity/timestamp")
		}
		if page == 1 && (row.Id != alice.ID || row.Username != "alice" || row.NativeUserId != "42" || !row.IsInstanceAdmin || row.Disabled || row.DisabledAt != nil || row.CredentialVersion != "1" || result.GetPage().GetNextPage() != 2) {
			t.Fatal("enabled administrator metadata or pagination changed")
		}
		if page == 2 && (row.Id != bob.ID || row.Username != "bob" || row.NativeUserId != "84" || row.IsInstanceAdmin || !row.Disabled || row.GetDisabledAt() == "" || row.Email != "bob@example.invalid" || row.CredentialVersion != disabled.CredentialVersion || result.GetPage().GetNextPage() != 0) {
			t.Fatal("disabled local-account metadata or termination changed")
		}
	}
	for _, body := range []string{`{"page":{"page":10001}}`, `{"page":{"limit":101}}`} {
		if response := instanceAccountsRequest(f.s, admin, body); response.Code != 400 {
			t.Fatal("unbounded inventory pagination", response.Code)
		}
	}
	// Fresh provider identity remains necessary for a locally enrolled admin.
	for _, mode := range []int32{1, 2} {
		f.mode.Store(mode)
		if response := instanceAccountsRequest(f.s, admin, "{}"); response.Code != 401 || strings.Contains(response.Body.String(), "bob") {
			t.Fatal("changed/revoked provider identity read inventory", response.Code)
		}
	}
}

func TestInstanceAdminPostWaitDenialPostgres(t *testing.T) {
	for _, action := range []string{"disable", "reset-password", "source_logout", "source_expiry", "provider_revocation", "provider_identity"} {
		t.Run(action, func(t *testing.T) {
			f := newManagementFixture(t)
			enrollLocal(t, f, "alice", true)
			enrollLocal(t, f, "bob", false)
			admin := localLogin(t, f, "alice")
			barrier := &apiWaitTransport{base: f.s.client.Transport, entered: make(chan struct{}), resume: make(chan struct{})}
			if barrier.base == nil {
				barrier.base = http.DefaultTransport
			}
			f.s.client.Transport = barrier
			defer close(barrier.resume)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- instanceAccountsRequest(f.s, admin, "{}") }()
			select {
			case <-barrier.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("inventory did not reach post-query provider barrier")
			}
			switch action {
			case "disable", "reset-password":
				input := LocalAccountInput{Username: "alice"}
				if action == "reset-password" {
					input.Password = "New independent Golf password"
				}
				if _, err := ManageLocalAccount(context.Background(), f.db, f.s.keyring, f.s.config.GiteaURL, action, input); err != nil {
					t.Fatal(err)
				}
			case "source_logout":
				if err := f.s.logoutSession(context.Background(), admin.Value); err != nil {
					t.Fatal(err)
				}
			case "source_expiry":
				_, _, hash := f.id(t, admin)
				if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", hash); err != nil {
					t.Fatal(err)
				}
			case "provider_revocation":
				f.mode.Store(2)
			case "provider_identity":
				f.mode.Store(1)
			}
			barrier.resume <- struct{}{}
			select {
			case response := <-done:
				if response.Code != 401 || strings.Contains(response.Body.String(), "bob") || strings.Contains(response.Body.String(), "accounts") {
					t.Fatal("private inventory escaped post-wait denial", response.Code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("inventory post-wait check stalled")
			}
		})
	}
}
