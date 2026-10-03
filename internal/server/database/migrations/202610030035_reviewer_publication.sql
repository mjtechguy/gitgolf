-- +goose Up
ALTER TABLE golf_reviewer_runs ADD COLUMN repository_id bigint;
ALTER TABLE golf_reviewer_runs ADD COLUMN pull_request_id bigint;
ALTER TABLE golf_reviewer_runs ADD COLUMN merge_base_commit text;
ALTER TABLE golf_reviewer_runs ADD COLUMN diff_fingerprint bytea;
ALTER TABLE golf_reviewer_runs ADD COLUMN legacy_effect_block boolean NOT NULL DEFAULT false;
-- Old outdated rows may have erased a publication_unknown effect. No native
-- PR/review identity or reconstructed dispatch history is invented here.
UPDATE golf_reviewer_runs SET legacy_effect_block=true WHERE state IN ('publishing','publication_unknown','outdated');
ALTER TABLE golf_reviewer_runs ADD CONSTRAINT golf_reviewer_comparison CHECK (
 (repository_id IS NULL AND pull_request_id IS NULL AND merge_base_commit IS NULL AND diff_fingerprint IS NULL)
 OR (repository_id IS NOT NULL AND pull_request_id IS NOT NULL AND merge_base_commit IS NOT NULL AND diff_fingerprint IS NOT NULL AND repository_id>0 AND pull_request_id>0 AND merge_base_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$' AND length(merge_base_commit)=length(head_commit) AND octet_length(diff_fingerprint)=32));
CREATE TABLE golf_reviewer_publications (
 run_id uuid PRIMARY KEY REFERENCES golf_reviewer_runs(id),
 forge_url text NOT NULL,
 repository_id bigint NOT NULL CHECK(repository_id>0),
 pull_request_id bigint NOT NULL CHECK(pull_request_id>0),
 pull_number bigint NOT NULL CHECK(pull_number BETWEEN 1 AND 2147483647),
 publisher_id bigint NOT NULL CHECK(publisher_id>0),
 payload_fingerprint bytea NOT NULL CHECK(octet_length(payload_fingerprint)=32),
 state text NOT NULL CHECK(state IN ('reserved','dispatch_unknown','published','rejected')),
 observed_review_id bigint CHECK(observed_review_id>0),
 failure_code text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(state<>'published' OR observed_review_id IS NOT NULL),
 UNIQUE(forge_url,repository_id,pull_request_id,run_id)
);
CREATE UNIQUE INDEX golf_reviewer_unresolved_publication ON golf_reviewer_publications(forge_url,publisher_id,repository_id,pull_request_id) WHERE state IN ('reserved','dispatch_unknown');
CREATE TABLE golf_reviewer_publication_events (
 id bigserial PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES golf_reviewer_publications(run_id),
 phase text NOT NULL CHECK(phase IN ('reserved','dispatch_unknown','receipt','published','rejected','uncertain')),
 observed_review_id bigint CHECK(observed_review_id>0),
 failure_code text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- +goose StatementBegin
CREATE FUNCTION golf_guard_reviewer_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reviewer publication evidence cannot be deleted'; END IF;
 IF ROW(NEW.run_id,NEW.forge_url,NEW.repository_id,NEW.pull_request_id,NEW.pull_number,NEW.publisher_id,NEW.payload_fingerprint,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.run_id,OLD.forge_url,OLD.repository_id,OLD.pull_request_id,OLD.pull_number,OLD.publisher_id,OLD.payload_fingerprint,OLD.created_at) THEN RAISE EXCEPTION 'Immutable reviewer publication'; END IF;
 IF OLD.observed_review_id IS NOT NULL AND NEW.observed_review_id IS DISTINCT FROM OLD.observed_review_id THEN RAISE EXCEPTION 'Immutable reviewer receipt'; END IF;
 IF OLD.state='reserved' AND NEW.state NOT IN ('reserved','dispatch_unknown','rejected') THEN RAISE EXCEPTION 'Reviewer publication must record dispatch'; END IF;
 IF OLD.state IN ('published','rejected') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal reviewer publication'; END IF;
 IF OLD.state='dispatch_unknown' AND NEW.state NOT IN ('dispatch_unknown','published') THEN RAISE EXCEPTION 'Uncertain reviewer effect cannot be released'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_reviewer_publication_guard BEFORE UPDATE OR DELETE ON golf_reviewer_publications FOR EACH ROW EXECUTE FUNCTION golf_guard_reviewer_publication();
CREATE FUNCTION golf_guard_reviewer_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reviewer run evidence cannot be deleted'; END IF;
 IF ROW(NEW.id,NEW.reviewer_id,NEW.reviewer_revision,NEW.pull_number,NEW.base_commit,NEW.head_commit,NEW.intent,NEW.diff,NEW.publisher_id,NEW.created_at,NEW.repository_id,NEW.pull_request_id,NEW.merge_base_commit,NEW.diff_fingerprint,NEW.legacy_effect_block)
 IS DISTINCT FROM ROW(OLD.id,OLD.reviewer_id,OLD.reviewer_revision,OLD.pull_number,OLD.base_commit,OLD.head_commit,OLD.intent,OLD.diff,OLD.publisher_id,OLD.created_at,OLD.repository_id,OLD.pull_request_id,OLD.merge_base_commit,OLD.diff_fingerprint,OLD.legacy_effect_block) THEN RAISE EXCEPTION 'Immutable reviewer run selection'; END IF;
 IF EXISTS(SELECT 1 FROM golf_reviewer_publications WHERE run_id=OLD.id AND state='reserved') AND NEW.state NOT IN ('queued','running') THEN RAISE EXCEPTION 'Reserved reviewer run cannot be superseded'; END IF;
 IF EXISTS(SELECT 1 FROM golf_reviewer_publications WHERE run_id=OLD.id AND state='dispatch_unknown') AND NEW.state NOT IN ('publishing','publication_unknown') THEN RAISE EXCEPTION 'Unresolved reviewer run cannot be superseded'; END IF;
 IF OLD.state='published' AND NEW.state<>'published' THEN RAISE EXCEPTION 'Published reviewer effect is historical'; END IF;
 IF OLD.state IN ('publishing','publication_unknown','published') AND NEW.state NOT IN ('publishing','publication_unknown','published') THEN RAISE EXCEPTION 'Reviewer effect cannot become outdated'; END IF;
 IF EXISTS(SELECT 1 FROM golf_reviewer_publications WHERE run_id=OLD.id) AND NEW.findings IS DISTINCT FROM OLD.findings THEN RAISE EXCEPTION 'Frozen reviewer publication inputs'; END IF;
 IF OLD.review_id IS NOT NULL AND NEW.review_id IS DISTINCT FROM OLD.review_id THEN RAISE EXCEPTION 'Immutable reviewer native receipt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_reviewer_run_snapshot_guard BEFORE UPDATE OR DELETE ON golf_reviewer_runs FOR EACH ROW EXECUTE FUNCTION golf_guard_reviewer_run_snapshot();
CREATE FUNCTION golf_guard_reviewer_publication_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only reviewer publication events'; END $$;
CREATE TRIGGER golf_reviewer_publication_event_guard BEFORE UPDATE OR DELETE ON golf_reviewer_publication_events FOR EACH ROW EXECUTE FUNCTION golf_guard_reviewer_publication_event();
CREATE TRIGGER golf_reviewer_publications_no_truncate BEFORE TRUNCATE ON golf_reviewer_publications FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_reviewer_runs_no_truncate BEFORE TRUNCATE ON golf_reviewer_runs FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_reviewer_publication_events_no_truncate BEFORE TRUNCATE ON golf_reviewer_publication_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Reviewer publication history requires coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd
