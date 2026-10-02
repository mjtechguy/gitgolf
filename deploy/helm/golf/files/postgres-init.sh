#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=golf_password="$GOLF_DB_PASSWORD" --set=gitea_password="$GITEA_DB_PASSWORD" <<'SQL'
CREATE USER golf WITH PASSWORD :'golf_password';
CREATE USER gitea WITH PASSWORD :'gitea_password';
CREATE DATABASE golf OWNER golf;
CREATE DATABASE gitea OWNER gitea;
REVOKE CONNECT ON DATABASE golf FROM PUBLIC;
REVOKE CONNECT ON DATABASE gitea FROM PUBLIC;
GRANT CONNECT ON DATABASE golf TO golf;
GRANT CONNECT ON DATABASE gitea TO gitea;
SQL
