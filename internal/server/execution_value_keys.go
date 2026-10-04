package server

import (
	"bytes"
	"context"
	"database/sql"

	"github.com/mjtechguy/golf-git/internal/runner"
)

type executionEncryptedContent struct {
	id                                    string
	version, sequence                     int64
	size                                  int
	forge, name, kind, attempt, job, step string
	repo, owner                           int64
	encrypted, binding                    []byte
	key                                   string
}

func executionContentRows(ctx context.Context, tx *sql.Tx, outputs bool, key, after string, offset int64, limit int, rotation bool) ([]executionEncryptedContent, error) {
	var query string
	if outputs {
		query = `SELECT q.run_id::text,0::bigint,q.sequence,q.raw_bytes,q.forge_url,q.repository_id,q.owner_id,'','',q.attempt_id,q.job_instance_id,q.step_id,q.encrypted_content,q.content_binding,q.credential_key_id FROM golf_workflow_quarantined_outputs q WHERE `
		if rotation {
			query += `q.credential_key_id<>$1 ORDER BY q.run_id,q.sequence LIMIT $2 FOR UPDATE OF q SKIP LOCKED`
		} else {
			query += `q.credential_key_id=$1 AND (q.run_id::text>$2 OR (q.run_id::text=$2 AND q.sequence>$3)) ORDER BY q.run_id,q.sequence LIMIT $4`
		}
	} else {
		query = `SELECT q.id::text,q.version,0::bigint,q.value_bytes,v.forge_url,v.repository_id,v.owner_id,v.name,v.kind,'','','',q.encrypted_content,q.content_binding,q.credential_key_id FROM golf_execution_value_versions q JOIN golf_execution_values v ON v.id=q.id WHERE `
		if rotation {
			query += `q.credential_key_id<>$1 ORDER BY q.id,q.version LIMIT $2 FOR UPDATE OF q SKIP LOCKED`
		} else {
			query += `q.credential_key_id=$1 AND (q.id::text>$2 OR (q.id::text=$2 AND q.version>$3)) ORDER BY q.id,q.version LIMIT $4`
		}
	}
	var rows *sql.Rows
	var e error
	if rotation {
		rows, e = tx.QueryContext(ctx, query, key, limit)
	} else {
		rows, e = tx.QueryContext(ctx, query, key, after, offset, limit)
	}
	if e != nil {
		return nil, keyOperationError(ctx)
	}
	defer rows.Close()
	out := []executionEncryptedContent{}
	for rows.Next() {
		var r executionEncryptedContent
		if e = rows.Scan(&r.id, &r.version, &r.sequence, &r.size, &r.forge, &r.repo, &r.owner, &r.name, &r.kind, &r.attempt, &r.job, &r.step, &r.encrypted, &r.binding, &r.key); e != nil {
			return nil, keyOperationError(ctx)
		}
		out = append(out, r)
	}
	if rows.Err() != nil {
		return nil, keyOperationError(ctx)
	}
	return out, nil
}
func openExecutionContent(keys *Keyring, r executionEncryptedContent, outputs bool) (string, error) {
	domain := executionValueDomain
	binding := executionValueBinding(r.id, r.version, r.forge, r.repo, r.owner, r.name, r.kind, r.size)
	if outputs {
		domain = quarantinedOutputDomain
		binding = quarantineBinding(workflowRunRecord{ID: r.id, ForgeURL: r.forge, RepositoryID: r.repo, OwnerID: r.owner}, r.attempt, r.sequence, r.job, r.step, r.size)
	}
	if !bytes.Equal(r.binding, binding) {
		return "", errCredentialUnavailable
	}
	plain, e := keys.open(r.key, domain, r.encrypted, r.binding)
	if e != nil || len(plain) != r.size {
		return "", errCredentialUnavailable
	}
	if outputs {
		if len(plain) > 16<<10 || !runnerLogText(plain) {
			return "", errCredentialUnavailable
		}
	} else {
		if !runner.ExecutionValueName(r.name) || !runner.ExecutionValueBody(plain, r.kind == "secret") {
			return "", errCredentialUnavailable
		}
	}
	return plain, nil
}
func bootstrapExecutionContents(ctx context.Context, tx *sql.Tx, keys *Keyring) error {
	for _, outputs := range []bool{false, true} {
		after := ""
		offset := int64(0)
		for {
			rows, e := executionContentRows(ctx, tx, outputs, "legacy", after, offset, 500, false)
			if e != nil {
				return e
			}
			for _, r := range rows {
				if _, e = openExecutionContent(keys, r, outputs); e != nil {
					return errKeyBootstrap
				}
				after = r.id
				offset = r.version
				if outputs {
					offset = r.sequence
				}
			}
			if len(rows) < 500 {
				break
			}
		}
	}
	return nil
}
func rotateExecutionContents(ctx context.Context, tx *sql.Tx, keys *Keyring, remaining int) (uint64, uint64, error) {
	var counts [2]uint64
	for index, outputs := range []bool{false, true} {
		if remaining == 0 {
			break
		}
		rows, e := executionContentRows(ctx, tx, outputs, keys.active, "", 0, remaining, true)
		if e != nil {
			return 0, 0, e
		}
		for _, r := range rows {
			plain, e := openExecutionContent(keys, r, outputs)
			if e != nil {
				return 0, 0, e
			}
			domain := executionValueDomain
			if outputs {
				domain = quarantinedOutputDomain
			}
			cipher, key, e := keys.seal(domain, plain, r.binding)
			if e != nil {
				return 0, 0, e
			}
			query := `UPDATE golf_execution_value_versions SET encrypted_content=$3,credential_key_id=$4 WHERE id=$1 AND version=$2`
			selector := r.version
			if outputs {
				query = `UPDATE golf_workflow_quarantined_outputs SET encrypted_content=$3,credential_key_id=$4 WHERE run_id=$1 AND sequence=$2`
				selector = r.sequence
			}
			result, e := tx.ExecContext(ctx, query, r.id, selector, cipher, key)
			if e != nil {
				return 0, 0, keyOperationError(ctx)
			}
			n, _ := result.RowsAffected()
			if n != 1 {
				return 0, 0, errCredentialUnavailable
			}
			counts[index]++
		}
		remaining -= len(rows)
	}
	return counts[0], counts[1], nil
}
