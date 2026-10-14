import io
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import golf_cloudflare as gc
from cloudflare_setup import replace_private_json

ACCOUNT, OTHER, ZONE, STORE = 'a'*32, 'b'*32, 'c'*32, 'd'*32
NAME = 'golf-alchemy-20261014-0123abcd'


class FakeCf:
    """Answers read-only cf calls from a table; records every call."""
    def __init__(self, zones=('example.com',), accounts=((ACCOUNT, 'Main'),), stores=(), team='team.cloudflareaccess.com',
                 subscriptions=(), signed_in=True, zone_status='active'):
        self.calls = []
        self.zones, self.accounts, self.stores, self.team = zones, accounts, stores, team
        self.subscriptions, self.signed_in, self.zone_status = subscriptions, signed_in, zone_status

    def __call__(self, *args):
        self.calls.append(args)
        if args[:2] == ('auth', 'whoami'):
            return {'authenticated': self.signed_in, 'tokenValid': self.signed_in, 'accounts': [{'id': i, 'name': n} for i, n in self.accounts]}
        if args[:2] == ('zones', 'list'):
            name = args[args.index('--name')+1]
            return [{'id': ZONE, 'name': name, 'status': self.zone_status}] if name in self.zones else []
        if args[:3] == ('secrets-store', 'stores', 'list'):
            return [{'id': s, 'name': 'default'} for s in self.stores]
        if args[:3] == ('zero-trust', 'organization', 'get'):
            return {'auth_domain': self.team} if self.team else {}
        if args[:3] == ('accounts', 'subscriptions', 'get'):
            return [{'rate_plan': {'id': plan, 'public_name': plan}} for plan in self.subscriptions]
        raise AssertionError('unexpected cf call '+repr(args))

    def writes(self):
        return [c for c in self.calls if any(word in c for word in ['create', 'delete', 'update', 'put'])]


def parse(*argv):
    return gc.build_parser().parse_args(list(argv))


def quiet():
    lines = []
    return lines, lines.append


class Discovery(unittest.TestCase):
    def test_zone_is_the_longest_suffix_on_the_account(self):
        self.assertEqual(gc.zone_candidates('golf.dev.example.com'), ['golf.dev.example.com', 'dev.example.com', 'example.com'])
        cf = FakeCf(zones=('example.com', 'dev.example.com'))
        self.assertEqual(gc.discover_zone(cf, ACCOUNT, 'golf.dev.example.com')['name'], 'dev.example.com')
        self.assertIsNone(gc.discover_zone(FakeCf(zones=()), ACCOUNT, 'golf.example.com'))
        self.assertTrue(all(call[:2] == ('zones', 'list') and ACCOUNT in call for call in cf.calls))

    def test_preview_suggestion_stays_in_the_zone(self):
        self.assertEqual(gc.suggest_preview('golf.example.com', 'example.com'), 'previews-golf.example.com')
        self.assertEqual(gc.suggest_preview('example.com', 'example.com'), 'previews.example.com')
        self.assertTrue(gc.in_zone(gc.suggest_preview('a.b.example.com', 'example.com'), 'example.com'))
        self.assertLessEqual(len(gc.suggest_preview('x'*63+'.example.com', 'example.com').split('.')[0]), 63)

    def test_identity_store_team_and_plan(self):
        with self.assertRaises(gc.Stop): gc.discover_identity(FakeCf(signed_in=False))
        self.assertEqual(gc.discover_identity(FakeCf(accounts=((ACCOUNT, 'A'), (OTHER, 'B'))))[0][1]['id'], OTHER)
        self.assertEqual(gc.discover_secret_stores(FakeCf(stores=(STORE,))), [STORE])
        self.assertEqual(gc.discover_team_domain(FakeCf()), 'https://team.cloudflareaccess.com')
        self.assertIsNone(gc.discover_team_domain(FakeCf(team=None)))
        self.assertTrue(gc.workers_paid(FakeCf(subscriptions=('workers_paid',))))
        self.assertFalse(gc.workers_paid(FakeCf(subscriptions=('free',))))

    def test_cf_caller_uses_the_profile_without_ambient_tokens(self):
        seen = {}
        def run(argv, **kwargs):
            seen.update(argv=argv, env=kwargs['env'])
            return types.SimpleNamespace(returncode=0, stdout='{"success": true, "result": [1]}', stderr='')
        with patch.dict(os.environ, CLOUDFLARE_API_TOKEN='ambient-test-value'):
            self.assertEqual(gc.make_cf('golf', ACCOUNT, run)('zones', 'list'), [1])
        self.assertEqual(seen['argv'][:3], ['cf', '--profile', 'golf'])
        self.assertNotIn('CLOUDFLARE_API_TOKEN', seen['env'])
        self.assertEqual((seen['env']['CLOUDFLARE_ACCOUNT_ID'], seen['env']['CI'], seen['env']['CF_SEND_TELEMETRY']), (ACCOUNT, '1', 'false'))
        failing = lambda argv, **kwargs: types.SimpleNamespace(returncode=1, stdout='', stderr='boom\nAuthentication error')
        with self.assertRaisesRegex(gc.Stop, 'Authentication error'): gc.make_cf('golf', None, failing)('auth', 'whoami')


class Options(unittest.TestCase):
    def resolve(self, cf, *argv, answers=None):
        args = parse('install', *argv)
        lines, out = quiet()
        prompter = gc.Prompter(answers is not None, (lambda prompt: answers.pop(0)) if answers is not None else None, out)
        return gc.resolve_options(args, prompter, lambda account: cf), lines

    def test_non_interactive_discovers_everything_else(self):
        cf = FakeCf(stores=(STORE,))
        o, _ = self.resolve(cf, '--yes', '--hostname', 'golf.example.com', '--email', 'jane.doe@example.com', '--content', 'example', '--with', 'search,public')
        self.assertEqual((o['account'], o['zone'], o['preview_hostname'], o['secrets_store_id'], o['team_domain']),
                         (ACCOUNT, ZONE, 'previews-golf.example.com', STORE, 'https://team.cloudflareaccess.com'))
        self.assertEqual(o['services'], ['ai', 'search', 'public'])
        self.assertEqual(o['public_manifest'], gc.EXAMPLE_PUBLIC)
        self.assertEqual(cf.writes(), [])

    def test_non_interactive_lists_every_missing_flag(self):
        cf = FakeCf(accounts=((ACCOUNT, 'A'), (OTHER, 'B')))
        with self.assertRaises(gc.Stop) as raised:
            self.resolve(cf, '--yes', '--hostname', 'golf.example.com', '--with', 'webhooks')
        for flag in ['--account-id', '--preview-hostname', '--email', '--content', '--webhook-origin']:
            self.assertIn(flag, str(raised.exception))

    def test_refusals(self):
        base = ['--yes', '--hostname', 'golf.example.com', '--email', 'jane@example.com', '--content', 'none']
        with self.assertRaisesRegex(gc.Stop, 'No zone'): self.resolve(FakeCf(zones=()), *base)
        with self.assertRaisesRegex(gc.Stop, 'pending'): self.resolve(FakeCf(zone_status='pending'), *base)
        with self.assertRaisesRegex(gc.Stop, 'zone-id differs'): self.resolve(FakeCf(), *base, '--zone-id', OTHER)
        with self.assertRaisesRegex(gc.Stop, 'Zero Trust'): self.resolve(FakeCf(team=None), *base)
        with self.assertRaisesRegex(gc.Stop, 'not visible'): self.resolve(FakeCf(), *base, '--account-id', OTHER)
        with self.assertRaisesRegex(ValueError, 'preview hostname must be in'): self.resolve(FakeCf(), *base, '--preview-hostname', 'p.other.org')
        with self.assertRaisesRegex(gc.Stop, 'Unknown service'): self.resolve(FakeCf(), *base, '--with', 'ai,teleport')

    def test_interactive_questions_offer_discovered_defaults(self):
        cf = FakeCf(accounts=((ACCOUNT, 'A'), (OTHER, 'B')))
        answers = ['9', '2', 'golf.example.com', '', 'jane@example.com', '2', '5,observability']
        o, lines = self.resolve(cf, answers=answers)
        self.assertEqual(answers, [])
        self.assertEqual((o['account'], o['preview_hostname'], o['content'], o['services']), (OTHER, 'previews-golf.example.com', 'none', ['observability', 'ai']))
        self.assertIn('  2) B ('+OTHER+')', lines)

    def test_interactive_reasks_after_an_invalid_answer(self):
        answers = ['Not A Host', 'golf.example.com', 'previews.example.com', 'not-an-email', 'jane@example.com', '1', '']
        o, lines = self.resolve(FakeCf(), answers=answers)
        self.assertEqual((o['hostname'], o['email'], o['content'], o['services']), ('golf.example.com', 'jane@example.com', 'example', []))

    def test_terminal_required_without_yes(self):
        tty = types.SimpleNamespace(isatty=lambda: False)
        with self.assertRaisesRegex(gc.Stop, 'No terminal'): gc.interactive_mode(parse('install'), tty)
        self.assertFalse(gc.interactive_mode(parse('install', '--yes'), tty))


OPTIONS = {'profile': 'golf', 'account': ACCOUNT, 'zone': ZONE, 'hostname': 'golf.example.com', 'preview_hostname': 'previews-golf.example.com',
           'email': 'jane@example.com', 'admin_login': None, 'secrets_store_id': None, 'team_domain': 'https://team.cloudflareaccess.com',
           'content': 'example', 'services': [], 'agent_path': None, 'actions_url': None, 'webhook_origins': [], 'public_manifest': None}


def actions(steps):
    return [s['argv'][1] if s['argv'] and s['argv'][0] == gc.WRAPPER else s['id'] for s in steps]


class Sequencing(unittest.TestCase):
    def test_each_service_has_its_prerequisites(self):
        expected = {
            'observability': ['enable-observability', 'deploy'], 'analytics': ['enable-analytics', 'deploy'],
            'dead-letter': ['enable-dead-letter', 'deploy'], 'operations': ['enable-operations', 'renew-deploy', 'deploy'],
            'ai': ['enable-ai', 'renew-deploy', 'deploy'], 'search': ['migrate', 'enable-search', 'renew-deploy', 'deploy'],
            'email': ['migrate', 'enable-email', 'renew-deploy', 'deploy'], 'pipelines': ['migrate', 'enable-pipelines', 'deploy'],
            'webhooks': ['enable-webhooks', 'deploy'], 'public': ['migrate', 'enable-public', 'deploy', 'seed-public'],
            'rate-limit': ['enable-rate-limit', 'deploy']}
        self.assertEqual(set(expected), set(gc.SERVICES))
        o = {**OPTIONS, 'webhook_origins': ['https://hooks.example.com'], 'public_manifest': gc.EXAMPLE_PUBLIC}
        for name, sequence in expected.items():
            steps = gc.service_steps(name, o, '/dir', set())
            self.assertEqual(actions(steps), sequence, name)
            self.assertTrue(all(s['retry'] == (s['argv'][1] == 'deploy') for s in steps), name)
        self.assertEqual(gc.service_steps('webhooks', o, '/dir', set())[0]['argv'][-2:], ['--origin', 'https://hooks.example.com'])
        self.assertIn('--agent-path', gc.service_steps('ai', {**o, 'agent_path': 'calc.py'}, '/dir', set())[0]['argv'])
        self.assertEqual(actions(gc.service_steps('public', {**o, 'public_manifest': None}, '/dir', set())), ['migrate', 'enable-public', 'deploy'])

    def test_full_install_order_migrates_once(self):
        o = {**OPTIONS, 'services': gc.parse_services('email,search,public'), 'public_manifest': gc.EXAMPLE_PUBLIC}
        steps = gc.install_steps(o, None, ['web'])
        names = actions(steps)
        self.assertEqual(names[:6], ['npm:web', 'build-image', 'init', 'plan', 'deploy', 'seed'])
        self.assertEqual(names.count('migrate'), 1)
        self.assertLess(names.index('enable-ai'), names.index('enable-search'))
        self.assertEqual(names[-1], 'verify')
        self.assertEqual(len({s['id'] for s in steps}), len(steps))
        init = steps[2]['argv']
        self.assertEqual(init[:2], [gc.WRAPPER, 'init'])
        self.assertNotIn(gc.DIR, init)
        self.assertIn('--access-team-domain', init)
        self.assertEqual(steps[5]['argv'][-2:], ['--manifest', gc.EXAMPLE])
        self.assertIn('--no-seed', gc.seed_argv({**o, 'content': 'none'}, '/dir'))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.forge = self.root/'.tmp/cloudflare-forge'
        self.forge.mkdir(parents=True)
        self.directory = self.forge/NAME
        self.calls = []
        self.lines = []
        self.patches = [patch.object(gc, 'ROOT', self.root)]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in self.patches: p.stop()
        self.temporary.cleanup()

    def make_directory(self):
        self.directory.mkdir(mode=0o700)
        replace_private_json(self.directory/'alchemy-input.json', {'name': NAME})
        replace_private_json(self.directory/'operator.json', {'id': 'token-id'})
        replace_private_json(self.directory/'ownership.json', {'state': 'retained', 'deployment': 'alchemy', 'checks': {'ci': {}, 'preview': {}},
            'demo': {'credentials_expire_at': '2026-10-21T00:00:00Z'}})

    def fake_run(self, script=None):
        """script: {action: [outputs...]}; an output starting with FAIL fails with that text."""
        script = script or {}
        def run(command):
            argv = [str(a) for a in command]
            self.calls.append(argv)
            action = argv[2] if argv[0].endswith('python3') or 'python' in argv[0] else argv[0]
            if action == 'init':
                self.make_directory()
                return 0, 'Alchemy init\n'+str(self.directory)+'\n'
            queue = script.get(action)
            output = queue.pop(0) if queue else 'ok\n'
            return (1, output) if output.startswith('FAIL') else (0, output)
        return run

    def runner(self, o, script=None, directory=None, progress=None, http=None):
        sleeps = []
        runner = gc.Runner(o, directory, progress, self.fake_run(script), self.lines.append, http=http or (lambda url: (302, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x')),
                           sleep=sleeps.append, forge=self.forge)
        runner.sleeps = sleeps
        return runner

    def wrapper_actions(self):
        return [c[2] if c[1] == gc.WRAPPER else c[1].rsplit('/', 1)[-1]+':'+c[2] if c[1].startswith('scripts/') else c[0] for c in self.calls]


class Execution(Fixture):
    def test_fresh_install_runs_every_step_and_fills_in_the_directory(self):
        o = {**OPTIONS, 'services': ['observability']}
        runner = self.runner(o)
        self.assertEqual(runner.execute_all(gc.install_steps(o, None)), 0)
        self.assertEqual(self.wrapper_actions(), ['cloudflare-demo-deploy.py:build-image', 'init', 'plan', 'deploy', 'seed', 'enable-observability', 'deploy'])
        self.assertTrue(all(gc.DIR not in call for call in self.calls))
        self.assertTrue(all(str(self.directory) in call for call in self.calls[2:]))
        progress = json.loads((self.directory/gc.PROGRESS).read_text())
        self.assertEqual(progress['done'][-1], 'verify')
        self.assertIsNone(progress['failed'])
        self.assertEqual(oct(os.stat(self.directory/gc.PROGRESS).st_mode & 0o777), '0o600')
        self.assertIn('    https://golf.example.com/ redirects to Cloudflare Access sign-in, as expected.', self.lines)

    def test_failure_records_the_step_and_resume_continues_there(self):
        o = {**OPTIONS, 'services': ['ai']}
        self.assertEqual(self.runner(o, {'seed': ['FAIL: import timed out']*gc.SETTLE_ATTEMPTS}).execute_all(gc.install_steps(o, None)), 1)
        progress = json.loads((self.directory/gc.PROGRESS).read_text())
        self.assertEqual(progress['done'], ['build-image', 'init', 'plan', 'deploy'])
        self.assertEqual(progress['failed']['step'], 'seed')
        self.assertIn('Resume with: python3 scripts/golf_cloudflare.py install --resume '+str(self.directory), self.lines)
        self.calls.clear()
        resumed = self.runner(progress['options'], directory=self.directory, progress=progress)
        self.assertEqual(resumed.execute_all(gc.install_steps(progress['options'], self.directory)), 0)
        self.assertEqual(self.wrapper_actions(), ['seed', 'enable-ai', 'renew-deploy', 'deploy'])

    def test_known_first_deploy_errors_are_retried_once(self):
        o = {**OPTIONS, 'services': ['ai']}
        for marker in gc.KNOWN_RETRY:
            self.calls.clear()
            shutil_rm(self.directory)
            script = {'deploy': ['ok\n', 'FAIL ... '+marker+' ...\n', 'ok\n']}
            self.assertEqual(self.runner(o, script).execute_all(gc.install_steps(o, None)), 0, marker)
            self.assertEqual(self.wrapper_actions()[-4:], ['enable-ai', 'renew-deploy', 'deploy', 'deploy'])

    def test_seeding_waits_for_the_release_and_retries(self):
        o = dict(OPTIONS)
        self.assertEqual(self.runner(o, {'seed': ['FAIL clone retained repository failed']}).execute_all(gc.install_steps(o, None)), 0)
        self.assertEqual(self.wrapper_actions().count('seed'), 2)
        shutil_rm(self.directory); self.calls.clear()
        runner = self.runner(o, {'seed': ['FAIL x']*gc.SETTLE_ATTEMPTS})
        self.assertEqual(runner.execute_all(gc.install_steps(o, None)), 1)
        self.assertEqual(self.wrapper_actions().count('seed'), gc.SETTLE_ATTEMPTS)
        self.assertEqual(runner.sleeps, [gc.SETTLE_DELAY]*(gc.SETTLE_ATTEMPTS-1))

    def test_other_errors_and_a_second_known_error_are_not_retried(self):
        o = dict(OPTIONS)
        self.assertEqual(self.runner(o, {'deploy': ['FAIL hostname already in use']}).execute_all(gc.install_steps(o, None)), 1)
        self.assertEqual(self.wrapper_actions().count('deploy'), 1)
        shutil_rm(self.directory); self.calls.clear()
        marker = 'FAIL '+gc.KNOWN_RETRY[0]
        self.assertEqual(self.runner(o, {'deploy': [marker, marker]}).execute_all(gc.install_steps(o, None)), 1)
        self.assertEqual(self.wrapper_actions().count('deploy'), 2)

    def test_stale_deploy_token_and_machine_credential_are_renewed_first(self):
        self.make_directory()
        replace_private_json(self.directory/'retained-auth.json', {})
        old = time.time() - 9*3600
        for name in ['operator.json', 'retained-auth.json']:
            os.utime(self.directory/name, (old, old))
        o = dict(OPTIONS)
        progress = {'schema': 'golf.cloudflare.install.v1', 'options': o, 'done': ['build-image', 'init', 'plan'], 'failed': None}
        self.assertEqual(self.runner(o, directory=self.directory, progress=progress).execute_all(gc.install_steps(o, self.directory)), 0)
        self.assertEqual(self.wrapper_actions(), ['renew-deploy', 'deploy', 'cloudflare-demo-deploy.py:renew-authority', 'seed'])

    def test_init_failure_after_creating_the_directory_resumes_with_renew_deploy(self):
        o = dict(OPTIONS)
        runner = self.runner(o)
        base = runner.run
        def run(command):
            code, output = base(command)
            return (1, 'Alchemy deployment permissions are unavailable') if command[2] == 'init' else (code, output)
        runner.run = run
        (self.directory/'operator.json').unlink(missing_ok=True)
        self.assertEqual(runner.execute_all(gc.install_steps(o, None)), 1)
        (self.directory/'operator.json').unlink()
        progress = json.loads((self.directory/gc.PROGRESS).read_text())
        self.assertEqual((progress['done'], progress['failed']['step']), (['build-image'], 'init'))
        self.calls.clear()
        self.assertEqual(self.runner(o, directory=self.directory, progress=progress).execute_all(gc.install_steps(o, self.directory))
                         , 0)
        self.assertEqual(self.wrapper_actions()[:3], ['renew-deploy', 'plan', 'deploy'])

    def test_failure_before_init_says_nothing_was_created(self):
        o = dict(OPTIONS)
        self.assertEqual(self.runner(o, {'build-image': ['FAIL docker daemon']}).execute_all(gc.install_steps(o, None, ['web'])), 1)
        self.assertEqual(self.wrapper_actions(), ['npm', 'cloudflare-demo-deploy.py:build-image'])
        self.assertFalse(self.directory.exists())
        self.assertIn('Nothing was created on Cloudflare yet; rerun the same install command.', self.lines)
        self.assertTrue(any('linux/amd64' in line for line in self.lines))

    def test_verify_requires_the_access_redirect(self):
        self.make_directory()
        o = dict(OPTIONS)
        steps = [gc.step('verify', 'Verify', kind='verify')]
        runner = self.runner(o, directory=self.directory, http=lambda url: (200, None))
        self.assertEqual(runner.execute_all(steps), 1)
        self.assertEqual(runner.sleeps, [20, 20])
        self.assertTrue(any('30 minutes' in line for line in self.lines))
        public = {**o, 'services': ['public']}
        seen = []
        runner = self.runner(public, directory=self.directory, http=lambda url: seen.append(url) or (302, '/cdn-cgi/access/login/golf.example.com'))
        self.assertEqual(runner.execute_all(steps), 0)
        self.assertEqual(seen, ['https://golf.example.com/auth/login'])
        self.assertFalse(gc.access_redirect('https://evil.example.com/login', 'golf.example.com'))


def shutil_rm(path):
    import shutil
    shutil.rmtree(path, ignore_errors=True)


class Commands(Fixture):
    def progress(self, done, services=()):
        self.make_directory()
        o = {**OPTIONS, 'services': list(services)}
        replace_private_json(self.directory/gc.PROGRESS, {'schema': 'golf.cloudflare.install.v1', 'options': o, 'done': list(done), 'failed': None})
        return o

    def test_resume_through_the_command(self):
        o = self.progress(['build-image', 'init', 'plan', 'deploy'])
        args = parse('install', '--resume', str(self.directory), '--yes')
        self.assertEqual(gc.install(args, run=self.fake_run(), out=self.lines.append, http=lambda url: (302, 'https://t.cloudflareaccess.com/'), sleep=lambda s: None), 0)
        self.assertEqual(self.wrapper_actions(), ['seed'])
        self.assertTrue(any(line.startswith('Golf is deployed. Sign in at https://golf.example.com/') for line in self.lines))

    def test_install_refuses_a_directory_outside_the_private_root(self):
        with self.assertRaisesRegex(gc.Stop, 'installation directory'):
            gc.install(parse('install', '--resume', str(self.root), '--yes'), out=self.lines.append)
        self.progress(['init'])
        self.directory.chmod(0o755)
        with self.assertRaisesRegex(gc.Stop, 'private'):
            gc.install(parse('install', '--resume', str(self.directory), '--yes'), out=self.lines.append)

    def test_fresh_install_command_confirms_before_any_step(self):
        with patch.object(gc, 'preflight', return_value=[]):
            args = parse('install', '--hostname', 'golf.example.com', '--email', 'jane@example.com', '--content', 'none')
            tty = types.SimpleNamespace(isatty=lambda: True)
            answers = ['', '', 'n']
            code = gc.install(args, run=self.fake_run(), cf_for=lambda account: FakeCf(), ask=lambda prompt: answers.pop(0), out=self.lines.append, stdin=tty)
        self.assertEqual((code, self.calls), (1, []))
        self.assertIn('Nothing changed.', self.lines)
        self.assertIn('  Preview hostname:   previews-golf.example.com', self.lines)

    def test_update_migrates_only_when_needed_and_adds_services(self):
        o = self.progress(['build-image', 'init', 'plan', 'deploy', 'seed', 'verify'])
        with patch.object(gc, 'schema_pending', return_value=[]):
            self.assertEqual(gc.update(parse('update', str(self.directory), '--yes'), run=self.fake_run(), out=self.lines.append), 0)
        self.assertEqual(self.wrapper_actions(), ['plan', 'deploy'])
        self.calls.clear()
        with patch.object(gc, 'schema_pending', return_value=[('x.sql', '', '')]):
            self.assertEqual(gc.update(parse('update', str(self.directory), '--yes', '--with', 'email'), run=self.fake_run({'deploy': ['ok', 'FAIL quota']}),
                                       out=self.lines.append), 1)
        self.assertEqual(self.wrapper_actions(), ['plan', 'migrate', 'deploy', 'enable-email', 'renew-deploy', 'deploy'])
        saved = json.loads((self.directory/gc.PROGRESS).read_text())
        self.assertEqual(saved['options']['services'], ['email'])
        self.assertIn('Resume with: python3 scripts/golf_cloudflare.py update '+str(self.directory), self.lines)
        self.calls.clear()
        with patch.object(gc, 'schema_pending', return_value=[]):
            self.assertEqual(gc.update(parse('update', str(self.directory), '--yes'), run=self.fake_run(), out=self.lines.append,
                                       http=lambda url: (302, 'https://t.cloudflareaccess.com/')), 0)
        self.assertEqual(self.wrapper_actions(), ['plan', 'deploy', 'deploy'])

    def test_update_requires_a_finished_install(self):
        self.progress(['build-image', 'init', 'plan'])
        with self.assertRaisesRegex(gc.Stop, 'not finished'):
            gc.update(parse('update', str(self.directory), '--yes'), run=self.fake_run(), out=self.lines.append)

    def test_status_is_offline(self):
        self.progress(['build-image', 'init', 'plan'])
        with patch.object(gc, 'schema_pending', return_value=[]):
            gc.status(parse('status', str(self.directory)), out=self.lines.append)
        self.assertIn('  Install steps:   3/6 done', self.lines)
        self.assertIn('  Provider tokens: expire 2026-10-21T00:00:00Z', self.lines)
        self.assertIn('  Schema:          current', self.lines)

    def test_destroy_needs_the_typed_name(self):
        self.progress(['init'])
        self.assertEqual(gc.destroy(parse('destroy', str(self.directory), '--confirm', 'wrong'), run=self.fake_run(), out=self.lines.append), 1)
        self.assertEqual(self.calls, [])
        self.assertEqual(gc.destroy(parse('destroy', str(self.directory), '--confirm', NAME), run=self.fake_run(), out=self.lines.append), 0)
        self.assertEqual(self.wrapper_actions(), ['destroy'])
        self.assertIn('destroyed_at', json.loads((self.directory/gc.PROGRESS).read_text()))


class Doctor(unittest.TestCase):
    def fake(self, answers):
        def run(argv, timeout=60):
            for prefix, answer in answers.items():
                if ' '.join(argv).startswith(prefix): return answer
            return 0, 'ok'
        return run

    def checks(self, answers=None, env=None, cf_version='1.0.0-beta.13', node_modules=True, machine='x86_64'):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'go.mod').write_text('module x\n\ngo 1.27.1\n')
            (root/'cf/bin').mkdir(parents=True)
            (root/'cf/package.json').write_text(json.dumps({'version': cf_version}))
            for project in gc.NPM_PROJECTS:
                if node_modules:
                    (root/project/'node_modules').mkdir(parents=True)
                    (root/project/'node_modules/.package-lock.json').write_text('{}')
            base = {'node --version': (0, 'v24.15.0'), 'go env GOVERSION': (0, 'go1.27.1'), 'cf auth list': (0, '[{"name": "golf"}]')}
            rows = gc.local_checks(run=self.fake({**base, **(answers or {})}), which=lambda name: str(root/'cf/bin/cf'),
                                   env=env or {}, machine=machine, root=root)
            return {name: (status, fix) for name, status, detail, fix in rows}

    def test_all_good(self):
        self.assertTrue(all(status == 'ok' for status, _ in self.checks().values()))

    def test_fixes_are_specific(self):
        rows = self.checks({'node --version': (0, 'v22.1.0'), 'go env GOVERSION': (0, 'go1.26.0'), 'cf auth list': (0, '[]')},
                           env={'CF_API_TOKEN': 'x'}, cf_version='1.0.0-beta.12', node_modules=False)
        self.assertEqual(rows['Node'][0], 'fail')
        self.assertIn('npm install -g cf@1.0.0-beta.13', rows['cf CLI'][1])
        self.assertEqual(rows['Go'][0], 'warn')
        self.assertEqual(rows['npm deps: web'], ('fail', 'npm --prefix web ci'))
        self.assertIn('unset CF_API_TOKEN', rows['Ambient credentials'][1])
        self.assertIn('cf auth create golf', rows['cf profile golf'][1])

    def test_docker_and_amd64(self):
        self.assertEqual(self.checks({'docker info': (1, 'no daemon')})['Docker'][0], 'fail')
        self.assertEqual(self.checks({'docker buildx inspect': (0, 'Platforms: linux/arm64')}, machine='arm64')['linux/amd64 builds'][0], 'fail')
        self.assertEqual(self.checks({'docker buildx inspect': (0, 'Platforms: linux/arm64, linux/amd64')}, machine='arm64')['linux/amd64 builds'][0], 'ok')

    def test_remote_checks_are_read_only_and_report_unknowns(self):
        cf = FakeCf(subscriptions=('workers_paid',), stores=(STORE,))
        rows = {name: status for name, status, *_ in gc.remote_checks(lambda account: cf, None, 'golf.example.com')}
        self.assertEqual(rows['Workers Paid'], 'ok')
        self.assertEqual(rows['Zone for golf.example.com'], 'ok')
        self.assertEqual(rows['workers.dev subdomain'], 'skip')
        self.assertEqual(cf.writes(), [])
        rows = {name: status for name, status, *_ in gc.remote_checks(lambda account: FakeCf(team=None, subscriptions=()), None)}
        self.assertEqual((rows['Zero Trust organization'], rows['Workers Paid']), ('fail', 'warn'))
        rows = {name: status for name, status, *_ in gc.remote_checks(lambda account: FakeCf(signed_in=False))}
        self.assertEqual(rows, {'Signed in': 'fail'})

    def test_doctor_fix_runs_npm_ci(self):
        ran = []
        def run(argv, timeout=60):
            ran.append(argv)
            return 0, 'ok'
        with patch.object(gc, 'local_checks', side_effect=[[('npm deps: web', 'fail', 'missing', 'npm --prefix web ci')], [('npm deps: web', 'ok', 'installed', None)]]):
            self.assertEqual(gc.doctor(parse('doctor', '--fix'), run=run, out=lambda line: None), 0)
        self.assertEqual(ran, [['npm', '--prefix', 'web', 'ci']])


if __name__ == '__main__':
    unittest.main()
