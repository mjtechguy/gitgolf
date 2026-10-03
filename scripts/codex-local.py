#!/usr/bin/env python3
"""Operator-local trusted-source Codex connection; no managed Golf authority."""
import argparse
from contextlib import contextmanager
import fcntl
import difflib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import stat
import subprocess
import sys
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
LABEL = 'io.golf.codex.connection'
LIMIT = 8 << 20


def require(ok, message):
    if not ok: raise ValueError(message)


def private_file(path, limit):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'Input must be an owned 0600 ordinary file')
    require(info.st_size <= limit, 'Input exceeds bound')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        require(os.fstat(stream.fileno()) == info, 'Input changed during open')
        return stream.read(limit+1)


def source_archive(path):
    path = Path(path)
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 16 << 20, 'Invalid source archive')
    with path.open('rb') as file:
        return validated_checkpoint(file)


def completed_events(data, exit_code):
    events = []
    for line in data.splitlines():
        require(len(line) <= 1 << 20, 'Oversize event')
        value = json.loads(line)
        require(isinstance(value, dict) and isinstance(value.get('type'), str), 'Malformed event')
        events.append(value['type'])
    return exit_code == 0 and events.count('turn.completed') == 1 and events.count('turn.started') == 1 and events.count('thread.started') == 1 and events.index('thread.started') < events.index('turn.started') < events.index('turn.completed') and not any(value in ('turn.failed', 'error') for value in events) and events[-1:] == ['turn.completed']


def docker(*args, data=None, check=True, timeout=30):
    process = subprocess.run(['docker', *args], input=data, capture_output=True, timeout=timeout)
    require(not check or process.returncode == 0, 'Docker operation failed; private diagnostics withheld')
    require(len(process.stdout) <= 16 << 20 and len(process.stderr) <= 1 << 20, 'Docker output exceeds bound')
    return process


def owned(record, labels):
    return labels.get(LABEL) == record['identity'] and labels.get('io.golf.codex.owner') == str(os.getuid())


@contextmanager
def connection(directory, image):
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'An actual local image ID is required')
    path = Path(directory).absolute()
    require(not path.is_symlink() and not path.resolve().is_relative_to(ROOT), 'State must be outside checkout')
    path.mkdir(mode=0o700, parents=False, exist_ok=True)
    info = path.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'State directory must be owned 0700')
    fd = os.open(path/'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    require(stat.S_IMODE(os.fstat(fd).st_mode) == 0o600 and os.fstat(fd).st_uid == os.getuid(), 'Unsafe lock file')
    try:
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('Connection is busy')
        state = path/'connection.json'
        if state.exists():
            record = json.loads(private_file(state, 4096))
            require(record.get('image') == image and re.fullmatch(r'[a-f0-9]{32}', record.get('identity', '')), 'Invalid connection identity or image mismatch')
            require(record.get('volume') == 'golf-codex-'+record['identity'], 'Invalid volume identity')
        else:
            identity = uuid.uuid4().hex
            record = {'identity': identity, 'volume': 'golf-codex-'+identity, 'image': image}
            fd_state = os.open(state, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd_state, 'w') as stream: json.dump(record, stream)
        yield path, record
    finally:
        os.close(fd)


def containers(record):
    listing = docker('ps', '-aq', '--no-trunc', '--filter', 'label='+LABEL+'='+record['identity']).stdout.decode().split()
    for identifier in listing:
        resource = json.loads(docker('inspect', identifier).stdout)[0]
        require(owned(record, resource['Config'].get('Labels') or {}), 'Container ownership mismatch')
    return listing


def volume(record, create=False):
    names = docker('volume', 'ls', '-q', '--filter', 'name=^'+record['volume']+'$').stdout.decode().split()
    if not names and create:
        docker('volume', 'create', '--label', LABEL+'='+record['identity'], '--label', 'io.golf.codex.owner='+str(os.getuid()), record['volume'])
        names = [record['volume']]
    if names:
        require(names == [record['volume']], 'Unexpected volume inventory')
        resource = json.loads(docker('volume', 'inspect', record['volume']).stdout)[0]
        require(owned(record, resource.get('Labels') or {}), 'Volume ownership mismatch')
    return bool(names)


def create_command(record):
    return ['create', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--security-opt', 'seccomp='+str(ROOT/'deploy/docker/codex/seccomp.json'),
        '--pids-limit', '128', '--memory', '1g', '--memory-swap', '1g', '--cpus', '2', '--log-driver', 'none', '--restart', 'no', '--pull', 'never', '--no-healthcheck',
        '--tmpfs', '/tmp:uid=1000,gid=1000,size=67108864,mode=700',
        '--tmpfs', '/workspace:uid=1000,gid=1000,size=67108864,mode=700',
        '--mount', 'type=volume,source='+record['volume']+',target=/auth',
        '--label', LABEL+'='+record['identity'], '--label', 'io.golf.codex.owner='+str(os.getuid()),
        '--entrypoint', 'sh', record['image'], '-c', 'sleep 2147483647']


def verify_container(record, identifier):
    require(re.fullmatch(r'[a-f0-9]{64}', identifier), 'Invalid container identity')
    resource = json.loads(docker('inspect', identifier).stdout)[0]
    require(owned(record, resource['Config'].get('Labels') or {}) and resource['Image'] == record['image'], 'Container ownership mismatch')


def remove_container(record, identifier):
    verify_container(record, identifier)
    docker('stop', '--time', '5', identifier, check=False, timeout=15)
    verify_container(record, identifier)
    docker('kill', identifier, check=False)
    verify_container(record, identifier)
    docker('rm', identifier)


def device_codes(data):
    clean = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', data)
    if b'https://auth.openai.com/codex/device' not in clean:
        return []
    return re.findall(rb'Enter this one-time code[^\n]*\n[ \t]*([A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12})?)\b', clean)


def stream_exec(record, identifier, command, payload, timeout, stdout_file=None, stderr_file=None, device=False):
    verify_container(record, identifier)
    process = subprocess.Popen(['docker', 'exec', '-i', identifier, *command], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector(); deadline = time.monotonic()+timeout
    output, error, codes = bytearray(), bytearray(), set()
    remaining = memoryview(payload)
    if remaining:
        os.set_blocking(process.stdin.fileno(), False); selector.register(process.stdin, selectors.EVENT_WRITE)
    else: process.stdin.close()
    for pipe in (process.stdout, process.stderr):
        os.set_blocking(pipe.fileno(), False); selector.register(pipe, selectors.EVENT_READ)
    try:
        while selector.get_map():
            require(time.monotonic() < deadline, 'Execution timeout; no automatic retry')
            for key, _ in selector.select(min(1, max(0,deadline-time.monotonic()))):
                if key.fileobj == process.stdin:
                    count = os.write(process.stdin.fileno(), remaining)
                    remaining = remaining[count:]
                    if not remaining:
                        selector.unregister(process.stdin); process.stdin.close()
                    continue
                data = os.read(key.fileobj.fileno(), 65536)
                if not data: selector.unregister(key.fileobj); continue
                target = output if key.fileobj == process.stdout else error
                require(len(target)+len(data) <= (LIMIT if key.fileobj == process.stdout else 1 << 20), 'Output exceeds bound')
                target.extend(data)
                destination = stdout_file if key.fileobj == process.stdout else stderr_file
                if destination: destination.write(data); destination.flush()
                if device:
                    for code in device_codes(bytes(output)+bytes(error)):
                        if code not in codes:
                            codes.add(code); print('Open https://auth.openai.com/codex/device and enter '+code.decode(), flush=True)
        return process.wait(timeout=5), bytes(output), bytes(error)
    finally:
        selector.close()
        if not process.stdin.closed: process.stdin.close()
        if process.poll() is None:
            remove_container(record, identifier)
            process.kill(); process.wait(timeout=5)
        for pipe in (process.stdout, process.stderr): pipe.close()


def exec_flags():
    return ['codex', 'exec', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write',
        '-c', 'approval_policy="never"', '--ephemeral', '--color', 'never', '--json', '-C', '/workspace', '-']



def checkpoint_source(record,identifier):
    verify_container(record,identifier)
    process = subprocess.Popen(['docker','cp',identifier+':/workspace','-'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    raw = bytearray(); deadline = time.monotonic()+30
    selector = selectors.DefaultSelector(); selector.register(process.stdout,selectors.EVENT_READ)
    try:
        while selector.get_map():
            require(time.monotonic()<deadline,'Checkpoint timed out')
            for key,_ in selector.select(1):
                data = os.read(key.fileobj.fileno(),65536)
                if not data: selector.unregister(key.fileobj); continue
                require(len(raw)+len(data)<=64<<20,'Checkpoint exceeds bound'); raw.extend(data)
        require(process.wait(timeout=5)==0,'Checkpoint copy failed')
    finally:
        selector.close(); process.stdout.close()
        if process.poll() is None: process.kill(); process.wait(timeout=5)
    result = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as source,tarfile.open(fileobj=result,mode='w:') as destination:
        for index,item in enumerate(source):
            require(index<8192,'Checkpoint entry bound exceeded')
            parts = PurePosixPath(item.name).parts
            require(parts and parts[0]=='workspace','Unexpected checkpoint root')
            if len(parts)==1 or parts[1].lower()=='.git': continue
            item.name='/'.join(parts[1:]); destination.addfile(item,source.extractfile(item) if item.isfile() else None)
    # Validate and normalize the proposal with the same source trust boundary.
    return validated_checkpoint(io.BytesIO(result.getvalue()),allow_empty=True)


def validated_checkpoint(file,allow_empty=False):
    # A file descriptor avoids writing or extracting agent-controlled files on host.
    result,seen,total = io.BytesIO(),{},0
    with tarfile.open(fileobj=file,mode='r:') as source,tarfile.open(fileobj=result,mode='w:') as destination:
        for index,item in enumerate(source):
            name=item.name.rstrip('/')
            parts=PurePosixPath(name).parts
            require(name==PurePosixPath(name).as_posix(),'Noncanonical checkpoint path')
            item.name=name
            require(index<4096 and parts and not item.name.startswith('/') and '\\' not in item.name,'Unsafe checkpoint path')
            require(all(part not in ('..','.') for part in item.name.rstrip('/').split('/')) and all(part.lower() not in ('.git','.codex') for part in parts),'Forbidden checkpoint configuration')
            require(len(item.name.encode())<=512 and all(ord(char)>=32 and ord(char)!=127 for char in item.name),'Invalid checkpoint name')
            require(item.name not in seen and (item.isfile() or item.isdir()) and not item.issparse(),'Nonordinary checkpoint')
            require(not any('/'.join(parts[:n]) in seen and not seen['/'.join(parts[:n])] for n in range(1,len(parts))),'Checkpoint parent conflict')
            require(item.isdir() or not any(value.startswith(item.name+'/') for value in seen),'Checkpoint child conflict')
            seen[item.name]=item.isdir();total+=item.size
            require(0<=item.size<=8<<20 and total<=16<<20 and (item.isfile() or item.size==0),'Checkpoint byte bound exceeded')
            clean=tarfile.TarInfo(item.name);clean.type=tarfile.DIRTYPE if item.isdir() else tarfile.REGTYPE
            clean.mode=0o700 if item.isdir() or item.mode&0o111 else 0o600;clean.uid=clean.gid=1000;clean.size=item.size
            destination.addfile(clean,source.extractfile(item) if item.isfile() else None)
    require(allow_empty or any(not directory for directory in seen.values()),'Empty source')
    return result.getvalue()


def proposal(before,after):
    def files(data):
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:') as archive:
            return {item.name:archive.extractfile(item).read() for item in archive if item.isfile()}
    old,new=files(before),files(after);diff=[];binary=[]
    for name in sorted(old.keys()|new.keys()):
        if old.get(name)==new.get(name):continue
        try:
            left=old.get(name,b'').decode('utf-8');right=new.get(name,b'').decode('utf-8')
            require('\x00' not in left+right,'Binary file')
        except (UnicodeDecodeError,ValueError):
            binary.append({'path':name,'before_sha256':hashlib.sha256(old[name]).hexdigest() if name in old else None,
                'after_sha256':hashlib.sha256(new[name]).hexdigest() if name in new else None});continue
        for line in difflib.unified_diff(left.splitlines(True),right.splitlines(True),fromfile='a/'+name if name in old else '/dev/null',tofile='b/'+name if name in new else '/dev/null'):
            diff.append(line if line.endswith('\n') else line+'\n\\ No newline at end of file\n')
    data=''.join(diff).encode();require(len(data)<=LIMIT,'Proposal exceeds bound');return data,binary

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True); parser.add_argument('--state-directory', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('login-device'); key = sub.add_parser('login-api'); key.add_argument('--key-file', required=True)
    sub.add_parser('status'); sub.add_parser('disconnect')
    task = sub.add_parser('run'); task.add_argument('--source', required=True); task.add_argument('--commit', required=True)
    task.add_argument('--prompt-file', required=True); task.add_argument('--output-directory', required=True)
    task.add_argument('--timeout', type=int, default=300); task.add_argument('--trusted-source', action='store_true', required=True)
    args = parser.parse_args()
    with connection(args.state_directory, args.image) as (state, record):
        existing = containers(record)
        if args.command == 'disconnect':
            for identifier in existing: remove_container(record, identifier)
            if volume(record): docker('volume', 'rm', record['volume'])
            (state/'connection.json').unlink()
            print(json.dumps({'state': 'disconnected', 'lock_directory_retained': True})); return
        require(not existing, 'Busy or orphaned runtime; explicit disconnect required')
        image = json.loads(docker('image', 'inspect', args.image).stdout)[0]
        require(image.get('Architecture') in ('amd64','arm64'), 'Only qualified amd64/arm64 profiles are supported')
        require(image['Id'] == args.image and image['Config']['User'] in ('1000', '1000:1000'), 'Expected pinned nonroot image')
        present = volume(record, create=args.command.startswith('login-'))
        if args.command == 'status' and not present:
            print(json.dumps({'state': 'unconfigured', 'inference_verified': False})); return
        require(present, 'Connect this isolated account first')
        payload = b''; archive = None
        if args.command == 'login-api':
            payload = private_file(args.key_file, 1024).strip()
            require(re.fullmatch(rb'sk-[A-Za-z0-9_-]{20,500}', payload), 'Invalid API key file')
            payload += b'\n'
        if args.command == 'run':
            require(re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', args.commit) and 5 <= args.timeout <= 900, 'Invalid source identity or timeout')
            archive = source_archive(args.source); payload = private_file(args.prompt_file, 16384)
            require(payload.strip(), 'Empty prompt')
            output = Path(args.output_directory).absolute()
            require(not output.exists() and not output.is_symlink() and not output.resolve().is_relative_to(ROOT), 'Output directory must be fresh and outside checkout')
            output.mkdir(mode=0o700)
        identifier = docker(*create_command(record)).stdout.decode().strip()
        try:
            verify_container(record, identifier); docker('start', identifier)
            if archive:
                verify_container(record, identifier); docker('cp', '-a', '-', identifier+':/workspace', data=archive)
                verify_container(record, identifier)
                docker('exec', '-e', 'GIT_CONFIG_NOSYSTEM=1', '-e', 'GIT_CONFIG_GLOBAL=/dev/null', identifier,
                    'sh', '-c', 'cd /workspace && git init -q && git -c core.hooksPath=/dev/null add -A -f && git -c core.hooksPath=/dev/null -c user.name=Golf -c user.email=operator@golf.invalid commit -qm source')
            if args.command == 'run':
                with open(output/'events.jsonl', 'xb', opener=lambda p,f: os.open(p,f,0o600)) as events, open(output/'stderr.txt', 'xb', opener=lambda p,f: os.open(p,f,0o600)) as errors:
                    code, data, _ = stream_exec(record,identifier,exec_flags(),payload,args.timeout,events,errors)
                completed = completed_events(data,code)
                verify_container(record, identifier); docker('pause',identifier)
                try: checkpoint = checkpoint_source(record,identifier)
                finally:
                    verify_container(record,identifier); docker('unpause',identifier)
                diff, binary_changes = proposal(archive,checkpoint)
                for name,content in [('changes.patch',diff),('checkpoint.tar',checkpoint),('binary-changes.json',json.dumps(binary_changes).encode())]:
                    fd = os.open(output/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                    with os.fdopen(fd,'wb') as destination: destination.write(content)
                print(json.dumps({'state': 'completed' if completed else 'failed', 'inference_verified': completed,
                    'source_commit': args.commit, 'source_sha256': hashlib.sha256(archive).hexdigest()}))
                return 0 if completed else 1
            command = ['codex','login','--device-auth'] if args.command == 'login-device' else ['codex','login','--with-api-key'] if args.command == 'login-api' else ['codex','login','status']
            code, data, error = stream_exec(record,identifier,command,payload,900 if args.command == 'login-device' else 60,device=args.command == 'login-device')
            state_name = 'connected' if code == 0 else 'unavailable'
            mode = 'api_key' if args.command == 'login-api' else 'chatgpt' if args.command == 'login-device' else 'chatgpt' if b'ChatGPT' in data+error else 'api_key' if b'API key' in data+error else 'unknown'
            print(json.dumps({'state': state_name, 'auth_mode': mode, 'inference_verified': False}))
            return 0 if code == 0 else 1
        finally:
            if identifier in containers(record): remove_container(record,identifier)


if __name__ == '__main__':
    def interrupted(*_): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try: sys.exit(main() or 0)
    except (Exception, KeyboardInterrupt):
        print(json.dumps({'state':'failed','reason':'Operation refused or interrupted; private diagnostics withheld; no automatic retry'}))
        sys.exit(1)
