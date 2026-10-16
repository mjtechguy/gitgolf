#!/usr/bin/env python3
"""Show why an atomic push's unchanged source ref is not a remote verify lock.

Uses only two disposable local Git repositories and a private packet trace.
One disposable local pre-receive hook supplies a deterministic race barrier.
No provider, credentials, canonical ref-file edits or HOME override.
This tests a Git protocol primitive, not a complete Forgejo policy boundary.
"""
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time


def main():
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                'GIT_TERMINAL_PROMPT': '0'})
    with tempfile.TemporaryDirectory(prefix='golf-git-atomic-') as temporary:
        root = Path(temporary)
        work, remote = root / 'work', root / 'remote.git'

        def git(*args, cwd=work, trace=None, success=True):
            current_env = env.copy()
            if trace:
                current_env['GIT_TRACE_PACKET'] = str(trace)
            result = subprocess.run(['git', *map(str, args)], cwd=cwd, env=current_env,
                                    capture_output=True, text=True, timeout=15)
            assert (result.returncode == 0) == success, 'Git command outcome changed; output withheld'
            return result.stdout.strip()

        version = git('--version', cwd=root)
        git('init', '--quiet', '--object-format=sha1', '--initial-branch=main', work, cwd=root)
        git('init', '--quiet', '--bare', '--object-format=sha1', remote, cwd=root)
        git('config', 'user.name', 'Golf atomic proof')
        git('config', 'user.email', 'atomic@example.invalid')
        git('config', 'commit.gpgsign', 'false')

        def commit(name):
            (work / name).write_text(name + '\n')
            git('add', '--', name)
            git('commit', '--quiet', '-m', name)
            return git('rev-parse', 'HEAD')

        base = commit('base.txt')
        git('checkout', '--quiet', '-b', 'source')
        head = commit('source.txt')
        git('checkout', '--quiet', 'main')
        git('merge', '--quiet', '--no-ff', '-m', 'candidate', head)
        candidate = git('rev-parse', 'HEAD')
        git('push', '--quiet', remote, base + ':refs/heads/main',
            head + ':refs/heads/source', base + ':refs/heads/main-two',
            base + ':refs/heads/main-race')
        trace = root / 'packets.txt'
        git('push', '--quiet', '--atomic', '--force-with-lease=refs/heads/main:' + base,
            '--force-with-lease=refs/heads/source:' + head, remote,
            candidate + ':refs/heads/main', head + ':refs/heads/source', trace=trace)
        commands = re.findall(r'packet:\s+push> [0-9a-f]{40} [0-9a-f]{40} (refs/heads/[^\s\\]+)',
                              trace.read_text())
        assert commands == ['refs/heads/main'], 'Unexpected protocol commands; requalify no-op behavior'
        assert git('ls-remote', remote, 'refs/heads/main').split()[0] == candidate
        assert git('ls-remote', remote, 'refs/heads/source').split()[0] == head

        # Pause after advertisement/command receipt, before target publication.
        # This hook exists only in this disposable local bare repository.
        hooks = root / 'hooks'
        hooks.mkdir()
        hook = hooks / 'pre-receive'
        hook.write_text('''#!/usr/bin/env python3
import os, pathlib, sys, time
updates = sys.stdin.read().splitlines()
if any(line.endswith(' refs/heads/main-race') for line in updates):
    gate = pathlib.Path(os.environ['GOLF_PROOF_GATE'])
    (gate / 'received').touch()
    deadline = time.monotonic() + 15
    while not (gate / 'release').exists():
        if time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.02)
''')
        hook.chmod(0o700)
        git('config', 'core.hooksPath', hooks, cwd=remote)
        gate = root / 'gate'
        gate.mkdir()
        race_env = env | {'GOLF_PROOF_GATE': str(gate),
                          'GIT_TRACE_PACKET': str(root / 'race-packets.txt')}
        race = subprocess.Popen(['git', 'push', '--quiet', '--atomic',
            '--force-with-lease=refs/heads/main-race:' + base,
            '--force-with-lease=refs/heads/source:' + head, str(remote),
            candidate + ':refs/heads/main-race', head + ':refs/heads/source'],
            cwd=work, env=race_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True)
        try:
            deadline = time.monotonic() + 10
            while not (gate / 'received').exists():
                assert race.poll() is None and time.monotonic() < deadline, 'Race barrier not reached'
                time.sleep(0.02)
            assert git('ls-remote', remote, 'refs/heads/main-race').split()[0] == base
            git('checkout', '--quiet', 'source')
            changed = commit('source-two.txt')
            git('push', '--quiet', remote, changed + ':refs/heads/source')
            (gate / 'release').touch()
            race.communicate(timeout=15)
            assert race.returncode == 0, 'Target publication outcome changed; output withheld'
        finally:
            (gate / 'release').touch()
            try:
                race.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(race.pid, signal.SIGKILL)
                race.communicate(timeout=15)
        race_commands = re.findall(r'packet:\s+push> [0-9a-f]{40} [0-9a-f]{40} (refs/heads/[^\s\\]+)',
                                   (root / 'race-packets.txt').read_text())
        assert race_commands == ['refs/heads/main-race']
        assert git('ls-remote', remote, 'refs/heads/main-race').split()[0] == candidate
        assert git('ls-remote', remote, 'refs/heads/source').split()[0] == changed
        git('merge-base', '--is-ancestor', changed, candidate, success=False)

        # A source change visible before advertisement rejects the whole push.
        git('push', '--quiet', '--atomic', '--force-with-lease=refs/heads/main-two:' + base,
            '--force-with-lease=refs/heads/source:' + head, remote,
            candidate + ':refs/heads/main-two', head + ':refs/heads/source', success=False)
        assert git('ls-remote', remote, 'refs/heads/main-two').split()[0] == base
        assert git('ls-remote', remote, 'refs/heads/source').split()[0] == changed
        print('PASS: ' + version + '; unchanged source omitted from atomic update commands')
        print('PASS: already changed source rejects atomic push through explicit stale lease')
        print('PASS: deterministic source change after command receipt does not reject target publication')
    print('PASS: disposable repositories, local hook and traces removed; no Forgejo instance accessed')


if __name__ == '__main__':
    main()
