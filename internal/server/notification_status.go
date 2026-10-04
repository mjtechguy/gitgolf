package server

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

// emailConfigurationStatus is instance metadata, not delivery authority. Callers
// must use the managed-session/current instance-admin before/after read guard.
// Dedicated worker advisory locks are already held by RunEmailWorker; connection
// activity proves neither that a queue poll succeeded nor that SMTP is reachable.
type emailConfigurationStatus struct {
	ObservedAt                              time.Time
	Configured                              bool
	TransportID                             string
	TransportVersion, ActivationGeneration  int64
	ConnectedWorkers, RecentlyActiveWorkers int
	LastWorkerActivity                      *time.Time
	LatestDelivery                          *emailDeliveryEvidence
}

type emailDeliveryEvidence struct {
	CreatedAt         time.Time
	CompletedAt       *time.Time
	State             string
	Attempts          int
	SMTPStatus        int
	RelayAccepted     bool
	PossibleDuplicate bool
}

// Recent activity uses the database clock and exceeds the bounded 15s SMTP
// attempt. It is connection activity, not a new worker heartbeat protocol.
const emailWorkerActivityWindow = 30 * time.Second

const emailConfigurationStatusSQL = `WITH observed AS (SELECT clock_timestamp() AS at), workers AS (
 SELECT count(*) AS connected,count(*) FILTER (WHERE a.state IN ('active','idle') AND a.state_change>o.at-interval '30 seconds' AND a.state_change<=o.at) AS recent,max(a.state_change) AS last_activity
 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid CROSS JOIN observed o
 WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND a.datname=current_database() AND a.usename=current_user
 AND ((l.classid::bigint<<32)|l.objid::bigint) IN (74191526730404300,74191526730404301)
)
 SELECT o.at,c.transport_id::text,c.transport_version,c.generation,w.connected,w.recent,w.last_activity,
 d.created_at,d.completed_at,d.state,d.attempts,d.smtp_status,d.possible_duplicate
 FROM golf_email_configuration c CROSS JOIN observed o CROSS JOIN workers w
 LEFT JOIN LATERAL (SELECT created_at,completed_at,state,attempts,smtp_status,possible_duplicate FROM golf_email_deliveries
 WHERE transport_id=c.transport_id AND transport_version=c.transport_version AND activation_generation=c.generation
 ORDER BY created_at DESC,id DESC LIMIT 1) d ON true WHERE c.singleton`

func (s *Server) readEmailConfigurationStatus(ctx context.Context) (emailConfigurationStatus, error) {
	ctx, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	var result emailConfigurationStatus
	if s.db == nil {
		return result, errStorageUnavailable
	}
	var id, state sql.NullString
	var version, attempts, status sql.NullInt64
	var worker, created, completed sql.NullTime
	var duplicate sql.NullBool
	err := s.db.QueryRowContext(ctx, emailConfigurationStatusSQL).Scan(&result.ObservedAt, &id, &version, &result.ActivationGeneration, &result.ConnectedWorkers, &result.RecentlyActiveWorkers, &worker, &created, &completed, &state, &attempts, &status, &duplicate)
	if err != nil {
		return emailConfigurationStatus{}, errStorageUnavailable
	}
	result.Configured = id.Valid
	if id.Valid {
		result.TransportID = id.String
		result.TransportVersion = version.Int64
	}
	if worker.Valid {
		result.LastWorkerActivity = &worker.Time
	}
	if created.Valid {
		if !state.Valid || !attempts.Valid || !status.Valid || !duplicate.Valid {
			return emailConfigurationStatus{}, errStorageUnavailable
		}
		result.LatestDelivery = &emailDeliveryEvidence{CreatedAt: created.Time, State: state.String, Attempts: int(attempts.Int64), SMTPStatus: int(status.Int64), PossibleDuplicate: duplicate.Bool}
		if completed.Valid {
			result.LatestDelivery.CompletedAt = &completed.Time
		}
		result.LatestDelivery.RelayAccepted = state.String == "accepted" && status.Int64 == 250
	} else if completed.Valid || state.Valid || attempts.Valid || status.Valid || duplicate.Valid {
		return emailConfigurationStatus{}, errStorageUnavailable
	}
	if !version.Valid && id.Valid || version.Valid && !id.Valid || validateEmailConfigurationStatus(result) != nil {
		return emailConfigurationStatus{}, errStorageUnavailable
	}
	return result, nil
}

func validateEmailConfigurationStatus(s emailConfigurationStatus) error {
	bad := errors.New("Invalid notification configuration observation")
	if s.ObservedAt.IsZero() || s.ActivationGeneration < 0 || s.ConnectedWorkers < 0 || s.ConnectedWorkers > 2 || s.RecentlyActiveWorkers < 0 || s.RecentlyActiveWorkers > s.ConnectedWorkers {
		return bad
	}
	if s.Configured {
		if _, e := uuid.Parse(s.TransportID); e != nil || s.TransportVersion <= 0 || s.ActivationGeneration <= 0 {
			return bad
		}
	} else if s.TransportID != "" || s.TransportVersion != 0 || s.LatestDelivery != nil {
		return bad
	}
	if s.LastWorkerActivity != nil {
		if s.LastWorkerActivity.IsZero() || s.LastWorkerActivity.After(s.ObservedAt) || s.ConnectedWorkers == 0 {
			return bad
		}
	} else if s.ConnectedWorkers != 0 {
		return bad
	}
	if s.RecentlyActiveWorkers > 0 && (s.LastWorkerActivity == nil || !s.LastWorkerActivity.After(s.ObservedAt.Add(-emailWorkerActivityWindow))) {
		return bad
	}
	if d := s.LatestDelivery; d != nil {
		if d.CreatedAt.IsZero() || d.CreatedAt.After(s.ObservedAt) || d.Attempts < 0 || d.Attempts > 6 || d.SMTPStatus < 0 || d.SMTPStatus > 599 {
			return bad
		}
		terminal := false
		switch d.State {
		case "queued", "sending", "retrying":
		case "accepted", "failed", "cancelled", "suppressed":
			terminal = true
		default:
			return bad
		}
		if terminal != (d.CompletedAt != nil) || d.CompletedAt != nil && (d.CompletedAt.Before(d.CreatedAt) || d.CompletedAt.After(s.ObservedAt)) {
			return bad
		}
		if d.RelayAccepted != (d.State == "accepted" && d.SMTPStatus == 250) || d.State == "accepted" && (d.Attempts == 0 || !d.RelayAccepted) {
			return bad
		}
	}
	return nil
}
