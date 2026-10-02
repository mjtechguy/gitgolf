#!/usr/bin/env python3
"""Create private local RustFS credentials without changing existing deployment keys."""
import os
from pathlib import Path
import secrets

def main():
    target=Path(__file__).resolve().parents[1]/'.env.storage'
    try:
        fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError:
        print('Private .env.storage already exists; preserving RustFS credentials.')
        return
    with os.fdopen(fd,'w') as out:
        out.write('RUSTFS_ACCESS_KEY=golf-local-'+secrets.token_hex(12)+'\n')
        out.write('RUSTFS_SECRET_KEY='+secrets.token_urlsafe(48)+'\n')
    print('Created private .env.storage. Keep it with the deployment backup; do not commit it.')

if __name__=='__main__':main()
