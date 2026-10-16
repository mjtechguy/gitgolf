package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestAdminMFARecoveryNativeProof(t *testing.T) {
	name := os.Getenv("GOLF_ADMIN_MFA_NATIVE_PROOF")
	if name == "" {
		t.Skip("owned native admin recovery envelope not supplied")
	}
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private bounded recovery envelope required")
	}
	file, e := os.Open(name)
	if e != nil {
		t.Fatal("native recovery envelope unavailable")
	}
	defer file.Close()
	var in struct{ URL, AdminUsername, AdminToken, Username, Token string }
	decoder := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&in) != nil || decoder.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Username, "golf-mfa-probe-") || !strings.HasPrefix(in.AdminUsername, "golf-mfa-probe-") || in.Username == in.AdminUsername {
		t.Fatal("invalid owned recovery envelope")
	}
	config := testConfig(in.URL)
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("native recovery server unavailable")
	}
	adminAccount, e := ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.AdminUsername, Password: localTestPassword, ForgeToken: in.AdminToken, IsInstanceAdmin: true})
	if e != nil {
		t.Fatal("native recovery admin enrollment")
	}
	targetAccount, e := ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Username, Password: localTestPassword, ForgeToken: in.Token})
	if e != nil {
		t.Fatal("native recovery target enrollment")
	}
	admin, _, _, adminTransport, adminOrigin := testRPCClients(t, s)
	target, _, _, targetTransport, targetOrigin := testRPCClients(t, s)
	pat, _, _, _, _ := testRPCClients(t, s)
	if _, e = pat.LoginWithForgeToken(t.Context(), connect.NewRequest(&golfv1.LoginWithForgeTokenRequest{Token: in.Token})); e != nil {
		t.Fatal("native pre-enrollment token session")
	}
	enroll := func(session golfv1connect.SessionServiceClient, transport *http.Client, origin, name string) []string {
		t.Helper()
		if _, e := session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: name, Password: localTestPassword})); e != nil {
			t.Fatal("native owned password sign-in")
		}
		security := golfv1connect.NewAccountSecurityServiceClient(transport, origin+"/rpc")
		setup, e := security.BeginOwnMFA(t.Context(), mfaNativeRequest(s, &golfv1.BeginOwnMFARequest{ExpectedVersion: "0", PasswordConfirmation: localTestPassword}))
		if e != nil {
			t.Fatal("native owned MFA setup")
		}
		code, e := totpCode(setup.Msg.Secret, time.Now().Unix()/30)
		if e != nil {
			t.Fatal(e)
		}
		enabled, e := security.ConfirmOwnMFA(t.Context(), mfaNativeRequest(s, &golfv1.ConfirmOwnMFARequest{ExpectedVersion: "1", PasswordConfirmation: localTestPassword, Code: code}))
		if e != nil || len(enabled.Msg.RecoveryCodes) != 10 {
			t.Fatal("native owned MFA enable")
		}
		return enabled.Msg.RecoveryCodes
	}
	targetCodes := enroll(target, targetTransport, targetOrigin.String(), in.Username)
	if _, e = pat.GetSession(t.Context(), connect.NewRequest(&golfv1.GetSessionRequest{})); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("native prior token browser survived enrollment")
	}
	adminCodes := enroll(admin, adminTransport, adminOrigin.String(), in.AdminUsername)
	complete := func(session golfv1connect.SessionServiceClient, name, code string) {
		t.Helper()
		password, e := session.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: name, Password: localTestPassword}))
		if e != nil || !password.Msg.MfaRequired {
			t.Fatal("native recovery challenge")
		}
		if _, e = session.CompletePasswordMFA(t.Context(), connect.NewRequest(&golfv1.CompletePasswordMFARequest{Code: code})); e != nil {
			t.Fatal("native recovery sign-in")
		}
	}
	complete(admin, in.AdminUsername, adminCodes[0])
	complete(target, in.Username, targetCodes[0])
	if _, e = target.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Username, Password: localTestPassword})); e != nil {
		t.Fatal("native pending recovery challenge")
	}
	instance := golfv1connect.NewInstanceAdminServiceClient(adminTransport, adminOrigin.String()+"/rpc")
	inventory, e := instance.ListLocalAccounts(t.Context(), mfaNativeRequest(s, &golfv1.ListLocalAccountsRequest{}))
	if e != nil || !inventory.Msg.AdminMfaEnabled || inventory.Msg.AdminMfaVersion != "2" {
		t.Fatal("native admin factor inventory")
	}
	var targetInfo *golfv1.LocalAccountInfo
	for _, row := range inventory.Msg.Accounts {
		if row.Id == targetAccount.ID {
			targetInfo = row
		}
	}
	if targetInfo == nil || !targetInfo.MfaEnabled || targetInfo.MfaVersion != "2" {
		t.Fatal("native target factor inventory")
	}
	request := &golfv1.ResetRegularLocalMFARequest{AccountId: targetInfo.Id, GolfUserId: targetInfo.GolfUserId, NativeUserId: targetInfo.NativeUserId, ExpectedCredentialVersion: targetInfo.CredentialVersion, ExpectedMfaVersion: targetInfo.MfaVersion, ExpectedAdminMfaVersion: "2", PasswordConfirmation: localTestPassword, AdminMfaCode: adminCodes[1], Reason: "Owned native recovery qualification", AcknowledgeWarning: true}
	reset, e := instance.ResetRegularLocalMFA(t.Context(), mfaNativeRequest(s, request))
	if e != nil || reset.Msg.Account.MfaEnabled || reset.Msg.Account.MfaVersion != "3" || reset.Msg.Account.CredentialVersion != "2" || reset.Msg.SessionsRevoked != 1 || reset.Msg.ChallengesRevoked != 1 {
		t.Fatal("native administrative recovery effect")
	}
	if _, e = target.GetSession(t.Context(), connect.NewRequest(&golfv1.GetSessionRequest{})); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("native target session retained")
	}
	if _, e = target.CompletePasswordMFA(t.Context(), connect.NewRequest(&golfv1.CompletePasswordMFARequest{Code: targetCodes[1]})); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("native target challenge retained")
	}
	if _, e = admin.GetSession(t.Context(), connect.NewRequest(&golfv1.GetSessionRequest{})); e != nil {
		t.Fatal("native actor session unexpectedly revoked")
	}
	targetLogin, e := target.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Username, Password: localTestPassword}))
	if e != nil || targetLogin.Msg.User == nil || targetLogin.Msg.MfaRequired {
		t.Fatal("native target password changed")
	}
	nativeActor, e := s.currentUser(t.Context(), forgeCredential{Kind: "pat", Token: in.AdminToken})
	if e != nil {
		t.Fatal("native operator identity unavailable")
	}
	operator := LocalAccountInput{Username: in.AdminUsername, AccountID: adminAccount.ID, GolfUserID: adminAccount.UserID, ExpectedNativeUserID: strconv.FormatInt(nativeActor.ID, 10), ExpectedCredentialVersion: "1", ExpectedMFAVersion: "2", RecoveryReason: "Owned native console recovery qualification", AcknowledgeMFAReset: true, WritersDrained: true}
	var out LocalAccountResult
	if binary := os.Getenv("GOLF_OPERATOR_CLI_NATIVE_PROOF"); binary != "" {
		stat, e := os.Lstat(binary)
		if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 {
			t.Fatal("owned private operator binary required")
		}
		var schema string
		if e = s.db.QueryRow(`SELECT current_schema()`).Scan(&schema); e != nil || !strings.HasPrefix(schema, "golf_test_") {
			t.Fatal("owned test schema required for CLI")
		}
		dsn, e := url.Parse(os.Getenv("GOLF_TEST_DATABASE_URL"))
		if e != nil || dsn.Hostname() != "127.0.0.1" || dsn.Port() != "45472" {
			t.Fatal("owned host PostgreSQL only for CLI proof")
		}
		query := dsn.Query()
		query.Set("search_path", schema)
		dsn.RawQuery = query.Encode()
		invoke := func(action string, input LocalAccountInput, readonly bool) LocalAccountResult {
			t.Helper()
			address := *dsn
			if readonly {
				q := address.Query()
				q.Set("default_transaction_read_only", "on")
				address.RawQuery = q.Encode()
			}
			var payload any = map[string]any{"username": input.Username}
			if action == "reset-mfa" {
				payload = map[string]any{"username": input.Username, "account_id": input.AccountID, "golf_user_id": input.GolfUserID, "expected_native_user_id": input.ExpectedNativeUserID, "expected_credential_version": input.ExpectedCredentialVersion, "expected_mfa_version": input.ExpectedMFAVersion, "reason": input.RecoveryReason, "acknowledge_warning": input.AcknowledgeMFAReset, "writers_drained": input.WritersDrained}
			}
			data, _ := json.Marshal(payload)
			command := exec.CommandContext(t.Context(), binary, "local-account", action)
			command.Stdin = bytes.NewReader(data)
			command.Env = []string{"PATH=" + os.Getenv("PATH"), "DATABASE_URL=" + address.String(), "GOLF_FORGE_URL=" + in.URL}
			if !readonly {
				command.Env = append(command.Env, "GOLF_ENCRYPTION_KEY="+config.EncryptionKey)
			}
			stdout, e := command.Output()
			if e != nil || bytes.Contains(stdout, []byte(in.Token)) || bytes.Contains(stdout, []byte(in.AdminToken)) {
				t.Fatal("operator CLI outcome unavailable or unsafe", action)
			}
			var result struct {
				SchemaVersion string             `json:"schema_version"`
				Action        string             `json:"action"`
				State         string             `json:"state"`
				Result        LocalAccountResult `json:"result"`
			}
			if json.Unmarshal(stdout, &result) != nil || result.SchemaVersion != "golf.local-account.v1" || result.Action != action || result.State != "complete" {
				t.Fatal("operator CLI receipt invalid")
			}
			return result.Result
		}
		inspect := invoke("inspect", LocalAccountInput{Username: in.AdminUsername}, true)
		if inspect.ID != adminAccount.ID || inspect.UserID != adminAccount.UserID || inspect.NativeUserID != operator.ExpectedNativeUserID || !inspect.MFAEnabled || inspect.MFAVersion != "2" {
			t.Fatal("readonly operator discovery differs")
		}
		out = invoke("reset-mfa", operator, false)
	} else {
		out, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "reset-mfa", operator)
	}
	if e != nil || !out.IsInstanceAdmin || out.MFAVersion != "3" || out.SessionsRevoked != 1 {
		t.Fatal("native console administrator recovery effect")
	}
	if _, e = admin.GetSession(t.Context(), connect.NewRequest(&golfv1.GetSessionRequest{})); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("native console prior session retained")
	}
	fresh, e := admin.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.AdminUsername, Password: localTestPassword}))
	if e != nil || fresh.Msg.User == nil || !fresh.Msg.User.IsInstanceAdmin || fresh.Msg.MfaRequired {
		t.Fatal("native console role/password changed")
	}
	if _, e = target.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
		t.Fatal("native target cleanup logout")
	}
	if _, e = admin.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
		t.Fatal("native actor cleanup logout")
	}
}
