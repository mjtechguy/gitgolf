-- +goose Up
-- Bounded latest-created delivery observation for the exact active SMTP version
-- and activation generation. No message, recipient or private content is indexed.
CREATE INDEX golf_email_deliveries_configuration_latest ON golf_email_deliveries
 (transport_id,transport_version,activation_generation,created_at DESC,id DESC)
 INCLUDE(state,attempts,smtp_status,possible_duplicate,completed_at);
-- +goose Down
DROP INDEX golf_email_deliveries_configuration_latest;
