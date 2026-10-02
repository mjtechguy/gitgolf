#!/usr/bin/env python3
"""Enroll the opt-in local qualification worker without changing execution policy."""
import base64
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = 'alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0'

def main():
    target = ROOT / '.env.ci'
    key = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=')
    values = {
        'GOLF_RUNNER_KEY': key,
        'GOLF_RUNNER_KEYS': json.dumps({'local-docker': key}, separators=(',', ':')),
        'GOLF_RUNNER_IMAGES': json.dumps({'linux': IMAGE}, separators=(',', ':')),
        'GOLF_RUNNER_JOB_IMAGE': IMAGE,
        'GOLF_RUNNER_APPROVED_IMAGES': json.dumps([IMAGE], separators=(',', ':')),
    }
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print('Private .env.ci already exists; preserving enrolled worker credentials.')
        return
    with os.fdopen(fd, 'w') as out:
        for name, value in values.items():
            out.write(f"{name}='{value}'\n")
    print('Created private .env.ci. Execution policies remain disabled until explicitly configured.')

if __name__ == '__main__':
    main()
