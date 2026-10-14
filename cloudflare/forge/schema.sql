-- One independently provisioned workspace partition. Never applied to PostgreSQL.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  can_create INTEGER NOT NULL DEFAULT 0 CHECK(can_create IN (0,1))
);
CREATE TABLE IF NOT EXISTS credentials (
  digest TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  artifact_name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  creator_id INTEGER NOT NULL REFERENCES users(id),
  creation_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('CREATING','ACTIVE')),
  created_at TEXT NOT NULL,
  write_pending TEXT,
  UNIQUE(creator_id, creation_key)
);
CREATE TABLE IF NOT EXISTS grants (
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('read','write','admin')),
  PRIMARY KEY(repository_id, user_id)
);
CREATE TABLE IF NOT EXISTS git_operations (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  ref TEXT NOT NULL,
  old_sha TEXT NOT NULL,
  new_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DISPATCHED','APPLIED')),
  ci_state TEXT NOT NULL DEFAULT 'NONE' CHECK(ci_state IN ('NONE','PENDING','RECORDED','REFUSED')),
  created_at TEXT NOT NULL
);

-- Native collaboration; shared issue/PR numbers, separate PR identities.
CREATE TABLE IF NOT EXISTS discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 4294967295),
  kind TEXT NOT NULL CHECK(kind IN ('issue','pull')),
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('OPEN','CLOSED')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id,number)
);
CREATE INDEX IF NOT EXISTS discussions_repository ON discussions(repository_id,kind,state,number DESC);
CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id INTEGER NOT NULL UNIQUE REFERENCES discussions(id),
  base_branch TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  draft INTEGER NOT NULL CHECK(draft IN (0,1))
);
CREATE TABLE IF NOT EXISTS discussion_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS discussion_comments_parent ON discussion_comments(discussion_id,id);
CREATE TABLE IF NOT EXISTS pull_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  head_commit TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('APPROVED','COMMENT','REQUEST_CHANGES')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pull_reviews_parent ON pull_reviews(pull_request_id,id);
-- Reported status observations only; not execution attestations or merge evidence.
CREATE TABLE IF NOT EXISTS reported_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  commit_id TEXT NOT NULL,
  context TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','SUCCESS','FAILURE','ERROR','WARNING','SKIPPED')),
  description TEXT NOT NULL,
  target_url TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reported_checks_commit ON reported_checks(repository_id,commit_id,context,id DESC);
CREATE TABLE IF NOT EXISTS collaboration_operations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  operation_key TEXT NOT NULL,
  method TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_kind TEXT NOT NULL CHECK(result_kind IN ('issue','pull','comment','review','check')),
  result_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id,operation_key)
);
CREATE TABLE IF NOT EXISTS evidence_jobs (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  operation_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','SUCCEEDED','REFUSED','EXPIRED')),
  delivery TEXT NOT NULL DEFAULT 'PENDING' CHECK(delivery IN ('PENDING','SENT','STARTED')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  advice_state TEXT NOT NULL CHECK(advice_state IN ('NONE','REQUESTED','RESERVED','SUCCEEDED','UNKNOWN')),
  advice TEXT,
  test_state TEXT NOT NULL DEFAULT 'NONE' CHECK(test_state IN ('NONE','REQUESTED','RUNNING','PASSED','FAILED','TIMED_OUT','CANCELLED','LOST')),
  test_result TEXT,
  agent_state TEXT NOT NULL DEFAULT 'NONE' CHECK(agent_state IN ('NONE','REQUESTED','FORK_PENDING','RUNNING','succeeded','failed','cancelled','timed_out','lost')),
  agent_fork TEXT,
  agent_publish TEXT CHECK(agent_publish IN ('DISPATCHED','APPLIED')),
  agent_proposal TEXT,
  agent_result TEXT,
  report_key TEXT,
  report_hash TEXT,
  report_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(user_id,operation_key)
);
CREATE INDEX IF NOT EXISTS evidence_daily ON evidence_jobs(created_at);

-- Workspace-owned outbound runner identities and explicit repository placement.
CREATE TABLE IF NOT EXISTS native_runner_pools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, version INTEGER NOT NULL CHECK(version>0),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','DRAINING')),
  trust_class TEXT NOT NULL CHECK(trust_class IN ('UNTRUSTED','TRUSTED')),
  max_parallel INTEGER NOT NULL CHECK(max_parallel BETWEEN 1 AND 20),
  image_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS native_runner_machines (
  id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES native_runner_pools(id), name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','DRAINING','REVOKED','QUARANTINED')),
  sponsor_id INTEGER NOT NULL REFERENCES users(id), credential_digest TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, last_seen_at TEXT, active_job_id TEXT REFERENCES evidence_jobs(id),
  attempt_generation INTEGER NOT NULL DEFAULT 0, claim_id TEXT, lease_digest TEXT, lease_expires_at INTEGER,
  cleanup_state TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(cleanup_state IN ('CONFIRMED','UNKNOWN')),
  created_at TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 'native' CHECK(protocol IN ('native','gitlab')),
  UNIQUE(pool_id,name)
);
CREATE INDEX IF NOT EXISTS native_runner_machine_pool ON native_runner_machines(pool_id,state);
CREATE TABLE IF NOT EXISTS native_runner_placements (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), pool_id TEXT REFERENCES native_runner_pools(id),
  pool_version INTEGER, version INTEGER NOT NULL CHECK(version>0), updated_at TEXT NOT NULL,
  CHECK((pool_id IS NULL)=(pool_version IS NULL))
);
CREATE TABLE IF NOT EXISTS gitlab_runner_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_job_id TEXT NOT NULL UNIQUE REFERENCES evidence_jobs(id),
  machine_id TEXT NOT NULL REFERENCES native_runner_machines(id),
  token_digest TEXT NOT NULL,
  trace TEXT NOT NULL DEFAULT '',
  trace_bytes INTEGER NOT NULL DEFAULT 0,
  completed_state TEXT,
  completed_exit_code INTEGER,
  CHECK(length(trace) <= 65536),
  CHECK(trace_bytes BETWEEN 0 AND 49152)
);
CREATE INDEX IF NOT EXISTS gitlab_runner_jobs_machine ON gitlab_runner_jobs(machine_id);

-- Native protected static PR delivery.
CREATE TABLE IF NOT EXISTS previews (
  id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id), job_id TEXT NOT NULL REFERENCES evidence_jobs(id),
  operation_key TEXT NOT NULL, input_hash TEXT NOT NULL, selection TEXT NOT NULL, pr_revision TEXT NOT NULL,
  commit_id TEXT NOT NULL, tree_id TEXT NOT NULL, source_path TEXT NOT NULL,
  bundle_key TEXT NOT NULL, bundle_hash TEXT NOT NULL, bundle_bytes INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PUBLISHING','READY','REVOKED','EXPIRED')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, purged INTEGER NOT NULL DEFAULT 0 CHECK(purged IN (0,1)),
  capture_state TEXT NOT NULL DEFAULT 'NONE' CHECK(capture_state IN ('NONE','DISPATCHED','READY','UNKNOWN')),
  capture_key TEXT, capture_hash TEXT, capture_bytes INTEGER, browser_ms INTEGER,
  kind TEXT NOT NULL DEFAULT 'STATIC' CHECK(kind IN ('STATIC','WORKER')), policy_hash TEXT,
  UNIQUE(user_id,operation_key)
);
CREATE INDEX IF NOT EXISTS previews_cleanup ON previews(purged,state,expires_at);
CREATE TABLE IF NOT EXISTS preview_credentials (
  digest TEXT PRIMARY KEY, preview_id TEXT NOT NULL REFERENCES previews(id), user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('grant','session')), expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS preview_credentials_expiry ON preview_credentials(expires_at);

-- Native managed application resources and verified-push CI admission.
CREATE TABLE IF NOT EXISTS app_resources (
  preview_id TEXT NOT NULL REFERENCES previews(id), kind TEXT NOT NULL CHECK(kind IN ('database','bucket','cleaner','script','domain','migration')),
  name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('DISPATCHED','READY','DELETED')),
  provider_id TEXT, identity TEXT, PRIMARY KEY(preview_id,kind)
);
CREATE TABLE IF NOT EXISTS ci_intake (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES git_operations(id), repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id), number INTEGER NOT NULL, selection TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','ADMITTED','REFUSED')),
  job_id TEXT, reason TEXT, created_at TEXT NOT NULL, UNIQUE(operation_id,number)
);
CREATE TABLE IF NOT EXISTS app_requests (day TEXT PRIMARY KEY, total INTEGER NOT NULL);

-- Apply only to Golf's native D1 workspace; seed its configured workspace separately.
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  artifact_namespace TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS repository_stars (
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY(repository_id,user_id)
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  full_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0
);

-- Native D1 only. Existing repository identities and Git authority are preserved.
CREATE TABLE IF NOT EXISTS repository_settings (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  description TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0
);
-- Replaceable immutable read models; no credentials or permission decisions are cached.
CREATE TABLE repository_indexes (
  key TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id),
  commit_id TEXT NOT NULL, input_hash TEXT NOT NULL, payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','READY')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX repository_indexes_expiry ON repository_indexes(expires_at,state);
CREATE TABLE repository_index_budget (
  day TEXT PRIMARY KEY, operations INTEGER NOT NULL CHECK(operations BETWEEN 0 AND 60000)
);
-- No role is inferred from can_create or repository grants on existing installs.
CREATE TABLE IF NOT EXISTS operations_admins (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS operations_maintenance (
  stage TEXT PRIMARY KEY CHECK(stage IN ('ci','previews','evidence','indexes')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_success_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','degraded','failed')),
  processed INTEGER CHECK(processed IS NULL OR processed >= 0),
  pending INTEGER CHECK(pending IS NULL OR pending >= 0)
);
CREATE INDEX IF NOT EXISTS evidence_operations ON evidence_jobs(state,created_at);
CREATE INDEX IF NOT EXISTS app_resources_operations ON app_resources(state,kind);
CREATE TABLE IF NOT EXISTS operations_provider (
  service TEXT PRIMARY KEY CHECK(service IN ('workers','artifacts','r2')),
  attempted_at TEXT NOT NULL, observed_at TEXT,
  window_start TEXT, window_end TEXT,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
  requests INTEGER, errors INTEGER, subrequests INTEGER
);
CREATE TABLE IF NOT EXISTS operations_delivery_failures (
  message_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES evidence_jobs(id),
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_delivery_expiry ON operations_delivery_failures(observed_at);

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
-- Native push policy and original mutation receipts; no Git objects are rewritten.
CREATE TABLE IF NOT EXISTS repository_rules (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), branches TEXT NOT NULL, tags TEXT NOT NULL,
 next_tag INTEGER NOT NULL CHECK(next_tag>0)
);
CREATE TABLE IF NOT EXISTS repository_rule_operations (
 operation_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id),
 actor_id INTEGER NOT NULL REFERENCES users(id), input_hash TEXT NOT NULL,
 receipt TEXT NOT NULL, current_rules TEXT
);
-- Repository-only Git credentials. Secrets are returned once and only their hashes persist.
CREATE TABLE IF NOT EXISTS git_credentials (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 digest TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 artifact_name TEXT NOT NULL,
 label TEXT NOT NULL,
 mode INTEGER NOT NULL CHECK(mode IN (1,2)),
 identity_version INTEGER NOT NULL,
 grant_generation INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+3600),
 revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS git_credentials_inventory ON git_credentials(user_id,repository_id,id);

-- Review routing and administration are collaboration state, not merge authority.
CREATE TABLE IF NOT EXISTS pull_review_versions (
  pull_request_id INTEGER PRIMARY KEY REFERENCES pull_requests(id),
  version INTEGER NOT NULL CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS pull_review_requests (
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  identity_version INTEGER NOT NULL,
  grant_generation INTEGER NOT NULL,
  PRIMARY KEY(pull_request_id,user_id)
);
CREATE TABLE IF NOT EXISTS pull_review_lifecycle (
  review_id INTEGER PRIMARY KEY REFERENCES pull_reviews(id),
  version INTEGER NOT NULL CHECK(version>0),
  dismissed INTEGER NOT NULL CHECK(dismissed IN (0,1)),
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pull_review_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  kind TEXT NOT NULL CHECK(kind IN ('request','lifecycle','authoring')),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
CREATE TABLE IF NOT EXISTS pull_review_drafts (
  review_id INTEGER PRIMARY KEY REFERENCES pull_reviews(id),
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('PENDING','PUBLISHED','DISCARDED')),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_review_one_pending ON pull_review_drafts(pull_request_id,author_id) WHERE status='PENDING';
CREATE TABLE IF NOT EXISTS pull_review_draft_versions (
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version>0),
  PRIMARY KEY(pull_request_id,author_id)
);
-- Public ownership is separate from the stable installation/DO partition.
CREATE TABLE IF NOT EXISTS native_owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('PERSONAL','ORGANIZATION')),
  user_id INTEGER UNIQUE REFERENCES users(id),
  full_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  creator_id INTEGER NOT NULL REFERENCES users(id),
  creation_key TEXT,
  input_hash TEXT,
  UNIQUE(creator_id,creation_key),
  CHECK((kind='PERSONAL' AND user_id IS NOT NULL) OR (kind='ORGANIZATION' AND user_id IS NULL))
);
CREATE TABLE IF NOT EXISTS native_owner_members (
  owner_id INTEGER NOT NULL REFERENCES native_owners(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  PRIMARY KEY(owner_id,user_id)
);
CREATE TABLE IF NOT EXISTS repository_owners (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  owner_id INTEGER NOT NULL REFERENCES native_owners(id)
);
CREATE INDEX IF NOT EXISTS repository_owners_owner ON repository_owners(owner_id,repository_id);

CREATE TABLE IF NOT EXISTS repository_visibility (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(id),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE INDEX IF NOT EXISTS repository_visibility_public ON repository_visibility(is_public,repository_id);
CREATE TABLE IF NOT EXISTS public_profiles (
  owner_id INTEGER PRIMARY KEY REFERENCES native_owners(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  readme TEXT NOT NULL DEFAULT '',
  pinned TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);

CREATE TABLE IF NOT EXISTS repository_environments (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  artifact_name TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_environments_live ON repository_environments(repository_id) WHERE deleted=0;
CREATE TABLE IF NOT EXISTS repository_environment_versions (
  environment_id TEXT NOT NULL REFERENCES repository_environments(id),
  version INTEGER NOT NULL CHECK(version>=1),
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  policy TEXT NOT NULL,
  target TEXT NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  environment_created_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(environment_id,version)
);
CREATE TABLE IF NOT EXISTS repository_environment_operations (
  operation_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  environment_id TEXT NOT NULL REFERENCES repository_environments(id),
  version INTEGER NOT NULL CHECK(version>=1),
  action TEXT NOT NULL CHECK(action IN ('save','delete')),
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_environment_operations_repository ON repository_environment_operations(repository_id);

-- Native merge journal. Commit title/message are fingerprinted in input_hash, never stored.
CREATE TABLE IF NOT EXISTS pull_merge_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id),
  input_hash TEXT NOT NULL,
  original TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
  detail TEXT NOT NULL DEFAULT '',
  git_operation_id TEXT REFERENCES git_operations(id),
  merge_commit_id TEXT NOT NULL DEFAULT '',
  actual_base_commit_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_merge_one_unresolved ON pull_merge_operations(pull_request_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE UNIQUE INDEX IF NOT EXISTS pull_merge_one_success ON pull_merge_operations(pull_request_id) WHERE phase='SUCCEEDED';

-- Repository switch for pull-request runs and automatic push tests; no row means both are enabled within the operator allocation.
CREATE TABLE IF NOT EXISTS repository_execution_policy (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), manual INTEGER NOT NULL CHECK(manual IN (0,1)),
 push INTEGER NOT NULL CHECK(push IN (0,1)), updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
);

-- Repository execution values and exact-source approvals. Values are AES-GCM ciphertext and plaintext is never stored.
CREATE TABLE IF NOT EXISTS execution_value_brokers (
 repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), artifact_name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0)
);
CREATE TABLE IF NOT EXISTS execution_values (
 id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('secret','variable')), version INTEGER NOT NULL CHECK(version>0),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), value_bytes INTEGER NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repository_id,name)
);
CREATE TABLE IF NOT EXISTS execution_value_versions (
 id TEXT NOT NULL REFERENCES execution_values(id), version INTEGER NOT NULL CHECK(version>0), value_bytes INTEGER NOT NULL CHECK(value_bytes BETWEEN 1 AND 8192),
 encrypted TEXT NOT NULL, key_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(id,version)
);
CREATE TABLE IF NOT EXISTS execution_bindings (
 id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 workflow_path TEXT NOT NULL, commit_id TEXT NOT NULL, blob_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, engine_catalog TEXT NOT NULL,
 event TEXT NOT NULL, event_ref TEXT NOT NULL, value_refs TEXT NOT NULL, sponsor_id INTEGER NOT NULL REFERENCES users(id),
 identity_version INTEGER NOT NULL, grant_generation INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_bindings_source ON execution_bindings(repository_id,commit_id);
CREATE TABLE IF NOT EXISTS execution_value_operations (
 operation_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 action TEXT NOT NULL CHECK(action IN ('save_value','delete_value','save_binding','delete_binding')), item_id TEXT NOT NULL,
 accepted_version INTEGER NOT NULL, accepted_broker_revision INTEGER NOT NULL, input_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
-- One release per job: which approval version let its values leave storage, and when. Never the values.
CREATE TABLE IF NOT EXISTS execution_value_releases (
 job_id TEXT PRIMARY KEY REFERENCES evidence_jobs(id), binding_id TEXT NOT NULL REFERENCES execution_bindings(id), binding_version INTEGER NOT NULL, released_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS repository_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  artifact_name TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  tag_object_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0 CHECK(draft IN (0,1)),
  prerelease INTEGER NOT NULL DEFAULT 0 CHECK(prerelease IN (0,1)),
  author_id INTEGER NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_releases_tag ON repository_releases(repository_id,tag_name) WHERE deleted=0;
CREATE INDEX IF NOT EXISTS repository_releases_inventory ON repository_releases(repository_id,deleted,id);
-- deleted: 0 listed, 1 removed while its R2 object awaits deletion, 2 object confirmed absent.
CREATE TABLE IF NOT EXISTS repository_release_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL REFERENCES repository_releases(id),
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 262144),
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  downloads INTEGER NOT NULL DEFAULT 0 CHECK(downloads>=0),
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1,2))
);
CREATE UNIQUE INDEX IF NOT EXISTS repository_release_assets_name ON repository_release_assets(release_id,name) WHERE deleted=0;
CREATE INDEX IF NOT EXISTS repository_release_assets_state ON repository_release_assets(deleted,release_id,id);
-- receipt holds the immutable original; phase and result settle once. object names a reserved upload.
CREATE TABLE IF NOT EXISTS repository_release_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK(kind IN ('publication','management')),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
  result_id INTEGER,
  object TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);

-- comment_id 0 is the issue or pull request description. Comments carry no foreign key, so deleting a comment never fails here.
CREATE TABLE IF NOT EXISTS discussion_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  comment_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 262144),
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS discussion_attachments_name ON discussion_attachments(discussion_id,comment_id,name);
CREATE TABLE IF NOT EXISTS discussion_attachment_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  discussion_id INTEGER NOT NULL REFERENCES discussions(id),
  comment_id INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL,
  original TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
  attachment_id INTEGER REFERENCES discussion_attachments(id),
  object TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,operation_id)
);

-- Installation policy inside the deploy allocation (schema 30). A missing row means the deploy value applies, so this migration changes nothing.
-- Keys are validated in code (src/installation.mjs), so new keys need no migration.
CREATE TABLE IF NOT EXISTS installation_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installation_operations (
  operation_id TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  input_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Append-only record of administration changes at installation, organization and repository scope; before and after are JSON.
CREATE TABLE IF NOT EXISTS installation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  actor_email TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT,
  widening INTEGER NOT NULL DEFAULT 0 CHECK(widening IN (0, 1)),
  operation_id TEXT UNIQUE,
  client TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS installation_audit_scope ON installation_audit(scope, scope_id, id);
CREATE TRIGGER IF NOT EXISTS installation_audit_no_update BEFORE UPDATE ON installation_audit
BEGIN SELECT RAISE(ABORT, 'installation audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS installation_audit_no_delete BEFORE DELETE ON installation_audit
BEGIN SELECT RAISE(ABORT, 'installation audit is append-only'); END;

-- Feature policies. No row means ALLOWED at installation and organization scope and enabled for the repository,
-- so applying this migration changes nothing. Feature names are validated in code, never by CHECK.
CREATE TABLE IF NOT EXISTS feature_policies (
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization')), scope_id TEXT NOT NULL, feature TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('DISABLED','ALLOWED','ENFORCED')), version INTEGER NOT NULL CHECK(version>0),
 updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(scope,scope_id,feature)
);
-- A repository's own choice; a row for another artifact enables nothing. Actions keeps its switch in repository_execution_policy.
CREATE TABLE IF NOT EXISTS repository_features (
 repository_id INTEGER NOT NULL REFERENCES repositories(id), artifact_name TEXT NOT NULL, feature TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL CHECK(version>0),
 updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
 PRIMARY KEY(repository_id,feature)
);
-- One fence per policy scope: every change in a scope advances it inside the same batch.
CREATE TABLE IF NOT EXISTS policy_revisions (
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization','repository')), scope_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), PRIMARY KEY(scope,scope_id)
);

-- Actions/CI pipelines on the native backend (docs/NATIVE_ACTIONS_PIPELINES.md). Separate from evidence_jobs;
-- every route that reads or writes these rows checks the `actions` feature policy. Replay-safe.
CREATE TABLE IF NOT EXISTS pipeline_registration_tokens (
 id TEXT PRIMARY KEY,                                   -- UUID v4
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization','repository')),
 scope_id TEXT NOT NULL,                                -- '' | native_owners.id | repositories.id (decimal text)
 labels TEXT NOT NULL DEFAULT '[]',                     -- JSON array, default labels for runners registered with it
 token_digest TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of the plaintext; plaintext shown once
 expires_at INTEGER NOT NULL,                           -- epoch ms, at most 24 h after creation
 uses_left INTEGER NOT NULL CHECK(uses_left BETWEEN 0 AND 100),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_runners (
 id INTEGER PRIMARY KEY AUTOINCREMENT,                  -- Forgejo Runner.id / GitLab runner id
 uuid TEXT NOT NULL UNIQUE,                             -- Forgejo x-runner-uuid; GitLab token id part
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 scope TEXT NOT NULL CHECK(scope IN ('installation','organization','repository')),
 scope_id TEXT NOT NULL,
 name TEXT NOT NULL,
 labels TEXT NOT NULL DEFAULT '[]',                     -- JSON array; Forgejo labels keep "name:schema://image"; matching uses the name part
 token_digest TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of the runner credential
 state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DISABLED')),
 version TEXT NOT NULL DEFAULT '',                      -- reported runner version
 info TEXT NOT NULL DEFAULT '{}',                       -- engine-specific bounded JSON (GitLab: executor/platform/architecture)
 ephemeral INTEGER NOT NULL DEFAULT 0 CHECK(ephemeral IN (0,1)),
 registration_id TEXT REFERENCES pipeline_registration_tokens(id),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 last_seen_at TEXT,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE INDEX IF NOT EXISTS pipeline_runners_scope ON pipeline_runners(engine,scope,scope_id,state);
CREATE TABLE IF NOT EXISTS pipeline_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,                  -- github.run_id / GitLab pipeline id
 repository_id INTEGER NOT NULL REFERENCES repositories(id),
 artifact_name TEXT NOT NULL,                           -- a row for another artifact is never served
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 number INTEGER NOT NULL,                               -- per repository and engine, starts at 1
 workflow_path TEXT NOT NULL,                           -- .github/workflows/x.yml | .forgejo/workflows/x.yml | .gitlab-ci.yml
 workflow_name TEXT NOT NULL,
 workflow_blob TEXT NOT NULL DEFAULT '',
 event TEXT NOT NULL CHECK(event IN ('push','pull_request','workflow_dispatch','merge_request_event','web','schedule')),
 ref TEXT NOT NULL,                                     -- refs/heads/x | refs/tags/x | refs/pull/N/head
 commit_id TEXT NOT NULL,
 before_sha TEXT NOT NULL DEFAULT '',
 pull_number INTEGER,
 head_ref TEXT NOT NULL DEFAULT '',
 base_ref TEXT NOT NULL DEFAULT '',
 actor_id INTEGER NOT NULL REFERENCES users(id),
 trusted INTEGER NOT NULL CHECK(trusted IN (0,1)),      -- 1 = same-repository trigger; secrets are released only then
 inputs TEXT NOT NULL DEFAULT '{}',                     -- workflow_dispatch inputs / GitLab pipeline variables (non-secret)
 event_payload TEXT NOT NULL DEFAULT '{}',              -- github.event, at most 32 KiB
 title TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','WAITING','SUCCESS','FAILURE','CANCELLED','SKIPPED','REFUSED')),
 reason TEXT NOT NULL DEFAULT '',                       -- visible refusal or note (unsupported syntax, concurrency, …)
 attempt INTEGER NOT NULL DEFAULT 1,
 concurrency_group TEXT,
 concurrency_cancel INTEGER NOT NULL DEFAULT 0,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 intake_id TEXT,                                        -- trigger idempotency: UNIQUE with the workflow path
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL,
 UNIQUE(repository_id,engine,number),
 UNIQUE(intake_id,workflow_path)
);
CREATE INDEX IF NOT EXISTS pipeline_runs_repository ON pipeline_runs(repository_id,id);
CREATE INDEX IF NOT EXISTS pipeline_runs_state ON pipeline_runs(state,concurrency_group);
CREATE TABLE IF NOT EXISTS pipeline_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,                  -- Forgejo task id / GitLab job id
 run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
 attempt INTEGER NOT NULL,                              -- current jobs: attempt = pipeline_runs.attempt
 engine TEXT NOT NULL CHECK(engine IN ('forgejo-actions','gitlab-ci')),
 job_key TEXT NOT NULL,                                 -- YAML job id (Forgejo) / job name (GitLab)
 name TEXT NOT NULL,                                    -- display name; matrix values or "name 1/3" included
 stage TEXT NOT NULL DEFAULT '',
 stage_index INTEGER NOT NULL DEFAULT 0,
 needs TEXT NOT NULL DEFAULT '[]',                      -- JSON array of job_key (Forgejo) or job name (GitLab) in the same run
 runs_on TEXT NOT NULL DEFAULT '[]',                    -- JSON array of labels a runner must all carry (GitLab: tags)
 payload TEXT NOT NULL,                                 -- Forgejo: single-job workflow YAML; GitLab: JSON job spec (gitlab-pipeline.mjs owns it)
 state TEXT NOT NULL CHECK(state IN ('BLOCKED','QUEUED','RUNNING','SUCCESS','FAILURE','CANCELLED','SKIPPED','MANUAL')),
 when_mode TEXT NOT NULL DEFAULT 'on_success' CHECK(when_mode IN ('on_success','on_failure','always','manual','conditional')),
 allow_failure INTEGER NOT NULL DEFAULT 0 CHECK(allow_failure IN (0,1)),
 timeout_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(timeout_seconds BETWEEN 60 AND 21600),
 retry_max INTEGER NOT NULL DEFAULT 0 CHECK(retry_max BETWEEN 0 AND 2),
 retry_count INTEGER NOT NULL DEFAULT 0,
 runner_id INTEGER REFERENCES pipeline_runners(id),
 request_key TEXT,                                      -- Forgejo x-runner-request-key idempotency
 token_digest TEXT UNIQUE,                              -- job token (SHA-256 hex); NULL when not running
 token_expires_at INTEGER,
 outputs TEXT NOT NULL DEFAULT '{}',                    -- job outputs (Forgejo) / dotenv reports (GitLab), at most 64 KiB
 exit_code INTEGER,
 failure_reason TEXT NOT NULL DEFAULT '',
 log_lines INTEGER NOT NULL DEFAULT 0,
 log_bytes INTEGER NOT NULL DEFAULT 0,
 log_chunks INTEGER NOT NULL DEFAULT 0,
 log_complete INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, queued_at TEXT, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL,
 UNIQUE(run_id,attempt,name)
);
CREATE INDEX IF NOT EXISTS pipeline_jobs_queue ON pipeline_jobs(engine,state,id);
CREATE INDEX IF NOT EXISTS pipeline_jobs_run ON pipeline_jobs(run_id,attempt);
CREATE TABLE IF NOT EXISTS pipeline_steps (
 job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id), number INTEGER NOT NULL, name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','SUCCESS','FAILURE','CANCELLED','SKIPPED')),
 started_at TEXT, finished_at TEXT, log_index INTEGER NOT NULL DEFAULT 0, log_length INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(job_id,number)
);
-- R2 key of a chunk: pipelines/<run_id>/<job_id>/log/<seq zero-padded to 8>. Chunks are immutable; seq is dense from 0.
CREATE TABLE IF NOT EXISTS pipeline_log_chunks (
 job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id), seq INTEGER NOT NULL,
 first_line INTEGER NOT NULL, lines INTEGER NOT NULL, first_byte INTEGER NOT NULL, bytes INTEGER NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(job_id,seq)
);
CREATE TABLE IF NOT EXISTS pipeline_artifacts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
 job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id),
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('actions-v4','gitlab-archive','gitlab-report')),
 state TEXT NOT NULL CHECK(state IN ('UPLOADING','READY','EXPIRED','DELETED')),
 size INTEGER NOT NULL DEFAULT 0,
 sha256 TEXT NOT NULL DEFAULT '',
 blocks TEXT NOT NULL DEFAULT '[]',                     -- ordered R2 keys under pipelines/<run>/artifacts/<id>/; download concatenates
 content_type TEXT NOT NULL DEFAULT 'application/zip',
 created_at TEXT NOT NULL, finalized_at TEXT, expires_at TEXT NOT NULL,
 UNIQUE(job_id,name)
);
CREATE INDEX IF NOT EXISTS pipeline_artifacts_run ON pipeline_artifacts(run_id,name);
-- Durable trigger intake: a push/PR/dispatch is recorded first, then discovered; a lost intake is retried by the sweep.
CREATE TABLE IF NOT EXISTS pipeline_intake (
 id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), kind TEXT NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','DONE','REFUSED')), reason TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_intake_pending ON pipeline_intake(state,created_at);
