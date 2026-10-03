#!/usr/bin/env python3
"""Qualify the pinned Codex sandbox without provider credentials or inference."""
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Already built local sha256 image ID')
    args = parser.parse_args()
    assert re.fullmatch(r'sha256:[a-f0-9]{64}', args.image)
    profile = ROOT/'deploy/docker/codex/seccomp.json'
    policy = json.loads(profile.read_text())
    assert policy['defaultAction'] == 'SCMP_ACT_ERRNO'
    assert policy['syscalls'][-3]['names'] == ['mount', 'umount2', 'pivot_root']
    assert policy['syscalls'][-2]['args'] == [{'index': 0, 'value': 268435456, 'op': 'SCMP_CMP_EQ'}]
    assert policy['syscalls'][-1]['names'] == ['clone']
    assert policy['syscalls'][-1]['args'] == [
        {'index': 0, 'value': 1040318464, 'valueTwo': 939655168, 'op': 'SCMP_CMP_MASKED_EQ'}]
    command = ['docker', 'run', '--rm', '--pull=never', '--network=bridge', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp='+str(profile),
        '--pids-limit=128', '--memory=536870912', '--memory-swap=536870912', '--cpus=1',
        '--tmpfs=/tmp:size=67108864,mode=1777',
        '--tmpfs=/auth:uid=1000,gid=1000,mode=0700,size=16777216',
        '--tmpfs=/workspace:uid=1000,gid=1000,mode=0700,size=67108864', args.image]
    result = subprocess.run([*command, '--version'], capture_output=True, timeout=30)
    assert result.returncode == 0 and result.stdout.strip() == b'codex-cli 0.160.0'
    script = '''set -eu
test "$(id -u)" = 1000
printf checked > /workspace/check
if touch /auth/should-deny 2>/dev/null; then exit 21; fi
if touch /etc/should-deny 2>/dev/null; then exit 22; fi
node -e 'const net=require("net");const s=net.connect({host:"1.1.1.1",port:443});s.on("connect",()=>process.exit(23));s.on("error",e=>process.exit(["EPERM","EACCES","ENETUNREACH"].includes(e.code)?0:24));setTimeout(()=>process.exit(25),2000);'
'''
    result = subprocess.run([*command, '-c', 'sandbox_mode="workspace-write"',
        'sandbox', '--', '/bin/sh', '-c', script], capture_output=True, timeout=30)
    assert result.returncode == 0, 'Native sandbox qualification failed; diagnostics withheld'
    print('PASS: Codex0.160.0 nonroot workspace write; auth/root write and sandbox network denial; resources removed')


if __name__ == '__main__':
    main()
