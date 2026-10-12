-- Native webhook configuration and transactional outbox. Secrets are AES-GCM ciphertext.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
 id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), name TEXT NOT NULL, destination_host TEXT NOT NULL,
 encrypted TEXT NOT NULL, credential_version INTEGER NOT NULL CHECK(credential_version>0), event_topics TEXT NOT NULL, workflow_notifications INTEGER NOT NULL CHECK(workflow_notifications BETWEEN 1 AND 3),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), sponsor_id INTEGER NOT NULL REFERENCES users(id),
 identity_version INTEGER NOT NULL, grant_generation INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_repository ON webhook_subscriptions(repository_id,id);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id), subscription_version INTEGER NOT NULL,
 event_id TEXT NOT NULL, event_topic TEXT NOT NULL, payload TEXT NOT NULL, automatic_key TEXT,
 requested_by INTEGER REFERENCES users(id), input_hash TEXT,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retrying','accepted','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6), response_status INTEGER NOT NULL DEFAULT 0,
 failure_code TEXT NOT NULL DEFAULT '', possible_duplicate INTEGER NOT NULL DEFAULT 0 CHECK(possible_duplicate IN (0,1)),
 lease TEXT, lease_until TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
 UNIQUE(subscription_id,subscription_version,automatic_key)
);
CREATE INDEX IF NOT EXISTS webhook_delivery_inventory ON webhook_deliveries(subscription_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS webhook_delivery_due ON webhook_deliveries(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS webhook_daily (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS webhook_discussion_event AFTER INSERT ON discussion_events

BEGIN
 INSERT OR IGNORE INTO webhook_deliveries(id,subscription_id,subscription_version,event_id,event_topic,payload,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,'discussion:'||NEW.id,CASE WHEN (SELECT kind FROM discussions WHERE id=NEW.discussion_id)='pull' THEN 'pulls' ELSE 'issues' END,
  json_object('schema','golf.webhook.v1','event','golf.repository.changed','event_id','discussion:'||NEW.id,'repository_id',CAST(s.repository_id AS TEXT),'topic',CASE WHEN (SELECT kind FROM discussions WHERE id=NEW.discussion_id)='pull' THEN 'pulls' ELSE 'issues' END),
  'discussion:'||NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM webhook_subscriptions s
 WHERE s.repository_id=(SELECT repository_id FROM discussions WHERE id=NEW.discussion_id) AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value=CASE WHEN (SELECT kind FROM discussions WHERE id=NEW.discussion_id)='pull' THEN 'pulls' ELSE 'issues' END) AND (1);
END;
CREATE TRIGGER IF NOT EXISTS webhook_source_event AFTER UPDATE OF state ON git_operations
WHEN NEW.state='APPLIED' AND OLD.state!='APPLIED'
BEGIN
 INSERT OR IGNORE INTO webhook_deliveries(id,subscription_id,subscription_version,event_id,event_topic,payload,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,'source:'||NEW.id,'source',
  json_object('schema','golf.webhook.v1','event','golf.repository.changed','event_id','source:'||NEW.id,'repository_id',CAST(s.repository_id AS TEXT),'topic','source'),
  'source:'||NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM webhook_subscriptions s
 WHERE s.repository_id=NEW.repository_id AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value='source') AND (1);
END;
CREATE TRIGGER IF NOT EXISTS webhook_test_admission_event AFTER INSERT ON evidence_jobs
WHEN NEW.test_state='REQUESTED'
BEGIN
 INSERT OR IGNORE INTO webhook_deliveries(id,subscription_id,subscription_version,event_id,event_topic,payload,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,'test:'||NEW.id||':'||NEW.test_state,'actions',
  json_object('schema','golf.webhook.v1','event','golf.repository.changed','event_id','test:'||NEW.id||':'||NEW.test_state,'repository_id',CAST(s.repository_id AS TEXT),'topic','actions'),
  'test:'||NEW.id||':'||NEW.test_state,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM webhook_subscriptions s
 WHERE s.repository_id=NEW.repository_id AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value='actions') AND (s.workflow_notifications=1);
END;
CREATE TRIGGER IF NOT EXISTS webhook_test_state_event AFTER UPDATE OF test_state ON evidence_jobs
WHEN NEW.test_state!=OLD.test_state
BEGIN
 INSERT OR IGNORE INTO webhook_deliveries(id,subscription_id,subscription_version,event_id,event_topic,payload,automatic_key,next_attempt_at,created_at)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),s.id,s.version,'test:'||NEW.id||':'||NEW.test_state,'actions',
  json_object('schema','golf.webhook.v1','event','golf.repository.changed','event_id','test:'||NEW.id||':'||NEW.test_state,'repository_id',CAST(s.repository_id AS TEXT),'topic','actions'),
  'test:'||NEW.id||':'||NEW.test_state,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM webhook_subscriptions s
 WHERE s.repository_id=NEW.repository_id AND s.enabled=1 AND EXISTS(SELECT 1 FROM json_each(s.event_topics) WHERE value='actions') AND (s.workflow_notifications=1 OR s.workflow_notifications=2 AND NEW.test_state IN ('PASSED','FAILED','TIMED_OUT','CANCELLED','LOST') OR s.workflow_notifications=3 AND NEW.test_state IN ('FAILED','TIMED_OUT'));
END;
-- Keep the existing maintenance journal intact; its stage constraint predates webhooks.
CREATE TABLE IF NOT EXISTS webhook_maintenance (
 stage TEXT PRIMARY KEY CHECK(stage='webhooks'), started_at TEXT NOT NULL, completed_at TEXT, last_success_at TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','degraded','failed')),
 processed INTEGER CHECK(processed IS NULL OR processed>=0), pending INTEGER CHECK(pending IS NULL OR pending>=0)
);
