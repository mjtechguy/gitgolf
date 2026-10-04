-- +goose Up
CREATE TABLE golf_webhook_subscriptions (
 id uuid PRIMARY KEY,forge_url text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,repository_name text NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 version bigint NOT NULL CHECK(version>0),epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),event_topics jsonb NOT NULL,
 enabled boolean NOT NULL,authorization_state text NOT NULL CHECK(authorization_state IN ('authorized','disabled','authority_unavailable')),
 sponsor_user_id bigint NOT NULL REFERENCES golf_users(id),sponsor_native_id bigint NOT NULL CHECK(sponsor_native_id>0),
 local_account_id bigint NOT NULL REFERENCES golf_local_accounts(id),credential_version bigint NOT NULL CHECK(credential_version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(event_topics)='array' AND jsonb_array_length(event_topics) BETWEEN 1 AND 4 AND event_topics <@ '["source","issues","pulls","actions"]'::jsonb)
);
CREATE INDEX golf_webhook_scope ON golf_webhook_subscriptions(forge_url,repository_id,id);
CREATE TABLE golf_webhook_credentials (
 subscription_id uuid NOT NULL REFERENCES golf_webhook_subscriptions(id),version bigint NOT NULL CHECK(version>0),destination_host text NOT NULL,
 encrypted_credential bytea NOT NULL,credential_binding bytea NOT NULL CHECK(octet_length(credential_binding)=32),credential_key_id text NOT NULL,
 PRIMARY KEY(subscription_id,version)
);
CREATE TRIGGER golf_webhook_active_key BEFORE INSERT OR UPDATE OF encrypted_credential,credential_key_id ON golf_webhook_credentials FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TABLE golf_webhook_deliveries (
 id uuid PRIMARY KEY,subscription_id uuid NOT NULL REFERENCES golf_webhook_subscriptions(id),subscription_version bigint NOT NULL,epoch bigint NOT NULL,
 event_id text NOT NULL,event_topic text NOT NULL,payload bytea NOT NULL CHECK(octet_length(payload)<=16384),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retrying','accepted','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6),response_status integer NOT NULL DEFAULT 0 CHECK(response_status BETWEEN 0 AND 599),
 failure_code text NOT NULL DEFAULT '',possible_duplicate boolean NOT NULL DEFAULT false,next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid,lease_until timestamptz,operation_id uuid,operation_fingerprint bytea CHECK(operation_fingerprint IS NULL OR octet_length(operation_fingerprint)=32),requested_by bigint REFERENCES golf_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 FOREIGN KEY(subscription_id,subscription_version) REFERENCES golf_webhook_credentials(subscription_id,version)
);
CREATE UNIQUE INDEX golf_webhook_original_event ON golf_webhook_deliveries(subscription_id,event_id) WHERE operation_id IS NULL;
CREATE UNIQUE INDEX golf_webhook_explicit_operation ON golf_webhook_deliveries(requested_by,operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX golf_webhook_subscription_pending ON golf_webhook_deliveries(subscription_id) WHERE state IN ('queued','retrying','sending');
CREATE INDEX golf_webhook_due ON golf_webhook_deliveries(next_attempt_at,id) WHERE state IN ('queued','retrying','sending');
CREATE TABLE golf_webhook_attempts (
 delivery_id uuid NOT NULL REFERENCES golf_webhook_deliveries(id),attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 6),lease_id uuid NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,response_status integer NOT NULL DEFAULT 0,
 outcome text NOT NULL DEFAULT 'sending',PRIMARY KEY(delivery_id,attempt)
);
-- +goose StatementBegin
CREATE FUNCTION golf_webhook_subscription_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.forge_url,NEW.repository_id,NEW.owner_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.forge_url,OLD.repository_id,OLD.owner_id,OLD.created_at) OR NEW.version<OLD.version OR NEW.epoch<OLD.epoch THEN RAISE EXCEPTION 'Immutable webhook subscription target'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_webhook_subscription_identity BEFORE UPDATE ON golf_webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION golf_webhook_subscription_identity();
CREATE FUNCTION golf_webhook_local_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL) OR NEW.credential_version<>OLD.credential_version THEN
  UPDATE golf_webhook_subscriptions SET enabled=false,authorization_state='authority_unavailable',epoch=epoch+1,updated_at=clock_timestamp() WHERE local_account_id=NEW.id AND enabled;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_webhook_local_revocation AFTER UPDATE OF disabled_at,credential_version ON golf_local_accounts FOR EACH ROW EXECUTE FUNCTION golf_webhook_local_revocation();
CREATE FUNCTION golf_webhook_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.subscription_id,NEW.subscription_version,NEW.epoch,NEW.event_id,NEW.event_topic,NEW.payload,NEW.operation_id,NEW.operation_fingerprint,NEW.requested_by,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.subscription_id,OLD.subscription_version,OLD.epoch,OLD.event_id,OLD.event_topic,OLD.payload,OLD.operation_id,OLD.operation_fingerprint,OLD.requested_by,OLD.created_at) THEN RAISE EXCEPTION 'Immutable webhook event and dispatch identity'; END IF;
  RETURN NEW;
 END IF;
 -- Serialize only this subscription. Over-capacity events retain a terminal
 -- history record; capacity never silently drops the originating activity.
 PERFORM pg_advisory_xact_lock(hashtextextended('golf-webhook-queue:'||NEW.subscription_id::text,0));
 IF (SELECT count(*) FROM golf_webhook_deliveries WHERE subscription_id=NEW.subscription_id AND state IN ('queued','retrying','sending'))>=200 THEN
  NEW.state:='failed';NEW.failure_code:='queue_capacity';NEW.completed_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_webhook_delivery_guard BEFORE INSERT OR UPDATE ON golf_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION golf_webhook_delivery_guard();
CREATE FUNCTION golf_webhook_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.recipient_user_id<>0 OR NEW.topic NOT IN ('source','issues','pulls','actions') THEN RETURN NEW; END IF;
 -- The shared activity is a committed change observation, not a semantic claim
 -- that a push/CI/review/deployment finished. Never fan out private agent events.
 INSERT INTO golf_webhook_deliveries(id,subscription_id,subscription_version,epoch,event_id,event_topic,payload)
 SELECT gen_random_uuid(),s.id,s.version,s.epoch,'activity:'||NEW.id::text,NEW.topic,
 convert_to(jsonb_build_object('schema','golf.webhook.v1','event','repository.activity.'||NEW.topic,'event_id','activity:'||NEW.id::text,
 'producer','golf.repository_activity','repository_id',NEW.repository_id::text,'occurred_at',NEW.created_at)::text,'UTF8')
 FROM golf_webhook_subscriptions s WHERE s.forge_url=NEW.forge_url AND s.repository_id=NEW.repository_id AND s.enabled AND s.authorization_state='authorized' AND s.event_topics ? NEW.topic ORDER BY s.id;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_webhook_activity_outbox AFTER INSERT ON golf_repository_activity FOR EACH ROW EXECUTE FUNCTION golf_webhook_outbox();
CREATE FUNCTION golf_webhook_credential_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.subscription_id,NEW.version,NEW.destination_host,NEW.credential_binding) IS DISTINCT FROM ROW(OLD.subscription_id,OLD.version,OLD.destination_host,OLD.credential_binding) THEN RAISE EXCEPTION 'Immutable webhook credential identity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_webhook_credential_identity BEFORE UPDATE ON golf_webhook_credentials FOR EACH ROW EXECUTE FUNCTION golf_webhook_credential_identity();
-- +goose StatementEnd
CREATE TABLE golf_webhook_configuration_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,subscription_id uuid NOT NULL REFERENCES golf_webhook_subscriptions(id),
 version bigint NOT NULL,sponsor_user_id bigint NOT NULL REFERENCES golf_users(id),enabled boolean NOT NULL,event_topics jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(subscription_id,version)
);
CREATE TRIGGER golf_webhook_config_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_webhook_configuration_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_webhook_deliveries_no_delete BEFORE DELETE OR TRUNCATE ON golf_webhook_deliveries FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_webhook_credentials_no_delete BEFORE DELETE OR TRUNCATE ON golf_webhook_credentials FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_webhook_attempts_no_delete BEFORE DELETE OR TRUNCATE ON golf_webhook_attempts FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
ALTER TABLE golf_crypto_events ADD COLUMN webhook_credentials_count bigint NOT NULL DEFAULT 0 CHECK(webhook_credentials_count>=0);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Webhook credentials and external effect history require coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd
