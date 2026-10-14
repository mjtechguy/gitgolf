-- Model selection per AI use case (schema 33). Installation choices live in installation_settings under ai.model.<use>;
-- with no rows the deploy list (AI_MODELS) applies, so this migration changes nothing.
-- The account's Workers AI catalog, cached for six hours. A model that disappears or passes its deprecation date is marked retired.
CREATE TABLE IF NOT EXISTS ai_model_catalog (
  model TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  properties TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_model_catalog_reads (
  task TEXT PRIMARY KEY,
  attempted_at TEXT NOT NULL,
  read_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
  models INTEGER,
  reason TEXT
);
-- A repository's own model where the installation lets repositories choose; '' follows the installation default.
CREATE TABLE IF NOT EXISTS repository_ai_models (
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  use TEXT NOT NULL,
  model TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repository_id, use)
);
