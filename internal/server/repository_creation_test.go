package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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

const creationFixtureKey = "12345678-1234-4123-8123-123456789abc"

type creationFixture struct {
	s          *Server
	db         *sql.DB
	posts      atomic.Int32
	postStatus atomic.Int32
	readStatus atomic.Int32
	userMode   atomic.Int32 // 1: rejected credential; 2: changed immutable identity
	mu         sync.Mutex
	repos      map[string]Repository
	postHook   func(http.ResponseWriter, *http.Request, Repository) bool
	readHook   func()
}

func newCreationFixture(t *testing.T) *creationFixture {
	t.Helper()
	f := &creationFixture{db: testDatabase(t), repos: make(map[string]Repository)}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		user := User{ID: 42, Login: "alice"}
		if r.Header.Get("Authorization") == "token bob-creation-token" {
			user.ID, user.Login = 84, "bob"
		}
		if r.URL.Path == "/api/v1/user" {
			switch f.userMode.Load() {
			case 1:
				w.WriteHeader(401)
				return
			case 2:
				user.ID = 99
			}
			_ = json.NewEncoder(w).Encode(user)
			return
		}
		if r.URL.Path == "/api/v1/user/repos" && r.Method == "POST" {
			f.posts.Add(1)
			var reserved int
			if err := f.db.QueryRow("SELECT count(*) FROM golf_repository_creations c JOIN golf_repository_creation_events e ON e.creation_id=c.id WHERE c.state='OUTCOME_UNKNOWN' AND e.state='OUTCOME_UNKNOWN'").Scan(&reserved); err != nil || reserved == 0 {
				t.Error("provider dispatched without committed reservation and event")
			}
			var input repositoryCreationInput
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error("bad provider create request")
			}
			repo := Repository{ID: 100 + user.ID, Name: input.Name, FullName: user.Login + "/" + input.Name, Description: input.Description, Private: input.Private}
			if f.postHook != nil && f.postHook(w, r, repo) {
				return
			}
			if code := f.postStatus.Load(); code != 0 {
				w.WriteHeader(int(code))
				fmt.Fprint(w, `{"message":"private-provider-error-body"}`)
				return
			}
			f.mu.Lock()
			f.repos[repo.FullName] = repo
			f.mu.Unlock()
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(repo)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/repos/") {
			if f.readHook != nil {
				f.readHook()
			}
			if code := f.readStatus.Load(); code != 0 {
				w.WriteHeader(int(code))
				return
			}
			f.mu.Lock()
			repo, found := f.repos[strings.TrimPrefix(r.URL.Path, "/api/v1/repos/")]
			f.mu.Unlock()
			if !found {
				w.WriteHeader(404)
				return
			}
			_ = json.NewEncoder(w).Encode(repo)
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(provider.Close)
	var err error
	config := testConfig(provider.URL)
	config.ForgePublicURL, config.ForgeOAuthClientID, config.ForgeOAuthClientSecret = provider.URL, "creation-client", "creation-client-secret"
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *creationFixture) session(t *testing.T, name, kind string) loginResult {
	t.Helper()
	id := int64(42)
	if name == "bob" {
		id = 84
	}
	token := name + "-creation-token"
	if kind == "oauth" {
		token = encodeOAuth(oauthEnvelope{Version: 1, AccessToken: token, RefreshToken: "creation-refresh", Expiry: time.Now().Add(time.Hour), Verified: true})
	}
	result, err := f.s.createSession(context.Background(), User{ID: id, Login: name}, kind, token, "")
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func (f *creationFixture) client(t *testing.T, session loginResult) golfv1connect.RepositoryServiceClient {
	t.Helper()
	_, client, _, transport, origin := testRPCClients(t, f.s)
	transport.Jar.SetCookies(origin, []*http.Cookie{f.s.sessionCookie(session.Value, session.Expires, 3600)})
	return client
}
func creationRequest(key string) *golfv1.CreateRepositoryRequest {
	private := true
	return &golfv1.CreateRepositoryRequest{Name: "example", Description: "private-description-sentinel", Private: &private, IdempotencyKey: key}
}
func (f *creationFixture) counts(t *testing.T, operations, events int) {
	t.Helper()
	var actualOperations, actualEvents int
	if err := f.db.QueryRow("SELECT (SELECT count(*) FROM golf_repository_creations),(SELECT count(*) FROM golf_repository_creation_events)").Scan(&actualOperations, &actualEvents); err != nil || actualOperations != operations || actualEvents != events {
		t.Fatal("unexpected durable operation/event counts", actualOperations, actualEvents, err)
	}
}

func TestRepositoryCreationBoundary(t *testing.T) {
	s, err := New(testConfig("http://forgejo.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, procedure := range []string{golfv1connect.RepositoryServiceCreateRepositoryProcedure, golfv1connect.RepositoryServiceGetRepositoryCreationProcedure} {
		for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
			req := httptest.NewRequest("POST", "/rpc"+procedure, strings.NewReader("invalid JSON"))
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
				t.Fatal("creation decoded before origin/auth or lost no-store")
			}
		}
	}
}

func TestRepositoryCreationConcurrentReplayPostgres(t *testing.T) {
	f := newCreationFixture(t)
	session := f.session(t, "alice", "pat")
	client := f.client(t, session)
	entered, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	f.postHook = func(w http.ResponseWriter, r *http.Request, repo Repository) bool {
		once.Do(func() { close(entered) })
		select {
		case <-resume:
			return false
		case <-r.Context().Done():
			return true
		}
	}
	t.Cleanup(func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	})
	first := make(chan *golfv1.CreateRepositoryResponse, 1)
	failed := make(chan error, 1)
	go func() {
		response, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
		if err != nil {
			failed <- err
			return
		}
		first <- response.Msg
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider not dispatched")
	}
	const duplicates = 8
	var wg sync.WaitGroup
	for range duplicates {
		wg.Go(func() {
			response, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
			if err != nil || response.Msg.Creation.State != golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN || response.Msg.Repository != nil {
				t.Error("in-flight duplicate did not return unknown", err)
			}
		})
	}
	wg.Wait()
	if f.posts.Load() != 1 {
		t.Fatal("duplicate native dispatch")
	}
	f.counts(t, 1, 1)
	close(resume)
	var original *golfv1.CreateRepositoryResponse
	select {
	case original = <-first:
	case err := <-failed:
		t.Fatal(err)
	case <-time.After(3 * time.Second):
		t.Fatal("creation never completed")
	}
	if original.Creation.State != golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_SUCCEEDED || original.Repository == nil || original.Repository.Id != original.Creation.RepositoryId {
		t.Fatal("success missing current repository")
	}
	f.counts(t, 1, 2)
	restarted, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.s = restarted
	client = f.client(t, session)
	replay, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
	if err != nil || replay.Msg.Creation.Id != original.Creation.Id || f.posts.Load() != 1 {
		t.Fatal("restart replay dispatched or lost identity", err)
	}
	for _, change := range []func(*golfv1.CreateRepositoryRequest){func(r *golfv1.CreateRepositoryRequest) { r.Name = "other" }, func(r *golfv1.CreateRepositoryRequest) { r.Description += " " }, func(r *golfv1.CreateRepositoryRequest) { *r.Private = false }} {
		request := creationRequest(creationFixtureKey)
		change(request)
		if _, err := client.CreateRepository(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Fatal("key accepted changed inputs", err)
		}
	}
	if f.posts.Load() != 1 {
		t.Fatal("collision dispatched")
	}
	wire, err := protojson.Marshal(replay.Msg)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{session.Value, "alice-creation-token", "payloadFingerprint", "userId", "repositoryFullName"} {
		if bytes.Contains(wire, []byte(secret)) {
			t.Fatal("operation response leaked internal state")
		}
	}
}

func TestRepositoryCreationRejectionAndUnknownPostgres(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 409, 422, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newCreationFixture(t)
			f.postStatus.Store(int32(status))
			client := f.client(t, f.session(t, "alice", "pat"))
			response, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
			if err != nil {
				t.Fatal(err)
			}
			known := status != 429 && status != 500
			want := golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN
			events := 1
			if known {
				want = golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_REJECTED
				events = 2
			}
			if response.Msg.Creation.State != want || response.Msg.Repository != nil || known && response.Msg.Creation.FailureCode != fmt.Sprintf("provider_http_%d", status) {
				t.Fatal("wrong provider outcome")
			}
			f.postStatus.Store(0)
			replay, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
			if err != nil || replay.Msg.Creation.State != want || f.posts.Load() != 1 {
				t.Fatal("terminal or unknown outcome retried", err)
			}
			f.counts(t, 1, events)
			wire, _ := protojson.Marshal(response.Msg)
			if bytes.Contains(wire, []byte("private-provider-error-body")) {
				t.Fatal("provider body leaked")
			}
		})
	}
	for _, status := range []int{403, 409, 500} {
		t.Run(fmt.Sprintf("legacy-%d", status), func(t *testing.T) {
			f := newCreationFixture(t)
			f.postStatus.Store(int32(status))
			client := f.client(t, f.session(t, "alice", "pat"))
			_, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest("")))
			if connect.CodeOf(err) != connect.CodeOf(rpcError(forgeError{status})) {
				t.Fatal("legacy error changed", err)
			}
			var key string
			if err := f.db.QueryRow("SELECT idempotency_key FROM golf_repository_creations").Scan(&key); err != nil || !creationKey.MatchString(key) {
				t.Fatal("legacy call not journaled")
			}
		})
	}
}

func TestRepositoryCreationInvalidSuccessPostgres(t *testing.T) {
	for _, body := range []string{`not JSON`, `{"id":0,"name":"example","full_name":"alice/example","private":true}`, `{"id":1,"name":"other","full_name":"alice/other","private":true}`, `{"id":1,"name":"example","full_name":"bob/example","private":true}`, `{"id":1,"name":"example","full_name":"alice/example","private":false}`, `{"id":1,"name":"example","full_name":"alice/example"}`} {
		t.Run(fmt.Sprintf("case-%x", body[:3]), func(t *testing.T) {
			f := newCreationFixture(t)
			f.postHook = func(w http.ResponseWriter, _ *http.Request, _ Repository) bool {
				w.WriteHeader(201)
				fmt.Fprint(w, body)
				return true
			}
			client := f.client(t, f.session(t, "alice", "pat"))
			response, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
			if err != nil || response.Msg.Creation.State != golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN || response.Msg.Repository != nil {
				t.Fatal("malformed/mismatched success promoted", err)
			}
			f.counts(t, 1, 1)
		})
	}
}

func TestRepositoryCreationLookupAccessPostgres(t *testing.T) {
	f := newCreationFixture(t)
	session := f.session(t, "alice", "oauth")
	client := f.client(t, session)
	created, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
	if err != nil {
		t.Fatal(err)
	}
	bob := f.client(t, f.session(t, "bob", "pat"))
	if _, err := bob.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: creationFixtureKey})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("foreign operation visible", err)
	}
	for _, status := range []int{403, 404} {
		f.readStatus.Store(int32(status))
		response, err := client.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: creationFixtureKey}))
		if err != nil || response.Msg.Creation.State != golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_SUCCEEDED || response.Msg.Repository != nil {
			t.Fatal("operation became cached access grant", err)
		}
	}
	f.readStatus.Store(503)
	if _, err := client.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: creationFixtureKey})); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("outage silently treated as access loss", err)
	}
	f.readStatus.Store(0)
	f.mu.Lock()
	repo := f.repos["alice/example"]
	repo.ID++
	f.repos["alice/example"] = repo
	f.mu.Unlock()
	response, err := client.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: creationFixtureKey}))
	if err != nil || response.Msg.Repository != nil || response.Msg.Creation.RepositoryId != created.Msg.Creation.RepositoryId {
		t.Fatal("same-name replacement disclosed", err)
	}
	for _, mode := range []int32{1, 2} {
		f.userMode.Store(mode)
		if _, err := client.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: creationFixtureKey})); connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatal("revoked/wrong immutable provider user accepted", err)
		}
	}
	f.userMode.Store(0)
	// Same UUID is independent for another immutable account, never a global key.
	other, err := bob.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
	if err != nil || other.Msg.Creation.Id == created.Msg.Creation.Id || other.Msg.Repository.FullName != "bob/example" {
		t.Fatal("cross-account reservation collided", err)
	}
}

func TestRepositoryCreationValidationPostgres(t *testing.T) {
	f := newCreationFixture(t)
	client := f.client(t, f.session(t, "alice", "pat"))
	for _, key := range []string{"bad", strings.ToUpper(creationFixtureKey), "12345678-1234-1123-8123-123456789abc", "12345678-1234-4123-7123-123456789abc"} {
		request := creationRequest(key)
		if _, err := client.CreateRepository(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid UUID accepted", err)
		}
	}
	for _, key := range []string{"", "bad"} {
		if _, err := client.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: key})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid lookup UUID accepted", err)
		}
	}
	request := creationRequest(creationFixtureKey)
	request.Private = nil
	if _, err := client.CreateRepository(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("implicit public create accepted")
	}
	f.counts(t, 0, 0)
	if f.posts.Load() != 0 {
		t.Fatal("invalid request dispatched")
	}
	response, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest("")))
	if err != nil || response.Msg.Repository == nil || !creationKey.MatchString(response.Msg.Creation.IdempotencyKey) {
		t.Fatal("legacy success missing generated operation", err)
	}
}

func TestRepositoryCreationEventRollbackPostgres(t *testing.T) {
	for _, completion := range []bool{false, true} {
		t.Run(fmt.Sprintf("completion=%t", completion), func(t *testing.T) {
			f := newCreationFixture(t)
			client := f.client(t, f.session(t, "alice", "pat"))
			state := "OUTCOME_UNKNOWN"
			if completion {
				state = "SUCCEEDED"
			}
			// A deferred trigger makes even a commit-time event failure roll back the
			// operation transition. Reservation failure must prevent the native call.
			_, err := f.db.Exec("CREATE FUNCTION fail_creation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='" + state + "' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER fail_creation_event AFTER INSERT ON golf_repository_creation_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_creation_event();")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey))); connect.CodeOf(err) != connect.CodeUnavailable {
				t.Fatal("event failure did not fail atomically", err)
			}
			if _, err := f.db.Exec("DROP TRIGGER fail_creation_event ON golf_repository_creation_events"); err != nil {
				t.Fatal(err)
			}
			if completion {
				f.counts(t, 1, 1)
				response, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
				if err != nil || response.Msg.Creation.State != golfv1.RepositoryCreationState_REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN || f.posts.Load() != 1 {
					t.Fatal("ambiguous provider success redispatched", err)
				}
			} else {
				f.counts(t, 0, 0)
				if f.posts.Load() != 0 {
					t.Fatal("failed reservation dispatched")
				}
			}
		})
	}
}

func TestRepositoryCreationPostWaitRevocationPostgres(t *testing.T) {
	for _, mutation := range []string{"delete", "expire", "provider", "read-revoke"} {
		t.Run(mutation, func(t *testing.T) {
			f := newCreationFixture(t)
			session := f.session(t, "alice", "pat")
			client := f.client(t, session)
			hash, _ := sessionHash(session.Value)
			change := func() {
				var err error
				switch mutation {
				case "delete", "read-revoke":
					_, err = f.db.Exec("DELETE FROM golf_sessions WHERE token_hash=$1", hash)
				case "expire":
					_, err = f.db.Exec("UPDATE golf_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", hash)
				case "provider":
					f.userMode.Store(1)
				}
				if err != nil {
					t.Error(err)
				}
			}
			if mutation == "read-revoke" {
				f.readHook = change
			} else {
				f.postHook = func(http.ResponseWriter, *http.Request, Repository) bool { change(); return false }
			}
			if _, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey))); connect.CodeOf(err) != connect.CodeUnauthenticated {
				t.Fatal("revoked caller received creation response", err)
			}
			var state string
			if err := f.db.QueryRow("SELECT state FROM golf_repository_creations").Scan(&state); err != nil || state != "SUCCEEDED" {
				t.Fatal("provider result lost after caller revoked", err)
			}
			f.counts(t, 1, 2)
		})
	}
}

func TestRepositoryCreationCanceledUnknownPostgres(t *testing.T) {
	f := newCreationFixture(t)
	session := f.session(t, "alice", "pat")
	entered := make(chan struct{})
	var once sync.Once
	f.postHook = func(_ http.ResponseWriter, r *http.Request, _ Repository) bool {
		once.Do(func() { close(entered) })
		<-r.Context().Done()
		return true
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	private := true
	go func() {
		_, _, err := f.s.createRepository(ctx, session.Value, forgeCredential{Kind: "pat", Token: "alice-creation-token"}, "example", "", &private, creationFixtureKey, "", false)
		done <- err
	}()
	select {
	case <-entered:
		cancel()
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("provider not entered")
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("canceled caller not denied", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled create did not settle")
	}
	f.counts(t, 1, 1)
	record, repo, err := f.s.createRepository(t.Context(), session.Value, forgeCredential{Kind: "pat", Token: "alice-creation-token"}, "example", "", &private, creationFixtureKey, "", false)
	if err != nil || record.State != "OUTCOME_UNKNOWN" || repo != nil || f.posts.Load() != 1 {
		t.Fatal("canceled unknown outcome resent", err)
	}
}

type creationRoundTripper func(*http.Request) (*http.Response, error)

func (call creationRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return call(r) }

func TestRepositoryCreationObservedResultAfterCancellationPostgres(t *testing.T) {
	f := newCreationFixture(t)
	session := f.session(t, "alice", "pat")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	transport := f.s.client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	f.s.client.Transport = creationRoundTripper(func(req *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(req)
		if err == nil && req.Method == "POST" {
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if readErr != nil {
				return nil, readErr
			}
			response.Body = io.NopCloser(bytes.NewReader(body))
			cancel()
		}
		return response, err
	})
	private := true
	_, _, err := f.s.createRepository(ctx, session.Value, forgeCredential{Kind: "pat", Token: "alice-creation-token"}, "example", "", &private, creationFixtureKey, "", false)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("canceled response was not denied", err)
	}
	var state string
	if err := f.db.QueryRow("SELECT state FROM golf_repository_creations").Scan(&state); err != nil || state != "SUCCEEDED" {
		t.Fatal("observed success was not durably completed after client cancellation", err)
	}
	f.counts(t, 1, 2)
}

func TestRepositoryCreationMigrationAndGuardsPostgres(t *testing.T) {
	f := newCreationFixture(t)
	session := f.session(t, "alice", "pat")
	hash, _ := sessionHash(session.Value)
	// Start from an actual old schema. Retained journals intentionally prohibit
	// downgrading a latest schema; that is not an additive-upgrade test.
	old := testDatabaseAtVersion(t, 202610020003)
	for _, table := range []string{"golf_users", "golf_sessions"} {
		var data []byte
		if err := f.db.QueryRow("SELECT to_jsonb(t) FROM " + table + " t").Scan(&data); err != nil {
			t.Fatal(err)
		}
		if _, err := old.Exec("INSERT INTO "+table+" OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::"+table+",$1::jsonb)).*", string(data)); err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range [][2]string{{"golf_users", "id"}, {"golf_sessions", "session_id"}} {
		if _, err := old.Exec("SELECT setval(pg_get_serial_sequence($1,$2),(SELECT max("+column[1]+") FROM "+column[0]+"))", column[0], column[1]); err != nil {
			t.Fatal(err)
		}
	}
	f.db, f.s.db = old, old
	provider, err := goose.NewProvider(goose.DialectPostgres, f.db, os.DirFS("database/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	var before []byte
	if err := f.db.QueryRow("SELECT encrypted_token FROM golf_sessions WHERE token_hash=$1", hash).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	var after []byte
	if err := f.db.QueryRow("SELECT encrypted_token FROM golf_sessions WHERE token_hash=$1", hash).Scan(&after); err != nil || !bytes.Equal(before, after) {
		t.Fatal("additive migration changed existing credential", err)
	}
	f.counts(t, 0, 0)
	client := f.client(t, session)
	response, err := client.CreateRepository(t.Context(), connect.NewRequest(creationRequest(creationFixtureKey)))
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"UPDATE golf_repository_creation_events SET state='REJECTED'", "DELETE FROM golf_repository_creation_events", "TRUNCATE golf_repository_creation_events"} {
		if _, err := f.db.Exec(query); err == nil {
			t.Fatal("operation history mutation permitted")
		}
	}
	var userID, id int64
	if err := f.db.QueryRow("SELECT user_id,id FROM golf_repository_creations").Scan(&userID, &id); err != nil {
		t.Fatal(err)
	}
	_, err = database.New(f.db).CompleteRepositoryCreation(t.Context(), database.CompleteRepositoryCreationParams{UserID: userID, ForgeURL: f.s.config.ForgeURL, CreationID: id, State: "REJECTED", FailureCode: "provider_http_409"})
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("terminal operation could transition again", err)
	}
	_, err = database.New(f.db).GetRepositoryCreation(t.Context(), database.GetRepositoryCreationParams{UserID: userID, ForgeURL: "http://other.invalid", IdempotencyKey: creationFixtureKey})
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("cross-forge SQL lookup disclosed operation", err)
	}
	lookup, err := client.GetRepositoryCreation(t.Context(), connect.NewRequest(&golfv1.GetRepositoryCreationRequest{IdempotencyKey: creationFixtureKey}))
	if err != nil || lookup.Msg.Creation.Id != response.Msg.Creation.Id {
		t.Fatal("history guard test corrupted record", err)
	}
}
