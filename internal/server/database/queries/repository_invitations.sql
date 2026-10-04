-- name: GetRepositoryInvitation :one
SELECT * FROM golf_repository_invitations WHERE id=$1 AND forge_url=$2;
-- name: LockRepositoryInvitation :one
SELECT * FROM golf_repository_invitations WHERE id=$1 AND forge_url=$2 FOR UPDATE;
-- name: LockInvitationUsers :many
SELECT id,forge_user_id FROM golf_users WHERE forge_url=$1 AND (id=$2 OR id=$3) ORDER BY id FOR UPDATE;
-- name: GetInvitationIssuerAccount :one
SELECT * FROM golf_local_accounts WHERE id=$1 AND user_id=$2;
-- name: LockInvitationIssuerAccount :one
SELECT * FROM golf_local_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE;
-- name: ListRepositoryInvitationIDs :many
SELECT id FROM golf_repository_invitations WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5;
-- name: ListOwnRepositoryInvitationIDs :many
SELECT id FROM golf_repository_invitations WHERE forge_url=$1 AND recipient_native_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4;
