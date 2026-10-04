package server

import (
	"context"
	"database/sql"
	"encoding/json"
)

type workflowDispatchInputKeyRow struct {
	content  workflowDispatchInputContent
	expected workflowDispatchInputIdentity
}

// No terminal-state filter: old, failed, cancelled and hidden run inputs retain
// their keys. Independent run/user columns prevent rotation from laundering a
// content row whose source or actor binding no longer matches its immutable run.
func workflowDispatchInputKeyRows(ctx context.Context, tx *sql.Tx, key, after string, limit int, rotation bool) ([]workflowDispatchInputKeyRow, error) {
	query := `SELECT c.run_id::text,c.forge_url,c.user_id,c.native_actor_id,c.repository_id,c.owner_id,c.idempotency_key::text,c.commit_id,c.workflow_path,c.blob_id,c.source_sha256,c.schema_sha256,c.submitted_sha256,c.effective_sha256,c.payload_bytes,c.payload_sha256,c.encrypted_content,c.content_binding,c.credential_key_id,
 r.id::text,r.forge_url,r.user_id,u.forge_user_id,r.repository_id,r.owner_id,r.idempotency_key::text,r.commit_id,r.workflow_path,r.blob_id,r.source_sha256,r.origin,c.contract_version,u.forge_url,r.input_contract,r.engine_catalog,r.input_schema_sha256,r.submitted_inputs_sha256,r.effective_inputs_sha256
 FROM golf_workflow_dispatch_inputs c JOIN golf_workflow_runs r ON r.id=c.run_id JOIN golf_users u ON u.id=c.user_id WHERE `
	if rotation {
		query += `c.credential_key_id<>$1 ORDER BY c.run_id LIMIT $2 FOR UPDATE OF c SKIP LOCKED`
	} else {
		query += `c.credential_key_id=$1 AND c.run_id::text>$2 ORDER BY c.run_id LIMIT $3`
	}
	var rows *sql.Rows
	var err error
	if rotation {
		rows, err = tx.QueryContext(ctx, query, key, limit)
	} else {
		rows, err = tx.QueryContext(ctx, query, key, after, limit)
	}
	if err != nil {
		return nil, keyOperationError(ctx)
	}
	defer rows.Close()
	out := []workflowDispatchInputKeyRow{}
	for rows.Next() {
		var row workflowDispatchInputKeyRow
		c, e := &row.content, &row.expected
		i := &c.Identity
		var origin, userForge, inputContract, catalog string
		var contract int
		if err = rows.Scan(&i.RunID, &i.ForgeURL, &i.UserID, &i.NativeActorID, &i.RepositoryID, &i.OwnerID, &i.IdempotencyKey, &i.CommitID, &i.WorkflowPath, &i.BlobID, &i.SourceSHA256, &i.SchemaSHA256, &i.SubmittedSHA256, &i.EffectiveSHA256, &c.PlainBytes, &c.PlainSHA256, &c.EncryptedContent, &c.Binding, &c.KeyID,
			&e.RunID, &e.ForgeURL, &e.UserID, &e.NativeActorID, &e.RepositoryID, &e.OwnerID, &e.IdempotencyKey, &e.CommitID, &e.WorkflowPath, &e.BlobID, &e.SourceSHA256, &origin, &contract, &userForge, &inputContract, &catalog, &e.SchemaSHA256, &e.SubmittedSHA256, &e.EffectiveSHA256); err != nil {
			return nil, keyOperationError(ctx)
		}
		if origin != "manual" || contract != 1 || userForge != e.ForgeURL || inputContract != workflowManualInputsContract || catalog != workflowTypedEngineCatalog {
			return nil, errCredentialUnavailable
		}
		// Digests come independently from immutable typed-run metadata. Runtime
		// release still rechecks declaration semantics against retained source.
		out = append(out, row)
	}
	if rows.Err() != nil {
		return nil, keyOperationError(ctx)
	}
	return out, nil
}

func bootstrapWorkflowDispatchInputContents(ctx context.Context, tx *sql.Tx, keys *Keyring) error {
	after := ""
	for {
		rows, err := workflowDispatchInputKeyRows(ctx, tx, "legacy", after, 500, false)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if _, err = openWorkflowDispatchInputContent(keys, row.expected, row.content); err != nil {
				return errKeyBootstrap
			}
			after = row.content.Identity.RunID
		}
		if len(rows) < 500 {
			return nil
		}
	}
}

func rotateWorkflowDispatchInputContents(ctx context.Context, tx *sql.Tx, keys *Keyring, limit int) (uint64, error) {
	if limit <= 0 {
		return 0, nil
	}
	rows, err := workflowDispatchInputKeyRows(ctx, tx, keys.active, "", limit, true)
	if err != nil {
		return 0, err
	}
	for _, row := range rows {
		values, err := openWorkflowDispatchInputContent(keys, row.expected, row.content)
		if err != nil {
			return 0, err
		}
		// Open already verified exact canonical encoding/hash; reconstructing this
		// payload changes only ciphertext/key, never defaults, source or intent.
		body, err := json.Marshal(workflowDispatchInputPayload{1, values.Submitted, values.Effective})
		if err != nil {
			return 0, errCredentialUnavailable
		}
		cipher, key, err := keys.seal(workflowDispatchInputDomain, string(body), row.content.Binding)
		if err != nil {
			return 0, err
		}
		result, err := tx.ExecContext(ctx, `UPDATE golf_workflow_dispatch_inputs SET encrypted_content=$2,credential_key_id=$3 WHERE run_id=$1`, row.content.Identity.RunID, cipher, key)
		if err != nil {
			return 0, keyOperationError(ctx)
		}
		n, err := result.RowsAffected()
		if err != nil || n != 1 {
			return 0, keyOperationError(ctx)
		}
	}
	return uint64(len(rows)), nil
}
