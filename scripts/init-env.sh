#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then
  echo '.env already exists; preserving database passwords and encryption key.'
  exit 0
fi
umask 077
# noclobber protects an existing file if two initializers race.
set -C
{
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'GOLF_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'GITEA_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'GOLF_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)"
} > .env
printf '%s\n' 'Created private .env. Back it up securely; do not commit it.'
