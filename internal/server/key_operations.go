package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"github.com/google/uuid"
	"sort"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errKeyPolicy = errors.New("Encryption configuration does not match the database policy or stored key labels.")
var errKeyMaterial = errors.New("Encryption key material does not match its registered label.")
var errKeyBootstrap = errors.New("Legacy encryption validation failed; preserve all keys and credentials and resolve configuration before retrying.")
var errKeyRetirement = errors.New("Key retirement requires a configured inactive key with zero stored session, OAuth-attempt, local-account, infrastructure-profile and automation-credential and private-review-content uses.")

// Safe operator output contains labels and counts, never fingerprints, binding
// hashes, ciphertext, credentials, key material or database connection strings.
type CredentialKeyUsage struct {
	KeyID                     string `json:"key_id"`
	Sessions                  uint64 `json:"sessions"`
	OAuthAttempts             uint64 `json:"oauth_attempts"`
	LocalAccounts             uint64 `json:"local_accounts"`
	InfrastructureConnections uint64 `json:"infrastructure_connections"`
	AutomationCredentials     uint64 `json:"automation_credentials"`
	ReviewContents            uint64 `json:"review_contents"`
	Configured                bool   `json:"configured"`
}
type CredentialKeyStatus struct {
	ActiveKeyID           string               `json:"active_key_id"`
	ConfiguredActiveKeyID string               `json:"configured_active_key_id"`
	Keys                  []CredentialKeyUsage `json:"keys"`
}
type CredentialKeyOperation struct {
	OperationID                      string              `json:"operation_id"`
	Action                           string              `json:"action"`
	Batches                          uint32              `json:"batches"`
	RotatedSessions                  uint64              `json:"rotated_sessions"`
	RotatedOAuthAttempts             uint64              `json:"rotated_oauth_attempts"`
	RotatedLocalAccounts             uint64              `json:"rotated_local_accounts"`
	RotatedInfrastructureConnections uint64              `json:"rotated_infrastructure_connections"`
	RotatedAutomationCredentials     uint64              `json:"rotated_automation_credentials"`
	RotatedReviewContents            uint64              `json:"rotated_review_contents"`
	Complete                         bool                `json:"complete"`
	Status                           CredentialKeyStatus `json:"status"`
}

func keyStatus(ctx context.Context, q *database.Queries, keys *Keyring) (CredentialKeyStatus, error) {
	if keys == nil {
		return CredentialKeyStatus{}, errKeyConfiguration
	}
	active, err := q.GetEncryptionPolicy(ctx)
	if err != nil {
		return CredentialKeyStatus{}, keyOperationError(ctx)
	}
	counts, err := q.CountCredentialKeys(ctx)
	if err != nil {
		return CredentialKeyStatus{}, keyOperationError(ctx)
	}
	byID := map[string]CredentialKeyUsage{}
	for id := range keys.keys {
		byID[id] = CredentialKeyUsage{KeyID: id, Configured: true}
	}
	for _, row := range counts {
		byID[row.CredentialKeyID] = CredentialKeyUsage{KeyID: row.CredentialKeyID, Sessions: uint64(row.Sessions), OAuthAttempts: uint64(row.OauthAttempts), LocalAccounts: uint64(row.LocalAccounts), InfrastructureConnections: uint64(row.InfrastructureConnections), AutomationCredentials: uint64(row.AutomationCredentials), ReviewContents: uint64(row.ReviewContents), Configured: keys.keys[row.CredentialKeyID] != nil}
	}
	if _, exists := byID[active]; !exists {
		byID[active] = CredentialKeyUsage{KeyID: active, Configured: keys.keys[active] != nil}
	}
	result := CredentialKeyStatus{ActiveKeyID: active, ConfiguredActiveKeyID: keys.active, Keys: []CredentialKeyUsage{}}
	for _, usage := range byID {
		result.Keys = append(result.Keys, usage)
	}
	sort.Slice(result.Keys, func(i, j int) bool { return result.Keys[i].KeyID < result.Keys[j].KeyID })
	return result, nil
}

func keyOperationError(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return errStorageUnavailable
}

func verifyFingerprints(ctx context.Context, q *database.Queries, keys *Keyring) error {
	for id, fingerprint := range keys.fingerprints {
		stored, err := q.GetKeyFingerprint(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			continue // Standby keys are bound only when explicitly activated.
		}
		if err != nil {
			return keyOperationError(ctx)
		}
		if !bytes.Equal(stored, fingerprint[:]) {
			return errKeyMaterial
		}
	}
	return nil
}

// ensureLegacyBinding is the one-time upgrade bootstrap. Holding the policy
// exclusively fences ciphertext writes while every existing legacy row is
// authenticated in bounded pages. No ciphertext is rewritten or deleted.
func ensureLegacyBinding(ctx context.Context, db *sql.DB, keys *Keyring) error {
	if db == nil || keys == nil {
		return errKeyConfiguration
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return keyOperationError(ctx)
	}
	defer tx.Rollback()
	q := database.New(db).WithTx(tx)
	if err := q.LockEncryptionOperator(ctx); err != nil {
		return keyOperationError(ctx)
	}
	_, err = q.LockEncryptionPolicy(ctx)
	if err != nil {
		return keyOperationError(ctx)
	}
	if err := verifyFingerprints(ctx, q, keys); err != nil {
		return err
	}
	_, err = q.GetKeyFingerprint(ctx, "legacy")
	if err == nil {
		return txCommitKey(ctx, tx)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return keyOperationError(ctx)
	}
	if keys.keys["legacy"] == nil {
		counts, err := q.CountCredentialKeys(ctx)
		if err != nil {
			return keyOperationError(ctx)
		}
		for _, row := range counts {
			if row.CredentialKeyID == "legacy" && row.Sessions+row.OauthAttempts+row.LocalAccounts+row.InfrastructureConnections+row.AutomationCredentials+row.ReviewContents != 0 {
				return errKeyPolicy
			}
		}
		// A fresh full-keyring deployment has no legacy material to register.
		return txCommitKey(ctx, tx)
	}
	after := int64(0)
	for {
		rows, err := q.BootstrapLegacySessions(ctx, after)
		if err != nil {
			return keyOperationError(ctx)
		}
		for _, row := range rows {
			if _, err := keys.open("legacy", sessionDomain, row.EncryptedToken, row.TokenHash); err != nil {
				return errKeyBootstrap
			}
			after = row.SessionID
		}
		if len(rows) < 500 {
			break
		}
	}
	cursor := []byte{}
	for {
		rows, err := q.BootstrapLegacyOAuthAttempts(ctx, cursor)
		if err != nil {
			return keyOperationError(ctx)
		}
		for _, row := range rows {
			if _, err := keys.open("legacy", oauthAttemptDomain, row.EncryptedVerifier, row.StateHash); err != nil {
				return errKeyBootstrap
			}
			cursor = row.StateHash
		}
		if len(rows) < 500 {
			break
		}
	}
	after = 0
	for {
		rows, err := q.BootstrapLegacyLocalAccounts(ctx, after)
		if err != nil {
			return keyOperationError(ctx)
		}
		for _, row := range rows {
			if _, err := keys.open("legacy", localAccountDomain, row.EncryptedForgeToken, row.CredentialBinding); err != nil {
				return errKeyBootstrap
			}
			after = row.ID
		}
		if len(rows) < 500 {
			break
		}
	}
	profileCursor, versionCursor := "", int64(0)
	for {
		rows, err := q.BootstrapLegacyInfrastructureConnections(ctx, database.BootstrapLegacyInfrastructureConnectionsParams{AfterProfile: profileCursor, AfterVersion: versionCursor})
		if err != nil {
			return keyOperationError(ctx)
		}
		for _, row := range rows {
			if _, err := keys.open("legacy", infrastructureConnectionDomain, row.EncryptedCredential, row.CredentialBinding); err != nil {
				return errKeyBootstrap
			}
			profileCursor, versionCursor = row.ProfileID, row.Version
		}
		if len(rows) < 500 {
			break
		}
	}
	// Codex native auth blobs share the infrastructure codec and usage counter,
	// but their distinct personal-connection bindings are authenticated independently.
	codeCursor := ""
	for {
		rowsCodex, err := tx.QueryContext(ctx, `SELECT connection_id::text,encrypted_credential,credential_binding FROM golf_codex_auth WHERE credential_key_id='legacy' AND connection_id::text>$1 ORDER BY connection_id LIMIT 500`, codeCursor)
		if err != nil {
			return keyOperationError(ctx)
		}
		count := 0
		for rowsCodex.Next() {
			var id string
			var encrypted, binding []byte
			if err := rowsCodex.Scan(&id, &encrypted, &binding); err != nil {
				rowsCodex.Close()
				return keyOperationError(ctx)
			}
			if _, err := keys.open("legacy", infrastructureConnectionDomain, encrypted, binding); err != nil {
				rowsCodex.Close()
				return errKeyBootstrap
			}
			codeCursor = id
			count++
		}
		err = rowsCodex.Err()
		rowsCodex.Close()
		if err != nil {
			return keyOperationError(ctx)
		}
		if count < 500 {
			break
		}
	}

	automationCursor := ""
	for {
		rows, err := q.BootstrapLegacyAutomationCredentials(ctx, automationCursor)
		if err != nil {
			return keyOperationError(ctx)
		}
		for _, row := range rows {
			if _, err := keys.open("legacy", automationRepositoryDomain, row.EncryptedCredential, row.CredentialBinding); err != nil {
				return errKeyBootstrap
			}
			automationCursor = row.GrantID
		}
		if len(rows) < 500 {
			break
		}
	}
	reviewCursor := ""
	for {
		rows, err := q.BootstrapLegacyReviewContents(ctx, reviewCursor)
		if err != nil {
			return keyOperationError(ctx)
		}
		for _, row := range rows {
			if _, err := keys.open("legacy", reviewContentDomain, row.EncryptedContent, row.ContentBinding); err != nil {
				return errKeyBootstrap
			}
			reviewCursor = row.ID
		}
		if len(rows) < 500 {
			break
		}
	}
	fingerprint := keys.fingerprints["legacy"]
	if err := q.RegisterKeyFingerprint(ctx, database.RegisterKeyFingerprintParams{KeyID: "legacy", Fingerprint: fingerprint[:]}); err != nil {
		return keyOperationError(ctx)
	}
	return txCommitKey(ctx, tx)
}

func txCommitKey(ctx context.Context, tx *sql.Tx) error {
	if err := tx.Commit(); err != nil {
		return keyOperationError(ctx)
	}
	return nil
}

// KeyStatus includes expired rows and configured keys with zero uses. The first
// upgraded invocation can authenticate/register the legacy label, but never
// changes active policy or ciphertext. Errors are safe to show to an operator.
func KeyStatus(ctx context.Context, db *sql.DB, keys *Keyring) (CredentialKeyStatus, error) {
	if err := ensureLegacyBinding(ctx, db, keys); err != nil {
		return CredentialKeyStatus{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return CredentialKeyStatus{}, keyOperationError(ctx)
	}
	defer tx.Rollback()
	q := database.New(db).WithTx(tx)
	if _, err := q.ShareEncryptionPolicy(ctx); err != nil {
		return CredentialKeyStatus{}, keyOperationError(ctx)
	}
	if err := verifyFingerprints(ctx, q, keys); err != nil {
		return CredentialKeyStatus{}, err
	}
	status, err := keyStatus(ctx, q, keys)
	if err != nil {
		return CredentialKeyStatus{}, err
	}
	if err := txCommitKey(ctx, tx); err != nil {
		return CredentialKeyStatus{}, err
	}
	return status, nil
}

func requiredKeys(status CredentialKeyStatus, matchActive bool) error {
	if matchActive && status.ActiveKeyID != status.ConfiguredActiveKeyID {
		return errKeyPolicy
	}
	for _, usage := range status.Keys {
		if !usage.Configured && (usage.Sessions != 0 || usage.OAuthAttempts != 0 || usage.LocalAccounts != 0 || usage.InfrastructureConnections != 0 || usage.AutomationCredentials != 0 || usage.ReviewContents != 0 || (matchActive && usage.KeyID == status.ActiveKeyID)) {
			return errKeyPolicy
		}
	}
	return nil
}

func checkRuntimeKeys(ctx context.Context, db *sql.DB, keys *Keyring) error {
	status, err := KeyStatus(ctx, db, keys)
	if err != nil {
		return err
	}
	if err := requiredKeys(status, true); err != nil {
		return err
	}
	// A nonlegacy stored label without its permanent binding cannot be trusted.
	q := database.New(db)
	for _, usage := range status.Keys {
		if usage.Sessions == 0 && usage.OAuthAttempts == 0 && usage.LocalAccounts == 0 && usage.InfrastructureConnections == 0 && usage.AutomationCredentials == 0 && usage.ReviewContents == 0 && usage.KeyID != status.ActiveKeyID {
			continue
		}
		if _, err := q.GetKeyFingerprint(ctx, usage.KeyID); err != nil {
			return errKeyPolicy
		}
	}
	return nil
}

func beginKeyOperation(ctx context.Context, db *sql.DB, keys *Keyring, action string) (CredentialKeyOperation, error) {
	opID, err := newAuditOperation()
	result := CredentialKeyOperation{OperationID: opID, Action: action}
	if err != nil {
		return result, err
	}
	result.Status, err = KeyStatus(ctx, db, keys)
	return result, err
}

func appendCrypto(ctx context.Context, q *database.Queries, operation, action, keyID string, sessions, attempts, locals, infrastructure, automation uint64, review ...uint64) error {
	var reviewCount uint64
	if len(review) > 0 {
		reviewCount = review[0]
	}
	if err := q.AppendCryptoEvent(ctx, database.AppendCryptoEventParams{OperationID: operation, Action: action, KeyID: keyID, SessionsCount: int64(sessions), OauthAttemptsCount: int64(attempts), LocalAccountsCount: int64(locals), InfrastructureConnectionsCount: int64(infrastructure), AutomationCredentialsCount: int64(automation), ReviewContentsCount: int64(reviewCount)}); err != nil {
		return keyOperationError(ctx)
	}
	return nil
}

// ActivateKey requires operators to drain ALL old writers first, including
// requests exchanging OAuth tokens externally. A database write fence cannot
// undo a provider's token rotation. This API does not claim a rolling activation.
func ActivateKey(ctx context.Context, db *sql.DB, keys *Keyring) (CredentialKeyOperation, error) {
	result, err := beginKeyOperation(ctx, db, keys, "ACTIVE_KEY_CHANGED")
	if err != nil {
		return result, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return result, keyOperationError(ctx)
	}
	defer tx.Rollback()
	q := database.New(db).WithTx(tx)
	if err := q.LockEncryptionOperator(ctx); err != nil {
		return result, keyOperationError(ctx)
	}
	if _, err := q.LockEncryptionPolicy(ctx); err != nil {
		return result, keyOperationError(ctx)
	}
	if err := verifyFingerprints(ctx, q, keys); err != nil {
		return result, err
	}
	status, err := keyStatus(ctx, q, keys)
	if err != nil {
		return result, err
	}
	if err := requiredKeys(status, false); err != nil {
		return result, err
	}
	stored, err := q.GetKeyFingerprint(ctx, keys.active)
	if errors.Is(err, sql.ErrNoRows) {
		fingerprint := keys.fingerprints[keys.active]
		if err := q.RegisterKeyFingerprint(ctx, database.RegisterKeyFingerprintParams{KeyID: keys.active, Fingerprint: fingerprint[:]}); err != nil {
			return result, keyOperationError(ctx)
		}
	} else if err != nil {
		return result, keyOperationError(ctx)
	} else {
		fingerprint := keys.fingerprints[keys.active]
		if !bytes.Equal(stored, fingerprint[:]) {
			return result, errKeyMaterial
		}
	}
	if status.ActiveKeyID == keys.active {
		if err := txCommitKey(ctx, tx); err != nil {
			return result, err
		}
		result.Status, result.Complete = status, true
		return result, nil // Already active; no invented change event.
	}
	if err := q.SetEncryptionPolicy(ctx, keys.active); err != nil {
		return result, keyOperationError(ctx)
	}
	var sessions, attempts, locals, infrastructure, automation, review uint64
	for _, usage := range status.Keys {
		sessions += usage.Sessions
		attempts += usage.OAuthAttempts
		locals += usage.LocalAccounts
		infrastructure += usage.InfrastructureConnections
		automation += usage.AutomationCredentials
		review += usage.ReviewContents
	}
	if err := appendCrypto(ctx, q, result.OperationID, result.Action, keys.active, sessions, attempts, locals, infrastructure, automation, review); err != nil {
		return result, err
	}
	status.ActiveKeyID = keys.active
	if err := txCommitKey(ctx, tx); err != nil {
		return result, err
	}
	result.Status, result.Complete = status, true
	return result, nil
}

func remainingCredentials(status CredentialKeyStatus) uint64 {
	var remaining uint64
	for _, usage := range status.Keys {
		if usage.KeyID != status.ActiveKeyID {
			remaining += usage.Sessions + usage.OAuthAttempts + usage.LocalAccounts + usage.InfrastructureConnections + usage.AutomationCredentials + usage.ReviewContents
		}
	}
	return remaining
}

// RotateCredentials commits at most maxBatches of batchSize total records. Each
// batch locks/skips busy rows, rewrites all credential families and appends its
// operator event atomically. Returned counters cover committed batches only.
func RotateCredentials(ctx context.Context, db *sql.DB, keys *Keyring, batchSize, maxBatches int) (CredentialKeyOperation, error) {
	result := CredentialKeyOperation{Action: "CREDENTIAL_BATCH_REENCRYPTED"}
	if batchSize < 1 || batchSize > 1000 || maxBatches < 1 || maxBatches > 100 {
		return result, errors.New("Rotation requires batch size 1–1000 and batch count 1–100.")
	}
	var err error
	result, err = beginKeyOperation(ctx, db, keys, result.Action)
	if err != nil {
		return result, err
	}
	for range maxBatches {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if err := requiredKeys(result.Status, true); err != nil {
			return result, err
		}
		if remainingCredentials(result.Status) == 0 {
			result.Complete = true
			return result, nil
		}
		sessions, attempts, locals, infrastructure, automation, review, status, err := rotateCredentialBatch(ctx, db, keys, result.OperationID, batchSize)
		if err != nil {
			return result, err
		}
		result.Status = status
		result.RotatedSessions += sessions
		result.RotatedOAuthAttempts += attempts
		result.RotatedLocalAccounts += locals
		result.RotatedInfrastructureConnections += infrastructure
		result.RotatedAutomationCredentials += automation
		result.RotatedReviewContents += review
		if sessions+attempts+locals+infrastructure+automation+review > 0 {
			result.Batches++
		}
		if remainingCredentials(status) == 0 {
			result.Complete = true
			return result, nil
		}
		if sessions+attempts+locals+infrastructure+automation+review == 0 {
			return result, nil
		} // Busy rows remain; resume later.
	}
	return result, nil
}

func rotateCredentialBatch(ctx context.Context, db *sql.DB, keys *Keyring, operation string, batchSize int) (uint64, uint64, uint64, uint64, uint64, uint64, CredentialKeyStatus, error) {
	fail := func(err error) (uint64, uint64, uint64, uint64, uint64, uint64, CredentialKeyStatus, error) {
		return 0, 0, 0, 0, 0, 0, CredentialKeyStatus{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	defer tx.Rollback()
	q := database.New(db).WithTx(tx)
	if err := q.LockEncryptionOperator(ctx); err != nil {
		return fail(keyOperationError(ctx))
	}
	active, err := q.ShareEncryptionPolicy(ctx)
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	if active != keys.active {
		return fail(errKeyPolicy)
	}
	if err := verifyFingerprints(ctx, q, keys); err != nil {
		return fail(err)
	}
	sessions, err := q.LockRotationSessions(ctx, database.LockRotationSessionsParams{ActiveKeyID: active, RowLimit: int32(batchSize)})
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	attempts, err := q.LockRotationOAuthAttempts(ctx, database.LockRotationOAuthAttemptsParams{ActiveKeyID: active, RowLimit: int32(batchSize - len(sessions))})
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	locals, err := q.LockRotationLocalAccounts(ctx, database.LockRotationLocalAccountsParams{ActiveKeyID: active, RowLimit: int32(batchSize - len(sessions) - len(attempts))})
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	infrastructure, err := q.LockRotationInfrastructureConnections(ctx, database.LockRotationInfrastructureConnectionsParams{ActiveKeyID: active, RowLimit: int32(batchSize - len(sessions) - len(attempts) - len(locals))})
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	codexCount, err := rotateCodexAuth(ctx, tx, keys, batchSize-len(sessions)-len(attempts)-len(locals)-len(infrastructure))
	if err != nil {
		return fail(err)
	}
	automation, err := q.LockRotationAutomationCredentials(ctx, database.LockRotationAutomationCredentialsParams{ActiveKeyID: active, RowLimit: int32(batchSize - len(sessions) - len(attempts) - len(locals) - len(infrastructure) - codexCount)})
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	review, err := q.LockRotationReviewContents(ctx, database.LockRotationReviewContentsParams{ActiveKeyID: active, RowLimit: int32(batchSize - len(sessions) - len(attempts) - len(locals) - len(infrastructure) - codexCount - len(automation))})
	if err != nil {
		return fail(keyOperationError(ctx))
	}
	for _, row := range review {
		plain, err := keys.open(row.CredentialKeyID, reviewContentDomain, row.EncryptedContent, row.ContentBinding)
		if err != nil {
			return fail(err)
		}
		encrypted, key, err := keys.seal(reviewContentDomain, plain, row.ContentBinding)
		if err != nil {
			return fail(err)
		}
		if err := q.UpdateKeyedReviewContent(ctx, database.UpdateKeyedReviewContentParams{ID: row.ID, EncryptedContent: encrypted, CredentialKeyID: key}); err != nil {
			return fail(keyOperationError(ctx))
		}
	}
	for _, row := range sessions {
		plain, err := keys.open(row.CredentialKeyID, sessionDomain, row.EncryptedToken, row.TokenHash)
		if err != nil {
			return fail(err)
		}
		encrypted, keyID, err := keys.seal(sessionDomain, plain, row.TokenHash)
		if err != nil {
			return fail(err)
		}
		if err := q.UpdateKeyedSessionCredential(ctx, database.UpdateKeyedSessionCredentialParams{TokenHash: row.TokenHash, EncryptedToken: encrypted, CredentialKeyID: keyID}); err != nil {
			return fail(keyOperationError(ctx))
		}
	}
	for _, row := range attempts {
		plain, err := keys.open(row.CredentialKeyID, oauthAttemptDomain, row.EncryptedVerifier, row.StateHash)
		if err != nil {
			return fail(err)
		}
		encrypted, keyID, err := keys.seal(oauthAttemptDomain, plain, row.StateHash)
		if err != nil {
			return fail(err)
		}
		if err := q.UpdateKeyedOAuthAttempt(ctx, database.UpdateKeyedOAuthAttemptParams{StateHash: row.StateHash, EncryptedVerifier: encrypted, CredentialKeyID: keyID}); err != nil {
			return fail(keyOperationError(ctx))
		}
	}
	for _, row := range locals {
		plain, err := keys.open(row.CredentialKeyID, localAccountDomain, row.EncryptedForgeToken, row.CredentialBinding)
		if err != nil {
			return fail(err)
		}
		encrypted, keyID, err := keys.seal(localAccountDomain, plain, row.CredentialBinding)
		if err != nil {
			return fail(err)
		}
		if err := q.UpdateKeyedLocalAccount(ctx, database.UpdateKeyedLocalAccountParams{ID: row.ID, EncryptedForgeToken: encrypted, CredentialKeyID: keyID}); err != nil {
			return fail(keyOperationError(ctx))
		}
	}
	for _, row := range infrastructure {
		plain, err := keys.open(row.CredentialKeyID, infrastructureConnectionDomain, row.EncryptedCredential, row.CredentialBinding)
		if err != nil {
			return fail(err)
		}
		encrypted, keyID, err := keys.seal(infrastructureConnectionDomain, plain, row.CredentialBinding)
		if err != nil {
			return fail(err)
		}
		if err = q.UpdateKeyedInfrastructureConnection(ctx, database.UpdateKeyedInfrastructureConnectionParams{ProfileID: uuid.MustParse(row.ProfileID), Version: row.Version, EncryptedCredential: encrypted, CredentialKeyID: keyID}); err != nil {
			return fail(keyOperationError(ctx))
		}
	}
	for _, row := range automation {
		plain, err := keys.open(row.CredentialKeyID, automationRepositoryDomain, row.EncryptedCredential, row.CredentialBinding)
		if err != nil {
			return fail(err)
		}
		encrypted, keyID, err := keys.seal(automationRepositoryDomain, plain, row.CredentialBinding)
		if err != nil {
			return fail(err)
		}
		if err = q.UpdateKeyedAutomationCredential(ctx, database.UpdateKeyedAutomationCredentialParams{GrantID: uuid.MustParse(row.GrantID), Version: row.Version, EncryptedCredential: encrypted, CredentialKeyID: keyID}); err != nil {
			return fail(keyOperationError(ctx))
		}
	}
	sc, ac, lc, ic, gc, rc := uint64(len(sessions)), uint64(len(attempts)), uint64(len(locals)), uint64(len(infrastructure)+codexCount), uint64(len(automation)), uint64(len(review))
	if sc+ac+lc+ic+gc+rc > 0 {
		if err := appendCrypto(ctx, q, operation, "CREDENTIAL_BATCH_REENCRYPTED", active, sc, ac, lc, ic, gc, rc); err != nil {
			return fail(err)
		}
	}
	status, err := keyStatus(ctx, q, keys)
	if err != nil {
		return fail(err)
	}
	if err := txCommitKey(ctx, tx); err != nil {
		return fail(err)
	}
	return sc, ac, lc, ic, gc, rc, status, nil
}

// CheckKeyRetirement records an eligible zero-use check; it never erases keys.
// The active-policy write fence prevents stale nonactive-ID writes afterward.
func CheckKeyRetirement(ctx context.Context, db *sql.DB, keys *Keyring, keyID string) (CredentialKeyOperation, error) {
	result := CredentialKeyOperation{Action: "RETIREMENT_CHECKED"}
	if !ValidKeyID(keyID) || keys == nil || keys.keys[keyID] == nil {
		return result, errKeyRetirement
	}
	var err error
	result, err = beginKeyOperation(ctx, db, keys, result.Action)
	if err != nil {
		return result, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return result, keyOperationError(ctx)
	}
	defer tx.Rollback()
	q := database.New(db).WithTx(tx)
	if err := q.LockEncryptionOperator(ctx); err != nil {
		return result, keyOperationError(ctx)
	}
	if _, err := q.ShareEncryptionPolicy(ctx); err != nil {
		return result, keyOperationError(ctx)
	}
	if err := verifyFingerprints(ctx, q, keys); err != nil {
		return result, err
	}
	status, err := keyStatus(ctx, q, keys)
	if err != nil {
		return result, err
	}
	if err := requiredKeys(status, true); err != nil {
		return result, err
	}
	if keyID == status.ActiveKeyID {
		return result, errKeyRetirement
	}
	if _, err := q.GetKeyFingerprint(ctx, keyID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return result, errKeyRetirement
		}
		return result, keyOperationError(ctx)
	}
	for _, usage := range status.Keys {
		if usage.KeyID == keyID && usage.Sessions+usage.OAuthAttempts+usage.LocalAccounts+usage.InfrastructureConnections+usage.AutomationCredentials+usage.ReviewContents != 0 {
			return result, errKeyRetirement
		}
	}
	if err := appendCrypto(ctx, q, result.OperationID, result.Action, keyID, 0, 0, 0, 0, 0); err != nil {
		return result, err
	}
	if err := txCommitKey(ctx, tx); err != nil {
		return result, err
	}
	result.Status, result.Complete = status, true
	return result, nil
}
