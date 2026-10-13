#!/usr/bin/env python3
"""Prime replaceable indexes by reading exact snapshots from canonical Artifacts Git."""
import argparse
import codecs
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile('[a-f0-9]{40}')


def parse_tree(data, recursive=False):
    result = []
    for record in data.split(b'\0'):
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        parts = metadata.decode('ascii').split()
        mode, kind, digest = parts[:3]
        path = name.decode('utf-8')
        if not SHA.fullmatch(digest) or len(path) > 4096 or any(part in ['', '.', '..'] for part in path.split('/')) or any(ord(c) < 32 or ord(c) == 127 or c == '\\' for c in path):
            raise ValueError('Invalid canonical tree entry')
        entry = {'name': path, 'hash': digest, 'type': 'symlink' if mode == '120000' else 'gitlink' if mode == '160000' else 'exec' if mode == '100755' else kind}
        if recursive:
            entry['size'] = int(parts[3]) if parts[3] != '-' else 0
            if not 0 <= entry['size'] <= 32 * 1024 * 1024:
                raise ValueError('Canonical blob exceeds the qualified bound')
        result.append(entry)
    if len(result) > 100000:
        raise ValueError('Canonical inventory exceeds the qualified bound')
    return result


class Metadata:
    def __init__(self, directory, profile):
        self.root = Path(directory).resolve()
        self.settings = json.loads((self.root / 'forge.json').read_text())
        if not re.fullmatch('[a-zA-Z0-9_-]{1,63}', profile) or any(os.environ.get(k) for k in ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY']):
            raise ValueError('Use a named profile without ambient credentials')
        self.profile = profile
        self.env = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': self.settings['account'], 'CF_SEND_TELEMETRY': 'false', 'CI': 'true'}
        self.deadline = None
        if (self.root / 'ownership.json').exists():
            receipt = json.loads((self.root / 'ownership.json').read_text())
            if receipt['account'] != self.settings['account'] or receipt['name'] != self.settings['worker']:
                raise ValueError('Metadata installation differs from ownership')
            window = receipt.get('validation_window') or receipt['demo']
            if not window.get('retained'):
                self.deadline = dt.datetime.fromisoformat(window['stop_at'].replace('Z', '+00:00'))

    def cf(self, *args, raw=False):
        if self.deadline and dt.datetime.now(dt.timezone.utc) >= self.deadline:
            raise ValueError('Demo deadline reached')
        attempts = 3 if args[:4] == ('artifacts', 'namespaces', 'repos', 'get') else 1
        for attempt in range(attempts):
            process = subprocess.run([shutil.which('cf'), '--profile', self.profile, *args], cwd=self.root, env=self.env, capture_output=True, timeout=60)
            if not process.returncode:
                break
            if attempt + 1 < attempts:
                time.sleep(attempt + 1)
        if process.returncode:
            raise RuntimeError('Metadata operation failed: ' + ' '.join(args[:3]))
        return process.stdout if raw else json.loads(process.stdout)

    def query(self, sql, params=()):
        body = {'sql': sql, 'params': list(params)}
        if len(json.dumps(body).encode()) > 65536:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json', prefix='golf-index-query-') as payload:
                json.dump([body], payload); payload.flush()
                return self.cf('d1', 'query', self.settings['database']['uuid'], '--batch', '@'+payload.name)[0]['results']
        return self.cf('d1', 'query', self.settings['database']['uuid'], '--body', json.dumps(body))[0]['results']

    def seed(self, row):
        remote = f"https://{self.settings['account']}.artifacts.cloudflare.net/git/{self.settings['namespace']}/{row['artifact_name']}.git"
        info = self.cf('artifacts', 'namespaces', 'repos', 'get', row['artifact_name'], '--namespace', self.settings['namespace'])
        if info['name'] != row['artifact_name'] or info['remote'] != remote:
            raise ValueError('Canonical provider identity changed')
        token = self.cf('artifacts', 'namespaces', 'tokens', 'create', self.settings['namespace'], '--repo', row['artifact_name'], '--scope', 'read', '--ttl', '600')
        try:
            plaintext = token['plaintext']
            if not isinstance(plaintext, str) or not 32 <= len(plaintext) <= 2048 or re.search(r'[^\x21-\x7e]', plaintext):
                raise ValueError('Invalid canonical read credential')
            git_env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull, 'GIT_TERMINAL_PROMPT': '0'}
            config = {'credential.helper': '', 'core.hooksPath': os.devnull, 'http.followRedirects': 'false', 'http.proxy': '', 'http.sslVerify': 'true', 'http.extraHeader': 'Authorization: Bearer ' + plaintext, 'protocol.file.allow': 'never', 'protocol.ext.allow': 'never'}
            git_env['GIT_CONFIG_COUNT'] = str(len(config))
            for i, (key, value) in enumerate(config.items()):
                git_env[f'GIT_CONFIG_KEY_{i}'], git_env[f'GIT_CONFIG_VALUE_{i}'] = key, value
            with tempfile.TemporaryDirectory(prefix='golf-metadata-') as directory:
                path = Path(directory) / 'snapshot.git'
                def git(*args):
                    process = subprocess.run(['git', *args], env=git_env, capture_output=True, timeout=180)
                    if process.returncode:
                        raise RuntimeError('Canonical Git inspection failed')
                    return process.stdout
                head = git('ls-remote', remote, 'refs/heads/' + row['default_branch']).decode().split()
                if not head:
                    return {'repository': row['name'], 'empty': True}
                if len(head) != 2 or not SHA.fullmatch(head[0]) or head[1] != 'refs/heads/' + row['default_branch']:
                    raise ValueError('Invalid canonical head')
                git('clone', '--bare', '--single-branch', '--branch', row['default_branch'], '--', remote, str(path))
                commit = git('-C', str(path), 'rev-parse', 'HEAD').decode().strip()
                if commit != head[0]:
                    raise ValueError('Canonical head changed during inspection; retry the read')
                entries = parse_tree(git('-C', str(path), 'ls-tree', '-r', '-l', '-z', '--full-tree', commit), True)
                hashes = list(dict.fromkeys(entry['hash'] for entry in entries if entry['type'] in ['blob', 'exec']))
                binary = set()
                requests = Path(directory) / 'object-requests'
                requests.write_text(''.join(digest + '\n' for digest in hashes)); requests.chmod(0o600)
                with requests.open('rb') as source:
                    process = subprocess.Popen(['git', '-C', str(path), 'cat-file', '--batch'], stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=git_env)
                    try:
                        for digest in hashes:
                            header = process.stdout.readline(256).decode().split()
                            if len(header) != 3 or header[:2] != [digest, 'blob']:
                                raise ValueError('Canonical object identity differs')
                            size = int(header[2])
                            if not 0 <= size <= 32 * 1024 * 1024: raise ValueError('Canonical object size exceeds its bound')
                            prefix = process.stdout.read(min(size, 8192)); remaining = size - len(prefix)
                            try:
                                codecs.getincrementaldecoder('utf-8')('strict').decode(prefix, final=size <= 8192)
                                if b'\0' in prefix: binary.add(digest)
                            except UnicodeDecodeError: binary.add(digest)
                            while remaining:
                                block = process.stdout.read(min(remaining, 1024 * 1024))
                                if not block: raise ValueError('Canonical object was truncated')
                                remaining -= len(block)
                            if process.stdout.read(1) != b'\n': raise ValueError('Invalid canonical object framing')
                        if process.wait(timeout=30): raise RuntimeError('Canonical object inspection failed')
                    finally:
                        if process.poll() is None: process.kill(); process.wait()
                        process.stdout.close()
                for entry in entries: entry['binary'] = entry['hash'] in binary
                root_entries = parse_tree(git('-C', str(path), 'ls-tree', '-z', commit))
                tree = git('-C', str(path), 'rev-parse', commit + '^{tree}').decode().strip()
                blobs = {}
                for entry in root_entries:
                    if entry['type'] not in ['blob', 'exec'] or not (re.fullmatch(r'(?:licen[cs]e|copying|copyright)(?:[._-].*)?', entry['name'], re.I) or entry['name'] == '.gitattributes'):
                        continue
                    size = int(git('-C', str(path), 'cat-file', '-s', entry['hash']))
                    if size <= 65536:
                        blobs[entry['hash']] = git('-C', str(path), 'cat-file', 'blob', entry['hash']).decode('utf-8', errors='replace')
                data = {'entries': entries, 'rootEntries': root_entries, 'treeHash': tree, 'blobs': blobs, 'commitId': commit}
                program = """import { language, rootMetadata, excludedDirectory } from './cloudflare/forge/src/repository-metadata.mjs';
import { indexKey } from './cloudflare/forge/src/repository-indexes.mjs';
let input='';for await (const part of process.stdin) input+=part;const {data,env,row}=JSON.parse(input);
const root=await rootMetadata({readCommit:async()=>({treeHash:data.treeHash}),readTree:async()=>data.rootEntries,readBlob:async hash=>data.blobs[hash]===undefined?null:new Blob([data.blobs[hash]])},data.commitId);
const counts={};let processed=0;for(const entry of data.entries){const parts=entry.name.split('/');if(parts.slice(0,-1).some((_,i)=>excludedDirectory(parts.slice(0,i+1).join('/'),root.rules)))continue;processed++;const name=['blob','exec'].includes(entry.type)?language(entry.name,root.rules):undefined;if(name&&!entry.binary&&entry.size>0)counts[name]=(counts[name]||0)+entry.size;}
const result={licenseIds:root.licenseIds,licensePaths:root.licensePaths,languages:Object.entries(counts).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,bytes])=>({name,byteCount:String(bytes)})),languagesState:'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE',licensesState:'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE',indexedCommitId:data.commitId,indexedFiles:processed,indexingProcessed:processed,languageClassifier:'Linguist filename map with root attributes and generated/vendor exclusions'};
const paths=data.entries.filter(e=>e.type!=='gitlink').map(e=>e.name).sort();
const fileIndex={result:{repositoryId:String(row.id),commitId:data.commitId,paths},...await indexKey(env,row,{kind:'file-index',ref:data.commitId})};
console.log(JSON.stringify({result,...await indexKey(env,row,{kind:'overview',ref:data.commitId}),fileIndex}));"""
                environment = {'ACCOUNT_ID': self.settings['account'], 'ARTIFACTS_NAMESPACE': self.settings['namespace'], 'WORKSPACE_SLUG': self.settings['workspace']}
                process = subprocess.run(['node', '--input-type=module', '--eval', program], cwd=ROOT, input=json.dumps({'data': data, 'env': environment, 'row': row}).encode(), capture_output=True, timeout=60)
                if process.returncode:
                    raise RuntimeError('Canonical snapshot classification failed')
                metadata = json.loads(process.stdout)
        finally:
            self.cf('artifacts', 'namespaces', 'tokens', 'revoke', token['id'], '--namespace', self.settings['namespace'], '--force')
            del token
        current = self.query("SELECT r.artifact_name,g.role FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id WHERE r.id=? AND r.state='ACTIVE' AND g.user_id=r.creator_id AND u.active=1", [row['id']])
        if not current or current[0]['artifact_name'] != row['artifact_name'] or current[0]['role'] != 'admin':
            raise ValueError('Canonical repository authority changed')
        now = dt.datetime.now(dt.timezone.utc)
        primed = []
        for index in [metadata, metadata['fileIndex']]:
            payload = json.dumps(index['result'], ensure_ascii=False, separators=(',', ':'))
            encoded = payload.encode(); digest = hashlib.sha256(encoded).hexdigest()
            if len(encoded) > 256 * 1024 or 'paths' in index['result'] and len(index['result']['paths']) > 10000:
                continue
            self.query("INSERT INTO repository_indexes(key,repository_id,commit_id,input_hash,payload,payload_hash,payload_bytes,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM repository_indexes)<256 AND (SELECT count(*) FROM repository_indexes WHERE repository_id=?)<64 ON CONFLICT(key) DO NOTHING", [index['key'], row['id'], commit, index['inputHash'], payload, digest, len(encoded), now.isoformat(), (now + dt.timedelta(days=1)).isoformat(), row['id']])
            saved = self.query('SELECT payload_hash,payload_bytes FROM repository_indexes WHERE key=? AND repository_id=?', [index['key'], row['id']])
            if not saved or saved[0]['payload_hash'] != digest or saved[0]['payload_bytes'] != len(encoded):
                raise ValueError('Existing immutable metadata differs; refusing overwrite')
            primed.append('files' if 'paths' in index['result'] else 'languages')
        # The hosted reconciler publishes this durable PENDING payload to R2.
        return {'repository': row['name'], 'commit': commit, 'files': metadata['result']['indexedFiles'], 'languages': metadata['result']['languages'], 'licenses': metadata['result']['licenseIds'], 'primed': primed}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--profile', default='golf')
    parser.add_argument('--repository', action='append', default=[])
    args = parser.parse_args()
    metadata = Metadata(args.directory, args.profile)
    rows = metadata.query("SELECT id,name,artifact_name,default_branch,creator_id FROM repositories WHERE state='ACTIVE' ORDER BY id")
    if args.repository:
        rows = [row for row in rows if row['name'] in args.repository]
        if {row['name'] for row in rows} != set(args.repository):
            raise ValueError('Select existing active repositories')
    for row in rows:
        print(json.dumps(metadata.seed(row)), flush=True)


if __name__ == '__main__':
    main()
