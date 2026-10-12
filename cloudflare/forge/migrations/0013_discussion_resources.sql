CREATE TABLE IF NOT EXISTS discussion_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK(kind IN ('label','milestone')),
  name TEXT NOT NULL COLLATE NOCASE,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS discussion_resource_name ON discussion_resources(repository_id,kind,name) WHERE deleted=0;
CREATE INDEX IF NOT EXISTS discussion_resource_inventory ON discussion_resources(repository_id,kind,deleted,id);
CREATE TABLE IF NOT EXISTS discussion_resource_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_key TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_key)
);
CREATE TABLE IF NOT EXISTS discussion_labels (
  discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  label_id INTEGER NOT NULL REFERENCES discussion_resources(id),
  PRIMARY KEY(discussion_id,label_id)
);
CREATE INDEX IF NOT EXISTS discussion_label_members ON discussion_labels(label_id,discussion_id);
CREATE TABLE IF NOT EXISTS discussion_assignees (
  discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY(discussion_id,user_id)
);
CREATE INDEX IF NOT EXISTS discussion_assignee_members ON discussion_assignees(user_id,discussion_id);
CREATE TABLE IF NOT EXISTS discussion_milestones (
  discussion_id INTEGER PRIMARY KEY REFERENCES discussions(id),
  milestone_id INTEGER NOT NULL REFERENCES discussion_resources(id)
);
CREATE INDEX IF NOT EXISTS discussion_milestone_members ON discussion_milestones(milestone_id,discussion_id);
CREATE TRIGGER IF NOT EXISTS discussion_resource_revision AFTER UPDATE ON discussion_resources BEGIN
  UPDATE discussions SET revision=revision+1 WHERE id IN (
    SELECT discussion_id FROM discussion_labels WHERE label_id=NEW.id
    UNION SELECT discussion_id FROM discussion_milestones WHERE milestone_id=NEW.id
  );
  DELETE FROM discussion_labels WHERE label_id=NEW.id AND NEW.deleted=1;
  DELETE FROM discussion_milestones WHERE milestone_id=NEW.id AND NEW.deleted=1;
END;
