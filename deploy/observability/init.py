#!/usr/bin/env python3
"""Create local monitoring secrets without printing them or overwriting files."""
import os
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parents[2]


def initialize(directory):
    # Compose dotenv uses literal single-quoted absolute file paths.
    assert directory.is_absolute() and not any(c in str(directory) for c in "'\r\n"), 'Unsupported directory characters'
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    token = secrets.token_hex(32)
    # Compose file-backed secrets preserve host permissions. The 0700 parent
    # protects these files on the host; 0444 lets non-root container UIDs read
    # their individual read-only secret mount without running as host root.
    for name, value in [('metrics-token', token), ('grafana-password', secrets.token_urlsafe(32))]:
        path = directory / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
        path.chmod(0o444)
    env = directory / 'monitoring.env'
    # Values are generated hex or absolute paths. Quote paths for Compose's
    # dotenv parser; reject quote/newline rather than inventing a shell codec.
    fd = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(f"GOLF_METRICS_TOKEN={token}\nGOLF_METRICS_TOKEN_FILE='{directory / 'metrics-token'}'\n"
                     f"GOLF_GRAFANA_PASSWORD_FILE='{directory / 'grafana-password'}'\n")
    return token


if __name__ == '__main__':
    try:
        initialize(ROOT / '.tmp' / 'observability')
    except FileExistsError:
        raise SystemExit('Monitoring directory already exists; existing secrets were not changed.')
    print('Created private .tmp/observability; see deploy/observability/README.md to start.')
