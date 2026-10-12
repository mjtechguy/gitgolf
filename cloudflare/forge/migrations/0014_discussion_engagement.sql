-- Reactions and inbox activity are native D1 records; no external email is sent.
CREATE TABLE IF NOT EXISTS discussion_engagement_versions (
  discussion_id INTEGER NOT NULL REFERENCES discussions(id), comment_id INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(discussion_id,comment_id)
);
CREATE TABLE IF NOT EXISTS discussion_reactions (
  discussion_id INTEGER NOT NULL REFERENCES discussions(id), comment_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL CHECK(content IN ('+1','-1','laugh','hooray','confused','heart','rocket','eyes')),
  PRIMARY KEY(discussion_id,comment_id,user_id,content)
);
CREATE TABLE IF NOT EXISTS discussion_subscriptions (
  discussion_id INTEGER NOT NULL REFERENCES discussions(id), user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY(discussion_id,user_id)
);
CREATE TABLE IF NOT EXISTS discussion_events (
  id TEXT PRIMARY KEY, discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  actor_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discussion_event_inventory ON discussion_events(discussion_id,created_at);
CREATE TABLE IF NOT EXISTS discussion_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  discussion_id INTEGER NOT NULL REFERENCES discussions(id), event_id TEXT NOT NULL REFERENCES discussion_events(id),
  unread INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1)), revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE(user_id,event_id)
);
CREATE INDEX IF NOT EXISTS discussion_notification_inbox ON discussion_notifications(user_id,unread,id);
CREATE TRIGGER IF NOT EXISTS discussion_reaction_added AFTER INSERT ON discussion_reactions BEGIN
  INSERT INTO discussion_engagement_versions VALUES(NEW.discussion_id,NEW.comment_id,1) ON CONFLICT(discussion_id,comment_id) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER IF NOT EXISTS discussion_reaction_removed AFTER DELETE ON discussion_reactions BEGIN
  INSERT INTO discussion_engagement_versions VALUES(OLD.discussion_id,OLD.comment_id,1) ON CONFLICT(discussion_id,comment_id) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER IF NOT EXISTS discussion_subscription_added AFTER INSERT ON discussion_subscriptions BEGIN
  INSERT INTO discussion_engagement_versions VALUES(NEW.discussion_id,0,1) ON CONFLICT(discussion_id,comment_id) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER IF NOT EXISTS discussion_subscription_removed AFTER DELETE ON discussion_subscriptions BEGIN
  INSERT INTO discussion_engagement_versions VALUES(OLD.discussion_id,0,1) ON CONFLICT(discussion_id,comment_id) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER IF NOT EXISTS discussion_comment_engagement_removed AFTER DELETE ON discussion_comments BEGIN
  DELETE FROM discussion_reactions WHERE discussion_id=OLD.discussion_id AND comment_id=OLD.id;
END;
