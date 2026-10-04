package server

import (
	"context"
	"errors"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEmailConfigurationStatusValidation(t *testing.T) {
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	active := now.Add(-time.Second)
	completed := now.Add(-time.Millisecond)
	base := emailConfigurationStatus{ObservedAt: now, Configured: true, TransportID: uuid.NewString(), TransportVersion: 1, ActivationGeneration: 2, ConnectedWorkers: 1, RecentlyActiveWorkers: 1, LastWorkerActivity: &active, LatestDelivery: &emailDeliveryEvidence{CreatedAt: active, CompletedAt: &completed, State: "accepted", Attempts: 1, SMTPStatus: 250, RelayAccepted: true}}
	if e := validateEmailConfigurationStatus(base); e != nil {
		t.Fatal(e)
	}
	cases := []struct {
		name   string
		change func(*emailConfigurationStatus)
	}{
		{"configuration not health", func(s *emailConfigurationStatus) {
			s.ConnectedWorkers = 0
			s.RecentlyActiveWorkers = 0
			s.LastWorkerActivity = nil
		}},
		{"stale ownership", func(s *emailConfigurationStatus) {
			old := now.Add(-time.Minute)
			s.LastWorkerActivity = &old
			s.RecentlyActiveWorkers = 0
		}},
		{"unconfigured", func(s *emailConfigurationStatus) {
			s.Configured = false
			s.TransportID = ""
			s.TransportVersion = 0
			s.LatestDelivery = nil
		}},
		{"no current generation evidence", func(s *emailConfigurationStatus) { s.LatestDelivery = nil }},
		{"queued not accepted", func(s *emailConfigurationStatus) {
			s.LatestDelivery = &emailDeliveryEvidence{CreatedAt: active, State: "queued"}
		}},
		{"unknown ack not success", func(s *emailConfigurationStatus) {
			s.LatestDelivery = &emailDeliveryEvidence{CreatedAt: active, State: "retrying", Attempts: 1, PossibleDuplicate: true}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := base
			c.change(&s)
			if e := validateEmailConfigurationStatus(s); e != nil {
				t.Fatal(e)
			}
		})
	}
	bad := []struct {
		name   string
		change func(*emailConfigurationStatus)
	}{
		{"missing clock", func(s *emailConfigurationStatus) { s.ObservedAt = time.Time{} }},
		{"invalid configuration", func(s *emailConfigurationStatus) { s.TransportID = "not-a-uuid" }},
		{"unconfigured evidence", func(s *emailConfigurationStatus) { s.Configured = false; s.TransportID = ""; s.TransportVersion = 0 }},
		{"excess slots", func(s *emailConfigurationStatus) { s.ConnectedWorkers = 3 }},
		{"recent exceeds connected", func(s *emailConfigurationStatus) { s.RecentlyActiveWorkers = 2 }},
		{"future activity", func(s *emailConfigurationStatus) { future := now.Add(time.Second); s.LastWorkerActivity = &future }},
		{"stale reported live", func(s *emailConfigurationStatus) { old := now.Add(-time.Minute); s.LastWorkerActivity = &old }},
		{"unobserved worker time", func(s *emailConfigurationStatus) { s.LastWorkerActivity = nil }},
		{"future delivery", func(s *emailConfigurationStatus) {
			d := *s.LatestDelivery
			d.CreatedAt = now.Add(time.Second)
			s.LatestDelivery = &d
		}},
		{"accepted without250", func(s *emailConfigurationStatus) {
			d := *s.LatestDelivery
			d.SMTPStatus = 451
			d.RelayAccepted = false
			s.LatestDelivery = &d
		}},
		{"accepted without completion", func(s *emailConfigurationStatus) { d := *s.LatestDelivery; d.CompletedAt = nil; s.LatestDelivery = &d }},
		{"accepted without attempt", func(s *emailConfigurationStatus) { d := *s.LatestDelivery; d.Attempts = 0; s.LatestDelivery = &d }},
		{"unknown state", func(s *emailConfigurationStatus) {
			d := *s.LatestDelivery
			d.State = "delivered_to_inbox"
			s.LatestDelivery = &d
		}},
	}
	for _, c := range bad {
		t.Run(c.name, func(t *testing.T) {
			s := base
			c.change(&s)
			if validateEmailConfigurationStatus(s) == nil {
				t.Fatal("Malformed observation accepted")
			}
		})
	}
}

func TestEmailConfigurationStatusMissingDatabase(t *testing.T) {
	_, e := (&Server{}).readEmailConfigurationStatus(context.Background())
	if !errors.Is(e, errStorageUnavailable) {
		t.Fatal(e)
	}
}

func TestEmailConfigurationStatusDatabase(t *testing.T) {
	f := newNotificationFixture(t)
	read := func() emailConfigurationStatus {
		t.Helper()
		s, e := f.s.readEmailConfigurationStatus(t.Context())
		if e != nil {
			t.Fatal(e)
		}
		return s
	}
	s := read()
	if !s.Configured || s.TransportID != f.transport.Id || s.TransportVersion != 1 || s.ActivationGeneration != 1 || s.ConnectedWorkers != 0 || s.LatestDelivery != nil {
		t.Fatal("Saved configuration fabricated worker or delivery", s)
	}
	owner, e := f.db.Conn(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	defer owner.Close()
	slot := int64(74191526730404300)
	if _, e = owner.ExecContext(t.Context(), `SELECT pg_advisory_lock_shared($1)`, slot); e != nil {
		t.Fatal(e)
	}
	if read().ConnectedWorkers != 0 {
		t.Fatal("Shared observer lock counted as delivery worker")
	}
	if _, e = owner.ExecContext(t.Context(), `SELECT pg_advisory_unlock_shared($1),pg_advisory_lock($2)`, slot, slot+99); e != nil {
		t.Fatal(e)
	}
	if read().ConnectedWorkers != 0 {
		t.Fatal("Unrelated advisory lock counted as worker")
	}
	if _, e = owner.ExecContext(t.Context(), `SELECT pg_advisory_lock($1)`, slot); e != nil {
		t.Fatal(e)
	}
	s = read()
	if s.ConnectedWorkers != 1 || s.RecentlyActiveWorkers != 1 || s.LastWorkerActivity == nil || s.LatestDelivery != nil {
		t.Fatal("Actual owned active connection missing", s)
	}
	f.verification(t)
	d := f.claim(t)
	if _, e = f.db.Exec(`UPDATE golf_email_deliveries SET state='accepted',smtp_status=250,completed_at=clock_timestamp() WHERE id=$1`, d.ID); e != nil {
		t.Fatal(e)
	}
	s = read()
	if s.LatestDelivery == nil || !s.LatestDelivery.RelayAccepted || s.LatestDelivery.Attempts != 1 || s.LatestDelivery.SMTPStatus != 250 {
		t.Fatal("Actual metadata acceptance missing", s)
	}
	if _, e = f.s.ActivateEmailTransport(f.ctx, webhookRequest(f.webhookFixture, &golfv1.ActivateEmailTransportRequest{Id: f.transport.Id, Version: "1", ExpectedActivationGeneration: "1", CurrentPassword: localTestPassword})); e != nil {
		t.Fatal(e)
	}
	s = read()
	if s.ActivationGeneration != 2 || s.LatestDelivery != nil {
		t.Fatal("Earlier activation acceptance shown as current", s)
	}
	f.verification(t)
	s = read()
	if s.LatestDelivery == nil || s.LatestDelivery.State != "queued" || s.LatestDelivery.RelayAccepted {
		t.Fatal("Queued current-generation mail shown accepted", s)
	}
	if _, e = owner.ExecContext(t.Context(), `SELECT pg_advisory_unlock_all()`); e != nil {
		t.Fatal(e)
	}
	s = read()
	if s.ConnectedWorkers != 0 || s.RecentlyActiveWorkers != 0 || s.LastWorkerActivity != nil {
		t.Fatal("Released worker ownership still active", s)
	}
	cancelled, stop := context.WithCancel(t.Context())
	stop()
	if _, e = f.s.readEmailConfigurationStatus(cancelled); !errors.Is(e, errStorageUnavailable) {
		t.Fatal("Cancelled read returned payload", e)
	}
}
