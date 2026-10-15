-- Credential vault and engines (docs/CREDENTIAL_VAULT.md, docs/ENGINES.md, docs/AGENTS_AND_AUTOMATIONS_PLAN.md phase 2a).
-- vault_credentials holds API keys and subscription sign-ins (token files) at user, organization or installation scope. sealed_value is an
-- envelope: the value is encrypted with its own random AES-GCM data key, and that data key is encrypted with the installation key that
-- execution values use (EXECUTION_VALUE_KEY, Secrets Store); key_id names that installation key. No plaintext is stored and no API returns
-- it. fingerprint is at most the last 4 characters of an API key. Revoking destroys the envelope (sealed_value NULL) and keeps the metadata.
-- version advances on every rotation. One active label per owner. Replay-safe.
CREATE TABLE IF NOT EXISTS vault_credentials (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('user','organization','installation')),
 owner_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('api-key','subscription')),
 provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','xai','google')),
 tool TEXT NOT NULL DEFAULT '' CHECK(tool IN ('','codex','claude','opencode','grok','agy','muse')),
 label TEXT NOT NULL,
 sealed_value TEXT,
 key_id TEXT NOT NULL DEFAULT '',
 fingerprint TEXT NOT NULL DEFAULT '',
 value_bytes INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 rotated_at TEXT,
 revoked_at TEXT,
 last_used_at TEXT,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS vault_credentials_owner ON vault_credentials(scope,owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS vault_credentials_label ON vault_credentials(scope,owner_id,label) WHERE revoked_at IS NULL;

-- Who besides the owner may use a credential, chosen explicitly by its owner (or the organization owners and operations administrators
-- for their scopes): one person (user, grantee_id the user id), the members of an organization within its repositories (organization, the
-- owner id), one repository (repository, the repository id) or every active account (installation, grantee_id ''). engines limits the grant
-- to those engine ids ([] = every engine that uses the credential); places lists where it may be used: cloud, agent-host, ssh-host.
CREATE TABLE IF NOT EXISTS vault_credential_grants (
 id TEXT PRIMARY KEY,
 credential_id TEXT NOT NULL REFERENCES vault_credentials(id),
 grantee_kind TEXT NOT NULL CHECK(grantee_kind IN ('user','organization','repository','installation')),
 grantee_id TEXT NOT NULL,
 engines TEXT NOT NULL DEFAULT '[]',
 places TEXT NOT NULL DEFAULT '["cloud","agent-host","ssh-host"]',
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(credential_id,grantee_kind,grantee_id)
);

-- Engines: what does the thinking. cloudflare-model (a Workers AI model inside the deploy list, no credential), provider-model (OpenAI,
-- Anthropic, xAI or Google through the private AI Gateway with a vault API key) or coding-cli (a CLI tool and the credential it uses; it runs
-- on agent hosts, SSH hosts or later cloud sandboxes). places is a JSON list of cloud, agent-host and ssh-host. The built-in Workers AI
-- engines are not rows. Replay-safe.
CREATE TABLE IF NOT EXISTS engines (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('user','organization','installation')),
 owner_id TEXT NOT NULL,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('cloudflare-model','provider-model','coding-cli')),
 provider TEXT NOT NULL DEFAULT '',
 model TEXT NOT NULL DEFAULT '',
 tool TEXT NOT NULL DEFAULT '',
 credential_id TEXT REFERENCES vault_credentials(id),
 places TEXT NOT NULL DEFAULT '["cloud"]',
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_by INTEGER NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS engines_owner ON engines(scope,owner_id);

-- Engine selection per AI use case, replacing per-use-case model selection: installation, then organization, then repository. engine_id ''
-- follows the level above (at installation: the Workers AI model chosen in AI models, so nothing changes until an engine is chosen).
-- allow_override says whether the levels below may choose. Replay-safe.
CREATE TABLE IF NOT EXISTS engine_selections (
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization','repository')),
 scope_id TEXT NOT NULL,
 use_case TEXT NOT NULL,
 engine_id TEXT NOT NULL DEFAULT '',
 allow_override INTEGER NOT NULL DEFAULT 0 CHECK(allow_override IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1,
 updated_by INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(scope,scope_id,use_case)
);

-- The engine an AI run was admitted with, when it is not the default Workers AI model: re-checked before inference. The credential is
-- recorded by id and label, never by value. Replay-safe.
CREATE TABLE IF NOT EXISTS ai_run_engines (
 run_id TEXT PRIMARY KEY REFERENCES ai_runs(id),
 engine_id TEXT NOT NULL,
 engine_version INTEGER NOT NULL,
 credential_id TEXT,
 credential_label TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
