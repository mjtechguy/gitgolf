package server

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func recoveryMFAFixture(t *testing.T) (*managementFixture, []string) {
	t.Helper()
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", false)
	_, codes := enableMFATest(t, f, "alice")
	return f, codes
}

func TestRecoveryFactorQuarantinePostgres(t *testing.T) {
	f, factor := recoveryMFAFixture(t)
	_, challenge := recoverySession(t, f, "alice", "")
	result, e := InvalidateRestoredSessions(t.Context(), f.db, strings.Repeat("d", 32))
	if e != nil || result.Quarantine.MFAAccounts != 1 || result.Quarantine.MFAChallenges != 1 || result.Quarantine.MFARecoveryCodes != 10 || result.LocalAccountsDisabledCount != 1 {
		t.Fatal("copied factor authority was not quarantined", e)
	}
	if mfaLoginRequest(f.s, "CompletePasswordMFA", map[string]string{"code": factor[0]}, challenge).Code != 401 {
		t.Fatal("restored recovery challenge/code was usable")
	}
	var enabled, disabled bool
	var version int64
	if e = f.db.QueryRow(`SELECT m.enabled,m.version,a.disabled_at IS NOT NULL FROM golf_local_mfa m JOIN golf_local_accounts a ON a.id=m.account_id`).Scan(&enabled, &version, &disabled); e != nil || enabled || !disabled || version != 3 {
		t.Fatal("restore did not require deliberate account and factor reenrollment")
	}
	var counts RecoveryQuarantineCounts
	var raw []byte
	if e = f.db.QueryRow(`SELECT quarantine_counts FROM golf_recovery_events`).Scan(&raw); e != nil || json.Unmarshal(raw, &counts) != nil || counts != result.Quarantine {
		t.Fatal("committed recovery counts mismatch")
	}
	var action, kind, operation string
	if e = f.db.QueryRow(`SELECT action,actor_kind,operation_id FROM golf_mfa_events WHERE action='restore_reset'`).Scan(&action, &kind, &operation); e != nil || kind != "operator" || operation != result.OperationID {
		t.Fatal("factor recovery lacks exact operator audit")
	}
	again, e := InvalidateRestoredSessions(t.Context(), f.db, strings.Repeat("d", 32))
	if e != nil || again.Quarantine != (RecoveryQuarantineCounts{}) {
		t.Fatal("repeat quarantine invented reset counts")
	}
}

func TestRecoveryAuthorityRollbackPostgres(t *testing.T) {
	f, _ := recoveryMFAFixture(t)
	_, _ = recoverySession(t, f, "alice", "")
	before := recoverySnapshot(t, f.db, true)
	if _, e := f.db.Exec(`CREATE FUNCTION reject_restore_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-quarantine-error'; END $$; CREATE CONSTRAINT TRIGGER reject_restore_quarantine AFTER INSERT ON golf_recovery_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_restore_quarantine()`); e != nil {
		t.Fatal(e)
	}
	result, e := InvalidateRestoredSessions(t.Context(), f.db, strings.Repeat("e", 32))
	if e == nil || result != (RecoveryResult{}) || strings.Contains(e.Error(), "private-quarantine-error") || !reflect.DeepEqual(before, recoverySnapshot(t, f.db, true)) {
		t.Fatal("failed recovery partially revoked factor or disclosed storage error")
	}
}

func TestRecoveryAgentQuarantinePreservesOriginalJournalPostgres(t *testing.T) {
	f := newConversationFixture(t)
	f.start(t)
	f.observe(t, runner.AgentObservation{Sequence: 1, Kind: "thread_started"})
	f.observe(t, runner.AgentObservation{Sequence: 2, Kind: "turn_started", Status: "inProgress"})
	f.observe(t, runner.AgentObservation{Sequence: 3, Kind: "assistant_message", Text: "Retained original journal"})
	s := f.x.f.server
	encrypted, key, e := s.keyring.seal(infrastructureConnectionDomain, string(conversationInitial), codexBinding(f.r.ID))
	if e != nil {
		t.Fatal("fixture agent credential encryption")
	}
	if _, e = s.db.Exec(`INSERT INTO golf_codex_auth(connection_id,encrypted_credential,credential_binding,credential_key_id) VALUES($1,$2,$3,$4)`, f.r.ID, encrypted, codexBinding(f.r.ID), key); e != nil {
		t.Fatal("fixture agent credential")
	}
	queued := uuid.NewString()
	f.x.task(t, queued, 11, f.x.user, f.x.at)
	var before string
	if e := s.db.QueryRow(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]') FROM golf_agent_task_events t`).Scan(&before); e != nil {
		t.Fatal(e)
	}
	result, e := InvalidateRestoredSessions(t.Context(), s.db, strings.Repeat("f", 32))
	if e != nil || result.Quarantine.AgentTasks != 2 || result.Quarantine.AgentConnections != 1 || result.Quarantine.AgentCredentials != 1 {
		t.Fatal("restored tasks/credentials not quarantined", e)
	}
	running, e := s.taskRecord(t.Context(), f.t.ID)
	if e != nil || running.State != "lost" || running.Attempt != f.t.Attempt {
		t.Fatal("original running attempt was replayable or rewritten")
	}
	var leaseNull bool
	if e = s.db.QueryRow(`SELECT lease_expires_at IS NULL FROM golf_agent_tasks WHERE id=$1`, f.t.ID).Scan(&leaseNull); e != nil || !leaseNull {
		t.Fatal("restored running lease remained usable")
	}
	q, e := s.taskRecord(t.Context(), queued)
	if e != nil || q.State != "cancelled" {
		t.Fatal("queued task remained claimable")
	}
	var after string
	if e = s.db.QueryRow(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]') FROM golf_agent_task_events t`).Scan(&after); e != nil || before != after {
		t.Fatal("restore rewrote retained conversation")
	}
}
