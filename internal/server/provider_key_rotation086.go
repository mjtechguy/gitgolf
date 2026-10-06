package server

import (
	"context"
	"database/sql"
)

// Provider credentials share the existing infrastructure domain and usage count,
// but have their own exact binding and bounded native table rotation.
func rotateProviderConnections086(ctx context.Context, tx *sql.Tx, keys *Keyring, limit int) (int, error) {
	if limit < 1 {
		return 0, nil
	}
	rows, e := tx.QueryContext(ctx, `SELECT `+providerConnectionColumns+` FROM golf_provider_connections WHERE credential_key_id<>$1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2`, keys.active, limit)
	if e != nil {
		return 0, errStorageUnavailable
	}
	var found []providerConnectionRecord
	for rows.Next() {
		r, e := scanProviderConnection(rows)
		if e != nil {
			rows.Close()
			return 0, errStorageUnavailable
		}
		found = append(found, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return 0, errStorageUnavailable
	}
	for _, r := range found {
		if _, e := (&Server{keyring: keys}).providerSecret(r); e != nil {
			return 0, e
		}
		plain, e := keys.open(r.KeyID, infrastructureConnectionDomain, r.Cipher, r.Binding)
		if e != nil {
			return 0, e
		}
		cipher, key, e := keys.seal(infrastructureConnectionDomain, plain, r.Binding)
		if e != nil {
			return 0, e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_provider_connections SET encrypted_credential=$1,credential_key_id=$2 WHERE id=$3`, cipher, key, r.ID); e != nil {
			return 0, errStorageUnavailable
		}
	}
	return len(found), nil
}
func validateLegacyProviderConnections086(ctx context.Context, tx *sql.Tx, keys *Keyring) error {
	cursor := ""
	for {
		rows, e := tx.QueryContext(ctx, `SELECT id::text,encrypted_credential,credential_binding FROM golf_provider_connections WHERE credential_key_id='legacy' AND id::text>$1 ORDER BY id LIMIT 500`, cursor)
		if e != nil {
			return errStorageUnavailable
		}
		n := 0
		for rows.Next() {
			var id string
			var cipher, binding []byte
			if e = rows.Scan(&id, &cipher, &binding); e != nil {
				rows.Close()
				return errStorageUnavailable
			}
			if _, e = keys.open("legacy", infrastructureConnectionDomain, cipher, binding); e != nil {
				rows.Close()
				return e
			}
			cursor = id
			n++
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return errStorageUnavailable
		}
		if n < 500 {
			return nil
		}
	}
}
