#!/usr/bin/env python3
"""Create the private environment for a fresh Forgejo installation.

Optional overrides are read from the environment only when the file is first
created: COMPOSE_PROJECT_NAME, GOLF_HTTP_PORT, GOLF_FORGE_HTTP_PORT and
GOLF_FORGE_SSH_PORT. compose.yaml derives the loopback public URLs from the
ports unless GOLF_PUBLIC_URL/GOLF_FORGE_PUBLIC_URL are set explicitly.
"""
import base64
import os
from pathlib import Path
import re
import secrets
import sys
import uuid

PORTS = (('GOLF_HTTP_PORT', 8080), ('GOLF_FORGE_HTTP_PORT', 3001), ('GOLF_FORGE_SSH_PORT', 2222))


def overrides():
    values = {}
    project = os.environ.get('COMPOSE_PROJECT_NAME', '')
    if project:
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', project):
            sys.exit('COMPOSE_PROJECT_NAME must be lowercase letters, digits, "-" or "_".')
        values['COMPOSE_PROJECT_NAME'] = project
    for name, default in PORTS:
        raw = os.environ.get(name, '')
        if not raw:
            continue
        if not raw.isdigit() or not 1 <= int(raw) <= 65535:
            sys.exit(f'{name} must be a TCP port number.')
        if int(raw) != default:
            values[name] = str(int(raw))
    return values


def main():
    path = Path(__file__).resolve().parents[1] / '.env'
    values = {name:secrets.token_hex(24) for name in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD')}
    values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_FORGE_INSTANCE_ID=str(uuid.uuid4()))
    values.update(overrides())
    try:
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError:
        print('.env exists; preserved unchanged.')
        return
    with os.fdopen(fd,'w') as file:
        file.write(''.join(f'{name}={value}\n' for name,value in values.items()))
    print(f"Created private .env for the {values.get('COMPOSE_PROJECT_NAME', 'golf-forgejo')} project. Back it up securely.")

if __name__=='__main__': main()
