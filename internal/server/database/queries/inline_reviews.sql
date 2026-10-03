-- name: GetInlineReviewMutation :one
SELECT * FROM golf_inline_review_mutations WHERE user_id=$1 AND operation_id=$2;

-- name: ReserveInlineReviewMutation :one
INSERT INTO golf_inline_review_mutations(operation_id,user_id,forge_url,actor_id,repository_id,pull_request_id,pull_number,repository_owner,repository_name,draft_id,draft_version,target_generation,comparison_id,request_fingerprint,payload_fingerprint,expected_revision,base_tip,merge_base,head_commit,diff_sha256,decision,entry_count)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
ON CONFLICT(user_id,operation_id) DO NOTHING RETURNING *;

-- name: AdvanceInlineReviewMutation :one
UPDATE golf_inline_review_mutations SET phase=$3,observed_review_id=$4,verified_comment_ids=$5,failure_code=$6,updated_at=clock_timestamp() WHERE user_id=$1 AND operation_id=$2 RETURNING *;

-- name: AppendInlineReviewEvent :exec
INSERT INTO golf_inline_review_events(user_id,operation_id,phase,observed_review_id,failure_code) VALUES($1,$2,$3,$4,$5);

-- name: InlineReviewQuota :one
SELECT count(*) FILTER (WHERE user_id=$1)::bigint AS owner_records,count(*)::bigint AS instance_records FROM golf_inline_review_mutations;
