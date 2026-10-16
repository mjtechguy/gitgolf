package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

func organizationExecutionConsumerFixture(t *testing.T) (*organizationExecutionFixture, workflowRunRecord, *executionBindingRecord, *golfv1.RepositoryExecutionValueTarget) {
	t.Helper()
	f := newOrganizationExecutionFixture(t)
	id := uuid.NewString()
	m := organizationExecutionSave(f, id, "0", "0", "BUILD_CREDENTIAL", "organization-secret-fixture")
	if _, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
		t.Fatal(e)
	}
	req := organizationExecutionRequest(f, &golfv1.GetRepositoryAccessRequest{Repository: m.SelectedRepositories[0].Repository})
	access, e := f.s.GetRepositoryAccess(f.ctx, req)
	if e != nil {
		t.Fatal("repository source approver", e)
	}
	target := &golfv1.RepositoryExecutionValueTarget{Repository: req.Msg.Repository, RepositoryId: access.Msg.Access.RepositoryId, OwnerId: access.Msg.Access.OwnerId, AccessRevision: access.Msg.Access.Revision}
	hash, e := sessionHash(f.s.cookieValue(req.Header()))
	if e != nil {
		t.Fatal(e)
	}
	var user int64
	if e = f.db.QueryRow(`SELECT user_id FROM golf_sessions WHERE token_hash=$1`, hash).Scan(&user); e != nil {
		t.Fatal(e)
	}
	run := workflowRunRecord{ID: uuid.NewString(), ForgeURL: f.s.config.ForgeURL, RepositoryID: 9007199254740993, OwnerID: 73, UserID: user, OrganizationOwned: true, CommitID: strings.Repeat("a", 40), BlobID: strings.Repeat("b", 40), SourceSHA256: strings.Repeat("c", 64), EngineCatalog: runner.ActionsCatalog, WorkflowPath: runWorkflowPath, Origin: "push", EventRef: "refs/heads/main"}
	refs := []executionReference{{ID: id, Version: "1", Scope: "organization", OrganizationID: "73"}}
	encoded, _ := json.Marshal(refs)
	bindingID := uuid.NewString()
	if _, e = f.db.Exec(`INSERT INTO golf_execution_value_brokers(forge_url,repository_id,owner_id) VALUES($1,$2,$3)`, run.ForgeURL, run.RepositoryID, run.OwnerID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.db.Exec(`INSERT INTO golf_execution_bindings(id,forge_url,repository_id,owner_id,version) VALUES($1,$2,$3,$4,1)`, bindingID, run.ForgeURL, run.RepositoryID, run.OwnerID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.db.Exec(`INSERT INTO golf_execution_binding_versions(id,version,workflow_path,commit_id,blob_id,source_sha256,engine_catalog,event,event_ref,value_refs,approver_user_id,approver_native_id,approval_session_hash,expires_at) VALUES($1,1,$2,$3,$4,$5,$6,'push',$7,$8,$9,42,$10,$11)`, bindingID, run.WorkflowPath, run.CommitID, run.BlobID, run.SourceSHA256, run.EngineCatalog, run.EventRef, encoded, user, hash, time.Now().Add(4*time.Minute)); e != nil {
		t.Fatal(e)
	}
	b, e := f.s.executionApprovalForSource(f.ctx, run)
	if e != nil || b == nil || len(b.organizations) != 1 {
		t.Fatal("dual source/share authority", e)
	}
	return f, run, b, target
}
func organizationExecutionEnvironment(t *testing.T, f *organizationExecutionFixture, run workflowRunRecord, b *executionBindingRecord) (map[string]string, error) {
	t.Helper()
	tx, e := f.db.BeginTx(f.ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if e = lockExecutionApprovalUsers(f.ctx, tx, run, b); e != nil {
		return nil, e
	}
	env, e := f.s.executionBrokerFence(f.ctx, tx, run, b)
	if e != nil {
		return nil, e
	}
	return env.Secrets, nil
}
func TestOrganizationExecutionReleaseAndRepositoryOverridePostgres(t *testing.T) {
	f, run, b, target := organizationExecutionConsumerFixture(t)
	env, e := organizationExecutionEnvironment(t, f, run, b)
	if e != nil || env["BUILD_CREDENTIAL"] != "organization-secret-fixture" {
		t.Fatal("private inherited release", e)
	}
	inventory, e := f.s.ListRepositoryExecutionValues(f.ctx, organizationExecutionRequest(f, &golfv1.ListRepositoryExecutionValuesRequest{Target: target}))
	if e != nil || len(inventory.Msg.InheritedValues) != 1 || inventory.Msg.InheritedValues[0].Overridden {
		t.Fatal("inherited metadata inventory", e)
	}
	encoded, _ := json.Marshal(inventory.Msg)
	if bytes.Contains(encoded, []byte(env["BUILD_CREDENTIAL"])) {
		t.Fatal("inherited inventory exposed secret")
	}
	active := seedOrganizationExecutionActiveRuns(t, f, run, b)
	local := executionSaveRequest(target, uuid.NewString(), "0", "0", "BUILD_CREDENTIAL", "local-replacement-fixture", golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE)
	if _, e = f.s.SaveRepositoryExecutionValue(f.ctx, organizationExecutionRequest(f, local)); e == nil {
		t.Fatal("cross-kind override accepted")
	}
	local.Kind = golfv1.RepositoryExecutionValueKind_REPOSITORY_EXECUTION_VALUE_KIND_SECRET
	saved, e := f.s.SaveRepositoryExecutionValue(f.ctx, organizationExecutionRequest(f, local))
	if e != nil {
		t.Fatal("explicit same-kind override", e)
	}
	assertOrganizationExecutionRunsCancelled(t, f, active)
	if _, e = organizationExecutionEnvironment(t, f, run, b); !errors.Is(e, errExecutionApproval) {
		t.Fatal("inherited source selection survived explicit override", e)
	}
	inventory, e = f.s.ListRepositoryExecutionValues(f.ctx, organizationExecutionRequest(f, &golfv1.ListRepositoryExecutionValuesRequest{Target: target}))
	if e != nil || !inventory.Msg.InheritedValues[0].Overridden {
		t.Fatal("override observation", e)
	}
	tx, e := f.db.BeginTx(f.ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	name, kind, value, e := f.s.openExecutionReference(f.ctx, tx, executionTarget{repo: run.RepositoryID, owner: run.OwnerID}, executionReference{ID: local.Id, Version: saved.Msg.Operation.AcceptedVersion, Scope: "repository"})
	if e != nil || name != local.Name || kind != "secret" || value != local.Value {
		t.Fatal("explicit repository selection released wrong scope", e)
	}
}
func TestOrganizationExecutionReleaseAuthorityAndImmutableScopePostgres(t *testing.T) {
	for _, mode := range []string{"owner lost", "repo transferred", "personal kind", "wrong organization", "share removed", "session revoked", "credential version changed"} {
		t.Run(mode, func(t *testing.T) {
			f, run, b, _ := organizationExecutionConsumerFixture(t)
			switch mode {
			case "owner lost":
				f.owner.Store(false)
			case "repo transferred":
				f.foreignRepo.Store(true)
			case "personal kind":
				run.OrganizationOwned = false
			case "wrong organization":
				run.OwnerID = 74
			case "share removed":
				active := seedOrganizationExecutionActiveRuns(t, f, run, b)
				a := b.organizations[0]
				m := organizationExecutionSave(f, a.reference.ID, "1", "1", a.record.name, "")
				m.Value = nil
				m.SelectedRepositories = nil
				if _, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
					t.Fatal(e)
				}
				assertOrganizationExecutionRunsCancelled(t, f, active)
			case "session revoked":
				if _, e := f.db.Exec(`DELETE FROM golf_sessions WHERE token_hash=$1`, b.organizations[0].record.session); e != nil {
					t.Fatal(e)
				}
			case "credential version changed":
				if _, e := f.db.Exec(`UPDATE golf_local_accounts SET credential_version=credential_version+1 WHERE user_id=$1`, b.organizations[0].record.approver); e != nil {
					t.Fatal(e)
				}
			}
			if got, e := f.s.executionApprovalForSource(f.ctx, run); e == nil && (got != nil || mode != "wrong organization") {
				t.Fatal("changed source/share authority accepted", mode)
			}
			if _, e := organizationExecutionEnvironment(t, f, run, b); e == nil {
				t.Fatal("postwait private release accepted changed authority", mode)
			}
		})
	}
}
func TestOrganizationExecutionHistoryKeyLifecyclePostgres(t *testing.T) {
	f := newOrganizationExecutionFixture(t)
	id := uuid.NewString()
	m := organizationExecutionSave(f, id, "0", "0", "BUILD_CREDENTIAL", "organization-private-key-fixture")
	if _, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
		t.Fatal(e)
	}
	m.OperationId = uuid.NewString()
	m.ExpectedVersion = "1"
	m.ExpectedBrokerRevision = "1"
	m.Value = nil
	m.SelectedRepositories = nil
	if _, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
		t.Fatal(e)
	}
	if _, e := f.s.DeleteOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, &golfv1.DeleteOrganizationExecutionValueRequest{Target: f.target, Id: id, ExpectedVersion: "2", ExpectedBrokerRevision: "2", OperationId: uuid.NewString()})); e != nil {
		t.Fatal(e)
	}
	keys := rotationKeys(t, f.s.config)
	status, e := KeyStatus(f.ctx, f.db, keys)
	if e != nil {
		t.Fatal(e)
	}
	var count uint64
	for _, k := range status.Keys {
		count += k.OrganizationExecutionValues
	}
	if count != 2 {
		t.Fatal("deleted/unselected immutable history omitted", count)
	}
	missing := keyedConfig(f.s.config)
	missing.EncryptionKey = ""
	if _, e = New(missing, f.db); e == nil {
		t.Fatal("missing old family key accepted at startup")
	}
	mustActivate(t, f.db, keys)
	if _, e = CheckKeyRetirement(f.ctx, f.db, keys, "legacy"); e == nil {
		t.Fatal("retained organization history key retired")
	}
	// Rotate the fixture's existing session/account families first. Only org
	// history remains under legacy, proving the new startup counter independently.
	partial, e := RotateCredentials(f.ctx, f.db, keys, 1, 2)
	if e != nil || partial.Complete || partial.RotatedOrganizationExecutionValues != 0 {
		t.Fatal("unexpected pre-org batch", e)
	}
	if _, e = New(missing, f.db); e == nil {
		t.Fatal("organization-only retained legacy family hidden from startup")
	}
	op, e := RotateCredentials(f.ctx, f.db, keys, 1, 20)
	if e != nil || !op.Complete || op.RotatedOrganizationExecutionValues != 2 {
		t.Fatal("bounded historical organization rotation", e)
	}
	if _, e = CheckKeyRetirement(f.ctx, f.db, keys, "legacy"); e != nil {
		t.Fatal("fully rotated key remains in use", e)
	}
	var audit int
	if e = f.db.QueryRow(`SELECT coalesce(sum(organization_execution_values_count),0) FROM golf_crypto_events WHERE action='CREDENTIAL_BATCH_REENCRYPTED'`).Scan(&audit); e != nil || audit != 2 {
		t.Fatal("organization family audit counts", e)
	}
	f.s.keyring = keys
	for _, v := range []int64{1, 2} {
		_, value, e := f.s.openOrganizationExecutionValue(f.ctx, f.db, organizationExecutionTarget{id: 73}, id, v)
		if e != nil || value != "organization-private-key-fixture" {
			t.Fatal("rotated history loses original exact content", e)
		}
	}
	if _, e = f.db.Exec(`UPDATE golf_organization_execution_versions SET selected_repositories='[]' WHERE id=$1 AND version=1`, id); e == nil {
		t.Fatal("share AAD metadata mutated")
	}
	if _, e = f.db.Exec(`DELETE FROM golf_organization_execution_versions WHERE id=$1`, id); e == nil {
		t.Fatal("backup/retirement history deleted")
	}
	if _, e = New(missing, f.db); e != nil {
		t.Fatal("retired key removal failed after all families rotated", e)
	}
}

// Owned Golf-only rows exercise cancellation/storage boundaries; they are not
// a runnable workflow or evidence of native/runner execution.
func seedOrganizationExecutionActiveRuns(t *testing.T, f *organizationExecutionFixture, run workflowRunRecord, b *executionBindingRecord) []string {
	t.Helper()
	ids := []string{}
	for _, state := range []string{"queued", "running"} {
		id := uuid.NewString()
		_, e := f.db.Exec(`INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash,state) VALUES($1,$2,$3,$4,'club','example',true,$5,$6,$7,$8,$9,1,'{}',$10,$11,'[]',$12,$13,$14)`, id, run.ForgeURL, run.RepositoryID, run.OwnerID, run.UserID, b.session, run.CommitID, run.WorkflowPath, run.BlobID, []byte{}, run.SourceSHA256, uuid.NewString(), bytes.Repeat([]byte{1}, 32), state)
		if e != nil {
			t.Fatal("owned active-run fence fixture", e)
		}
		if _, e = f.db.Exec(`INSERT INTO golf_workflow_execution_bindings(run_id,binding_id,binding_version) VALUES($1,$2,$3)`, id, b.id, b.version); e != nil {
			t.Fatal(e)
		}
		ids = append(ids, id)
	}
	return ids
}
func assertOrganizationExecutionRunsCancelled(t *testing.T, f *organizationExecutionFixture, ids []string) {
	t.Helper()
	for _, id := range ids {
		var state string
		if e := f.db.QueryRow(`SELECT state FROM golf_workflow_runs WHERE id=$1`, id).Scan(&state); e != nil || state != "cancelled" {
			t.Fatal("share/override left prior work active", e)
		}
	}
}
func TestOrganizationExecutionRecoveryPreservesContentButDeniesReleasePostgres(t *testing.T) {
	f, run, b, _ := organizationExecutionConsumerFixture(t)
	active := seedOrganizationExecutionActiveRuns(t, f, run, b)
	var before []byte
	if e := f.db.QueryRow(`SELECT encrypted_content FROM golf_organization_execution_versions WHERE id=$1`, b.values[0].ID).Scan(&before); e != nil {
		t.Fatal(e)
	}
	result, e := InvalidateRestoredSessions(f.ctx, f.db, strings.Repeat("d", 32))
	if e != nil || result.SessionsCount != 1 || result.LocalAccountsDisabledCount != 1 {
		t.Fatal("quarantine original owner sessions", e)
	}
	assertOrganizationExecutionRunsCancelled(t, f, active)
	var after []byte
	if e = f.db.QueryRow(`SELECT encrypted_content FROM golf_organization_execution_versions WHERE id=$1`, b.values[0].ID).Scan(&after); e != nil || !bytes.Equal(before, after) {
		t.Fatal("recovery erased/rewrote organization ciphertext", e)
	}
	if _, e = f.s.executionApprovalForSource(f.ctx, run); e == nil {
		t.Fatal("restored organization share implicitly resumed")
	}
	var count int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_organization_execution_operations`).Scan(&count); e != nil || count != 1 {
		t.Fatal("quarantine altered immutable share receipts", e)
	}
}
func TestOrganizationExecutionLegacyBootstrapRejectsCorruptContentPostgres(t *testing.T) {
	f := newOrganizationExecutionFixture(t)
	id := uuid.NewString()
	m := organizationExecutionSave(f, id, "0", "0", "BUILD_CREDENTIAL", "organization-bootstrap-fixture")
	if _, e := f.s.SaveOrganizationExecutionValue(f.ctx, organizationExecutionRequest(f, m)); e != nil {
		t.Fatal(e)
	}
	var original []byte
	if e := f.db.QueryRow(`SELECT encrypted_content FROM golf_organization_execution_versions WHERE id=$1`, id).Scan(&original); e != nil {
		t.Fatal(e)
	}
	bad := append([]byte{}, original...)
	bad[len(bad)-1] ^= 1
	if _, e := f.db.Exec(`UPDATE golf_organization_execution_versions SET encrypted_content=$2 WHERE id=$1`, id, bad); e != nil {
		t.Fatal(e)
	}
	tx, e := f.db.BeginTx(f.ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if e = bootstrapOrganizationExecutionContents(f.ctx, tx, f.s.keyring); !errors.Is(e, errKeyBootstrap) {
		t.Fatal("bootstrap accepted corrupt organization history", e)
	}
}

func TestOrganizationExecutionCancellationScopedUUIDPostgres(t *testing.T) {
	f, run, b, _ := organizationExecutionConsumerFixture(t)
	original := seedOrganizationExecutionActiveRuns(t, f, run, b)
	untouched := []string{}
	for _, mode := range []string{"repository", "other organization"} {
		clone := *b
		clone.id = uuid.NewString()
		copyRun := run
		copyRun.ID = uuid.NewString()
		refs := []executionReference{{ID: b.values[0].ID, Version: "1", Scope: "repository"}}
		if mode == "other organization" {
			copyRun.OwnerID = 74
			refs[0].Scope = "organization"
			refs[0].OrganizationID = "74"
		}
		if _, e := f.db.Exec(`INSERT INTO golf_execution_value_brokers(forge_url,repository_id,owner_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, run.ForgeURL, run.RepositoryID, copyRun.OwnerID); e != nil {
			t.Fatal(e)
		}
		if _, e := f.db.Exec(`INSERT INTO golf_execution_bindings(id,forge_url,repository_id,owner_id,version) VALUES($1,$2,$3,$4,1)`, clone.id, run.ForgeURL, run.RepositoryID, copyRun.OwnerID); e != nil {
			t.Fatal(e)
		}
		encoded, _ := json.Marshal(refs)
		if _, e := f.db.Exec(`INSERT INTO golf_execution_binding_versions SELECT $1,version,workflow_path,commit_id,blob_id,source_sha256,engine_catalog,event,event_ref,$2,approver_user_id,approver_native_id,approval_session_hash,expires_at,created_at FROM golf_execution_binding_versions WHERE id=$3 AND version=1`, clone.id, encoded, b.id); e != nil {
			t.Fatal(e)
		}
		untouched = append(untouched, seedOrganizationExecutionActiveRuns(t, f, copyRun, &clone)...)
	}
	tx, e := f.db.BeginTx(f.ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if e = fenceOrganizationExecutionValueRuns(f.ctx, tx, run.ForgeURL, run.OwnerID, b.values[0].ID); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	assertOrganizationExecutionRunsCancelled(t, f, original)
	for _, id := range untouched {
		var state string
		if e = f.db.QueryRow(`SELECT state FROM golf_workflow_runs WHERE id=$1`, id).Scan(&state); e != nil || state == "cancelled" {
			t.Fatal("scoped UUID collision revoked unrelated work", e)
		}
	}
}
