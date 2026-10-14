import test from 'node:test';
import assert from 'node:assert/strict';
import { sealingKey, seal, open } from './src/sealed.mjs';
import { executionValueBindings, executionValueBody, executionValueName, executionValueState } from './src/execution-values.mjs';

const binding = fill => ({ get: async () => Buffer.alloc(32, fill).toString('base64') });

test('sealed values open only under the same key and additional data', async () => {
  const { key, id } = await sealingKey(binding(7), 'Fixture'), other = await sealingKey(binding(8), 'Fixture');
  assert.match(id, /^[a-f0-9]{16}$/); assert.notEqual(id, other.id); assert.equal((await sealingKey(binding(7), 'Fixture')).id, id);
  const additional = ['golf.native.execution-value.v1', 'https://golf.example.com', 1, 'repo-a', 'value', 1, 'NAME', 'secret', 20];
  const sealed = await seal(key, additional, 'fixture-secret-value');
  assert.equal(sealed.includes('fixture'), false); assert.notEqual(await seal(key, additional, 'fixture-secret-value'), sealed);
  assert.equal(await open(key, additional, sealed), 'fixture-secret-value');
  for (let i = 0; i < additional.length; i++) await assert.rejects(open(key, additional.map((part, index) => index === i ? typeof part === 'number' ? part + 1 : part + 'x' : part), sealed));
  await assert.rejects(open(other.key, additional, sealed));
  const [iv, body] = sealed.split('.'), flipped = Buffer.from(body, 'base64'); flipped[0] ^= 1;
  await assert.rejects(open(key, additional, iv + '.' + flipped.toString('base64')));
  for (const unusable of [{ get: async () => 'short' }, { get: async () => undefined }, { get: async () => Buffer.alloc(31, 1).toString('base64') }])
    await assert.rejects(sealingKey(unusable, 'Fixture'), /^Error: Fixture encryption key unavailable$/);
});

test('the shared envelope still opens webhook credentials sealed before the helper was extracted', async () => {
  // Exactly the statements webhooks.mjs used inline, so existing subscriptions stay readable.
  const text = new TextEncoder(), encode = bytes => btoa(String.fromCharCode(...bytes)), raw = Buffer.alloc(32, 7);
  const identity = ['golf.native.webhook.v1', 'https://golf.example.com', 1, 'repo-a', '11111111-1111-4111-8111-111111111111', 1], value = { endpoint: 'https://receiver.example.com/hook', signingSecret: 'x'.repeat(40) };
  const iv = crypto.getRandomValues(new Uint8Array(12)), legacy = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(JSON.stringify(identity)) }, legacy, text.encode(JSON.stringify(value)));
  const { key } = await sealingKey(binding(7), 'Webhook');
  assert.deepEqual(JSON.parse(await open(key, identity, encode(iv) + '.' + encode(new Uint8Array(encrypted)))), value);
});

test('value names keep process and controller authority out of reach', () => {
  for (const name of ['DEPLOY_TOKEN', 'A', 'A'.repeat(64), 'REGION_2', 'TRACEPARENT', 'CIRCLE', 'FFMPEG_PATH', 'GITLABS']) assert.equal(executionValueName(name), true, name);
  for (const name of ['PATH', 'HOME', 'ENV', 'IFS', 'CI', 'TRACE', 'PS4', 'SHELLOPTS', 'BASHOPTS', 'NODE_OPTIONS', 'PYTHONPATH', 'HTTPS_PROXY', 'SSL_CERT_FILE', 'GIT_CONFIG_COUNT',
    'GOLF_COMMIT', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'RUNNER_TEMP', 'ACT_TOKEN', 'DOCKER_HOST', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'XDG_CONFIG_HOME', 'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK', 'NODE_PATH', 'BASH_ENV', 'PYTHON_STARTUP', 'SYSTEMD_LOG_LEVEL',
    'CI_JOB_TOKEN', 'FF_NETWORK_PER_BUILD', 'GITLAB_CI', 'path', 'Deploy', '_LEADING', '9LIVES', 'WITH-DASH', 'WITH SPACE', 'A'.repeat(65), '', null, 7]) assert.equal(executionValueName(name), false, String(name));
});

test('value bodies are bounded single-line UTF-8 and secrets have a minimum length', () => {
  for (const [value, secret] of [['12345678', true], ['x', false], ['x'.repeat(8192), true], ['é'.repeat(4096), true], ['value with spaces', true], ['emoji-😀-fine', true]]) assert.equal(executionValueBody(value, secret), true, value.slice(0, 20));
  for (const [value, secret] of [['1234567', true], ['', false], ['x'.repeat(8193), false], ['é'.repeat(4097), false], ['line\nbreak-here', true], ['carriage\rreturn', true], ['tab\tseparated', true], ['nul\u0000byte-here', true],
    ['next\u0085line-here', true], ['line separator', true], ['paragraph separator', true], ['lone\ud83dsurrogate', true], [12345678, true], [null, false]]) assert.equal(executionValueBody(value, secret), false, String(value).slice(0, 20));
});

test('availability follows the existing test profile and the dedicated key', () => {
  const key = binding(1), actions = { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/check.yml' };
  assert.deepEqual(executionValueState({ ...actions, EXECUTION_VALUE_KEY: key }), { ready: true, reason: '' });
  assert.equal(executionValueState(actions).reason, 'Configure a dedicated Secrets Store encryption key for repository values.');
  assert.equal(executionValueState({ ...actions, EXECUTION_VALUE_KEY: 'text-is-not-a-secrets-store-binding' }).ready, false);
  const module = 'Repository values need an operator-approved Actions workflow profile; this installation runs an approved Python test module.';
  assert.deepEqual(executionValueState({ TEST_MODULE: 'test_calc', EXECUTION_VALUE_KEY: key }), { ready: false, reason: module });
  assert.equal(executionValueState({ TEST_MODULE: 'test_calc' }).reason, module);
  assert.equal(executionValueState({ EXECUTION_VALUE_KEY: key }).reason, 'Repository values need an operator-approved Actions workflow profile; this installation has no container test allocation.');
  assert.equal(executionValueState({ TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.gitlab-ci.yml', EXECUTION_VALUE_KEY: key }).ready, false);
  for (const format of ['gitlab', 'actions-act']) assert.equal(executionValueState({ ...actions, TEST_WORKFLOW_FORMAT: format, EXECUTION_VALUE_KEY: key }).ready, false);
});

test('setup accepts only a dedicated Secrets Store reference for the value key', () => {
  const key = { store: 'a'.repeat(32), name: 'golf-execution-values' };
  assert.deepEqual(executionValueBindings({}), {});
  assert.deepEqual(executionValueBindings({ execution_values: { key } }), { EXECUTION_VALUE_KEY: { type: 'secrets-store-secret', storeId: key.store, secretName: key.name } });
  for (const value of [{}, { key: null }, { key: { ...key, store: 'short' } }, { key: { ...key, name: '../other' } }, { key: { ...key, value: 'never-a-secret-value' } }, { key, value: 'never-a-secret-value' }, { key: { store: key.store } }])
    assert.throws(() => executionValueBindings({ execution_values: value }), /their own Secrets Store/);
  for (const other of [{ webhooks: { key } }, { apps: { provisioner: key } }, { apps: { policy: { secret: key } } }, { registry: { apiToken: key } }, { operations: { analytics_secret: key } }])
    assert.throws(() => executionValueBindings({ execution_values: { key }, ...other }), /their own Secrets Store/);
  assert.equal(executionValueBindings({ execution_values: { key }, webhooks: { key: { ...key, name: 'golf-webhook' } } }).EXECUTION_VALUE_KEY.secretName, key.name);
});

test('exact secret text is masked across chunk boundaries, overlaps and multi-byte characters', async () => {
  const { maskExecutionOutput, maskExecutionResult } = await import('./src/execution-values.mjs');
  const secret = 'fixture-secret-value', bytes = value => new TextEncoder().encode(value).length;
  assert.deepEqual(maskExecutionOutput(['before ' + secret + ' after'], [secret]), ['before ' + '*'.repeat(20) + ' after']);
  // Split at every possible position between two chunks, and over three chunks.
  for (let cut = 1; cut < secret.length; cut++) assert.deepEqual(maskExecutionOutput(['a' + secret.slice(0, cut), secret.slice(cut) + 'z'], [secret]), ['a' + '*'.repeat(cut), '*'.repeat(secret.length - cut) + 'z']);
  assert.deepEqual(maskExecutionOutput([secret.slice(0, 3), secret.slice(3, 17), secret.slice(17)], [secret]), ['***', '*'.repeat(14), '***']);
  assert.deepEqual(maskExecutionOutput(['', secret, ''], [secret]), ['', '*'.repeat(20), '']);
  // Overlapping occurrences and one secret inside or across another leave no unmasked remainder.
  assert.deepEqual(maskExecutionOutput(['x' + 'a'.repeat(11) + 'x'], ['a'.repeat(8)]), ['x' + '*'.repeat(11) + 'x']);
  assert.deepEqual(maskExecutionOutput(['abcabcabcab-'], ['abcabcab']), ['***********-']);
  assert.deepEqual(maskExecutionOutput(['12345678ABCDEFGH!'], ['12345678ABCD', '5678ABCDEFGH', '12345678ABCD']), ['****************!']);
  const wide = 'pässwörd-✓-😀';
  assert.deepEqual(maskExecutionOutput(['é' + wide.slice(0, 4), wide.slice(4) + 'é'], [wide]), ['é' + '*'.repeat(bytes(wide.slice(0, 4))), '*'.repeat(bytes(wide.slice(4))) + 'é']);
  const untouched = ['nothing here', secret.slice(1), secret.slice(0, -1).toUpperCase(), '\u0000 nul and   separators'];
  assert.deepEqual(maskExecutionOutput(untouched, [secret]), untouched);
  assert.deepEqual(maskExecutionOutput(['kept'], []), ['kept']);
  for (const invalid of ['short77', '', 'two\nlines-of-text', null]) assert.throws(() => maskExecutionOutput(['text'], [invalid]), /Invalid masking secret/);
  // A result keeps its shape; the stdout-to-stderr junction counts as one transcript, and an unmaskable result is withheld.
  const result = { state: 'FAILED', exitCode: 1, stdout: 'out ' + secret.slice(0, 9), stderr: secret.slice(9) + ' err ' + secret, diagnostic: 'said ' + secret, image: { tag: 'ci' } };
  assert.deepEqual(maskExecutionResult(result, [secret]), { ...result, stdout: 'out ' + '*'.repeat(9), stderr: '*'.repeat(11) + ' err ' + '*'.repeat(20), diagnostic: 'said ' + '*'.repeat(20) });
  assert.equal(maskExecutionResult(result, []), result); assert.equal(maskExecutionResult(result, undefined), result);
  assert.deepEqual(maskExecutionResult({ state: 'CANCELLED' }, [secret]), { state: 'CANCELLED' });
  const withheld = maskExecutionResult(result, ['short77']);
  assert.deepEqual([withheld.stdout, withheld.stderr, withheld.diagnostic, withheld.exitCode], ['', 'Output withheld: it could not be checked for repository secrets.\n', '', 1]);
});

test('the capability opens only with the key and the hosted Actions profile, in the agreed words', async () => {
  const { executionValueCapability } = await import('./src/execution-values.mjs');
  const actions = { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/check.yml' };
  assert.deepEqual(executionValueCapability({ ...actions, EXECUTION_VALUE_KEY: binding(1) }), { id: 'settings.repository-secrets', label: 'Secrets and variables', state: 'CAPABILITY_STATE_READY',
    reason: 'Encrypted repository secrets and plain variables, released as environment variables only to an administrator-approved exact commit of the approved workflow on Cloudflare-hosted pull-request jobs. Exact secret text is masked in stored output; transformed values are not detected. Jobs have no Internet access. Customer runners, agent jobs, environment scopes and secrets expressions do not receive values.' });
  assert.deepEqual(executionValueCapability(actions), { id: 'settings.repository-secrets', label: 'Secrets and variables', state: 'CAPABILITY_STATE_DISABLED', reason: 'Configure a dedicated Secrets Store encryption key for repository values.' });
  // The hosted installation today: a module profile, with or without the key.
  for (const env of [{ TEST_MODULE: 'test_calc' }, { TEST_MODULE: 'test_calc', EXECUTION_VALUE_KEY: binding(1) }]) assert.deepEqual(executionValueCapability(env), { id: 'settings.repository-secrets', label: 'Secrets and variables', state: 'CAPABILITY_STATE_DISABLED',
    reason: 'Repository values need an operator-approved Actions workflow profile; this installation runs an approved Python test module.' });
});
