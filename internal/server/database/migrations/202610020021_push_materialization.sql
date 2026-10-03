-- +goose Up
-- Body signatures do not cover delivery IDs. Preserve historical receipts while
-- assigning one canonical receipt to every signed payload.
CREATE TABLE golf_repository_event_payloads (
 connection_id uuid NOT NULL REFERENCES golf_repository_event_connections(id),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
 event_id bigint NOT NULL UNIQUE REFERENCES golf_repository_events(id),
 push_admission_requested boolean NOT NULL DEFAULT false,
 PRIMARY KEY(connection_id,payload_sha256)
);
INSERT INTO golf_repository_event_payloads(connection_id,payload_sha256,event_id) SELECT connection_id,payload_sha256,min(id) FROM golf_repository_events GROUP BY connection_id,payload_sha256;
CREATE TRIGGER golf_repository_event_payloads_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON golf_repository_event_payloads FOR EACH STATEMENT EXECUTE FUNCTION golf_audit_reject_mutation();
CREATE TABLE golf_push_materializations (
 id uuid PRIMARY KEY,
 event_id bigint NOT NULL REFERENCES golf_repository_events(id),
 grant_id uuid NOT NULL REFERENCES golf_automation_grants(id),
 grant_revision bigint NOT NULL CHECK(grant_revision>0),
 grant_epoch bigint NOT NULL CHECK(grant_epoch>0),
 credential_version bigint NOT NULL CHECK(credential_version>0),
 workflow_path text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','preparing','admitted','blocked','skipped')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_id uuid,
 lease_expires_at timestamptz,
 native_activity_id bigint CHECK(native_activity_id>0),
 run_id uuid UNIQUE REFERENCES golf_workflow_runs(id),
 reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(event_id,grant_id,workflow_path),
 CHECK ((state='preparing')=(lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK ((state='admitted')=(run_id IS NOT NULL))
);
CREATE UNIQUE INDEX golf_push_materializations_native_activity ON golf_push_materializations(grant_id,native_activity_id,workflow_path) WHERE native_activity_id IS NOT NULL;
CREATE INDEX golf_push_materializations_claim ON golf_push_materializations(created_at) WHERE state IN ('pending','preparing');
-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM golf_push_materializations) THEN RAISE EXCEPTION 'Preserve push admission history before downgrade'; END IF;
END $$;
-- +goose StatementEnd
DROP TABLE golf_push_materializations;
DROP TABLE golf_repository_event_payloads;
