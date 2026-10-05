package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// Only the isolated Golf policy state is seeded here. Native permission and
// credentials remain unchanged; application-policy mutation is separately tested
// through the supported administrator RPC lifecycle and race checks.
func seedGolfSuspension(t *testing.T, s *Server) {
	t.Helper()
	_, e := s.db.Exec(`INSERT INTO golf_user_access(user_id,version,suspended,reason) SELECT id,1,true,'Owned background suspension fixture' FROM golf_users WHERE forge_url=$1 AND forge_user_id=42`, s.config.GiteaURL)
	if e != nil {
		t.Fatal(e)
	}
}
func suspendAfterNativeRead(t *testing.T, s *Server, pathSuffix string) {
	t.Helper()
	original := s.client.Transport
	if original == nil {
		original = http.DefaultTransport
	}
	var once sync.Once
	s.client.Transport = creationRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, e := original.RoundTrip(r)
		if e == nil && strings.HasSuffix(r.URL.Path, pathSuffix) {
			once.Do(func() { seedGolfSuspension(t, s) })
		}
		return response, e
	})
}
func TestGolfUserAccessWebhookBackgroundPostgres(t *testing.T) {
	for _, mode := range []string{"early", "late_native"} {
		t.Run(mode, func(t *testing.T) {
			f := newWebhookFixture(t)
			sub := f.save(t, uuid.NewString(), "0", true)
			f.queue(t, sub, uuid.NewString())
			d := f.claim(t)
			if _, e := f.s.webhookAuthority(t.Context(), d.SubscriptionID, d.SubscriptionVersion, d.Epoch); e != nil {
				t.Fatal("baseline native authority", e)
			}
			reads := f.permissionReads.Load()
			if mode == "early" {
				seedGolfSuspension(t, f.s)
				if e := f.s.webhookDeliveryLive(t.Context(), d); !errors.Is(e, errWebhookRevoked) {
					t.Fatal("live webhook ignored suspension", e)
				}
			} else {
				suspendAfterNativeRead(t, f.s, "/permission")
			}
			token, e := f.s.webhookAuthority(t.Context(), d.SubscriptionID, d.SubscriptionVersion, d.Epoch)
			if !errors.Is(e, errWebhookRevoked) || token.Token != "" {
				t.Fatal("background authority escaped Golf suspension", e)
			}
			if mode == "early" && f.permissionReads.Load() != reads {
				t.Fatal("early suspension reached native permission API")
			}
			f.s.attemptWebhook(t.Context(), d)
			if f.received.Load() != 0 || f.delivery(t, d.ID.String()).State != "cancelled" {
				t.Fatal("suspended sponsor emitted webhook")
			}
			var enabled bool
			if e := f.db.QueryRow(`SELECT enabled FROM golf_webhook_subscriptions WHERE id=$1`, sub.Id).Scan(&enabled); e != nil || enabled {
				t.Fatal("revoked background subscription not paused", e)
			}
		})
	}
}
func TestGolfUserAccessEmailBackgroundPostgres(t *testing.T) {
	for _, mode := range []string{"early", "late_native"} {
		t.Run(mode, func(t *testing.T) {
			f := newNotificationFixture(t)
			f.verification(t)
			d := f.claim(t)
			if _, e := f.s.emailAuthority(t.Context(), d); e != nil {
				t.Fatal("baseline email authority", e)
			}
			if mode == "early" {
				seedGolfSuspension(t, f.s)
				if e := f.s.emailDeliveryLive(t.Context(), d); !errors.Is(e, errEmailRevoked) {
					t.Fatal("live email ignored suspension", e)
				}
			} else {
				suspendAfterNativeRead(t, f.s, "/api/v1/user")
			}
			if _, e := f.s.emailAuthority(t.Context(), d); !errors.Is(e, errEmailRevoked) {
				t.Fatal("background email authority escaped suspension", e)
			}
			smtp := &smtpFixture{}
			network := smtpNetworkFixture(t, smtp, true)
			f.s.attemptEmail(context.Background(), d, network, nil)
			smtp.mu.Lock()
			body := smtp.body
			smtp.mu.Unlock()
			if body != "" || f.delivery(t, d.ID).State != "cancelled" {
				t.Fatal("suspended recipient emitted SMTP body")
			}
		})
	}
}
