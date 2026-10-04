package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"strconv"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func (s *Server) executionApprovalAuthority(ctx context.Context, run workflowRunRecord, b *executionBindingRecord) error {
	if b == nil {
		return nil
	}
	if e := validateOrganizationExecutionApprovals(b); e != nil {
		return e
	}
	for i := range b.organizations {
		if e := s.organizationExecutionApprovalAuthority(ctx, run, &b.organizations[i]); e != nil {
			return e
		}
	}
	token, e := s.sessionCredentialHash(ctx, b.session)
	if e != nil {
		return e
	}
	session, e := database.New(s.db).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: b.session, ForgeURL: s.config.GiteaURL})
	if e != nil || session.ForgeUserID != b.approverNative {
		return errExecutionApproval
	}
	user, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	if user.ID != b.approverNative {
		return errExecutionApproval
	}
	repository, e := s.executionSelectedRepository(ctx, token, run.RepositoryID)
	if e != nil {
		return e
	}
	if repository.Owner.ID != run.OwnerID || *repository.Archived || *repository.Mirror {
		return errExecutionApproval
	}
	key := repositoryKey{repository.Owner.Login, repository.Name}
	access, e := s.readRepositoryAccess(ctx, token, key, user)
	if e != nil {
		return e
	}
	if !automationGrantAdmin(access) || access.RepositoryId != strconv.FormatInt(run.RepositoryID, 10) || access.OwnerId != strconv.FormatInt(run.OwnerID, 10) {
		return errExecutionApproval
	}
	base, _ := repositoryPath(key)
	var fork struct {
		ID   int64 `json:"id"`
		Fork *bool `json:"fork"`
	}
	_, e = s.forgeJSON(ctx, http.MethodGet, base, token, nil, &fork, http.StatusOK)
	if e != nil {
		return e
	}
	if fork.ID != run.RepositoryID || fork.Fork == nil || *fork.Fork {
		return errExecutionApproval
	}
	return nil
}
func (s *Server) executionApprovalForSource(ctx context.Context, run workflowRunRecord) (*executionBindingRecord, error) {
	rows, e := s.db.QueryContext(ctx, `SELECT `+executionBindingColumns+` FROM golf_execution_bindings b JOIN golf_execution_binding_versions v ON v.id=b.id AND v.version=b.version WHERE b.forge_url=$1 AND b.repository_id=$2 AND b.owner_id=$3 AND NOT b.deleted AND v.workflow_path=$4 AND v.event=$5 LIMIT 21`, s.config.GiteaURL, run.RepositoryID, run.OwnerID, run.WorkflowPath, run.Origin)
	if e != nil {
		return nil, errStorageUnavailable
	}
	bindings := []executionBindingRecord{}
	for rows.Next() {
		b, e := scanExecutionBinding(rows)
		if e != nil {
			rows.Close()
			return nil, errStorageUnavailable
		}
		bindings = append(bindings, b)
	}
	e = rows.Err()
	rows.Close()
	if e != nil || len(bindings) > 20 {
		return nil, errStorageUnavailable
	}
	if len(bindings) == 0 {
		return nil, nil
	}
	if run.Origin == "manual" && run.EventRef != run.CommitID {
		return nil, errExecutionApproval
	}
	// Configured broker workflows cannot silently execute different/unapproved
	// source without values. The administrator must change/delete that approval.
	var selected *executionBindingRecord
	for i := range bindings {
		b := &bindings[i]
		if b.commit == run.CommitID && b.blob == run.BlobID && b.source == run.SourceSHA256 && executionBindingInputsMatch(b, run) && (b.event != "push" || b.ref == run.EventRef) {
			if selected != nil {
				return nil, errExecutionApproval
			}
			selected = b
		}
	}
	if selected == nil {
		return nil, errExecutionApproval
	}
	if e = loadOrganizationExecutionApprovals(ctx, s.db, run, selected); e != nil {
		return nil, e
	}
	if e = s.executionApprovalAuthority(ctx, run, selected); e != nil {
		return nil, e
	}
	return selected, nil
}
func storedExecutionRunBinding(ctx context.Context, tx workflowQueryer, run workflowRunRecord) (*executionBindingRecord, error) {
	var exists bool
	if e := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_workflow_execution_bindings WHERE run_id=$1)`, run.ID).Scan(&exists); e != nil {
		return nil, errStorageUnavailable
	}
	if !exists {
		return nil, nil
	}
	b, e := scanExecutionBinding(tx.QueryRowContext(ctx, `SELECT `+executionBindingColumns+` FROM golf_workflow_execution_bindings rb JOIN golf_execution_bindings b ON b.id=rb.binding_id JOIN golf_execution_binding_versions v ON v.id=rb.binding_id AND v.version=rb.binding_version WHERE rb.run_id=$1 AND b.forge_url=$2 AND b.repository_id=$3 AND b.owner_id=$4 AND b.version=rb.binding_version AND NOT b.deleted`, run.ID, run.ForgeURL, run.RepositoryID, run.OwnerID))
	if errors.Is(e, sql.ErrNoRows) {
		return nil, errExecutionApproval
	}
	if e != nil {
		return nil, errStorageUnavailable
	}
	if e = loadOrganizationExecutionApprovals(ctx, tx, run, &b); e != nil {
		return nil, e
	}
	return &b, nil
}

// Acquire all immutable user locks in one order before existing policy/session
// fences. Approval may belong to a different administrator than the run actor.
func lockExecutionApprovalUsers(ctx context.Context, tx *sql.Tx, run workflowRunRecord, b *executionBindingRecord) error {
	if b == nil {
		return nil
	}
	rows, e := tx.QueryContext(ctx, `SELECT id FROM golf_users WHERE forge_url=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE`, run.ForgeURL, executionRunApprovalUserIDs(run, b))
	if e != nil {
		return errStorageUnavailable
	}
	count := 0
	for rows.Next() {
		count++
	}
	e = rows.Err()
	rows.Close()
	expected := len(executionRunApprovalUserIDs(run, b))
	if e != nil {
		return errStorageUnavailable
	}
	if count != expected {
		return errExecutionApproval
	}
	return nil
}
func (s *Server) executionBrokerFence(ctx context.Context, tx *sql.Tx, run workflowRunRecord, b *executionBindingRecord) (*runner.ExecutionEnvironment, error) {
	if b == nil {
		return nil, nil
	}
	if e := validateOrganizationExecutionApprovals(b); e != nil {
		return nil, e
	}
	if e := executionLifecycleGate(ctx, tx, run.ForgeURL, run.RepositoryID); e != nil {
		return nil, e
	}
	for _, a := range b.organizations {
		if e := s.lockOrganizationExecutionApproval(ctx, tx, run, a); e != nil {
			return nil, e
		}
	}
	var revision int64
	if e := tx.QueryRowContext(ctx, `SELECT revision FROM golf_execution_value_brokers WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 FOR SHARE`, run.ForgeURL, run.RepositoryID, run.OwnerID).Scan(&revision); e != nil {
		return nil, errExecutionApproval
	}
	var current bool
	if e := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_execution_bindings current JOIN golf_execution_binding_versions v ON v.id=current.id AND v.version=current.version WHERE current.id=$1 AND current.forge_url=$2 AND current.repository_id=$3 AND current.owner_id=$4 AND current.version=$5 AND NOT current.deleted AND v.expires_at>clock_timestamp() AND v.approver_user_id=$6 AND v.approver_native_id=$7 AND v.approval_session_hash=$8)`, b.id, run.ForgeURL, run.RepositoryID, run.OwnerID, b.version, b.approverUser, b.approverNative, b.session).Scan(&current); e != nil {
		return nil, errStorageUnavailable
	}
	if !current || !executionBindingInputsMatch(b, run) || b.commit != run.CommitID || b.blob != run.BlobID || b.source != run.SourceSHA256 || b.path != run.WorkflowPath || b.event != run.Origin || b.event == "push" && b.ref != run.EventRef {
		return nil, errExecutionApproval
	}
	if run.Origin == "manual" {
		plan, e := loadActionPlan(ctx, tx, run.ID)
		if e != nil {
			return nil, e
		}
		if plan.Ref != run.CommitID {
			return nil, errExecutionApproval
		}
	}
	q := database.New(s.db).WithTx(tx)
	identity, e := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: b.session, ForgeURL: run.ForgeURL})
	if e != nil || identity.ID != b.approverUser || identity.ForgeUserID != b.approverNative {
		return nil, errExecutionApproval
	}
	session, e := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: b.session, UserID: b.approverUser, ForgeURL: run.ForgeURL})
	if e != nil || !session.ExpiresAt.After(b.expires) {
		return nil, errExecutionApproval
	}
	env := &runner.ExecutionEnvironment{Variables: map[string]string{}, Secrets: map[string]string{}}
	t := executionTarget{repo: run.RepositoryID, owner: run.OwnerID}
	for _, ref := range b.values {
		name, kind, value, e := s.openExecutionReference(ctx, tx, t, ref)
		if e != nil {
			return nil, e
		}
		if _, ok := env.Secrets[name]; ok {
			return nil, errExecutionApproval
		}
		if _, ok := env.Variables[name]; ok {
			return nil, errExecutionApproval
		}
		if kind == "secret" {
			env.Secrets[name] = value
		} else {
			env.Variables[name] = value
		}
	}
	if env.Validate() != nil {
		return nil, errCredentialUnavailable
	}
	return env, nil
}

// Prelock before repository placement/pool/run admission. Absence is protected
// too: a concurrent first broker/binding creation cannot invert this ordering.
// This reads metadata only and does not open any execution value.
func lockExecutionAdmissionBroker(ctx context.Context, tx *sql.Tx, run workflowRunRecord) error {
	if e := executionLifecycleGate(ctx, tx, run.ForgeURL, run.RepositoryID); e != nil {
		return e
	}
	if run.OrganizationOwned {
		if _, e := lockOrganizationExecutionBroker(ctx, tx, run.ForgeURL, run.OwnerID, false); e != nil {
			return e
		}
	}
	if e := lockExecutionBrokerAbsence(ctx, tx, run.ForgeURL, run.RepositoryID, run.OwnerID); e != nil {
		return e
	}
	var revision int64
	e := tx.QueryRowContext(ctx, `SELECT revision FROM golf_execution_value_brokers WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 FOR SHARE`, run.ForgeURL, run.RepositoryID, run.OwnerID).Scan(&revision)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) attachExecutionBinding(ctx context.Context, tx *sql.Tx, run workflowRunRecord, b *executionBindingRecord) error {
	if e := lockExecutionAdmissionBroker(ctx, tx, run); e != nil {
		return e
	}
	if b == nil {
		var configured bool
		if e := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_execution_bindings b JOIN golf_execution_binding_versions v ON v.id=b.id AND v.version=b.version WHERE b.forge_url=$1 AND b.repository_id=$2 AND b.owner_id=$3 AND NOT b.deleted AND v.workflow_path=$4 AND v.event=$5)`, run.ForgeURL, run.RepositoryID, run.OwnerID, run.WorkflowPath, run.Origin).Scan(&configured); e != nil {
			return errStorageUnavailable
		}
		if configured {
			return errExecutionApproval
		}
		return nil
	}
	if _, e := s.executionBrokerFence(ctx, tx, run, b); e != nil {
		return e
	}
	_, e := tx.ExecContext(ctx, `INSERT INTO golf_workflow_execution_bindings(run_id,binding_id,binding_version) VALUES($1,$2,$3)`, run.ID, b.id, b.version)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}
func (s *Server) appendQuarantinedOutput(ctx context.Context, tx *sql.Tx, run workflowRunRecord, attempt string, sequence int64, text, job, step string) error {
	var last, used int64
	if e := tx.QueryRowContext(ctx, `SELECT log_sequence,log_bytes FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&last, &used); e != nil {
		return errStorageUnavailable
	}
	if sequence <= last {
		var encrypted, binding []byte
		var key, oldJob, oldStep string
		var size int
		e := tx.QueryRowContext(ctx, `SELECT encrypted_content,content_binding,credential_key_id,raw_bytes,job_instance_id,step_id FROM golf_workflow_quarantined_outputs WHERE run_id=$1 AND sequence=$2 AND attempt_id=$3`, run.ID, sequence, attempt).Scan(&encrypted, &binding, &key, &size, &oldJob, &oldStep)
		if e != nil || oldJob != job || oldStep != step || !bytes.Equal(binding, quarantineBinding(run, attempt, sequence, job, step, size)) {
			return errWorkflowRunConflict
		}
		old, e := s.keyring.open(key, quarantinedOutputDomain, encrypted, binding)
		if e != nil || old != text {
			return errWorkflowRunConflict
		}
		return nil
	}
	if sequence != last+1 || sequence > 16384 || used+int64(len(text)) > runnerMaxLogBytes {
		return errWorkflowRunConflict
	}
	binding := quarantineBinding(run, attempt, sequence, job, step, len(text))
	encrypted, key, e := s.keyring.seal(quarantinedOutputDomain, text, binding)
	if e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO golf_workflow_quarantined_outputs(run_id,attempt_id,sequence,forge_url,repository_id,owner_id,job_instance_id,step_id,raw_bytes,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, run.ID, attempt, sequence, run.ForgeURL, run.RepositoryID, run.OwnerID, job, step, len(text), encrypted, binding, key)
	if e != nil {
		return errStorageUnavailable
	}
	_, e = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET log_sequence=$2,log_bytes=log_bytes+$3 WHERE id=$1`, run.ID, sequence, len(text))
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

// Exact-string redaction marks bytes across the complete ordered transcript,
// then preserves each original receipt/coordinate boundary. Arbitrarily encoded
// or transformed secrets are outside this source-trusted profile's guarantee.
func redactExecutionOutput(chunks []string, secrets map[string]string) ([]string, error) {
	var combined []byte
	for _, text := range chunks {
		if !runnerLogText(text) {
			return nil, errCredentialUnavailable
		}
		combined = append(combined, []byte(text)...)
		if len(combined) > runnerMaxLogBytes {
			return nil, errCredentialUnavailable
		}
	}
	marks := make([]int32, len(combined)+1)
	seen := map[string]bool{}
	for _, secret := range secrets {
		if !runner.ExecutionValueBody(secret, true) {
			return nil, errCredentialUnavailable
		}
		if seen[secret] {
			continue
		}
		seen[secret] = true
		// KMP retains overlapping matches without quadratic repeated-byte marking.
		pattern := []byte(secret)
		failure := make([]int, len(pattern))
		for i, j := 1, 0; i < len(pattern); i++ {
			for j > 0 && pattern[i] != pattern[j] {
				j = failure[j-1]
			}
			if pattern[i] == pattern[j] {
				j++
			}
			failure[i] = j
		}
		for i, j := 0, 0; i < len(combined); i++ {
			for j > 0 && combined[i] != pattern[j] {
				j = failure[j-1]
			}
			if combined[i] == pattern[j] {
				j++
			}
			if j == len(pattern) {
				start := i - len(pattern) + 1
				marks[start]++
				marks[i+1]--
				j = failure[j-1]
			}
		}
	}
	active := int32(0)
	for i := range combined {
		active += marks[i]
		if active > 0 {
			combined[i] = '*'
		}
	}
	result := make([]string, len(chunks))
	offset := 0
	for i, text := range chunks {
		result[i] = string(combined[offset : offset+len(text)])
		offset += len(text)
		if !runnerLogText(result[i]) {
			return nil, errCredentialUnavailable
		}
	}
	return result, nil
}
func (s *Server) releaseQuarantinedOutput(ctx context.Context, tx *sql.Tx, run workflowRunRecord, attempt string, env *runner.ExecutionEnvironment) error {
	rows, e := tx.QueryContext(ctx, `SELECT sequence,raw_bytes,job_instance_id,step_id,encrypted_content,content_binding,credential_key_id FROM golf_workflow_quarantined_outputs WHERE run_id=$1 AND attempt_id=$2 ORDER BY sequence LIMIT 16385`, run.ID, attempt)
	if e != nil {
		return errStorageUnavailable
	}
	type output struct {
		seq             int64
		job, step, text string
	}
	entries := []output{}
	chunks := []string{}
	total := 0
	for rows.Next() {
		var r output
		var size int
		var encrypted, binding []byte
		var key string
		if e = rows.Scan(&r.seq, &size, &r.job, &r.step, &encrypted, &binding, &key); e != nil {
			rows.Close()
			return errStorageUnavailable
		}
		if r.seq != int64(len(entries)+1) || !bytes.Equal(binding, quarantineBinding(run, attempt, r.seq, r.job, r.step, size)) {
			rows.Close()
			return errCredentialUnavailable
		}
		r.text, e = s.keyring.open(key, quarantinedOutputDomain, encrypted, binding)
		if e != nil || len(r.text) != size {
			rows.Close()
			return errCredentialUnavailable
		}
		total += size
		if total > runnerMaxLogBytes {
			rows.Close()
			return errCredentialUnavailable
		}
		entries = append(entries, r)
		chunks = append(chunks, r.text)
	}
	e = rows.Err()
	rows.Close()
	if e != nil || len(entries) > 16384 {
		return errStorageUnavailable
	}
	var sequence, used int64
	if e = tx.QueryRowContext(ctx, `SELECT log_sequence,log_bytes FROM golf_workflow_runs WHERE id=$1`, run.ID).Scan(&sequence, &used); e != nil || sequence != int64(len(entries)) || used != int64(total) {
		return errCredentialUnavailable
	}
	masked, e := redactExecutionOutput(chunks, env.Secrets)
	if e != nil {
		return e
	}
	for i, r := range entries {
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_workflow_run_logs(run_id,sequence,text,job_instance_id,engine_step_id) VALUES($1,$2,$3,$4,$5)`, run.ID, r.seq, masked[i], r.job, r.step); e != nil {
			return errStorageUnavailable
		}
	}
	_, e = tx.ExecContext(ctx, `UPDATE golf_workflow_execution_bindings SET output_state='redacted' WHERE run_id=$1 AND output_state='withheld'`, run.ID)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}
func observeExecutionOutput(ctx context.Context, tx workflowQueryer, runID string) (golfv1.WorkflowOutputState, string, string, error) {
	var state, id string
	var version int64
	e := tx.QueryRowContext(ctx, `SELECT output_state,binding_id::text,binding_version FROM golf_workflow_execution_bindings WHERE run_id=$1`, runID).Scan(&state, &id, &version)
	if errors.Is(e, sql.ErrNoRows) {
		return golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_ORDINARY, "", "", nil
	}
	if e != nil {
		return 0, "", "", errStorageUnavailable
	}
	if state == "redacted" {
		return golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_REDACTED, id, strconv.FormatInt(version, 10), nil
	}
	if state != "withheld" {
		return 0, "", "", errStorageUnavailable
	}
	return golfv1.WorkflowOutputState_WORKFLOW_OUTPUT_STATE_WITHHELD, id, strconv.FormatInt(version, 10), nil
}

// One sorted identity lock order covers the actor and both approving scopes.
func executionRunApprovalUserIDs(run workflowRunRecord, b *executionBindingRecord) []int64 {
	ids := append([]int64{run.UserID}, executionApprovalUserIDs(b)...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := []int64{}
	for _, id := range ids {
		if len(out) == 0 || out[len(out)-1] != id {
			out = append(out, id)
		}
	}
	return out
}
