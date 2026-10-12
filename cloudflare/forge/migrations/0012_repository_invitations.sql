CREATE TABLE IF NOT EXISTS native_identity_versions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id), version INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS native_identity_revision AFTER UPDATE OF active,email,login ON users BEGIN
  INSERT INTO native_identity_versions VALUES(NEW.id,1)
    ON CONFLICT(user_id) DO UPDATE SET version=version+1;
END;
CREATE TABLE IF NOT EXISTS repository_invitations (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  artifact_name TEXT NOT NULL,
  issuer_id INTEGER NOT NULL REFERENCES users(id),
  issuer_version INTEGER NOT NULL,
  issuer_generation INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  recipient_version INTEGER NOT NULL,
  recipient_generation INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read','write','admin')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','ACCEPTED','REJECTED','REVOKED','EXPIRED')),
  operation_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  UNIQUE(issuer_id,operation_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_invitation_pending ON repository_invitations(repository_id,recipient_id) WHERE state='PENDING';
CREATE INDEX IF NOT EXISTS repository_invitation_inbox ON repository_invitations(recipient_id,created_at,id);
CREATE INDEX IF NOT EXISTS repository_invitation_inventory ON repository_invitations(repository_id,created_at,id);
CREATE TABLE IF NOT EXISTS repository_invitation_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_key TEXT NOT NULL,
  invitation_id TEXT NOT NULL REFERENCES repository_invitations(id),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_key)
);
