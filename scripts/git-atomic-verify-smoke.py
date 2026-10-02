#!/usr/bin/env python3
"""Show why an atomic push's unchanged source ref is not a remote verify lock.

Uses only two disposable local Git repositories and a private packet trace.
No provider, credentials, hooks, direct ref-file edits or HOME override.
This tests a Git protocol primitive, not a complete Gitea policy boundary.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile


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
            head + ':refs/heads/source', base + ':refs/heads/main-two')
        trace = root / 'packets.txt'
        git('push', '--quiet', '--atomic', '--force-with-lease=refs/heads/main:' + base,
            '--force-with-lease=refs/heads/source:' + head, remote,
            candidate + ':refs/heads/main', head + ':refs/heads/source', trace=trace)
        commands = re.findall(r'packet:\s+push> [0-9a-f]{40} [0-9a-f]{40} (refs/heads/[^\s\\]+)',
                              trace.read_text())
        assert commands == ['refs/heads/main'], 'Unexpected protocol commands; requalify no-op behavior'
        assert git('ls-remote', remote, 'refs/heads/main').split()[0] == candidate
        assert git('ls-remote', remote, 'refs/heads/source').split()[0] == head

        # A source change already visible during advertisement is different:
        # its explicit stale lease rejects the entire atomic push.
        git('checkout', '--quiet', 'source')
        changed = commit('source-two.txt')
        git('push', '--quiet', remote, changed + ':refs/heads/source')
        git('push', '--quiet', '--atomic', '--force-with-lease=refs/heads/main-two:' + base,
            '--force-with-lease=refs/heads/source:' + head, remote,
            candidate + ':refs/heads/main-two', head + ':refs/heads/source', success=False)
        assert git('ls-remote', remote, 'refs/heads/main-two').split()[0] == base
        assert git('ls-remote', remote, 'refs/heads/source').split()[0] == changed
        print('PASS: ' + version + '; unchanged source omitted from atomic update commands')
        print('PASS: already changed source rejects atomic push through explicit stale lease')
    print('PASS: disposable repositories and packet trace removed; no Gitea instance accessed')


if __name__ == '__main__':
    main()
