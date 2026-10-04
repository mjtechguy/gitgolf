-- +goose Up
CREATE TABLE golf_runner_pools (
 forge_url text NOT NULL, id uuid NOT NULL,
 name text NOT NULL CHECK(octet_length(name) BETWEEN 1 AND 128),
 runtime text NOT NULL CHECK(runtime='local-docker'),
 state text NOT NULL CHECK(state IN ('active','draining')),
 max_parallel_attempts integer NOT NULL CHECK(max_parallel_attempts BETWEEN 1 AND 100),
 repository_assignment_enabled boolean NOT NULL,
 version bigint NOT NULL CHECK(version>0), actor_user_id bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,id), UNIQUE(forge_url,name)
);
CREATE TABLE golf_runner_pool_workers (
 forge_url text NOT NULL, runner_id text NOT NULL CHECK(runner_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'), pool_id uuid NOT NULL,
 PRIMARY KEY(forge_url,runner_id), FOREIGN KEY(forge_url,pool_id) REFERENCES golf_runner_pools(forge_url,id)
);
CREATE TABLE golf_repository_runner_placements (
 forge_url text NOT NULL, repository_id bigint NOT NULL CHECK(repository_id>0), owner_id bigint NOT NULL CHECK(owner_id>0),
 version bigint NOT NULL CHECK(version>0), pool_id uuid, selected_pool_version bigint,
 actor_user_id bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(forge_url,repository_id), FOREIGN KEY(forge_url,pool_id) REFERENCES golf_runner_pools(forge_url,id),
 CHECK((pool_id IS NULL AND selected_pool_version IS NULL) OR (pool_id IS NOT NULL AND selected_pool_version IS NOT NULL AND selected_pool_version>0))
);
CREATE TABLE golf_runner_pool_audit (
 forge_url text NOT NULL,pool_id uuid NOT NULL,version bigint NOT NULL,actor_user_id bigint NOT NULL,
 name text NOT NULL,state text NOT NULL,max_parallel_attempts integer NOT NULL,
 repository_assignment_enabled boolean NOT NULL,worker_ids text[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(forge_url,pool_id,version),
 FOREIGN KEY(forge_url,pool_id) REFERENCES golf_runner_pools(forge_url,id)
);
CREATE TABLE golf_runner_placement_audit (
 forge_url text NOT NULL,repository_id bigint NOT NULL,owner_id bigint NOT NULL,version bigint NOT NULL,
 actor_user_id bigint NOT NULL,pool_id uuid,selected_pool_version bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(forge_url,repository_id,version)
);
ALTER TABLE golf_workflow_runs ADD COLUMN runner_pool_id uuid;
ALTER TABLE golf_workflow_runs ADD COLUMN runner_pool_version bigint;
ALTER TABLE golf_workflow_runs ADD COLUMN runner_placement_version bigint NOT NULL DEFAULT 0 CHECK(runner_placement_version>=0);
ALTER TABLE golf_workflow_runs ADD CONSTRAINT golf_workflow_runner_pool_binding CHECK((runner_pool_id IS NULL AND runner_pool_version IS NULL) OR (runner_pool_id IS NOT NULL AND runner_pool_version IS NOT NULL AND runner_pool_version>0));
CREATE INDEX golf_workflow_pool_attempts ON golf_workflow_runs(forge_url,runner_pool_id) WHERE state='running';
-- +goose StatementBegin
CREATE FUNCTION golf_runner_pool_lock(f text,p uuid) RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended(f||'/runner-pool/'||p::text,0)); $$;
CREATE FUNCTION golf_runner_placement_lock(f text,r bigint) RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended(f||'/runner-placement/'||r::text,0)); $$;
CREATE FUNCTION golf_runner_pool_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.forge_url<>OLD.forge_url OR NEW.id<>OLD.id OR NEW.runtime<>OLD.runtime OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid retained runner pool transition' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_runner_placement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.forge_url<>OLD.forge_url OR NEW.repository_id<>OLD.repository_id OR NEW.owner_id<>OLD.owner_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid retained runner placement transition' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_runner_pool_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Runner pool history is retained' USING ERRCODE='55000'; END $$;
CREATE FUNCTION golf_runner_pool_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f text; w text;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Replace runner pool membership explicitly' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN f:=OLD.forge_url;w:=OLD.runner_id; ELSE f:=NEW.forge_url;w:=NEW.runner_id; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/runner/'||w,0));
 IF EXISTS(SELECT 1 FROM golf_workflow_runs WHERE forge_url=f AND runner_id=w AND state='running') THEN RAISE EXCEPTION 'Busy runner membership cannot move' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION golf_runner_pool_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a golf_repository_runner_placements%ROWTYPE; p golf_runner_pools%ROWTYPE;
BEGIN
 PERFORM golf_runner_placement_lock(NEW.forge_url,NEW.repository_id);
 SELECT * INTO a FROM golf_repository_runner_placements WHERE forge_url=NEW.forge_url AND repository_id=NEW.repository_id;
 NEW.runner_pool_id:=NULL;NEW.runner_pool_version:=NULL;NEW.runner_placement_version:=0;
 IF FOUND THEN
  IF a.owner_id<>NEW.owner_id THEN RAISE EXCEPTION 'Runner placement owner changed' USING ERRCODE='55000'; END IF;
  NEW.runner_placement_version:=a.version;
  IF a.pool_id IS NOT NULL THEN
   PERFORM golf_runner_pool_lock(NEW.forge_url,a.pool_id);
   SELECT * INTO p FROM golf_runner_pools WHERE forge_url=NEW.forge_url AND id=a.pool_id;
   IF NOT FOUND OR p.runtime<>'local-docker' OR NOT p.repository_assignment_enabled OR p.state<>'active' THEN RAISE EXCEPTION 'Runner pool admission unavailable' USING ERRCODE='55000'; END IF;
   NEW.runner_pool_id:=p.id;NEW.runner_pool_version:=p.version;
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- Candidate filtering is an optimization; claim rechecks current configuration/capacity under locks.
CREATE FUNCTION golf_runner_pool_candidate(f text,r uuid,w text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN x.runner_pool_id IS NULL THEN NOT EXISTS(SELECT 1 FROM golf_runner_pool_workers m WHERE m.forge_url=f AND m.runner_id=w)
 ELSE EXISTS(SELECT 1 FROM golf_runner_pool_workers m WHERE m.forge_url=f AND m.runner_id=w AND m.pool_id=x.runner_pool_id) END FROM golf_workflow_runs x WHERE x.forge_url=f AND x.id=r;
$$;
CREATE FUNCTION golf_runner_pool_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a golf_repository_runner_placements%ROWTYPE;p golf_runner_pools%ROWTYPE;v bigint:=0;assigned uuid;
BEGIN
 IF NEW.runner_pool_id IS DISTINCT FROM OLD.runner_pool_id OR NEW.runner_pool_version IS DISTINCT FROM OLD.runner_pool_version OR NEW.runner_placement_version<>OLD.runner_placement_version THEN RAISE EXCEPTION 'Admitted runner placement is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.state='queued' AND NEW.state='running' THEN
  IF NEW.runner_id IS NULL OR NEW.runner_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' THEN RAISE EXCEPTION 'Runner identity is required' USING ERRCODE='55000'; END IF;
  PERFORM golf_runner_placement_lock(NEW.forge_url,NEW.repository_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.forge_url||'/runner/'||NEW.runner_id,0));
  IF EXISTS(SELECT 1 FROM golf_runner_controls WHERE forge_url=NEW.forge_url AND runner_id=NEW.runner_id AND state<>'active') THEN RAISE EXCEPTION 'Enrolled runner control refused' USING ERRCODE='55000'; END IF;
  SELECT pool_id INTO assigned FROM golf_runner_pool_workers WHERE forge_url=NEW.forge_url AND runner_id=NEW.runner_id;
  IF assigned IS DISTINCT FROM NEW.runner_pool_id THEN RAISE EXCEPTION 'Runner pool placement mismatch' USING ERRCODE='55000'; END IF;
  SELECT * INTO a FROM golf_repository_runner_placements WHERE forge_url=NEW.forge_url AND repository_id=NEW.repository_id;
  IF FOUND THEN v:=a.version; IF a.owner_id<>NEW.owner_id OR a.pool_id IS DISTINCT FROM NEW.runner_pool_id THEN RAISE EXCEPTION 'Runner placement changed' USING ERRCODE='55000'; END IF; END IF;
  IF v<>NEW.runner_placement_version THEN RAISE EXCEPTION 'Runner placement version changed' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM golf_workflow_runs WHERE forge_url=NEW.forge_url AND runner_id=NEW.runner_id AND state='running' AND id<>NEW.id) THEN RAISE EXCEPTION 'Runner already busy' USING ERRCODE='55000'; END IF;
  IF assigned IS NOT NULL THEN
   PERFORM golf_runner_pool_lock(NEW.forge_url,assigned);
   SELECT * INTO p FROM golf_runner_pools WHERE forge_url=NEW.forge_url AND id=assigned;
   IF NOT FOUND OR p.version<>NEW.runner_pool_version OR p.state<>'active' OR NOT p.repository_assignment_enabled OR p.runtime<>'local-docker' THEN RAISE EXCEPTION 'Runner pool configuration changed' USING ERRCODE='55000'; END IF;
   IF (SELECT count(*) FROM golf_workflow_runs WHERE forge_url=NEW.forge_url AND runner_pool_id=assigned AND state='running' AND id<>NEW.id)>=p.max_parallel_attempts THEN RAISE EXCEPTION 'Runner pool is at capacity' USING ERRCODE='55000'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_runner_pool_record_guard BEFORE UPDATE OR DELETE ON golf_runner_pools FOR EACH ROW EXECUTE FUNCTION golf_runner_pool_record_guard();
CREATE TRIGGER golf_runner_placement_guard BEFORE UPDATE OR DELETE ON golf_repository_runner_placements FOR EACH ROW EXECUTE FUNCTION golf_runner_placement_guard();
CREATE TRIGGER golf_runner_pool_member_guard BEFORE INSERT OR UPDATE OR DELETE ON golf_runner_pool_workers FOR EACH ROW EXECUTE FUNCTION golf_runner_pool_member_guard();
CREATE TRIGGER golf_runner_pool_admission BEFORE INSERT ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_runner_pool_admission();
CREATE TRIGGER golf_runner_pool_claim_guard BEFORE UPDATE ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_runner_pool_claim_guard();
CREATE TRIGGER golf_runner_pool_audit_retained BEFORE UPDATE OR DELETE ON golf_runner_pool_audit FOR EACH ROW EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_pool_audit_no_truncate BEFORE TRUNCATE ON golf_runner_pool_audit EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_placement_audit_retained BEFORE UPDATE OR DELETE ON golf_runner_placement_audit FOR EACH ROW EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_placement_audit_no_truncate BEFORE TRUNCATE ON golf_runner_placement_audit EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_pools_no_truncate BEFORE TRUNCATE ON golf_runner_pools EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_placements_no_truncate BEFORE TRUNCATE ON golf_repository_runner_placements EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_pool_workers_no_truncate BEFORE TRUNCATE ON golf_runner_pool_workers EXECUTE FUNCTION golf_runner_pool_history_guard();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_runner_pools) OR EXISTS(SELECT 1 FROM golf_repository_runner_placements) OR EXISTS(SELECT 1 FROM golf_workflow_runs WHERE runner_pool_id IS NOT NULL OR runner_placement_version<>0) THEN RAISE EXCEPTION 'Retained runner placement requires qualified forward recovery' USING ERRCODE='55000'; END IF;
END $$;
-- +goose StatementEnd
DROP TRIGGER golf_runner_pool_admission ON golf_workflow_runs;
DROP TRIGGER golf_runner_pool_claim_guard ON golf_workflow_runs;
DROP FUNCTION golf_runner_pool_admission();DROP FUNCTION golf_runner_pool_claim_guard();DROP FUNCTION golf_runner_pool_candidate(text,uuid,text);
ALTER TABLE golf_workflow_runs DROP COLUMN runner_pool_id,DROP COLUMN runner_pool_version,DROP COLUMN runner_placement_version;
DROP TABLE golf_runner_pool_audit,golf_runner_placement_audit,golf_runner_pool_workers,golf_repository_runner_placements,golf_runner_pools;
DROP FUNCTION golf_runner_pool_record_guard();DROP FUNCTION golf_runner_placement_guard();DROP FUNCTION golf_runner_pool_history_guard();DROP FUNCTION golf_runner_pool_member_guard();DROP FUNCTION golf_runner_pool_lock(text,uuid);DROP FUNCTION golf_runner_placement_lock(text,bigint);
