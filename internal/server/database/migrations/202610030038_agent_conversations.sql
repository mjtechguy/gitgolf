-- +goose Up
-- Retained private attempt observations, never a shared repository transcript.
CREATE TABLE golf_agent_conversations (
 task_id uuid NOT NULL REFERENCES golf_agent_tasks(id) ON DELETE RESTRICT,
 attempt_id text NOT NULL CHECK(attempt_id ~ '^[a-f0-9]{32}$'),
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),
 owner_id bigint NOT NULL CHECK(owner_id>0),
 user_id bigint NOT NULL REFERENCES golf_users(id) ON DELETE RESTRICT,
 native_user_id bigint NOT NULL CHECK(native_user_id>0),
 worker_id text NOT NULL,
 connection_id uuid NOT NULL,
 connection_version bigint NOT NULL CHECK(connection_version>0),
 commit_id text NOT NULL CHECK(commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 body_state text NOT NULL DEFAULT 'WITHHELD' CHECK(body_state IN ('WITHHELD','AVAILABLE','UNAVAILABLE')),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence BETWEEN 0 AND 513),
 projected_bytes bigint NOT NULL DEFAULT 0 CHECK(projected_bytes BETWEEN 0 AND 262144),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(task_id,attempt_id),
 UNIQUE(task_id,attempt_id,forge_url,repository_id,user_id)
);
CREATE TABLE golf_agent_conversation_contents (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL,
 attempt_id text NOT NULL,
 forge_url text NOT NULL,
 repository_id bigint NOT NULL,
 user_id bigint NOT NULL,
 sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 513),
 encrypted_content bytea NOT NULL CHECK(octet_length(encrypted_content) BETWEEN 28 AND 262172),
 content_binding bytea NOT NULL CHECK(octet_length(content_binding)=32),
 credential_key_id text NOT NULL CHECK(credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(task_id,attempt_id,forge_url,repository_id,user_id) REFERENCES golf_agent_conversations(task_id,attempt_id,forge_url,repository_id,user_id),
 UNIQUE(id,task_id,attempt_id,sequence)
);
CREATE INDEX golf_agent_conversation_content_key ON golf_agent_conversation_contents(credential_key_id,id);
CREATE TRIGGER golf_agent_conversation_active_key BEFORE INSERT OR UPDATE OF encrypted_content,credential_key_id ON golf_agent_conversation_contents FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TABLE golf_agent_task_events (
 task_id uuid NOT NULL,
 attempt_id text NOT NULL,
 sequence bigint NOT NULL,
 content_id uuid NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('prompt','thread_started','turn_started','tool_started','tool_completed','approval_declined','assistant_message','plan_updated','usage_updated','turn_completed')),
 status text NOT NULL DEFAULT '' CHECK(status IN ('','inProgress','completed','failed','interrupted','declined','pending')),
 tool_kind text NOT NULL DEFAULT '' CHECK(tool_kind IN ('','commandExecution','fileChange')),
 total_tokens bigint CHECK(total_tokens>=0),
 projected_bytes integer NOT NULL CHECK(projected_bytes BETWEEN 1 AND 262144),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(task_id,attempt_id,sequence),
 FOREIGN KEY(content_id,task_id,attempt_id,sequence) REFERENCES golf_agent_conversation_contents(id,task_id,attempt_id,sequence)
);
-- +goose StatementBegin
CREATE FUNCTION golf_agent_conversation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM golf_agent_tasks t WHERE t.id=NEW.task_id AND t.attempt_id=NEW.attempt_id AND t.forge_url=NEW.forge_url AND t.repository_id=NEW.repository_id AND t.owner_id=NEW.owner_id AND t.user_id=NEW.user_id AND t.native_user_id=NEW.native_user_id AND t.worker_id=NEW.worker_id AND t.connection_id=NEW.connection_id AND t.connection_version=NEW.connection_version AND t.commit_id=NEW.commit_id AND t.state='running' AND t.lease_expires_at>clock_timestamp()) OR NEW.body_state<>'WITHHELD' OR NEW.last_sequence<>0 OR NEW.projected_bytes<>0 THEN
   RAISE EXCEPTION 'Conversation attempt admission mismatch';
  END IF;
 ELSE
  IF ROW(NEW.task_id,NEW.attempt_id,NEW.forge_url,NEW.repository_id,NEW.owner_id,NEW.user_id,NEW.native_user_id,NEW.worker_id,NEW.connection_id,NEW.connection_version,NEW.commit_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.task_id,OLD.attempt_id,OLD.forge_url,OLD.repository_id,OLD.owner_id,OLD.user_id,OLD.native_user_id,OLD.worker_id,OLD.connection_id,OLD.connection_version,OLD.commit_id,OLD.created_at) OR OLD.body_state<>'WITHHELD' THEN
   RAISE EXCEPTION 'Conversation identity/terminal state is immutable';
  END IF;
  IF NEW.body_state='WITHHELD' THEN
   IF NEW.last_sequence<>OLD.last_sequence+1 OR NEW.projected_bytes<=OLD.projected_bytes THEN RAISE EXCEPTION 'Conversation sequence is immutable'; END IF;
  ELSIF NEW.last_sequence<>OLD.last_sequence OR NEW.projected_bytes<>OLD.projected_bytes OR (NEW.body_state='AVAILABLE' AND NOT EXISTS(SELECT 1 FROM golf_agent_tasks t WHERE t.id=NEW.task_id AND t.attempt_id=NEW.attempt_id AND t.state='succeeded')) THEN
   RAISE EXCEPTION 'Conversation terminal admission mismatch';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_agent_conversation_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.task_id,NEW.attempt_id,NEW.forge_url,NEW.repository_id,NEW.user_id,NEW.sequence,NEW.content_binding,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.task_id,OLD.attempt_id,OLD.forge_url,OLD.repository_id,OLD.user_id,OLD.sequence,OLD.content_binding,OLD.created_at) THEN RAISE EXCEPTION 'Conversation content identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_agent_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c golf_agent_conversations%ROWTYPE;
BEGIN
 SELECT * INTO c FROM golf_agent_conversations WHERE task_id=NEW.task_id AND attempt_id=NEW.attempt_id FOR UPDATE;
 IF NOT FOUND OR c.body_state<>'WITHHELD' OR c.last_sequence+1<>NEW.sequence OR NOT EXISTS(SELECT 1 FROM golf_agent_tasks t WHERE t.id=c.task_id AND t.attempt_id=c.attempt_id AND t.worker_id=c.worker_id AND t.state='running' AND t.lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Conversation event admission mismatch'; END IF;
 UPDATE golf_agent_conversations SET last_sequence=NEW.sequence,projected_bytes=projected_bytes+NEW.projected_bytes WHERE task_id=NEW.task_id AND attempt_id=NEW.attempt_id;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_agent_conversation_identity BEFORE INSERT OR UPDATE ON golf_agent_conversations FOR EACH ROW EXECUTE FUNCTION golf_agent_conversation_guard();
CREATE TRIGGER golf_agent_conversation_content_identity BEFORE UPDATE ON golf_agent_conversation_contents FOR EACH ROW EXECUTE FUNCTION golf_agent_conversation_content_guard();
CREATE TRIGGER golf_agent_event_admission BEFORE INSERT ON golf_agent_task_events FOR EACH ROW EXECUTE FUNCTION golf_agent_event_guard();
CREATE TRIGGER golf_agent_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_agent_task_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_agent_conversations_retained BEFORE DELETE OR TRUNCATE ON golf_agent_conversations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_agent_conversation_contents_retained BEFORE DELETE OR TRUNCATE ON golf_agent_conversation_contents FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
ALTER TABLE golf_crypto_events ADD COLUMN conversation_contents_count bigint NOT NULL DEFAULT 0 CHECK(conversation_contents_count>=0);
-- +goose Down
-- Retained attempt history must never disappear during rollback, including loss.
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Agent conversation schema downgrade requires a separately qualified recovery procedure'; END $$;
-- +goose StatementEnd
