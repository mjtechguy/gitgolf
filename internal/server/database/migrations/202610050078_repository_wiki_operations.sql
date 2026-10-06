-- +goose Up
CREATE TABLE golf_repository_wiki_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL, actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0), repository_owner text NOT NULL, repository_name text NOT NULL,
 access_revision text NOT NULL CHECK(access_revision ~ '^[a-f0-9]{64}$'), kind integer NOT NULL CHECK(kind BETWEEN 1 AND 3),
 slug text NOT NULL, expected_commit_id text NOT NULL, input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 result_slug text NOT NULL DEFAULT '', result_commit_id text NOT NULL DEFAULT '',
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,forge_url,operation_id), CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK((kind=1 AND slug='' AND expected_commit_id='') OR (kind IN (2,3) AND slug<>'' AND expected_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$')),
 CHECK((phase='SUCCEEDED' AND kind IN (1,2) AND result_slug<>'' AND result_commit_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$') OR ((phase<>'SUCCEEDED' OR kind=3) AND result_slug='' AND result_commit_id=''))
);
CREATE UNIQUE INDEX golf_wiki_operations_unresolved ON golf_repository_wiki_operations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_repository_wiki_operation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id bigint NOT NULL REFERENCES golf_repository_wiki_operations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_wiki_operations_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_wiki_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_wiki_operation_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_wiki_operation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_wiki_operation_lock(f text,r bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(f,r,true); PERFORM pg_advisory_xact_lock(hashtextextended(f||'/wiki-operation/'||r::text,0));
END; $$;
CREATE FUNCTION golf_wiki_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_wiki_operation_lock(NEW.forge_url,NEW.repository_id);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid wiki operation reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_repository_wiki_operations WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND (repository_id=NEW.repository_id OR source_repository_id=NEW.repository_id) AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Repository operation unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','updated_at','result_slug','result_commit_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','updated_at','result_slug','result_commit_id']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Wiki operation identity/outcome immutable'; END IF;
  NEW.updated_at=greatest(clock_timestamp(),OLD.updated_at);
 END IF; RETURN NEW;
END; $$;
CREATE FUNCTION golf_wiki_operation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO golf_repository_wiki_operation_events(operation_id,phase) VALUES(NEW.id,NEW.phase); RETURN NEW;
END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_wiki_operation;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_wiki_operation(f,r)+(SELECT count(*) FROM golf_repository_wiki_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_wiki_operation;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_wiki_operation(f,r) OR EXISTS(SELECT 1 FROM golf_repository_wiki_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_wiki_operation_guard BEFORE INSERT OR UPDATE ON golf_repository_wiki_operations FOR EACH ROW EXECUTE FUNCTION golf_wiki_operation_guard();
CREATE TRIGGER golf_wiki_operation_event AFTER INSERT OR UPDATE ON golf_repository_wiki_operations FOR EACH ROW EXECUTE FUNCTION golf_wiki_operation_event();
CREATE TABLE golf_organization_label_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL REFERENCES golf_users(id), forge_url text NOT NULL, actor_id bigint NOT NULL CHECK(actor_id>0),
 operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'), organization text NOT NULL, organization_id bigint NOT NULL CHECK(organization_id>0),
 kind integer NOT NULL CHECK(kind BETWEEN 1 AND 3), label_id bigint NOT NULL CHECK(label_id>=0), expected_revision text NOT NULL,
 input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32), phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 result_label_id bigint NOT NULL DEFAULT 0 CHECK(result_label_id>=0), failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 UNIQUE(user_id,forge_url,operation_id), CHECK((kind=1 AND label_id=0 AND expected_revision='') OR (kind IN (2,3) AND label_id>0 AND expected_revision ~ '^[a-f0-9]{64}$')),
 CHECK((phase='REJECTED')=(failure_code='preflight_refused')), CHECK((phase='SUCCEEDED' AND kind IN (1,2) AND result_label_id>0) OR ((phase<>'SUCCEEDED' OR kind=3) AND result_label_id=0))
);
CREATE UNIQUE INDEX golf_org_label_unresolved ON golf_organization_label_operations(forge_url,organization_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_organization_label_operation_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id bigint NOT NULL REFERENCES golf_organization_label_operations(id),phase text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase));
CREATE TRIGGER golf_org_label_no_delete BEFORE DELETE OR TRUNCATE ON golf_organization_label_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_org_label_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_organization_label_operation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_org_label_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.forge_url||'/organization-label/'||NEW.organization_id::text,0));
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid org label reservation'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','result_label_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','result_label_id']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Org label operation immutable'; END IF;
 END IF;RETURN NEW;
END; $$;
CREATE FUNCTION golf_org_label_operation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO golf_organization_label_operation_events(operation_id,phase) VALUES(NEW.id,NEW.phase);RETURN NEW;END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_org_label_guard BEFORE INSERT OR UPDATE ON golf_organization_label_operations FOR EACH ROW EXECUTE FUNCTION golf_org_label_operation_guard();
CREATE TRIGGER golf_org_label_event AFTER INSERT OR UPDATE ON golf_organization_label_operations FOR EACH ROW EXECUTE FUNCTION golf_org_label_operation_event();
CREATE TABLE golf_repository_mirror_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id bigint NOT NULL REFERENCES golf_users(id),forge_url text NOT NULL,actor_id bigint NOT NULL CHECK(actor_id>0),operation_id text NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_owner text NOT NULL,repository_name text NOT NULL,repository_id bigint NOT NULL CHECK(repository_id>0),owner_id bigint NOT NULL CHECK(owner_id>0),expected_revision text NOT NULL CHECK(expected_revision ~ '^[a-f0-9]{64}$'),kind integer NOT NULL CHECK(kind IN (1,2)),interval_value text NOT NULL,input_fingerprint bytea NOT NULL CHECK(octet_length(input_fingerprint)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),sync_accepted boolean NOT NULL DEFAULT false,failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 UNIQUE(user_id,forge_url,operation_id),CHECK((phase='REJECTED')=(failure_code='preflight_refused')),CHECK(sync_accepted=(phase='SUCCEEDED' AND kind=2))
);
CREATE UNIQUE INDEX golf_mirror_unresolved ON golf_repository_mirror_operations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_repository_mirror_operation_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id bigint NOT NULL REFERENCES golf_repository_mirror_operations(id),phase text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,phase));
CREATE TRIGGER golf_mirror_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_mirror_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_mirror_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_mirror_operation_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_mirror_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,true);
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid mirror reservation';END IF;
  IF golf_repository_lifecycle_blocked(NEW.forge_url,NEW.repository_id) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=NEW.forge_url AND (repository_id=NEW.repository_id OR source_repository_id=NEW.repository_id) AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Repository operation unresolved';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','sync_accepted']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','sync_accepted']) OR NOT(OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Mirror operation immutable';END IF;
 END IF;RETURN NEW;
END; $$;
CREATE FUNCTION golf_mirror_operation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO golf_repository_mirror_operation_events(operation_id,phase) VALUES(NEW.id,NEW.phase);RETURN NEW;END; $$;
ALTER FUNCTION golf_repository_lifecycle_active(text,bigint) RENAME TO golf_repository_lifecycle_active_before_mirror_operation;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_active_before_mirror_operation(f,r)+(SELECT count(*) FROM golf_repository_mirror_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
ALTER FUNCTION golf_repository_lifecycle_blocked(text,bigint) RENAME TO golf_repository_lifecycle_blocked_before_mirror_operation;
CREATE OR REPLACE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT golf_repository_lifecycle_blocked_before_mirror_operation(f,r) OR EXISTS(SELECT 1 FROM golf_repository_mirror_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')); $$;
-- +goose StatementEnd
CREATE TRIGGER golf_mirror_guard BEFORE INSERT OR UPDATE ON golf_repository_mirror_operations FOR EACH ROW EXECUTE FUNCTION golf_mirror_operation_guard();
CREATE TRIGGER golf_mirror_event AFTER INSERT OR UPDATE ON golf_repository_mirror_operations FOR EACH ROW EXECUTE FUNCTION golf_mirror_operation_event();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Retained wiki outcomes require qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd
