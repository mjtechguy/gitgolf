package server

import (
	"context"
	"encoding/base64"
	"io"
	"mime/quotedprintable"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func recoveryRequest90(t *testing.T, f *notificationFixture, email, id string) {
	t.Helper()
	r, e := f.s.RequestPasswordRecovery(t.Context(), connect.NewRequest(&golfv1.RequestPasswordRecoveryRequest{Email: email, OperationId: id}))
	if e != nil || r.Msg.Message != recoveryMessage90 {
		t.Fatal("nonuniform request", e, r)
	}
}
func deliveredRecovery90(t *testing.T, f *notificationFixture, id string) string {
	t.Helper()
	smtp := &smtpFixture{}
	network := smtpNetworkFixture(t, smtp, true)
	d := f.claim(t)
	if d.ID != id {
		t.Fatal("wrong recovery outbox original")
	}
	f.s.attemptEmail(t.Context(), d, network, nil)
	if f.delivery(t, id).State != "accepted" {
		t.Fatal("recovery SMTP acceptance")
	}
	smtp.mu.Lock()
	body := smtp.body
	smtp.mu.Unlock()
	text, e := io.ReadAll(quotedprintable.NewReader(strings.NewReader(body)))
	if e != nil {
		t.Fatal(e)
	}
	code := regexp.MustCompile(regexp.QuoteMeta(id) + `\.[A-Za-z0-9_-]{32}`).FindString(string(text))
	if code == "" {
		t.Fatal("missing delivered capability")
	}
	return code
}
func TestPasswordRecovery90VerifiedDeliveryAndMFAIsolationPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	f.verifyAndEnable(t)
	enrollRecovery90(t, f)
	begin, e := f.s.BeginOwnMFA(f.ctx, webhookRequest(f.webhookFixture, &golfv1.BeginOwnMFARequest{ExpectedVersion: "0", PasswordConfirmation: localTestPassword}))
	if e != nil {
		t.Fatal(e)
	}
	code, e := totpCode(begin.Msg.Secret, time.Now().Unix()/30)
	if e != nil {
		t.Fatal(e)
	}
	factor, e := f.s.ConfirmOwnMFA(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmOwnMFARequest{ExpectedVersion: begin.Msg.Mfa.Version, PasswordConfirmation: localTestPassword, Code: code}))
	if e != nil {
		t.Fatal(e)
	}
	var before string
	if e = f.db.QueryRow(`SELECT to_jsonb(m)::text FROM golf_local_mfa m WHERE account_id=$1`, f.localID).Scan(&before); e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	recoveryRequest90(t, f, "alice@example.test", id)
	recoveryRequest90(t, f, "alice@example.test", id)
	var count int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_email_deliveries WHERE id=$1`, id).Scan(&count); e != nil || count != 1 {
		t.Fatal("recovery request replay sent another email", e, count)
	}
	recovery := deliveredRecovery90(t, f, id)
	nextPassword := "new owned password recovery passphrase"
	response, e := f.s.CompletePasswordRecovery(t.Context(), connect.NewRequest(&golfv1.CompletePasswordRecoveryRequest{RecoveryCode: recovery, NewPassword: nextPassword}))
	if e != nil || !response.Msg.RequiresLogin {
		t.Fatal("recovery", e, response)
	}
	var after string
	if e = f.db.QueryRow(`SELECT to_jsonb(m)::text FROM golf_local_mfa m WHERE account_id=$1`, f.localID).Scan(&after); e != nil || after != before {
		t.Fatal("password recovery changed the MFA factor", e)
	}
	if _, e = f.s.CompletePasswordRecovery(t.Context(), connect.NewRequest(&golfv1.CompletePasswordRecoveryRequest{RecoveryCode: recovery, NewPassword: nextPassword})); e == nil {
		t.Fatal("recovery capability reused")
	}
	if _, e = f.s.loginLocalSession(t.Context(), "alice@example.test", localTestPassword, ""); e == nil {
		t.Fatal("old password survived")
	}
	login, e := f.s.loginLocalSession(t.Context(), "alice@example.test", nextPassword, "")
	if e != nil || login.MFAChallenge == "" {
		t.Fatal("new password bypassed MFA", e, login)
	}
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_sessions WHERE user_id=(SELECT user_id FROM golf_local_accounts WHERE id=$1)`, f.localID).Scan(&count); e != nil || count != 0 {
		t.Fatal("old browser sessions survived", e, count)
	}
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_mfa_recovery_codes WHERE account_id=$1 AND used_at IS NULL`, f.localID).Scan(&count); e != nil || count != 10 {
		t.Fatal("MFA recovery codes erased", e, count)
	}
	if len(factor.Msg.RecoveryCodes) != 10 {
		t.Fatal("owned MFA fixture incomplete")
	}
}
func TestPasswordRecovery90GenericPurposeLimitsAndRevocationPostgres(t *testing.T) {
	t.Run("unknown and unverified", func(t *testing.T) {
		f := newNotificationFixture(t)
		for _, email := range []string{"missing@example.test", "alice@example.test", "bad"} {
			recoveryRequest90(t, f, email, uuid.NewString())
		}
		var n int
		if e := f.db.QueryRow(`SELECT count(*) FROM golf_email_deliveries`).Scan(&n); e != nil || n != 0 {
			t.Fatal("unverified/unknown mailed", e, n)
		}
	})
	t.Run("delivery and code follow current identity", func(t *testing.T) {
		f := newNotificationFixture(t)
		f.verifyAndEnable(t)
		enrollRecovery90(t, f)
		id := uuid.NewString()
		recoveryRequest90(t, f, "alice@example.test", id)
		var mail emailMailSecret
		d := f.delivery(t, id)
		if e := f.s.notificationLoad(t.Context(), f.db, d.ContentID.String, "mail", &mail); e != nil {
			t.Fatal(e)
		}
		text, _ := io.ReadAll(quotedprintable.NewReader(strings.NewReader(mail.Body)))
		capability := regexp.MustCompile(regexp.QuoteMeta(id) + `\.[A-Za-z0-9_-]{32}`).FindString(string(text))
		if capability == "" {
			t.Fatal("mail capability")
		}
		if _, e := f.db.Exec(`UPDATE golf_local_accounts SET credential_version=credential_version+1 WHERE id=$1`, f.localID); e != nil {
			t.Fatal(e)
		}
		if _, e := f.s.emailAuthority(t.Context(), d); e == nil {
			t.Fatal("stale recovery email admitted")
		}
		if _, e := f.s.CompletePasswordRecovery(t.Context(), connect.NewRequest(&golfv1.CompletePasswordRecoveryRequest{RecoveryCode: capability, NewPassword: localTestPassword})); e == nil {
			t.Fatal("changed account recovered")
		}
	})
	t.Run("wrong guesses exhausted", func(t *testing.T) {
		f := newNotificationFixture(t)
		f.verifyAndEnable(t)
		enrollRecovery90(t, f)
		id := uuid.NewString()
		recoveryRequest90(t, f, "alice@example.test", id)
		good := deliveredRecovery90(t, f, id)
		bad := id + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 24))
		for i := 0; i < 5; i++ {
			if _, e := f.s.CompletePasswordRecovery(t.Context(), connect.NewRequest(&golfv1.CompletePasswordRecoveryRequest{RecoveryCode: bad, NewPassword: localTestPassword})); e == nil {
				t.Fatal("wrong code accepted")
			}
		}
		if _, e := f.s.CompletePasswordRecovery(t.Context(), connect.NewRequest(&golfv1.CompletePasswordRecoveryRequest{RecoveryCode: good, NewPassword: localTestPassword})); e == nil {
			t.Fatal("exhausted code accepted")
		}
	})
	t.Run("distinct challenge purpose", func(t *testing.T) {
		f := newNotificationFixture(t)
		f.verifyAndEnable(t)
		enrollRecovery90(t, f)
		id := uuid.NewString()
		recoveryRequest90(t, f, "alice@example.test", id)
		state := f.state(t)
		if state.ChallengeId != "" {
			t.Fatal("recovery exposed as verification challenge")
		}
		if _, e := f.s.ConfirmEmailVerification(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ConfirmEmailVerificationRequest{ChallengeId: id, ExpectedContactVersion: state.ContactVersion, Code: "12345678"})); e == nil {
			t.Fatal("recovery challenge used for email verification")
		}
		for i := 0; i < 5; i++ {
			recoveryRequest90(t, f, "alice@example.test", uuid.NewString())
		}
		var n int
		if e := f.db.QueryRow(`SELECT count(*) FROM golf_email_challenges WHERE purpose='password_recovery'`).Scan(&n); e != nil || n != 3 {
			t.Fatal("recovery mail rate cap", e, n)
		}
	})
}
func TestPasswordRecovery90PublicBoundaryPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	request := func(origin string) *http.Request {
		r, _ := http.NewRequestWithContext(context.Background(), "POST", f.s.config.PublicURL+"/rpc/golf.v1.PasswordRecoveryService/RequestPasswordRecovery", strings.NewReader(`{"email":"missing@example.test","operationId":"`+uuid.NewString()+`"}`))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Connect-Protocol-Version", "1")
		return r
	}
	handler := f.s
	for _, origin := range []string{f.s.config.PublicURL, "https://foreign.invalid"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, request(origin))
		want := 200
		if origin != f.s.config.PublicURL {
			want = 403
		}
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("public recovery boundary", origin, w.Code)
		}
	}
}

func TestPasswordRecovery90ExpiryDuringProviderWaitPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	f.verifyAndEnable(t)
	enrollRecovery90(t, f)
	id := uuid.NewString()
	recoveryRequest90(t, f, "alice@example.test", id)
	code := deliveredRecovery90(t, f, id)
	var before string
	if e := f.db.QueryRow(`SELECT password_hash FROM golf_local_accounts WHERE id=$1`, f.localID).Scan(&before); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Exec(`UPDATE golf_email_challenges SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, id); e != nil {
		t.Fatal(e)
	}
	base := f.s.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	var calls atomic.Int32
	f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/v1/user" && calls.Add(1) == 2 {
			time.Sleep(1500 * time.Millisecond)
		}
		return base.RoundTrip(r)
	})
	if _, e := f.s.CompletePasswordRecovery(t.Context(), connect.NewRequest(&golfv1.CompletePasswordRecoveryRequest{RecoveryCode: code, NewPassword: localTestPassword})); e == nil {
		t.Fatal("expired capability reset password after native wait")
	}
	var after string
	var used bool
	if e := f.db.QueryRow(`SELECT password_hash FROM golf_local_accounts WHERE id=$1`, f.localID).Scan(&after); e != nil || after != before {
		t.Fatal("expired recovery changed password", e)
	}
	if e := f.db.QueryRow(`SELECT confirmed_at IS NOT NULL FROM golf_email_challenges WHERE id=$1`, id).Scan(&used); e != nil || used {
		t.Fatal("expired recovery consumed capability", e)
	}
}

func enrollRecovery90(t *testing.T, f *notificationFixture) {
	t.Helper()
	state := enrollmentState90(t, f)
	_, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, enrollmentInput90(state, true)))
	if e != nil {
		t.Fatal("explicit owned recovery enrollment", e)
	}
}

func TestPasswordRecovery90ConsentEpochAndAfterProviderPostgres(t *testing.T) {
	t.Run("notification verification is not enrollment", func(t *testing.T) {
		f := newNotificationFixture(t)
		f.verifyAndEnable(t)
		recoveryRequest90(t, f, "alice@example.test", uuid.NewString())
		var n int
		if e := f.db.QueryRow(`SELECT count(*) FROM golf_email_challenges WHERE purpose='password_recovery'`).Scan(&n); e != nil || n != 0 {
			t.Fatal("notification consent became password recovery", e, n)
		}
	})
	t.Run("reenrollment never revives old capability", func(t *testing.T) {
		f := newNotificationFixture(t)
		f.verifyAndEnable(t)
		enrollRecovery90(t, f)
		id := uuid.NewString()
		recoveryRequest90(t, f, "alice@example.test", id)
		code := deliveredRecovery90(t, f, id)
		d := f.delivery(t, id)
		for _, enabled := range []bool{false, true} {
			state := enrollmentState90(t, f)
			if _, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, enrollmentInput90(state, enabled))); e != nil {
				t.Fatal(e)
			}
		}
		if _, e := f.s.emailAuthority(t.Context(), d); e == nil {
			t.Fatal("old consent recovery delivered after reenrollment")
		}
		if _, e := f.s.CompletePasswordRecovery(t.Context(), connect.NewRequest(&golfv1.CompletePasswordRecoveryRequest{RecoveryCode: code, NewPassword: localTestPassword})); e == nil {
			t.Fatal("old code revived after reenrollment")
		}
	})
	t.Run("delivery rereads consent after native wait", func(t *testing.T) {
		f := newNotificationFixture(t)
		f.verifyAndEnable(t)
		enrollRecovery90(t, f)
		id := uuid.NewString()
		recoveryRequest90(t, f, "alice@example.test", id)
		d := f.delivery(t, id)
		base := f.s.client.Transport
		if base == nil {
			base = http.DefaultTransport
		}
		var changed atomic.Bool
		f.s.client.Transport = forge086Transport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Path == "/api/v1/user" && changed.CompareAndSwap(false, true) {
				state := enrollmentState90(t, f)
				if _, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, enrollmentInput90(state, false))); e != nil {
					t.Error("owned consent revocation", e)
				}
			}
			return base.RoundTrip(r)
		})
		if _, e := f.s.emailAuthority(t.Context(), d); e == nil {
			t.Fatal("revoked recovery sent after blocked native read")
		}
		if !changed.Load() {
			t.Fatal("native wait boundary not reached")
		}
	})
}
