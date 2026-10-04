-- +goose Up
ALTER TABLE golf_webhook_subscriptions ADD COLUMN workflow_notifications integer NOT NULL DEFAULT 1 CHECK(workflow_notifications BETWEEN 1 AND 3);
ALTER TABLE golf_webhook_configuration_events ADD COLUMN workflow_notifications integer NOT NULL DEFAULT 1 CHECK(workflow_notifications BETWEEN 1 AND 3);
ALTER TABLE golf_email_subscriptions ADD COLUMN workflow_notifications integer NOT NULL DEFAULT 1 CHECK(workflow_notifications BETWEEN 1 AND 3);
ALTER TABLE golf_email_events ADD COLUMN workflow_notifications integer CHECK(workflow_notifications BETWEEN 1 AND 3);

-- No historical backfill sends. One immutable, content-free terminal observation
-- per logical workflow run; terminal edits/replay/log frames never resend it.
CREATE TABLE golf_workflow_notification_events (
 run_id uuid PRIMARY KEY REFERENCES golf_workflow_runs(id),
 event_id text NOT NULL UNIQUE,
 forge_url text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 attempt_id text NOT NULL CHECK(attempt_id='' OR attempt_id ~ '^[a-f0-9]{32}$'),
 state text NOT NULL CHECK(state IN ('succeeded','failed','cancelled','timed_out','lost')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(event_id='workflow-terminal:'||run_id::text)
);
CREATE TRIGGER golf_workflow_notification_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_workflow_notification_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION golf_webhook_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.recipient_user_id<>0 OR NEW.topic NOT IN ('source','issues','pulls','actions') THEN RETURN NEW; END IF;
 INSERT INTO golf_webhook_deliveries(id,subscription_id,subscription_version,epoch,event_id,event_topic,payload)
 SELECT gen_random_uuid(),s.id,s.version,s.epoch,'activity:'||NEW.id::text,NEW.topic,
 convert_to(jsonb_build_object('schema','golf.webhook.v1','event','repository.activity.'||NEW.topic,'event_id','activity:'||NEW.id::text,
 'producer','golf.repository_activity','repository_id',NEW.repository_id::text,'occurred_at',NEW.created_at)::text,'UTF8')
 FROM golf_webhook_subscriptions s WHERE s.forge_url=NEW.forge_url AND s.repository_id=NEW.repository_id AND s.enabled AND s.authorization_state='authorized' AND s.event_topics ? NEW.topic
 AND (NEW.topic<>'actions' OR s.workflow_notifications=1) ORDER BY s.id;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION golf_email_activity_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.recipient_user_id<>0 OR NEW.topic NOT IN ('source','issues','pulls','actions') THEN RETURN NEW; END IF;
 INSERT INTO golf_email_deliveries(id,user_id,kind,contact_version,subscription_id,subscription_version,epoch,event_id,event_topic,transport_id,transport_version,activation_generation)
 SELECT gen_random_uuid(),s.user_id,'activity',s.contact_version,s.id,s.version,s.epoch,'activity:'||NEW.id::text,NEW.topic,cfg.transport_id,cfg.transport_version,cfg.generation
 FROM golf_email_subscriptions s JOIN golf_email_contacts c ON c.user_id=s.user_id CROSS JOIN golf_email_configuration cfg
 WHERE s.forge_url=NEW.forge_url AND s.repository_id=NEW.repository_id AND s.enabled AND s.authorization_state='authorized' AND s.event_topics ? NEW.topic
 AND (NEW.topic<>'actions' OR s.workflow_notifications=1)
 AND c.enabled AND c.verified_at IS NOT NULL AND c.suppression='' AND c.version=s.contact_version AND c.credential_version=s.credential_version ORDER BY s.id;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_workflow_terminal_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event golf_workflow_notification_events;
BEGIN
 IF OLD.state NOT IN ('queued','running') OR NEW.state NOT IN ('succeeded','failed','cancelled','timed_out','lost') THEN RETURN NEW; END IF;
 INSERT INTO golf_workflow_notification_events(run_id,event_id,forge_url,repository_id,owner_id,attempt_id,state)
 VALUES(NEW.id,'workflow-terminal:'||NEW.id::text,NEW.forge_url,NEW.repository_id,NEW.owner_id,NEW.attempt_id,NEW.state)
 ON CONFLICT(run_id) DO NOTHING RETURNING * INTO event;
 IF NOT FOUND THEN RETURN NEW; END IF;
 INSERT INTO golf_webhook_deliveries(id,subscription_id,subscription_version,epoch,event_id,event_topic,payload)
 SELECT gen_random_uuid(),s.id,s.version,s.epoch,event.event_id,'actions',
 convert_to(jsonb_build_object('schema','golf.webhook.v1','event','workflow.run.terminal','producer','golf.workflow_notification_events',
 'event_id',event.event_id,'repository_id',event.repository_id::text,'owner_id',event.owner_id::text,
 'run_id',event.run_id::text,'attempt_id',NULLIF(event.attempt_id,''),'state',event.state,'occurred_at',event.observed_at)::text,'UTF8')
 FROM golf_webhook_subscriptions s
 WHERE s.forge_url=NEW.forge_url AND s.repository_id=NEW.repository_id AND s.owner_id=NEW.owner_id
 AND s.enabled AND s.authorization_state='authorized' AND s.event_topics ? 'actions'
 AND (s.workflow_notifications=2 OR (s.workflow_notifications=3 AND NEW.state IN ('failed','timed_out'))) ORDER BY s.id;
 INSERT INTO golf_email_deliveries(id,user_id,kind,contact_version,subscription_id,subscription_version,epoch,event_id,event_topic,transport_id,transport_version,activation_generation)
 SELECT gen_random_uuid(),s.user_id,'activity',s.contact_version,s.id,s.version,s.epoch,event.event_id,'actions',cfg.transport_id,cfg.transport_version,cfg.generation
 FROM golf_email_subscriptions s JOIN golf_email_contacts c ON c.user_id=s.user_id CROSS JOIN golf_email_configuration cfg
 WHERE s.forge_url=NEW.forge_url AND s.repository_id=NEW.repository_id AND s.owner_id=NEW.owner_id
 AND s.enabled AND s.authorization_state='authorized' AND s.event_topics ? 'actions'
 AND (s.workflow_notifications=2 OR (s.workflow_notifications=3 AND NEW.state IN ('failed','timed_out')))
 AND c.enabled AND c.verified_at IS NOT NULL AND c.suppression='' AND c.version=s.contact_version AND c.credential_version=s.credential_version ORDER BY s.id;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_workflow_terminal_notifications AFTER UPDATE OF state ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_workflow_terminal_notifications();
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Workflow notification consent and effect history require forward recovery; downgrade refused'; END $$;
-- +goose StatementEnd
