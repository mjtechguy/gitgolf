-- name: CreateNotificationContent :exec
INSERT INTO golf_notification_contents(id,kind,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5);
-- name: GetNotificationContent :one
SELECT * FROM golf_notification_contents WHERE id=$1;
-- name: LockRotationNotificationContents :many
SELECT id::text,kind,encrypted_content,content_binding,credential_key_id FROM golf_notification_contents
WHERE credential_key_id<>sqlc.arg(active_key_id) ORDER BY id LIMIT sqlc.arg(row_limit) FOR UPDATE SKIP LOCKED;
-- name: UpdateKeyedNotificationContent :exec
UPDATE golf_notification_contents SET encrypted_content=$2,credential_key_id=$3 WHERE id=$1;
-- name: BootstrapLegacyNotificationContents :many
SELECT id::text,kind,encrypted_content,content_binding FROM golf_notification_contents WHERE credential_key_id='legacy' AND id::text>sqlc.arg(after_id)::text ORDER BY id::text LIMIT 500;
