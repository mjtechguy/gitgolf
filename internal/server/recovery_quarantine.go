package server

import (
	"context"
	"database/sql"
)

// Recovery destroys copied authority, never immutable operation identities or
// uncertain native effects. All original source writers must already be drained.
type RecoveryQuarantineCounts struct {
	MFAAccounts       uint64 `json:"mfa_accounts"`
	MFAChallenges     uint64 `json:"mfa_challenges"`
	MFARecoveryCodes  uint64 `json:"mfa_recovery_codes"`
	AgentCredentials  uint64 `json:"agent_credentials"`
	AgentConnections  uint64 `json:"agent_connections"`
	AgentTasks        uint64 `json:"agent_tasks"`
	Reviewers         uint64 `json:"reviewers"`
	ReviewerRuns      uint64 `json:"reviewer_runs"`
	WebhookDeliveries uint64 `json:"webhook_deliveries"`
	EmailDeliveries   uint64 `json:"email_deliveries"`
	EmailChallenges   uint64 `json:"email_challenges"`
	GitProfiles       uint64 `json:"git_profiles"`
}

func quarantineRestoredAuthority(ctx context.Context, tx *sql.Tx, backup, operation string) (RecoveryQuarantineCounts, error) {
	var counts RecoveryQuarantineCounts
	if _, err := tx.ExecContext(ctx, `LOCK TABLE golf_local_mfa,golf_mfa_recovery_codes,golf_mfa_login_challenges,golf_mfa_attempts,golf_mfa_events,golf_codex_connections,golf_codex_auth,golf_agent_tasks,golf_reviewers,golf_reviewer_runs,golf_reviewer_publications,golf_webhook_deliveries,golf_email_deliveries,golf_email_challenges,golf_git_transport_profiles IN ACCESS EXCLUSIVE MODE`); err != nil {
		return counts, err
	}
	for _, write := range []struct {
		query string
		count *uint64
	}{
		{`WITH changed AS (UPDATE golf_local_mfa SET version=version+1,enabled=false,active_content_id=NULL,pending_content_id=NULL,pending_expires_at=NULL,last_counter=-1 WHERE enabled OR pending_content_id IS NOT NULL RETURNING account_id,version) INSERT INTO golf_mfa_events(account_id,user_id,action,version,operation_id,actor_kind,reason) SELECT c.account_id,a.user_id,'restore_reset',c.version,$1,'operator','Quarantined restored factor from backup '||$2 FROM changed c JOIN golf_local_accounts a ON a.id=c.account_id`, &counts.MFAAccounts},
		{`DELETE FROM golf_mfa_login_challenges`, &counts.MFAChallenges},
		{`DELETE FROM golf_mfa_recovery_codes`, &counts.MFARecoveryCodes},
		{`DELETE FROM golf_codex_auth`, &counts.AgentCredentials},
		{`UPDATE golf_codex_connections SET state='REAUTH_REQUIRED',version=version+1,auth_method='',email='',plan_type='',checked_at=NULL,login_id='',verification_url='',user_code='',login_expires_at=NULL,reason_code='recovery_quarantine',updated_at=clock_timestamp() WHERE state IN ('CONNECTED','AWAITING_AUTH')`, &counts.AgentConnections},
		{`UPDATE golf_agent_tasks SET state=CASE WHEN state='running' THEN 'lost' ELSE 'cancelled' END,version=version+1,finished_at=clock_timestamp(),lease_expires_at=NULL,reason='Restored instance quarantined; inspect prior external effects. No automatic replay.' WHERE state IN ('queued','running')`, &counts.AgentTasks},
		{`UPDATE golf_reviewers SET enabled=false,revision=revision+1 WHERE enabled`, &counts.Reviewers},
		{`UPDATE golf_reviewer_runs SET state='failed',reason='Restored instance quarantined; no automatic replay.' WHERE state IN ('admitting','queued','running') AND NOT EXISTS(SELECT 1 FROM golf_reviewer_publications p WHERE p.run_id=golf_reviewer_runs.id AND p.state IN ('reserved','dispatch_unknown'))`, &counts.ReviewerRuns},
		{`UPDATE golf_webhook_deliveries SET state='cancelled',failure_code='recovery_quarantine',possible_duplicate=true,lease_id=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE state IN ('queued','sending','retrying')`, &counts.WebhookDeliveries},
		{`UPDATE golf_email_deliveries SET state='cancelled',failure_code='recovery_quarantine',possible_duplicate=true,lease_id=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE state IN ('queued','sending','retrying')`, &counts.EmailDeliveries},
		{`DELETE FROM golf_email_challenges`, &counts.EmailChallenges},
		{`UPDATE golf_git_transport_profiles SET suspended_at=clock_timestamp() WHERE suspended_at IS NULL`, &counts.GitProfiles},
	} {
		// Only the MFA audit insert has parameters; all other statements are fixed.
		var result sql.Result
		var err error
		if write.count == &counts.MFAAccounts {
			result, err = tx.ExecContext(ctx, write.query, operation, backup)
		} else {
			result, err = tx.ExecContext(ctx, write.query)
		}
		if err != nil {
			return counts, err
		}
		n, err := result.RowsAffected()
		if err != nil || n < 0 {
			return counts, errRecovery
		}
		*write.count = uint64(n)
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM golf_mfa_attempts`)
	return counts, err
}
