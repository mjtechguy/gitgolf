package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var errPushQueueCapacity = errors.New("repository push queue capacity reached")

type pushMaterialization struct {
	ID, LeaseID, GrantID, Path                  string
	EventID, Revision, Epoch, CredentialVersion int64
}

// RunPushAutomation belongs to the HTTP server lifecycle, not a request or a
// browser session. PostgreSQL leases permit multiple coordinators; executed
// attempts are never automatically retried by this preparation loop.
func (s *Server) RunPushAutomation(ctx context.Context) {
	if !s.config.PushCIEnabled || s.db == nil {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if s.materializePush(ctx) == nil {
			s.pushCoordinatorSeen.Store(time.Now().UnixNano())
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) seedPushMaterializations(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// ponytail: bounded global admission lock and 512 pending items; shard only
	// after measured admission contention. Network/source preparation holds no lock.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(738164029)`); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_push_materializations WHERE state IN ('pending','preparing')`).Scan(&count); err != nil {
		return err
	}
	limit := min(20, 512-count)
	if limit <= 0 {
		return tx.Commit()
	}
	// Only currently configured connections can create work. Old pre-grant
	// receipts never become eligible when someone enables a later grant.
	for id := range s.repositoryEventConnections {
		rows, e := tx.QueryContext(ctx, `SELECT e.id,g.id::text,g.revision,g.revocation_epoch,c.version,p.value FROM golf_repository_events e JOIN golf_repository_event_payloads h ON h.event_id=e.id JOIN golf_repository_event_connections b ON b.id=e.connection_id JOIN golf_automation_grants g ON g.forge_url=b.forge_url AND g.repository_id=b.repository_id AND g.owner_id=b.owner_id AND b.repository=g.repository_owner||'/'||g.repository_name JOIN golf_automation_credentials c ON c.grant_id=g.id CROSS JOIN LATERAL jsonb_array_elements_text(g.workflow_paths) p(value) WHERE h.push_admission_requested AND e.connection_id=$1 AND g.forge_url=$2 AND g.enabled AND g.expires_at>clock_timestamp() AND e.received_at>=g.created_at AND e.after_commit_id !~ '^0+$' AND e.ref LIKE 'refs/heads/%' AND g.branches ? substr(e.ref,12) AND NOT EXISTS(SELECT 1 FROM golf_push_materializations m WHERE m.event_id=e.id AND m.grant_id=g.id AND m.workflow_path=p.value) AND NOT EXISTS(SELECT 1 FROM golf_local_accounts a WHERE a.user_id=g.sponsor_user_id AND a.disabled_at IS NOT NULL) ORDER BY e.id,g.id,p.value LIMIT $3`, id, s.config.GiteaURL, limit)
		if e != nil {
			return e
		}
		var batch []pushMaterialization
		for rows.Next() {
			var m pushMaterialization
			if e = rows.Scan(&m.EventID, &m.GrantID, &m.Revision, &m.Epoch, &m.CredentialVersion, &m.Path); e != nil {
				rows.Close()
				return e
			}
			batch = append(batch, m)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, m := range batch {
			_, err = tx.ExecContext(ctx, `INSERT INTO golf_push_materializations(id,event_id,grant_id,grant_revision,grant_epoch,credential_version,workflow_path) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, uuid.NewString(), m.EventID, m.GrantID, m.Revision, m.Epoch, m.CredentialVersion, m.Path)
			if err != nil {
				return err
			}
			limit--
			if limit == 0 {
				break
			}
		}
		if limit == 0 {
			break
		}
	}
	return tx.Commit()
}

func (s *Server) claimPushMaterialization(ctx context.Context) (pushMaterialization, error) {
	var m pushMaterialization
	// Read-only preparation may resume after a crash, at most three times. A
	// crashed execution remains lost under the existing worker contract.
	_, err := s.db.ExecContext(ctx, `UPDATE golf_push_materializations SET state='blocked',reason='preparation_attempt_limit',lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE state='preparing' AND lease_expires_at<=clock_timestamp() AND attempts=3`)
	if err != nil {
		return m, err
	}
	m.LeaseID = uuid.NewString()
	err = s.db.QueryRowContext(ctx, `WITH candidate AS (SELECT id FROM golf_push_materializations WHERE (state='pending' OR (state='preparing' AND lease_expires_at<=clock_timestamp())) AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE golf_push_materializations m SET state='preparing',attempts=attempts+1,lease_id=$1,lease_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() FROM candidate c WHERE m.id=c.id RETURNING m.id::text,m.event_id,m.grant_id::text,m.grant_revision,m.grant_epoch,m.credential_version,m.workflow_path`, m.LeaseID).Scan(&m.ID, &m.EventID, &m.GrantID, &m.Revision, &m.Epoch, &m.CredentialVersion, &m.Path)
	return m, err
}

func (s *Server) finishPushPreparation(ctx context.Context, m pushMaterialization, state, reason string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE golf_push_materializations SET state=$3,reason=$4,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND state='preparing' AND lease_expires_at>clock_timestamp()`, m.ID, m.LeaseID, state, reason)
	return err
}

func (s *Server) materializePush(ctx context.Context) error {
	if !s.config.PushCIEnabled {
		return nil
	}
	if err := s.seedPushMaterializations(ctx); err != nil {
		return err
	}
	m, err := s.claimPushMaterialization(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	preparation, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	err = s.preparePushMaterialization(preparation, m)
	if err == nil {
		return nil
	}
	// Uncertain provider/storage outcomes retain their lease for bounded retry;
	// proven denials are terminal and cannot be replayed by policy edits.
	state, reason := "blocked", "authority_denied"
	switch {
	case errors.Is(err, errWorkflowTriggerNotMatched):
		state, reason = "skipped", "trigger_not_matched"
	case errors.Is(err, errPushActivityMissing):
		reason = "native_push_evidence_missing"
	case errors.Is(err, errPushQueueCapacity):
		reason = "repository_queue_capacity"
	case errors.Is(err, errWorkflowPolicyDenied):
		reason = "push_policy_denied"
	case errors.Is(err, errRunnerPoolUnavailable):
		reason = "runner_pool_unavailable"
	case errors.Is(err, errRunnerPoolStale):
		reason = "runner_placement_changed"
	case errors.Is(err, errActionsProfile), errors.Is(err, errWorkflowExecutionUnsupported), errors.Is(err, errWorkflowSource), errors.Is(err, errRunnerUnavailable):
		reason = "execution_contract_unsupported"
	case errors.Is(err, errUnauthenticated), errors.Is(err, errResourceNotFound), isRunnerAuthorityDenied(err):
	default:
		return err
	}
	return s.finishPushPreparation(ctx, m, state, reason)
}

func (s *Server) preparePushMaterialization(ctx context.Context, m pushMaterialization) error {
	g, err := scanAutomationGrant(s.db.QueryRowContext(ctx, `SELECT `+automationGrantColumns+` FROM golf_automation_grants WHERE id=$1`, m.GrantID))
	if err != nil {
		return errStorageUnavailable
	}
	var event pushActivityEvent
	var commit, connection string
	err = s.db.QueryRowContext(ctx, `SELECT e.sender_id,e.ref,e.after_commit_id,e.connection_id::text FROM golf_repository_events e JOIN golf_repository_event_connections b ON b.id=e.connection_id WHERE e.id=$1 AND b.forge_url=$2 AND b.repository_id=$3 AND b.owner_id=$4 AND b.repository=$5`, m.EventID, g.ForgeURL, g.RepositoryID, g.OwnerID, g.RepositoryOwner+"/"+g.RepositoryName).Scan(&event.SenderID, &event.Ref, &commit, &connection)
	if err != nil {
		return errStorageUnavailable
	}
	if _, ok := s.repositoryEventConnections[connection]; !ok {
		return errUnauthenticated
	}
	event.After = commit
	run := workflowRunRecord{ID: uuid.NewString(), Origin: "push", ForgeURL: g.ForgeURL, RepositoryID: g.RepositoryID, OwnerID: g.OwnerID, RepositoryOwner: g.RepositoryOwner, RepositoryName: g.RepositoryName, OrganizationOwned: g.OrganizationOwned, UserID: g.SponsorUserID, CommitID: commit, WorkflowPath: m.Path, EventRef: event.Ref, AutomationGrantID: sql.NullString{String: m.GrantID, Valid: true}, AutomationGrantRevision: sql.NullInt64{Int64: m.Revision, Valid: true}, AutomationGrantEpoch: sql.NullInt64{Int64: m.Epoch, Valid: true}, AutomationCredentialVersion: sql.NullInt64{Int64: m.CredentialVersion, Valid: true}, RepositoryEventID: sql.NullInt64{Int64: m.EventID, Valid: true}}
	g, credential, err := s.automationRunCredential(ctx, run)
	if err != nil {
		return err
	}
	if err = s.verifyAutomationDelegation(ctx, g, credential); err != nil {
		return err
	}
	activityID, err := s.verifyPushActivity(ctx, credential, g, event)
	if err != nil {
		return err
	}
	// Check policy before reading commands or fetching an archive.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	if err = s.lockAutomationRunAuthority(ctx, tx, run); err != nil {
		tx.Rollback()
		return err
	}
	policy, err := s.readEffectiveExecutionPolicyForEvent(ctx, tx, g.RepositoryID, g.OwnerID, g.OrganizationOwned, "push", m.Path)
	if err != nil {
		tx.Rollback()
		return err
	}
	if !policy.Allowed {
		tx.Rollback()
		return errWorkflowPolicyDenied
	}
	if err = tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	exact, blob, plan, source, err := s.prepareWorkflowRunForEvent(ctx, credential, repositoryKey{g.RepositoryOwner, g.RepositoryName}, commit, m.Path, event.Ref)
	if err != nil {
		return err
	}
	if exact != commit {
		return errInvalidForgeResponse
	}
	image, err := s.executionImage(plan)
	if err != nil {
		return err
	}
	plan.ImageDigest = image
	run.CommitID = commit
	run.BlobID = blob
	run.WorkflowPath = m.Path
	run.SourceSHA256 = sourceArchiveHash(source)
	run.EngineCatalog = workflowExecutionCatalog
	if plan.Actions != nil {
		run.EngineCatalog = plan.Actions.Catalog
	}
	approval, err := s.executionApprovalForSource(ctx, run)
	if err != nil {
		return err
	}
	binding, err := s.storeWorkflowSource(ctx, source)
	if err != nil {
		return err
	}
	if err = s.verifyAutomationDelegation(ctx, g, credential); err != nil {
		return err
	}
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return errStorageUnavailable
	}
	tx, err = s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	if err = lockExecutionApprovalUsers(ctx, tx, run, approval); err != nil {
		return err
	}
	if err = s.lockAutomationRunAuthority(ctx, tx, run); err != nil {
		return err
	}
	if err = executionLifecycleGate(ctx, tx, g.ForgeURL, g.RepositoryID); err != nil {
		return err
	}
	current, err := s.readEffectiveExecutionPolicyForEvent(ctx, tx, g.RepositoryID, g.OwnerID, g.OrganizationOwned, "push", m.Path)
	if err != nil {
		return err
	}
	oldEpochs, _ := json.Marshal(policy.Epochs)
	epochs, _ := json.Marshal(current.Epochs)
	if !current.Allowed || string(oldEpochs) != string(epochs) {
		return errWorkflowPolicyDenied
	}
	var queued int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_workflow_runs WHERE forge_url=$1 AND repository_id=$2 AND state IN ('queued','running')`, g.ForgeURL, g.RepositoryID).Scan(&queued); err != nil {
		return errStorageUnavailable
	}
	if queued >= 64 {
		return errPushQueueCapacity
	}
	if err = lockExecutionAdmissionBroker(ctx, tx, run); err != nil {
		return err
	}
	if err = s.runnerPoolAdmission(ctx, tx, g.RepositoryID, g.OwnerID); err != nil {
		return err
	}
	var lease bool
	if err = tx.QueryRowContext(ctx, `SELECT lease_id=$2 AND lease_expires_at>clock_timestamp() AND state='preparing' FROM golf_push_materializations WHERE id=$1 FOR UPDATE`, m.ID, m.LeaseID).Scan(&lease); err != nil {
		return errStorageUnavailable
	}
	if !lease {
		return errUnauthenticated
	}
	var duplicate bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_push_materializations WHERE grant_id=$1 AND native_activity_id=$2 AND workflow_path=$3 AND id<>$4)`, m.GrantID, activityID, m.Path, m.ID).Scan(&duplicate); err != nil {
		return errStorageUnavailable
	}
	if duplicate {
		_, err = tx.ExecContext(ctx, `UPDATE golf_push_materializations SET state='skipped',reason='native_activity_duplicate',lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, m.ID)
		if err != nil {
			return errStorageUnavailable
		}
		return tx.Commit()
	}
	sum := sha256.Sum256(source)
	intent := sha256.Sum256([]byte(m.ID))
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash,source_storage,source_key,source_fingerprint,source_profile_id,source_profile_version,origin,automation_grant_id,automation_grant_revision,automation_grant_epoch,automation_credential_version,repository_event_id,event_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'push',$24,$25,$26,$27,$28,$29)`, run.ID, g.ForgeURL, g.RepositoryID, g.OwnerID, g.RepositoryOwner, g.RepositoryName, g.OrganizationOwned, g.SponsorUserID, commit, m.Path, blob, int32(plan.Format), planJSON, binding.Archive, hex.EncodeToString(sum[:]), epochs, m.ID, intent[:], binding.Storage, binding.Key, binding.Fingerprint, binding.ProfileID, binding.ProfileVersion, m.GrantID, m.Revision, m.Epoch, m.CredentialVersion, m.EventID, event.Ref)
	if err != nil {
		return errStorageUnavailable
	}
	if err = s.attachExecutionBinding(ctx, tx, run, approval); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE golf_push_materializations SET state='admitted',native_activity_id=$2,run_id=$3,lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, m.ID, activityID, run.ID)
	if err != nil {
		return errStorageUnavailable
	}
	return tx.Commit()
}
