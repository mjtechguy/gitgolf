package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type notificationFixture struct {
	*webhookFixture
	transport *golfv1.EmailTransport
	target    *golfv1.RepositoryEmailTarget
}

func newNotificationFixture(t *testing.T) *notificationFixture {
	t.Helper()
	base := newWebhookFixture(t, true)
	f := &notificationFixture{webhookFixture: base, target: &golfv1.RepositoryEmailTarget{Repository: base.target.Repository, RepositoryId: base.target.RepositoryId, OwnerId: base.target.OwnerId}}
	if _, e := f.db.Exec(`UPDATE golf_local_accounts SET email='alice@example.test' WHERE id=$1`, f.localID); e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	saved, e := f.s.SaveEmailTransport(f.ctx, webhookRequest(base, &golfv1.SaveEmailTransportRequest{Id: id, ExpectedVersion: "0", Name: "Owned SMTP", Host: "smtp.fixture.test", Port: 465, TlsMode: "implicit", Sender: "sender@example.test", CurrentPassword: localTestPassword}))
	if e != nil {
		t.Fatal("save transport", e)
	}
	f.transport = saved.Msg.Transport
	active, e := f.s.ActivateEmailTransport(f.ctx, webhookRequest(base, &golfv1.ActivateEmailTransportRequest{Id: id, Version: "1", ExpectedActivationGeneration: "0", CurrentPassword: localTestPassword}))
	if e != nil || !active.Msg.Transport.Active {
		t.Fatal("activate transport", e)
	}
	return f
}
func (f *notificationFixture) state(t *testing.T) *golfv1.OwnEmailNotificationState {
	t.Helper()
	r, e := f.s.GetOwnEmailNotifications(f.ctx, webhookRequest(f.webhookFixture, &golfv1.GetOwnEmailNotificationsRequest{}))
	if e != nil {
		t.Fatal(e)
	}
	return r.Msg.State
}
func (f *notificationFixture) verification(t *testing.T) *golfv1.RequestEmailVerificationResponse {
	t.Helper()
	r, e := f.s.RequestEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.RequestEmailVerificationRequest{ExpectedContactVersion: f.state(t).ContactVersion, OperationId: uuid.NewString()}))
	if e != nil {
		t.Fatal(e)
	}
	return r.Msg
}
func (f *notificationFixture) claim(t *testing.T) emailDelivery {
	t.Helper()
	d, e := f.s.claimEmail(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	return d
}
func (f *notificationFixture) delivery(t *testing.T, id string) emailDelivery {
	t.Helper()
	d, e := scanEmailDelivery(f.db.QueryRow(`SELECT `+emailDeliveryColumns+` FROM golf_email_deliveries WHERE id=$1`, id))
	if e != nil {
		t.Fatal(e)
	}
	return d
}
func (f *notificationFixture) verifyAndEnable(t *testing.T) *golfv1.OwnEmailNotificationState {
	t.Helper()
	request := f.verification(t)
	smtp := &smtpFixture{}
	n := smtpNetworkFixture(t, smtp, true)
	d := f.claim(t)
	f.s.attemptEmail(t.Context(), d, n, nil)
	if f.delivery(t, d.ID).State != "accepted" {
		t.Fatal("verification not SMTP accepted")
	}
	smtp.mu.Lock()
	body := smtp.body
	smtp.mu.Unlock()
	match := regexp.MustCompile(`verification code is ([0-9]{8})`).FindStringSubmatch(body)
	if len(match) != 2 {
		t.Fatal("controlled receiver missing verification code")
	}
	r, e := f.s.ConfirmEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmEmailVerificationRequest{ChallengeId: request.ChallengeId, ExpectedContactVersion: request.AcceptedContactVersion, Code: match[1]}))
	if e != nil || !r.Msg.State.Verified {
		t.Fatal("confirm own code", e)
	}
	preference, e := f.s.SaveOwnEmailPreference(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveOwnEmailPreferenceRequest{ExpectedContactVersion: r.Msg.State.ContactVersion, ExpectedPreferenceVersion: r.Msg.State.PreferenceVersion, Enabled: true, AuthorizeBackground: true}))
	if e != nil {
		t.Fatal(e)
	}
	return preference.Msg.State
}
func (f *notificationFixture) subscribe(t *testing.T) *golfv1.RepositoryEmailSubscription {
	t.Helper()
	state := f.verifyAndEnable(t)
	r, e := f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveRepositoryEmailSubscriptionRequest{Target: f.target, Id: uuid.NewString(), ExpectedVersion: "0", ExpectedContactVersion: state.ContactVersion, EventTopics: []string{"source", "pulls"}, Enabled: true, AuthorizeBackground: true}))
	if e != nil {
		t.Fatal(e)
	}
	return r.Msg.Subscription
}
func (f *notificationFixture) event(t *testing.T, topic string) {
	t.Helper()
	if _, e := f.db.Exec(`INSERT INTO golf_repository_activity(forge_url,repository_id,topic,recipient_user_id) VALUES($1,$2,$3,0)`, f.s.config.GiteaURL, int64(9007199254740993), topic); e != nil {
		t.Fatal(e)
	}
}
func TestNotificationVerificationCASRateAttemptsAndMetadataPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	state := f.state(t)
	if state.Verified || state.Enabled || state.ContactVersion != "0" {
		t.Fatal("alias was implicitly verified")
	}
	request := f.verification(t)
	if request.State.Verified || request.State.Enabled || request.AcceptedContactVersion != "1" || request.State.ChallengeId != request.ChallengeId {
		t.Fatal("request receipt")
	}
	replay, e := f.s.RequestEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.RequestEmailVerificationRequest{ExpectedContactVersion: "0", OperationId: request.ChallengeId}))
	if e != nil || replay.Msg.ChallengeId != request.ChallengeId {
		t.Fatal("operation replay", e)
	}
	var count int
	f.db.QueryRow(`SELECT count(*) FROM golf_email_deliveries`).Scan(&count)
	if count != 1 {
		t.Fatal("replay duplicated mail")
	}
	raw, _ := json.Marshal(request)
	if strings.Contains(string(raw), "Your Golf email verification") || strings.Contains(string(raw), "sender@example.test") {
		t.Fatal("private mail in RPC metadata")
	}
	for i := 0; i < 5; i++ {
		_, e = f.s.ConfirmEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmEmailVerificationRequest{ChallengeId: request.ChallengeId, ExpectedContactVersion: "1", Code: "not-code"}))
		if e == nil {
			t.Fatal("malformed code accepted")
		}
	}
	var codePayload emailMailSecret
	d := f.delivery(t, request.DeliveryId)
	if e = f.s.notificationLoad(t.Context(), f.db, d.ContentID.String, "mail", &codePayload); e != nil {
		t.Fatal(e)
	}
	match := regexp.MustCompile(`verification code is ([0-9]{8})`).FindStringSubmatch(codePayload.Body)
	if len(match) != 2 {
		t.Fatal("fixture code absent")
	}
	wrong := "00000000"
	if match[1] == wrong {
		wrong = "11111111"
	}
	for i := 0; i < 5; i++ {
		_, e = f.s.ConfirmEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmEmailVerificationRequest{ChallengeId: request.ChallengeId, ExpectedContactVersion: "1", Code: wrong}))
		if e == nil {
			t.Fatal("wrong code accepted")
		}
	}
	_, e = f.s.ConfirmEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmEmailVerificationRequest{ChallengeId: request.ChallengeId, ExpectedContactVersion: "1", Code: match[1]}))
	if e == nil {
		t.Fatal("exhausted challenge accepted")
	}
	f.verification(t)
	f.verification(t)
	_, e = f.s.RequestEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.RequestEmailVerificationRequest{ExpectedContactVersion: f.state(t).ContactVersion, OperationId: uuid.NewString()}))
	if e == nil {
		t.Fatal("hourly request cap bypassed")
	}
}
func TestNotificationOutboxLogoutAndPrivateExclusionPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	sub := f.subscribe(t)
	tx, e := f.db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	_, e = tx.Exec(`INSERT INTO golf_repository_activity(forge_url,repository_id,topic,recipient_user_id) VALUES($1,$2,'source',0)`, f.s.config.GiteaURL, int64(9007199254740993))
	if e != nil {
		t.Fatal(e)
	}
	tx.Rollback()
	if _, e = f.s.claimEmail(t.Context()); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("rolled-back activity queued mail")
	}
	if _, e = f.db.Exec(`INSERT INTO golf_repository_activity(forge_url,repository_id,topic,recipient_user_id) VALUES($1,$2,'agents',42)`, f.s.config.GiteaURL, int64(9007199254740993)); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.claimEmail(t.Context()); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("private agent event leaked")
	}
	f.event(t, "pulls")
	d := f.claim(t)
	if d.SubscriptionID.String != sub.Id {
		t.Fatal("wrong frozen subscription")
	}
	logout := webhookRequest(f.webhookFixture, &golfv1.LogoutRequest{})
	if _, e = f.s.Logout(f.ctx, logout); e != nil {
		t.Fatal(e)
	}
	smtp := &smtpFixture{}
	f.s.attemptEmail(t.Context(), d, smtpNetworkFixture(t, smtp, true), nil)
	if f.delivery(t, d.ID).State != "accepted" {
		t.Fatal("explicit logout-persistent consent lost")
	}
	smtp.mu.Lock()
	body := smtp.body
	smtp.mu.Unlock()
	if !strings.Contains(body, "Golf observed a repository pulls change.") || strings.Contains(body, "owned-webhook-native-token") || strings.Contains(body, "Owned private issue text") {
		t.Fatal("unexpected activity mail content")
	}
}
func TestNotificationCurrentAuthorityAndRecipientSuppressionPostgres(t *testing.T) {
	for _, mode := range []string{"native_before_DATA", "native_identity", "repo_replaced", "mailbox_rejected", "credential_changed"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotificationFixture(t)
			f.subscribe(t)
			f.event(t, "source")
			d := f.claim(t)
			smtp := &smtpFixture{}
			switch mode {
			case "native_before_DATA":
				smtp.onRCPT = func() { f.revoked.Store(true) }
			case "native_identity":
				f.foreignActor.Store(true)
			case "repo_replaced":
				f.replacement.Store(true)
			case "mailbox_rejected":
				smtp.rcpt = "550 5.1.1 owned absent"
			case "credential_changed":
				if _, e := f.db.Exec(`UPDATE golf_local_accounts SET credential_version=credential_version+1 WHERE id=$1`, f.localID); e != nil {
					t.Fatal(e)
				}
			}
			f.s.attemptEmail(t.Context(), d, smtpNetworkFixture(t, smtp, true), nil)
			observed := f.delivery(t, d.ID)
			if mode == "mailbox_rejected" {
				if observed.State != "suppressed" || observed.SMTPStatus != 550 {
					t.Fatal("mailbox refusal not suppressed")
				}
				var enabled bool
				var suppression string
				if e := f.db.QueryRow(`SELECT enabled,suppression FROM golf_email_contacts`).Scan(&enabled, &suppression); e != nil || enabled || suppression != "recipient_rejected" {
					t.Fatal("suppression not durable", e)
				}
			} else {
				if observed.State != "cancelled" {
					t.Fatal("revoked observation not cancelled", observed.State)
				}
				smtp.mu.Lock()
				defer smtp.mu.Unlock()
				for _, cmd := range smtp.commands {
					if cmd == "DATA" {
						t.Fatal("revoked/private target received DATA")
					}
				}
			}
		})
	}
}
func TestNotificationLostAckFrozenMessageAndRedeliveryPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	f.subscribe(t)
	f.event(t, "source")
	first := f.claim(t)
	smtp := &smtpFixture{dropAck: true}
	f.s.attemptEmail(t.Context(), first, smtpNetworkFixture(t, smtp, true), nil)
	d := f.delivery(t, first.ID)
	if d.State != "retrying" || !d.Duplicate {
		t.Fatal("lost ack is not unknown duplicate")
	}
	smtp.mu.Lock()
	original := smtp.body
	smtp.mu.Unlock()
	if _, e := f.db.Exec(`UPDATE golf_email_deliveries SET next_attempt_at=clock_timestamp() WHERE id=$1`, d.ID); e != nil {
		t.Fatal(e)
	}
	retry := f.claim(t)
	smtp2 := &smtpFixture{}
	f.s.attemptEmail(t.Context(), retry, smtpNetworkFixture(t, smtp2, true), nil)
	smtp2.mu.Lock()
	resent := smtp2.body
	smtp2.mu.Unlock()
	if original != resent || f.delivery(t, d.ID).State != "accepted" {
		t.Fatal("automatic retry changed frozen Message-ID/body")
	}
	state := f.state(t)
	operation := uuid.NewString()
	r, e := f.s.RedeliverOwnEmail(f.ctx, webhookRequest(f.webhookFixture, &golfv1.RedeliverOwnEmailRequest{DeliveryId: d.ID, OperationId: operation, ExpectedContactVersion: state.ContactVersion}))
	if e != nil || r.Msg.Delivery.Id != operation || r.Msg.Delivery.EventId != d.EventID || !r.Msg.Delivery.PossibleDuplicate {
		t.Fatal("explicit redelivery", e)
	}
	replay, e := f.s.RedeliverOwnEmail(f.ctx, webhookRequest(f.webhookFixture, &golfv1.RedeliverOwnEmailRequest{DeliveryId: d.ID, OperationId: operation, ExpectedContactVersion: state.ContactVersion}))
	if e != nil || replay.Msg.Delivery.Id != operation {
		t.Fatal("redelivery replay", e)
	}
	newDelivery := f.claim(t)
	smtp3 := &smtpFixture{}
	f.s.attemptEmail(t.Context(), newDelivery, smtpNetworkFixture(t, smtp3, true), nil)
	smtp3.mu.Lock()
	third := smtp3.body
	smtp3.mu.Unlock()
	if third == original || !strings.Contains(third, "Message-ID: <"+operation+"@golf.notifications>") {
		t.Fatal("explicit redelivery reused original message identity")
	}
	f.revoked.Store(true)
	if _, e = f.s.RedeliverOwnEmail(f.ctx, webhookRequest(f.webhookFixture, &golfv1.RedeliverOwnEmailRequest{DeliveryId: d.ID, OperationId: operation, ExpectedContactVersion: state.ContactVersion})); e == nil {
		t.Fatal("redelivery replay exposed revoked native target")
	}
}
func TestNotificationActivationUnsubscribeAndCurrentReadFencesPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	sub := f.subscribe(t)
	f.event(t, "source")
	d := f.claim(t)
	_, e := f.s.ActivateEmailTransport(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ActivateEmailTransportRequest{Id: f.transport.Id, Version: "1", ExpectedActivationGeneration: "1", CurrentPassword: localTestPassword}))
	if e != nil {
		t.Fatal(e)
	}
	smtp := &smtpFixture{}
	f.s.attemptEmail(t.Context(), d, smtpNetworkFixture(t, smtp, true), nil)
	if f.delivery(t, d.ID).State != "cancelled" {
		t.Fatal("old activation generation dispatched")
	}
	// Cancellation paused the old consent. Re-enable explicitly before proving
	// a GET cannot disable, then a deliberate POST can disable this new version.
	state := f.state(t)
	resumed, e := f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveRepositoryEmailSubscriptionRequest{Target: f.target, Id: sub.Id, ExpectedVersion: sub.Version, ExpectedContactVersion: state.ContactVersion, EventTopics: []string{"source"}, Enabled: true, AuthorizeBackground: true}))
	if e != nil || !resumed.Msg.Subscription.Enabled {
		t.Fatal("explicit consent resume failed", e)
	}
	var contentID string
	if e = f.db.QueryRow(`SELECT content_id::text FROM golf_email_subscriptions WHERE id=$1`, sub.Id).Scan(&contentID); e != nil {
		t.Fatal(e)
	}
	var secret emailSubscriptionSecret
	if e = f.s.notificationLoad(t.Context(), f.db, contentID, "subscription", &secret); e != nil {
		t.Fatal(e)
	}
	handler := f.s.EmailUnsubscribeHandler()
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/notifications/unsubscribe?token="+secret.UnsubscribeToken, nil))
	var enabled bool
	f.db.QueryRow(`SELECT enabled FROM golf_email_subscriptions WHERE id=$1`, sub.Id).Scan(&enabled)
	if get.Code != 200 || !enabled || strings.Contains(get.Body.String(), "alice@example.test") {
		t.Fatal("unsubscribe GET changed/exposed subscription")
	}
	post := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/notifications/unsubscribe", strings.NewReader(url.Values{"token": {secret.UnsubscribeToken}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	handler.ServeHTTP(post, req)
	f.db.QueryRow(`SELECT enabled FROM golf_email_subscriptions WHERE id=$1`, sub.Id).Scan(&enabled)
	if post.Code != 200 || enabled || post.Header().Get("Location") != "" {
		t.Fatal("unsubscribe POST failed")
	}
	f.revoked.Store(true)
	if _, e = f.s.GetRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.GetRepositoryEmailSubscriptionRequest{Target: f.target})); e == nil {
		t.Fatal("lost current read still exposed subscription")
	}
	if _, e = f.s.ListOwnEmailDeliveries(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ListOwnEmailDeliveriesRequest{Target: f.target})); e == nil {
		t.Fatal("lost current read exposed private history")
	}
}
func TestNotificationConcurrentCASExpiryAndSQLAckLossPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	request := f.verification(t)
	var payload emailMailSecret
	d := f.delivery(t, request.DeliveryId)
	if e := f.s.notificationLoad(t.Context(), f.db, d.ContentID.String, "mail", &payload); e != nil {
		t.Fatal(e)
	}
	code := regexp.MustCompile(`verification code is ([0-9]{8})`).FindStringSubmatch(payload.Body)[1]
	if _, e := f.db.Exec(`UPDATE golf_email_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, request.ChallengeId); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.ConfirmEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmEmailVerificationRequest{ChallengeId: request.ChallengeId, Code: code, ExpectedContactVersion: "1"})); e == nil {
		t.Fatal("expired challenge accepted")
	}
	f.verifyAndEnable(t)
	state := f.state(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	success := 0
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.s.SaveOwnEmailPreference(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveOwnEmailPreferenceRequest{ExpectedContactVersion: state.ContactVersion, ExpectedPreferenceVersion: state.PreferenceVersion, Enabled: true, AuthorizeBackground: true}))
			if e == nil {
				mu.Lock()
				success++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if success != 1 {
		t.Fatal("concurrent preference CAS admitted multiple changes")
	}
	s, e := f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveRepositoryEmailSubscriptionRequest{Target: f.target, Id: uuid.NewString(), ExpectedVersion: "0", ExpectedContactVersion: state.ContactVersion, EventTopics: []string{"source"}, Enabled: true, AuthorizeBackground: true}))
	if e != nil {
		t.Fatal(e)
	}
	_ = s
	f.event(t, "source")
	d = f.claim(t)
	if _, e = f.db.Exec(`CREATE FUNCTION golf_owned_fail_email_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='accepted' THEN RAISE EXCEPTION 'owned receipt fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER golf_owned_email_ack BEFORE UPDATE ON golf_email_deliveries FOR EACH ROW EXECUTE FUNCTION golf_owned_fail_email_ack()`); e != nil {
		t.Fatal(e)
	}
	smtp := &smtpFixture{}
	f.s.attemptEmail(t.Context(), d, smtpNetworkFixture(t, smtp, true), nil)
	if f.delivery(t, d.ID).State != "sending" {
		t.Fatal("lost SQL receipt invented acceptance")
	}
	if _, e = f.db.Exec(`DROP TRIGGER golf_owned_email_ack ON golf_email_deliveries`); e != nil {
		t.Fatal(e)
	}
	if _, e = f.db.Exec(`UPDATE golf_email_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, d.ID); e != nil {
		t.Fatal(e)
	}
	retry := f.claim(t)
	if !retry.Duplicate || retry.Attempts != 2 {
		t.Fatal("expired accepted-but-unrecorded attempt lost uncertainty")
	}
}
func TestNotificationKeyInventoryRotationAndRetirementPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	f.subscribe(t)
	f.event(t, "source")
	d := f.claim(t)
	smtp := &smtpFixture{}
	f.s.attemptEmail(t.Context(), d, smtpNetworkFixture(t, smtp, true), nil)
	status, e := KeyStatus(t.Context(), f.db, f.s.keyring)
	if e != nil {
		t.Fatal(e)
	}
	var expected int64
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_notification_contents`).Scan(&expected); e != nil || expected < 5 {
		t.Fatal("missing retained private families", e)
	}
	var observed uint64
	for _, k := range status.Keys {
		observed += k.NotificationContents
	}
	if observed != uint64(expected) {
		t.Fatal("private mail missing from key inventory")
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	rotation, e := RotateCredentials(t.Context(), f.db, keys, 2, 20)
	if e != nil || !rotation.Complete || rotation.RotatedNotificationContents != uint64(expected) {
		t.Fatal("notification rotation incomplete", e)
	}
	var payload emailMailSecret
	if e = f.s.notificationLoad(t.Context(), f.db, f.delivery(t, d.ID).ContentID.String, "mail", &payload); e == nil {
		t.Fatal("old runtime keyring read newly keyed private content")
	}
	f.s.keyring = keys
	if e = f.s.notificationLoad(t.Context(), f.db, f.delivery(t, d.ID).ContentID.String, "mail", &payload); e != nil {
		t.Fatal("rotated mail did not reopen", e)
	}
	var audited int64
	if e = f.db.QueryRow(`SELECT COALESCE(sum(notification_contents_count),0) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'`).Scan(&audited); e != nil || audited != expected {
		t.Fatal("named crypto audit mismatch", e)
	}
}
func TestNotificationOwnAuthorityAndVersionValidationPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	request := f.verification(t)
	foreign := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "owned-webhook-native-token", Local: false})
	if _, e := f.s.GetOwnEmailNotifications(foreign, webhookRequest(f.webhookFixture, &golfv1.GetOwnEmailNotificationsRequest{})); e == nil {
		t.Fatal("native token session acquired background identity")
	}
	bad := &golfv1.RepositoryEmailTarget{Repository: f.target.Repository, OwnerId: f.target.OwnerId, RepositoryId: strconv.FormatInt(9007199254740994, 10)}
	if _, e := f.s.GetRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.GetRepositoryEmailSubscriptionRequest{Target: bad})); e == nil {
		t.Fatal("wrong repository ID accepted")
	}
	if _, e := f.db.Exec(`UPDATE golf_local_accounts SET credential_version=credential_version+1 WHERE id=$1`, f.localID); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.ConfirmEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmEmailVerificationRequest{ChallengeId: request.ChallengeId, ExpectedContactVersion: "1", Code: "00000000"})); e == nil {
		t.Fatal("stale credential confirmed mailbox")
	}
}

func TestNotificationKeyFaultBusyRetirementAndActiveFencePostgres(t *testing.T) {
	f := newNotificationFixture(t)
	r := f.verification(t)
	d := f.delivery(t, r.DeliveryId)
	var before []byte
	if e := f.db.QueryRow(`SELECT encrypted_content FROM golf_notification_contents WHERE id=$1`, d.ContentID.String).Scan(&before); e != nil {
		t.Fatal(e)
	}
	keys := rotationKeys(t, f.s.config)
	mustActivate(t, f.db, keys)
	if _, e := CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); !errors.Is(e, errKeyRetirement) {
		t.Fatal("retained notification key could retire", e)
	}
	if e := f.s.notificationStore(t.Context(), f.db, uuid.NewString(), "mail", emailMailSecret{"alice@example.test", "private"}); e == nil {
		t.Fatal("inactive writer inserted new notification ciphertext")
	}
	if _, e := f.db.Exec(`CREATE FUNCTION owned_notification_crypto_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned history fault'; END $$; CREATE TRIGGER owned_notification_crypto_fault BEFORE INSERT ON golf_crypto_events FOR EACH ROW EXECUTE FUNCTION owned_notification_crypto_fault()`); e != nil {
		t.Fatal(e)
	}
	failed, e := RotateCredentials(t.Context(), f.db, keys, 1000, 1)
	if !errors.Is(e, errStorageUnavailable) || failed.RotatedNotificationContents != 0 {
		t.Fatal("failed journal batch reported success", e)
	}
	var after []byte
	var label string
	if e := f.db.QueryRow(`SELECT encrypted_content,credential_key_id FROM golf_notification_contents WHERE id=$1`, d.ContentID.String).Scan(&after, &label); e != nil || !bytes.Equal(before, after) || label != "legacy" {
		t.Fatal("partial mail rotation escaped rollback", e)
	}
	if _, e := f.db.Exec(`DROP TRIGGER owned_notification_crypto_fault ON golf_crypto_events`); e != nil {
		t.Fatal(e)
	}
	held, e := f.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer held.Rollback()
	if _, e = held.Exec(`SELECT id FROM golf_notification_contents WHERE id=$1 FOR UPDATE`, d.ContentID.String); e != nil {
		t.Fatal(e)
	}
	partial, e := RotateCredentials(t.Context(), f.db, keys, 1000, 2)
	if e != nil || partial.Complete {
		t.Fatal("locked private mail was hidden", e)
	}
	if _, e = CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); !errors.Is(e, errKeyRetirement) {
		t.Fatal("busy mail key could retire", e)
	}
	if e = held.Commit(); e != nil {
		t.Fatal(e)
	}
	done, e := RotateCredentials(t.Context(), f.db, keys, 1000, 2)
	if e != nil || !done.Complete || done.RotatedNotificationContents != 1 {
		t.Fatal("mail lock resume failed", e)
	}
	if _, e = CheckKeyRetirement(t.Context(), f.db, keys, "legacy"); e != nil {
		t.Fatal("fully rotated inactive key cannot retire", e)
	}
	f.s.keyring = keys
	var mail emailMailSecret
	if e = f.s.notificationLoad(t.Context(), f.db, d.ContentID.String, "mail", &mail); e != nil {
		t.Fatal("rotated mail cannot reopen", e)
	}
}
func TestNotificationLegacyBootstrapLaterPagePostgres(t *testing.T) {
	db := testDatabase(t)
	keys := parseTestKeys(t, keyFixture(1), nil, "")
	tx, e := db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	var lastID string
	var valid []byte
	for i := 0; i < 501; i++ {
		id := fmt.Sprintf("00000000-0000-4000-8000-%012x", i)
		binding := notificationBinding(id, "mail")
		cipher, _, e := keys.seal(notificationContentDomain, `{"Recipient":"alice@example.test","Body":"retained private mail"}`, binding)
		if e != nil {
			t.Fatal(e)
		}
		if i == 500 {
			lastID = id
			valid = append([]byte{}, cipher...)
			cipher[0] ^= 1
		}
		if _, e = tx.Exec(`INSERT INTO golf_notification_contents(id,kind,encrypted_content,content_binding,credential_key_id) VALUES($1,'mail',$2,$3,'legacy')`, id, cipher, binding); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	cfg := testConfig("https://forge.invalid")
	cfg.EncryptionKey = keyFixture(1)
	if _, e = New(cfg, db); !errors.Is(e, errKeyBootstrap) {
		t.Fatal("second-page private mail skipped", e)
	}
	if _, e = database.New(db).GetKeyFingerprint(t.Context(), "legacy"); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("partial private validation bound key")
	}
	if _, e = db.Exec(`UPDATE golf_notification_contents SET encrypted_content=$2 WHERE id=$1`, lastID, valid); e != nil {
		t.Fatal(e)
	}
	if _, e = New(cfg, db); e != nil {
		t.Fatal("repaired retained content did not bootstrap", e)
	}
	status, e := KeyStatus(t.Context(), db, keys)
	if e != nil {
		t.Fatal(e)
	}
	var count uint64
	for _, k := range status.Keys {
		count += k.NotificationContents
	}
	if count != 501 {
		t.Fatal("bootstrap purged content")
	}
}

func TestNotificationTransferRequiresNewConsentPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	old := f.subscribe(t)
	f.event(t, "source")
	d := f.claim(t)
	f.transferred.Store(true)
	fresh := &golfv1.RepositoryEmailTarget{Repository: &golfv1.RepositoryKey{Owner: "bob", Name: "example"}, RepositoryId: f.target.RepositoryId, OwnerId: "43"}
	current, e := f.s.GetRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.GetRepositoryEmailSubscriptionRequest{Target: fresh}))
	if e != nil || current.Msg.Subscription != nil {
		t.Fatal("transferred subscription silently adopted", e)
	}
	saved, e := f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveRepositoryEmailSubscriptionRequest{Target: fresh, Id: uuid.NewString(), ExpectedVersion: "0", ExpectedContactVersion: current.Msg.State.ContactVersion, EventTopics: []string{"source"}, Enabled: true, AuthorizeBackground: true}))
	if e != nil || saved.Msg.Subscription.Id == old.Id {
		t.Fatal("fresh transfer consent failed", e)
	}
	smtp := &smtpFixture{}
	f.s.attemptEmail(t.Context(), d, smtpNetworkFixture(t, smtp, true), nil)
	if f.delivery(t, d.ID).State != "cancelled" {
		t.Fatal("old immutable owner dispatched")
	}
	smtp.mu.Lock()
	defer smtp.mu.Unlock()
	if len(smtp.commands) != 0 {
		t.Fatal("old transfer contacted receiver")
	}
}
func TestNotificationWorkerDoesNotClaimForeignForgePostgres(t *testing.T) {
	f := newNotificationFixture(t)
	request := f.verification(t)
	originalURL := f.s.config.GiteaURL
	f.s.config.GiteaURL = "https://other.invalid"
	defer func() { f.s.config.GiteaURL = originalURL }()
	if _, e := f.s.claimEmail(t.Context()); !errors.Is(e, sql.ErrNoRows) {
		t.Fatal("foreign worker claimed another forge", e)
	}
	if f.delivery(t, request.DeliveryId).State != "queued" {
		t.Fatal("foreign worker cancelled another forge")
	}
	f.s.config.GiteaURL = originalURL
	if got := f.claim(t); got.ID != request.DeliveryId {
		t.Fatal("own worker missed queued message")
	}
}

func TestNotificationRepositoryAdmissionCapacityPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	sub := f.subscribe(t)
	// Retained historical owner scopes count toward the explicit repository bound.
	_, e := f.db.Exec(`INSERT INTO golf_email_subscriptions(id,user_id,forge_url,repository_id,owner_id,repository_owner,repository_name,local_account_id,native_user_id,credential_version,contact_version,version,event_topics,enabled,authorization_state,unsubscribe_hash,content_id)
 SELECT gen_random_uuid(),user_id,forge_url,repository_id,100+n,repository_owner,repository_name,local_account_id,native_user_id,credential_version,contact_version,1,event_topics,false,'disabled',unsubscribe_hash,content_id FROM golf_email_subscriptions CROSS JOIN generate_series(1,499) n WHERE id=$1`, sub.Id)
	if e != nil {
		t.Fatal(e)
	}
	f.transferred.Store(true)
	target := &golfv1.RepositoryEmailTarget{Repository: &golfv1.RepositoryKey{Owner: "bob", Name: "example"}, RepositoryId: f.target.RepositoryId, OwnerId: "43"}
	_, e = f.s.SaveRepositoryEmailSubscription(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveRepositoryEmailSubscriptionRequest{Target: target, Id: uuid.NewString(), ExpectedVersion: "0", ExpectedContactVersion: f.state(t).ContactVersion, EventTopics: []string{"source"}, Enabled: true, AuthorizeBackground: true}))
	if connect.CodeOf(e) != connect.CodeResourceExhausted {
		t.Fatal("bounded repository admission lost refusal", e)
	}
	var count int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_email_subscriptions`).Scan(&count); e != nil || count != 500 {
		t.Fatal("capacity refusal added subscription", e)
	}
}
