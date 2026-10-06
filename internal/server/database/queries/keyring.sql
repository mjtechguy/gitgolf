-- name: CreateKeyedSession :one
INSERT INTO golf_sessions (token_hash, user_id, encrypted_token, expires_at, credential_kind, credential_key_id)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING session_id;

-- name: CreateKeyedOAuthAttempt :exec
INSERT INTO golf_oauth_attempts (state_hash, binding_hash, encrypted_verifier, expires_at, credential_key_id)
VALUES ($1, $2, $3, $4, $5);

-- name: LockOAuthAttempt :one
SELECT encrypted_verifier, credential_key_id, expires_at
FROM golf_oauth_attempts
WHERE state_hash = $1 AND binding_hash = $2 AND expires_at > clock_timestamp()
FOR UPDATE;

-- name: DeleteOAuthAttempt :execrows
DELETE FROM golf_oauth_attempts
WHERE state_hash = $1 AND binding_hash = $2 AND expires_at > clock_timestamp();

-- name: UpdateKeyedSessionCredential :exec
UPDATE golf_sessions SET encrypted_token = $2, credential_key_id = $3 WHERE token_hash = $1;

-- name: GetEncryptionPolicy :one
SELECT active_key_id FROM golf_encryption_policy WHERE singleton;

-- name: LockEncryptionPolicy :one
SELECT active_key_id FROM golf_encryption_policy WHERE singleton FOR UPDATE;

-- name: ShareEncryptionPolicy :one
SELECT active_key_id FROM golf_encryption_policy WHERE singleton FOR SHARE;

-- name: SetEncryptionPolicy :exec
UPDATE golf_encryption_policy SET active_key_id = $1 WHERE singleton;

-- Serialize operators per transaction, not an entire unbounded rotate command.
-- name: LockEncryptionOperator :exec
SELECT pg_advisory_xact_lock(74191526730202002);

-- name: CountCredentialKeys :many
SELECT credential_key_id,sum(sessions)::bigint AS sessions,sum(oauth_attempts)::bigint AS oauth_attempts,sum(local_accounts)::bigint AS local_accounts,sum(infrastructure_connections)::bigint AS infrastructure_connections,sum(automation_credentials)::bigint AS automation_credentials,sum(review_contents)::bigint AS review_contents,sum(conversation_contents)::bigint AS conversation_contents,sum(webhook_credentials)::bigint AS webhook_credentials,sum(notification_contents)::bigint AS notification_contents,sum(execution_values)::bigint AS execution_values,sum(quarantined_outputs)::bigint AS quarantined_outputs,sum(organization_execution_values)::bigint AS organization_execution_values,sum(workflow_dispatch_inputs)::bigint AS workflow_dispatch_inputs
FROM (
 SELECT credential_key_id,count(*) AS sessions,0::bigint AS oauth_attempts,0::bigint AS local_accounts,0::bigint AS infrastructure_connections,0::bigint AS automation_credentials,0::bigint AS review_contents,0::bigint AS conversation_contents,0::bigint AS webhook_credentials,0::bigint AS notification_contents,0::bigint AS execution_values,0::bigint AS quarantined_outputs,0::bigint AS organization_execution_values,0::bigint AS workflow_dispatch_inputs FROM golf_sessions GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_oauth_attempts GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_local_accounts GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_infrastructure_connection_versions GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_automation_credentials GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_review_contents GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_agent_conversation_contents GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_webhook_credentials GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_notification_contents GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*),0::bigint ,0::bigint,0::bigint FROM golf_execution_value_versions GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*) ,0::bigint,0::bigint FROM golf_workflow_quarantined_outputs GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_codex_auth GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*),0::bigint FROM golf_organization_execution_versions GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,count(*) FROM golf_workflow_dispatch_inputs GROUP BY credential_key_id
 UNION ALL SELECT credential_key_id,0::bigint,0::bigint,0::bigint,count(*),0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint,0::bigint ,0::bigint,0::bigint FROM golf_provider_connections GROUP BY credential_key_id
) counts GROUP BY credential_key_id ORDER BY credential_key_id;


-- name: LockRotationSessions :many
SELECT token_hash, encrypted_token, credential_key_id
FROM golf_sessions
WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY session_id LIMIT sqlc.arg(row_limit)
FOR UPDATE SKIP LOCKED;

-- name: LockRotationOAuthAttempts :many
SELECT state_hash, encrypted_verifier, credential_key_id
FROM golf_oauth_attempts
WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY state_hash LIMIT sqlc.arg(row_limit)
FOR UPDATE SKIP LOCKED;

-- name: UpdateKeyedOAuthAttempt :exec
UPDATE golf_oauth_attempts SET encrypted_verifier = $2, credential_key_id = $3 WHERE state_hash = $1;

-- name: AppendCryptoEvent :exec
INSERT INTO golf_crypto_events (operation_id, action, key_id, sessions_count, oauth_attempts_count, local_accounts_count,infrastructure_connections_count,automation_credentials_count,review_contents_count,conversation_contents_count,webhook_credentials_count,notification_contents_count,execution_values_count,quarantined_outputs_count,organization_execution_values_count,workflow_dispatch_inputs_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);

-- name: GetKeyFingerprint :one
SELECT fingerprint FROM golf_encryption_keys WHERE key_id = $1;

-- The operator lock serializes registration with activation/bootstrap.
-- name: RegisterKeyFingerprint :exec
INSERT INTO golf_encryption_keys (key_id, fingerprint) VALUES ($1, $2);

-- name: BootstrapLegacySessions :many
SELECT session_id, token_hash, encrypted_token
FROM golf_sessions
WHERE credential_key_id = 'legacy' AND session_id > sqlc.arg(after_id)
ORDER BY session_id LIMIT 500;

-- name: BootstrapLegacyOAuthAttempts :many
SELECT state_hash, encrypted_verifier
FROM golf_oauth_attempts
WHERE credential_key_id = 'legacy' AND state_hash > sqlc.arg(after_hash)::bytea
ORDER BY state_hash LIMIT 500;

-- name: LockRotationInfrastructureConnections :many
SELECT profile_id::text,version,encrypted_credential,credential_binding,credential_key_id
FROM golf_infrastructure_connection_versions
WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY profile_id,version LIMIT sqlc.arg(row_limit)
FOR UPDATE SKIP LOCKED;

-- name: UpdateKeyedInfrastructureConnection :exec
UPDATE golf_infrastructure_connection_versions SET encrypted_credential=sqlc.arg(encrypted_credential),credential_key_id=sqlc.arg(credential_key_id) WHERE profile_id=sqlc.arg(profile_id)::uuid AND version=sqlc.arg(version);

-- name: BootstrapLegacyInfrastructureConnections :many
SELECT profile_id::text,version,encrypted_credential,credential_binding
FROM golf_infrastructure_connection_versions
WHERE credential_key_id='legacy' AND (profile_id::text>sqlc.arg(after_profile)::text OR (profile_id::text=sqlc.arg(after_profile)::text AND version>sqlc.arg(after_version)))
ORDER BY profile_id,version LIMIT 500;

-- name: LockRotationAutomationCredentials :many
SELECT grant_id::text,version,encrypted_credential,credential_binding,credential_key_id
FROM golf_automation_credentials
WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY grant_id LIMIT sqlc.arg(row_limit)
FOR UPDATE SKIP LOCKED;

-- name: UpdateKeyedAutomationCredential :exec
UPDATE golf_automation_credentials SET encrypted_credential=sqlc.arg(encrypted_credential),credential_key_id=sqlc.arg(credential_key_id)
WHERE grant_id=sqlc.arg(grant_id)::uuid AND version=sqlc.arg(version);

-- name: BootstrapLegacyAutomationCredentials :many
SELECT grant_id::text,encrypted_credential,credential_binding
FROM golf_automation_credentials
WHERE credential_key_id='legacy' AND grant_id::text>sqlc.arg(after_grant)::text
ORDER BY grant_id LIMIT 500;

-- name: LockRotationConversationContents :many
SELECT id::text,encrypted_content,content_binding,credential_key_id FROM golf_agent_conversation_contents
WHERE credential_key_id<>sqlc.arg(active_key_id) ORDER BY id LIMIT sqlc.arg(row_limit) FOR UPDATE SKIP LOCKED;
-- name: UpdateKeyedConversationContent :exec
UPDATE golf_agent_conversation_contents SET encrypted_content=$2,credential_key_id=$3 WHERE id=$1;
-- name: BootstrapLegacyConversationContents :many
SELECT id::text,encrypted_content,content_binding FROM golf_agent_conversation_contents
WHERE credential_key_id='legacy' AND id::text>sqlc.arg(after_id)::text ORDER BY id LIMIT 500;

-- name: LockRotationWebhookCredentials :many
SELECT subscription_id::text,version,encrypted_credential,credential_binding,credential_key_id
FROM golf_webhook_credentials WHERE credential_key_id <> sqlc.arg(active_key_id)
ORDER BY subscription_id,version LIMIT sqlc.arg(row_limit) FOR UPDATE SKIP LOCKED;

-- name: UpdateKeyedWebhookCredential :exec
UPDATE golf_webhook_credentials SET encrypted_credential=sqlc.arg(encrypted_credential),credential_key_id=sqlc.arg(credential_key_id)
WHERE subscription_id=sqlc.arg(subscription_id)::uuid AND version=sqlc.arg(version);

-- name: BootstrapLegacyWebhookCredentials :many
SELECT subscription_id::text,version,encrypted_credential,credential_binding FROM golf_webhook_credentials
WHERE credential_key_id='legacy' AND (subscription_id::text>sqlc.arg(after_subscription)::text OR (subscription_id::text=sqlc.arg(after_subscription)::text AND version>sqlc.arg(after_version)))
ORDER BY subscription_id,version LIMIT 500;
