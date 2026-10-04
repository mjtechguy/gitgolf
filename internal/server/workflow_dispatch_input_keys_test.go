package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func seedWorkflowInputKeyRows(t *testing.T, n int) (*workflowRunFixture, []workflowDispatchInputContent) {
	t.Helper()
	f := newWorkflowRunFixture(t)
	f.enable(t)
	response, err := f.dispatch(t, uuid.NewString())
	if err != nil {
		t.Fatal("seed dispatch", err)
	}
	run, err := f.server.loadWorkflowRun(t.Context(), response.Msg.Run.Id)
	if err != nil {
		t.Fatal(err)
	}
	_, base, schema, values := dispatchInputContentFixture(t)
	base.RunID = run.ID
	base.ForgeURL = run.ForgeURL
	base.UserID = run.UserID
	base.NativeActorID = f.user.ID
	base.RepositoryID = run.RepositoryID
	base.OwnerID = run.OwnerID
	base.IdempotencyKey = run.IdempotencyKey
	base.CommitID = run.CommitID
	base.WorkflowPath = run.WorkflowPath
	base.BlobID = run.BlobID
	base.SourceSHA256 = run.SourceSHA256
	tx, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	out := []workflowDispatchInputContent{}
	for i := 0; i < n; i++ {
		identity := base
		if i > 0 {
			identity.RunID = uuid.NewString()
			identity.IdempotencyKey = uuid.NewString()
			patch, _ := json.Marshal(map[string]any{"id": identity.RunID, "idempotency_key": identity.IdempotencyKey})
			if _, err = tx.ExecContext(t.Context(), `INSERT INTO golf_workflow_runs SELECT (jsonb_populate_record(NULL::golf_workflow_runs,to_jsonb(r)||$2::jsonb)).* FROM golf_workflow_runs r WHERE id=$1`, run.ID, string(patch)); err != nil {
				t.Fatal("clone run fixture", err)
			}
		}
		row, err := sealWorkflowDispatchInputContent(f.server.keyring, identity, schema, values)
		if err != nil {
			t.Fatal(err)
		}
		if err = insertDispatchInputContent(t.Context(), tx, row); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return f, out
}

func workflowInputUses(status CredentialKeyStatus, id string) uint64 {
	for _, row := range status.Keys {
		if row.KeyID == id {
			return row.WorkflowDispatchInputs
		}
	}
	return 0
}
func TestWorkflowDispatchInputKeyAccounting(t *testing.T) {
	usage := CredentialKeyUsage{KeyID: "old", WorkflowDispatchInputs: 2}
	status := CredentialKeyStatus{ActiveKeyID: "next", ConfiguredActiveKeyID: "next", Keys: []CredentialKeyUsage{usage}}
	if credentialUsageTotal(usage) != 2 || remainingCredentials(status) != 2 || !errors.Is(requiredKeys(status, true), errKeyPolicy) {
		t.Fatal("retained input keys hidden from policy/accounting")
	}
	usage.Configured = true
	status.Keys[0] = usage
	if err := requiredKeys(status, true); err != nil {
		t.Fatal("configured old input key refused", err)
	}
	status.ActiveKeyID = "old"
	if remainingCredentials(status) != 0 {
		t.Fatal("active input key counted as outstanding rotation")
	}
}

func TestWorkflowDispatchInputKeysRotationPostgres(t *testing.T) {
	f, original := seedWorkflowInputKeyRows(t, 3)
	// Retained cancelled/failed/succeeded history all counts, irrespective of run visibility.
	for i, state := range []string{"cancelled", "failed", "succeeded"} {
		if _, err := f.server.db.ExecContext(t.Context(), `UPDATE golf_workflow_runs SET state=$2,version=3,started_at=clock_timestamp(),finished_at=clock_timestamp(),exit_code=0 WHERE id=$1`, original[i].Identity.RunID, state); err != nil {
			t.Fatal(err)
		}
	}
	keys := rotationKeys(t, f.server.config)
	status, err := KeyStatus(t.Context(), f.server.db, keys)
	if err != nil || workflowInputUses(status, "legacy") != 3 {
		t.Fatal("retained inventory", err)
	}
	mustActivate(t, f.server.db, keys)
	// Clear other families while holding all inputs. Missing-key/startup and
	// retirement refusal below must be attributable to this family alone.
	hold, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Rollback()
	if _, err = hold.Exec(`SELECT run_id FROM golf_workflow_dispatch_inputs FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	busy, err := RotateCredentials(t.Context(), f.server.db, keys, 1, 100)
	if err != nil || busy.Complete || busy.RotatedWorkflowDispatchInputs != 0 || remainingCredentials(busy.Status) != 3 {
		t.Fatal("busy retained inputs must remain after other families rotate", err)
	}
	hold.Rollback()
	missing := keyedConfig(f.server.config)
	missing.EncryptionKey = ""
	if _, err = New(missing, f.server.db); !errors.Is(err, errKeyPolicy) {
		t.Fatal("startup admitted missing historical input key", err)
	}
	if _, err = CheckKeyRetirement(t.Context(), f.server.db, keys, "legacy"); !errors.Is(err, errKeyRetirement) {
		t.Fatal("in-use input key retired", err)
	}
	// Shared budget remains one across earlier credential families and inputs.
	result, err := RotateCredentials(t.Context(), f.server.db, keys, 1, 100)
	if err != nil || !result.Complete || result.RotatedWorkflowDispatchInputs != 3 {
		t.Fatal("bounded shared rotation", err)
	}
	var inputAudit, maxTotal int64
	if err = f.server.db.QueryRow(`SELECT sum(workflow_dispatch_inputs_count),max(sessions_count+oauth_attempts_count+local_accounts_count+infrastructure_connections_count+automation_credentials_count+review_contents_count+conversation_contents_count+webhook_credentials_count+notification_contents_count+execution_values_count+quarantined_outputs_count+organization_execution_values_count+workflow_dispatch_inputs_count) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'`).Scan(&inputAudit, &maxTotal); err != nil || inputAudit != 3 || maxTotal > 1 {
		t.Fatal("audit/shared batch bound", err)
	}
	for _, before := range original {
		tx, err := f.server.db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := workflowDispatchInputKeyRows(t.Context(), tx, "next", "", 500, false)
		tx.Rollback()
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, row := range rows {
			if row.content.Identity.RunID == before.Identity.RunID {
				found = true
				if row.content.Identity != before.Identity || row.content.PlainBytes != before.PlainBytes || row.content.PlainSHA256 != before.PlainSHA256 || !bytes.Equal(row.content.Binding, before.Binding) {
					t.Fatal("rotation rewrote source/input identity")
				}
				if _, err = openWorkflowDispatchInputContent(keys, before.Identity, row.content); err != nil {
					t.Fatal("rotated retained content unavailable", err)
				}
			}
		}
		if !found {
			t.Fatal("rotation hid retained row")
		}
	}
	if _, err = CheckKeyRetirement(t.Context(), f.server.db, keys, "legacy"); err != nil {
		t.Fatal("zero-use old key retirement", err)
	}
	if _, err = New(missing, f.server.db); err != nil {
		t.Fatal("restart after retirement", err)
	}
}

func TestWorkflowDispatchInputKeysBusyRollbackPostgres(t *testing.T) {
	f, _ := seedWorkflowInputKeyRows(t, 2)
	keys := rotationKeys(t, f.server.config)
	mustActivate(t, f.server.db, keys)
	busy, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Rollback()
	if _, err = busy.ExecContext(t.Context(), `SELECT run_id FROM golf_workflow_dispatch_inputs FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	tx, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	count, err := rotateWorkflowDispatchInputContents(t.Context(), tx, keys, 10)
	tx.Rollback()
	if err != nil || count != 0 {
		t.Fatal("busy content not skipped", err)
	}
	busy.Rollback()
	// Refuse the last sorted content update after an earlier row was rewritten;
	// the same transaction must roll back earlier families/rows and its audit.
	var last string
	if err = f.server.db.QueryRow(`SELECT run_id::text FROM golf_workflow_dispatch_inputs ORDER BY run_id DESC LIMIT 1`).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.db.Exec(`CREATE FUNCTION test_input_rotation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rotation refusal'; END $$; CREATE TRIGGER test_input_rotation_fail BEFORE UPDATE ON golf_workflow_dispatch_inputs FOR EACH ROW WHEN (OLD.run_id='` + last + `'::uuid) EXECUTE FUNCTION test_input_rotation_fail()`); err != nil {
		t.Fatal(err)
	}
	result, err := RotateCredentials(t.Context(), f.server.db, keys, 1000, 1)
	if err == nil || result.Complete || result.RotatedWorkflowDispatchInputs != 0 {
		t.Fatal("failed batch reported completion")
	}
	var audits int
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'`).Scan(&audits); err != nil || audits != 0 {
		t.Fatal("rolled back batch left audit", err)
	}
	status, err := KeyStatus(t.Context(), f.server.db, keys)
	if err != nil || workflowInputUses(status, "legacy") != 2 || workflowInputUses(status, "next") != 0 {
		t.Fatal("failed batch rewrote content", err)
	}
	if _, err = f.server.db.Exec(`DROP TRIGGER test_input_rotation_fail ON golf_workflow_dispatch_inputs; DROP FUNCTION test_input_rotation_fail()`); err != nil {
		t.Fatal(err)
	}
	result, err = RotateCredentials(t.Context(), f.server.db, keys, 1000, 1)
	if err != nil || !result.Complete || result.RotatedWorkflowDispatchInputs != 2 {
		t.Fatal("resumed failed batch", err)
	}
}

func TestWorkflowDispatchInputKeysBootstrap501Postgres(t *testing.T) {
	f, original := seedWorkflowInputKeyRows(t, 501)
	tx, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = bootstrapWorkflowDispatchInputContents(t.Context(), tx, f.server.keyring); err != nil {
		t.Fatal("501-row authentication", err)
	}
	tx.Rollback()
	// Corrupt precisely the last sorted row: a single 500-row bootstrap would miss it.
	var id string
	if err = f.server.db.QueryRow(`SELECT run_id::text FROM golf_workflow_dispatch_inputs ORDER BY run_id DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	for _, row := range original {
		if row.Identity.RunID == id {
			cipher := append([]byte{}, row.EncryptedContent...)
			cipher[0] ^= 1
			if _, err = f.server.db.Exec(`UPDATE golf_workflow_dispatch_inputs SET encrypted_content=$2 WHERE run_id=$1`, id, cipher); err != nil {
				t.Fatal(err)
			}
		}
	}
	tx, err = f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = bootstrapWorkflowDispatchInputContents(t.Context(), tx, f.server.keyring); !errors.Is(err, errKeyBootstrap) {
		t.Fatal("bootstrap stopped before row501", err)
	}
}

func TestWorkflowDispatchInputKeysRecoveryLockPostgres(t *testing.T) {
	f, original := seedWorkflowInputKeyRows(t, 1)
	hold, err := f.server.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Rollback()
	if _, err = hold.Exec(`SELECT run_id FROM golf_workflow_dispatch_inputs FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if _, err = InvalidateRestoredSessions(ctx, f.server.db, "abcdef0123456789abcdef0123456789"); err == nil {
		t.Fatal("recovery did not fence retained input table")
	}
	hold.Rollback()
	if _, err = InvalidateRestoredSessions(t.Context(), f.server.db, "abcdef0123456789abcdef0123456789"); err != nil {
		t.Fatal("drained recovery", err)
	}
	var count int
	var state string
	if err = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_dispatch_inputs`).Scan(&count); err != nil || count != 1 {
		t.Fatal("recovery erased input history", err)
	}
	if err = f.server.db.QueryRow(`SELECT state FROM golf_workflow_runs WHERE id=$1`, original[0].Identity.RunID).Scan(&state); err != nil || state != "cancelled" {
		t.Fatal("recovery replayed original work", err)
	}
}
