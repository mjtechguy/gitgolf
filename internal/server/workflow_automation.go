package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
)

// Load only this run's independently delegated credential. Browser logout is
// deliberately unrelated; grant expiry/revocation and sponsor disable are not.
func (s *Server) automationRunCredential(ctx context.Context, run workflowRunRecord) (automationGrantRecord, forgeCredential, error) {
	if run.Origin != "push" || !run.AutomationGrantID.Valid || !run.AutomationGrantRevision.Valid || !run.AutomationGrantEpoch.Valid || !run.AutomationCredentialVersion.Valid || !run.RepositoryEventID.Valid || len(run.SessionHash) != 0 {
		return automationGrantRecord{}, forgeCredential{}, errUnauthenticated
	}
	g, err := scanAutomationGrant(s.db.QueryRowContext(ctx, `SELECT `+automationGrantColumns+` FROM golf_automation_grants WHERE id=$1 AND forge_url=$2 AND enabled AND expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM golf_local_accounts WHERE user_id=sponsor_user_id AND disabled_at IS NOT NULL)`, run.AutomationGrantID.String, s.config.GiteaURL))
	if errors.Is(err, sql.ErrNoRows) {
		return g, forgeCredential{}, errUnauthenticated
	}
	if err != nil {
		return g, forgeCredential{}, errStorageUnavailable
	}
	if !automationRunMatchesGrant(run, g) {
		return g, forgeCredential{}, errUnauthenticated
	}
	var version int64
	var encrypted, binding []byte
	var keyID string
	err = s.db.QueryRowContext(ctx, `SELECT version,encrypted_credential,credential_binding,credential_key_id FROM golf_automation_credentials WHERE grant_id=$1`, g.ID).Scan(&version, &encrypted, &binding, &keyID)
	if err != nil {
		return g, forgeCredential{}, errStorageUnavailable
	}
	if version != run.AutomationCredentialVersion.Int64 || !bytes.Equal(binding, automationCredentialBinding(g.ID, g.ForgeURL, g.SponsorNativeUserID)) {
		return g, forgeCredential{}, errUnauthenticated
	}
	token, err := s.keyring.open(keyID, automationRepositoryDomain, encrypted, binding)
	if err != nil {
		return g, forgeCredential{}, errCredentialUnavailable
	}
	return g, forgeCredential{Kind: "pat", Token: token}, nil
}

func automationRunMatchesGrant(run workflowRunRecord, g automationGrantRecord) bool {
	return run.Origin == "push" && run.AutomationGrantID.Valid && run.AutomationGrantID.String == g.ID && g.Enabled &&
		run.ForgeURL == g.ForgeURL && run.RepositoryID == g.RepositoryID && run.OwnerID == g.OwnerID &&
		run.RepositoryOwner == g.RepositoryOwner && run.RepositoryName == g.RepositoryName && run.OrganizationOwned == g.OrganizationOwned &&
		run.UserID == g.SponsorUserID && run.AutomationGrantRevision.Valid && run.AutomationGrantRevision.Int64 == g.Revision &&
		run.AutomationGrantEpoch.Valid && run.AutomationGrantEpoch.Int64 == g.RevocationEpoch &&
		strings.HasPrefix(run.EventRef, "refs/heads/") && validRef(run.EventRef) &&
		slices.Contains(g.Branches, strings.TrimPrefix(run.EventRef, "refs/heads/")) && slices.Contains(g.WorkflowPaths, run.WorkflowPath)
}

// Shared lock order: sponsor user, grant, immutable credential, scope policies,
// then run. Native API calls and credential decryption happen outside SQL locks.
func (s *Server) lockAutomationRunAuthority(ctx context.Context, tx *sql.Tx, run workflowRunRecord) error {
	var nativeID int64
	err := tx.QueryRowContext(ctx, `SELECT forge_user_id FROM golf_users WHERE id=$1 AND forge_url=$2 FOR UPDATE`, run.UserID, s.config.GiteaURL).Scan(&nativeID)
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	var disabled bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_local_accounts WHERE user_id=$1 AND disabled_at IS NOT NULL)`, run.UserID).Scan(&disabled); err != nil {
		return errStorageUnavailable
	}
	if disabled {
		return errUnauthenticated
	}
	g, err := scanAutomationGrant(tx.QueryRowContext(ctx, `SELECT `+automationGrantColumns+` FROM golf_automation_grants WHERE id=$1 AND forge_url=$2 AND enabled AND expires_at>clock_timestamp() FOR UPDATE`, run.AutomationGrantID.String, s.config.GiteaURL))
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	if nativeID != g.SponsorNativeUserID || !automationRunMatchesGrant(run, g) {
		return errUnauthenticated
	}
	var version int64
	var binding []byte
	if err = tx.QueryRowContext(ctx, `SELECT version,credential_binding FROM golf_automation_credentials WHERE grant_id=$1 FOR SHARE`, g.ID).Scan(&version, &binding); err != nil {
		return errStorageUnavailable
	}
	if !run.AutomationCredentialVersion.Valid || version != run.AutomationCredentialVersion.Int64 || !bytes.Equal(binding, automationCredentialBinding(g.ID, g.ForgeURL, g.SponsorNativeUserID)) {
		return errUnauthenticated
	}
	return nil
}
