-- +goose Up
-- Only Golf-owned private state. No native forge tables or shared activity.
CREATE TABLE golf_review_draft_targets (
    user_id bigint NOT NULL REFERENCES golf_users(id),
    forge_url text NOT NULL,
    repository_id bigint NOT NULL CHECK (repository_id > 0),
    pull_request_id bigint NOT NULL CHECK (pull_request_id > 0),
    pull_number integer NOT NULL CHECK (pull_number > 0),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    PRIMARY KEY (user_id, forge_url, repository_id, pull_request_id),
    UNIQUE (user_id, forge_url, repository_id, pull_request_id, pull_number)
);
CREATE TABLE golf_review_contents (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES golf_users(id),
    forge_url text NOT NULL,
    repository_id bigint NOT NULL CHECK (repository_id > 0),
    pull_request_id bigint NOT NULL CHECK (pull_request_id > 0),
    draft_id uuid NOT NULL,
    version bigint NOT NULL CHECK (version >= 0),
    kind text NOT NULL CHECK (kind IN ('comparison', 'operation')),
    encrypted_content bytea NOT NULL CHECK (octet_length(encrypted_content) BETWEEN 28 AND 2097152),
    content_binding bytea NOT NULL CHECK (octet_length(content_binding) = 32),
    credential_key_id text NOT NULL CHECK (credential_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((kind = 'comparison' AND version = 0) OR (kind = 'operation' AND version > 0)),
    UNIQUE (id,user_id,forge_url,repository_id,pull_request_id,draft_id,version)
);
CREATE INDEX golf_review_contents_key ON golf_review_contents(credential_key_id,id);
CREATE INDEX golf_review_contents_owner ON golf_review_contents(user_id);
CREATE TRIGGER golf_review_content_active_key BEFORE INSERT OR UPDATE OF encrypted_content,credential_key_id ON golf_review_contents
FOR EACH ROW EXECUTE FUNCTION golf_credential_active_key();
CREATE TABLE golf_review_drafts (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL,
    forge_url text NOT NULL,
    repository_id bigint NOT NULL,
    pull_request_id bigint NOT NULL,
    pull_number integer NOT NULL,
    comparison_id uuid NOT NULL UNIQUE,
    current_version bigint NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    deleted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (user_id,forge_url,repository_id,pull_request_id,pull_number) REFERENCES golf_review_draft_targets(user_id,forge_url,repository_id,pull_request_id,pull_number),
    UNIQUE (id,user_id,forge_url,repository_id,pull_request_id),
    CHECK (NOT deleted OR current_version > 0)
);
CREATE UNIQUE INDEX golf_review_draft_one_active ON golf_review_drafts(user_id,forge_url,repository_id,pull_request_id) WHERE NOT deleted;
CREATE TABLE golf_review_draft_versions (
    draft_id uuid NOT NULL,
    user_id bigint NOT NULL,
    forge_url text NOT NULL,
    repository_id bigint NOT NULL,
    pull_request_id bigint NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    operation_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('SAVE','DELETE')),
    expected_version bigint NOT NULL CHECK (expected_version >= 0 AND version = expected_version + 1),
    expected_generation bigint NOT NULL CHECK (expected_generation >= 0),
    accepted_generation bigint NOT NULL CHECK (accepted_generation = expected_generation + 1),
    content_id uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(draft_id,version),
    UNIQUE(user_id,operation_id),
    FOREIGN KEY(draft_id,user_id,forge_url,repository_id,pull_request_id) REFERENCES golf_review_drafts(id,user_id,forge_url,repository_id,pull_request_id),
    FOREIGN KEY(content_id,user_id,forge_url,repository_id,pull_request_id,draft_id,version) REFERENCES golf_review_contents(id,user_id,forge_url,repository_id,pull_request_id,draft_id,version)
);
ALTER TABLE golf_review_drafts ADD CONSTRAINT golf_review_draft_current_version FOREIGN KEY(id,current_version)
REFERENCES golf_review_draft_versions(draft_id,version) DEFERRABLE INITIALLY DEFERRED;
-- comparison has version0; bind its exact owner/target/draft scope at insertion.
-- +goose StatementBegin
CREATE FUNCTION golf_review_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM golf_review_contents c WHERE c.id=NEW.comparison_id AND c.kind='comparison' AND c.version=0 AND c.draft_id=NEW.id AND c.user_id=NEW.user_id AND c.forge_url=NEW.forge_url AND c.repository_id=NEW.repository_id AND c.pull_request_id=NEW.pull_request_id) THEN
            RAISE EXCEPTION 'Review comparison scope mismatch';
        END IF;
    ELSE
        IF OLD.deleted OR NEW.current_version <> OLD.current_version + 1 OR
           ROW(NEW.id,NEW.user_id,NEW.forge_url,NEW.repository_id,NEW.pull_request_id,NEW.pull_number,NEW.comparison_id,NEW.created_at) IS DISTINCT FROM
           ROW(OLD.id,OLD.user_id,OLD.forge_url,OLD.repository_id,OLD.pull_request_id,OLD.pull_number,OLD.comparison_id,OLD.created_at) THEN
            RAISE EXCEPTION 'Review draft identity/version is immutable';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION golf_review_target_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.user_id,NEW.forge_url,NEW.repository_id,NEW.pull_request_id,NEW.pull_number) IS DISTINCT FROM ROW(OLD.user_id,OLD.forge_url,OLD.repository_id,OLD.pull_request_id,OLD.pull_number) OR NEW.generation <> OLD.generation+1 THEN
        RAISE EXCEPTION 'Review target generation cannot reset';
    END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION golf_review_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.user_id,NEW.forge_url,NEW.repository_id,NEW.pull_request_id,NEW.draft_id,NEW.version,NEW.kind,NEW.content_binding,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.forge_url,OLD.repository_id,OLD.pull_request_id,OLD.draft_id,OLD.version,OLD.kind,OLD.content_binding,OLD.created_at) THEN
        RAISE EXCEPTION 'Review content identity is immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION golf_review_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM golf_review_drafts d JOIN golf_review_draft_targets t USING(user_id,forge_url,repository_id,pull_request_id) WHERE d.id=NEW.draft_id AND NOT d.deleted AND d.current_version=NEW.expected_version AND t.generation=NEW.expected_generation) THEN
        RAISE EXCEPTION 'Review version admission mismatch';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER golf_review_draft_identity BEFORE INSERT OR UPDATE ON golf_review_drafts FOR EACH ROW EXECUTE FUNCTION golf_review_draft_guard();
CREATE TRIGGER golf_review_target_identity BEFORE UPDATE ON golf_review_draft_targets FOR EACH ROW EXECUTE FUNCTION golf_review_target_guard();
CREATE TRIGGER golf_review_content_identity BEFORE UPDATE ON golf_review_contents FOR EACH ROW EXECUTE FUNCTION golf_review_content_guard();
CREATE TRIGGER golf_review_version_admission BEFORE INSERT ON golf_review_draft_versions FOR EACH ROW EXECUTE FUNCTION golf_review_version_guard();
CREATE TRIGGER golf_review_versions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_review_draft_versions FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_review_drafts_retained BEFORE DELETE OR TRUNCATE ON golf_review_drafts FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_review_targets_retained BEFORE DELETE OR TRUNCATE ON golf_review_draft_targets FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TRIGGER golf_review_contents_retained BEFORE DELETE OR TRUNCATE ON golf_review_contents FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
ALTER TABLE golf_crypto_events ADD COLUMN review_contents_count bigint NOT NULL DEFAULT 0 CHECK(review_contents_count >= 0);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM golf_review_draft_targets) OR EXISTS(SELECT 1 FROM golf_review_contents) THEN
        RAISE EXCEPTION 'Private review draft history prevents downgrade';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_review_draft_versions CASCADE;
DROP TABLE golf_review_drafts;
DROP TABLE golf_review_contents;
DROP TABLE golf_review_draft_targets;
DROP FUNCTION golf_review_version_guard();
DROP FUNCTION golf_review_content_guard();
DROP FUNCTION golf_review_target_guard();
DROP FUNCTION golf_review_draft_guard();
ALTER TABLE golf_crypto_events DROP COLUMN review_contents_count;
