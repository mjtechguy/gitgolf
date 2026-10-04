package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"github.com/pressly/goose/v3"
	"google.golang.org/protobuf/encoding/protojson"
)

func apiManagementClient(t *testing.T, f *managementFixture, session loginResult) golfv1connect.ApiCredentialServiceClient {
	t.Helper()
	_, _, _, client, origin := testRPCClients(t, f.s)
	client.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return golfv1connect.NewApiCredentialServiceClient(client, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", f.s.config.PublicURL)
			return next(ctx, req)
		}
	})))
}

func issueApiCredential(t *testing.T, client golfv1connect.ApiCredentialServiceClient, label string, lifetime uint32) *golfv1.CreateApiCredentialResponse {
	t.Helper()
	result, err := client.CreateApiCredential(context.Background(), connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: label, LifetimeSeconds: lifetime}))
	if err != nil {
		t.Fatal(err)
	}
	if result.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("credential response cacheable")
	}
	return result.Msg
}

func apiRequest(s *Server, token, procedure, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader(body))
	request.Header.Set("Origin", s.config.PublicURL)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Connect-Protocol-Version", "1")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	return response
}

func TestApiCredentialBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	token := apiTokenPrefix + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for _, procedure := range []string{golfv1connect.ApiCredentialServiceCreateApiCredentialProcedure, golfv1connect.ApiCredentialServiceListApiCredentialsProcedure, golfv1connect.ApiCredentialServiceRevokeApiCredentialProcedure,
		golfv1connect.SessionServiceLoginWithGiteaTokenProcedure, golfv1connect.SessionServiceLoginWithPasswordProcedure, golfv1connect.SessionServiceLogoutProcedure, golfv1connect.SessionServiceGetAuthenticationOptionsProcedure,
		golfv1connect.SessionServiceBeginGiteaOAuthProcedure, golfv1connect.SessionServiceListSessionsProcedure, golfv1connect.SessionServiceRevokeSessionProcedure,
		golfv1connect.SessionServiceRevokeOtherSessionsProcedure, golfv1connect.RepositoryServiceCreateRepositoryProcedure, golfv1connect.CapabilityServiceListCapabilitiesProcedure, "/golf.v1.FutureService/Read"} {
		response := apiRequest(s, token, procedure, "{malformed")
		if response.Code != 403 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("bearer procedure guard: %s status%d", procedure, response.Code)
		}
	}
	for _, modify := range []func(*http.Request){
		func(r *http.Request) { r.Header.Add("Authorization", "Bearer "+token) },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+token+", Bearer "+token) },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer  "+token) },
		func(r *http.Request) { r.Header.Set("Authorization", "Basic "+token) },
		func(r *http.Request) { r.Header.Set("Authorization", "") },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+token+"=") },
		func(r *http.Request) { r.Header.Set("Cookie", "golf_session=malformed") },
		func(r *http.Request) { r.Header.Set("Cookie", "unrelated=anything") },
	} {
		request := httptest.NewRequest("POST", "/rpc"+golfv1connect.SessionServiceGetSessionProcedure, strings.NewReader("{malformed"))
		request.Header.Set("Origin", s.config.PublicURL)
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Connect-Protocol-Version", "1")
		modify(request)
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != 401 || strings.Contains(response.Body.String(), token) {
			t.Fatalf("authorization shape before decoding: %d", response.Code)
		}
		request.Header.Set("Origin", "https://foreign.invalid")
		response = httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatal("origin boundary lost")
		}
	}
	// Exact reviewed read-only delegation surface, including bounded tags.
	// Every new generated procedure remains denied unless named here.
	expected := map[string]bool{
		golfv1connect.RepositoryActivityServiceWatchRepositoryProcedure:      true,
		golfv1connect.SessionServiceGetSessionProcedure:                      true,
		golfv1connect.AuditServiceListAuditEventsProcedure:                   true,
		golfv1connect.RepositoryServiceListRepositoriesProcedure:             true,
		golfv1connect.RepositoryServiceGetRepositoryProcedure:                true,
		golfv1connect.RepositoryServiceGetRepositoryOverviewProcedure:        true,
		golfv1connect.RepositoryServiceGetRepositoryCreationProcedure:        true,
		golfv1connect.RepositoryServiceListBranchesProcedure:                 true,
		golfv1connect.RepositoryServiceListCommitsProcedure:                  true,
		golfv1connect.RepositoryServiceListTagsProcedure:                     true,
		golfv1connect.RepositoryServiceGetContentsProcedure:                  true,
		golfv1connect.RepositoryServiceResolveRepositorySourceProcedure:      true,
		golfv1connect.RepositoryServiceGetCommitDiffProcedure:                true,
		golfv1connect.RepositoryServiceGetPullRequestDiffProcedure:           true,
		golfv1connect.RepositoryServiceGetRepositoryComparisonProcedure:      true,
		golfv1connect.RepositoryServiceListPullRequestCommitsProcedure:       true,
		golfv1connect.RepositoryServiceListPullRequestChecksProcedure:        true,
		golfv1connect.RepositoryServiceGetRepositoryImageProcedure:           true,
		golfv1connect.RepositoryServiceListIssuesProcedure:                   true,
		golfv1connect.RepositoryServiceGetIssueProcedure:                     true,
		golfv1connect.RepositoryServiceListPullRequestsProcedure:             true,
		golfv1connect.RepositoryServiceListIssueCommentsProcedure:            true,
		golfv1connect.RepositoryServiceGetIssueMutationProcedure:             true,
		golfv1connect.RepositoryServiceGetPullRequestProcedure:               true,
		golfv1connect.RepositoryServiceListPullRequestReviewsProcedure:       true,
		golfv1connect.RepositoryServiceGetPullRequestReviewCommentsProcedure: true,
		golfv1connect.RepositoryServiceGetPullRequestReviewMutationProcedure: true,
		golfv1connect.OrganizationServiceListOrganizationsProcedure:          true,
		golfv1connect.OrganizationServiceGetOrganizationProcedure:            true,
		golfv1connect.OrganizationServiceListTeamsProcedure:                  true,
		golfv1connect.OrganizationServiceGetTeamProcedure:                    true,
		golfv1connect.OrganizationServiceListTeamMembersProcedure:            true,
		golfv1connect.OrganizationServiceListTeamRepositoriesProcedure:       true,
	}
	services := golfv1.File_golf_v1_golf_proto.Services()
	for i := 0; i < services.Len(); i++ {
		service := services.Get(i)
		for j := 0; j < service.Methods().Len(); j++ {
			procedure := "/" + string(service.FullName()) + "/" + string(service.Methods().Get(j).Name())
			allowed := apiReadProcedure(procedure)
			if allowed != expected[procedure] {
				t.Fatal("unexpected bearer delegation contract", procedure, allowed)
			}
			delete(expected, procedure)
		}
	}
	if len(expected) != 0 {
		t.Fatal("reviewed API procedures missing from descriptor", expected)
	}
	if !apiReadProcedure(golfv1connect.RepositoryServiceGetRepositoryComparisonProcedure) || apiReadProcedure(golfv1connect.RepositoryServiceCreatePullRequestProcedure) {
		t.Fatal("comparison read versus PR write delegation boundary lost")
	}
	if !apiReadProcedure(golfv1connect.RepositoryServiceGetPullRequestReviewMutationProcedure) || apiReadProcedure(golfv1connect.RepositoryServiceCreatePullRequestReviewProcedure) {
		t.Fatal("review outcome read versus review publication delegation boundary lost")
	}
	for _, invalid := range []string{token + "=", token[:len(token)-1] + "B", strings.TrimPrefix(token, apiTokenPrefix), " " + token} {
		if _, err := apiTokenHash(invalid); err == nil {
			t.Fatal("noncanonical token accepted")
		}
	}
}

func TestApiCredentialLifecyclePostgres(t *testing.T) {
	f := newManagementFixture(t)
	source := f.session(t, "alice", "pat")
	other := f.session(t, "alice", "oauth")
	bob := f.session(t, "bob", "pat")
	client, otherClient, bobClient := apiManagementClient(t, f, source), apiManagementClient(t, f, other), apiManagementClient(t, f, bob)
	created := issueApiCredential(t, client, "local agent 中文", 43200)
	sourceID, _, sourceHash := f.id(t, source)
	if created.Credential.SourceSessionId != strconv.FormatInt(sourceID, 10) || !created.Credential.SourceSessionActive || created.Credential.RevokedAt != "" || created.Credential.Label != "local agent 中文" {
		t.Fatal("wrong metadata")
	}
	expires, err := time.Parse(time.RFC3339Nano, created.Credential.ExpiresAt)
	if err != nil || expires.After(source.Expires) || source.Expires.Sub(expires) > time.Millisecond {
		t.Fatal("source expiry not clamped")
	}
	var stored, encryptedBefore []byte
	if err := f.db.QueryRow("SELECT token_hash FROM golf_api_credentials WHERE id=$1", created.Credential.Id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.Sum256([]byte(created.Token))
	if !bytes.Equal(stored, wantHash[:]) {
		t.Fatal("stored credential is not the token digest")
	}
	if err := f.db.QueryRow("SELECT encrypted_token FROM golf_sessions WHERE token_hash=$1", sourceHash).Scan(&encryptedBefore); err != nil {
		t.Fatal(err)
	}
	for _, server := range []*Server{f.s, func() *Server {
		restarted, err := New(f.s.config, f.db)
		if err != nil {
			t.Fatal(err)
		}
		return restarted
	}()} {
		response := apiRequest(server, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`)
		if response.Code != 200 || !strings.Contains(response.Body.String(), `"alice"`) {
			t.Fatal("bearer identity/restart", response.Code)
		}
		response = apiRequest(server, created.Token, golfv1connect.AuditServiceListAuditEventsProcedure, `{"limit":1}`)
		if response.Code != 200 {
			t.Fatal("delegated account read could not resolve source session", response.Code)
		}
	}
	var encryptedAfter []byte
	if err := f.db.QueryRow("SELECT encrypted_token FROM golf_sessions WHERE token_hash=$1", sourceHash).Scan(&encryptedAfter); err != nil || !bytes.Equal(encryptedBefore, encryptedAfter) {
		t.Fatal("PAT read copied or altered source ciphertext", err)
	}
	listed, err := otherClient.ListApiCredentials(context.Background(), connect.NewRequest(&golfv1.ListApiCredentialsRequest{}))
	if err != nil || len(listed.Msg.Credentials) != 1 || listed.Msg.CurrentSourceExpiresAt == "" {
		t.Fatal("owner list", err)
	}
	raw, _ := protojson.Marshal(listed.Msg)
	if bytes.Contains(raw, []byte(created.Token)) || bytes.Contains(raw, stored) || bytes.Contains(raw, []byte("tokenHash")) {
		t.Fatal("metadata exposed secret")
	}
	bobList, err := bobClient.ListApiCredentials(context.Background(), connect.NewRequest(&golfv1.ListApiCredentialsRequest{}))
	if err != nil || len(bobList.Msg.Credentials) != 0 {
		t.Fatal("cross-owner list", err)
	}
	for _, id := range []string{created.Credential.Id, "9223372036854775807"} {
		_, err := bobClient.RevokeApiCredential(context.Background(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: id}))
		if connect.CodeOf(err) != connect.CodeNotFound {
			t.Fatal("foreign/missing denial differs", err)
		}
	}
	var revokedAt string
	for range 2 {
		result, err := otherClient.RevokeApiCredential(context.Background(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: created.Credential.Id}))
		if err != nil || result.Msg.Credential.RevokedAt == "" || revokedAt != "" && revokedAt != result.Msg.Credential.RevokedAt {
			t.Fatal("idempotent revoke", err)
		}
		revokedAt = result.Msg.Credential.RevokedAt
	}
	if response := apiRequest(f.s, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 401 {
		t.Fatal("revoked credential retained access", response.Code)
	}
	second := issueApiCredential(t, client, "second", 0)
	if err := f.s.logoutSession(context.Background(), source.Value); err != nil {
		t.Fatal(err)
	}
	if response := apiRequest(f.s, second.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 401 {
		t.Fatal("ended source retained access", response.Code)
	}
	listed, err = otherClient.ListApiCredentials(context.Background(), connect.NewRequest(&golfv1.ListApiCredentialsRequest{Page: &golfv1.PageRequest{Limit: 1}}))
	if err != nil || len(listed.Msg.Credentials) != 1 || listed.Msg.Credentials[0].SourceSessionActive || listed.Msg.Credentials[0].RevokedAt != "" || listed.Msg.Page.NextPage != 2 {
		t.Fatal("retained metadata/source distinction/pagination", err)
	}
	var events int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_api_credential_events").Scan(&events); err != nil || events != 3 {
		t.Fatal("transactional lifecycle event count", err, events)
	}
}

func TestApiCredentialValidationRollbackPostgres(t *testing.T) {
	f := newManagementFixture(t)
	source := f.session(t, "alice", "pat")
	client := apiManagementClient(t, f, source)
	for _, request := range []*golfv1.CreateApiCredentialRequest{
		{Label: ""}, {Label: " label"}, {Label: "label "}, {Label: "a\x7fb"}, {Label: strings.Repeat("é", 33)},
		{Label: "label", LifetimeSeconds: 59}, {Label: "label", LifetimeSeconds: 43201},
	} {
		if _, err := client.CreateApiCredential(context.Background(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid issuance input accepted", err)
		}
	}
	if validApiCredentialLabel(string([]byte{0xff})) {
		t.Fatal("invalid UTF8 label accepted")
	}
	for _, id := range []string{"", "0", "01", "+1", "9223372036854775808", "1e2"} {
		if _, err := client.RevokeApiCredential(context.Background(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: id})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid ID", err)
		}
	}
	if _, err := f.db.Exec(`CREATE TRIGGER fail_api_event BEFORE INSERT ON golf_api_credential_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation()`); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateApiCredential(context.Background(), connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "rolled back"})); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("creation event failure", err)
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_api_credentials").Scan(&count); err != nil || count != 0 {
		t.Fatal("issuance survived event rollback", err)
	}
	if _, err := f.db.Exec("DROP TRIGGER fail_api_event ON golf_api_credential_events"); err != nil {
		t.Fatal(err)
	}
	created := issueApiCredential(t, client, "rollback revoke", 0)
	if _, err := f.db.Exec(`CREATE TRIGGER fail_api_event BEFORE INSERT ON golf_api_credential_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation()`); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RevokeApiCredential(context.Background(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: created.Credential.Id})); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("revocation event failure", err)
	}
	if response := apiRequest(f.s, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 200 {
		t.Fatal("revocation survived event rollback", response.Code)
	}
	for _, statement := range []string{"UPDATE golf_api_credentials SET label='changed'", "UPDATE golf_api_credentials SET source_session_id=999", "UPDATE golf_api_credential_events SET action='REVOKED'", "DELETE FROM golf_api_credential_events", "TRUNCATE golf_api_credential_events"} {
		if _, err := f.db.Exec(statement); err == nil {
			t.Fatal("immutable state/history altered")
		}
	}
}

type apiWaitTransport struct {
	base      http.RoundTripper
	userCalls atomic.Int32
	entered   chan struct{}
	resume    chan struct{}
}

func (transport *apiWaitTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := transport.base.RoundTrip(request)
	if request.URL.Path == "/api/v1/user" && transport.userCalls.Add(1) == 2 {
		close(transport.entered)
		select {
		case <-transport.resume:
		case <-request.Context().Done():
			if response != nil {
				response.Body.Close()
			}
			return nil, request.Context().Err()
		}
	}
	return response, err
}

func TestApiCredentialPostWaitDenialPostgres(t *testing.T) {
	for _, action := range []string{"credential_revoke", "source_logout", "source_expiry", "provider_revocation", "provider_identity"} {
		t.Run(action, func(t *testing.T) {
			f := newManagementFixture(t)
			source := f.session(t, "alice", "pat")
			other := f.session(t, "alice", "pat")
			client, otherClient := apiManagementClient(t, f, source), apiManagementClient(t, f, other)
			created := issueApiCredential(t, client, "in flight", 0)
			barrier := &apiWaitTransport{base: f.s.client.Transport, entered: make(chan struct{}), resume: make(chan struct{})}
			if barrier.base == nil {
				barrier.base = http.DefaultTransport
			}
			f.s.client.Transport = barrier
			defer close(barrier.resume)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- apiRequest(f.s, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`) }()
			select {
			case <-barrier.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("read did not reach provider barrier")
			}
			switch action {
			case "credential_revoke":
				if _, err := otherClient.RevokeApiCredential(context.Background(), connect.NewRequest(&golfv1.RevokeApiCredentialRequest{CredentialId: created.Credential.Id})); err != nil {
					t.Fatal(err)
				}
			case "source_logout":
				if err := f.s.logoutSession(context.Background(), source.Value); err != nil {
					t.Fatal(err)
				}
			case "source_expiry":
				_, _, hash := f.id(t, source)
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
				if response.Code != 401 || strings.Contains(response.Body.String(), `"alice"`) {
					t.Fatal("private result escaped post-wait denial", response.Code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("post-wait denial stalled")
			}
		})
	}
}

func TestApiCredentialQuotaAndScopePostgres(t *testing.T) {
	f := newManagementFixture(t)
	source := f.session(t, "alice", "oauth")
	client := apiManagementClient(t, f, source)
	created := issueApiCredential(t, client, "oauth source", 0)
	if response := apiRequest(f.s, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 200 {
		t.Fatal("OAuth delegation failed", response.Code)
	}
	// Prime ninety-nine usable credentials in one statement, then race two
	// real lifecycle calls for the remaining account-locked quota slot.
	_, userID, hash := f.id(t, source)
	if _, err := f.db.Exec(`INSERT INTO golf_api_credentials(user_id,token_hash,label,source_session_id,source_token_hash,expires_at)
SELECT $1,sha256(convert_to('fixture-'||n,'UTF8')),'quota fixture', $2,$3,$4 FROM generate_series(1,98)n`, userID, created.Credential.SourceSessionId, hash, source.Expires); err != nil {
		t.Fatal(err)
	}
	var accepted, denied atomic.Int32
	var wait sync.WaitGroup
	for range 2 {
		wait.Go(func() {
			_, err := client.CreateApiCredential(context.Background(), connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "racing final slot"}))
			if err == nil {
				accepted.Add(1)
			} else if connect.CodeOf(err) == connect.CodeResourceExhausted {
				denied.Add(1)
			} else {
				t.Error(err)
			}
		})
	}
	wait.Wait()
	if accepted.Load() != 1 || denied.Load() != 1 {
		t.Fatal("concurrent quota escaped account lock")
	}
	// Same DB and ciphertext with a different configured forge cannot delegate.
	otherConfig := f.s.config
	otherConfig.GiteaURL += "/different-forge"
	otherConfig.GiteaPublicURL = otherConfig.GiteaURL
	otherServer, err := New(otherConfig, f.db)
	if err != nil {
		t.Fatal(err)
	}
	if response := apiRequest(otherServer, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 401 {
		t.Fatal("cross-forge authority escaped", response.Code)
	}
	if err := f.s.logoutSession(context.Background(), source.Value); err != nil {
		t.Fatal(err)
	}
	newSource := f.session(t, "alice", "pat")
	newClient := apiManagementClient(t, f, newSource)
	issueApiCredential(t, newClient, "old source no longer consumes quota", 0)
	if response := apiRequest(f.s, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 401 {
		t.Fatal("new login revived ended delegation")
	}
}

func TestApiCredentialLockWaitRechecksPostgres(t *testing.T) {
	f := newManagementFixture(t)
	source := f.session(t, "alice", "pat")
	client := apiManagementClient(t, f, source)
	created := issueApiCredential(t, client, "blocked audit", 0)
	_, userID, _ := f.id(t, source)
	tx, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("SELECT id FROM golf_users WHERE id=$1 FOR UPDATE", userID); err != nil {
		t.Fatal(err)
	}
	hash, _ := apiTokenHash(created.Token)
	ctx := context.WithValue(context.Background(), apiAuthKey{}, apiAuth{hash: hash})
	done := make(chan error, 1)
	go func() { _, _, _, err := f.s.listAuditEvents(ctx, "", managementToken(), 20, "", ""); done <- err }()
	// Prove the operation has reached a database lock wait instead of relying on
	// a sleep to arrange the revocation race.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := f.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '-- name: LockSessionUser%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("account read did not wait on lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := tx.Exec("UPDATE golf_api_credentials SET revoked_at=clock_timestamp() WHERE id=$1", created.Credential.Id); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, errUnauthenticated) {
		t.Fatal("account-lock wait retained revoked delegation", err)
	}
}

// Keep the SQL null-time type in the wire regression: expired metadata is still
// returned, without inventing an explicit revocation timestamp.
func TestApiCredentialWireLargeIDs(t *testing.T) {
	row := wireApiCredential(database.ListApiCredentialsRow{ID: 9007199254740993, SourceSessionID: 9007199254740995, Label: "ended", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(-time.Second), RevokedAt: sql.NullTime{}})
	raw, err := protojson.Marshal(row)
	if err != nil || !strings.Contains(string(raw), `"9007199254740993"`) || !strings.Contains(string(raw), `"9007199254740995"`) || row.RevokedAt != "" {
		t.Fatal(fmt.Sprintf("opaque wire IDs/metadata: %v", err))
	}
}

func TestApiCredentialOAuthSharedRefreshPostgres(t *testing.T) {
	f := newOAuthFixture(t)
	source, err := f.s.createSession(t.Context(), User{ID: 42, Login: "same-user"}, "oauth", encodeOAuth(oauthEnvelope{Version: 1, AccessToken: oauthAccess(0), RefreshToken: "refresh-0", Expiry: time.Now().Add(time.Hour), Verified: true}), "")
	if err != nil {
		t.Fatal(err)
	}
	client := apiManagementClient(t, &managementFixture{s: f.s, db: f.db}, source)
	created := issueApiCredential(t, client, "shared rotating source", 0)
	hash, _ := sessionHash(source.Value)
	encrypted, keyID, err := f.s.keyring.seal(sessionDomain, encodeOAuth(oauthEnvelope{Version: 1, AccessToken: oauthAccess(0), RefreshToken: "refresh-0", Expiry: time.Now().Add(-time.Minute), Verified: true}), hash)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.New(f.db).UpdateKeyedSessionCredential(t.Context(), database.UpdateKeyedSessionCredentialParams{TokenHash: hash, EncryptedToken: encrypted, CredentialKeyID: keyID}); err != nil {
		t.Fatal(err)
	}
	replica, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	apiHash, _ := apiTokenHash(created.Token)
	start := make(chan struct{})
	results := make(chan error, 12)
	for i := range 12 {
		go func() {
			<-start
			server := f.s
			if i%2 == 1 {
				server = replica
			}
			ctx, value := context.Background(), source.Value
			if i%3 != 0 {
				ctx = context.WithValue(ctx, apiAuthKey{}, apiAuth{hash: apiHash})
				value = ""
			}
			credential, err := server.sessionCredential(ctx, value)
			if err == nil && (credential.Kind != "oauth" || credential.Token != oauthAccess(1)) {
				err = errors.New("shared refresh returned wrong generation")
			}
			results <- err
		}()
	}
	close(start)
	for range 12 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatal("bearer and cookie cloned/raced OAuth refresh", f.calls.Load())
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_sessions").Scan(&count); err != nil || count != 1 {
		t.Fatal("delegation created another encrypted credential", err, count)
	}
	if response := apiRequest(replica, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 200 {
		t.Fatal("refreshed bearer unusable", response.Code)
	}
	var expires time.Time
	if err := f.db.QueryRow("SELECT expires_at FROM golf_sessions WHERE token_hash=$1", hash).Scan(&expires); err != nil || expires.Sub(source.Expires).Abs() > time.Millisecond {
		t.Fatal("refresh changed source absolute expiry", err)
	}
}

func TestApiCredentialMigrationExpiryRecoveryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	// Start from the historical schema and migrate forward. The latest PR
	// journal intentionally refuses downgrade; this test must not cross it.
	f.db = testDatabase(t)
	f.s.db = f.db
	provider, err := goose.NewProvider(goose.DialectPostgres, f.db, os.DirFS("database/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(t.Context(), 202610020004); err != nil {
		t.Fatal(err)
	}
	pat, oauth := f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")
	var before, after []byte
	query := `SELECT coalesce(json_agg(to_jsonb(s) - 'local_account_id' - 'local_credential_version' ORDER BY session_id)::text,'[]') FROM golf_sessions s`
	if err := f.db.QueryRow(query).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(query).Scan(&after); err != nil || !bytes.Equal(before, after) {
		t.Fatal("migration changed old sessions", err)
	}
	var linked int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_sessions WHERE local_account_id IS NOT NULL OR local_credential_version IS NOT NULL").Scan(&linked); err != nil || linked != 0 {
		t.Fatal("migration linked historical sessions to local credentials", err)
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_api_credential_events").Scan(&count); err != nil || count != 0 {
		t.Fatal("migration invented history", err)
	}
	client := apiManagementClient(t, f, pat)
	created := issueApiCredential(t, client, "survives recovery as metadata", 0)
	// An already expired delegated key cannot extend its still-live source.
	id, userID, hash := f.id(t, oauth)
	expiredToken := apiTokenPrefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	expiredHash, _ := apiTokenHash(expiredToken)
	if _, err := f.db.Exec(`INSERT INTO golf_api_credentials(user_id,token_hash,label,source_session_id,source_token_hash,created_at,expires_at) VALUES($1,$2,'expired',$3,$4,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second')`, userID, expiredHash, id, hash); err != nil {
		t.Fatal(err)
	}
	if response := apiRequest(f.s, expiredToken, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 401 {
		t.Fatal("expired API credential used live source", response.Code)
	}
	historyQuery := `SELECT json_build_object('credentials',(SELECT json_agg(c ORDER BY id) FROM golf_api_credentials c),'events',(SELECT json_agg(e ORDER BY id) FROM golf_api_credential_events e))::text`
	if err := f.db.QueryRow(historyQuery).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := InvalidateRestoredSessions(t.Context(), f.db, strings.Repeat("a", 32)); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(historyQuery).Scan(&after); err != nil || !bytes.Equal(before, after) {
		t.Fatal("recovery changed API metadata/events", err)
	}
	newSource := f.session(t, "alice", "pat")
	if response := apiRequest(f.s, created.Token, golfv1connect.SessionServiceGetSessionProcedure, `{}`); response.Code != 401 {
		t.Fatal("fresh login revived restored delegation", response.Code)
	}
	listed, err := apiManagementClient(t, f, newSource).ListApiCredentials(t.Context(), connect.NewRequest(&golfv1.ListApiCredentialsRequest{}))
	if err != nil || len(listed.Msg.Credentials) != 2 {
		t.Fatal("recovered metadata missing", err)
	}
	for _, row := range listed.Msg.Credentials {
		if row.SourceSessionActive {
			t.Fatal("restored source incorrectly active")
		}
	}
}

// Exercise real Connect routing so the procedure spec is supplied by the
// handler, rather than manufacturing an unexported spec in a unit test.
func TestSelfCredentialAcknowledgmentRouting(t *testing.T) {
	var checks atomic.Int64
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checks.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer forge.Close()
	s, err := New(testConfig(forge.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	operation := base64.RawURLEncoding.EncodeToString(make([]byte, 24))
	for _, method := range []string{"password", "email"} {
		for _, tc := range []struct {
			name, before, after, operation string
			count                          uint64
			requiresLogin, otherRoute      bool
			accepted                       bool
		}{
			{name: "verified receipt", before: "1", after: "2", operation: operation, count: 1, requiresLogin: true, accepted: true},
			{name: "wrong version", before: "1", after: "3", operation: operation, count: 1, requiresLogin: true},
			{name: "zero revoked sessions", before: "1", after: "2", operation: operation, requiresLogin: true},
			{name: "missing operation", before: "1", after: "2", count: 1, requiresLogin: true},
			{name: "wrong operation length", before: "1", after: "2", operation: "AA", count: 1, requiresLogin: true},
			{name: "noncanonical operation", before: "1", after: "2", operation: operation + "=", count: 1, requiresLogin: true},
			{name: "login not required", before: "1", after: "2", operation: operation, count: 1},
			{name: "noncanonical input version", before: "01", after: "2", operation: operation, count: 1, requiresLogin: true},
			{name: "version overflow", before: "9223372036854775807", after: "9223372036854775808", operation: operation, count: 1, requiresLogin: true},
			{name: "different route", before: "1", after: "2", operation: operation, count: 1, requiresLogin: true, otherRoute: true},
		} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				procedure := golfv1connect.AccountSecurityServiceChangeOwnPasswordProcedure
				if method == "email" {
					procedure = golfv1connect.AccountSecurityServiceChangeOwnLoginEmailProcedure
				}
				if tc.otherRoute {
					procedure = "/golf.v1.FutureService/Read"
				}
				option := connect.WithInterceptors(connect.UnaryInterceptorFunc(s.apiReadInterceptor))
				var handler http.Handler
				if method == "password" {
					handler = connect.NewUnaryHandler(procedure, func(context.Context, *connect.Request[golfv1.ChangeOwnPasswordRequest]) (*connect.Response[golfv1.ChangeOwnPasswordResponse], error) {
						return connect.NewResponse(&golfv1.ChangeOwnPasswordResponse{CredentialVersion: tc.after, OperationId: tc.operation, SessionsRevoked: tc.count, RequiresLogin: tc.requiresLogin}), nil
					}, option)
				} else {
					handler = connect.NewUnaryHandler(procedure, func(context.Context, *connect.Request[golfv1.ChangeOwnLoginEmailRequest]) (*connect.Response[golfv1.ChangeOwnLoginEmailResponse], error) {
						return connect.NewResponse(&golfv1.ChangeOwnLoginEmailResponse{CredentialVersion: tc.after, OperationId: tc.operation, SessionsRevoked: tc.count, RequiresLogin: tc.requiresLogin}), nil
					}, option)
				}
				request := httptest.NewRequest(http.MethodPost, procedure, strings.NewReader(`{"expectedCredentialVersion":"`+tc.before+`"}`))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Connect-Protocol-Version", "1")
				request = request.WithContext(context.WithValue(request.Context(), sessionTokenKey{}, forgeCredential{Token: "revoked-fixture-credential", Kind: "pat", Local: true}))
				prior := checks.Load()
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if tc.accepted {
					if response.Code != http.StatusOK || checks.Load() != prior {
						t.Fatalf("verified acknowledgment failed: status %d native checks %d", response.Code, checks.Load()-prior)
					}
				} else if response.Code != http.StatusUnauthorized || checks.Load() != prior+1 {
					t.Fatalf("invalid acknowledgment bypassed authority: status %d native checks %d", response.Code, checks.Load()-prior)
				}
			})
		}
	}
}
