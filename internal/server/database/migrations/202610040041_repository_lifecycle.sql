-- +goose Up
-- Golf metadata-only archive intent. Passwords and native response bodies are never retained.
CREATE TABLE golf_repository_lifecycle_operations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES golf_users(id),
 forge_url text NOT NULL,
 actor_id bigint NOT NULL CHECK(actor_id>0),
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 repository_id bigint NOT NULL CHECK(repository_id>0),
 owner_id bigint NOT NULL CHECK(owner_id>0),
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 expected_revision text NOT NULL CHECK(expected_revision ~ '^[a-f0-9]{64}$'),
 from_archived boolean NOT NULL,
 to_archived boolean NOT NULL,
 fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,idempotency_key),
 CHECK((phase='REJECTED')=(failure_code='preflight_refused')),
 CHECK(phase<>'SUCCEEDED' OR from_archived<>to_archived)
);
CREATE UNIQUE INDEX golf_repository_lifecycle_unresolved ON golf_repository_lifecycle_operations(forge_url,repository_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE INDEX golf_repository_lifecycle_history ON golf_repository_lifecycle_operations(forge_url,repository_id,id DESC);
CREATE TABLE golf_repository_lifecycle_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation_id bigint NOT NULL REFERENCES golf_repository_lifecycle_operations(id),
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(operation_id,phase)
);
CREATE TRIGGER golf_repository_lifecycle_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_lifecycle_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_repository_lifecycle_operations_no_delete BEFORE DELETE OR TRUNCATE ON golf_repository_lifecycle_operations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementBegin
CREATE FUNCTION golf_repository_lifecycle_lock(f text,r bigint,exclusive boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF exclusive THEN PERFORM pg_advisory_xact_lock(hashtextextended(f||'/repository-lifecycle/'||r::text,0));
 ELSE PERFORM pg_advisory_xact_lock_shared(hashtextextended(f||'/repository-lifecycle/'||r::text,0)); END IF;
END; $$;
CREATE FUNCTION golf_repository_lifecycle_blocked(f text,r bigint) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM golf_repository_lifecycle_operations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))
 OR COALESCE((SELECT to_archived FROM golf_repository_lifecycle_operations WHERE forge_url=f AND repository_id=r AND phase='SUCCEEDED' ORDER BY id DESC LIMIT 1),false);
$$;
CREATE FUNCTION golf_repository_lifecycle_active(f text,r bigint) RETURNS bigint LANGUAGE sql AS $$
 SELECT sum(n)::bigint FROM (
 SELECT count(*) n FROM golf_workflow_runs WHERE forge_url=f AND repository_id=r AND state IN ('queued','running')
 UNION ALL SELECT count(*) FROM golf_agent_tasks WHERE forge_url=f AND repository_id=r AND state IN ('queued','running')
 UNION ALL SELECT count(*) FROM golf_reviewer_runs x JOIN golf_reviewers v ON v.id=x.reviewer_id WHERE v.forge_url=f AND v.repository_id=r AND (x.state IN ('admitting','queued','running','publishing','publication_unknown') OR x.legacy_effect_block)
 UNION ALL SELECT count(*) FROM golf_push_materializations x JOIN golf_repository_events e ON e.id=x.event_id JOIN golf_repository_event_connections c ON c.id=e.connection_id WHERE c.forge_url=f AND c.repository_id=r AND x.state IN ('pending','preparing')
 UNION ALL SELECT count(*) FROM golf_issue_mutations x JOIN golf_users u ON u.id=x.user_id WHERE u.forge_url=f AND x.repository_id=r AND x.state='OUTCOME_UNKNOWN'
 UNION ALL SELECT count(*) FROM golf_pull_review_mutations x JOIN golf_users u ON u.id=x.user_id WHERE u.forge_url=f AND x.repository_id=r AND x.state='OUTCOME_UNKNOWN'
 UNION ALL SELECT count(*) FROM golf_reviewer_publications WHERE forge_url=f AND repository_id=r AND state IN ('reserved','dispatch_unknown')
 UNION ALL SELECT count(*) FROM golf_inline_review_mutations WHERE forge_url=f AND repository_id=r AND phase IN ('RESERVED','DISPATCH_UNKNOWN')
 ) counts;
$$;
CREATE FUNCTION golf_repository_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  -- Exact-key replay reaches ON CONFLICT without granting a new dispatch.
  IF EXISTS(SELECT 1 FROM golf_repository_lifecycle_operations WHERE user_id=NEW.user_id AND idempotency_key=NEW.idempotency_key) THEN RETURN NEW; END IF;
  PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,true);
  IF NEW.phase<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Invalid lifecycle actor/reservation'; END IF;
  IF EXISTS(SELECT 1 FROM golf_repository_lifecycle_operations WHERE forge_url=NEW.forge_url AND repository_id=NEW.repository_id AND phase IN ('RESERVED','DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Lifecycle outcome unresolved' USING ERRCODE='55000'; END IF;
 ELSE
  PERFORM golf_repository_lifecycle_lock(NEW.forge_url,NEW.repository_id,true);
  IF (to_jsonb(NEW)-ARRAY['phase','failure_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','failure_code','updated_at']) OR
   NOT (OLD.phase='RESERVED' AND NEW.phase IN ('DISPATCH_UNKNOWN','REJECTED') OR OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase='SUCCEEDED') THEN RAISE EXCEPTION 'Lifecycle identity/terminal outcome immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_repository_lifecycle_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO golf_repository_lifecycle_events(operation_id,phase) VALUES(NEW.id,NEW.phase);
 IF NEW.phase='SUCCEEDED' THEN PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'source'); END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION golf_repository_lifecycle_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f text; r bigint; live boolean;
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'golf_workflow_runs','golf_agent_tasks' THEN f:=NEW.forge_url;r:=NEW.repository_id;live:=NEW.state IN ('queued','running');
 WHEN 'golf_reviewer_runs' THEN SELECT forge_url,repository_id INTO f,r FROM golf_reviewers WHERE id=NEW.reviewer_id;live:=NEW.state IN ('admitting','queued','running','publishing','publication_unknown');
 WHEN 'golf_push_materializations' THEN SELECT c.forge_url,c.repository_id INTO f,r FROM golf_repository_events e JOIN golf_repository_event_connections c ON c.id=e.connection_id WHERE e.id=NEW.event_id;live:=NEW.state IN ('pending','preparing');
 WHEN 'golf_issue_mutations','golf_pull_review_mutations' THEN SELECT forge_url INTO f FROM golf_users WHERE id=NEW.user_id;r:=NEW.repository_id;live:=NEW.state='OUTCOME_UNKNOWN';
 WHEN 'golf_reviewer_publications' THEN f:=NEW.forge_url;r:=NEW.repository_id;live:=NEW.state IN ('reserved','dispatch_unknown');
 WHEN 'golf_inline_review_mutations' THEN f:=NEW.forge_url;r:=NEW.repository_id;live:=NEW.phase IN ('RESERVED','DISPATCH_UNKNOWN');
 ELSE RAISE EXCEPTION 'Unknown lifecycle admission family';
 END CASE;
 IF live THEN
  IF f IS NULL OR r IS NULL OR r<=0 THEN RAISE EXCEPTION 'Unbound lifecycle admission'; END IF;
  PERFORM golf_repository_lifecycle_lock(f,r,false);
  IF golf_repository_lifecycle_blocked(f,r) THEN RAISE EXCEPTION 'Repository lifecycle blocks new or active work' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER golf_repository_lifecycle_guard BEFORE INSERT OR UPDATE ON golf_repository_lifecycle_operations FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_guard();
CREATE TRIGGER golf_repository_lifecycle_event AFTER INSERT OR UPDATE ON golf_repository_lifecycle_operations FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_event();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_agent_tasks FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_reviewer_runs FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_push_materializations FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_issue_mutations FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_pull_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_reviewer_publications FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
CREATE TRIGGER golf_lifecycle_admission BEFORE INSERT OR UPDATE ON golf_inline_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_repository_lifecycle_admission();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Lifecycle history/admission fences require explicitly qualified offline recovery; no automatic downgrade'; END $$;
-- +goose StatementEnd
