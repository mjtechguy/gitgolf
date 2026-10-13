#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=golf_password="$GOLF_DB_PASSWORD" --set=forgejo_password="$FORGEJO_DB_PASSWORD" <<'SQL'
CREATE USER golf WITH PASSWORD :'golf_password';
CREATE USER forgejo WITH PASSWORD :'forgejo_password';
CREATE DATABASE golf OWNER golf;
CREATE DATABASE forgejo OWNER forgejo;
REVOKE CONNECT ON DATABASE golf FROM PUBLIC;
REVOKE CONNECT ON DATABASE forgejo FROM PUBLIC;
GRANT CONNECT ON DATABASE golf TO golf;
GRANT CONNECT ON DATABASE forgejo TO forgejo;
SQL
