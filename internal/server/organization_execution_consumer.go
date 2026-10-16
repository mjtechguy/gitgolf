package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type organizationExecutionApproval struct {
	organization int64
	reference    executionReference
	record       organizationExecutionRecord
	credential   forgeCredential
}

func readOrganizationExecutionApproval(ctx context.Context, q workflowQueryer, run workflowRunRecord, ref executionReference) (organizationExecutionApproval, error) {
	var out organizationExecutionApproval
	if ref.Scope != "organization" || !run.OrganizationOwned {
		return out, errExecutionApproval
	}
	org, e := discussionID(ref.OrganizationID)
	if e != nil || org != run.OwnerID {
		return out, errExecutionApproval
	}
	version, e := executionNumber(ref.Version, false)
	if e != nil || !creationKey.MatchString(ref.ID) {
		return out, errExecutionApproval
	}
	// Metadata-only preparation; ciphertext and plaintext are not opened before
	// the private attempt-bound consumer transaction authorizes release.
	columns := `v.id::text,v.name,v.kind,v.version,v.deleted,h.value_bytes,v.created_at,v.updated_at,h.selected_repositories,h.expires_at,h.approver_user_id,h.approver_native_id,h.approval_session_hash,NULL::bytea,NULL::bytea,''`
	r, e := scanOrganizationExecutionValue(q.QueryRowContext(ctx, `SELECT `+columns+` FROM golf_organization_execution_values v JOIN golf_organization_execution_versions h ON h.id=v.id AND h.version=$4 WHERE v.id=$1 AND v.forge_url=$2 AND v.organization_id=$3`, ref.ID, run.ForgeURL, org, version))
	if errors.Is(e, sql.ErrNoRows) {
		return out, errExecutionApproval
	}
	if e != nil {
		return out, errStorageUnavailable
	}
	if r.deleted || r.version != version || !r.expires.After(time.Now()) || r.approver <= 0 || r.native <= 0 || len(r.session) != 32 {
		return out, errExecutionApproval
	}
	selected := false
	for _, v := range r.selected {
		if v.ID == strconv.FormatInt(run.RepositoryID, 10) {
			selected = true
		}
	}
	if !selected {
		return out, errExecutionApproval
	}
	return organizationExecutionApproval{organization: org, reference: ref, record: r}, nil
}
func loadOrganizationExecutionApprovals(ctx context.Context, q workflowQueryer, run workflowRunRecord, b *executionBindingRecord) error {
	if b == nil {
		return nil
	}
	b.organizations = nil
	for _, ref := range b.values {
		if ref.Scope == "organization" {
			a, e := readOrganizationExecutionApproval(ctx, q, run, ref)
			if e != nil {
				return e
			}
			b.organizations = append(b.organizations, a)
		} else if (ref.Scope != "" && ref.Scope != "repository") || ref.OrganizationID != "" {
			return errExecutionApproval
		}
	}
	return nil
}
func executionApprovalUserIDs(b *executionBindingRecord) []int64 {
	if b == nil {
		return nil
	}
	ids := []int64{b.approverUser}
	for _, a := range b.organizations {
		ids = append(ids, a.record.approver)
	}
	return ids
}
func (s *Server) organizationExecutionApprovalAuthority(ctx context.Context, run workflowRunRecord, a *organizationExecutionApproval) error {
	current, e := readOrganizationExecutionApproval(ctx, s.db, run, a.reference)
	if e != nil {
		return e
	}
	if current.record.approver != a.record.approver || current.record.native != a.record.native || !bytes.Equal(current.record.session, a.record.session) || !current.record.expires.Equal(a.record.expires) {
		return errExecutionApproval
	}
	token, e := s.sessionCredentialHash(ctx, a.record.session)
	if e != nil {
		return e
	}
	session, e := database.New(s.db).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: a.record.session, ForgeURL: run.ForgeURL})
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return errStorageUnavailable
	}
	if e != nil || session.ForgeUserID != a.record.native || !session.ExpiresAt.After(a.record.expires) {
		return errExecutionApproval
	}
	a.credential = token
	if e = s.organizationExecutionNativeAuthority(ctx, run, *a); e != nil {
		return e
	}
	current, e = readOrganizationExecutionApproval(ctx, s.db, run, a.reference)
	if e != nil {
		return e
	}
	if current.record.approver != a.record.approver || current.record.native != a.record.native || !bytes.Equal(current.record.session, a.record.session) || !current.record.expires.Equal(a.record.expires) {
		return errExecutionApproval
	}
	return nil
}
func (s *Server) organizationExecutionNativeAuthority(ctx context.Context, run workflowRunRecord, a organizationExecutionApproval) error {
	token := a.credential
	user, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	if user.ID != a.record.native {
		return errExecutionApproval
	}
	repo, e := s.executionSelectedRepository(ctx, token, run.RepositoryID)
	if e != nil {
		return e
	}
	if repo.Owner == nil || repo.Owner.ID != a.organization || *repo.Archived || *repo.Mirror {
		return errExecutionApproval
	}
	t := organizationExecutionTarget{repo.Owner.Login, a.organization}
	if e = s.checkOrganizationExecutionOwner(ctx, token, t, user); e != nil {
		return e
	}
	// A second exact repository receipt follows the last membership/owner read.
	after, e := s.executionSelectedRepository(ctx, token, run.RepositoryID)
	if e != nil {
		return e
	}
	if after.ID != repo.ID || after.Owner == nil || after.Owner.ID != a.organization || *after.Archived || *after.Mirror || !a.record.expires.After(time.Now()) {
		return errExecutionApproval
	}
	return nil
}
func (s *Server) lockOrganizationExecutionApproval(ctx context.Context, tx *sql.Tx, run workflowRunRecord, a organizationExecutionApproval) error {
	if _, e := lockOrganizationExecutionBroker(ctx, tx, run.ForgeURL, a.organization, false); e != nil {
		return e
	}
	current, e := readOrganizationExecutionApproval(ctx, tx, run, a.reference)
	if e != nil {
		return e
	}
	if current.record.approver != a.record.approver || current.record.native != a.record.native || string(current.record.session) != string(a.record.session) || !current.record.expires.Equal(a.record.expires) {
		return errExecutionApproval
	}
	q := database.New(s.db).WithTx(tx)
	identity, e := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: a.record.session, ForgeURL: run.ForgeURL})
	if e != nil || identity.ID != a.record.approver || identity.ForgeUserID != a.record.native {
		return errExecutionApproval
	}
	session, e := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: a.record.session, UserID: a.record.approver, ForgeURL: run.ForgeURL})
	if e != nil || !session.ExpiresAt.After(a.record.expires) {
		return errExecutionApproval
	}
	credential, e := q.GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: a.record.session, ForgeURL: run.ForgeURL})
	if e != nil || credential.ForgeUserID != a.record.native || !credential.ExpiresAt.After(a.record.expires) {
		return errExecutionApproval
	}
	if e = s.organizationExecutionNativeAuthority(ctx, run, a); e != nil {
		return e
	}
	return nil
}
func (s *Server) openExecutionReference(ctx context.Context, q workflowQueryer, t executionTarget, ref executionReference) (string, string, string, error) {
	version, e := executionNumber(ref.Version, false)
	if e != nil {
		return "", "", "", errExecutionApproval
	}
	if ref.Scope == "organization" {
		org, e := discussionID(ref.OrganizationID)
		if e != nil || org != t.owner {
			return "", "", "", errExecutionApproval
		}
		r, value, e := s.openOrganizationExecutionValue(ctx, q, organizationExecutionTarget{id: org}, ref.ID, version)
		if e != nil {
			return "", "", "", e
		}
		if r.deleted || r.version != version || !r.expires.After(time.Now()) {
			return "", "", "", errExecutionApproval
		}
		selected := false
		for _, v := range r.selected {
			if v.ID == strconv.FormatInt(t.repo, 10) {
				selected = true
			}
		}
		if !selected {
			return "", "", "", errExecutionApproval
		}
		var overridden bool
		if e = q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_execution_values WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND name=$4 AND NOT deleted)`, s.config.ForgeURL, t.repo, t.owner, r.name).Scan(&overridden); e != nil {
			return "", "", "", errStorageUnavailable
		}
		if overridden {
			return "", "", "", errExecutionApproval
		}
		return r.name, r.kind, value, nil
	}
	if ref.Scope != "" && ref.Scope != "repository" || ref.OrganizationID != "" {
		return "", "", "", errExecutionApproval
	}
	r, value, e := s.openExecutionValue(ctx, q, t, ref.ID, version)
	if e != nil {
		return "", "", "", e
	}
	if r.deleted || r.version != version {
		return "", "", "", errExecutionApproval
	}
	return r.name, r.kind, value, nil
}
func listInheritedExecutionValues(ctx context.Context, tx *sql.Tx, forge string, t executionTarget, organizationOwned bool, organizationName string) ([]*golfv1.InheritedExecutionValue, error) {
	out := []*golfv1.InheritedExecutionValue{}
	if !organizationOwned {
		return out, nil
	}
	if _, e := lockOrganizationExecutionBroker(ctx, tx, forge, t.owner, false); e != nil {
		return nil, e
	}
	rows, e := tx.QueryContext(ctx, `SELECT v.id::text,v.name,v.kind,v.version,v.deleted,h.value_bytes,v.created_at,v.updated_at,h.selected_repositories,h.expires_at,h.approver_user_id,h.approver_native_id,h.approval_session_hash,NULL::bytea,NULL::bytea,'' FROM golf_organization_execution_values v JOIN golf_organization_execution_versions h ON h.id=v.id AND h.version=v.version WHERE v.forge_url=$1 AND v.organization_id=$2 AND NOT v.deleted AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.selected_repositories) x WHERE x->>'id'=$3) ORDER BY v.name,v.id LIMIT 65`, forge, t.owner, strconv.FormatInt(t.repo, 10))
	if e != nil {
		return nil, errStorageUnavailable
	}
	records := []organizationExecutionRecord{}
	for rows.Next() {
		r, e := scanOrganizationExecutionValue(rows)
		if e != nil {
			rows.Close()
			return nil, errStorageUnavailable
		}
		records = append(records, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil || len(records) > 64 {
		return nil, errStorageUnavailable
	}
	for _, r := range records {
		localKind := ""
		e = tx.QueryRowContext(ctx, `SELECT kind FROM golf_execution_values WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND name=$4 AND NOT deleted`, forge, t.repo, t.owner, r.name).Scan(&localKind)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return nil, errStorageUnavailable
		}
		state := "requires_current_authority"
		if !r.expires.After(time.Now()) {
			state = "expired"
		}
		if localKind != "" && localKind != r.kind {
			state = "name_conflict"
		}
		out = append(out, &golfv1.InheritedExecutionValue{OrganizationId: strconv.FormatInt(t.owner, 10), OrganizationName: organizationName, Value: wireOrganizationExecutionValue(r).Value, Overridden: localKind == r.kind, ShareExpiresAt: r.expires.UTC().Format(time.RFC3339Nano), ShareState: state})
	}
	return out, nil
}

// Local name overrides revoke inherited source approvals for that name. The
// immutable references remain historical; no binding is silently rewritten.
func fenceInheritedExecutionName(ctx context.Context, tx *sql.Tx, forge string, t executionTarget, name string) error {
	_, e := tx.ExecContext(ctx, `UPDATE golf_workflow_runs r SET state='cancelled',version=r.version+1,finished_at=clock_timestamp(),reason='Inherited execution value selection changed.',lease_token_hash=NULL FROM golf_workflow_execution_bindings rb JOIN golf_execution_binding_versions b ON b.id=rb.binding_id AND b.version=rb.binding_version WHERE r.id=rb.run_id AND r.forge_url=$1 AND r.repository_id=$2 AND r.owner_id=$3 AND r.state IN ('queued','running') AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.value_refs) ref JOIN golf_organization_execution_values v ON v.id::text=ref->>'id' WHERE ref->>'scope'='organization' AND v.forge_url=$1 AND v.organization_id=$3 AND v.name=$4)`, forge, t.repo, t.owner, name)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

// UUIDs belong to independent repository/organization tables. Scope and current
// immutable owning org are mandatory; a chosen colliding UUID cannot revoke a
// different tenant's repository value or another organization's share.
func fenceOrganizationExecutionValueRuns(ctx context.Context, tx *sql.Tx, forge string, org int64, id string) error {
	_, e := tx.ExecContext(ctx, `UPDATE golf_workflow_runs r SET state='cancelled',version=r.version+1,finished_at=clock_timestamp(),reason='Organization execution value approval or version changed.',lease_token_hash=NULL FROM golf_workflow_execution_bindings rb JOIN golf_execution_binding_versions b ON b.id=rb.binding_id AND b.version=rb.binding_version WHERE r.id=rb.run_id AND r.forge_url=$1 AND r.owner_id=$2 AND r.organization_owned AND r.state IN ('queued','running') AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.value_refs) x WHERE x->>'id'=$3 AND x->>'scope'='organization' AND x->>'organizationId'=$4)`, forge, org, id, strconv.FormatInt(org, 10))
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

func validateOrganizationExecutionApprovals(b *executionBindingRecord) error {
	next := 0
	for _, ref := range b.values {
		if ref.Scope != "organization" {
			continue
		}
		if next >= len(b.organizations) || b.organizations[next].reference != ref {
			return errExecutionApproval
		}
		next++
	}
	if next != len(b.organizations) {
		return errExecutionApproval
	}
	return nil
}
