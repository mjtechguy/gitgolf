"""Begin the approved four-hour native demo window or stop its owned supervisor."""
import argparse
import json
import os
from pathlib import Path
import signal
import stat
import hashlib
import subprocess
import sys
import datetime as dt

ROOT = Path(__file__).resolve().parents[1]


def renew_previews(observe, context):
    rows = observe('/native/pr-preview', {**context, 'action': 'list'})['previews']
    originals = [next((row for row in rows if row['kind'] == kind and row['state'] == 'READY' and not row['purged']), None) for kind in ['STATIC', 'WORKER']]
    if any(row is None for row in originals):
        raise RuntimeError('Both original ready preview kinds are required before demo activation')
    renewed = []
    for current in originals:
        kind = current['kind']
        value = observe('/native/pr-preview', {**context, 'action': 'renew', 'previewId': current['id'], 'expectedExpiresAt': current['expiresAt']})['preview']
        expiry = dt.datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00'))
        remaining = (expiry - dt.datetime.now(dt.timezone.utc)).total_seconds()
        if value['id'] != current['id'] or value['commitId'] != current['commitId'] or value['sha256'] != current['sha256'] or value['kind'] != kind or value['state'] != 'READY' or value['purged'] or not 14300 <= remaining <= 14405:
            raise RuntimeError('Original preview identity or approved four-hour lease differs')
        renewed.append(value)
    return renewed


def deadline_unit(receipt):
    return 'golf-demo-stop-' + hashlib.sha256(str(receipt).encode()).hexdigest()[:16]


def arm_deadline(receipt, seconds):
    receipt, state = load_receipt(receipt)
    if type(seconds) is not int or not 1 <= seconds <= 14700 or not (state.get('state') in ['awaiting_login', 'ready'] or state.get('state') == 'running' and state.get('demo', {}).get('unattended') is True):
        raise ValueError('Only an owned prepared demo can arm a bounded stop timer')
    unit = deadline_unit(receipt)
    subprocess.run(['systemctl', '--user', 'stop', unit + '.timer'], capture_output=True, check=False, timeout=10)
    result = subprocess.run(['systemd-run', '--user', '--collect', '--unit=' + unit, '--on-active=' + str(seconds) + 's', '--timer-property=AccuracySec=1s',
        '--property=Type=oneshot', '--property=TimeoutStartSec=1800',
        '--property=Restart=on-failure', '--property=RestartSec=30',
        '--property=StartLimitBurst=3', '--property=StartLimitIntervalSec=7200', '--setenv=PATH=' + os.environ['PATH'],
        sys.executable, str(ROOT/'scripts/cloudflare_demo.py'), 'stop', str(receipt)], capture_output=True, timeout=15)
    if result.returncode:
        raise RuntimeError('Independent demo stop timer could not be armed; demo readiness withheld')
    active = subprocess.run(['systemctl', '--user', 'is-active', unit + '.timer'], capture_output=True, timeout=10)
    if active.returncode or active.stdout.strip() != b'active':
        raise RuntimeError('Independent demo stop timer was not confirmed active')
    return unit


def process_matches(process, proc=Path('/proc')):
    pid = process.get('pid')
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        target = proc / str(pid)
        ticks = (target / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        command = (target / 'cmdline').read_bytes().split(b'\0')
        return ticks == process.get('start_ticks') and len(command) > 1 and Path(os.fsdecode(command[1])).name == 'cloudflare-forge-smoke.py'
    except (OSError, IndexError, ValueError):
        return False


def load_receipt(receipt):
    receipt = Path(receipt)
    if receipt.is_symlink():
        raise ValueError('Use the original private ownership receipt')
    receipt = receipt.resolve(strict=True)
    if receipt.name != 'ownership.json' or not receipt.is_relative_to(ROOT / '.tmp/cloudflare-forge'):
        raise ValueError('Use a native qualification ownership receipt')
    info = receipt.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError('The ownership receipt must be private to this operator')
    state = json.loads(receipt.read_text())
    if not state.get('demo'):
        raise ValueError('Use an owned disposable demo receipt')
    return receipt, state


def control(action, receipt):
    receipt, state = load_receipt(receipt)
    if action == 'stop' and not process_matches(state.get('demo_process', {})):
        from cloudflare_demo_cleanup import recover
        recover(receipt)
        return 'Owned demo resources removed; inspect cleanup-recovery.json'
    if not process_matches(state.get('demo_process', {})):
        raise ValueError('The original demo supervisor is not running')
    if action == 'begin':
        if state['state'] != 'awaiting_login':
            raise ValueError('Only a prepared demo can begin its window')
        if (receipt.parent / 'demo.begin').exists():
            raise FileExistsError('Demo window was already requested')
        arm_deadline(receipt, 14700)
        fd = os.open(receipt.parent / 'demo.begin', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        return 'Demo window requested; the supervisor renews the original preview leases before reporting ready'
    os.kill(state['demo_process']['pid'], signal.SIGTERM)
    return 'Stop requested; inspect the receipt for completed owned-resource cleanup'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['begin', 'stop'])
    parser.add_argument('receipt')
    args = parser.parse_args()
    try:
        print(control(args.action, args.receipt))
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
