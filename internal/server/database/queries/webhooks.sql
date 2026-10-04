-- name: LockWebhookConfiguration :exec
SELECT pg_advisory_xact_lock(hashtextextended('golf-webhooks:configuration',0));
-- name: CountWebhookSubscriptions :one
SELECT count(*) AS instance_count,count(*) FILTER(WHERE forge_url=$1 AND repository_id=$2) AS repository_count FROM golf_webhook_subscriptions;
-- name: GetWebhookLocalAuthority :one
SELECT a.id,a.credential_version,u.forge_user_id FROM golf_local_accounts a JOIN golf_users u ON u.id=a.user_id JOIN golf_sessions s ON s.user_id=u.id AND s.local_account_id=a.id
WHERE s.token_hash=$1 AND u.forge_url=$2 AND s.expires_at>clock_timestamp() AND a.disabled_at IS NULL AND s.local_credential_version=a.credential_version FOR SHARE OF a;
-- name: LockWebhookSubscription :one
SELECT * FROM golf_webhook_subscriptions WHERE id=$1 AND forge_url=$2 AND repository_id=$3 FOR UPDATE;
-- name: ListWebhookSubscriptions :many
SELECT * FROM golf_webhook_subscriptions WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 ORDER BY created_at,id LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);
-- name: GetWebhookCredential :one
SELECT * FROM golf_webhook_credentials WHERE subscription_id=$1 AND version=$2;
-- name: CreateWebhookSubscription :exec
INSERT INTO golf_webhook_subscriptions(id,forge_url,repository_id,owner_id,repository_owner,repository_name,name,version,event_topics,enabled,authorization_state,sponsor_user_id,sponsor_native_id,local_account_id,credential_version)
VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,false,'disabled',$9,$10,$11,$12);
-- name: UpdateWebhookSubscription :execrows
UPDATE golf_webhook_subscriptions SET repository_owner=$2,repository_name=$3,name=$4,version=$5,epoch=epoch+1,event_topics=$6,enabled=$7,authorization_state=$8,sponsor_user_id=$9,sponsor_native_id=$10,local_account_id=$11,credential_version=$12,updated_at=clock_timestamp()
WHERE id=$1 AND version=sqlc.arg(expected_version);
-- name: CreateWebhookCredential :exec
INSERT INTO golf_webhook_credentials(subscription_id,version,destination_host,encrypted_credential,credential_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6);
-- name: CancelPreviousWebhookDeliveries :exec
UPDATE golf_webhook_deliveries SET state='cancelled',failure_code='configuration_changed',completed_at=clock_timestamp() WHERE subscription_id=$1 AND state IN ('queued','retrying');
-- name: GetWebhookDelivery :one
SELECT * FROM golf_webhook_deliveries WHERE id=$1;
-- name: ListWebhookDeliveries :many
SELECT * FROM golf_webhook_deliveries WHERE subscription_id=$1 ORDER BY created_at DESC,id DESC LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);
-- name: CreateExplicitWebhookDelivery :exec
INSERT INTO golf_webhook_deliveries(id,subscription_id,subscription_version,epoch,event_id,event_topic,payload,operation_id,operation_fingerprint,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);

-- name: GetExplicitWebhookOperation :one
SELECT * FROM golf_webhook_deliveries WHERE requested_by=$1 AND operation_id=$2;

-- name: RecordWebhookConfiguration :exec
INSERT INTO golf_webhook_configuration_events(subscription_id,version,sponsor_user_id,enabled,event_topics) VALUES($1,$2,$3,$4,$5);

-- name: LockWebhookQueue :exec
SELECT pg_advisory_xact_lock(hashtextextended('golf-webhook-queue:'||sqlc.arg(subscription_id)::uuid::text,0));
