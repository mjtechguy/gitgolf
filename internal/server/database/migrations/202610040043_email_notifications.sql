-- +goose Up
CREATE TABLE golf_notification_contents (
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('transport','contact','subscription','mail')),
 encrypted_content bytea NOT NULL CHECK(octet_length(encrypted_content) BETWEEN 1 AND 32768),
 content_binding bytea NOT NULL CHECK(octet_length(content_binding)=32),credential_key_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER golf_notification_active_key BEFORE INSERT OR UPDATE OF encrypted_content,credential_key_id ON golf_notification_contents FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TABLE golf_email_transports (
 id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 host text NOT NULL CHECK(length(host) BETWEEN 1 AND 253),port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
 tls_mode text NOT NULL CHECK(tls_mode IN ('implicit','starttls','operator_plaintext')),
 content_id uuid NOT NULL REFERENCES golf_notification_contents(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(id,version)
);
CREATE TABLE golf_email_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),transport_id uuid,transport_version bigint,
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),FOREIGN KEY(transport_id,transport_version) REFERENCES golf_email_transports(id,version),
 CHECK((transport_id IS NULL)=(transport_version IS NULL))
);
INSERT INTO golf_email_configuration(singleton) VALUES(true);
CREATE TABLE golf_email_contacts (
 user_id bigint PRIMARY KEY REFERENCES golf_users(id),local_account_id bigint NOT NULL REFERENCES golf_local_accounts(id),native_user_id bigint NOT NULL CHECK(native_user_id>0),
 credential_version bigint NOT NULL CHECK(credential_version>0),version bigint NOT NULL CHECK(version>0),
 content_id uuid NOT NULL REFERENCES golf_notification_contents(id),mailbox_hash bytea NOT NULL CHECK(octet_length(mailbox_hash)=32),
 preference_version bigint NOT NULL DEFAULT 1 CHECK(preference_version>0),verified_at timestamptz,enabled boolean NOT NULL DEFAULT false,suppression text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE golf_email_challenges (
 id uuid PRIMARY KEY,user_id bigint NOT NULL REFERENCES golf_users(id),contact_version bigint NOT NULL CHECK(contact_version>0),
 code_hash bytea NOT NULL CHECK(octet_length(code_hash)=32),attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL,confirmed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX golf_email_challenge_rate ON golf_email_challenges(user_id,created_at);
CREATE TABLE golf_email_subscriptions (
 id uuid PRIMARY KEY,user_id bigint NOT NULL REFERENCES golf_users(id),forge_url text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,repository_name text NOT NULL,local_account_id bigint NOT NULL REFERENCES golf_local_accounts(id),native_user_id bigint NOT NULL CHECK(native_user_id>0),
 credential_version bigint NOT NULL CHECK(credential_version>0),contact_version bigint NOT NULL CHECK(contact_version>0),version bigint NOT NULL CHECK(version>0),epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
 event_topics jsonb NOT NULL CHECK(jsonb_typeof(event_topics)='array' AND jsonb_array_length(event_topics) BETWEEN 1 AND 4 AND event_topics <@ '["source","issues","pulls","actions"]'::jsonb),
 enabled boolean NOT NULL,authorization_state text NOT NULL CHECK(authorization_state IN ('authorized','disabled','authority_unavailable','unsubscribed')),
 unsubscribe_hash bytea NOT NULL CHECK(octet_length(unsubscribe_hash)=32),content_id uuid NOT NULL REFERENCES golf_notification_contents(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(user_id,forge_url,repository_id,owner_id)
);
CREATE INDEX golf_email_subscriptions_scope ON golf_email_subscriptions(forge_url,repository_id,id) WHERE enabled;
CREATE TABLE golf_email_deliveries (
 id uuid PRIMARY KEY,user_id bigint NOT NULL REFERENCES golf_users(id),kind text NOT NULL CHECK(kind IN ('verification','activity')),
 contact_version bigint NOT NULL CHECK(contact_version>0),subscription_id uuid REFERENCES golf_email_subscriptions(id),subscription_version bigint NOT NULL DEFAULT 0,epoch bigint NOT NULL DEFAULT 0,
 challenge_id uuid REFERENCES golf_email_challenges(id),event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 128),event_topic text NOT NULL CHECK(event_topic IN ('source','issues','pulls','actions','verification')),
 transport_id uuid,transport_version bigint,activation_generation bigint NOT NULL CHECK(activation_generation>=0),
 content_id uuid REFERENCES golf_notification_contents(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retrying','accepted','failed','cancelled','suppressed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6),next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid,lease_until timestamptz,smtp_status integer NOT NULL DEFAULT 0 CHECK(smtp_status BETWEEN 0 AND 599),failure_code text NOT NULL DEFAULT '',possible_duplicate boolean NOT NULL DEFAULT false,
 redelivery_of uuid REFERENCES golf_email_deliveries(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 FOREIGN KEY(transport_id,transport_version) REFERENCES golf_email_transports(id,version),
 CHECK((kind='verification' AND challenge_id IS NOT NULL AND subscription_id IS NULL) OR (kind='activity' AND challenge_id IS NULL AND subscription_id IS NOT NULL))
);
CREATE UNIQUE INDEX golf_email_event_once ON golf_email_deliveries(user_id,event_id,subscription_id) WHERE redelivery_of IS NULL;
CREATE INDEX golf_email_deliveries_due ON golf_email_deliveries(next_attempt_at,id) WHERE state IN ('queued','retrying','sending');
CREATE INDEX golf_email_deliveries_own ON golf_email_deliveries(user_id,created_at DESC,id DESC);
CREATE TABLE golf_email_attempts (
 delivery_id uuid NOT NULL REFERENCES golf_email_deliveries(id),attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 6),lease_id uuid NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,smtp_status integer NOT NULL DEFAULT 0,outcome text NOT NULL DEFAULT 'sending',PRIMARY KEY(delivery_id,attempt)
);
CREATE TABLE golf_email_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id bigint REFERENCES golf_users(id),action text NOT NULL,object_id uuid,version bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- +goose StatementBegin
CREATE FUNCTION golf_notification_content_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.kind,NEW.content_binding,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.content_binding,OLD.created_at) THEN RAISE EXCEPTION 'Immutable notification private content'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_notification_content_identity BEFORE UPDATE ON golf_notification_contents FOR EACH ROW EXECUTE FUNCTION golf_notification_content_identity();
CREATE FUNCTION golf_email_subscription_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.user_id,NEW.forge_url,NEW.repository_id,NEW.owner_id,NEW.local_account_id,NEW.native_user_id) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.forge_url,OLD.repository_id,OLD.owner_id,OLD.local_account_id,OLD.native_user_id) OR NEW.version<OLD.version OR NEW.epoch<OLD.epoch THEN RAISE EXCEPTION 'Immutable email subscriber and repository'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_email_subscription_identity BEFORE UPDATE ON golf_email_subscriptions FOR EACH ROW EXECUTE FUNCTION golf_email_subscription_identity();
CREATE FUNCTION golf_email_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.user_id,NEW.kind,NEW.contact_version,NEW.subscription_id,NEW.subscription_version,NEW.epoch,NEW.challenge_id,NEW.event_id,NEW.event_topic,NEW.transport_id,NEW.transport_version,NEW.activation_generation,NEW.redelivery_of,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.kind,OLD.contact_version,OLD.subscription_id,OLD.subscription_version,OLD.epoch,OLD.challenge_id,OLD.event_id,OLD.event_topic,OLD.transport_id,OLD.transport_version,OLD.activation_generation,OLD.redelivery_of,OLD.created_at) OR OLD.content_id IS NOT NULL AND NEW.content_id IS DISTINCT FROM OLD.content_id THEN RAISE EXCEPTION 'Immutable email dispatch inputs'; END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended('golf-email-queue:'||NEW.user_id::text,0));
  IF NEW.transport_id IS NULL THEN NEW.state:='failed';NEW.failure_code:='transport_unconfigured';NEW.completed_at:=clock_timestamp();
  ELSIF (SELECT count(*) FROM golf_email_deliveries WHERE user_id=NEW.user_id AND state IN ('queued','retrying','sending'))>=200 THEN NEW.state:='failed';NEW.failure_code:='queue_capacity';NEW.completed_at:=clock_timestamp(); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_email_delivery_identity BEFORE INSERT OR UPDATE ON golf_email_deliveries FOR EACH ROW EXECUTE FUNCTION golf_email_delivery_identity();
CREATE FUNCTION golf_email_local_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL) OR OLD.credential_version<>NEW.credential_version THEN
 UPDATE golf_email_contacts SET enabled=false,verified_at=NULL,suppression='credential_changed',updated_at=clock_timestamp() WHERE local_account_id=NEW.id;
 UPDATE golf_email_subscriptions SET enabled=false,authorization_state='authority_unavailable',epoch=epoch+1,updated_at=clock_timestamp() WHERE local_account_id=NEW.id AND enabled;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_email_local_revocation AFTER UPDATE OF disabled_at,credential_version ON golf_local_accounts FOR EACH ROW EXECUTE FUNCTION golf_email_local_revocation();
CREATE FUNCTION golf_email_activity_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.recipient_user_id<>0 OR NEW.topic NOT IN ('source','issues','pulls','actions') THEN RETURN NEW; END IF;
 INSERT INTO golf_email_deliveries(id,user_id,kind,contact_version,subscription_id,subscription_version,epoch,event_id,event_topic,transport_id,transport_version,activation_generation)
 SELECT gen_random_uuid(),s.user_id,'activity',s.contact_version,s.id,s.version,s.epoch,'activity:'||NEW.id::text,NEW.topic,cfg.transport_id,cfg.transport_version,cfg.generation
 FROM golf_email_subscriptions s JOIN golf_email_contacts c ON c.user_id=s.user_id CROSS JOIN golf_email_configuration cfg
 WHERE s.forge_url=NEW.forge_url AND s.repository_id=NEW.repository_id AND s.enabled AND s.authorization_state='authorized' AND s.event_topics ? NEW.topic
 AND c.enabled AND c.verified_at IS NOT NULL AND c.suppression='' AND c.version=s.contact_version AND c.credential_version=s.credential_version ORDER BY s.id;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_email_activity_outbox AFTER INSERT ON golf_repository_activity FOR EACH ROW EXECUTE FUNCTION golf_email_activity_outbox();
-- +goose StatementEnd
CREATE TRIGGER golf_email_transports_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_email_transports FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_email_events_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_email_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_email_contents_no_delete BEFORE DELETE OR TRUNCATE ON golf_notification_contents FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_email_deliveries_no_delete BEFORE DELETE OR TRUNCATE ON golf_email_deliveries FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_email_attempts_no_delete BEFORE DELETE OR TRUNCATE ON golf_email_attempts FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
ALTER TABLE golf_crypto_events ADD COLUMN notification_contents_count bigint NOT NULL DEFAULT 0 CHECK(notification_contents_count>=0);
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Notification private content and external effect history require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd
