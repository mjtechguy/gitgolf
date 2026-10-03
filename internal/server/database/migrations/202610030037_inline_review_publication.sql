-- +goose Up
-- Private text/source remain in immutable encrypted 036 comparison/SAVE records.
-- The exact FK retains those records for verification, rotation and recovery.
CREATE TABLE golf_inline_review_mutations (
 operation_id uuid NOT NULL,
 user_id bigint NOT NULL REFERENCES golf_users(id),
 forge_url text NOT NULL,
 actor_id bigint NOT NULL CHECK(actor_id>0),
 repository_id bigint NOT NULL CHECK(repository_id>0),
 pull_request_id bigint NOT NULL CHECK(pull_request_id>0),
 pull_number integer NOT NULL CHECK(pull_number>0),
 repository_owner text NOT NULL,
 repository_name text NOT NULL,
 draft_id uuid NOT NULL,
 draft_version bigint NOT NULL CHECK(draft_version>0),
 target_generation bigint NOT NULL CHECK(target_generation>0),
 comparison_id uuid NOT NULL REFERENCES golf_review_contents(id),
 request_fingerprint bytea NOT NULL CHECK(octet_length(request_fingerprint)=32),
 payload_fingerprint bytea NOT NULL CHECK(octet_length(payload_fingerprint)=32),
 expected_revision text NOT NULL CHECK(expected_revision ~ '^[a-f0-9]{64}$'),
 base_tip text NOT NULL CHECK(base_tip ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 merge_base text NOT NULL CHECK(merge_base ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 head_commit text NOT NULL CHECK(head_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
 diff_sha256 text NOT NULL CHECK(diff_sha256 ~ '^[a-f0-9]{64}$'),
 decision text NOT NULL CHECK(decision IN ('COMMENT','APPROVED','REQUEST_CHANGES')),
 entry_count integer NOT NULL CHECK(entry_count BETWEEN 0 AND 20),
 phase text NOT NULL DEFAULT 'RESERVED' CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED')),
 observed_review_id bigint NOT NULL DEFAULT 0 CHECK(observed_review_id>=0),
 verified_comment_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(verified_comment_ids)='array'),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused','native_effect_unverified')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,operation_id),
 FOREIGN KEY(draft_id,user_id,forge_url,repository_id,pull_request_id) REFERENCES golf_review_drafts(id,user_id,forge_url,repository_id,pull_request_id),
 FOREIGN KEY(draft_id,draft_version) REFERENCES golf_review_draft_versions(draft_id,version),
 CHECK(length(base_tip)=length(merge_base) AND length(base_tip)=length(head_commit)),
 CHECK((phase='SUCCEEDED' AND entry_count>0 AND observed_review_id>0 AND jsonb_array_length(verified_comment_ids)=entry_count AND failure_code='') OR
       (phase<>'SUCCEEDED' AND jsonb_array_length(verified_comment_ids)=0)),
 CHECK((phase='RESERVED' AND observed_review_id=0 AND failure_code='') OR
       (phase='DISPATCH_UNKNOWN' AND failure_code IN ('','native_effect_unverified')) OR
       (phase='REJECTED' AND observed_review_id=0 AND failure_code='preflight_refused') OR phase='SUCCEEDED')
);
-- Only a known nondispatch rejection releases the saved version. Its exact key
-- remains immutable inspection-only; a new operation is an explicit new intent.
CREATE UNIQUE INDEX golf_inline_review_version_effect ON golf_inline_review_mutations(draft_id,draft_version) WHERE phase<>'REJECTED';
CREATE INDEX golf_inline_review_unresolved ON golf_inline_review_mutations(forge_url,actor_id,repository_id,pull_request_id) WHERE phase IN ('RESERVED','DISPATCH_UNKNOWN');
CREATE TABLE golf_inline_review_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL,
 operation_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('RESERVED','DISPATCH_UNKNOWN','RECEIPT','SUCCEEDED','REJECTED','UNCERTAIN')),
 observed_review_id bigint NOT NULL DEFAULT 0 CHECK(observed_review_id>=0),
 failure_code text NOT NULL DEFAULT '' CHECK(failure_code IN ('','preflight_refused','native_effect_unverified')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(user_id,operation_id) REFERENCES golf_inline_review_mutations(user_id,operation_id),
 UNIQUE(user_id,operation_id,phase)
);
-- +goose StatementBegin
CREATE FUNCTION golf_inline_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  -- Exact-key replay must reach ON CONFLICT and the caller's fingerprint check.
  IF EXISTS(SELECT 1 FROM golf_inline_review_mutations WHERE user_id=NEW.user_id AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  PERFORM 1 FROM golf_users WHERE id=NEW.user_id FOR UPDATE;
  PERFORM 1 FROM golf_review_draft_targets WHERE user_id=NEW.user_id AND forge_url=NEW.forge_url AND repository_id=NEW.repository_id AND pull_request_id=NEW.pull_request_id FOR UPDATE;
  IF NEW.phase<>'RESERVED' OR NEW.observed_review_id<>0 OR jsonb_array_length(NEW.verified_comment_ids)<>0 OR NEW.failure_code<>'' OR NOT EXISTS(SELECT 1 FROM golf_users WHERE id=NEW.user_id AND forge_url=NEW.forge_url AND forge_user_id=NEW.actor_id) THEN RAISE EXCEPTION 'Inline publication must reserve original actor before dispatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM golf_review_drafts d JOIN golf_review_draft_versions v ON v.draft_id=d.id AND v.version=NEW.draft_version JOIN golf_review_draft_targets t ON t.user_id=d.user_id AND t.forge_url=d.forge_url AND t.repository_id=d.repository_id AND t.pull_request_id=d.pull_request_id
    WHERE d.id=NEW.draft_id AND d.user_id=NEW.user_id AND d.forge_url=NEW.forge_url AND d.repository_id=NEW.repository_id AND d.pull_request_id=NEW.pull_request_id AND d.pull_number=NEW.pull_number AND NOT d.deleted AND d.current_version=NEW.draft_version AND d.comparison_id=NEW.comparison_id AND v.kind='SAVE' AND v.accepted_generation=NEW.target_generation AND t.generation=NEW.target_generation) THEN
   RAISE EXCEPTION 'Inline publication version admission changed' USING ERRCODE='23P01';
  END IF;
 ELSE
  IF OLD.phase IN ('SUCCEEDED','REJECTED') OR
     (to_jsonb(NEW)-ARRAY['phase','observed_review_id','verified_comment_ids','failure_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','observed_review_id','verified_comment_ids','failure_code','updated_at']) OR
     (OLD.observed_review_id>0 AND NEW.observed_review_id<>OLD.observed_review_id) OR
     (OLD.phase='RESERVED' AND NEW.phase NOT IN ('DISPATCH_UNKNOWN','REJECTED')) OR
     (OLD.phase='DISPATCH_UNKNOWN' AND NEW.phase NOT IN ('DISPATCH_UNKNOWN','SUCCEEDED')) OR
     (NEW.phase='SUCCEEDED' AND OLD.observed_review_id=0) THEN RAISE EXCEPTION 'Immutable inline publication identity/effect'; END IF;
  IF NEW.phase='SUCCEEDED' AND (EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.verified_comment_ids) c WHERE c !~ '^[1-9][0-9]*$' OR c::bigint<=0) OR
     (SELECT count(DISTINCT c) FROM jsonb_array_elements_text(NEW.verified_comment_ids) c)<>NEW.entry_count) THEN RAISE EXCEPTION 'Invalid inline child proof'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_inline_review_admission BEFORE INSERT OR UPDATE ON golf_inline_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_inline_review_guard();
CREATE FUNCTION golf_inline_review_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM golf_inline_review_mutations m WHERE m.user_id=NEW.user_id AND m.operation_id=NEW.operation_id AND m.observed_review_id=NEW.observed_review_id AND m.failure_code=NEW.failure_code AND
   (NEW.phase=m.phase OR NEW.phase IN ('RECEIPT','UNCERTAIN') AND m.phase='DISPATCH_UNKNOWN')) THEN RAISE EXCEPTION 'Inline review event differs from committed journal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_inline_review_event_admission BEFORE INSERT ON golf_inline_review_events FOR EACH ROW EXECUTE FUNCTION golf_inline_review_event_guard();


-- One native-actor/target gate for human overall, human inline and managed bot.
-- The number is used to retain old legacy exclusions that have no native PR ID.
-- This orders Golf reservations only; direct native writers remain external.
CREATE FUNCTION golf_review_shared_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f text; actor bigint; repo bigint; pr bigint; num bigint;
BEGIN
 IF TG_TABLE_NAME='golf_pull_review_mutations' THEN
  IF EXISTS(SELECT 1 FROM golf_pull_review_mutations WHERE user_id=NEW.user_id AND idempotency_key=NEW.idempotency_key) THEN RETURN NEW; END IF;
  SELECT forge_url INTO f FROM golf_users WHERE id=NEW.user_id;
  actor:=NEW.actor_forge_user_id; repo:=NEW.repository_id; pr:=NEW.pull_request_id; num:=NEW.number;
 ELSIF TG_TABLE_NAME='golf_reviewer_publications' THEN
  f:=NEW.forge_url; actor:=NEW.publisher_id; repo:=NEW.repository_id; pr:=NEW.pull_request_id; num:=NEW.pull_number;
 ELSE
  IF EXISTS(SELECT 1 FROM golf_inline_review_mutations WHERE user_id=NEW.user_id AND operation_id=NEW.operation_id) THEN RETURN NEW; END IF;
  f:=NEW.forge_url; actor:=NEW.actor_id; repo:=NEW.repository_id; pr:=NEW.pull_request_id; num:=NEW.pull_number;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(f||'/review-publication/'||repo||'/'||actor||'/'||num,0));
 IF EXISTS(SELECT 1 FROM golf_pull_review_mutations m JOIN golf_users u ON u.id=m.user_id WHERE u.forge_url=f AND m.actor_forge_user_id=actor AND m.repository_id=repo AND m.pull_request_id=pr AND m.state='OUTCOME_UNKNOWN') OR
    EXISTS(SELECT 1 FROM golf_reviewer_publications p WHERE p.forge_url=f AND p.publisher_id=actor AND p.repository_id=repo AND p.pull_request_id=pr AND p.state IN ('reserved','dispatch_unknown')) OR
    EXISTS(SELECT 1 FROM golf_inline_review_mutations i WHERE i.forge_url=f AND i.actor_id=actor AND i.repository_id=repo AND i.pull_request_id=pr AND i.phase IN ('RESERVED','DISPATCH_UNKNOWN')) OR
    EXISTS(SELECT 1 FROM golf_reviewer_runs r JOIN golf_reviewers v ON v.id=r.reviewer_id WHERE v.forge_url=f AND v.repository_id=repo AND r.publisher_id=actor AND r.pull_number=num AND r.legacy_effect_block) THEN
  RAISE EXCEPTION 'Unresolved review effect blocks publication' USING ERRCODE='23P01';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_review_shared_overall BEFORE INSERT ON golf_pull_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_review_shared_admission();
CREATE TRIGGER golf_review_shared_bot BEFORE INSERT ON golf_reviewer_publications FOR EACH ROW EXECUTE FUNCTION golf_review_shared_admission();
CREATE TRIGGER golf_review_shared_inline BEFORE INSERT ON golf_inline_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_review_shared_admission();
-- Only a fully qualified native effect invalidates shared repository views.
-- Draft SAVE/DELETE, reservations, unknown receipts and refusals stay private.
CREATE FUNCTION golf_human_review_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f text;
BEGIN
 IF TG_TABLE_NAME='golf_inline_review_mutations' THEN
  IF OLD.phase<>'SUCCEEDED' AND NEW.phase='SUCCEEDED' THEN
   PERFORM golf_append_repository_activity(NEW.forge_url,NEW.repository_id,0,'pulls');
  END IF;
 ELSE
  IF OLD.state<>'SUCCEEDED' AND NEW.state='SUCCEEDED' THEN
   SELECT forge_url INTO f FROM golf_users WHERE id=NEW.user_id;
   PERFORM golf_append_repository_activity(f,NEW.repository_id,0,'pulls');
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER golf_human_inline_review_activity AFTER UPDATE ON golf_inline_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_human_review_activity();
CREATE TRIGGER golf_human_overall_review_activity AFTER UPDATE ON golf_pull_review_mutations FOR EACH ROW EXECUTE FUNCTION golf_human_review_activity();
-- +goose StatementEnd
CREATE TRIGGER golf_inline_review_no_delete BEFORE DELETE OR TRUNCATE ON golf_inline_review_mutations FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_inline_review_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_inline_review_events FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Inline review effect history requires coordinated recovery; downgrade refused'; END $$;
-- +goose StatementEnd
