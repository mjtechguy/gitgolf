-- name: ReservePullReviewMutation :one
INSERT INTO golf_pull_review_mutations(user_id,actor_forge_user_id,idempotency_key,payload_fingerprint,body_fingerprint,repository_id,repository_owner,repository_name,pull_request_id,number,expected_revision,base_commit_id,head_commit_id,review_state)
SELECT u.id,u.forge_user_id,sqlc.arg(idempotency_key),sqlc.arg(payload_fingerprint),sqlc.arg(body_fingerprint),sqlc.arg(repository_id),sqlc.arg(repository_owner),sqlc.arg(repository_name),sqlc.arg(pull_request_id),sqlc.arg(number),sqlc.arg(expected_revision),sqlc.arg(base_commit_id),sqlc.arg(head_commit_id),sqlc.arg(review_state)
FROM golf_users u WHERE u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url)
ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING *;
-- name: GetPullReviewMutation :one
SELECT m.* FROM golf_pull_review_mutations m JOIN golf_users u ON u.id=m.user_id
WHERE u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url) AND m.idempotency_key=sqlc.arg(idempotency_key);
-- name: RecordPullReviewReceipt :one
UPDATE golf_pull_review_mutations m SET observed_review_id=sqlc.arg(observed_review_id),updated_at=clock_timestamp()
FROM golf_users u WHERE m.user_id=u.id AND u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url) AND m.id=sqlc.arg(mutation_id) AND m.state='OUTCOME_UNKNOWN' AND m.observed_review_id=0 RETURNING m.*;
-- name: CompletePullReviewMutation :one
UPDATE golf_pull_review_mutations m SET state=sqlc.arg(state),failure_code=sqlc.arg(failure_code),updated_at=clock_timestamp()
FROM golf_users u WHERE m.user_id=u.id AND u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url) AND m.id=sqlc.arg(mutation_id) AND m.state='OUTCOME_UNKNOWN' RETURNING m.*;
-- name: AppendPullReviewMutationEvent :exec
INSERT INTO golf_pull_review_mutation_events(mutation_id,phase,state,observed_review_id,failure_code) VALUES($1,$2,$3,$4,$5);
