-- +goose Up
-- Configuration content stays in the native forge; this journal retains only metadata.
CREATE TABLE golf_repository_rule_mutations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id),
 forge_url text NOT NULL,
 actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0),
 owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 action integer NOT NULL CHECK(action BETWEEN 1 AND 7),
 expected_access_revision text NOT NULL CHECK(expected_access_revision ~ '^[a-f0-9]{64}$'),
 expected_rules_revision text NOT NULL CHECK(expected_rules_revision ~ '^[a-f0-9]{64}$'),
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 observed_rules_revision text NOT NULL DEFAULT '' CHECK(observed_rules_revision='' OR observed_rules_revision ~ '^[a-f0-9]{64}$'),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,operation_id),
 CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK((phase='SUCCEEDED')=(observed_rules_revision<>''))
);
CREATE UNIQUE INDEX golf_repository_rule_mutations_unresolved ON golf_repository_rule_mutations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_repository_rule_mutation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 mutation_id bigint NOT NULL REFERENCES golf_repository_rule_mutations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(mutation_id,phase)
);
CREATE TRIGGER golf_rule_mutations_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_rule_mutations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_rule_mutation_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_rule_mutation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_rule_mutation_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,false);
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/repository-rules/'||r::text,0));
END; $$;
CREATE FUNCTION golf_rule_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM golf_rule_mutation_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM golf_repository_rule_mutations WHERE user_id=NEW.user_id AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid rules actor/reservation'; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_repository_rule_mutations WHERE forge_url=NEW.forge_url AND repository_id=NEW.repository_id AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Rule or lifecycle outcome unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','observed_rules_revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','observed_rules_revision','updated_at']) OR NOT (OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Rules identity/terminal phase immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_rule_mutation_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO golf_repository_rule_mutation_events(mutation_id,phase) VALUES(NEW.id,NEW.phase);
 IF NEW.phase='SUCCEEDED' THEN PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'source'); END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_rule_mutation_guard BEFORE INSERT OR UPDATE ON golf_repository_rule_mutations FOR EACH ROW EXECUTE FUNCTION golf_rule_mutation_guard();
CREATE TRIGGER golf_rule_mutation_event AFTER INSERT OR UPDATE ON golf_repository_rule_mutations FOR EACH ROW EXECUTE FUNCTION golf_rule_mutation_event();
-- Preserve the current access/invitation/execution/delivery consumers when adding
-- unresolved rule intents to the shared archive admission gate.
-- +goose StatementBegin
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_rules;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_rules(f,r)+(SELECT count(*) FROM golf_repository_rule_mutations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained rules outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd
