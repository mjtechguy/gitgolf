package server

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func TestPasswordRecoveryEnrollment90OwnLocalBoundaryPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	f.verifyAndEnable(t)
	state := enrollmentState90(t, f)
	input := enrollmentInput90(state, true)
	for _, mutate := range []func(*golfv1.SaveOwnPasswordRecoveryEnrollmentRequest){
		func(m *golfv1.SaveOwnPasswordRecoveryEnrollmentRequest) { m.LocalAccountId = "999" },
		func(m *golfv1.SaveOwnPasswordRecoveryEnrollmentRequest) { m.NativeUserId = "43" },
		func(m *golfv1.SaveOwnPasswordRecoveryEnrollmentRequest) { m.ExpectedCredentialVersion = "999" },
		func(m *golfv1.SaveOwnPasswordRecoveryEnrollmentRequest) { m.ExpectedContactVersion = "999" },
	} {
		wrong := proto.Clone(input).(*golfv1.SaveOwnPasswordRecoveryEnrollmentRequest)
		mutate(wrong)
		if _, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, wrong)); e == nil {
			t.Fatal("foreign or stale enrollment accepted")
		}
	}
	native := context.WithValue(f.ctx, sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "owned-webhook-native-token"})
	if _, e := f.s.GetOwnPasswordRecoveryEnrollment(native, webhookRequest(f.webhookFixture, &golfv1.GetOwnPasswordRecoveryEnrollmentRequest{})); e == nil {
		t.Fatal("provider credential accessed local recovery consent")
	}
	if _, e := f.s.SaveOwnPasswordRecoveryEnrollment(native, webhookRequest(f.webhookFixture, input)); e == nil {
		t.Fatal("provider credential changed local recovery consent")
	}
	var count int
	if e := f.db.QueryRow(`SELECT count(*) FROM golf_password_recovery_enrollments`).Scan(&count); e != nil || count != 0 {
		t.Fatal("refused enrollment created authority", e, count)
	}
}

func enrollmentState90(t *testing.T, f *notificationFixture) *golfv1.PasswordRecoveryEnrollment {
	t.Helper()
	r, e := f.s.GetOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, &golfv1.GetOwnPasswordRecoveryEnrollmentRequest{}))
	if e != nil {
		t.Fatal("own recovery enrollment read", e)
	}
	return r.Msg.Enrollment
}

func enrollmentInput90(state *golfv1.PasswordRecoveryEnrollment, enabled bool) *golfv1.SaveOwnPasswordRecoveryEnrollmentRequest {
	return &golfv1.SaveOwnPasswordRecoveryEnrollmentRequest{LocalAccountId: state.LocalAccountId, NativeUserId: state.NativeUserId, ExpectedCredentialVersion: state.CredentialVersion, ExpectedContactVersion: state.ContactVersion, ExpectedVersion: state.Version, Enabled: enabled, PasswordConfirmation: localTestPassword}
}

func TestPasswordRecoveryEnrollment90ConsentCASAndRevocationPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	initial := enrollmentState90(t, f)
	if initial.Enabled || initial.EmailVerified || initial.Version != "0" {
		t.Fatal("unverified account was enrolled", initial)
	}
	if _, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, enrollmentInput90(initial, true))); e == nil {
		t.Fatal("unverified mailbox enabled recovery")
	}
	f.verifyAndEnable(t)
	verified := enrollmentState90(t, f)
	if verified.Enabled || verified.Version != "0" || !verified.EmailVerified {
		t.Fatal("notification consent became recovery consent", verified)
	}
	input := enrollmentInput90(verified, true)
	wrong := proto.Clone(input).(*golfv1.SaveOwnPasswordRecoveryEnrollmentRequest)
	wrong.PasswordConfirmation = "wrong long confirmation password"
	if _, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, wrong)); e == nil {
		t.Fatal("wrong current password enabled recovery")
	}
	saved, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, input))
	if e != nil || !saved.Msg.Enrollment.Enabled || saved.Msg.Enrollment.Version != "1" {
		t.Fatal("explicit current consent not saved", e)
	}
	if _, e = f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, input)); e == nil {
		t.Fatal("stale consent replay accepted")
	}
	email := f.state(t)
	if _, e = f.s.SaveOwnEmailPreference(f.ctx, webhookRequest(f.webhookFixture, &golfv1.SaveOwnEmailPreferenceRequest{ExpectedContactVersion: email.ContactVersion, ExpectedPreferenceVersion: email.PreferenceVersion, Enabled: false})); e != nil {
		t.Fatal(e)
	}
	if !enrollmentState90(t, f).Enabled {
		t.Fatal("notification opt-out erased separate recovery consent")
	}
	var eventCount int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_password_recovery_enrollment_events`).Scan(&eventCount); e != nil || eventCount != 1 {
		t.Fatal("failed/replayed enrollment wrote history", e, eventCount)
	}
	if _, e = f.db.Exec(`UPDATE golf_password_recovery_enrollment_events SET enabled=false`); e == nil {
		t.Fatal("enrollment audit was mutable")
	}
	if _, e = f.db.Exec(`UPDATE golf_email_contacts SET version=version+1,verified_at=NULL WHERE user_id=$1`, verified.UserId); e != nil {
		t.Fatal(e)
	}
	stale := enrollmentState90(t, f)
	if stale.Enabled || stale.EnrollmentCurrent || stale.Version != "1" {
		t.Fatal("mailbox rebinding retained recovery authority", stale)
	}
	off, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, enrollmentInput90(stale, false)))
	if e != nil || off.Msg.Enrollment.Enabled || off.Msg.Enrollment.Version != "2" {
		t.Fatal("unverified stale consent could not be revoked", e)
	}
	var oldBinding int64
	if e = f.db.QueryRow(`SELECT contact_version FROM golf_password_recovery_enrollment_events WHERE version=1`).Scan(&oldBinding); e != nil || strconv.FormatInt(oldBinding, 10) != verified.ContactVersion {
		t.Fatal("revocation rewrote prior consent", e)
	}
}

func TestPasswordRecoveryEnrollment90CurrentMFARequiredPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	f.verifyAndEnable(t)
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
	login, e := f.s.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil || login.MFAChallenge == "" {
		t.Fatal("current MFA login unavailable", e)
	}
	r := connect.NewRequest(&golfv1.CompletePasswordMFARequest{Code: factor.Msg.RecoveryCodes[0]})
	r.Header().Set("Cookie", f.s.mfaCookie(login.MFAChallenge, login.Expires, 300).String())
	completed, e := f.s.CompletePasswordMFA(t.Context(), r)
	if e != nil {
		t.Fatal("current MFA session", e)
	}
	for _, cookie := range (&http.Response{Header: completed.Header()}).Cookies() {
		if cookie.Name == f.s.sessionCookie("", time.Time{}, 0).Name {
			f.cookie = cookie.String()
		}
	}
	state := enrollmentState90(t, f)
	input := enrollmentInput90(state, true)
	if !state.MfaEnabled {
		t.Fatal("current factor omitted")
	}
	if _, e = f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, input)); e == nil {
		t.Fatal("enrollment bypassed active MFA")
	}
	input.MfaCode = factor.Msg.RecoveryCodes[1]
	saved, e := f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, input))
	if e != nil || !saved.Msg.Enrollment.Enabled {
		t.Fatal("confirmed enrollment failed", e)
	}
	off := enrollmentInput90(saved.Msg.Enrollment, false)
	off.MfaCode = input.MfaCode
	if _, e = f.s.SaveOwnPasswordRecoveryEnrollment(f.ctx, webhookRequest(f.webhookFixture, off)); e == nil {
		t.Fatal("used factor recovery code accepted")
	}
	var consumed int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_mfa_recovery_codes WHERE account_id=$1 AND used_at IS NOT NULL`, state.LocalAccountId).Scan(&consumed); e != nil || consumed != 2 {
		t.Fatal("current factor not consumed exactly", e, consumed)
	}
}
