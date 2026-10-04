-- name: LockRepositoryRuleMutations :exec
SELECT golf_rule_mutation_lock(sqlc.arg(forge_url)::text,sqlc.arg(repository_id)::bigint);
-- name: ReserveRepositoryRuleMutation :one
INSERT INTO golf_repository_rule_mutations(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,action,expected_access_revision,expected_rules_revision,input_fingerprint)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(user_id,operation_id) DO NOTHING RETURNING *;
-- name: GetOwnRepositoryRuleMutation :one
SELECT * FROM golf_repository_rule_mutations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3;
-- name: AdvanceRepositoryRuleMutation :one
UPDATE golf_repository_rule_mutations SET phase=$4,failure_code=$5,observed_rules_revision=$6,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND forge_url=$3 RETURNING *;
