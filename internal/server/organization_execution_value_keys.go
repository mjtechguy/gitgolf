package server

import (
	"bytes"
	"crypto/sha256"
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
