"""Validate the public, pinned inputs for a repeatable native demo."""
import json
from pathlib import Path
import re


def read_manifest(path):
    value = json.loads(Path(path).read_text())
    if value.get('schema') != 'golf.demo.deployment.v1':
        raise ValueError('Unsupported demo manifest')
    slug = lambda s: isinstance(s,str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,38}',s)
    personal = value['personal']['login']
    organizations = value['organizations']
    if not slug(personal) or not isinstance(organizations,list) or len(organizations)>10:
        raise ValueError('Invalid demo owners')
    owners = [personal]+[o['slug'] for o in organizations]
    if not all(map(slug,owners)) or len(set(owners)) != len(owners):
        raise ValueError('Duplicate or invalid demo owner')
    repos=value['repositories']
    if not isinstance(repos,list) or not 1 <= len(repos) <= 30 or len({r['name'] for r in repos}) != len(repos):
        raise ValueError('Use at most 30 globally distinct native repository names')
    for row in repos:
        if row['owner'] not in owners or not slug(row['name']) or not re.fullmatch(r'https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',row['upstream']) or not re.fullmatch(r'[a-f0-9]{40}',row['commit']):
            raise ValueError('Use canonical owners, public GitHub sources and pinned full commits')
        for dep in row.get('dependencies',[]):
            if not re.fullmatch(r'[A-Za-z0-9_.+-]+\.whl',dep['name']) or not re.fullmatch(r'https://files.pythonhosted.org/packages/[A-Za-z0-9/_.-]+\.whl',dep['url']) or not re.fullmatch(r'[a-f0-9]{64}',dep['sha256']):
                raise ValueError('Use pinned public PyPI wheels')
    return value
