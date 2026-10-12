-- Grant revisions include deletions and external operator changes, preventing ABA edits.
CREATE TABLE IF NOT EXISTS repository_access_versions (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS collaborator_versions (
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repository_id,user_id)
);
CREATE TABLE IF NOT EXISTS repository_access_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_key TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_key)
);
CREATE TRIGGER IF NOT EXISTS grants_insert_revision AFTER INSERT ON grants BEGIN
  INSERT INTO repository_access_versions VALUES(NEW.repository_id,1)
    ON CONFLICT(repository_id) DO UPDATE SET version=version+1;
  INSERT INTO collaborator_versions VALUES(NEW.repository_id,NEW.user_id,1)
    ON CONFLICT(repository_id,user_id) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER IF NOT EXISTS grants_update_revision AFTER UPDATE OF role ON grants BEGIN
  INSERT INTO repository_access_versions VALUES(NEW.repository_id,1)
    ON CONFLICT(repository_id) DO UPDATE SET version=version+1;
  INSERT INTO collaborator_versions VALUES(NEW.repository_id,NEW.user_id,1)
    ON CONFLICT(repository_id,user_id) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER IF NOT EXISTS grants_delete_revision AFTER DELETE ON grants BEGIN
  INSERT INTO repository_access_versions VALUES(OLD.repository_id,1)
    ON CONFLICT(repository_id) DO UPDATE SET version=version+1;
  INSERT INTO collaborator_versions VALUES(OLD.repository_id,OLD.user_id,1)
    ON CONFLICT(repository_id,user_id) DO UPDATE SET generation=generation+1;
END;
