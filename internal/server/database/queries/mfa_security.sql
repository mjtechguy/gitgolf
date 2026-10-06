-- Local-factor changes revoke managed password and native-token browser sessions
-- for the same immutable Golf user. Provider OAuth/native Git grants are separate.
-- name: DeleteMFABrowserSessions :execrows
DELETE FROM golf_sessions WHERE user_id=$1 AND (local_account_id=$2 OR credential_kind='pat');
