package server

import (
	"connectrpc.com/connect"
	"context"
	"encoding/base64"
	"encoding/json"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func mfaNativeRequest[T any](s *Server, value *T) *connect.Request[T] {
	r := connect.NewRequest(value)
	r.Header().Set("Origin", s.config.PublicURL)
	return r
}

// The launcher creates/purges one ordinary native actor; all Golf writes remain
// in an owned disposable schema, and no provider secret reaches test output.
func TestLocalMFANativeProof(t *testing.T) {
	name := os.Getenv("GOLF_MFA_NATIVE_PROOF")
	if name == "" {
		t.Skip("owned native MFA envelope not supplied")
	}
	stat, e := os.Lstat(name)
	if e != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 64<<10 {
		t.Fatal("private bounded MFA envelope required")
	}
	file, e := os.Open(name)
	if e != nil {
		t.Fatal("native MFA envelope unavailable")
	}
	defer file.Close()
	var in struct{ URL, Username, Token string }
	decoder := json.NewDecoder(io.LimitReader(file, 64<<10+1))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&in) != nil || decoder.Decode(&extra) != io.EOF || in.URL != "http://localhost:3001" || !strings.HasPrefix(in.Username, "golf-mfa-probe-") || len(in.Token) < 8 {
		t.Fatal("invalid owned MFA fixture")
	}
	config := testConfig(in.URL)
	config.GiteaPublicURL = in.URL
	s, e := New(config, testDatabase(t))
	if e != nil {
		t.Fatal("native MFA server unavailable")
	}
	if _, e = ManageLocalAccount(t.Context(), s.db, s.keyring, in.URL, "create", LocalAccountInput{Username: in.Username, Password: localTestPassword, ForgeToken: in.Token}); e != nil {
		t.Fatal("native MFA enrollment failed")
	}
	sessions, repositories, _, transport, origin := testRPCClients(t, s)
	security := golfv1connect.NewAccountSecurityServiceClient(transport, origin.String()+"/rpc")
	if _, e = sessions.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Username, Password: localTestPassword})); e != nil {
		t.Fatal("native initial login failed")
	}
	// Supported native setup for an exact-commit YAML-template consumer proof.
	native := forgeCredential{Kind: "pat", Token: in.Token}
	var repository Repository
	if _, e = s.forgeJSON(t.Context(), http.MethodPost, "/user/repos", native, map[string]any{"name": "forms", "private": true, "auto_init": true}, &repository, http.StatusCreated); e != nil {
		t.Fatal("owned native form repository setup failed")
	}
	key := &golfv1.RepositoryKey{Owner: in.Username, Name: "forms"}
	base, _ := repositoryPath(keyFrom(key))
	if _, e = s.forgeJSON(t.Context(), http.MethodPost, base+"/contents/.github/ISSUE_TEMPLATE/bug.yml", native, map[string]string{"content": base64.StdEncoding.EncodeToString([]byte(usefulIssueForm)), "message": "Owned structured issue form"}, nil, http.StatusCreated); e != nil {
		t.Fatal("owned native form content setup failed")
	}
	collaboration := golfv1connect.NewDiscussionCollaborationServiceClient(transport, origin.String()+"/rpc")
	templates, e := collaboration.ListIssueTemplates(t.Context(), mfaNativeRequest(s, &golfv1.ListIssueTemplatesRequest{Repository: key, RepositoryId: strconv.FormatInt(repository.ID, 10)}))
	if e != nil || len(templates.Msg.Templates) != 1 || len(templates.Msg.Templates[0].Fields) != 5 || templates.Msg.CommitId == "" || templates.Msg.UnsupportedTemplates != 0 {
		t.Fatal("actual native exact-commit YAML form consumer failed")
	}
	body := "### Version\n\n1.2.3\n\n### Logs\n\n```shell\necho native\n```\n\n### Platform\n\nLinux\n\n### Agreement\n\n- [x] I checked existing issues."
	created, e := repositories.CreateIssue(t.Context(), connect.NewRequest(&golfv1.CreateIssueRequest{Repository: key, RepositoryId: strconv.FormatInt(repository.ID, 10), Title: "Structured native issue", Body: body, IdempotencyKey: randomUUID()}))
	if e != nil || created.Msg.Issue == nil || created.Msg.Issue.Body != body {
		t.Fatal("actual native form draft issue publication failed")
	}
	var issue discussionIssue
	if _, e = s.forge(t.Context(), http.MethodGet, base+"/issues/"+strconv.FormatUint(uint64(created.Msg.Issue.Number), 10), native, nil, &issue); e != nil || issue.Body != body {
		t.Fatal("independent native form issue bytes differ")
	}
	setup, e := security.BeginOwnMFA(t.Context(), mfaNativeRequest(s, &golfv1.BeginOwnMFARequest{ExpectedVersion: "0", PasswordConfirmation: localTestPassword}))
	if e != nil || setup.Msg.Mfa.Version != "1" {
		t.Fatal("native MFA setup failed")
	}
	code, e := totpCode(setup.Msg.Secret, time.Now().Unix()/30)
	if e != nil {
		t.Fatal("native MFA code unavailable")
	}
	enabled, e := security.ConfirmOwnMFA(t.Context(), mfaNativeRequest(s, &golfv1.ChangeOwnMFARequest{ExpectedVersion: "1", PasswordConfirmation: localTestPassword, Code: code}))
	if e != nil || !enabled.Msg.Mfa.Enabled || len(enabled.Msg.RecoveryCodes) != 10 || !enabled.Msg.RequiresLogin {
		t.Fatal("native MFA enable failed")
	}
	if _, e = sessions.GetSession(t.Context(), connect.NewRequest(&golfv1.GetSessionRequest{})); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("native setup session retained")
	}
	if _, e = sessions.LoginWithGiteaToken(t.Context(), connect.NewRequest(&golfv1.LoginWithGiteaTokenRequest{Token: in.Token})); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("native PAT interactive MFA bypass")
	}
	password, e := sessions.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Username, Password: localTestPassword}))
	if e != nil || !password.Msg.MfaRequired || password.Msg.User != nil {
		t.Fatal("native password incorrectly authenticated")
	}
	// Same persistent schema/keyring, new application instance. Challenge validity
	// comes from durable state rather than memory on the first application process.
	restart, e := New(config, s.db)
	if e != nil {
		t.Fatal("native restart failed")
	}
	next, _, _, nextTransport, nextOrigin := testRPCClients(t, restart)
	for _, cookie := range transport.Jar.Cookies(origin) {
		nextTransport.Jar.SetCookies(nextOrigin, []*http.Cookie{cookie})
	}
	security = golfv1connect.NewAccountSecurityServiceClient(nextTransport, nextOrigin.String()+"/rpc")
	sessions = next
	nextCode, e := totpCode(setup.Msg.Secret, time.Now().Unix()/30+1)
	if e != nil {
		t.Fatal("native fresh authenticator code unavailable")
	}
	signed, e := sessions.CompletePasswordMFA(t.Context(), connect.NewRequest(&golfv1.CompletePasswordMFARequest{Code: nextCode}))
	if e != nil || signed.Msg.User == nil || signed.Msg.User.Login != in.Username {
		t.Fatal("native durable MFA completion failed")
	}
	state, e := security.GetOwnMFA(t.Context(), mfaNativeRequest(restart, &golfv1.GetOwnMFARequest{}))
	if e != nil || state.Msg.Mfa.RemainingRecoveryCodes != 10 {
		t.Fatal("native own recovery count failed")
	}
	regenerated, e := security.RegenerateOwnMFARecovery(t.Context(), mfaNativeRequest(restart, &golfv1.ChangeOwnMFARequest{ExpectedVersion: "2", PasswordConfirmation: localTestPassword, Code: enabled.Msg.RecoveryCodes[1]}))
	if e != nil || len(regenerated.Msg.RecoveryCodes) != 10 || regenerated.Msg.Mfa.Version != "3" {
		t.Fatal("native recovery regeneration failed")
	}
	if _, e = sessions.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Username, Password: localTestPassword})); e != nil {
		t.Fatal("native repeat challenge failed")
	}
	if _, e = sessions.CompletePasswordMFA(t.Context(), connect.NewRequest(&golfv1.CompletePasswordMFARequest{Code: enabled.Msg.RecoveryCodes[2]})); connect.CodeOf(e) != connect.CodeUnauthenticated {
		t.Fatal("old recovery generation accepted")
	}
	if _, e = sessions.CompletePasswordMFA(t.Context(), connect.NewRequest(&golfv1.CompletePasswordMFARequest{Code: regenerated.Msg.RecoveryCodes[0]})); e != nil {
		t.Fatal("native replacement recovery failed")
	}
	disabled, e := security.DisableOwnMFA(t.Context(), mfaNativeRequest(restart, &golfv1.ChangeOwnMFARequest{ExpectedVersion: "3", PasswordConfirmation: localTestPassword, Code: regenerated.Msg.RecoveryCodes[1]}))
	if e != nil || disabled.Msg.Mfa.Enabled {
		t.Fatal("native disable failed")
	}
	legacy, e := sessions.LoginWithPassword(t.Context(), connect.NewRequest(&golfv1.LoginWithPasswordRequest{Username: in.Username, Password: localTestPassword}))
	if e != nil || legacy.Msg.User == nil || legacy.Msg.MfaRequired {
		t.Fatal("native legacy password behavior failed")
	}
	if _, e = sessions.Logout(context.Background(), connect.NewRequest(&golfv1.LogoutRequest{})); e != nil {
		t.Fatal("native own logout failed")
	}
}
