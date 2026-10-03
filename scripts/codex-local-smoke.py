#!/usr/bin/env python3
"""Actual Docker/native-CLI failure proof; deliberately invalid key, no paid inference."""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT/'scripts/codex-local.py'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='golf-codex-native-') as directory:
        root = Path(directory)
        state = root/'connection'
        prefix = [sys.executable, str(HELPER), '--image', args.image, '--state-directory', str(state)]
        def invoke(*arguments):
            result = subprocess.run([*prefix, *arguments], capture_output=True, timeout=90)
            receipt = json.loads(result.stdout.splitlines()[-1])
            return result.returncode, receipt
        code, receipt = invoke('status')
        assert code == 0 and receipt['state'] == 'unconfigured' and not receipt['inference_verified']
        try:
            key = root/'invalid-key'
            key.write_text('sk-golf-invalid-native-proof-aaaaaaaaaaaaaaaaaaaaaaaa')
            key.chmod(0o600)
            code, receipt = invoke('login-api', '--key-file', str(key))
            assert code == 0 and receipt['state'] == 'connected' and not receipt['inference_verified']
            identity = json.loads((state/'connection.json').read_text())['identity']
            code, receipt = invoke('status')
            assert code == 0 and not receipt['inference_verified']
            assert json.loads((state/'connection.json').read_text())['identity'] == identity
            source = root/'source.tar'
            with tarfile.open(source, 'w:') as archive:
                content = b'# Isolated Codex proof\n'
                item = tarfile.TarInfo('README.md'); item.size = len(content)
                archive.addfile(item, io.BytesIO(content))
            prompt = root/'prompt'
            prompt.write_text('Read README.md and describe it. Do not modify files.')
            prompt.chmod(0o600)
            code, receipt = invoke('run', '--trusted-source', '--source', str(source),
                '--commit', 'a'*40, '--prompt-file', str(prompt), '--output-directory', str(root/'result'), '--timeout', '10')
            assert code != 0 and receipt['state'] == 'failed' and not receipt.get('inference_verified')
            containers = subprocess.run(['docker', 'ps', '-aq', '--filter',
                'label=io.golf.codex.connection='+identity], capture_output=True, check=True)
            assert not containers.stdout.strip(), 'Attempt container survived failure'
            for file in (root/'result').iterdir():
                assert file.stat().st_mode & 0o777 == 0o600
            assert source.exists() and prompt.read_text().startswith('Read README.md')
        finally:
            code, receipt = invoke('disconnect')
            assert code == 0 and receipt['state'] == 'disconnected'
            assert not (state/'connection.json').exists()
    print('PASS: native API-cache restart; invalid-key execution refused/cancelled; private evidence; owned cleanup. No successful inference claimed.')


if __name__ == '__main__':
    main()
