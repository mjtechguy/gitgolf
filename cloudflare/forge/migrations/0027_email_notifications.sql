-- Native repository email: own-address consent, per-repository subscriptions and a transactional outbox.
-- The recipient is always the account's current sign-in address; no address, title, body or source is stored here.
CREATE TABLE IF NOT EXISTS email_preferences (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), email TEXT NOT NULL, identity_version INTEGER NOT NULL,
 suppression TEXT NOT NULL DEFAULT '' CHECK(suppression IN ('','recipient_rejected')), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_subscriptions (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), event_topics TEXT NOT NULL, workflow_notifications INTEGER NOT NULL CHECK(workflow_notifications BETWEEN 1 AND 3),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), identity_version INTEGER NOT NULL, grant_generation INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,repository_id)
);
CREATE INDEX IF NOT EXISTS email_subscription_repository ON email_subscriptions(repository_id,enabled);
CREATE TABLE IF NOT EXISTS email_deliveries (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES email_subscriptions(id), subscription_version INTEGER NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id), repository_id INTEGER NOT NULL REFERENCES repositories(id), identity_version INTEGER NOT NULL,
 event_id TEXT NOT NULL, event_topic TEXT NOT NULL, automatic_key TEXT, input_hash TEXT,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retrying','accepted','failed','cancelled','suppressed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6), failure_code TEXT NOT NULL DEFAULT '',
 possible_duplicate INTEGER NOT NULL DEFAULT 0 CHECK(possible_duplicate IN (0,1)),
 sender TEXT NOT NULL DEFAULT '', provider_message_id TEXT NOT NULL DEFAULT '',
 lease TEXT, lease_until TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
 UNIQUE(subscription_id,subscription_version,automatic_key)
);
CREATE INDEX IF NOT EXISTS email_delivery_inventory ON email_deliveries(user_id,repository_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS email_delivery_due ON email_deliveries(state,next_attempt_at);
CREATE INDEX IF NOT EXISTS email_delivery_pending ON email_deliveries(user_id,state);
CREATE TABLE IF NOT EXISTS email_daily (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0);
-- First provider acceptance per sender address; the capability reports READY only from this record.
CREATE TABLE IF NOT EXISTS email_acceptance (sender TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, accepted_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS email_discussion_event AFTER INSERT ON discussion_events
BEGIN
 INSERT OR IGNORE INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,s.user_id,s.repository_id,s.identity_version,'discussion:'||NEW.id,CASE WHEN (SELECT kind FROM discussions WHERE id=NEW.discussion_id)='pull' THEN 'pulls' ELSE 'issues' END,
  'discussion:'||NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM email_subscriptions s
 WHERE s.repository_id=(SELECT repository_id FROM discussions WHERE id=NEW.discussion_id) AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value=CASE WHEN (SELECT kind FROM discussions WHERE id=NEW.discussion_id)='pull' THEN 'pulls' ELSE 'issues' END)
  AND (SELECT COUNT(*) FROM email_deliveries p WHERE p.user_id=s.user_id AND p.state IN ('queued','retrying','sending'))<200;
END;
CREATE TRIGGER IF NOT EXISTS email_source_event AFTER UPDATE OF state ON git_operations
WHEN NEW.state='APPLIED' AND OLD.state!='APPLIED'
BEGIN
 INSERT OR IGNORE INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,s.user_id,s.repository_id,s.identity_version,'source:'||NEW.id,'source',
  'source:'||NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM email_subscriptions s
 WHERE s.repository_id=NEW.repository_id AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value='source')
  AND (SELECT COUNT(*) FROM email_deliveries p WHERE p.user_id=s.user_id AND p.state IN ('queued','retrying','sending'))<200;
END;
CREATE TRIGGER IF NOT EXISTS email_test_admission_event AFTER INSERT ON evidence_jobs
WHEN NEW.test_state='REQUESTED'
BEGIN
 INSERT OR IGNORE INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,s.user_id,s.repository_id,s.identity_version,'test:'||NEW.id||':'||NEW.test_state,'actions',
  'test:'||NEW.id||':'||NEW.test_state,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM email_subscriptions s
 WHERE s.repository_id=NEW.repository_id AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value='actions') AND s.workflow_notifications=1
  AND (SELECT COUNT(*) FROM email_deliveries p WHERE p.user_id=s.user_id AND p.state IN ('queued','retrying','sending'))<200;
END;
CREATE TRIGGER IF NOT EXISTS email_test_state_event AFTER UPDATE OF test_state ON evidence_jobs
WHEN NEW.test_state!=OLD.test_state
BEGIN
 INSERT OR IGNORE INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,s.user_id,s.repository_id,s.identity_version,'test:'||NEW.id||':'||NEW.test_state,'actions',
  'test:'||NEW.id||':'||NEW.test_state,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM email_subscriptions s
 WHERE s.repository_id=NEW.repository_id AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value='actions') AND (s.workflow_notifications=1 OR s.workflow_notifications=2 AND NEW.test_state IN ('PASSED','FAILED','TIMED_OUT','CANCELLED','LOST') OR s.workflow_notifications=3 AND NEW.test_state IN ('FAILED','TIMED_OUT'))
  AND (SELECT COUNT(*) FROM email_deliveries p WHERE p.user_id=s.user_id AND p.state IN ('queued','retrying','sending'))<200;
END;
-- The maintenance journal's stage constraint predates email, as it did webhooks.
CREATE TABLE IF NOT EXISTS email_maintenance (
 stage TEXT PRIMARY KEY CHECK(stage='email'), started_at TEXT NOT NULL, completed_at TEXT, last_success_at TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','degraded','failed')),
 processed INTEGER CHECK(processed IS NULL OR processed>=0), pending INTEGER CHECK(pending IS NULL OR pending>=0)
);
