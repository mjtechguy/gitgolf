-- Caller holds its managed account/session locks for reservation only.
-- name: ReserveIssueMutation :one
INSERT INTO golf_issue_mutations (user_id,actor_forge_user_id,idempotency_key,payload_fingerprint,kind,repository_id,repository_owner,repository_name,issue_id,issue_number,state,pull_request)
SELECT u.id,u.forge_user_id,sqlc.arg(idempotency_key),sqlc.arg(payload_fingerprint),sqlc.arg(kind),sqlc.arg(repository_id),sqlc.arg(repository_owner),sqlc.arg(repository_name),sqlc.arg(issue_id),sqlc.arg(issue_number),'OUTCOME_UNKNOWN',sqlc.arg(pull_request)
FROM golf_users u WHERE u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url)
ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING *;

-- name: GetIssueMutation :one
SELECT m.* FROM golf_issue_mutations m JOIN golf_users u ON u.id=m.user_id
WHERE u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url) AND m.idempotency_key=sqlc.arg(idempotency_key);

-- Evidence must remain writable after the caller is revoked/disconnected. No
-- active-session condition and no provider retry belong in completion.
-- name: CompleteIssueMutation :one
UPDATE golf_issue_mutations m SET state=sqlc.arg(state),failure_code=sqlc.arg(failure_code),
    issue_id=sqlc.arg(issue_id),issue_number=sqlc.arg(issue_number),comment_id=sqlc.arg(comment_id),updated_at=clock_timestamp()
FROM golf_users u WHERE m.user_id=u.id AND u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url)
    AND m.id=sqlc.arg(mutation_id) AND m.state='OUTCOME_UNKNOWN'
RETURNING m.*;

-- Once-only provisional receipt, still UNKNOWN until verified postflight.
-- name: RecordIssueMutationReceipt :one
UPDATE golf_issue_mutations m SET observed_result_id=sqlc.arg(observed_result_id),
    observed_number=sqlc.arg(observed_number),updated_at=clock_timestamp()
FROM golf_users u WHERE m.user_id=u.id AND u.id=sqlc.arg(user_id) AND u.forge_url=sqlc.arg(forge_url)
    AND m.id=sqlc.arg(mutation_id) AND m.state='OUTCOME_UNKNOWN' AND m.observed_result_id=0
RETURNING m.*;

-- name: AppendIssueMutationEvent :exec
INSERT INTO golf_issue_mutation_events(mutation_id,state,phase,observed_result_id,observed_number) VALUES($1,$2,$3,$4,$5);
