package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func pushMaterializationFixture(t *testing.T) (*workflowRunFixture, workflowRunRecord, string) {
	t.Helper()
	f, run, _ := automaticRunFixture(t)
	var connection string
	if err := f.server.db.QueryRow(`SELECT connection_id::text FROM golf_repository_events WHERE id=$1`, run.RepositoryEventID.Int64).Scan(&connection); err != nil {
		t.Fatal(err)
	}
	f.server.config.PushCIEnabled = true
	f.server.repositoryEventConnections = map[string]repositoryEventConnection{connection: {ID: connection}}
	return f, run, connection
}

func pushCanonicalReceipt(t *testing.T, f *workflowRunFixture, event int64) {
	t.Helper()
	if _, err := f.server.db.Exec(`INSERT INTO golf_repository_event_payloads(connection_id,payload_sha256,event_id,push_admission_requested) SELECT connection_id,payload_sha256,id,true FROM golf_repository_events WHERE id=$1`, event); err != nil {
		t.Fatal(err)
	}
}

func pushExtraReceipt(t *testing.T, f *workflowRunFixture, run workflowRunRecord, ref, commit string, canonical, historical bool) int64 {
	t.Helper()
	sum := sha256.Sum256([]byte(uuid.NewString()))
	var id int64
	if err := f.server.db.QueryRow(`INSERT INTO golf_repository_events(connection_id,delivery_id,payload_sha256,payload_bytes,event_type,ref,before_commit_id,after_commit_id,sender_id,received_at) SELECT connection_id,$2,$3,payload_bytes,event_type,$4,before_commit_id,$5,sender_id,CASE WHEN $6 THEN (SELECT created_at-interval '1 second' FROM golf_automation_grants WHERE id=$7) ELSE clock_timestamp() END FROM golf_repository_events WHERE id=$1 RETURNING id`, run.RepositoryEventID.Int64, uuid.NewString(), hex.EncodeToString(sum[:]), ref, commit, historical, run.AutomationGrantID.String).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if canonical {
		pushCanonicalReceipt(t, f, id)
	}
	return id
}

func TestPushMaterializationSeedingPostgres(t *testing.T) {
	f, run, connection := pushMaterializationFixture(t)
	pushCanonicalReceipt(t, f, run.RepositoryEventID.Int64)
	pushExtraReceipt(t, f, run, "refs/heads/main", run.CommitID, false, false)
	disabledReceipt := pushExtraReceipt(t, f, run, "refs/heads/main", run.CommitID, false, false)
	if _, err := f.server.db.Exec(`INSERT INTO golf_repository_event_payloads(connection_id,payload_sha256,event_id) SELECT connection_id,payload_sha256,id FROM golf_repository_events WHERE id=$1`, disabledReceipt); err != nil {
		t.Fatal(err)
	}
	pushExtraReceipt(t, f, run, "refs/heads/main", run.CommitID, true, true)
	pushExtraReceipt(t, f, run, "refs/heads/other", run.CommitID, true, false)
	pushExtraReceipt(t, f, run, "refs/tags/v1", run.CommitID, true, false)
	pushExtraReceipt(t, f, run, "refs/heads/main", strings.Repeat("0", 40), true, false)
	f.server.repositoryEventConnections = nil
	if err := f.server.seedPushMaterializations(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.server.db.QueryRow(`SELECT count(*) FROM golf_push_materializations`).Scan(&count); err != nil || count != 0 {
		t.Fatal("removed connection created work", err)
	}
	f.server.repositoryEventConnections = map[string]repositoryEventConnection{connection: {ID: connection}}
	for range 2 {
		if err := f.server.seedPushMaterializations(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	var event int64
	if err := f.server.db.QueryRow(`SELECT count(*),min(event_id) FROM golf_push_materializations`).Scan(&count, &event); err != nil || count != 1 || event != run.RepositoryEventID.Int64 {
		t.Fatal("noncanonical, historical or unsupported receipt seeded", count, event, err)
	}
	m, err := f.server.claimPushMaterialization(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err = f.server.finishPushPreparation(t.Context(), m, "blocked", "push_policy_denied"); err != nil {
		t.Fatal(err)
	}
	if err = f.server.seedPushMaterializations(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.claimPushMaterialization(t.Context()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("terminal denial was replayed", err)
	}
}

func TestPushMaterializationClaimsPostgres(t *testing.T) {
	f, run, _ := pushMaterializationFixture(t)
	pushCanonicalReceipt(t, f, run.RepositoryEventID.Int64)
	for range 7 {
		pushExtraReceipt(t, f, run, "refs/heads/main", run.CommitID, true, false)
	}
	if err := f.server.seedPushMaterializations(t.Context()); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	claims := make(chan pushMaterialization, 8)
	failures := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, err := f.server.claimPushMaterialization(t.Context())
			if err != nil {
				failures <- err
				return
			}
			claims <- m
		}()
	}
	wg.Wait()
	close(claims)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	var first pushMaterialization
	for m := range claims {
		if seen[m.ID] || m.LeaseID == "" {
			t.Fatal("concurrent claim duplicated work")
		}
		seen[m.ID] = true
		first = m
	}
	if len(seen) != 8 {
		t.Fatal("missing concurrent claims")
	}
	old := first
	for attempt := 2; attempt <= 3; attempt++ {
		if _, err := f.server.db.Exec(`UPDATE golf_push_materializations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, first.ID); err != nil {
			t.Fatal(err)
		}
		m, err := f.server.claimPushMaterialization(t.Context())
		if err != nil || m.ID != first.ID || m.LeaseID == first.LeaseID {
			t.Fatal("expired preparation did not resume", err)
		}
		first = m
		if err = f.server.finishPushPreparation(t.Context(), old, "blocked", "stale_finisher"); err != nil {
			t.Fatal(err)
		}
		var state, lease string
		var attempts int
		if err = f.server.db.QueryRow(`SELECT state,lease_id::text,attempts FROM golf_push_materializations WHERE id=$1`, m.ID).Scan(&state, &lease, &attempts); err != nil || state != "preparing" || lease != m.LeaseID || attempts != attempt {
			t.Fatal("stale lease changed current preparation", err)
		}
	}
	if _, err := f.server.db.Exec(`UPDATE golf_push_materializations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.claimPushMaterialization(t.Context()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("preparation exceeded three attempts", err)
	}
	var reason string
	if err := f.server.db.QueryRow(`SELECT reason FROM golf_push_materializations WHERE id=$1 AND state='blocked' AND lease_id IS NULL`, first.ID).Scan(&reason); err != nil || reason != "preparation_attempt_limit" {
		t.Fatal("exhausted preparation not terminal", err)
	}
}

func TestPushMaterializationRecoveryPostgres(t *testing.T) {
	f, run, _ := pushMaterializationFixture(t)
	pushCanonicalReceipt(t, f, run.RepositoryEventID.Int64)
	pushExtraReceipt(t, f, run, "refs/heads/main", run.CommitID, true, false)
	if err := f.server.seedPushMaterializations(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.claimPushMaterialization(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := InvalidateRestoredSessions(t.Context(), f.server.db, strings.Repeat("a", 32)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.server.db.QueryRow(`SELECT count(*) FROM golf_push_materializations WHERE state='blocked' AND reason='recovery_quarantine' AND lease_id IS NULL AND lease_expires_at IS NULL`).Scan(&count); err != nil || count != 2 {
		t.Fatal("recovery left pending preparation executable", err)
	}
	if err := f.server.seedPushMaterializations(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.claimPushMaterialization(t.Context()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("recovery quarantine revived work", err)
	}
}

func TestPushMaterializerDisabled(t *testing.T) {
	s := &Server{}
	if err := s.materializePush(t.Context()); err != nil {
		t.Fatal(err)
	}
	s.RunPushAutomation(t.Context())
}

func TestPushMaterializationInactiveGrantPostgres(t *testing.T) {
	for _, scenario := range []string{"revoked", "expired"} {
		t.Run(scenario, func(t *testing.T) {
			f, run, _ := pushMaterializationFixture(t)
			pushCanonicalReceipt(t, f, run.RepositoryEventID.Int64)
			query := `UPDATE golf_automation_grants SET enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE id=$1`
			if scenario == "expired" {
				query = `UPDATE golf_automation_grants SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`
			}
			if _, err := f.server.db.Exec(query, run.AutomationGrantID.String); err != nil {
				t.Fatal(err)
			}
			if err := f.server.seedPushMaterializations(t.Context()); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := f.server.db.QueryRow(`SELECT count(*) FROM golf_push_materializations`).Scan(&count); err != nil || count != 0 {
				t.Fatal("inactive grant acquired work", err)
			}
		})
	}
}

func TestPushMaterializationSkipsLockedPostgres(t *testing.T) {
	f, run, _ := pushMaterializationFixture(t)
	pushCanonicalReceipt(t, f, run.RepositoryEventID.Int64)
	pushExtraReceipt(t, f, run, "refs/heads/main", run.CommitID, true, false)
	if err := f.server.seedPushMaterializations(t.Context()); err != nil {
		t.Fatal(err)
	}
	tx, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var locked string
	if err = tx.QueryRow(`SELECT id::text FROM golf_push_materializations ORDER BY created_at,id LIMIT 1 FOR UPDATE`).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	m, err := f.server.claimPushMaterialization(t.Context())
	if err != nil || m.ID == locked {
		t.Fatal("claim did not skip another coordinator's locked row", err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	m, err = f.server.claimPushMaterialization(t.Context())
	if err != nil || m.ID != locked {
		t.Fatal("released row did not remain claimable", err)
	}
}
