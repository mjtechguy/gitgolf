package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"github.com/pressly/goose/v3"
	"google.golang.org/protobuf/encoding/protojson"
)

func auditClient(t *testing.T, f *managementFixture, session loginResult) golfv1connect.AuditServiceClient {
	t.Helper()
	_, _, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return golfv1connect.NewAuditServiceClient(transport, origin.String()+"/rpc", connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
			request.Header().Set("Origin", f.s.config.PublicURL)
			return next(ctx, request)
		}
	})))
}

func readAudit(t *testing.T, client golfv1connect.AuditServiceClient) *golfv1.ListAuditEventsResponse {
	t.Helper()
	response, err := client.ListAuditEvents(context.Background(), connect.NewRequest(&golfv1.ListAuditEventsRequest{Limit: 100}))
	if err != nil {
		t.Fatal(err)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("audit history was cacheable")
	}
	return response.Msg
}

func TestAuditBoundary(t *testing.T) {
	s, err := New(testConfig("http://gitea.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
		r := httptest.NewRequest("POST", "/rpc"+golfv1connect.AuditServiceListAuditEventsProcedure, strings.NewReader("malformed"))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("audit body decoded before origin/session boundary", w.Code)
		}
	}
}

func TestAuditLifecyclePostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	alice := f.session(t, "alice", "pat")
	aliceID, _, _ := f.id(t, alice)
	other := f.session(t, "alice", "oauth")
	otherID, _, _ := f.id(t, other)
	bob := f.session(t, "bob", "pat")
	bobID, _, _ := f.id(t, bob)
	if _, err := f.s.revokeSession(ctx, alice.Value, managementToken(), strconv.FormatInt(otherID, 10)); err != nil {
		t.Fatal(err)
	}
	f.session(t, "alice", "pat")
	for _, expected := range []uint64{1, 0} {
		if count, err := f.s.revokeOtherSessions(ctx, alice.Value, managementToken()); err != nil || count != expected {
			t.Fatal("audited bulk count", err)
		}
	}
	replacement, err := f.s.loginSession(ctx, "alice-management-token", alice.Value)
	if err != nil {
		t.Fatal(err)
	}
	replacementID, _, _ := f.id(t, replacement)
	rows := readAudit(t, auditClient(t, f, replacement)).Events
	if len(rows) != 8 || rows[0].Action != golfv1.AuditAction_AUDIT_ACTION_SIGN_IN || rows[1].Action != golfv1.AuditAction_AUDIT_ACTION_SESSION_REPLACED || rows[0].OperationId != rows[1].OperationId {
		t.Fatal("same-account replacement must commit both related events")
	}
	if rows[1].ActorSessionId != strconv.FormatInt(aliceID, 10) || rows[1].TargetSessionId != rows[1].ActorSessionId || rows[0].ActorSessionId != strconv.FormatInt(replacementID, 10) {
		t.Fatal("replacement session handles incorrect")
	}
	if rows[2].Action != golfv1.AuditAction_AUDIT_ACTION_OTHER_SESSIONS_REVOKED || rows[2].RevokedCount != 0 || rows[3].RevokedCount != 1 || rows[2].TargetSessionId != "" {
		t.Fatal("bulk zero/nonzero events lost native outcome")
	}
	for _, row := range rows {
		if len(row.OperationId) != 32 || (row.ExpiresAt != nil) != (row.Action == golfv1.AuditAction_AUDIT_ACTION_SIGN_IN) {
			t.Fatal("operation/expiry semantics incorrect")
		}
		if row.ActorSessionId == strconv.FormatInt(bobID, 10) || row.TargetSessionId == strconv.FormatInt(bobID, 10) {
			t.Fatal("foreign session appeared in account history")
		}
	}
	cross, err := f.s.loginSession(ctx, "bob-management-token", replacement.Value)
	if err != nil {
		t.Fatal(err)
	}
	aliceAgain := f.session(t, "alice", "oauth")
	aliceRows := readAudit(t, auditClient(t, f, aliceAgain)).Events
	bobRows := readAudit(t, auditClient(t, f, cross)).Events
	if aliceRows[1].Action != golfv1.AuditAction_AUDIT_ACTION_SESSION_REPLACED || aliceRows[1].OperationId == bobRows[0].OperationId || aliceRows[1].TargetSessionId != strconv.FormatInt(replacementID, 10) || len(bobRows) != 2 {
		t.Fatal("cross-account replacement leaked identity/correlation or history")
	}
	// Logout remains available after upstream revocation and is idempotent.
	f.mode.Store(2)
	for _, value := range []string{cross.Value, cross.Value, "", "malformed"} {
		if err := f.s.logoutSession(ctx, value); err != nil {
			t.Fatal("local logout depended on provider or duplicate event", err)
		}
	}
	f.mode.Store(0)
	bobAgain := f.session(t, "bob", "pat")
	bobRows = readAudit(t, auditClient(t, f, bobAgain)).Events
	if len(bobRows) != 4 || bobRows[1].Action != golfv1.AuditAction_AUDIT_ACTION_SIGN_OUT {
		t.Fatal("durable sign-out absent or duplicated")
	}
	raw, _ := protojson.Marshal(readAudit(t, auditClient(t, f, aliceAgain)))
	for _, secret := range []string{alice.Value, other.Value, "management-token", "refresh", "tokenHash", "encrypted", "ipAddress", "userAgent", "forgeUrl"} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("audit returned secret/uncontracted identity field")
		}
	}
}

func TestAuditStableCursorAndScopingPostgres(t *testing.T) {
	f := newManagementFixture(t)
	if _, err := f.db.Exec("ALTER SEQUENCE golf_audit_events_id_seq RESTART WITH 9007199254740993"); err != nil {
		t.Fatal(err)
	}
	alice := f.session(t, "alice", "pat")
	client := auditClient(t, f, alice)
	for range 4 {
		if _, err := f.s.revokeOtherSessions(context.Background(), alice.Value, managementToken()); err != nil {
			t.Fatal(err)
		}
	}
	first, err := client.ListAuditEvents(context.Background(), connect.NewRequest(&golfv1.ListAuditEventsRequest{Limit: 2}))
	if err != nil || len(first.Msg.Events) != 2 || first.Msg.SnapshotId != "9007199254740997" || first.Msg.NextBeforeId != "9007199254740996" {
		t.Fatal("bounded opaque first snapshot", err)
	}
	f.session(t, "alice", "oauth") // A newer committed event must not enter this export.
	bob := f.session(t, "bob", "pat")
	bobSnapshot := readAudit(t, auditClient(t, f, bob)).SnapshotId
	before := first.Msg.NextBeforeId
	seen := map[string]bool{}
	for _, row := range first.Msg.Events {
		seen[row.Id] = true
	}
	for before != "" {
		response, err := client.ListAuditEvents(context.Background(), connect.NewRequest(&golfv1.ListAuditEventsRequest{Limit: 2, BeforeId: before, SnapshotId: first.Msg.SnapshotId}))
		if err != nil || response.Msg.SnapshotId != first.Msg.SnapshotId {
			t.Fatal("stable continuation", err)
		}
		for _, row := range response.Msg.Events {
			if seen[row.Id] || row.Id > first.Msg.SnapshotId {
				t.Fatal("cursor duplicated or admitted a newer record")
			}
			seen[row.Id] = true
		}
		before = response.Msg.NextBeforeId
	}
	if len(seen) != 5 || len(readAudit(t, client).Events) != 6 {
		t.Fatal("snapshot export lost records or refresh missed new event")
	}
	for _, request := range []*golfv1.ListAuditEventsRequest{
		{Limit: 101}, {BeforeId: "1"}, {SnapshotId: "01"}, {SnapshotId: "0"}, {SnapshotId: "+1"}, {SnapshotId: "9223372036854775808"},
		{SnapshotId: "2", BeforeId: "3"}, {SnapshotId: "9223372036854775807"}, {SnapshotId: bobSnapshot}, {SnapshotId: first.Msg.SnapshotId, BeforeId: "1"},
	} {
		response, err := client.ListAuditEvents(context.Background(), connect.NewRequest(request))
		if response != nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("unbound/noncanonical cursor exposed history", err)
		}
	}
	// SQL predicates also bind caller, user and forge; domain guards are not
	// the only protection against a mismatched internal query parameter.
	_, aliceUser, hash := f.id(t, alice)
	_, bobUser, _ := f.id(t, bob)
	queries := database.New(f.db)
	for _, params := range []database.ListAuditEventsParams{
		{UserID: bobUser, ForgeURL: f.s.config.GiteaURL, CallerTokenHash: hash, SnapshotID: 9223372036854775807, RowLimit: 100},
		{UserID: aliceUser, ForgeURL: "https://other.invalid", CallerTokenHash: hash, SnapshotID: 9223372036854775807, RowLimit: 100},
	} {
		rows, err := queries.ListAuditEvents(context.Background(), params)
		if err != nil || len(rows) != 0 {
			t.Fatal("SQL account/forge/caller boundary", err)
		}
	}
}

func TestAuditMutationRollbackPostgres(t *testing.T) {
	for _, operation := range []string{"login", "logout", "revoke", "bulk", "replacement", "cross-replacement"} {
		t.Run(operation, func(t *testing.T) {
			f := newManagementFixture(t)
			current := f.session(t, "alice", "pat")
			other := f.session(t, "alice", "oauth")
			otherID, _, _ := f.id(t, other)
			body := "RAISE EXCEPTION 'test audit failure';"
			if strings.Contains(operation, "replacement") {
				// Fail the second event after the old session's replacement event
				// has been inserted, proving partial history also rolls back.
				body = "IF NEW.action = 'SIGN_IN' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW;"
			}
			if _, err := f.db.Exec("CREATE FUNCTION reject_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " + body + ` END $$;
CREATE TRIGGER reject_audit_insert BEFORE INSERT ON golf_audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_insert()`); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			var err error
			switch operation {
			case "login":
				_, err = f.s.loginSession(ctx, "alice-management-token", "")
			case "logout":
				err = f.s.logoutSession(ctx, current.Value)
			case "revoke":
				_, err = f.s.revokeSession(ctx, current.Value, managementToken(), strconv.FormatInt(otherID, 10))
			case "bulk":
				_, err = f.s.revokeOtherSessions(ctx, current.Value, managementToken())
			case "replacement":
				_, err = f.s.loginSession(ctx, "alice-management-token", current.Value)
			case "cross-replacement":
				_, err = f.s.loginSession(ctx, "bob-management-token", current.Value)
			}
			if !errors.Is(err, errStorageUnavailable) {
				t.Fatal("audit failure was not surfaced safely", err)
			}
			var sessions, events, users int
			if err := f.db.QueryRow("SELECT (SELECT count(*) FROM golf_sessions),(SELECT count(*) FROM golf_audit_events),(SELECT count(*) FROM golf_users)").Scan(&sessions, &events, &users); err != nil || sessions != 2 || events != 2 || users != 1 {
				t.Fatal("audit failure did not roll back complete session operation", err)
			}
			for _, session := range []loginResult{current, other} {
				if _, err := f.s.sessionCredential(ctx, session.Value); err != nil {
					t.Fatal("rollback invalidated existing cookie", err)
				}
			}
		})
	}
}

// Seed the previous release's session format through Golf's own schema, without
// running the new audited login code against a deliberately downgraded schema.
func legacyManagementSession(t *testing.T, f *managementFixture, name, kind string) loginResult {
	t.Helper()
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	value := base64.RawURLEncoding.EncodeToString(random)
	hash, _ := sessionHash(value)
	user := User{ID: 42, Login: name}
	payload := name + "-management-token"
	if kind == "oauth" {
		payload = encodeOAuth(oauthEnvelope{Version: 1, AccessToken: "alice-management-oauth", RefreshToken: "fixture-refresh", Expiry: time.Now().Add(time.Hour), Verified: true})
	}
	expires := time.Now().Add(time.Hour)
	q := database.New(f.db)
	id, err := q.UpsertUser(context.Background(), database.UpsertUserParams{ForgeURL: f.s.config.GiteaURL, ForgeUserID: user.ID, Login: user.Login})
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateSession(context.Background(), database.CreateSessionParams{TokenHash: hash, UserID: id, EncryptedToken: f.s.seal(payload, hash), ExpiresAt: expires, CredentialKind: kind}); err != nil {
		t.Fatal(err)
	}
	return loginResult{User: user, Value: value, Expires: expires}
}

func TestAuditMigrationRetentionAndGuardPostgres(t *testing.T) {
	f := newManagementFixture(t)
	ctx := context.Background()
	provider, err := goose.NewProvider(goose.DialectPostgres, f.db, os.DirFS("database/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.DownTo(ctx, 202610010002); err != nil {
		t.Fatal(err)
	}
	pat, oauth := legacyManagementSession(t, f, "alice", "pat"), legacyManagementSession(t, f, "alice", "oauth")
	patID, _, _ := f.id(t, pat)
	oauthID, _, _ := f.id(t, oauth)
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, session := range []loginResult{pat, oauth} {
		response := readAudit(t, auditClient(t, f, session))
		if len(response.Events) != 0 || response.SnapshotId != "" || response.NextBeforeId != "" {
			t.Fatal("migration invented historic activity")
		}
	}
	if id, _, _ := f.id(t, pat); id != patID {
		t.Fatal("migration changed existing PAT session ID")
	}
	if id, _, _ := f.id(t, oauth); id != oauthID {
		t.Fatal("migration changed existing OAuth session ID")
	}
	if err := f.s.logoutSession(ctx, pat.Value); err != nil {
		t.Fatal(err)
	}
	before := readAudit(t, auditClient(t, f, oauth))
	f.s, err = New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	after := readAudit(t, auditClient(t, f, oauth))
	if len(after.Events) != 1 || after.Events[0].Action != golfv1.AuditAction_AUDIT_ACTION_SIGN_OUT || after.SnapshotId != before.SnapshotId {
		t.Fatal("restart/session deletion lost durable event")
	}
	for _, statement := range []string{"UPDATE golf_audit_events SET credential_kind='pat'", "DELETE FROM golf_audit_events", "TRUNCATE golf_audit_events"} {
		if _, err := f.db.Exec(statement); err == nil {
			t.Fatal("append-only guard accepted mutation")
		}
	}
	if len(readAudit(t, auditClient(t, f, oauth)).Events) != 1 {
		t.Fatal("guard failed to preserve history")
	}
}

func TestAuditIdentityAndWaitPostgres(t *testing.T) {
	for _, mode := range []int32{1, 2} {
		f := newManagementFixture(t)
		client := auditClient(t, f, f.session(t, "alice", "pat"))
		f.mode.Store(mode)
		if _, err := client.ListAuditEvents(context.Background(), connect.NewRequest(&golfv1.ListAuditEventsRequest{})); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("invalid immutable identity/provider credential read audit", err)
		}
	}
	for _, revoke := range []bool{false, true} {
		t.Run(fmt.Sprintf("provider-wait/revoke=%t", revoke), func(t *testing.T) {
			f := newManagementFixture(t)
			session := f.session(t, "alice", "pat")
			client := auditClient(t, f, session)
			f.mode.Store(3)
			done := make(chan error, 1)
			go func() {
				_, err := client.ListAuditEvents(context.Background(), connect.NewRequest(&golfv1.ListAuditEventsRequest{}))
				done <- err
			}()
			select {
			case <-f.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("provider did not block")
			}
			_, _, hash := f.id(t, session)
			query := "UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1"
			if revoke {
				query = "DELETE FROM golf_sessions WHERE token_hash=$1"
			}
			if _, err := f.db.Exec(query, hash); err != nil {
				t.Fatal(err)
			}
			f.resume <- struct{}{}
			if err := <-done; connect.CodeOf(err) != connect.CodeUnauthenticated {
				t.Fatal("provider wait outlived current caller", err)
			}
		})
	}
}

func TestAuditCrossReplacementConcurrencyPostgres(t *testing.T) {
	f := newManagementFixture(t)
	alice, bob := f.session(t, "alice", "pat"), f.session(t, "bob", "pat")
	start := make(chan struct{})
	done := make(chan error, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, request := range []struct{ token, old string }{{"alice-management-token", bob.Value}, {"bob-management-token", alice.Value}} {
		go func() {
			<-start
			_, err := f.s.loginSession(ctx, request.token, request.old)
			done <- err
		}()
	}
	close(start)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal("opposite account replacements deadlocked/failed", err)
		}
	}
	var sessions, events int
	if err := f.db.QueryRow("SELECT (SELECT count(*) FROM golf_sessions),(SELECT count(*) FROM golf_audit_events)").Scan(&sessions, &events); err != nil || sessions != 2 || events != 6 {
		t.Fatal("concurrent replacement lost atomic history", err)
	}
}

// A login blocked on an account must not allocate its audit ID until the
// current exporter has committed its upper bound. The later event stays out.
func TestAuditSnapshotSerializesWritersPostgres(t *testing.T) {
	f := newManagementFixture(t)
	session := f.session(t, "alice", "pat")
	_, userID, hash := f.id(t, session)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	q := database.New(f.db).WithTx(tx)
	if _, err := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: f.s.config.GiteaURL}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := f.s.loginSession(ctx, "alice-management-token", ""); done <- err }()
	waitManagementLock(t, f.db, "LockLoginUsers", 1)
	snapshot, err := q.GetAuditSnapshot(ctx, database.GetAuditSnapshotParams{UserID: userID, ForgeURL: f.s.config.GiteaURL, CallerTokenHash: hash})
	if err != nil {
		t.Fatal(err)
	}
	var lastID int64
	if err := tx.QueryRowContext(ctx, "SELECT last_value FROM golf_audit_events_id_seq").Scan(&lastID); err != nil || lastID != snapshot {
		t.Fatal("waiting writer allocated ID before account serialization", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	response, err := auditClient(t, f, session).ListAuditEvents(ctx, connect.NewRequest(&golfv1.ListAuditEventsRequest{SnapshotId: strconv.FormatInt(snapshot, 10)}))
	if err != nil || len(response.Msg.Events) != 1 {
		t.Fatal("old snapshot admitted later writer", err)
	}
}

func TestAuditReplacementLogoutAndBulkContentionPostgres(t *testing.T) {
	for _, action := range []string{"logout", "bulk"} {
		t.Run(action, func(t *testing.T) {
			f := newManagementFixture(t)
			alice, bob := f.session(t, "alice", "pat"), f.session(t, "bob", "pat")
			old := alice
			if action == "bulk" {
				old = f.session(t, "alice", "oauth")
			}
			_, userID, _ := f.id(t, alice)
			oldID, _, _ := f.id(t, old)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			held, err := f.db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Rollback()
			if _, err := held.ExecContext(ctx, "SELECT id FROM golf_users WHERE id=$1 FOR UPDATE", userID); err != nil {
				t.Fatal(err)
			}
			loginDone := make(chan error, 1)
			go func() { _, err := f.s.loginSession(ctx, "bob-management-token", old.Value); loginDone <- err }()
			waitManagementLock(t, f.db, "LockLoginUsers", 1)
			mutationDone := make(chan error, 1)
			go func() {
				if action == "logout" {
					mutationDone <- f.s.logoutSession(ctx, old.Value)
				} else {
					_, err := f.s.revokeOtherSessions(ctx, alice.Value, managementToken())
					mutationDone <- err
				}
			}()
			lock := "LockLogoutUser"
			if action == "bulk" {
				lock = "LockSessionUser"
			}
			waitManagementLock(t, f.db, lock, 1)
			if err := held.Commit(); err != nil {
				t.Fatal(err)
			}
			for _, done := range []chan error{loginDone, mutationDone} {
				if err := <-done; err != nil {
					t.Fatal("account/session operation deadlocked or failed", err)
				}
			}
			var removals, bulk int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_audit_events WHERE target_session_id=$1 AND action IN ('SIGN_OUT','SESSION_REPLACED','SESSION_REVOKED')", oldID).Scan(&removals); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow("SELECT COALESCE(sum(revoked_count),0) FROM golf_audit_events WHERE action='OTHER_SESSIONS_REVOKED'").Scan(&bulk); err != nil || removals+bulk != 1 {
				t.Fatal("competing operations double-counted/lost successful removal", err)
			}
			if _, err := f.s.sessionCredential(ctx, old.Value); !errors.Is(err, errUnauthenticated) {
				t.Fatal("removed cookie survived contention", err)
			}
			if _, err := f.s.sessionCredential(ctx, bob.Value); err != nil {
				t.Fatal("unrelated account cookie lost", err)
			}
		})
	}
}

func TestAuditConcurrentNewAccountConflictPostgres(t *testing.T) {
	f := newManagementFixture(t)
	alice, bob := f.session(t, "alice", "pat"), f.session(t, "bob", "pat")
	_, aliceUser, _ := f.id(t, alice)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	held, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err := held.ExecContext(ctx, "SELECT id FROM golf_users WHERE id=$1 FOR UPDATE", aliceUser); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 2)
	newAccount := User{ID: 126, Login: "new-account"}
	go func() {
		_, err := f.s.createSession(ctx, newAccount, "pat", "new-account-pat", alice.Value)
		done <- err
	}()
	waitManagementLock(t, f.db, "LockLoginUsers", 1)
	go func() {
		_, err := f.s.createSession(ctx, newAccount, "pat", "new-account-pat", bob.Value)
		done <- err
	}()
	waitManagementLock(t, f.db, "EnsureLoginUser", 1)
	if err := held.Commit(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal("new-account conflict wait broke lock order", err)
		}
	}
	var sessions, events, users int
	if err := f.db.QueryRow("SELECT (SELECT count(*) FROM golf_sessions),(SELECT count(*) FROM golf_audit_events),(SELECT count(*) FROM golf_users)").Scan(&sessions, &events, &users); err != nil || sessions != 2 || events != 6 || users != 3 {
		t.Fatal("concurrent new account lost sessions/audit or duplicated identity", err)
	}
}

func TestAuditAccountLockWaitExpiryPostgres(t *testing.T) {
	f := newManagementFixture(t)
	session := f.session(t, "alice", "pat")
	_, userID, hash := f.id(t, session)
	client := auditClient(t, f, session)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	held, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err := held.ExecContext(ctx, "SELECT id FROM golf_users WHERE id=$1 FOR UPDATE", userID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := client.ListAuditEvents(ctx, connect.NewRequest(&golfv1.ListAuditEventsRequest{}))
		done <- err
	}()
	waitManagementLock(t, f.db, "LockSessionUser", 1)
	if _, err := f.db.ExecContext(ctx, "UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", hash); err != nil {
		t.Fatal(err)
	}
	if err := held.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("audit revealed history after session expired waiting for account", err)
	}
}
