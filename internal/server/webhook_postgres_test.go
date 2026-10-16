package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type webhookFixture struct {
	s                *Server
	db               *sql.DB
	ctx              context.Context
	cookie           string
	target           *golfv1.RepositoryWebhookTarget
	sink             *httptest.Server
	received         atomic.Int32
	status           atomic.Int32
	revoked          atomic.Bool
	replacement      atomic.Bool
	foreignActor     atomic.Bool
	transferred      atomic.Bool
	downgrade        atomic.Bool
	permissionReads  atomic.Int32
	denyPermissionAt atomic.Int32
	localID          string
}

func newWebhookFixture(t *testing.T, instanceAdmin ...bool) *webhookFixture {
	t.Helper()
	f := &webhookFixture{db: testDatabase(t)}
	f.status.Store(204)
	f.sink = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.received.Add(1)
		if r.Header.Get("Authorization") != "" || !strings.HasPrefix(r.Header.Get("X-Golf-Signature-256"), "sha256=") {
			t.Error("unexpected receiver authority or signature")
		}
		w.WriteHeader(int(f.status.Load()))
	}))
	t.Cleanup(f.sink.Close)
	row := settingsFixtureRow()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			id := int64(42)
			if f.foreignActor.Load() {
				id = 84
			}
			json.NewEncoder(w).Encode(User{ID: id, Login: "alice"})
		case "/api/v1/repos/alice/example", "/api/v1/repos/bob/example":
			if f.revoked.Load() {
				w.WriteHeader(404)
				return
			}
			v := row
			if f.transferred.Load() {
				if strings.Contains(r.URL.Path, "/alice/") {
					w.WriteHeader(404)
					return
				}
				v.Owner = &User{ID: 43, Login: "bob"}
				v.FullName = "bob/example"
			} else if strings.Contains(r.URL.Path, "/bob/") {
				w.WriteHeader(404)
				return
			}
			if f.replacement.Load() {
				v.ID++
			}
			json.NewEncoder(w).Encode(v)
		case "/api/v1/users/search":
			owner := *row.Owner
			if f.transferred.Load() {
				owner = User{ID: 43, Login: "bob"}
			}
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []User{owner}})
		case "/api/v1/repos/alice/example/collaborators/alice/permission", "/api/v1/repos/bob/example/collaborators/alice/permission":
			permission := "owner"
			if f.transferred.Load() {
				permission = "admin"
			}
			reads := f.permissionReads.Add(1)
			if f.downgrade.Load() || (f.denyPermissionAt.Load() > 0 && reads >= f.denyPermissionAt.Load()) {
				permission = "write"
			}
			json.NewEncoder(w).Encode(map[string]any{"permission": permission, "user": *row.Owner})
		case "/api/v1/repos/bob/example/collaborators/alice":
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(provider.Close)
	cfg := testConfig(provider.URL)
	policy, _ := json.Marshal([]webhookEgressApproval{{Origin: f.sink.URL, Addresses: []string{"127.0.0.1"}, PathPrefix: "/owned"}})
	cfg.WebhookEgressPolicyJSON = string(policy)
	var e error
	f.s, e = New(cfg, f.db)
	if e != nil {
		t.Fatal(e)
	}
	local, e := ManageLocalAccount(t.Context(), f.db, f.s.keyring, cfg.ForgeURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "owned-webhook-native-token", IsInstanceAdmin: len(instanceAdmin) > 0 && instanceAdmin[0]})
	if e != nil {
		t.Fatal(e)
	}
	f.localID = local.ID
	login, e := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	f.cookie = f.s.sessionCookie(login.Value, login.Expires, 3600).String()
	f.ctx = context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "owned-webhook-native-token", Local: true})
	f.target = &golfv1.RepositoryWebhookTarget{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: "9007199254740993", OwnerId: "42"}
	return f
}
func webhookRequest[T any](f *webhookFixture, m *T) *connect.Request[T] {
	r := connect.NewRequest(m)
	r.Header().Set("Cookie", f.cookie)
	return r
}
func (f *webhookFixture) save(t *testing.T, id, version string, enabled bool) *golfv1.RepositoryWebhookSubscription {
	t.Helper()
	r, e := f.s.SaveRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.SaveRepositoryWebhookRequest{Target: f.target, Id: id, ExpectedVersion: version, Name: "Owned receiver", EventTopics: []string{"source", "pulls"}, Endpoint: f.sink.URL + "/owned", SigningSecret: strings.Repeat("K", 32), Enabled: enabled, AuthorizeBackground: enabled}))
	if e != nil {
		t.Fatal(e)
	}
	return r.Msg.Subscription
}
func (f *webhookFixture) queue(t *testing.T, s *golfv1.RepositoryWebhookSubscription, op string) *golfv1.RepositoryWebhookDelivery {
	t.Helper()
	r, e := f.s.TestRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.TestRepositoryWebhookRequest{Target: f.target, SubscriptionId: s.Id, ExpectedVersion: s.Version, OperationId: op}))
	if e != nil {
		t.Fatal(e)
	}
	return r.Msg.Delivery
}
func (f *webhookFixture) delivery(t *testing.T, id string) database.GolfWebhookDelivery {
	t.Helper()
	r, e := database.New(f.db).GetWebhookDelivery(t.Context(), uuid.MustParse(id))
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func (f *webhookFixture) claim(t *testing.T) database.GolfWebhookDelivery {
	t.Helper()
	r, e := f.s.claimWebhook(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestWebhookOutboxAndBackgroundPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	var configCount int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_webhook_configuration_events`).Scan(&configCount); e != nil || configCount != 1 {
		t.Fatal("configuration audit", e)
	}
	// Same SQL transaction admits events; rolled-back/private activity cannot leak.
	tx, e := f.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	_, e = tx.Exec(`INSERT INTO golf_repository_activity(forge_url,repository_id,topic,recipient_user_id) VALUES($1,$2,'source',0)`, f.s.config.ForgeURL, int64(9007199254740993))
	if e != nil {
		t.Fatal(e)
	}
	tx.Rollback()
	var count int
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_deliveries`).Scan(&count)
	if count != 0 {
		t.Fatal("rollback leaked event")
	}
	_, e = f.db.Exec(`INSERT INTO golf_repository_activity(forge_url,repository_id,topic,recipient_user_id) VALUES($1,$2,'agents',42),($1,$2,'pulls',0)`, f.s.config.ForgeURL, int64(9007199254740993))
	if e != nil {
		t.Fatal(e)
	}
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_deliveries`).Scan(&count)
	if count != 1 {
		t.Fatal("recipient-private activity fanned out", count)
	}
	d := f.claim(t)
	if d.SubscriptionID.String() != sub.Id || d.EventTopic != "pulls" || strings.Contains(string(d.Payload), "native-token") {
		t.Fatal("frozen event contract")
	}
	logout := connect.NewRequest(&golfv1.LogoutRequest{})
	logout.Header().Set("Cookie", f.cookie)
	if _, e = f.s.Logout(f.ctx, logout); e != nil {
		t.Fatal(e)
	}
	f.s.attemptWebhook(t.Context(), d)
	if f.received.Load() != 1 || f.delivery(t, d.ID.String()).State != "accepted" {
		t.Fatal("explicit background consent lost on browser logout")
	}
	if _, e = f.db.Exec(`UPDATE golf_webhook_deliveries SET payload='{}' WHERE id=$1`, d.ID); e == nil {
		t.Fatal("frozen payload mutable")
	}
	if _, e = f.db.Exec(`DELETE FROM golf_webhook_configuration_events`); e == nil {
		t.Fatal("configuration audit mutable")
	}
}
func TestWebhookCASConcurrentAndRevocationPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	s := f.save(t, uuid.NewString(), "0", true)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.s.SaveRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.SaveRepositoryWebhookRequest{Target: f.target, Id: s.Id, ExpectedVersion: "1", Name: "Updated", EventTopics: []string{"source"}, Enabled: true, AuthorizeBackground: true}))
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if connect.CodeOf(e) == connect.CodeFailedPrecondition {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("CAS", success, conflict)
	}
	s.Version = "2"
	d := f.queue(t, s, uuid.NewString())
	claimed := f.claim(t)
	if _, e := f.db.Exec(`UPDATE golf_local_accounts SET disabled_at=clock_timestamp() WHERE id=$1`, f.localID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Exec(`UPDATE golf_local_accounts SET disabled_at=NULL WHERE id=$1`, f.localID); e != nil {
		t.Fatal(e)
	}
	f.s.attemptWebhook(t.Context(), claimed)
	if f.received.Load() != 0 || f.delivery(t, d.Id).State != "cancelled" {
		t.Fatal("disabled then enabled restored background authority")
	}
	var enabled bool
	f.db.QueryRow(`SELECT enabled FROM golf_webhook_subscriptions WHERE id=$1`, s.Id).Scan(&enabled)
	if enabled {
		t.Fatal("revoked subscription revived")
	}
}
func TestWebhookNativeIdentityAndRedeliveryPostgres(t *testing.T) {
	for _, mode := range []string{"replacement", "actor", "native-revoke", "credential", "permission"} {
		t.Run(mode, func(t *testing.T) {
			f := newWebhookFixture(t)
			sub := f.save(t, uuid.NewString(), "0", true)
			d := f.queue(t, sub, uuid.NewString())
			claim := f.claim(t)
			switch mode {
			case "replacement":
				f.replacement.Store(true)
			case "actor":
				f.foreignActor.Store(true)
			case "native-revoke":
				f.revoked.Store(true)
			case "permission":
				f.downgrade.Store(true)
			case "credential":
				f.db.Exec(`UPDATE golf_local_accounts SET credential_version=credential_version+1 WHERE id=$1`, f.localID)
			}
			f.s.attemptWebhook(t.Context(), claim)
			if f.received.Load() != 0 || f.delivery(t, d.Id).State != "cancelled" {
				t.Fatal("changed authority dispatched")
			}
		})
	}
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	op := uuid.NewString()
	d := f.queue(t, sub, op)
	same := f.queue(t, sub, op)
	if same.Id != d.Id {
		t.Fatal("operation replay created duplicate")
	}
	f.s.attemptWebhook(t.Context(), f.claim(t))
	redeliver := webhookRequest(f, &golfv1.RedeliverRepositoryWebhookRequest{Target: f.target, DeliveryId: d.Id, ExpectedVersion: sub.Version, OperationId: uuid.NewString()})
	r, e := f.s.RedeliverRepositoryWebhook(f.ctx, redeliver)
	if e != nil || r.Msg.Delivery.EventId != d.EventId {
		t.Fatal("redelivery lost original event", e)
	}
	f.s.attemptWebhook(t.Context(), f.claim(t))
	if f.received.Load() != 2 {
		t.Fatal("explicit redelivery not consumed")
	}
	wrong := &golfv1.RepositoryWebhookTarget{Repository: f.target.Repository, RepositoryId: "9007199254740994", OwnerId: f.target.OwnerId}
	if _, e = f.s.ListRepositoryWebhooks(f.ctx, webhookRequest(f, &golfv1.ListRepositoryWebhooksRequest{Target: wrong})); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("cross repository inventory", e)
	}
}
func TestWebhookRetryLeaseAndCapacityPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	d := f.queue(t, sub, uuid.NewString())
	f.status.Store(503)
	for attempt := 1; attempt <= 6; attempt++ {
		f.db.Exec(`UPDATE golf_webhook_deliveries SET next_attempt_at=clock_timestamp() WHERE id=$1`, d.Id)
		claim := f.claim(t)
		f.s.attemptWebhook(t.Context(), claim)
		row := f.delivery(t, d.Id)
		want := "retrying"
		if attempt == 6 {
			want = "failed"
		}
		if row.State != want || row.Attempts != int32(attempt) {
			t.Fatal("bounded retry", row.State, row.Attempts)
		}
	}
	if f.received.Load() != 6 {
		t.Fatal("attempt count")
	}
	next := f.queue(t, sub, uuid.NewString())
	old := f.claim(t)
	f.db.Exec(`UPDATE golf_webhook_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, next.Id)
	fresh := f.claim(t)
	f.s.attemptWebhook(t.Context(), old)
	if f.received.Load() != 6 {
		t.Fatal("expired worker dispatched")
	}
	row := f.delivery(t, next.Id)
	if row.Attempts != 2 || !row.PossibleDuplicate || row.LeaseID == old.LeaseID || fresh.LeaseID == old.LeaseID {
		t.Fatal("uncertain lease recovery")
	}
	var finished bool
	f.db.QueryRow(`SELECT completed_at IS NOT NULL FROM golf_webhook_attempts WHERE delivery_id=$1 AND attempt=1`, next.Id).Scan(&finished)
	if !finished {
		t.Fatal("expired attempt not finalized")
	}
	// Capacity is a recorded terminal refusal, not a silent missing outbox event.
	_, e := f.db.Exec(`INSERT INTO golf_repository_activity(forge_url,repository_id,topic,recipient_user_id) SELECT $1,$2,'source',0 FROM generate_series(1,201)`, f.s.config.ForgeURL, int64(9007199254740993))
	if e != nil {
		t.Fatal(e)
	}
	var pending, failed int
	f.db.QueryRow(`SELECT count(*) FILTER(WHERE state IN ('queued','retrying','sending')),count(*) FILTER(WHERE failure_code='queue_capacity') FROM golf_webhook_deliveries WHERE subscription_id=$1`, sub.Id).Scan(&pending, &failed)
	if pending != 200 || failed != 2 {
		t.Fatal("bounded outbox capacity", pending, failed)
	}
}
func TestWebhookKeyLifecyclePostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	f.save(t, sub.Id, "1", false)
	keys := rotationKeys(t, f.s.config)
	status, e := KeyStatus(t.Context(), f.db, keys)
	if e != nil {
		t.Fatal(e)
	}
	var retained uint64
	for _, k := range status.Keys {
		retained += k.WebhookCredentials
	}
	if retained != 2 {
		t.Fatal("incomplete retained key inventory", retained)
	}
	mustActivate(t, f.db, keys)
	if _, e = CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); e == nil {
		t.Fatal("live webhook key retired")
	}
	if _, e = New(func() Config { c := keyedConfig(f.s.config); c.EncryptionKey = ""; return c }(), f.db); !errors.Is(e, errKeyPolicy) {
		t.Fatal("startup lost retained key", e)
	}
	if _, e = f.db.Exec(`CREATE FUNCTION reject_webhook_rotation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned rotation fault';END $$`); e != nil {
		t.Fatal(e)
	}
	f.db.Exec(`CREATE TRIGGER reject_webhook_rotation BEFORE UPDATE ON golf_webhook_credentials FOR EACH ROW EXECUTE FUNCTION reject_webhook_rotation()`)
	if _, e = RotateCredentials(t.Context(), f.db, keys, 100, 1); e == nil {
		t.Fatal("rotation fault became success")
	}
	var changed int
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_credentials WHERE credential_key_id='next'`).Scan(&changed)
	if changed != 0 {
		t.Fatal("partial rotation committed")
	}
	f.db.Exec(`DROP TRIGGER reject_webhook_rotation ON golf_webhook_credentials`)
	result, e := RotateCredentials(t.Context(), f.db, keys, 100, 10)
	if e != nil || !result.Complete || result.RotatedWebhookCredentials != 2 {
		t.Fatal("full rotation", result, e)
	}
	renewed, e := New(keyedConfig(f.s.config), f.db)
	if e != nil {
		t.Fatal(e)
	}
	private, _, e := renewed.webhookSecret(t.Context(), database.New(f.db), uuid.MustParse(sub.Id), 2)
	if e != nil || private.Endpoint != f.sink.URL+"/owned" || private.SigningSecret != strings.Repeat("K", 32) {
		t.Fatal("rotated private readback", e)
	}
	if _, e = CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); e != nil {
		t.Fatal("unused key retirement", e)
	}
}
func TestWebhookRecoveryQuarantinePostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	d := f.queue(t, sub, uuid.NewString())
	if _, e := InvalidateRestoredSessions(t.Context(), f.db, strings.Repeat("a", 32)); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.claimWebhook(t.Context()); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("recovery queued background dispatch", e)
	}
	if f.delivery(t, d.Id).State != "cancelled" || f.received.Load() != 0 {
		t.Fatal("restored delivery reissued")
	}
}
func TestWebhookHTTPBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, method := range []string{"ListRepositoryWebhooks", "SaveRepositoryWebhook", "ListRepositoryWebhookDeliveries", "TestRepositoryWebhook", "RedeliverRepositoryWebhook"} {
		path := "/golf.v1.RepositoryWebhookService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://wrong.invalid"} {
			req := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal(method, w.Code)
			}
		}
		if r := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); r.Code != 403 {
			t.Fatal("delegated API reached webhook writes", r.Code)
		}
	}
}

func TestWebhookInvalidDestinationHTTPPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	for _, endpoint := range []string{"http://169.254.169.254/private-token", f.sink.URL + "/outside/private-token"} {
		payload, err := json.Marshal(&golfv1.SaveRepositoryWebhookRequest{Target: f.target, Id: uuid.NewString(), ExpectedVersion: "0", Name: "Rejected", EventTopics: []string{"issues"}, Endpoint: endpoint, SigningSecret: strings.Repeat("K", 32), Enabled: true, AuthorizeBackground: true})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", "/rpc/golf.v1.RepositoryWebhookService/SaveRepositoryWebhook", strings.NewReader(string(payload)))
		req.Header.Set("Origin", f.s.config.PublicURL)
		req.Header.Set("Cookie", f.cookie)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Connect-Protocol-Version", "1")
		w := httptest.NewRecorder()
		f.s.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"code":"invalid_argument"`) || strings.Contains(w.Body.String(), "private-token") || f.received.Load() != 0 {
			t.Fatalf("destination rejection: status=%d cache=%q receiver=%d", w.Code, w.Header().Get("Cache-Control"), f.received.Load())
		}
	}
	listed, err := f.s.ListRepositoryWebhooks(f.ctx, webhookRequest(f, &golfv1.ListRepositoryWebhooksRequest{Target: f.target}))
	if err != nil || len(listed.Msg.Subscriptions) != 0 {
		t.Fatal("rejected destination persisted a subscription", err)
	}
}
func TestWebhookRetryBounds(t *testing.T) {
	for attempt := int32(1); attempt <= 6; attempt++ {
		d := webhookRetryDelay(attempt, "", time.Now())
		base := time.Duration(5<<min(attempt-1, 5)) * time.Second
		if d < base || d >= base+time.Second {
			t.Fatal("jitter bounds", d)
		}
	}
	if webhookRetryDelay(1, "3600", time.Now()) != time.Hour {
		t.Fatal("retry-after cap")
	}
}

func TestWebhookAcceptedRequestLostSQLAckPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	d := f.queue(t, sub, uuid.NewString())
	claim := f.claim(t)
	if _, e := f.db.Exec(`CREATE FUNCTION reject_webhook_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='accepted' THEN RAISE EXCEPTION 'owned lost finalization';END IF;RETURN NEW;END $$`); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Exec(`CREATE TRIGGER reject_webhook_ack BEFORE UPDATE ON golf_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION reject_webhook_ack()`); e != nil {
		t.Fatal(e)
	}
	f.s.attemptWebhook(t.Context(), claim)
	row := f.delivery(t, d.Id)
	if f.received.Load() != 1 || row.State != "sending" {
		t.Fatal("lost SQL acknowledgement fabricated receiver refusal or success")
	}
	f.db.Exec(`DROP TRIGGER reject_webhook_ack ON golf_webhook_deliveries`)
	f.db.Exec(`UPDATE golf_webhook_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, d.Id)
	recovered := f.claim(t)
	f.s.attemptWebhook(t.Context(), recovered)
	row = f.delivery(t, d.Id)
	if row.State != "accepted" || !row.PossibleDuplicate || row.Attempts != 2 || f.received.Load() != 2 {
		t.Fatal("uncertain request identity not preserved on recovery")
	}
}
func TestWebhookActualWorkerAndConcurrentClaimsPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	d := f.queue(t, sub, uuid.NewString())
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- f.s.RunWebhookWorker(ctx) }()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) && f.delivery(t, d.Id).State != "accepted" {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if f.received.Load() != 1 || f.delivery(t, d.Id).State != "accepted" {
		t.Fatal("actual worker did not consume signed test")
	}
	f.queue(t, sub, uuid.NewString())
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := f.s.claimWebhook(t.Context()); results <- e }()
	}
	wg.Wait()
	close(results)
	claimed, empty := 0, 0
	for e := range results {
		if e == nil {
			claimed++
		} else if errors.Is(e, sql.ErrNoRows) {
			empty++
		} else {
			t.Fatal(e)
		}
	}
	if claimed != 1 || empty != 1 {
		t.Fatal("same durable delivery claimed twice", claimed, empty)
	}
}
func TestWebhookSaveAuditFailureRollsBackPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	f.db.Exec(`CREATE FUNCTION reject_webhook_config_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned audit fault';END $$`)
	f.db.Exec(`CREATE TRIGGER reject_webhook_config_event BEFORE INSERT ON golf_webhook_configuration_events FOR EACH ROW EXECUTE FUNCTION reject_webhook_config_event()`)
	_, e := f.s.SaveRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.SaveRepositoryWebhookRequest{Target: f.target, Id: sub.Id, ExpectedVersion: "1", Name: "Not retained", EventTopics: []string{"source"}, Enabled: true, AuthorizeBackground: true}))
	if e == nil {
		t.Fatal("unaudited config accepted")
	}
	var version, credentials int
	f.db.QueryRow(`SELECT version FROM golf_webhook_subscriptions WHERE id=$1`, sub.Id).Scan(&version)
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_credentials WHERE subscription_id=$1`, sub.Id).Scan(&credentials)
	if version != 1 || credentials != 1 {
		t.Fatal("audit fault partially stored credential version")
	}
}

func TestWebhookLegacyBootstrapLaterPagePostgres(t *testing.T) {
	db := testDatabase(t)
	cfg := testConfig("https://forge.invalid")
	keys := parseTestKeys(t, cfg.EncryptionKey, nil, "")
	q := database.New(db)
	user, e := q.UpsertUser(t.Context(), database.UpsertUserParams{ForgeURL: cfg.ForgeURL, ForgeUserID: 42, Login: "alice"})
	if e != nil {
		t.Fatal(e)
	}
	binding := make([]byte, 32)
	binding[0] = 1
	localCipher, keyID, e := keys.seal(localAccountDomain, "owned-native-token", binding)
	if e != nil {
		t.Fatal(e)
	}
	local, e := q.CreateLocalAccount(t.Context(), database.CreateLocalAccountParams{UserID: user, Username: "alice", PasswordHash: "source-fixture-not-loginable", EncryptedForgeToken: localCipher, CredentialBinding: binding, CredentialKeyID: keyID})
	if e != nil {
		t.Fatal(e)
	}
	sub := uuid.New()
	if e = q.CreateWebhookSubscription(t.Context(), database.CreateWebhookSubscriptionParams{ID: sub, ForgeURL: cfg.ForgeURL, RepositoryID: 17, OwnerID: 42, RepositoryOwner: "alice", RepositoryName: "example", Name: "Retained versions", WorkflowNotifications: 1, EventTopics: []byte(`["source"]`), SponsorUserID: user, SponsorNativeID: 42, LocalAccountID: local.ID, CredentialVersion: 1}); e != nil {
		t.Fatal(e)
	}
	var original []byte
	for version := int64(1); version <= 501; version++ {
		binding := webhookBinding(sub.String(), version)
		cipher, id, e := keys.seal(webhookCredentialDomain, `{"Endpoint":"https://receiver.example.com/secret","SigningSecret":"`+strings.Repeat("K", 32)+`"}`, binding)
		if e != nil {
			t.Fatal(e)
		}
		if version == 501 {
			original = append([]byte(nil), cipher...)
			cipher[0] ^= 1
		}
		if e = q.CreateWebhookCredential(t.Context(), database.CreateWebhookCredentialParams{SubscriptionID: sub, Version: version, DestinationHost: "receiver.example.com", EncryptedCredential: cipher, CredentialBinding: binding, CredentialKeyID: id}); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = New(cfg, db); !errors.Is(e, errKeyBootstrap) {
		t.Fatal("later-page corrupt webhook registered key", e)
	}
	if _, e = q.GetKeyFingerprint(t.Context(), "legacy"); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("partial legacy bootstrap committed fingerprint", e)
	}
	if _, e = db.Exec(`UPDATE golf_webhook_credentials SET encrypted_credential=$2 WHERE subscription_id=$1 AND version=501`, sub, original); e != nil {
		t.Fatal(e)
	}
	if _, e = New(cfg, db); e != nil {
		t.Fatal("repaired retained history unreadable", e)
	}
	status, e := KeyStatus(t.Context(), db, keys)
	if e != nil {
		t.Fatal(e)
	}
	var count uint64
	for _, v := range status.Keys {
		count += v.WebhookCredentials
	}
	if count != 501 {
		t.Fatal("legacy history discarded", count)
	}
}

func TestWebhookFrozenCredentialBindingPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	q := database.New(f.db)
	original, e := q.GetWebhookCredential(t.Context(), database.GetWebhookCredentialParams{SubscriptionID: uuid.MustParse(sub.Id), Version: 1})
	if e != nil {
		t.Fatal(e)
	}
	// A valid ciphertext transplanted into a different immutable version must not
	// be opened or silently re-encrypted under the substituted identity.
	if e = q.CreateWebhookCredential(t.Context(), database.CreateWebhookCredentialParams{SubscriptionID: original.SubscriptionID, Version: 2, DestinationHost: original.DestinationHost, EncryptedCredential: original.EncryptedCredential, CredentialBinding: original.CredentialBinding, CredentialKeyID: original.CredentialKeyID}); e != nil {
		t.Fatal(e)
	}
	if _, _, e = f.s.webhookSecret(t.Context(), q, original.SubscriptionID, 2); !errors.Is(e, errCredentialUnavailable) {
		t.Fatal("private credential accepted under substituted version", e)
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	if _, e = RotateCredentials(t.Context(), f.db, keys, 100, 1); e == nil {
		t.Fatal("rotation legitimized wrong immutable binding")
	}
	var count int
	f.db.QueryRow(`SELECT count(*) FROM golf_webhook_credentials WHERE credential_key_id='next'`).Scan(&count)
	if count != 0 {
		t.Fatal("binding fault committed partial rotation")
	}
}

func TestWebhookNativeAdminObservationAndInstanceOverridePostgres(t *testing.T) {
	f := newWebhookFixture(t, true)
	sub := f.save(t, uuid.NewString(), "0", true)
	f.downgrade.Store(true)
	if _, e := f.s.ListRepositoryWebhooks(f.ctx, webhookRequest(f, &golfv1.ListRepositoryWebhooksRequest{Target: f.target})); connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("Golf instance administrator bypassed current native repository permission", e)
	}
	if _, e := f.s.SaveRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.SaveRepositoryWebhookRequest{Target: f.target, Id: sub.Id, ExpectedVersion: "1", Name: "Must refuse", EventTopics: []string{"source"}})); connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("native write-role created admin subscription", e)
	}
	f.downgrade.Store(false)
	f.denyPermissionAt.Store(f.permissionReads.Load() + 2)
	_, e := f.s.SaveRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.SaveRepositoryWebhookRequest{Target: f.target, Id: sub.Id, ExpectedVersion: "1", Name: "Committed before native revoke", EventTopics: []string{"source"}, Enabled: true, AuthorizeBackground: true}))
	if connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("post-commit current authority not rechecked", e)
	}
	var version int
	f.db.QueryRow(`SELECT version FROM golf_webhook_subscriptions WHERE id=$1`, sub.Id).Scan(&version)
	if version != 2 {
		t.Fatal("post-commit denial falsely treated as no effect")
	}
}

func TestWebhookOwnerTransferDoesNotAdoptFrozenSubscriptionPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	d := f.queue(t, sub, uuid.NewString())
	f.transferred.Store(true)
	current := &golfv1.RepositoryWebhookTarget{Repository: &golfv1.RepositoryKey{Owner: "bob", Name: "example"}, RepositoryId: f.target.RepositoryId, OwnerId: "43"}
	r, e := f.s.ListRepositoryWebhooks(f.ctx, webhookRequest(f, &golfv1.ListRepositoryWebhooksRequest{Target: current}))
	if e != nil || len(r.Msg.Subscriptions) != 0 {
		t.Fatal("current owner saw frozen prior-owner subscription", e)
	}
	if _, e = f.s.ListRepositoryWebhookDeliveries(f.ctx, webhookRequest(f, &golfv1.ListRepositoryWebhookDeliveriesRequest{Target: current, SubscriptionId: sub.Id})); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("prior owner history adopted", e)
	}
	if _, e = f.s.TestRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.TestRepositoryWebhookRequest{Target: current, SubscriptionId: sub.Id, ExpectedVersion: "1", OperationId: uuid.NewString()})); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("prior owner subscription dispatched under transferred target", e)
	}
	if _, e = f.s.TestRepositoryWebhook(f.ctx, webhookRequest(f, &golfv1.TestRepositoryWebhookRequest{Target: current, SubscriptionId: sub.Id, ExpectedVersion: "1", OperationId: d.Id})); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("prior owner operation receipt rebound", e)
	}
	f.s.attemptWebhook(t.Context(), f.claim(t))
	if f.received.Load() != 0 {
		t.Fatal("frozen owner delivery accepted after transfer")
	}
}

func TestWebhookDestinationDenialIsTerminalBeforeHTTPPostgres(t *testing.T) {
	f := newWebhookFixture(t)
	sub := f.save(t, uuid.NewString(), "0", true)
	delivery := f.queue(t, sub, uuid.NewString())
	policy, err := json.Marshal([]webhookEgressApproval{{Origin: f.sink.URL, Addresses: []string{"127.0.0.1"}, PathPrefix: "/replaced"}})
	if err != nil {
		t.Fatal(err)
	}
	f.s.config.WebhookEgressPolicyJSON = string(policy)
	f.s.attemptWebhook(t.Context(), f.claim(t))
	row := f.delivery(t, delivery.Id)
	if row.State != "failed" || row.FailureCode != "destination_denied" || row.PossibleDuplicate || row.Attempts != 1 || f.received.Load() != 0 {
		t.Fatal("denied destination was retried, sent or reported as a receiver uncertainty")
	}
	if _, err := f.s.claimWebhook(t.Context()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("terminal denial returned to the queue", err)
	}
}
