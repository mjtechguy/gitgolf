-- name: EnsureOrganizationCreationPolicy :exec
INSERT INTO golf_organization_creation_policies(forge_url,mode)VALUES($1,'administrators_only') ON CONFLICT DO NOTHING;
-- name: LockOrganizationCreationPolicy :one
SELECT * FROM golf_organization_creation_policies WHERE forge_url=$1 FOR UPDATE;
-- name: UpdateOrganizationCreationPolicy :one
UPDATE golf_organization_creation_policies SET mode=$2,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE forge_url=$1 AND revision=$3 RETURNING *;
-- name: ListOrganizationCreationSelections :many
SELECT user_id FROM golf_organization_creation_selections WHERE forge_url=$1 ORDER BY user_id;
-- name: DeleteOrganizationCreationSelections :exec
DELETE FROM golf_organization_creation_selections WHERE forge_url=$1;
-- name: AddOrganizationCreationSelection :exec
INSERT INTO golf_organization_creation_selections(forge_url,user_id)VALUES($1,$2);
-- name: GetOrganizationCreationCandidate :one
SELECT id FROM golf_users WHERE id=$1 AND forge_url=$2;
-- name: GetOrganizationCreationActor :one
SELECT id FROM golf_users WHERE forge_user_id=$1 AND forge_url=$2;
-- name: AppendOrganizationCreationPolicyEvent :exec
INSERT INTO golf_organization_creation_policy_events(forge_url,revision,revocation_epoch,actor_user_id,actor_session_id,mode,selected_user_count)VALUES($1,$2,$3,$4,$5,$6,$7);
