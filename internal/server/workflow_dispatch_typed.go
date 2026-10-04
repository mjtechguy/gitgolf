package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"strings"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

const workflowTypedEngineCatalog = "golf.workflow.act.v0.2.89.linux.v2"

type workflowDispatchTyped struct {
	Schema workflowDispatchInputSchema
	Values workflowDispatchInputValues
}

func workflowDispatchTypedMode(m *golfv1.DispatchWorkflowRequest) (bool, int64, int64, error) {
	present := m.InputContract != nil
	any := present || m.SubmittedSha256 != nil || len(m.Inputs) > 0 || m.WorkflowBlobId != "" || m.RepositoryId != "" || m.OwnerId != "" || m.SchemaSha256 != "" || m.EffectiveSha256 != ""
	if !any {
		return false, 0, 0, nil
	}
	if len(m.ProtoReflect().GetUnknown()) != 0 || !present || m.GetInputContract() != workflowManualInputsContract || m.SubmittedSha256 == nil || !workflowDispatchSHA256(m.GetSubmittedSha256()) || !workflowDispatchSHA256(m.SchemaSha256) || !workflowDispatchSHA256(m.EffectiveSha256) || !objectID.MatchString(m.WorkflowBlobId) || !objectID.MatchString(m.Ref) || m.WorkflowPath == ".gitlab-ci.yml" || len(m.Inputs) > maxWorkflowDispatchInputs {
		return false, 0, 0, invalid("Prepare typed inputs using the exact original source and input contract.")
	}
	repo, err := discussionID(m.RepositoryId)
	if err != nil {
		return false, 0, 0, err
	}
	owner, err := discussionID(m.OwnerId)
	if err != nil {
		return false, 0, 0, err
	}
	return true, repo, owner, nil
}

func workflowTypedIntentHash(key repositoryKey, commit, file string, repo, owner int64, blob, schema, submitted, effective, contract string) []byte {
	body, _ := json.Marshal(struct {
		Owner, Name, Commit, Path                    string
		RepositoryID, OwnerID                        int64
		Blob, Schema, Submitted, Effective, Contract string
	}{strings.ToLower(key.Owner), strings.ToLower(key.Name), commit, file, repo, owner, blob, schema, submitted, effective, contract})
	sum := sha256.Sum256(append([]byte("golf.workflow.dispatch.typed.intent.v1\x00"), body...))
	return sum[:]
}

// Source declaration/value validation and digest comparison precede archive
// acquisition/planning and any durable source upload or run reservation.
func (s *Server) prepareWorkflowDispatchTyped(ctx context.Context, credential forgeCredential, key repositoryKey, m *golfv1.DispatchWorkflowRequest) (string, string, *workflowExecutionPlan, []byte, *workflowDispatchTyped, error) {
	commit, blob, data, err := s.readWorkflowDefinition(ctx, credential, key, m.Ref, m.WorkflowPath)
	if err != nil {
		return "", "", nil, nil, nil, err
	}
	schema, err := parseWorkflowDispatchInputs(data)
	if err != nil {
		return "", "", nil, nil, nil, invalid(errWorkflowDispatchInputDeclaration.Error())
	}
	values, err := workflowDispatchWireValues(schema, m.Inputs)
	if err != nil {
		return "", "", nil, nil, nil, invalid(errWorkflowDispatchInputValues.Error())
	}
	if commit != m.Ref || blob != m.WorkflowBlobId || schema.SHA256 != m.SchemaSha256 || values.SubmittedSHA256 != m.GetSubmittedSha256() || values.EffectiveSHA256 != m.EffectiveSha256 {
		return "", "", nil, nil, nil, errWorkflowRunConflict
	}
	base, _ := repositoryPath(key)
	source, err := s.workflowSource(ctx, credential, base, commit, m.WorkflowPath, blob, data)
	if err != nil {
		return "", "", nil, nil, nil, err
	}
	actions, err := s.planActionsManual(ctx, m.WorkflowPath, blob, m.Ref, source, schema.SHA256)
	if err != nil {
		return "", "", nil, nil, nil, err
	}
	if actions.Catalog != workflowTypedEngineCatalog {
		return "", "", nil, nil, nil, errActionsEngine
	}
	if err = s.verifyActionSources(ctx, base, credential, commit, actions); err != nil {
		return "", "", nil, nil, nil, err
	}
	return commit, blob, &workflowExecutionPlan{Format: golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS, Actions: actions}, source, &workflowDispatchTyped{schema, values}, nil
}

func workflowDispatchInputRunIdentity(r workflowRunRecord, native int64) workflowDispatchInputIdentity {
	return workflowDispatchInputIdentity{RunID: r.ID, ForgeURL: r.ForgeURL, UserID: r.UserID, NativeActorID: native, RepositoryID: r.RepositoryID, OwnerID: r.OwnerID, IdempotencyKey: r.IdempotencyKey, CommitID: r.CommitID, WorkflowPath: r.WorkflowPath, BlobID: r.BlobID, SourceSHA256: r.SourceSHA256, SchemaSHA256: r.SchemaSHA256, SubmittedSHA256: r.SubmittedSHA256, EffectiveSHA256: r.EffectiveSHA256}
}

// Exact run-bound private payload loader. Caller holds current own managed
// session/credential authority; this helper neither grants nor releases work.
func (s *Server) loadWorkflowDispatchTypedValues(ctx context.Context, tx *sql.Tx, r workflowRunRecord, native int64) (workflowDispatchInputValues, error) {
	if r.InputContract != workflowManualInputsContract || r.Origin != "manual" || r.EngineCatalog != workflowTypedEngineCatalog {
		return workflowDispatchInputValues{}, errCredentialUnavailable
	}
	var c workflowDispatchInputContent
	i := &c.Identity
	err := tx.QueryRowContext(ctx, `SELECT run_id::text,forge_url,user_id,native_actor_id,repository_id,owner_id,idempotency_key::text,commit_id,workflow_path,blob_id,source_sha256,schema_sha256,submitted_sha256,effective_sha256,payload_bytes,payload_sha256,encrypted_content,content_binding,credential_key_id FROM golf_workflow_dispatch_inputs WHERE run_id=$1`, r.ID).Scan(&i.RunID, &i.ForgeURL, &i.UserID, &i.NativeActorID, &i.RepositoryID, &i.OwnerID, &i.IdempotencyKey, &i.CommitID, &i.WorkflowPath, &i.BlobID, &i.SourceSHA256, &i.SchemaSHA256, &i.SubmittedSHA256, &i.EffectiveSHA256, &c.PlainBytes, &c.PlainSHA256, &c.EncryptedContent, &c.Binding, &c.KeyID)
	if err != nil {
		return workflowDispatchInputValues{}, errStorageUnavailable
	}
	return openWorkflowDispatchInputContent(s.keyring, workflowDispatchInputRunIdentity(r, native), c)
}

func (s *Server) verifyWorkflowTypedReplay(ctx context.Context, tx *sql.Tx, r workflowRunRecord, native int64, m *golfv1.DispatchWorkflowRequest) error {
	retained, err := s.loadWorkflowDispatchTypedValues(ctx, tx, r, native)
	if err != nil {
		return err
	}
	// Types come from the authenticated original; no mutable source fetch or
	// caller-provided digest substitutes for exact canonical submitted-map equality.
	schema := workflowDispatchInputSchema{Definitions: []workflowDispatchInputDefinition{}}
	for _, v := range retained.Effective {
		def := workflowDispatchInputDefinition{Name: v.Name, Type: v.Type, Default: &v}
		if v.Type == workflowDispatchChoice {
			def.Options = []string{v.String}
		}
		schema.Definitions = append(schema.Definitions, def)
	}
	schema.SHA256 = workflowDispatchDigest("golf.workflow.dispatch.schema.v1", schema.Definitions)
	candidate, err := workflowDispatchWireValues(schema, m.Inputs)
	if err != nil || candidate.SubmittedSHA256 != retained.SubmittedSHA256 || candidate.EffectiveSHA256 != retained.EffectiveSHA256 {
		return errWorkflowRunConflict
	}
	a, _ := json.Marshal(candidate.Submitted)
	b, _ := json.Marshal(retained.Submitted)
	if !bytes.Equal(a, b) {
		return errWorkflowRunConflict
	}
	return nil
}

func (s *Server) storeWorkflowDispatchTyped(ctx context.Context, tx *sql.Tx, r workflowRunRecord, native int64, typed *workflowDispatchTyped) error {
	row, err := sealWorkflowDispatchInputContent(s.keyring, workflowDispatchInputRunIdentity(r, native), typed.Schema, typed.Values)
	if err != nil {
		return err
	}
	i := row.Identity
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_workflow_dispatch_inputs(run_id,contract_version,forge_url,user_id,native_actor_id,repository_id,owner_id,idempotency_key,commit_id,workflow_path,blob_id,source_sha256,schema_sha256,submitted_sha256,effective_sha256,payload_bytes,payload_sha256,encrypted_content,content_binding,credential_key_id) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, i.RunID, i.ForgeURL, i.UserID, i.NativeActorID, i.RepositoryID, i.OwnerID, i.IdempotencyKey, i.CommitID, i.WorkflowPath, i.BlobID, i.SourceSHA256, i.SchemaSHA256, i.SubmittedSHA256, i.EffectiveSHA256, row.PlainBytes, row.PlainSHA256, row.EncryptedContent, row.Binding, row.KeyID)
	if err != nil {
		return errStorageUnavailable
	}
	return nil
}
