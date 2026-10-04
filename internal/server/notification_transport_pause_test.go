package server

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func TestNotificationPauseExactBinding(t *testing.T) {
	valid := &golfv1.DeactivateEmailTransportRequest{Id: uuid.NewString(), Version: "1", ExpectedActivationGeneration: "9007199254740993"}
	if version, generation, err := emailPauseBinding(valid); err != nil || version != 1 || generation != 9007199254740993 {
		t.Fatal("exact binding was not preserved")
	}
	for _, change := range []func(*golfv1.DeactivateEmailTransportRequest){
		func(m *golfv1.DeactivateEmailTransportRequest) { m.Id = "private-sentinel" },
		func(m *golfv1.DeactivateEmailTransportRequest) { m.Version = "0" },
		func(m *golfv1.DeactivateEmailTransportRequest) { m.Version = "01" },
		func(m *golfv1.DeactivateEmailTransportRequest) { m.ExpectedActivationGeneration = "0" },
		func(m *golfv1.DeactivateEmailTransportRequest) { m.ExpectedActivationGeneration = "-1" },
		func(m *golfv1.DeactivateEmailTransportRequest) {
			m.ExpectedActivationGeneration = "9223372036854775807"
		},
	} {
		m := &golfv1.DeactivateEmailTransportRequest{Id: valid.Id, Version: valid.Version, ExpectedActivationGeneration: valid.ExpectedActivationGeneration}
		change(m)
		_, _, err := emailPauseBinding(m)
		if err == nil || strings.Contains(err.Error(), "private-sentinel") {
			t.Fatal("malformed pause was admitted or echoed")
		}
		s := new(Server)
		if _, err = s.DeactivateEmailTransport(context.Background(), connect.NewRequest(m)); err == nil {
			t.Fatal("malformed request reached authentication/database")
		}
	}
}
func pauseEmail(t *testing.T, f *notificationFixture, generation string) *golfv1.DeactivateEmailTransportResponse {
	t.Helper()
	r, err := f.s.DeactivateEmailTransport(f.ctx, webhookRequest(f.webhookFixture, &golfv1.DeactivateEmailTransportRequest{Id: f.transport.Id, Version: f.transport.Version, ExpectedActivationGeneration: generation, CurrentPassword: localTestPassword}))
	if err != nil {
		t.Fatal("pause", err)
	}
	if r.Msg.Transport == nil || r.Msg.Transport.Id != f.transport.Id || r.Msg.Transport.Version != f.transport.Version || r.Msg.Transport.Active {
		t.Fatal("pause receipt not exact")
	}
	return r.Msg
}
func TestNotificationPauseCancelsQueueRestartAndNeverReplaysPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	f.subscribe(t)
	f.event(t, "source")
	retry := f.claim(t)
	f.s.attemptEmail(t.Context(), retry, smtpNetworkFixture(t, &smtpFixture{rcpt: "451 4.3.0 retry"}, true), nil)
	if f.delivery(t, retry.ID).State != "retrying" {
		t.Fatal("retry fixture did not reach maintained consumer")
	}
	f.event(t, "pulls")
	var queued string
	if err := f.db.QueryRow(`SELECT id::text FROM golf_email_deliveries WHERE state='queued'`).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	r := pauseEmail(t, f, "1")
	if r.ActivationGeneration != "2" {
		t.Fatal("generation did not advance")
	}
	if _, err := f.s.claimEmail(t.Context()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("paused old queue was claimed", err)
	}
	for _, id := range []string{retry.ID, queued} {
		if f.delivery(t, id).State != "cancelled" {
			t.Fatal("old queue not cancelled")
		}
	}
	// Same stale binding cannot pause a new generation or create another event.
	_, err := f.s.DeactivateEmailTransport(f.ctx, webhookRequest(f.webhookFixture, &golfv1.DeactivateEmailTransportRequest{Id: f.transport.Id, Version: "1", ExpectedActivationGeneration: "1", CurrentPassword: localTestPassword}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale pause accepted", err)
	}
	var count int
	if err = f.db.QueryRow(`SELECT count(*) FROM golf_email_events WHERE action='transport_deactivated'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("pause audit duplicated", err)
	}
	restarted, err := New(f.s.config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	f.s = restarted
	observed, err := f.s.ListEmailTransports(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ListEmailTransportsRequest{}))
	if err != nil || observed.Msg.ActivationGeneration != "2" || observed.Msg.Observation == nil || observed.Msg.Observation.Configured {
		t.Fatal("pause was not retained after restart", err)
	}
	active, err := f.s.ActivateEmailTransport(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ActivateEmailTransportRequest{Id: f.transport.Id, Version: "1", ExpectedActivationGeneration: "2", CurrentPassword: localTestPassword}))
	if err != nil || active.Msg.ActivationGeneration != "3" {
		t.Fatal("explicit activation failed", err)
	}
	if _, err = f.s.claimEmail(t.Context()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("reactivation replayed old work", err)
	}
	f.event(t, "source")
	fresh := f.claim(t)
	if fresh.ID == retry.ID || fresh.ID == queued || fresh.ActivationGeneration != 3 {
		t.Fatal("fresh event adopted old work")
	}
	f.s.attemptEmail(t.Context(), fresh, smtpNetworkFixture(t, &smtpFixture{}, true), nil)
	if f.delivery(t, fresh.ID).State != "accepted" {
		t.Fatal("future event not consumed after explicit activation")
	}
}
func TestNotificationPauseBeforeDATAAndAcceptedHistoryPostgres(t *testing.T) {
	f := newNotificationFixture(t)
	sub := f.subscribe(t)
	f.event(t, "source")
	accepted := f.claim(t)
	f.s.attemptEmail(t.Context(), accepted, smtpNetworkFixture(t, &smtpFixture{}, true), nil)
	original := f.delivery(t, accepted.ID)
	if original.State != "accepted" || original.SMTPStatus != 250 {
		t.Fatal("accepted fixture")
	}
	f.event(t, "pulls")
	inFlight := f.claim(t)
	pauseErrors := make(chan error, 1)
	smtp := &smtpFixture{onRCPT: func() {
		_, err := f.s.DeactivateEmailTransport(f.ctx, webhookRequest(f.webhookFixture, &golfv1.DeactivateEmailTransportRequest{Id: f.transport.Id, Version: "1", ExpectedActivationGeneration: "1", CurrentPassword: localTestPassword}))
		pauseErrors <- err
	}}
	f.s.attemptEmail(t.Context(), inFlight, smtpNetworkFixture(t, smtp, true), nil)
	var pauseErr error
	select {
	case pauseErr = <-pauseErrors:
	default:
		t.Fatal("SMTP recipient boundary was never reached")
	}
	if pauseErr != nil || f.delivery(t, inFlight.ID).State != "cancelled" {
		t.Fatal("pre-DATA pause did not fence send", pauseErr)
	}
	smtp.mu.Lock()
	body := smtp.body
	commands := append([]string(nil), smtp.commands...)
	smtp.mu.Unlock()
	if body != "" || strings.Contains(strings.Join(commands, ","), "DATA") {
		t.Fatal("private bytes sent after pause")
	}
	retained := f.delivery(t, accepted.ID)
	if retained.State != original.State || retained.SMTPStatus != original.SMTPStatus || retained.ContentID != original.ContentID || retained.Attempts != original.Attempts {
		t.Fatal("accepted history was rewritten")
	}
	// Preserve the existing conservative live-cancellation consent boundary.
	var enabled bool
	if err := f.db.QueryRow(`SELECT enabled FROM golf_email_subscriptions WHERE id=$1`, sub.Id).Scan(&enabled); err != nil || enabled {
		t.Fatal("claimed authority-loss subscription must require explicit renewal", err)
	}
}
func TestNotificationPauseAuthorityAndCASPostgres(t *testing.T) {
	for _, mode := range []string{"password", "admin", "logout", "id", "version", "generation"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotificationFixture(t)
			m := &golfv1.DeactivateEmailTransportRequest{Id: f.transport.Id, Version: "1", ExpectedActivationGeneration: "1", CurrentPassword: localTestPassword}
			switch mode {
			case "password":
				m.CurrentPassword = "incorrect-owned-password"
			case "admin":
				if _, err := f.db.Exec(`UPDATE golf_local_accounts SET is_instance_admin=false WHERE id=$1`, f.localID); err != nil {
					t.Fatal(err)
				}
			case "logout":
				if _, err := f.s.Logout(f.ctx, webhookRequest(f.webhookFixture, &golfv1.LogoutRequest{})); err != nil {
					t.Fatal(err)
				}
			case "id":
				m.Id = uuid.NewString()
			case "version":
				m.Version = "2"
			case "generation":
				m.ExpectedActivationGeneration = "2"
			}
			if _, err := f.s.DeactivateEmailTransport(f.ctx, webhookRequest(f.webhookFixture, m)); err == nil {
				t.Fatal("refused control succeeded")
			}
			var configured bool
			var generation, count int
			if err := f.db.QueryRow(`SELECT transport_id IS NOT NULL,generation FROM golf_email_configuration WHERE singleton`).Scan(&configured, &generation); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow(`SELECT count(*) FROM golf_email_events WHERE action='transport_deactivated'`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if !configured || generation != 1 || count != 0 {
				t.Fatal("refusal changed configuration/history")
			}
		})
	}
}
