"""Validate the public, pinned inputs for a repeatable native demo, and the installing administrator's identity."""
import json
from pathlib import Path
import re

LOGIN = r'[a-z0-9][a-z0-9-]{0,38}'
EMAIL = r'[^\s@]+@[^\s@]+\.[^\s@]+'


def admin_identity(email, login=None, author_name=None, author_email=None):
    """The administrator's Golf login and Git author, derived from the Access email unless given explicitly."""
    if not isinstance(email, str) or len(email) > 254 or not re.fullmatch(EMAIL, email):
        raise ValueError('Use the administrator Access email, such as owner@example.com')
    if login is None:
        login = re.sub('[^a-z0-9-]+', '-', email.split('@')[0].lower()).strip('-')[:39].strip('-')
        if not login:
            raise ValueError('The email has no usable login; pass --admin-login')
    if not isinstance(login, str) or not re.fullmatch(LOGIN, login):
        raise ValueError('Use an admin login of 1-39 lowercase letters, digits or hyphens')
    author_email = email if author_email is None else author_email
    if not isinstance(author_email, str) or len(author_email) > 254 or not re.fullmatch(EMAIL, author_email):
        raise ValueError('Use a valid Git author email')
    author_name = login if author_name is None else author_name
    if not isinstance(author_name, str) or not author_name.strip() or len(author_name) > 100 or re.search(r'[<>\x00-\x1f\x7f]', author_name):
        raise ValueError('Use a Git author name of up to 100 characters without angle brackets or control characters')
    return {'login': login, 'gitAuthorName': author_name, 'gitAuthorEmail': author_email}


def read_manifest(path):
    value = json.loads(Path(path).read_text())
    if value.get('schema') != 'golf.demo.deployment.v1':
        raise ValueError('Unsupported demo manifest')
    slug = lambda s: isinstance(s,str) and re.fullmatch(LOGIN,s)
    # Without a personal section the administrator keeps their own login and the content lives under organizations.
    personal = value['personal']['login'] if 'personal' in value else None
    organizations = value['organizations']
    if personal is not None and not slug(personal) or not isinstance(organizations,list) or len(organizations)>10:
        raise ValueError('Invalid demo owners')
    owners = ([personal] if personal is not None else [])+[o['slug'] for o in organizations]
    if not owners or not all(map(slug,owners)) or len(set(owners)) != len(owners):
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
