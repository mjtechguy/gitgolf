package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/mjtechguy/golf-git/internal/runner"
)

func organizationExecutionBinding(id string, version int64, forge string, org int64, name, kind string, size int, selected []organizationExecutionSelection, approver, native int64, session []byte, expires time.Time) []byte {
	data, _ := json.Marshal([]any{organizationExecutionValueDomain, id, version, forge, org, name, kind, size, selected, approver, native, session, expires.UTC().Format(time.RFC3339Nano)})
	h := sha256.Sum256(data)
	return h[:]
}

// Shared by exact-version reads and the second packet's startup/rotation scans.
// Organization ciphertext never uses repository AAD or a fabricated repository ID.
func openOrganizationExecutionContent(keys *Keyring, forge string, org, version int64, r organizationExecutionRecord) (string, error) {
	binding := organizationExecutionBinding(r.id, version, forge, org, r.name, r.kind, r.size, r.selected, r.approver, r.native, r.session, r.expires)
	if !bytes.Equal(r.binding, binding) {
		return "", errCredentialUnavailable
	}
	plain, e := keys.open(r.key, organizationExecutionValueDomain, r.cipher, r.binding)
	if e != nil || len(plain) != r.size || !runner.ExecutionValueName(r.name) || !runner.ExecutionValueBody(plain, r.kind == "secret") {
		return "", errCredentialUnavailable
	}
	return plain, nil
}

func organizationExecutionContentRows(ctx context.Context, tx *sql.Tx, key, after string, version int64, limit int, rotation bool) ([]organizationExecutionEncryptedContent, error) {
	query := `SELECT v.forge_url,v.organization_id,v.id::text,v.name,v.kind,h.version,v.deleted,h.value_bytes,v.created_at,v.updated_at,h.selected_repositories,h.expires_at,h.approver_user_id,h.approver_native_id,h.approval_session_hash,h.encrypted_content,h.content_binding,h.credential_key_id FROM golf_organization_execution_versions h JOIN golf_organization_execution_values v ON v.id=h.id WHERE `
	if rotation {
		query += `h.credential_key_id<>$1 ORDER BY h.id,h.version LIMIT $2 FOR UPDATE OF h SKIP LOCKED`
	} else {
		query += `h.credential_key_id=$1 AND (h.id::text>$2 OR (h.id::text=$2 AND h.version>$3)) ORDER BY h.id,h.version LIMIT $4`
	}
	var rows *sql.Rows
	var e error
	if rotation {
		rows, e = tx.QueryContext(ctx, query, key, limit)
	} else {
		rows, e = tx.QueryContext(ctx, query, key, after, version, limit)
	}
	if e != nil {
		return nil, keyOperationError(ctx)
	}
	defer rows.Close()
	out := []organizationExecutionEncryptedContent{}
	for rows.Next() {
		var r organizationExecutionEncryptedContent
		v := &r.record
		var selected []byte
		e = rows.Scan(&r.forge, &r.organization, &v.id, &v.name, &v.kind, &v.version, &v.deleted, &v.size, &v.created, &v.updated, &selected, &v.expires, &v.approver, &v.native, &v.session, &v.cipher, &v.binding, &v.key)
		if e != nil || json.Unmarshal(selected, &v.selected) != nil {
			return nil, keyOperationError(ctx)
		}
		out = append(out, r)
	}
	if rows.Err() != nil {
		return nil, keyOperationError(ctx)
	}
	return out, nil
}

type organizationExecutionEncryptedContent struct {
	forge        string
	organization int64
	record       organizationExecutionRecord
}

func bootstrapOrganizationExecutionContents(ctx context.Context, tx *sql.Tx, keys *Keyring) error {
	after := ""
	version := int64(0)
	for {
		rows, e := organizationExecutionContentRows(ctx, tx, "legacy", after, version, 500, false)
		if e != nil {
			return e
		}
		for _, r := range rows {
			if _, e = openOrganizationExecutionContent(keys, r.forge, r.organization, r.record.version, r.record); e != nil {
				return errKeyBootstrap
			}
			after = r.record.id
			version = r.record.version
		}
		if len(rows) < 500 {
			return nil
		}
	}
}
func rotateOrganizationExecutionContents(ctx context.Context, tx *sql.Tx, keys *Keyring, limit int) (uint64, error) {
	if limit <= 0 {
		return 0, nil
	}
	rows, e := organizationExecutionContentRows(ctx, tx, keys.active, "", 0, limit, true)
	if e != nil {
		return 0, e
	}
	for _, r := range rows {
		plain, e := openOrganizationExecutionContent(keys, r.forge, r.organization, r.record.version, r.record)
		if e != nil {
			return 0, e
		}
		cipher, key, e := keys.seal(organizationExecutionValueDomain, plain, r.record.binding)
		if e != nil {
			return 0, e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_organization_execution_versions SET encrypted_content=$3,credential_key_id=$4 WHERE id=$1 AND version=$2`, r.record.id, r.record.version, cipher, key); e != nil {
			return 0, keyOperationError(ctx)
		}
	}
	return uint64(len(rows)), nil
}
