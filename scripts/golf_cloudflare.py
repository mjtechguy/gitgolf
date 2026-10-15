#!/usr/bin/env python3
"""Deploy Golf to your Cloudflare account with one command.

  doctor            check local tools (and, with --remote, read-only account settings)
  install           discover, ask, confirm, then build, deploy, seed, enable services and verify
  status DIR        show an installation's progress and receipt, offline
  update DIR        plan, migrate when the schema changed, deploy (optionally --with more services)
  destroy DIR       remove the installation after a typed confirmation

Every Cloudflare change is made by scripts/cloudflare_alchemy_demo.py (the Alchemy path);
this command only sequences it, discovers values with read-only cf calls and records progress
in the installation's private directory so an interrupted install resumes where it stopped."""
import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import cloudflare_alchemy_demo as alchemy
from cloudflare_demo_manifest import admin_identity, read_manifest
from cloudflare_setup import hostname as check_hostname, private_read, replace_private_json

ROOT = alchemy.ROOT
FORGE = ROOT/'.tmp/cloudflare-forge'
SELF = 'python3 scripts/golf_cloudflare.py'
WRAPPER = 'scripts/cloudflare_alchemy_demo.py'
CF_VERSION = '1.0.0-beta.13'
NODE_MAJOR = 24
PROGRESS = 'install-progress.json'
DIR = '{directory}'   # replaced by the installation directory once init has printed it
NPM_PROJECTS = ['cloudflare/agents', 'web', 'deploy/alchemy']
AMBIENT = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY']
# Alchemy beta.83 cannot resolve a Durable Object class or Workflow in the run that creates it;
# a second deploy completes it (deploy/alchemy/README.md). Only these errors are retried, once.
KNOWN_RETRY = ('requires a resolved Durable Object namespace', 'WorkflowNotFound')
SETTLE_RETRY, SETTLE_ATTEMPTS, SETTLE_DELAY = ('seed', 'seed-public'), 3, 60
EXAMPLE = 'deploy/demo/example.json'
EXAMPLE_PUBLIC = 'deploy/demo/example-public.json'
DEPLOY_TOKEN_STALE = 7.5*3600     # the deployment token lasts eight hours
AUTHORITY_STALE = 4.5*3600        # the native machine credential lasts five hours

# Optional services in installation order. migrate: needs the current schema first;
# renew: the deployment token gains a permission; enable: the wrapper action.
SERVICES = collections.OrderedDict([
    ('observability', {'enable': 'enable-observability', 'about': 'performance history and 1% redacted request logs'}),
    ('analytics', {'enable': 'enable-analytics', 'about': 'Analytics Engine metrics for PR evidence'}),
    ('dead-letter', {'enable': 'enable-dead-letter', 'about': 'keep failed evidence deliveries in a dead-letter queue'}),
    ('operations', {'enable': 'enable-operations', 'renew': True, 'about': 'service probes and the Workers analytics feed'}),
    ('ai', {'enable': 'enable-ai', 'renew': True, 'about': 'Workers AI review advice through a private AI Gateway (billed by Cloudflare)'}),
    ('search', {'enable': 'enable-search', 'migrate': True, 'renew': True, 'requires': 'ai', 'about': 'semantic search with Vectorize (needs ai)'}),
    ('email', {'enable': 'enable-email', 'migrate': True, 'renew': True, 'about': 'repository notification email via Email Service'}),
    ('pipelines', {'enable': 'enable-pipelines', 'migrate': True, 'about': 'Actions/CI pipelines with self-registered runners'}),
    ('webhooks', {'enable': 'enable-webhooks', 'about': 'repository webhooks to approved receiver origins'}),
    ('public', {'enable': 'enable-public', 'migrate': True, 'about': 'anonymous read access to explicitly published repositories'}),
    ('rate-limit', {'enable': 'enable-rate-limit', 'about': 'throttle anonymous public reads and clones'}),
    ('secrets', {'enable': 'enable-secrets', 'about': 'repository secrets and variables, the credential vault (its own Secrets Store key)'}),
    ('ssh-hosts', {'enable': 'enable-ssh-hosts', 'migrate': True, 'requires': 'secrets',
                   'about': 'coding agents on SSH hosts via an SSH container (needs secrets; Workers VPC with --ssh-vpc-tunnel-id)'}),
])

MINUTES = {'build-image': '5-15 minutes the first time, under a minute when cached', 'init': 'under a minute',
    'plan': '1-3 minutes', 'deploy': '5-15 minutes (the first deploy pushes the runner image)',
    'seed': 'a few minutes without content; 10-40 minutes with a manifest (imports and CI runs)',
    'migrate': 'under a minute', 'renew-deploy': 'seconds', 'renew-authority': 'seconds', 'enable': 'seconds',
    'seed-public': 'up to 10 minutes (waits for the new release to reach the workspace)', 'verify': 'under a minute',
    'npm': '1-3 minutes per project', 'destroy': '5-15 minutes'}

HINTS = {
    'npm': 'Check Node 24 and network access to the npm registry, then resume.',
    'build-image': 'Check that Docker is running and can build linux/amd64 images (doctor reports it), then resume.',
    'init': 'Check the cf profile is signed in (cf auth create PROFILE) and may create API tokens, and that Zero Trust is set up. '
            'Nothing was created on Cloudflare except, possibly, the deployment token.',
    'plan': 'The plan is read-only. Read the Alchemy error above; a permission error usually means the account lacks Workers Paid or Artifacts.',
    'deploy': 'Read the Alchemy error above. "already exists"/"in use" means a hostname or resource is occupied: pick unused hostnames. '
              'An authentication error means the eight-hour deployment token expired: resume renews it automatically.',
    'seed': 'Seeding is journaled: resuming continues the same jobs. A failed CI job is kept for inspection (see deploy/alchemy/README.md).',
    'migrate': 'Only reviewed, repeatable migrations are applied; read the message above before resuming.',
    'renew-deploy': 'The cf profile must still be signed in and offer the listed permission; email and search need account access to those products.',
    'renew-authority': 'The installation must be deployed and its administrator active; read the message above.',
    'enable': 'Read the message above; the private input was not changed when an enable action refuses.',
    'seed-public': 'Publishing waits for the new release to reach the workspace; resume after a few minutes.',
    'verify': 'New hostnames can take up to 30 minutes to resolve (negative DNS caching). Resume later to verify again.',
}


class Stop(Exception):
    """A user-facing refusal with an optional fix."""
    def __init__(self, message, fix=None):
        super().__init__(message)
        self.fix = fix


# ---------------------------------------------------------------- injectable process and network access

def stream(argv, env=None):
    """Run a local command, echoing its output indented while keeping the tail for error matching."""
    tail = collections.deque(maxlen=400)
    with subprocess.Popen(list(map(str, argv)), cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, bufsize=1, env=env) as process:
        for line in process.stdout:
            sys.stdout.write('    '+line)
            sys.stdout.flush()
            tail.append(line)
        code = process.wait()
    return code, ''.join(tail)


def capture(argv, timeout=60):
    """Run a local command quietly; (exit code, stdout+stderr), or (None, reason) when it cannot start."""
    try:
        result = subprocess.run(list(map(str, argv)), cwd=ROOT, capture_output=True, text=True, timeout=timeout,
                                env={**os.environ, 'CI': '1', 'CF_SEND_TELEMETRY': 'false'})
        return result.returncode, (result.stdout + result.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, str(error)


def make_cf(profile, account=None, run=subprocess.run):
    """A read-only cf caller for discovery. CI=1 skips the CLI's update check; telemetry is off."""
    def call(*args):
        env = {k: v for k, v in os.environ.items() if k not in AMBIENT}
        env.update(CI='1', CF_SEND_TELEMETRY='false')
        if account: env['CLOUDFLARE_ACCOUNT_ID'] = account
        result = run(['cf', '--profile', profile, *map(str, args)], capture_output=True, text=True, timeout=120, env=env)
        if result.returncode:
            last = (result.stderr or result.stdout or '').strip().splitlines()[-1:] or ['no output']
            raise Stop('cf '+' '.join(map(str, args[:3]))+' failed: '+last[0][:300])
        out = result.stdout.strip()
        value = json.loads(out) if out else None
        return value['result'] if isinstance(value, dict) and 'result' in value and 'success' in value else value
    return call


def probe(url):
    """One GET without following redirects: (status, Location) or (None, reason)."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    try:
        with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url, headers={'User-Agent': 'golf-cloudflare-verify/1'}), timeout=20) as response:
            return response.status, response.headers.get('Location')
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get('Location')
    except (urllib.error.URLError, OSError) as error:
        return None, str(getattr(error, 'reason', error))


# ---------------------------------------------------------------- discovery (read-only cf calls)

def rows(value):
    return value if isinstance(value, list) else (value or {}).get('result', []) if isinstance(value, dict) else []


def discover_identity(cf):
    """The profile's accounts (and email, when the CLI reports it). Raises when the profile is not signed in."""
    who = cf('auth', 'whoami') or {}
    if not who.get('authenticated') or who.get('tokenValid') is False:
        raise Stop('The cf profile is not signed in', 'cf auth create PROFILE')
    accounts = [{'id': a['id'], 'name': a.get('name', '')} for a in who.get('accounts', []) if re.fullmatch('[a-f0-9]{32}', a.get('id', ''))]
    email = who.get('email') or (who.get('user') or {}).get('email')
    return accounts, email


def zone_candidates(host):
    labels = host.split('.')
    return ['.'.join(labels[i:]) for i in range(len(labels)-1)]


def discover_zone(cf, account, host):
    """The longest zone of this account that contains the hostname: {'id', 'name', 'status'} or None."""
    for name in zone_candidates(host):
        match = [z for z in rows(cf('zones', 'list', '--name', name, '--account-id', account)) if z.get('name') == name]
        if match:
            return {'id': match[0]['id'], 'name': name, 'status': match[0].get('status', 'unknown')}
    return None


def in_zone(host, zone):
    return host == zone or host.endswith('.'+zone)


def suggest_preview(host, zone):
    """previews-HOST in the same zone (previews.ZONE when the hostname is the zone apex)."""
    if host == zone:
        return 'previews.'+zone
    first, rest = host.split('.', 1)
    return ('previews-'+first)[:63].rstrip('-')+'.'+rest


def discover_secret_stores(cf):
    return [s['id'] for s in rows(cf('secrets-store', 'stores', 'list')) if re.fullmatch('[a-f0-9]{32}', s.get('id', ''))]


def discover_team_domain(cf):
    organization = cf('zero-trust', 'organization', 'get') or {}
    domain = organization.get('auth_domain') if isinstance(organization, dict) else None
    return 'https://'+domain if domain else None


def workers_paid(cf):
    """True when a Workers paid plan is visible among the account's subscriptions, False when none is."""
    for row in rows(cf('accounts', 'subscriptions', 'get')):
        plan = row.get('rate_plan') or {}
        text = ' '.join(str(plan.get(k, '')) for k in ['id', 'public_name']).lower()
        if 'workers' in text and any(word in text for word in ['paid', 'bundled', 'standard', 'unbound']):
            return True
    return False


# ---------------------------------------------------------------- doctor

def version_tuple(text):
    return tuple(int(n) for n in re.findall(r'\d+', text)[:3])


def local_checks(run=capture, which=shutil.which, env=None, machine=None, root=None, profile='golf'):
    """Local prerequisites as (name, ok|warn|fail, detail, fix) rows. Contacts nothing."""
    env = os.environ if env is None else env
    root = ROOT if root is None else root
    checks = []
    def add(name, status, detail, fix=None): checks.append((name, status, detail, fix))

    code, out = run(['node', '--version'])
    if code == 0 and version_tuple(out)[:1] == (NODE_MAJOR,):
        add('Node', 'ok', out)
    else:
        add('Node', 'fail', out if code == 0 else 'not found', 'Install Node 24, e.g. nvm install 24 && nvm use 24')

    cf_path, cf_version = which('cf'), None
    if cf_path:
        try:
            cf_version = json.loads((Path(os.path.realpath(cf_path)).parent.parent/'package.json').read_text())['version']
        except (OSError, ValueError, KeyError):
            cf_version = None
    if cf_version == CF_VERSION:
        add('cf CLI', 'ok', CF_VERSION)
    else:
        add('cf CLI', 'fail', ('version '+str(cf_version)) if cf_path else 'not found',
            'npm install -g cf@'+CF_VERSION+'   (exactly this version; the build checks it)')

    code, out = run(['docker', 'info', '--format', '{{.ServerVersion}}'])
    if code != 0:
        add('Docker', 'fail', 'daemon not reachable', 'Start Docker (or add your user to the docker group)')
    else:
        add('Docker', 'ok', 'server '+out)
        code, out = run(['docker', 'buildx', 'version'])
        add('Docker BuildKit', 'ok' if code == 0 else 'fail', out.split('\n')[0] if code == 0 else 'buildx not available',
            None if code == 0 else 'Install the docker-buildx plugin')
        native = (machine or platform.machine()).lower() in ['x86_64', 'amd64']
        if native:
            add('linux/amd64 builds', 'ok', 'native')
        else:
            code, out = run(['docker', 'buildx', 'inspect'])
            ok = code == 0 and 'linux/amd64' in out
            add('linux/amd64 builds', 'ok' if ok else 'fail', 'emulated' if ok else 'no amd64 builder',
                None if ok else 'docker run --privileged --rm tonistiigi/binfmt --install amd64')

    add('Python', 'ok' if sys.version_info >= (3, 10) else 'fail', platform.python_version(), 'Install Python 3.10 or newer')
    code, out = run(['git', '--version'])
    add('Git', 'ok' if code == 0 else 'fail', out if code == 0 else 'not found', 'Install Git')

    wanted = re.search(r'^go\s+(\S+)', (root/'go.mod').read_text(), re.M)
    code, out = run(['go', 'env', 'GOVERSION'])
    if wanted and code == 0 and version_tuple(out) >= version_tuple(wanted.group(1)):
        add('Go', 'ok', out)
    else:
        add('Go', 'warn', (out if code == 0 else 'not found')+' (go.mod wants '+(wanted.group(1) if wanted else '?')+')',
            'Install Go '+(wanted.group(1) if wanted else '')+' for make cloudflare-check; the deploy itself does not use Go')

    for project in NPM_PROJECTS:
        installed = (root/project/'node_modules/.package-lock.json').exists()
        add('npm deps: '+project, 'ok' if installed else 'fail', 'installed' if installed else 'missing', 'npm --prefix '+project+' ci')

    ambient = [k for k in AMBIENT if env.get(k)]
    add('Ambient credentials', 'fail' if ambient else 'ok', ', '.join(ambient)+' set' if ambient else 'none',
        'unset '+' '.join(ambient)+'   (the scripts use the named cf profile only)' if ambient else None)

    if cf_path:
        code, out = run(['cf', 'auth', 'list'])
        try:
            names = [p['name'] for p in json.loads(out)]
        except (ValueError, TypeError, KeyError):
            names = None
        if names is None:
            add('cf profile '+profile, 'warn', 'could not list profiles', 'cf auth create '+profile)
        else:
            add('cf profile '+profile, 'ok' if profile in names else 'fail', 'present' if profile in names else 'missing',
                'cf auth create '+profile+'   (OAuth login; it must be allowed to create API tokens)')
    return checks


def remote_checks(cf_for, account=None, host=None):
    """Read-only account checks (GET calls only). cf_for(account) returns a cf caller."""
    checks = []
    def add(name, status, detail, fix=None): checks.append((name, status, detail, fix))
    try:
        accounts, _ = discover_identity(cf_for(None))
        add('Signed in', 'ok', str(len(accounts))+' account(s)')
    except Stop as error:
        add('Signed in', 'fail', str(error), error.fix)
        return checks
    if account is None and len(accounts) == 1:
        account = accounts[0]['id']
    if account is None or account not in [a['id'] for a in accounts]:
        add('Account', 'warn' if account is None else 'fail', 'pass --account-id to check one of: '+', '.join(a['id']+' ('+a['name']+')' for a in accounts)
            if account is None else account+' is not visible to this profile')
        return checks
    add('Account', 'ok', account)
    cf = cf_for(account)
    def attempt(name, check):
        try:
            check()
        except Stop as error:
            add(name, 'unknown', str(error))
    def paid():
        found = workers_paid(cf)
        add('Workers Paid', 'ok' if found else 'warn', 'subscription found' if found else 'no Workers paid subscription visible',
            None if found else 'Workers & Pages > Plans: subscribe to Workers Paid (Containers and Workers for Platforms need it)')
    def team():
        domain = discover_team_domain(cf)
        add('Zero Trust organization', 'ok' if domain else 'fail', domain or 'none',
            None if domain else 'Zero Trust dashboard: choose a team name (free plan is enough for a few seats)')
    def stores():
        ids = discover_secret_stores(cf)
        add('Secrets Store', 'ok', 'existing '+ids[0]+' (will be reused)' if ids else 'none yet (the stack creates one)')
    def zone():
        found = discover_zone(cf, account, host)
        if not found:
            add('Zone for '+host, 'fail', 'no zone of this account contains it', 'Add the domain to this account, or choose a hostname in one of its zones')
        else:
            add('Zone for '+host, 'ok' if found['status'] == 'active' else 'fail', found['name']+' ('+found['status']+', '+found['id']+')',
                None if found['status'] == 'active' else 'Finish activating the zone (nameservers) before installing')
    attempt('Workers Paid', paid)
    attempt('Zero Trust organization', team)
    attempt('Secrets Store', stores)
    if host:
        attempt('Zone', zone)
    add('workers.dev subdomain', 'skip', 'not readable with cf '+CF_VERSION+'; not needed (custom domains only)')
    add('Artifacts access', 'skip', 'not checked read-only; the plan step reports it')
    return checks


def print_checks(checks, out=print):
    marks = {'ok': ' ok ', 'warn': 'warn', 'fail': 'FAIL', 'unknown': ' ?? ', 'skip': 'skip'}
    for name, status, detail, fix in checks:
        out('  ['+marks[status]+'] '+name+': '+detail)
        if fix and status in ['fail', 'warn']:
            out('         fix: '+fix)


def doctor(args, run=capture, cf_for=None, out=print):
    out('Local prerequisites')
    checks = local_checks(run=run, profile=args.profile)
    missing = [c for c in checks if c[0].startswith('npm deps') and c[1] == 'fail']
    if args.fix and missing:
        for name, *_ in missing:
            project = name.split(': ', 1)[1]
            out('  running npm --prefix '+project+' ci ...')
            code, text = run(['npm', '--prefix', project, 'ci'], timeout=900)
            if code != 0:
                out(text[-2000:])
        checks = local_checks(run=run, profile=args.profile)
    print_checks(checks, out)
    if args.remote:
        out('Cloudflare account (read-only)')
        remote = remote_checks(cf_for or (lambda account: make_cf(args.profile, account)), args.account_id, args.hostname)
        print_checks(remote, out)
        checks = checks + remote
    failed = [c for c in checks if c[1] == 'fail']
    out('')
    out('All required checks passed.' if not failed else str(len(failed))+' check(s) need attention; see the fixes above.'
        + ('' if args.remote or failed else ' Add --remote for read-only account checks.'))
    return 1 if failed else 0


# ---------------------------------------------------------------- prompts

class Prompter:
    """Interactive questions; in non-interactive mode a missing answer is recorded instead of asked."""
    def __init__(self, interactive, ask=input, out=print):
        self.interactive, self.ask, self.out, self.missing = interactive, ask, out, []

    def text(self, label, given=None, default=None, validate=None, flag=None):
        if given is not None:
            return validate(given) if validate else given
        if not self.interactive:
            if default is not None:
                return validate(default) if validate else default
            self.missing.append(flag or label)
            return None
        while True:
            answer = self.ask(label+(' ['+default+']' if default else '')+': ').strip() or default
            if not answer:
                continue
            try:
                return validate(answer) if validate else answer
            except (ValueError, Stop) as error:
                self.out('  '+str(error))

    def choose(self, label, options, flag=None):
        """options: [(value, description)]; returns a value."""
        if not self.interactive:
            self.missing.append(flag or label)
            return None
        self.out(label)
        for i, (_, text) in enumerate(options, 1):
            self.out('  '+str(i)+') '+text)
        while True:
            answer = self.ask('Choose 1-'+str(len(options))+': ').strip()
            if answer.isdigit() and 1 <= int(answer) <= len(options):
                return options[int(answer)-1][0]

    def confirm(self, label, assume):
        if assume:
            return True
        if not self.interactive:
            return False
        return self.ask(label+' [y/N]: ').strip().lower() in ['y', 'yes']


def parse_services(text, everything=False):
    chosen = list(SERVICES) if everything else [s.strip() for s in (text or '').split(',') if s.strip()]
    unknown = [s for s in chosen if s not in SERVICES]
    if unknown:
        raise Stop('Unknown service(s): '+', '.join(unknown), 'choose from '+','.join(SERVICES))
    for name in list(chosen):
        need = SERVICES[name].get('requires')
        if need and need not in chosen:
            chosen.append(need)
    return [s for s in SERVICES if s in chosen]


def validate_email(value):
    admin_identity(value)
    return value


def validate_content(value):
    if value in ['example', 'none']:
        return value
    path = Path(value).expanduser().resolve()
    read_manifest(path)
    return str(path)


def resolve_options(args, prompter, cf_for):
    """Collect every install answer: flags first, then read-only discovery, then questions."""
    o = {'profile': args.profile, 'admin_login': args.admin_login, 'agent_path': args.agent_path,
         'actions_url': args.actions_url, 'ssh_vpc_tunnel_id': args.ssh_vpc_tunnel_id, 'webhook_origins': list(args.webhook_origin or [])}
    accounts, email_hint = discover_identity(cf_for(None))
    account = args.account_id
    if account is None:
        if len(accounts) == 1:
            account = accounts[0]['id']
            prompter.out('  account: '+account+' ('+accounts[0]['name']+'), the only one on this profile')
        else:
            account = prompter.choose('Which Cloudflare account?', [(a['id'], a['name']+' ('+a['id']+')') for a in accounts], '--account-id')
    elif account not in [a['id'] for a in accounts]:
        raise Stop('Account '+account+' is not visible to the cf profile '+args.profile)
    o['account'] = account
    cf = cf_for(account) if account else None

    o['hostname'] = prompter.text('Golf hostname (an unused name in one of your zones, e.g. golf.example.com)', args.hostname, validate=check_hostname, flag='--hostname')
    zone = None
    if o['hostname'] and cf:
        zone = discover_zone(cf, account, o['hostname'])
        if not zone:
            raise Stop('No zone on this account contains '+o['hostname'], 'Add the domain to the account, or use a hostname in one of its zones')
        if args.zone_id and args.zone_id != zone['id']:
            raise Stop('--zone-id differs from the zone that contains '+o['hostname']+' ('+zone['id']+')')
        if zone['status'] != 'active':
            raise Stop('Zone '+zone['name']+' is '+zone['status'], 'Finish activating the zone before installing')
        prompter.out('  zone: '+zone['name']+' ('+zone['id']+')')
    o['zone'] = zone['id'] if zone else args.zone_id
    def preview(value):
        check_hostname(value)
        if value == o['hostname']: raise ValueError('Use a hostname different from the Golf hostname')
        if zone and not in_zone(value, zone['name']): raise ValueError('The preview hostname must be in '+zone['name'])
        return value
    o['preview_hostname'] = prompter.text('Preview hostname (previews use it and its children)', args.preview_hostname,
        suggest_preview(o['hostname'], zone['name']) if zone else None, preview, '--preview-hostname')
    o['email'] = prompter.text('Administrator email (signs in through Cloudflare Access)', args.email, email_hint if prompter.interactive else None, validate_email, '--email')
    if o['email']:
        admin_identity(o['email'], args.admin_login)

    o['secrets_store_id'] = args.secrets_store_id
    if cf and not args.secrets_store_id:
        stores = discover_secret_stores(cf)
        if len(stores) > 1:
            o['secrets_store_id'] = prompter.choose('Which Secrets Store?', [(s, s) for s in stores], '--secrets-store-id')
        elif stores:
            o['secrets_store_id'] = stores[0]
            prompter.out('  Secrets Store: '+stores[0]+' (existing, reused)')
        else:
            prompter.out('  Secrets Store: none yet; the stack creates one')
    o['team_domain'] = args.access_team_domain or (discover_team_domain(cf) if cf else None)
    if cf and not o['team_domain']:
        raise Stop('This account has no Zero Trust organization', 'Zero Trust dashboard: choose a team name, then rerun')
    if o['team_domain'] and not re.fullmatch(alchemy.TEAM_DOMAIN, o['team_domain']):
        raise Stop('Use the Access team origin, https://TEAM.cloudflareaccess.com')
    if o['team_domain']: prompter.out('  Access team domain: '+o['team_domain'])

    if args.content is not None:
        o['content'] = validate_content(args.content)
    else:
        o['content'] = prompter.choose('Initial content?', [('example', 'Example organization with two small public repositories ('+EXAMPLE+')'),
            ('none', 'None: only the CI/preview playgrounds'), ('path', 'My own manifest file')], '--content')
        if o['content'] == 'path':
            o['content'] = prompter.text('Manifest path', validate=validate_content)

    if args.all or args.with_services is not None:
        o['services'] = parse_services(args.with_services, args.all)
    elif prompter.interactive:
        prompter.out('Optional services (each adds Cloudflare resources; you can add them later with update --with):')
        for i, (name, spec) in enumerate(SERVICES.items(), 1):
            prompter.out('  %2d) %-13s %s' % (i, name, spec['about']))
        while True:
            answer = prompter.ask('Numbers or names separated by commas, "all", or Enter for none: ').strip()
            try:
                names = [list(SERVICES)[int(a)-1] if a.isdigit() and 1 <= int(a) <= len(SERVICES) else a for a in answer.replace(' ', '').split(',') if a]
                o['services'] = parse_services(','.join(names), answer == 'all')
                break
            except Stop as error:
                prompter.out('  '+str(error))
    else:
        o['services'] = []
    o['public_manifest'] = resolve_public_manifest(args.public_manifest, o)
    if 'webhooks' in o['services'] and not o['webhook_origins']:
        origin = prompter.text('Webhook receiver origin (https://hooks.example.com)', flag='--webhook-origin')
        o['webhook_origins'] = [origin] if origin else []
    if prompter.missing:
        raise Stop('Missing for a non-interactive install: '+', '.join(prompter.missing), 'pass them as flags, or run without --yes to be asked')
    return o


def resolve_public_manifest(given, o):
    if 'public' not in o.get('services', []):
        return None
    if given:
        return str(Path(given).expanduser().resolve())
    return EXAMPLE_PUBLIC if o.get('content') == 'example' else None


# ---------------------------------------------------------------- the plan

def step(id, title, argv=None, kind=None, retry=False):
    return {'id': id, 'title': title, 'argv': argv, 'kind': kind or (argv[1] if argv and argv[0] == WRAPPER else id), 'retry': retry}


def wrapper(action, directory=None, *extra):
    return [WRAPPER, action, *([] if action == 'init' else [str(directory) if directory else DIR]), *extra]


def init_argv(o):
    argv = wrapper('init', None, '--account-id', o['account'], '--profile', o['profile'], '--zone-id', o['zone'],
        '--hostname', o['hostname'], '--preview-hostname', o['preview_hostname'], '--email', o['email'])
    for flag, key in [('--secrets-store-id', 'secrets_store_id'), ('--access-team-domain', 'team_domain'), ('--admin-login', 'admin_login')]:
        if o.get(key): argv += [flag, o[key]]
    return argv


def seed_argv(o, directory):
    content = o['content']
    return wrapper('seed', directory, *(['--no-seed'] if content == 'none' else ['--manifest', EXAMPLE if content == 'example' else content]))


def service_steps(name, o, directory, migrated):
    """The prerequisite sequence for one optional service. migrated: a set shared across services."""
    spec, steps = SERVICES[name], []
    if spec.get('migrate') and 'migrate' not in migrated:
        migrated.add('migrate')
        steps.append(step(name+':migrate', 'Apply pending schema migrations', wrapper('migrate', directory)))
    extra = []
    if name == 'ai' and o.get('agent_path'): extra = ['--agent-path', o['agent_path']]
    if name == 'pipelines' and o.get('actions_url'): extra = ['--actions-url', o['actions_url']]
    # The Workers VPC binding needs the deployment token to bind the Tunnel (Connectivity Directory).
    vpc = name == 'ssh-hosts' and o.get('ssh_vpc_tunnel_id')
    if vpc: extra = ['--vpc-tunnel-id', o['ssh_vpc_tunnel_id']]
    if name == 'webhooks':
        extra = [arg for origin in o.get('webhook_origins', []) for arg in ['--origin', origin]]
    steps.append(step(name+':enable', 'Enable '+name+' ('+spec['about']+')', wrapper(spec['enable'], directory, *extra), kind='enable'))
    if spec.get('renew') or vpc:
        steps.append(step(name+':renew-deploy', 'Renew the deployment token with the new permission', wrapper('renew-deploy', directory)))
    steps.append(step(name+':deploy', 'Deploy with '+name, wrapper('deploy', directory), retry=True))
    if name == 'public' and o.get('public_manifest'):
        steps.append(step(name+':seed-public', 'Publish '+o['public_manifest'], wrapper('seed-public', directory, '--manifest', o['public_manifest'])))
    return steps


def install_steps(o, directory, missing_npm=()):
    """Every install step in order; ids are stable so a resume skips completed ones."""
    steps = [step('npm:'+p, 'Install locked npm dependencies in '+p, ['npm', '--prefix', p, 'ci'], kind='npm') for p in missing_npm]
    steps += [step('build-image', 'Build the approved linux/amd64 CI image', ['scripts/cloudflare-demo-deploy.py', 'build-image']),
        step('init', 'Create the private installation directory and deployment token', init_argv(o)),
        step('plan', 'Preview the Cloudflare resources (read-only)', wrapper('plan', directory)),
        step('deploy', 'Deploy Workers, D1, R2, queues, Access and the runner image', wrapper('deploy', directory), retry=True),
        step('seed', 'Create the playgrounds and import content', seed_argv(o, directory))]
    migrated = set()
    for name in o['services']:
        steps += service_steps(name, o, directory, migrated)
    steps.append(step('verify', 'Verify the receipt and the Access sign-in redirect', kind='verify'))
    return steps


def schema_pending(directory):
    """Pending reviewed migrations for this installation (offline), or None when unknown."""
    path = Path(directory)/'schema-receipt.json'
    if not path.exists():
        return None
    applied = json.loads(private_read(path))['sha256']
    migrations = [(p.name, p.read_text()) for p in (ROOT/'cloudflare/forge/migrations').glob('*.sql')]
    return alchemy.pending_migrations((ROOT/'cloudflare/forge/schema.sql').read_text(), applied, migrations)


CORE = ['init', 'plan', 'deploy', 'seed']


def pending_services(o, directory, done):
    """Selected services whose enable/deploy steps have not all completed (a failed update --with resumes them)."""
    return [name for name in o.get('services', []) if not all(s['id'] in done for s in service_steps(name, o, directory, {'migrate'}))]


def update_steps(o, directory, services=()):
    """plan, migrate when the schema changed (or is unknown), deploy, then any pending services."""
    pending = schema_pending(directory)
    steps = [step('update:plan', 'Preview the changes (read-only)', wrapper('plan', directory))]
    if pending is None or pending:
        steps.append(step('update:migrate', 'Apply '+(str(len(pending))+' pending' if pending else 'any pending')+' schema migration(s)', wrapper('migrate', directory)))
    steps.append(step('update:deploy', 'Deploy this checkout', wrapper('deploy', directory), retry=True))
    for name in services:
        steps += service_steps(name, o, directory, {'migrate'})
    if services:
        steps.append(step('update:verify', 'Verify the receipt and the Access sign-in redirect', kind='verify'))
    return steps


# ---------------------------------------------------------------- execution

def installation(directory, root=None):
    forge = (root or ROOT)/'.tmp/cloudflare-forge'
    path = Path(directory).expanduser().resolve()
    if not path.is_dir() or not path.is_relative_to(forge) or not re.fullmatch(r'golf-alchemy-[0-9]{8}-[a-f0-9]{8}', path.name):
        raise Stop('Use an installation directory under .tmp/cloudflare-forge/golf-alchemy-*')
    if path.stat().st_mode & 0o077:
        raise Stop('The installation directory must be private (mode 0700)')
    return path


def load_progress(directory):
    path = Path(directory)/PROGRESS
    if not path.exists():
        return None
    progress = json.loads(private_read(path))
    if progress.get('schema') != 'golf.cloudflare.install.v1':
        raise Stop('Unsupported progress file in '+str(directory))
    return progress


def elapsed(seconds):
    seconds = int(seconds)
    return (str(seconds//60)+'m'+('%02ds' % (seconds % 60)) if seconds >= 60 else str(seconds)+'s')


class Runner:
    """Executes steps, persists progress after each one and stops on the first failure."""
    def __init__(self, options, directory=None, progress=None, run=stream, out=print, clock=time.time,
                 http=probe, sleep=time.sleep, forge=None, command='install'):
        self.o, self.directory, self.run, self.out, self.clock = options, directory, run, out, clock
        self.http, self.sleep, self.forge, self.command = http, sleep, forge or FORGE, command
        self.progress = progress or {'schema': 'golf.cloudflare.install.v1', 'options': options, 'done': [], 'failed': None,
            'started_at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}

    def save(self):
        self.progress['options'] = self.o
        if self.directory:
            self.progress['directory'] = str(self.directory)
            replace_private_json(Path(self.directory)/PROGRESS, self.progress)

    def age(self, name):
        path = Path(self.directory)/name
        return self.clock() - path.stat().st_mtime if path.exists() else None

    def freshen(self, s):
        """Renew short-lived authority before a step that needs it (checks file age only, never contents)."""
        action = s['argv'][1] if s['argv'] and s['argv'][0] == WRAPPER else None
        if action in ['plan', 'deploy'] and (self.age('operator.json') or 0) > DEPLOY_TOKEN_STALE:
            self.out('    The eight-hour deployment token is old; renewing it first.')
            self.execute(wrapper('renew-deploy', self.directory), 'renew-deploy')
        if action in ['seed', 'seed-public'] and (self.age('retained-auth.json') or 0) > AUTHORITY_STALE:
            self.out('    The five-hour machine credential is old; renewing it first.')
            self.execute(['scripts/cloudflare-demo-deploy.py', 'renew-authority', str(Path(self.directory)/'ownership.json')], 'renew-authority')

    def execute(self, argv, kind):
        argv = [str(self.directory) if a == DIR else a for a in argv]
        command = argv if argv[0] == 'npm' else [sys.executable, *argv]
        code, output = self.run(command)
        if code:
            raise StepFailed(kind, code, output)
        return output

    def run_step(self, s):
        if s['kind'] == 'verify':
            return self.verify()
        if s['id'] == 'init':
            return self.init(s)
        self.freshen(s)
        if s['kind'] in SETTLE_RETRY:
            # Seeding is journaled. Right after a deploy the Workspace Durable Object can still run the
            # previous release for about two minutes, so a clone or publish may fail once; wait and continue.
            for attempt in range(SETTLE_ATTEMPTS):
                try:
                    return self.execute(s['argv'], s['kind'])
                except StepFailed:
                    if attempt == SETTLE_ATTEMPTS - 1: raise
                    self.out('    The new release is still reaching the workspace; retrying in '+str(SETTLE_DELAY)+'s ('+str(attempt+2)+'/'+str(SETTLE_ATTEMPTS)+').')
                    self.sleep(SETTLE_DELAY)
                    self.freshen(s)
        try:
            self.execute(s['argv'], s['kind'])
        except StepFailed as failure:
            if not s['retry'] or not any(marker in failure.output for marker in KNOWN_RETRY):
                raise
            self.out('    Known first-deploy limitation (a new Durable Object class or Workflow resolves on the next run); deploying once more.')
            self.execute(s['argv'], s['kind'])

    def init(self, s):
        if self.directory:
            # Resuming after init created the directory but failed on its deployment token.
            if not (Path(self.directory)/'operator.json').exists():
                self.execute(wrapper('renew-deploy', self.directory), 'init')
            return
        before = set(self.forge.glob('golf-alchemy-*'))
        try:
            output = self.execute(s['argv'], 'init')
        except StepFailed:
            created = [p for p in set(self.forge.glob('golf-alchemy-*')) - before if (p/'alchemy-input.json').exists()]
            if len(created) == 1:
                self.directory = created[0]
            raise
        found = [line.strip() for line in output.splitlines() if re.fullmatch(r'\S*/\.tmp/cloudflare-forge/golf-alchemy-[0-9]{8}-[a-f0-9]{8}', line.strip())]
        if not found:
            raise StepFailed('init', 0, 'init did not print the installation directory')
        self.directory = Path(found[-1])

    def verify(self):
        state = json.loads(private_read(Path(self.directory)/'ownership.json'))
        checks = state.get('checks', {})
        self.out('    Receipt: state '+str(state.get('state'))+', deployment '+str(state.get('deployment'))+', '+str(len(checks))+' recorded check(s)'
            +(': '+', '.join(sorted(checks)) if checks else ''))
        if state.get('deployment') != 'alchemy' or state.get('state') != 'retained':
            raise StepFailed('verify', 1, 'The receipt is not a retained Alchemy installation')
        path = '/auth/login' if 'public' in self.o.get('services', []) else '/'
        url = 'https://'+self.o['hostname']+path
        for attempt in range(3):
            status, location = self.http(url)
            if status in (301, 302, 303, 307, 308) and location and access_redirect(location, self.o['hostname']):
                self.out('    '+url+' redirects to Cloudflare Access sign-in, as expected.')
                return
            self.out('    '+url+' answered '+str(status)+(' -> '+str(location) if location else '')+(', retrying in 20s' if attempt < 2 else ''))
            if attempt < 2: self.sleep(20)
        raise StepFailed('verify', 1, 'The hostname did not redirect to Cloudflare Access')

    def execute_all(self, steps):
        remaining = [s for s in steps if s['id'] not in self.progress['done']]
        total = len(steps)
        for s in remaining:
            number = steps.index(s)+1
            how_long = MINUTES.get(s['kind'], '')
            self.out('')
            self.out('['+str(number)+'/'+str(total)+'] '+s['title']+(' - usually '+how_long if how_long else ''))
            started = self.clock()
            try:
                self.run_step(s)
            except StepFailed as failure:
                self.progress['failed'] = {'step': s['id'], 'at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
                    'exit': failure.code, 'message': failure.output.strip().splitlines()[-1][:300] if failure.output.strip() else ''}
                self.save()
                self.out('')
                self.out('Step '+str(number)+'/'+str(total)+' "'+s['title']+'" failed.')
                self.out('What to do: '+HINTS.get(failure.kind, HINTS.get(s['kind'], 'Read the output above.')))
                if self.directory:
                    self.out('Resume with: '+SELF+' '+('install --resume' if self.command == 'install' else 'update')+' '+str(self.directory))
                else:
                    self.out('Nothing was created on Cloudflare yet; rerun the same install command.')
                return 1
            self.progress['done'].append(s['id'])
            self.progress['failed'] = None
            self.save()
            self.out('    done in '+elapsed(self.clock()-started))
        return 0


class StepFailed(Exception):
    def __init__(self, kind, code, output):
        super().__init__(kind)
        self.kind, self.code, self.output = kind, code, output


def access_redirect(location, host):
    target = urllib.parse.urlparse(urllib.parse.urljoin('https://'+host+'/', location))
    return (target.hostname or '').endswith('.cloudflareaccess.com') or target.path.startswith('/cdn-cgi/access/login')


def summary(o, out=print):
    out('')
    out('Golf will be installed with:')
    for label, value in [('cf profile', o['profile']), ('Account', o['account']), ('Zone', o['zone']),
                         ('Golf hostname', 'https://'+o['hostname']), ('Preview hostname', o['preview_hostname']),
                         ('Administrator', o['email']+(' (login '+o['admin_login']+')' if o.get('admin_login') else '')),
                         ('Secrets Store', o.get('secrets_store_id') or 'new (created by the stack)'),
                         ('Access team domain', o.get('team_domain') or 'read during init'),
                         ('Content', {'example': EXAMPLE, 'none': 'none (playgrounds only)'}.get(o['content'], o['content'])),
                         ('Optional services', ', '.join(o['services']) or 'none')]:
        out('  %-19s %s' % (label+':', value))
    if 'public' in o['services']:
        out('  %-19s %s' % ('Public content:', o.get('public_manifest') or 'none published (pass --public-manifest)'))
    if 'webhooks' in o['services']:
        out('  %-19s %s' % ('Webhook origins:', ', '.join(o['webhook_origins'])))
    if 'ssh-hosts' in o['services']:
        out('  %-19s %s' % ('SSH hosts VPC:', o.get('ssh_vpc_tunnel_id') or 'none (direct, Tailscale and Cloudflare Tunnel reach only)'))
    out('This creates Workers, D1, R2, queues, a Workflow, Access applications, API tokens and Secrets Store entries on the account.')
    out('Costs: Workers Paid usage'+(' plus Workers AI inference' if 'ai' in o['services'] else '')+'. Expect 20-60 minutes in total.')


def next_steps(o, directory, out=print):
    url = 'https://'+o['hostname']+('/auth/login' if 'public' in o.get('services', []) else '/')
    out('')
    out('Golf is deployed. Sign in at '+url+' with '+o['email']+' (Cloudflare Access sends a one-time code).')
    out('Next:')
    out('  - Installation directory (private; back it up, never commit it): '+str(directory))
    out('  - Provider tokens expire in seven days: '+SELF.replace('golf_cloudflare.py', 'cloudflare_alchemy_demo.py')+' renew-credentials '+str(directory)+', then '+SELF+' update '+str(directory))
    out('  - Status: '+SELF+' status '+str(directory)+'   Update after git pull: '+SELF+' update '+str(directory))
    if 'email' in o.get('services', []):
        out('  - Email reads degraded until Cloudflare accepts a first message from golf@mail.'+o['hostname']+'.')
    if 'pipelines' in o.get('services', []):
        out('  - Register runners under Settings > Runners.')
    out('  - Remove everything: '+SELF+' destroy '+str(directory))


# ---------------------------------------------------------------- commands

def preflight(args, run, out):
    """Local checks that must pass before install; returns npm projects to install."""
    checks = local_checks(run=run, profile=args.profile)
    blocking = [c for c in checks if c[1] == 'fail' and not c[0].startswith('npm deps')]
    if blocking:
        print_checks(blocking, out)
        raise Stop('Local prerequisites are missing', SELF+' doctor')
    return [c[0].split(': ', 1)[1] for c in checks if c[0].startswith('npm deps') and c[1] == 'fail']


def interactive_mode(args, stdin=None):
    stdin = stdin or sys.stdin
    if args.yes:
        return False
    if not stdin.isatty():
        raise Stop('No terminal for questions', 'pass --yes with every value as flags for a non-interactive install')
    return True


def install(args, run=stream, check=capture, cf_for=None, ask=input, out=print, http=probe, sleep=time.sleep, stdin=None):
    interactive = interactive_mode(args, stdin)
    prompter = Prompter(interactive, ask, out)
    if args.resume:
        directory = installation(args.resume)
        progress = load_progress(directory)
        if not progress:
            raise Stop('No install progress in '+str(directory), 'an installation made with cloudflare_alchemy_demo.py init is managed with update/status/destroy')
        o = progress['options']
        steps = install_steps(o, directory)
        left = [s for s in steps if s['id'] not in progress['done']]
        if not left:
            out('This installation is complete.')
            return 0
        out('Resuming '+str(directory)+' at "'+left[0]['title']+'" ('+str(len(left))+' step(s) left).')
        if not prompter.confirm('Continue?', args.yes):
            out('Nothing changed.')
            return 1
        runner = Runner(o, directory, progress, run, out, http=http, sleep=sleep)
        code = runner.execute_all(steps)
        if code == 0: next_steps(o, directory, out)
        return code
    out('Checking local prerequisites ...')
    missing_npm = preflight(args, check, out)
    out('Reading your Cloudflare account (read-only) ...')
    o = resolve_options(args, prompter, cf_for or (lambda account: make_cf(args.profile, account)))
    summary(o, out)
    if not prompter.confirm('Proceed with the install?', args.yes):
        out('Nothing changed.')
        return 1
    runner = Runner(o, None, None, run, out, http=http, sleep=sleep)
    code = runner.execute_all(install_steps(o, None, missing_npm))
    if code == 0: next_steps(o, runner.directory, out)
    return code


def status(args, out=print, clock=time.time):
    directory = installation(args.directory)
    progress = load_progress(directory)
    out('Installation '+directory.name)
    if progress:
        o = progress['options']
        steps = install_steps(o, directory)
        done = [s for s in steps if s['id'] in progress['done']]
        out('  Golf hostname:   https://'+o['hostname'])
        out('  Services:        '+(', '.join(o['services']) or 'none'))
        out('  Install steps:   '+str(len(done))+'/'+str(len(steps))+' done')
        if progress.get('failed'):
            f = progress['failed']
            out('  Last failure:    '+f['step']+' at '+f['at']+(': '+f['message'] if f.get('message') else ''))
            out('  Resume with:     '+SELF+' install --resume '+str(directory))
    else:
        out('  (made without golf_cloudflare.py install; showing the receipt only)')
    receipt = directory/'ownership.json'
    if receipt.exists():
        state = json.loads(private_read(receipt))
        out('  Receipt state:   '+str(state.get('state'))+' ('+str(state.get('deployment'))+')')
        out('  Provider tokens: expire '+str(state.get('demo', {}).get('credentials_expire_at')))
        out('  Recorded checks: '+str(len(state.get('checks', {}))))
    else:
        out('  Receipt:         not written yet (deploy has not completed)')
    token = directory/'operator.json'
    if token.exists():
        age = clock()-token.stat().st_mtime
        out('  Deploy token:    '+('renewed '+elapsed(age)+' ago' if age < 8*3600 else 'expired; update renews it'))
    try:
        pending = schema_pending(directory)
        out('  Schema:          '+('unknown' if pending is None else 'current' if not pending else str(len(pending))+' migration(s) pending; run update'))
    except ValueError as error:
        out('  Schema:          '+str(error))
    return 0


def update(args, run=stream, ask=input, out=print, http=probe, sleep=time.sleep, stdin=None):
    directory = installation(args.directory)
    progress = load_progress(directory)
    prompter = Prompter(interactive_mode(args, stdin), ask, out)
    adding = args.all or args.with_services
    if progress is None:
        if adding:
            raise Stop('Adding services needs an installation made with install', 'use the cloudflare_alchemy_demo.py enable-* actions')
        o, done = {'services': [], 'hostname': None}, []
    else:
        o, done = progress['options'], [d for d in progress['done'] if not d.startswith('update:')]
        if not all(core in done for core in CORE):
            raise Stop('The install has not finished', SELF+' install --resume '+str(directory))
    if adding:
        for key in ['agent_path', 'actions_url', 'ssh_vpc_tunnel_id']:
            if getattr(args, key): o[key] = getattr(args, key)
        if args.webhook_origin: o['webhook_origins'] = list(args.webhook_origin)
        wanted = parse_services(args.with_services, args.all)
        o['services'] = [s for s in SERVICES if s in o['services'] or s in wanted]
        if 'webhooks' in o['services'] and not o.get('webhook_origins'):
            raise Stop('webhooks needs --webhook-origin https://RECEIVER')
        if 'public' in wanted and not o.get('public_manifest'):
            o['public_manifest'] = resolve_public_manifest(args.public_manifest, o)
    services = pending_services(o, directory, done)
    steps = update_steps(o, directory, services)
    out('Update '+directory.name+':')
    for number, s in enumerate(steps, 1):
        out('  '+str(number)+'. '+s['title'])
    if not prompter.confirm('Proceed?', args.yes):
        out('Nothing changed.')
        return 1
    runner = Runner(o, directory, {**(progress or {}), 'schema': 'golf.cloudflare.install.v1', 'done': done, 'failed': None},
        run, out, http=http, sleep=sleep, command='update')
    if progress is None:
        runner.save = lambda: None
    code = runner.execute_all(steps)
    if code == 0:
        out('Update complete.')
    return code


def destroy(args, run=stream, ask=input, out=print):
    directory = installation(args.directory)
    progress = load_progress(directory)
    host = progress['options']['hostname'] if progress else None
    out('This permanently removes installation '+directory.name+(' at https://'+host if host else '')+':')
    out('  its Workers, D1 database and data, Git repositories, R2 buckets, queues, Access applications, previews,')
    out('  registry images and API tokens. The account\'s Secrets Store is kept; the installation\'s secrets are removed.')
    out('  It refuses while CI jobs are active. The private directory stays for inspection.')
    if args.confirm is not None:
        typed = args.confirm
    else:
        if not sys.stdin.isatty():
            raise Stop('Destroy needs a typed confirmation', '--confirm '+directory.name)
        typed = ask('Type the installation name ('+directory.name+') to destroy it: ').strip()
    if typed != directory.name:
        out('Name differs; nothing changed.')
        return 1
    out('Destroying - usually '+MINUTES['destroy']+' ...')
    code, _ = run([sys.executable, WRAPPER, 'destroy', str(directory)])
    if code:
        out('Destroy stopped partway. Inspect the output above and the private journals in '+str(directory)+' before retrying (see deploy/alchemy/README.md).')
        return 1
    if progress:
        progress['destroyed_at'] = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
        replace_private_json(directory/PROGRESS, progress)
    out('Destroyed.')
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog='golf_cloudflare.py', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)

    doc = sub.add_parser('doctor', help='check local prerequisites (and, with --remote, read-only account settings)',
        description='Check local prerequisites with fixes. --remote adds read-only (GET) account checks through the cf profile.')
    doc.add_argument('--profile', default='golf', help='cf CLI profile (default golf)')
    doc.add_argument('--fix', action='store_true', help='run npm ci where locked dependencies are missing')
    doc.add_argument('--remote', action='store_true', help='also run read-only account checks: sign-in, Workers Paid, Zero Trust, zone, Secrets Store')
    doc.add_argument('--account-id', help='account to check when the profile has several')
    doc.add_argument('--hostname', help='planned Golf hostname: checks its zone is on the account and active')

    inst = sub.add_parser('install', help='discover, ask, confirm, then deploy end to end (resumable)',
        description='Install Golf on Cloudflare. Interactive by default; --yes with flags runs unattended. '
                    'Discovers the account, zone, Secrets Store and Access team domain with read-only cf calls, '
                    'asks for the rest, shows a summary and asks before any change.',
        epilog='Example: '+SELF+' install --yes --hostname golf.example.com --email you@example.com --content example --with ai,public')
    inst.add_argument('--resume', metavar='DIR', help='continue an interrupted install from its failed step')
    inst.add_argument('--yes', action='store_true', help='never ask: take values from flags/discovery and skip the confirmation')
    inst.add_argument('--profile', default='golf', help='cf CLI profile (default golf; create it with cf auth create golf)')
    inst.add_argument('--account-id', help='default: the only account on the profile; otherwise asked')
    inst.add_argument('--zone-id', help='default: the zone that contains --hostname')
    inst.add_argument('--hostname', help='unused Golf hostname, e.g. golf.example.com')
    inst.add_argument('--preview-hostname', help='default: previews-HOSTNAME in the same zone')
    inst.add_argument('--email', help='administrator email that signs in through Cloudflare Access')
    inst.add_argument('--admin-login', help='Golf login; default derived from the email')
    inst.add_argument('--secrets-store-id', help='default: the account\'s existing store, or a new one')
    inst.add_argument('--access-team-domain', help='default: read from the Zero Trust organization')
    inst.add_argument('--content', help='example ('+EXAMPLE+'), none, or a manifest PATH')
    service_arguments(inst)

    st = sub.add_parser('status', help='show progress, receipt and token ages (offline)')
    st.add_argument('directory')

    up = sub.add_parser('update', help='renew if needed, plan, migrate when the schema changed, deploy; --with adds services')
    up.add_argument('directory')
    up.add_argument('--yes', action='store_true', help='skip the confirmation')
    service_arguments(up)

    de = sub.add_parser('destroy', help='remove the installation (typed confirmation)')
    de.add_argument('directory')
    de.add_argument('--confirm', metavar='NAME', help='the installation directory name, for unattended use')
    return parser


def service_arguments(parser):
    group = parser.add_argument_group('optional services')
    group.add_argument('--with', dest='with_services', metavar='LIST', help='comma-separated: '+','.join(SERVICES))
    group.add_argument('--all', action='store_true', help='every optional service')
    group.add_argument('--agent-path', help='ai: the one source file agent proposals may change')
    group.add_argument('--actions-url', help='pipelines: origin for unqualified marketplace actions, e.g. https://code.forgejo.org')
    group.add_argument('--webhook-origin', action='append', help='webhooks: approved receiver origin (repeatable)')
    group.add_argument('--ssh-vpc-tunnel-id', help='ssh-hosts: Cloudflare Tunnel UUID to bind as the Workers VPC network (docs/SSH_HOSTS.md)')
    group.add_argument('--public-manifest', help='public: what to publish; default '+EXAMPLE_PUBLIC+' with --content example')


def main(argv=None):
    args = build_parser().parse_args(argv)
    os.umask(0o077)
    try:
        if args.command == 'doctor': return doctor(args)
        if args.command == 'install': return install(args)
        if args.command == 'status': return status(args)
        if args.command == 'update': return update(args)
        if args.command == 'destroy': return destroy(args)
    except Stop as error:
        print('Stopped: '+str(error)+('\n  fix: '+error.fix if error.fix else ''), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print('\nInterrupted. Resume with install --resume DIR if an installation directory was printed.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
