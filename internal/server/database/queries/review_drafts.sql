-- name: EnsureReviewDraftTarget :exec
INSERT INTO golf_review_draft_targets(user_id,forge_url,repository_id,pull_request_id,pull_number)
VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING;

-- name: GetReviewDraftTarget :one
SELECT generation,pull_number FROM golf_review_draft_targets
WHERE user_id=$1 AND forge_url=$2 AND repository_id=$3 AND pull_request_id=$4 FOR UPDATE;

-- name: AdvanceReviewDraftTarget :exec
UPDATE golf_review_draft_targets SET generation=generation+1
WHERE user_id=$1 AND forge_url=$2 AND repository_id=$3 AND pull_request_id=$4;

-- name: GetReviewDraft :one
SELECT * FROM golf_review_drafts WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND repository_id=$4 AND pull_request_id=$5;

-- name: GetActiveReviewDraft :one
SELECT * FROM golf_review_drafts WHERE user_id=$1 AND forge_url=$2 AND repository_id=$3 AND pull_request_id=$4 AND NOT deleted;

-- name: InsertReviewDraft :exec
INSERT INTO golf_review_drafts(id,user_id,forge_url,repository_id,pull_request_id,pull_number,comparison_id)
VALUES($1,$2,$3,$4,$5,$6,$7);

-- name: AdvanceReviewDraft :exec
UPDATE golf_review_drafts SET current_version=current_version+1,deleted=$2,updated_at=clock_timestamp() WHERE id=$1;

-- name: InsertReviewContent :exec
INSERT INTO golf_review_contents(id,user_id,forge_url,repository_id,pull_request_id,draft_id,version,kind,encrypted_content,content_binding,credential_key_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);

-- name: GetReviewContent :one
SELECT * FROM golf_review_contents WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND repository_id=$4 AND pull_request_id=$5 AND draft_id=$6;

-- name: InsertReviewDraftVersion :exec
INSERT INTO golf_review_draft_versions(draft_id,user_id,forge_url,repository_id,pull_request_id,version,operation_id,kind,expected_version,expected_generation,accepted_generation,content_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12);

-- name: GetReviewDraftOperation :one
SELECT * FROM golf_review_draft_versions WHERE user_id=$1 AND operation_id=$2;

-- name: GetReviewDraftVersion :one
SELECT * FROM golf_review_draft_versions WHERE draft_id=$1 AND version=$2 AND user_id=$3;

-- name: ReviewContentQuota :one
SELECT count(*)::bigint AS records,coalesce(sum(octet_length(encrypted_content)),0)::bigint AS bytes FROM golf_review_contents WHERE user_id=$1;

-- name: LockRotationReviewContents :many
SELECT id,encrypted_content,content_binding,credential_key_id FROM golf_review_contents
WHERE credential_key_id <> sqlc.arg(active_key_id) ORDER BY id LIMIT sqlc.arg(row_limit) FOR UPDATE SKIP LOCKED;

-- name: UpdateKeyedReviewContent :exec
UPDATE golf_review_contents SET encrypted_content=$2,credential_key_id=$3 WHERE id=$1;

-- name: BootstrapLegacyReviewContents :many
SELECT id::text,encrypted_content,content_binding FROM golf_review_contents
WHERE credential_key_id='legacy' AND id::text>sqlc.arg(after_id)::text ORDER BY id LIMIT 500;

-- name: GetReviewDraftActor :one
SELECT forge_user_id FROM golf_users WHERE id=$1 AND forge_url=$2;

-- name: LockReviewContentQuota :exec
SELECT pg_advisory_xact_lock(74191526730203036);

-- name: ReviewContentInstanceQuota :one
SELECT count(*)::bigint AS records,coalesce(sum(octet_length(encrypted_content)),0)::bigint AS bytes FROM golf_review_contents;
