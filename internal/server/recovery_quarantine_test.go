package server

import (
	"crypto/sha256"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
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
	image := "sha256:" + strings.Repeat("d", 64)
	if _, e = s.db.Exec(`INSERT INTO golf_agent_controls(task_id,attempt_id,image,native_version,native_session,state,revision,screened_sequence,permission_id,tool_id,allow_once_options,resume,file_tools_qualified) VALUES($1,$2,$3,$4,'native-thread','dispatching',2,4,'original-permission','workspace-read','["allow-once"]',true,true)`, f.t.ID, f.attempt, image, runner.ManagedACPVersion); e != nil {
		t.Fatal("fixture exact preserved sandbox control", e)
	}
	request := &golfv1.SubmitAgentCommandRequest{TaskId: f.t.ID, AttemptId: f.attempt, RequestId: uuid.NewString(), Kind: "permission", PermissionId: "original-permission", OptionId: "allow-once", ExpectedTaskVersion: strconv.FormatInt(f.t.Version, 10), ExpectedRevision: "1"}
	command, e := json.Marshal(request)
	if e != nil {
		t.Fatal("fixture original command")
	}
	digest := sha256.Sum256(command)
	commandBinding := conversationBinding(f.t, s.config.GiteaURL, f.attempt, 4, command)
	commandCipher, commandKey, e := s.keyring.seal(conversationContentDomain, string(command), commandBinding)
	if e != nil {
		t.Fatal("fixture encrypted original command")
	}
	content := uuid.NewString()
	if _, e = s.db.Exec(`INSERT INTO golf_agent_conversation_contents(id,task_id,attempt_id,forge_url,repository_id,user_id,sequence,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6,4,$7,$8,$9)`, content, f.t.ID, f.attempt, s.config.GiteaURL, f.t.RepositoryID, f.t.UserID, commandCipher, commandBinding, commandKey); e != nil {
		t.Fatal("fixture retained command content", e)
	}
	if _, e = s.db.Exec(`INSERT INTO golf_agent_commands(task_id,attempt_id,request_id,kind,input_hash,content_id) VALUES($1,$2,$3,'permission',$4,$5)`, f.t.ID, f.attempt, request.RequestId, digest[:], content); e != nil {
		t.Fatal("fixture original queued command", e)
	}
	nativeInput, e := json.Marshal(runner.ACPInput{ID: "initial", Kind: "prompt", Text: "Exact original task prompt"})
	if e != nil {
		t.Fatal("fixture original native input")
	}
	nativeDigest := sha256.Sum256(nativeInput)
	if _, e = s.db.Exec(`INSERT INTO golf_agent_native_sends(task_id,attempt_id,input_id,kind,input_hash) VALUES($1,$2,'initial','prompt',$3)`, f.t.ID, f.attempt, nativeDigest[:]); e != nil {
		t.Fatal("fixture retained native-send exclusion", e)
	}
	if _, e = s.db.Exec(`INSERT INTO golf_agent_worker_presence(forge_url,worker_id,image,acp_image,acp_version,acp_file_tools) VALUES($1,'worker',$2,$2,$3,true)`, s.config.GiteaURL, image, runner.ManagedACPVersion); e != nil {
		t.Fatal("fixture copied qualified worker receipt", e)
	}
	retained := func() string {
		t.Helper()
		var original string
		if e := s.db.QueryRow(`SELECT jsonb_build_array((SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM golf_agent_conversation_contents c),(SELECT coalesce(jsonb_agg(to_jsonb(c)-'state' ORDER BY c.request_id),'[]') FROM golf_agent_commands c),(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.input_id),'[]') FROM golf_agent_native_sends n))::text`).Scan(&original); e != nil {
			t.Fatal("retained command/cipher/send snapshot", e)
		}
		return original
	}
	original := retained()
	var before string
	if e := s.db.QueryRow(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]') FROM golf_agent_task_events t`).Scan(&before); e != nil {
		t.Fatal(e)
	}
	result, e := InvalidateRestoredSessions(t.Context(), s.db, strings.Repeat("f", 32))
	if e != nil || result.Quarantine.AgentTasks != 2 || result.Quarantine.AgentConnections != 1 || result.Quarantine.AgentCredentials != 1 || result.Quarantine.AgentControls != 1 || result.Quarantine.AgentCommands != 1 || result.Quarantine.AgentWorkerReceipts != 1 {
		t.Fatal("restored tasks/credentials not quarantined", e)
	}
	var closed, claimed, receiptCleared bool
	if e = s.db.QueryRow(`SELECT state='closed' AND revision=3 AND native_session='native-thread' AND image=$3 AND native_version=$4 AND screened_sequence=4 AND permission_id='' AND tool_id='' AND allow_once_options='[]'::jsonb FROM golf_agent_controls WHERE task_id=$1 AND attempt_id=$2`, f.t.ID, f.attempt, image, runner.ManagedACPVersion).Scan(&closed); e != nil || !closed {
		t.Fatal("copied sandbox or permission authority remained live", e)
	}
	if e = s.db.QueryRow(`SELECT state='claimed' FROM golf_agent_commands WHERE task_id=$1 AND attempt_id=$2 AND request_id=$3`, f.t.ID, f.attempt, request.RequestId).Scan(&claimed); e != nil || !claimed {
		t.Fatal("copied command remained dispatchable", e)
	}
	if e = s.db.QueryRow(`SELECT image=$2 AND acp_image='' AND acp_version='' AND NOT acp_file_tools FROM golf_agent_worker_presence WHERE forge_url=$1 AND worker_id='worker'`, s.config.GiteaURL, image).Scan(&receiptCleared); e != nil || !receiptCleared {
		t.Fatal("copied native/file-tool receipt remained usable", e)
	}
	if original != retained() {
		t.Fatal("restore rewrote original command identity, encrypted content or native send")
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
	again, e := InvalidateRestoredSessions(t.Context(), s.db, strings.Repeat("f", 32))
	if e != nil || again.Quarantine != (RecoveryQuarantineCounts{}) || original != retained() {
		t.Fatal("repeated recovery revived copied authority or rewrote originals", e)
	}
}
