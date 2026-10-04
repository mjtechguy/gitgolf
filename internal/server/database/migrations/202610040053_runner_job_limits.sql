-- +goose Up
CREATE TABLE golf_instance_runner_limits (
 forge_url text PRIMARY KEY, version bigint NOT NULL CHECK(version>=0),
 cpu_millis integer NOT NULL CHECK(cpu_millis BETWEEN 100 AND 1000),
 memory_bytes bigint NOT NULL CHECK(memory_bytes BETWEEN 67108864 AND 268435456),
 pids integer NOT NULL CHECK(pids BETWEEN 16 AND 64),
 timeout_seconds integer NOT NULL CHECK(timeout_seconds BETWEEN 1 AND 900),
 actor_user_id bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE golf_instance_runner_limit_audit (
 forge_url text NOT NULL, version bigint NOT NULL CHECK(version>0), actor_user_id bigint NOT NULL,
 cpu_millis integer NOT NULL, memory_bytes bigint NOT NULL, pids integer NOT NULL, timeout_seconds integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(forge_url,version)
);
ALTER TABLE golf_runner_pools ADD COLUMN cpu_millis integer NOT NULL DEFAULT 1000 CHECK(cpu_millis BETWEEN 100 AND 1000), ADD COLUMN memory_bytes bigint NOT NULL DEFAULT 268435456 CHECK(memory_bytes BETWEEN 67108864 AND 268435456), ADD COLUMN pids integer NOT NULL DEFAULT 64 CHECK(pids BETWEEN 16 AND 64), ADD COLUMN timeout_seconds integer NOT NULL DEFAULT 900 CHECK(timeout_seconds BETWEEN 1 AND 900);
ALTER TABLE golf_repository_runner_placements ADD COLUMN cpu_millis integer NOT NULL DEFAULT 1000 CHECK(cpu_millis BETWEEN 100 AND 1000), ADD COLUMN memory_bytes bigint NOT NULL DEFAULT 268435456 CHECK(memory_bytes BETWEEN 67108864 AND 268435456), ADD COLUMN pids integer NOT NULL DEFAULT 64 CHECK(pids BETWEEN 16 AND 64), ADD COLUMN timeout_seconds integer NOT NULL DEFAULT 900 CHECK(timeout_seconds BETWEEN 1 AND 900);
ALTER TABLE golf_runner_pool_audit ADD COLUMN cpu_millis integer NOT NULL DEFAULT 1000, ADD COLUMN memory_bytes bigint NOT NULL DEFAULT 268435456, ADD COLUMN pids integer NOT NULL DEFAULT 64, ADD COLUMN timeout_seconds integer NOT NULL DEFAULT 900;
ALTER TABLE golf_runner_placement_audit ADD COLUMN cpu_millis integer NOT NULL DEFAULT 1000, ADD COLUMN memory_bytes bigint NOT NULL DEFAULT 268435456, ADD COLUMN pids integer NOT NULL DEFAULT 64, ADD COLUMN timeout_seconds integer NOT NULL DEFAULT 900;
-- Existing attempts deliberately remain unbound: neither credentials nor source may be released.
ALTER TABLE golf_workflow_runs ADD COLUMN resource_bound boolean NOT NULL DEFAULT false, ADD COLUMN resource_instance_version bigint NOT NULL DEFAULT 0 CHECK(resource_instance_version>=0), ADD COLUMN resource_cpu_millis integer NOT NULL DEFAULT 1000 CHECK(resource_cpu_millis BETWEEN 100 AND 1000), ADD COLUMN resource_memory_bytes bigint NOT NULL DEFAULT 268435456 CHECK(resource_memory_bytes BETWEEN 67108864 AND 268435456), ADD COLUMN resource_pids integer NOT NULL DEFAULT 64 CHECK(resource_pids BETWEEN 16 AND 64), ADD COLUMN resource_timeout_seconds integer NOT NULL DEFAULT 900 CHECK(resource_timeout_seconds BETWEEN 1 AND 900);
-- +goose StatementBegin
CREATE FUNCTION golf_runner_limit_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.forge_url<>OLD.forge_url OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid retained instance runner limit transition' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_runner_resource_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i golf_instance_runner_limits%ROWTYPE;p golf_runner_pools%ROWTYPE;a golf_repository_runner_placements%ROWTYPE;
BEGIN
 -- Short concurrent read lock is taken only by final SQL admission, after native proofs.
 -- Instance edits acquire no run/pool/placement locks, so there is no reverse dependency.
 SELECT * INTO i FROM golf_instance_runner_limits WHERE forge_url=NEW.forge_url FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Instance runner ceilings were not initialized' USING ERRCODE='55000'; END IF;
 NEW.resource_bound:=true; NEW.resource_instance_version:=i.version;
 NEW.resource_cpu_millis:=i.cpu_millis;NEW.resource_memory_bytes:=i.memory_bytes;NEW.resource_pids:=i.pids;NEW.resource_timeout_seconds:=i.timeout_seconds;
 IF NEW.runner_pool_id IS NOT NULL THEN
  SELECT * INTO p FROM golf_runner_pools WHERE forge_url=NEW.forge_url AND id=NEW.runner_pool_id;
  IF NOT FOUND OR p.version<>NEW.runner_pool_version THEN RAISE EXCEPTION 'Runner pool resource observation changed' USING ERRCODE='55000'; END IF;
  NEW.resource_cpu_millis:=LEAST(NEW.resource_cpu_millis,p.cpu_millis);NEW.resource_memory_bytes:=LEAST(NEW.resource_memory_bytes,p.memory_bytes);NEW.resource_pids:=LEAST(NEW.resource_pids,p.pids);NEW.resource_timeout_seconds:=LEAST(NEW.resource_timeout_seconds,p.timeout_seconds);
 END IF;
 SELECT * INTO a FROM golf_repository_runner_placements WHERE forge_url=NEW.forge_url AND repository_id=NEW.repository_id;
 IF FOUND THEN
  IF a.owner_id<>NEW.owner_id OR a.version<>NEW.runner_placement_version THEN RAISE EXCEPTION 'Runner placement resource observation changed' USING ERRCODE='55000'; END IF;
  NEW.resource_cpu_millis:=LEAST(NEW.resource_cpu_millis,a.cpu_millis);NEW.resource_memory_bytes:=LEAST(NEW.resource_memory_bytes,a.memory_bytes);NEW.resource_pids:=LEAST(NEW.resource_pids,a.pids);NEW.resource_timeout_seconds:=LEAST(NEW.resource_timeout_seconds,a.timeout_seconds);
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION golf_runner_resource_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
 IF NEW.resource_bound IS DISTINCT FROM OLD.resource_bound OR NEW.resource_instance_version<>OLD.resource_instance_version OR NEW.resource_cpu_millis<>OLD.resource_cpu_millis OR NEW.resource_memory_bytes<>OLD.resource_memory_bytes OR NEW.resource_pids<>OLD.resource_pids OR NEW.resource_timeout_seconds<>OLD.resource_timeout_seconds THEN RAISE EXCEPTION 'Admitted runner resource snapshot is immutable' USING ERRCODE='55000'; END IF;
 IF OLD.state='queued' AND NEW.state='running' THEN
  SELECT version INTO v FROM golf_instance_runner_limits WHERE forge_url=NEW.forge_url FOR SHARE;
  IF NOT FOUND OR NOT NEW.resource_bound OR v<>NEW.resource_instance_version THEN RAISE EXCEPTION 'Runner resource admission changed' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_runner_limit_record_guard BEFORE UPDATE OR DELETE ON golf_instance_runner_limits FOR EACH ROW EXECUTE FUNCTION golf_runner_limit_record_guard();
CREATE TRIGGER golf_runner_resource_admission BEFORE INSERT ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_runner_resource_admission();
CREATE TRIGGER golf_runner_resource_snapshot_guard BEFORE UPDATE ON golf_workflow_runs FOR EACH ROW EXECUTE FUNCTION golf_runner_resource_snapshot_guard();
CREATE TRIGGER golf_runner_limits_no_truncate BEFORE TRUNCATE ON golf_instance_runner_limits FOR EACH STATEMENT EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_limit_audit_retained BEFORE UPDATE OR DELETE ON golf_instance_runner_limit_audit FOR EACH ROW EXECUTE FUNCTION golf_runner_pool_history_guard();
CREATE TRIGGER golf_runner_limit_audit_no_truncate BEFORE TRUNCATE ON golf_instance_runner_limit_audit FOR EACH STATEMENT EXECUTE FUNCTION golf_runner_pool_history_guard();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_instance_runner_limits WHERE version>0) OR EXISTS(SELECT 1 FROM golf_instance_runner_limit_audit) OR EXISTS(SELECT 1 FROM golf_workflow_runs WHERE resource_bound) THEN RAISE EXCEPTION 'Retained resource admission requires qualified forward recovery' USING ERRCODE='55000'; END IF;
END $$;
-- +goose StatementEnd
DROP TRIGGER golf_runner_resource_admission ON golf_workflow_runs;DROP TRIGGER golf_runner_resource_snapshot_guard ON golf_workflow_runs;
DROP FUNCTION golf_runner_resource_admission();DROP FUNCTION golf_runner_resource_snapshot_guard();
DROP TABLE golf_instance_runner_limits,golf_instance_runner_limit_audit;
DROP FUNCTION golf_runner_limit_record_guard();
ALTER TABLE golf_workflow_runs DROP COLUMN resource_bound,DROP COLUMN resource_instance_version,DROP COLUMN resource_cpu_millis,DROP COLUMN resource_memory_bytes,DROP COLUMN resource_pids,DROP COLUMN resource_timeout_seconds;
ALTER TABLE golf_runner_pools DROP COLUMN cpu_millis,DROP COLUMN memory_bytes,DROP COLUMN pids,DROP COLUMN timeout_seconds;
ALTER TABLE golf_repository_runner_placements DROP COLUMN cpu_millis,DROP COLUMN memory_bytes,DROP COLUMN pids,DROP COLUMN timeout_seconds;
ALTER TABLE golf_runner_pool_audit DROP COLUMN cpu_millis,DROP COLUMN memory_bytes,DROP COLUMN pids,DROP COLUMN timeout_seconds;
ALTER TABLE golf_runner_placement_audit DROP COLUMN cpu_millis,DROP COLUMN memory_bytes,DROP COLUMN pids,DROP COLUMN timeout_seconds;
