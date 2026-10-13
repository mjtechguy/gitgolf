#!/usr/bin/env python3
"""Create the private environment for a fresh Forgejo installation."""
import base64
import os
from pathlib import Path
import secrets
import uuid

def main():
    path = Path(__file__).resolve().parents[1] / '.env'
    values = {name:secrets.token_hex(24) for name in ('POSTGRES_PASSWORD','GOLF_DB_PASSWORD','FORGEJO_DB_PASSWORD')}
    values.update(GOLF_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),GOLF_FORGE_INSTANCE_ID=str(uuid.uuid4()))
    try:
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError:
        print('.env exists; preserved unchanged.')
        return
    with os.fdopen(fd,'w') as file:
        file.write(''.join(f'{name}={value}\n' for name,value in values.items()))
    print('Created private .env for the golf-forgejo project. Back it up securely.')

if __name__=='__main__': main()
