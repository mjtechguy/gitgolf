package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
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

type managementFixture struct {
	s       *Server
	db      *sql.DB
	mode    atomic.Int32 // 1: different immutable ID; 2: revoked; 3: wait in provider.
	entered chan struct{}
	resume  chan struct{}
}

func newManagementFixture(t *testing.T) *managementFixture {
	t.Helper()
	f := &managementFixture{db: testDatabase(t), entered: make(chan struct{}, 8), resume: make(chan struct{})}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/version" {
			fmt.Fprint(w, `{"version":"1.27.3"}`)
			return
		}
		if r.URL.Path != "/api/v1/user" {
			w.WriteHeader(404)
			return
		}
		user := User{ID: 42, Login: "alice"}
		switch r.Header.Get("Authorization") {
		case "token alice-management-token", "Bearer alice-management-oauth":
		case "token bob-management-token":
			user.ID, user.Login = 84, "bob"
		default:
			w.WriteHeader(401)
			return
		}
		switch f.mode.Load() {
		case 1:
			user.ID = 999 // An unchanged login string must not establish ownership.
		case 2:
			w.WriteHeader(401)
			return
		case 3:
			f.entered <- struct{}{}
			select {
			case <-f.resume:
			case <-r.Context().Done():
				return
			}
		}
		_ = json.NewEncoder(w).Encode(user)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(func() {
		select {
		case <-f.resume:
		default:
			close(f.resume)
		}
	})
	config := testConfig(provider.URL)
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *managementFixture) session(t *testing.T, name, kind string) loginResult {
	t.Helper()
	user := User{ID: 42, Login: name}
	if name == "bob" {
		user.ID = 84
	}
	payload := name + "-management-token"
	if kind == "oauth" {
		payload = encodeOAuth(oauthEnvelope{Version: 1, AccessToken: "alice-management-oauth", RefreshToken: "fixture-refresh", Expiry: time.Now().Add(time.Hour), Verified: true})
	}
	result, err := f.s.createSession(context.Background(), user, kind, payload, "")
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *managementFixture) client(t *testing.T, session loginResult) golfv1connect.SessionServiceClient {
	t.Helper()
	client, _, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return client
}

func (f *managementFixture) id(t *testing.T, session loginResult) (int64, int64, []byte) {
	t.Helper()
	hash, _ := sessionHash(session.Value)
	var id, userID int64
	if err := f.db.QueryRow("SELECT session_id,user_id FROM golf_sessions WHERE token_hash=$1", hash).Scan(&id, &userID); err != nil {
		t.Fatal(err)
	}
	return id, userID, hash
}

func managementToken() forgeCredential {
	return forgeCredential{Kind: "pat", Token: "alice-management-token"}
}

func TestSessionManagementBoundary(t *testing.T) {
	s, err := New(testConfig("http://forgejo.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.SessionServiceListSessionsProcedure, golfv1connect.SessionServiceRevokeSessionProcedure, golfv1connect.SessionServiceRevokeOtherSessionsProcedure} {
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			request := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("malformed"))
			request.Header.Set("Origin", origin)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Connect-Protocol-Version", "1")
			response := httptest.NewRecorder()
			s.ServeHTTP(response, request)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if response.Code != want || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("session management decoded before auth/origin or lost no-store", response.Code)
			}
		}
	}
}

func TestSessionManagementRPCPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	current := f.session(t, "alice", "pat")
	other := f.session(t, "alice", "oauth")
	bob := f.session(t, "bob", "pat")
	expired := f.session(t, "alice", "pat")
	expiredID, _, expiredHash := f.id(t, expired)
	if _, err := f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", expiredHash); err != nil {
		t.Fatal(err)
	}
	currentID, _, _ := f.id(t, current)
	otherID, _, _ := f.id(t, other)
	bobID, _, _ := f.id(t, bob)
	client := f.client(t, current)
	listed, err := client.ListSessions(ctx, connect.NewRequest(&golfv1.ListSessionsRequest{Page: &golfv1.PageRequest{Limit: 1}}))
	if err != nil || len(listed.Msg.Sessions) != 1 || listed.Msg.Page.NextPage != 2 {
		t.Fatal("first bounded page", err)
	}
	row := listed.Msg.Sessions[0]
	if row.Id != strconv.FormatInt(otherID, 10) || row.Current || row.CredentialKind != "oauth" || row.CreatedAt == "" || row.ExpiresAt == "" {
		t.Fatal("wrong public session metadata")
	}
	if listed.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("session metadata was cacheable")
	}
	raw, err := protojson.Marshal(listed.Msg)
	if err != nil || bytes.Contains(raw, []byte(current.Value)) || bytes.Contains(raw, []byte("management-token")) {
		t.Fatal("session response leaked a credential")
	}
	var public map[string]json.RawMessage
	rowJSON, _ := protojson.Marshal(row)
	if err := json.Unmarshal(rowJSON, &public); err != nil {
		t.Fatal(err)
	}
	for field := range public {
		if field != "id" && field != "createdAt" && field != "expiresAt" && field != "current" && field != "credentialKind" {
			t.Fatal("unexpected session disclosure", field)
		}
	}
	second, err := client.ListSessions(ctx, connect.NewRequest(&golfv1.ListSessionsRequest{Page: &golfv1.PageRequest{Page: 2, Limit: 1}}))
	if err != nil || len(second.Msg.Sessions) != 1 || second.Msg.Page.NextPage != 0 || !second.Msg.Sessions[0].Current || second.Msg.Sessions[0].Id != strconv.FormatInt(currentID, 10) {
		t.Fatal("second page/current marker", err)
	}
	for _, page := range []*golfv1.PageRequest{{Page: 10001}, {Limit: 101}} {
		if _, err := client.ListSessions(ctx, connect.NewRequest(&golfv1.ListSessionsRequest{Page: page})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("pagination bounds", err)
		}
	}
	for _, id := range []string{"", "0", "-1", "+1", "01", " 1", "1.0", "9223372036854775808"} {
		if _, err := client.RevokeSession(ctx, connect.NewRequest(&golfv1.RevokeSessionRequest{SessionId: id})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("noncanonical session handle accepted", err)
		}
	}
	for _, id := range []int64{bobID, expiredID, 9223372036854775807} {
		if _, err := client.RevokeSession(ctx, connect.NewRequest(&golfv1.RevokeSessionRequest{SessionId: strconv.FormatInt(id, 10)})); connect.CodeOf(err) != connect.CodeNotFound {
			t.Fatal("foreign/expired/missing handle disclosed", err)
		}
	}
	revoked, err := client.RevokeSession(ctx, connect.NewRequest(&golfv1.RevokeSessionRequest{SessionId: strconv.FormatInt(otherID, 10)}))
	if err != nil || revoked.Msg.CurrentSessionRevoked || revoked.Header().Get("Set-Cookie") != "" {
		t.Fatal("other-session revoke", err)
	}
	if _, err := f.client(t, other).ListSessions(ctx, connect.NewRequest(&golfv1.ListSessionsRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("revoked OAuth cookie replay accepted", err)
	}
	if _, err := client.RevokeSession(ctx, connect.NewRequest(&golfv1.RevokeSessionRequest{SessionId: strconv.FormatInt(otherID, 10)})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("repeated revocation leaked deleted session", err)
	}
	f.session(t, "alice", "pat")
	f.session(t, "alice", "oauth")
	bulk, err := client.RevokeOtherSessions(ctx, connect.NewRequest(&golfv1.RevokeOtherSessionsRequest{}))
	if err != nil || bulk.Msg.RevokedCount != 2 {
		t.Fatal("bulk count/current preservation", err)
	}
	bulk, err = client.RevokeOtherSessions(ctx, connect.NewRequest(&golfv1.RevokeOtherSessionsRequest{}))
	if err != nil || bulk.Msg.RevokedCount != 0 {
		t.Fatal("empty bulk must be idempotent", err)
	}
	if _, err := f.client(t, bob).ListSessions(ctx, connect.NewRequest(&golfv1.ListSessionsRequest{})); err != nil {
		t.Fatal("another account was revoked", err)
	}
	revoked, err = client.RevokeSession(ctx, connect.NewRequest(&golfv1.RevokeSessionRequest{SessionId: strconv.FormatInt(currentID, 10)}))
	if err != nil || !revoked.Msg.CurrentSessionRevoked {
		t.Fatal("current-session revoke", err)
	}
	cookies := (&http.Response{Header: revoked.Header()}).Cookies()
	if len(cookies) != 1 || cookies[0].Name != cookieName || cookies[0].MaxAge != -1 || cookies[0].Value != "" {
		t.Fatal("current revoke did not clear cookie")
	}
	if _, err := f.client(t, current).ListSessions(ctx, connect.NewRequest(&golfv1.ListSessionsRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("current cookie replay accepted", err)
	}
}

func TestSessionManagementSQLScopesPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	current, other := f.session(t, "alice", "pat"), f.session(t, "alice", "pat")
	bob := f.session(t, "bob", "pat")
	_, aliceID, hash := f.id(t, current)
	otherID, _, _ := f.id(t, other)
	_, bobID, bobHash := f.id(t, bob)
	config := f.s.config
	config.ForgeURL += "/another-forge"
	config.ForgeOAuthClientID, config.ForgeOAuthClientSecret, config.ForgePublicURL = "", "", ""
	another, err := New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := another.createSession(ctx, User{ID: 42, Login: "alice"}, "pat", "alice-management-token", "")
	if err != nil {
		t.Fatal(err)
	}
	foreignID, _, foreignHash := f.id(t, foreign)
	queries := database.New(f.db)
	for _, test := range []struct {
		hash []byte
		user int64
		url  string
	}{{hash, bobID, f.s.config.ForgeURL}, {bobHash, aliceID, f.s.config.ForgeURL}, {hash, aliceID, config.ForgeURL}, {foreignHash, aliceID, f.s.config.ForgeURL}, {bytes.Repeat([]byte{9}, 32), aliceID, f.s.config.ForgeURL}} {
		rows, err := queries.ListManagedSessions(ctx, database.ListManagedSessionsParams{CallerTokenHash: test.hash, UserID: test.user, ForgeURL: test.url, RowLimit: 100})
		if err != nil || len(rows) != 0 {
			t.Fatal("SQL list escaped caller/user/forge scope", err)
		}
		count, err := queries.RevokeManagedSession(ctx, database.RevokeManagedSessionParams{CallerTokenHash: test.hash, UserID: test.user, ForgeURL: test.url, SessionID: otherID})
		if err != nil || count != 0 {
			t.Fatal("SQL targeted revoke escaped ownership", err)
		}
		count, err = queries.RevokeOtherManagedSessions(ctx, database.RevokeOtherManagedSessionsParams{CallerTokenHash: test.hash, UserID: test.user, ForgeURL: test.url})
		if err != nil || count != 0 {
			t.Fatal("SQL bulk revoke escaped ownership", err)
		}
	}
	if _, err := f.s.revokeSession(ctx, current.Value, managementToken(), strconv.FormatInt(foreignID, 10)); !errors.Is(err, errResourceNotFound) {
		t.Fatal("same upstream ID on another forge was accessible", err)
	}
	count, err := f.s.revokeOtherSessions(ctx, current.Value, managementToken())
	if err != nil || count != 1 {
		t.Fatal("bulk crossed forge boundary", err)
	}
	if _, err := another.sessionCredential(ctx, foreign.Value); err != nil {
		t.Fatal("foreign forge cookie was revoked", err)
	}
}

func TestSessionManagementPageCeilingPostgres(t *testing.T) {
	f := newManagementFixture(t)
	current := f.session(t, "alice", "pat")
	_, userID, hash := f.id(t, current)
	// limit=1 reaches the real bounded query's last page with only 10,001
	// metadata rows. The extra credentials are inert fixture bytes, never read.
	if _, err := f.db.Exec(`INSERT INTO golf_sessions(token_hash,user_id,encrypted_token,expires_at)
SELECT sha256(convert_to('page-limit-fixture-' || n::text, 'UTF8')), $1, $2, clock_timestamp()+interval '1 hour'
FROM generate_series(1,10000) n`, userID, []byte("inert metadata fixture")); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, current)
	page := connect.NewRequest(&golfv1.ListSessionsRequest{Page: &golfv1.PageRequest{Page: 10000, Limit: 1}})
	if response, err := client.ListSessions(context.Background(), page); connect.CodeOf(err) != connect.CodeInvalidArgument || response != nil || !strings.Contains(err.Error(), "10000-page limit") {
		t.Fatal("last-page overflow was silently represented as complete", err)
	}
	if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE session_id=(SELECT min(session_id) FROM golf_sessions WHERE token_hash<>$1)", hash); err != nil {
		t.Fatal(err)
	}
	// A new request prevents net/http cookie-jar additions from accumulating
	// in the reused request header and tripping the duplicate-cookie guard.
	page = connect.NewRequest(&golfv1.ListSessionsRequest{Page: &golfv1.PageRequest{Page: 10000, Limit: 1}})
	response, err := client.ListSessions(context.Background(), page)
	if err != nil || len(response.Msg.Sessions) != 1 || response.Msg.Page.NextPage != 0 {
		t.Fatal("exact page ceiling should remain readable", err)
	}
}

func TestSessionManagementProviderIdentityPostgres(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		for _, mode := range []int32{1, 2} {
			t.Run(fmt.Sprintf("%s-mode%d", kind, mode), func(t *testing.T) {
				f := newManagementFixture(t)
				current, other := f.session(t, "alice", kind), f.session(t, "alice", "pat")
				otherID, _, _ := f.id(t, other)
				client := f.client(t, current)
				f.mode.Store(mode)
				if _, err := client.ListSessions(context.Background(), connect.NewRequest(&golfv1.ListSessionsRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
					t.Fatal("wrong/revoked provider identity could list", err)
				}
				if _, err := client.RevokeSession(context.Background(), connect.NewRequest(&golfv1.RevokeSessionRequest{SessionId: strconv.FormatInt(otherID, 10)})); connect.CodeOf(err) != connect.CodeUnauthenticated {
					t.Fatal("wrong/revoked provider identity could revoke", err)
				}
				if _, err := client.RevokeOtherSessions(context.Background(), connect.NewRequest(&golfv1.RevokeOtherSessionsRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
					t.Fatal("wrong/revoked provider identity could bulk revoke", err)
				}
				var count int
				if err := f.db.QueryRow("SELECT count(*) FROM golf_sessions").Scan(&count); err != nil || count != 2 {
					t.Fatal("denied operation changed sessions", err)
				}
			})
		}
	}
}

func waitManagementLock(t *testing.T, db *sql.DB, query string, count int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		if err := db.QueryRow("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1", "-- name: "+query+"%").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= count {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("operation never reached expected database lock", query)
}

func TestSessionManagementWaitRechecksPostgres(t *testing.T) {
	for _, wait := range []string{"provider-expiry", "provider-revoked", "identity-expiry", "caller-expiry", "target-expiry"} {
		t.Run(wait, func(t *testing.T) {
			f := newManagementFixture(t)
			current, other := f.session(t, "alice", "pat"), f.session(t, "alice", "pat")
			_, userID, hash := f.id(t, current)
			_, _, otherHash := f.id(t, other)
			var expires time.Time
			if err := f.db.QueryRow("UPDATE golf_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1 RETURNING expires_at", hash).Scan(&expires); err != nil {
				t.Fatal(err)
			}
			var held *sql.Tx
			if strings.HasPrefix(wait, "provider-") {
				f.mode.Store(3)
			} else {
				var err error
				held, err = f.db.Begin()
				if err != nil {
					t.Fatal(err)
				}
				defer held.Rollback()
				if wait == "identity-expiry" {
					_, err = held.Exec("SELECT id FROM golf_users WHERE id=$1 FOR UPDATE", userID)
				} else {
					target := hash
					if wait == "target-expiry" {
						target = otherHash
					}
					_, err = held.Exec("SELECT token_hash FROM golf_sessions WHERE token_hash=$1 FOR UPDATE", target)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := f.s.revokeOtherSessions(ctx, current.Value, managementToken()); done <- err }()
			switch wait {
			case "provider-expiry", "provider-revoked":
				select {
				case <-f.entered:
				case <-ctx.Done():
					t.Fatal("provider did not block")
				}
			case "identity-expiry":
				waitManagementLock(t, f.db, "LockSessionUser", 1)
			case "caller-expiry":
				waitManagementLock(t, f.db, "LockManagedSession", 1)
			case "target-expiry":
				waitManagementLock(t, f.db, "RevokeOtherManagedSessions", 1)
			}
			if wait == "provider-revoked" {
				if _, err := f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash); err != nil {
					t.Fatal(err)
				}
			} else {
				time.Sleep(time.Until(expires) + 20*time.Millisecond)
			}
			if held != nil {
				if err := held.Commit(); err != nil {
					t.Fatal(err)
				}
			} else {
				close(f.resume)
			}
			if err := <-done; !errors.Is(err, errUnauthenticated) {
				t.Fatal("wait allowed stale caller authority", err)
			}
			var remaining int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_sessions WHERE token_hash=$1", otherHash).Scan(&remaining); err != nil || remaining != 1 {
				t.Fatal("expired/revoked caller committed a deletion", err)
			}
		})
	}
}

func TestSessionManagementConcurrentBulkPostgres(t *testing.T) {
	f := newManagementFixture(t)
	a, b := f.session(t, "alice", "pat"), f.session(t, "alice", "pat")
	_, userID, _ := f.id(t, a)
	held, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err := held.Exec("SELECT id FROM golf_users WHERE id=$1 FOR UPDATE", userID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type outcome struct {
		count uint64
		err   error
	}
	done := make(chan outcome, 2)
	for _, session := range []loginResult{a, b} {
		go func() {
			count, err := f.s.revokeOtherSessions(ctx, session.Value, managementToken())
			done <- outcome{count, err}
		}()
	}
	waitManagementLock(t, f.db, "LockSessionUser", 2)
	// Neither contender may hold a session before obtaining the identity lock.
	probe, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Rollback()
	if _, err := probe.ExecContext(ctx, "SELECT session_id FROM golf_sessions WHERE user_id=$1 FOR UPDATE NOWAIT", userID); err != nil {
		t.Fatal("account operation locked a session before the identity", err)
	}
	if err := probe.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := held.Commit(); err != nil {
		t.Fatal(err)
	}
	winners, denied := 0, 0
	for range 2 {
		result := <-done
		if result.err == nil && result.count == 1 {
			winners++
		} else if errors.Is(result.err, errUnauthenticated) && result.count == 0 {
			denied++
		} else {
			t.Fatal("bulk race did not serialize safely", result.err)
		}
	}
	if winners != 1 || denied != 1 {
		t.Fatal("bulk race must preserve exactly its winning caller")
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_sessions").Scan(&count); err != nil || count != 1 {
		t.Fatal("bulk race lost surviving caller", err)
	}
}

func TestSessionManagementCommitRollbackPostgres(t *testing.T) {
	f := newManagementFixture(t)
	current := f.session(t, "alice", "pat")
	f.session(t, "alice", "pat")
	f.session(t, "alice", "oauth")
	if _, err := f.db.Exec(`CREATE FUNCTION reject_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test commit failure'; END $$;
CREATE CONSTRAINT TRIGGER reject_session_delete AFTER DELETE ON golf_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_session_delete()`); err != nil {
		t.Fatal(err)
	}
	if count, err := f.s.revokeOtherSessions(context.Background(), current.Value, managementToken()); !errors.Is(err, errStorageUnavailable) || count != 0 {
		t.Fatal("commit failure reported revoked sessions", err)
	}
	var count int
	if err := f.db.QueryRow("SELECT count(*) FROM golf_sessions").Scan(&count); err != nil || count != 3 {
		t.Fatal("commit failure did not restore every session", err)
	}
	if err := f.db.QueryRow("SELECT count(*) FROM golf_audit_events").Scan(&count); err != nil || count != 3 {
		t.Fatal("commit failure retained a false successful audit event", err)
	}
}

func TestSessionManagementMigrationPreservesCredentialsPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	provider, err := goose.NewProvider(goose.DialectPostgres, f.db, os.DirFS("database/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.DownTo(ctx, 202610010001); err != nil {
		t.Fatal(err)
	}
	pat, oauth := legacyManagementSession(t, f, "alice", "pat"), legacyManagementSession(t, f, "alice", "oauth")
	type retained struct {
		hash, encrypted  []byte
		created, expires time.Time
		kind             string
	}
	before := []retained{}
	for _, session := range []loginResult{pat, oauth} {
		hash, _ := sessionHash(session.Value)
		row := retained{hash: hash}
		if err := f.db.QueryRow("SELECT encrypted_token,created_at,expires_at,credential_kind FROM golf_sessions WHERE token_hash=$1", hash).Scan(&row.encrypted, &row.created, &row.expires, &row.kind); err != nil {
			t.Fatal(err)
		}
		before = append(before, row)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	ids := map[int64]bool{}
	for _, old := range before {
		var id int64
		row := retained{}
		if err := f.db.QueryRow("SELECT session_id,encrypted_token,created_at,expires_at,credential_kind FROM golf_sessions WHERE token_hash=$1", old.hash).Scan(&id, &row.encrypted, &row.created, &row.expires, &row.kind); err != nil {
			t.Fatal(err)
		}
		if id <= 0 || ids[id] || !bytes.Equal(old.encrypted, row.encrypted) || !old.created.Equal(row.created) || !old.expires.Equal(row.expires) || old.kind != row.kind {
			t.Fatal("session-handle migration changed an existing credential or lifetime")
		}
		ids[id] = true
	}
	for _, session := range []loginResult{pat, oauth} {
		if _, err := f.client(t, session).ListSessions(ctx, connect.NewRequest(&golfv1.ListSessionsRequest{})); err != nil {
			t.Fatal("existing cookie failed after session-handle migration", err)
		}
	}
	if _, err := provider.DownTo(ctx, 202610010001); err != nil {
		t.Fatal(err)
	}
	for _, session := range []loginResult{pat, oauth} {
		// Read the previous release's columns after deliberately downgrading;
		// the current runtime requires the later explicit key-ID migration.
		hash, _ := sessionHash(session.Value)
		var encrypted []byte
		if err := f.db.QueryRow("SELECT encrypted_token FROM golf_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()", hash).Scan(&encrypted); err != nil {
			t.Fatal("session-handle downgrade lost preserved credentials", err)
		}
		if _, err := f.s.keyring.open("legacy", sessionDomain, encrypted, hash); err != nil {
			t.Fatal("session-handle downgrade changed legacy ciphertext", err)
		}
	}
}
