-- +goose Up
CREATE TABLE golf_forge_installation (
 singleton boolean PRIMARY KEY CHECK(singleton),
 kind text NOT NULL CHECK(kind IN ('gitea','forgejo')),
 origin text NOT NULL,
 instance_id text NOT NULL,
 workflow_directories text NOT NULL,
 enrolled_at timestamptz NOT NULL DEFAULT now()
);
-- +goose Down
DROP TABLE golf_forge_installation;
