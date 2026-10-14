#!/usr/bin/env python3
"""Build/load the exact local reviewer image; preserve an enrolled private bot token.

Supply a separately enrolled publishing token through --publisher-token-stdin on
first setup. No credential is printed or passed in a subprocess argument.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--publisher-token-stdin', action='store_true')
args = parser.parse_args()
path = ROOT / '.env.review'
existing = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#')) if path.exists() else {}
token = sys.stdin.read().strip() if args.publisher_token_stdin else existing.get('GOLF_REVIEW_PUBLISHER_TOKEN', '')
if not re.fullmatch(r'[A-Za-z0-9_-]{8,512}', token):
    sys.exit('Enroll a private nonadministrator publishing bot and supply its token via --publisher-token-stdin.')
subprocess.run(['docker', 'build', '-f', 'deploy/docker/Dockerfile.opencode', '-t', 'golf-opencode-review:local', '.'], cwd=ROOT, check=True)
image = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'golf-opencode-review:local'], cwd=ROOT, text=True).strip()
if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
    sys.exit('Exact native runtime identity could not be verified.')
save = subprocess.Popen(['docker', 'image', 'save', 'golf-opencode-review:local'], cwd=ROOT, stdout=subprocess.PIPE)
loaded = subprocess.run(['docker', 'exec', '-i', 'golf-runner-daemon-1', 'docker', 'image', 'load'], cwd=ROOT, stdin=save.stdout, capture_output=True)
save.stdout.close()
if loaded.returncode or save.wait():
    sys.exit('Cannot load into the local dedicated runner daemon; start the existing Compose runner profile first.')
# Exclusive, private staging file followed by an atomic replacement.
temporary = path.with_suffix('.review.tmp')
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, 'w') as file:
        file.write(f'GOLF_REVIEW_IMAGE={image}\nGOLF_REVIEW_PUBLISHER_TOKEN={token}\n')
    os.replace(temporary, path)
finally:
    temporary.unlink(missing_ok=True)
print('Exact reviewer runtime loaded; private publishing enrollment preserved. Run make local-up to reload the services.')
