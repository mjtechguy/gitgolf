#!/usr/bin/env node
// Supported Golf API proof for ONE disposable native fixture supplied by the
// operator wrapper. Credentials enter on stdin and remain in RAM. This helper
// never creates/purges native users, changes policies, or logs out its operator.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

const id = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
function configuration(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Configuration object required.');
  const base = new URL(value.baseUrl);
  assert(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'Only an explicit loopback Golf origin is supported.');
  assert(value.adminCookie && /^(?:__Host-)?golf_session$/.test(value.adminCookie.name) && /^[A-Za-z0-9_-]{43}$/.test(value.adminCookie.value), 'Current operator Golf cookie required.');
  assert(typeof value.adminPassword === 'string' && [...value.adminPassword].length >= 15 && Buffer.byteLength(value.adminPassword) <= 1024, 'Operator password confirmation required.');
  let gitBase;
  if (value.gitBaseUrl !== undefined) {
    gitBase = new URL(value.gitBaseUrl);
    assert(gitBase.protocol === 'https:' && ['localhost', '127.0.0.1', '[::1]'].includes(gitBase.hostname) && !gitBase.username && !gitBase.password && !gitBase.search && !gitBase.hash && gitBase.pathname === '/', 'Git TLS origin must be explicit loopback HTTPS.');
    assert(typeof value.trustedCa === 'string' && Buffer.byteLength(value.trustedCa) <= 16384 && /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]{32,}-----END CERTIFICATE-----\r?\n?$/.test(value.trustedCa), 'One bounded public trusted CA certificate is required for Git TLS.');
  } else assert(value.trustedCa === undefined, 'Git CA requires an explicit Git TLS origin.');
  const target = value.target;
  assert(target && id(target.nativeUserId) && /^golf-access-[a-z0-9][a-z0-9._-]{0,48}$/.test(target.login), 'One immutable disposable golf-access-* fixture is required.');
  assert(typeof target.email === 'string' && /^[a-z0-9._+-]+@[a-z0-9.-]+\.invalid$/.test(target.email), 'Disposable fixture email must use .invalid.');
  assert(typeof target.token === 'string' && target.token.length >= 8 && target.token.length <= 512 && !/[\s\x00-\x1f]/.test(target.token), 'Private fixture native token required.');
  assert(typeof value.source === 'string' && /^[a-f0-9]{7,40}$/.test(value.source), 'Operator source revision required.');
  const output = resolve(value.output); const tmp = resolve('.tmp');
  assert(relative(tmp, output) && !relative(tmp, output).startsWith(`..${sep}`) && relative(tmp, output) !== '..' && !relative(tmp, output).startsWith(sep), 'Receipt must use a new directory below workspace .tmp.');
  assert(!value.forbidden || Array.isArray(value.forbidden) && value.forbidden.length <= 100 && value.forbidden.every(text => typeof text === 'string' && text.length >= 8 && text.length <= 16384), 'Invalid privacy sentinels.');
  if (value.repository) {
    const repo = value.repository;
    assert(repo.owner === target.login && /^golf-access-[a-z0-9][a-z0-9._-]{0,48}$/.test(repo.name) && id(repo.id) && repo.ownerId === target.nativeUserId, 'Managed Git repository must belong to the same disposable fixture.');
  }
  return { ...value, baseUrl: base.origin, gitBaseUrl: gitBase?.origin || base.origin, output };
}
function bindRepository(read, access, repo) {
  assert(read?.id === repo.id && read.fullName === `${repo.owner}/${repo.name}` && read.name === repo.name && read.private, 'Owned private repository binding mismatch.');
  assert(access?.repositoryId === repo.id && access.ownerId === repo.ownerId && access.owner?.id === repo.ownerId && access.owner.login === repo.owner && !access.organizationOwned && access.currentPermission === 'owner', 'Owned immutable repository access binding mismatch.');
}
function bindGitTransport(transport, repo, origin) {
  assert(transport?.repositoryId === repo.id && transport.ownerId === repo.ownerId && transport.repository?.owner === repo.owner && transport.repository.name === repo.name, 'Managed Git immutable transport target mismatch.');
  assert(transport.enabled === true && transport.readCredentialAvailable === true, 'Managed READ Git must actually be enabled and available.');
  assert(transport.cloneUrl === `${origin}/git/${repo.owner}/${repo.name}.git`, 'Managed Git advertised clone URL must match the exact configured origin and repository.');
}
function privateFree(report, forbidden) {
  const text = JSON.stringify(report, null, 2);
  assert(!forbidden.some(secret => text.includes(secret)), 'Receipt privacy validation failed.');
  return `${text}\n`;
}
if (process.argv.includes('--self-check')) {
  const good = { baseUrl: 'http://127.0.0.1:8080', adminCookie: { name: 'golf_session', value: 'A'.repeat(43) }, adminPassword: 'synthetic-password-confirmation', target: { nativeUserId: '84', login: 'golf-access-owned', email: 'owned@example.invalid', token: 'synthetic-native-token' }, source: 'a'.repeat(40), output: '.tmp/self-check-access' };
  configuration(good);
  const repo = {owner:good.target.login,name:'golf-access-project',id:'7',ownerId:'84'}; const read={id:'7',name:repo.name,fullName:`${repo.owner}/${repo.name}`,private:true}; const access={repositoryId:'7',ownerId:'84',owner:{id:'84',login:repo.owner},currentPermission:'owner'}; bindRepository(read,access,repo); assert.throws(()=>bindRepository(read,{...access,owner:{id:'42',login:repo.owner}},repo));
  const ca = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n-----END CERTIFICATE-----\n`;
  configuration({...good,gitBaseUrl:'https://127.0.0.1:8443',trustedCa:ca});
  const transport = {cloneUrl:`${good.baseUrl}/git/${repo.owner}/${repo.name}.git`,repository:{owner:repo.owner,name:repo.name},repositoryId:repo.id,ownerId:repo.ownerId,enabled:true,readCredentialAvailable:true}; bindGitTransport(transport,repo,good.baseUrl);
  for (const update of [{enabled:false},{readCredentialAvailable:false},{ownerId:'42'},{repositoryId:'8'},{cloneUrl:'https://external.invalid/git/project.git'}]) assert.throws(()=>bindGitTransport({...transport,...update},repo,good.baseUrl));
  for (const update of [{gitBaseUrl:'http://127.0.0.1:8443',trustedCa:ca},{gitBaseUrl:'https://external.invalid',trustedCa:ca},{gitBaseUrl:'https://127.0.0.1:8443/project',trustedCa:ca},{gitBaseUrl:'https://127.0.0.1:8443',trustedCa:'-----BEGIN PRIVATE KEY-----'},{trustedCa:ca},{ baseUrl: 'http://external.invalid' }, { output: '/tmp/public' }, { target: { ...good.target, login: 'admin' } }, { target: { ...good.target, nativeUserId: '084' } }, { repository: { owner: 'admin', name: 'golf-access-owned', id: '1', ownerId: '84' } }]) assert.throws(() => configuration({ ...good, ...update }));
  assert.throws(() => privateFree({ note: good.target.token }, [good.target.token]));
  assert.doesNotThrow(() => privateFree({ passed: true, ownSessionsLoggedOut: true }, [good.target.token]));
  process.stdout.write('PASS Golf access qualification configuration and privacy boundaries\n');
  process.exit(0);
}
assert.equal(process.argv.length, 2, 'Use stdin JSON or --self-check only.');
let data = ''; for await (const chunk of process.stdin) { data += chunk; assert(Buffer.byteLength(data) <= 128 * 1024, 'Configuration exceeds the input bound.'); }
let config;
try { config = configuration(JSON.parse(data)); } catch { process.stderr.write('Golf access qualification configuration was rejected.\n'); process.exit(1); }
data = '';
await mkdir(config.output, { recursive: false, mode: 0o700 });
const secrets = [config.adminCookie.value, config.adminPassword, config.target.token, ...(config.forbidden || [])];
const password = `Golf owned fixture ${randomBytes(24).toString('base64url')}!`; secrets.push(password);
const ownCookies = new Set();
const report = { passed: false, declaredSource: config.source, sourceBinding: 'Operator supplied; bind to the root deployment receipt.', nativeFixtureId: config.target.nativeUserId, checks: [], cleanup: { ownSessions: false, golfFixtureSuspended: false, nativeFixture: 'Wrapper owns native repository/token/user cleanup.' }, oauth: 'Actual provider OAuth was not exercised here; source PostgreSQL refresh qualification is separate.', nativeIngress: 'Native web/API/SSH suspension is not claimed.' };
let step = 'operator identity'; let target; let rpcFailure;
async function request(path, body, cookie, bearer) {
  const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: config.baseUrl };
  if (cookie) headers.Cookie = `${config.adminCookie.name}=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`${config.baseUrl}/rpc/golf.v1.${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const reader = response.body.getReader(); const chunks = []; let count = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.byteLength; assert(count <= 1024 * 1024, 'Response exceeds bound.'); chunks.push(chunk.value); } } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks); let payload; try { payload = JSON.parse(bytes.toString('utf8')); } catch { assert.fail('Response is not bounded JSON.'); }
  if (response.status !== 200) rpcFailure = { stage: step, status: response.status, code: ['invalid_argument','unauthenticated','permission_denied','failed_precondition','unavailable','not_found','already_exists','internal','aborted'].includes(payload?.code) ? payload.code : 'unexpected' };
  return { status: response.status, headers: response.headers, body: payload };
}
function success(result) { assert.equal(result.status, 200, `${step} did not succeed.`); return result.body; }
function checked(name) { report.checks.push(name); }
async function login(path, body) {
  const result = await request(path, body);
  const cookie = result.headers.getSetCookie().map(text => text.match(new RegExp(`^${config.adminCookie.name}=([A-Za-z0-9_-]{43});`))?.[1]).find(Boolean);
  if (cookie) { assert.notEqual(cookie, config.adminCookie.value, 'Operator session was replaced.'); ownCookies.add(cookie); secrets.push(cookie); }
  const payload = success(result); assert(cookie, 'New own fixture session missing.');
  assert.equal(payload.user?.id, config.target.nativeUserId); assert.equal(payload.user.login, config.target.login); assert(!payload.user.isInstanceAdmin, 'Fixture acquired administrator role.');
  return cookie;
}
async function inventory() {
  for (let page = 1; page <= 8; page++) {
    const result = success(await request('InstanceAdminService/ListGolfUserAccess', { page: { page, limit: 100 } }, config.adminCookie.value));
    const user = (result.users || []).find(user => user.nativeUserId === config.target.nativeUserId);
    if (user) { assert.equal(user.login, config.target.login); assert.equal(user.golfUserId, target.golfUserId); assert(!user.isInstanceAdmin); return user; }
    const next = result.page?.nextPage || 0; if (!next) break; assert.equal(next, page + 1, 'Inventory cursor is not exact.');
  }
  assert.fail('Owned fixture absent from bounded current inventory.');
}
function receipt(result, input) {
  const op = result.operation; assert(op && result.user, 'Current access and original receipt required.');
  for (const field of ['operationId', 'golfUserId', 'nativeUserId', 'suspended', 'reason']) assert.equal(op[field] ?? (field === 'suspended' ? false : ''), input[field]);
  assert.equal(op.version, (BigInt(input.expectedVersion) + 1n).toString()); assert(op.changedAt && Number.isFinite(Date.parse(op.changedAt)));
  assert.equal(result.user.golfUserId, target.golfUserId); assert.equal(result.user.nativeUserId, config.target.nativeUserId);
  return op;
}
function intent(version, suspended, reason) { return { golfUserId: target.golfUserId, nativeUserId: config.target.nativeUserId, expectedVersion: version, suspended, reason, passwordConfirmation: config.adminPassword, operationId: randomUUID() }; }
async function gitRead(secret, expected) {
  const repo = config.repository; const endpoint = `${config.gitBaseUrl}/git/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}.git/info/refs?service=git-upload-pack`;
  const authorization = `Basic ${Buffer.from(`golf:${secret}`).toString('base64')}`;
  let status, contentType, bytes = 0;
  if (endpoint.startsWith('https:')) {
    await new Promise((resolveRequest, reject) => {
      const req = httpsRequest(endpoint, { method: 'GET', ca: config.trustedCa, rejectUnauthorized: true, minVersion: 'TLSv1.2', signal: AbortSignal.timeout(15_000), headers: { Authorization: authorization } }, response => {
        status = response.statusCode; contentType = response.headers['content-type'];
        response.on('data', chunk => { bytes += chunk.byteLength; if (bytes > 16 * 1024 * 1024) response.destroy(new Error('Git response exceeds bound.')); });
        response.on('end', resolveRequest); response.on('error', reject);
      });
      req.setTimeout(15_000, () => req.destroy(new Error('Git response deadline exceeded.')));
      req.on('error', reject); req.end();
    });
  } else {
    const response = await fetch(endpoint, { headers: { Authorization: authorization }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    status = response.status; contentType = response.headers.get('content-type');
    const reader = response.body.getReader();
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; assert(bytes <= 16 * 1024 * 1024, 'Git response exceeds bound.'); } } finally { await reader.cancel().catch(() => {}); }
  }
  report.managedGit = { expectedStatus: expected, actualStatus: status, tlsWithExplicitTrustedCa: endpoint.startsWith('https:') };
  assert.equal(status, expected, `${step}: managed Git status mismatch.`);
  if (expected === 200) { assert(contentType?.startsWith('application/x-git-upload-pack-advertisement')); assert(bytes > 0); }
}

try {
  const actor = success(await request('SessionService/GetSession', {}, config.adminCookie.value)).user;
  assert(actor?.isInstanceAdmin && actor.id !== config.target.nativeUserId, 'Current separate operator required.');
  step = 'ordinary fixture enrollment';
  const enrollment = success(await request('InstanceAdminService/EnrollRegularLocalAccount', { username: config.target.login, email: config.target.email, password, forgeToken: config.target.token, expectedNativeUserId: config.target.nativeUserId, passwordConfirmation: config.adminPassword }, config.adminCookie.value));
  target = enrollment.account; assert(target && id(target.golfUserId) && target.nativeUserId === config.target.nativeUserId && target.username === config.target.login && !target.isInstanceAdmin && !target.disabled && target.credentialVersion === '1'); checked('ordinary native identity enrolled through supported Golf API');
  const local = await login('SessionService/LoginWithPassword', { username: config.target.email, password });
  const secondLocal = await login('SessionService/LoginWithPassword', { username: config.target.email, password });
  const pat = await login('SessionService/LoginWithForgeToken', { token: config.target.token }); checked('two local sessions and a native-token session resolve exact fixture identity');
  const api = success(await request('ApiCredentialService/CreateApiCredential', { label: 'owned suspension qualification', lifetimeSeconds: 3600 }, pat)).token; assert(typeof api === 'string' && api.startsWith('golf_ro_')); secrets.push(api);
  step = 'current Golf inventory'; const initial = await inventory(); assert(!initial.suspended && (initial.version || '0') === '0'); checked('current exact Golf/native mapping and initial active version');
  let git;
  if (config.repository) {
    step = 'managed Git repository read'; const repo = config.repository;
    const read = success(await request('RepositoryService/GetRepository', { repository: { owner: repo.owner, name: repo.name } }, pat)).repository;
    step = 'managed Git access read';
    const access = success(await request('RepositoryAccessService/GetRepositoryAccess', { repository: { owner: repo.owner, name: repo.name } }, pat)).access;
    step = 'managed Git repository binding';
    report.repositoryPermission = ['none','read','write','admin','owner'].includes(access?.currentPermission) ? access.currentPermission : 'unexpected';
    bindRepository(read, access, repo);
    step = 'managed Git transport configuration';
    const transport = success(await request('GitTransportService/GetGitTransport', { repository: { owner: repo.owner, name: repo.name }, repositoryId: repo.id, ownerId: repo.ownerId }, pat));
    report.managedGitConfiguration = { enabled: transport.enabled === true, readCredentialAvailable: transport.readCredentialAvailable === true, writeCredentialAvailable: transport.writeCredentialAvailable === true };
    bindGitTransport(transport, repo, config.gitBaseUrl);
    step = 'managed Git credential creation';
    git = success(await request('GitTransportService/CreateGitCredential', { repository: { owner: repo.owner, name: repo.name }, repositoryId: repo.id, ownerId: repo.ownerId, label: 'owned suspension proof', mode: 'GIT_CREDENTIAL_MODE_READ', lifetimeSeconds: 3600 }, pat)).secret;
    assert(typeof git === 'string' && git.startsWith('golf_git_')); secrets.push(git); step = 'managed Git advertisement'; await gitRead(git, 200); checked('owned private repository managed Git advertisement baseline');
  }
  step = 'proven password rejection'; const wrong = intent('0', true, 'Owned rejected access proof'); wrong.passwordConfirmation = `${password} wrong`;
  const rejected = await request('InstanceAdminService/ChangeGolfUserAccess', wrong, config.adminCookie.value); assert.equal(rejected.status, 403); assert.equal(rejected.headers.get('golf-access-outcome'), 'rejected'); assert.equal((await inventory()).version || '0', '0'); checked('wrong confirmation explicitly rejected without state change');
  step = 'fixture suspension'; const suspend = intent('0', true, 'Owned managed access suspension proof'); const suspended = success(await request('InstanceAdminService/ChangeGolfUserAccess', suspend, config.adminCookie.value)); const original = receipt(suspended, suspend); assert.equal(original.sessionsRevoked, '3');
  checked('one durable suspension revokes all three owned local/token source sessions');
  for (const cookie of [local, secondLocal, pat]) assert.equal((await request('SessionService/GetSession', {}, cookie)).status, 401);
  assert.equal((await request('RepositoryService/ListRepositories', {}, undefined, api)).status, 401);
  if (git) await gitRead(git, 401); checked('old local/token/API and requested managed Git access refused');
  for (const [path, body] of [['SessionService/LoginWithPassword', { username: config.target.email, password }], ['SessionService/LoginWithForgeToken', { token: config.target.token }]]) assert.equal((await request(path, body)).status, 401); checked('suspended local and native-token re-entry refused');
  step = 'original operation inspection'; const inspect = success(await request('InstanceAdminService/GetGolfUserAccessOperation', { golfUserId: target.golfUserId, nativeUserId: target.nativeUserId, operationId: suspend.operationId }, config.adminCookie.value)); receipt(inspect, suspend); checked('original durable operation inspected without replay');
  step = 'exact idempotency'; receipt(success(await request('InstanceAdminService/ChangeGolfUserAccess', suspend, config.adminCookie.value)), suspend); const changed = await request('InstanceAdminService/ChangeGolfUserAccess', { ...suspend, reason: 'A different owned intent' }, config.adminCookie.value); assert.equal(changed.status, 409); checked('exact original input remains idempotent and changed UUID intent refused');
  step = 'fixture restoration'; const restore = intent('1', false, 'Owned explicit restoration proof'); const restored = receipt(success(await request('InstanceAdminService/ChangeGolfUserAccess', restore, config.adminCookie.value)), restore); assert.equal(restored.sessionsRevoked || '0', '0'); assert.equal(restored.automationGrantsRevoked || '0', '0');
  for (const cookie of [local, secondLocal, pat]) assert.equal((await request('SessionService/GetSession', {}, cookie)).status, 401); assert.equal((await request('RepositoryService/ListRepositories', {}, undefined, api)).status, 401); if (git) await gitRead(git, 401);
  await login('SessionService/LoginWithPassword', { username: config.target.email, password }); await login('SessionService/LoginWithForgeToken', { token: config.target.token }); checked('explicit restore permits fresh sessions while old credentials remain revoked');
  report.passed = true;
} catch { report.failure = { stage: step, ...(rpcFailure?.stage === step ? { rpc: { status: rpcFailure.status, code: rpcFailure.code } } : {}), reason: 'A bounded supported-API assertion failed; response bodies and credentials were withheld.' }; }
finally {
  let sessionsClean = true;
  for (const cookie of ownCookies) { try { const result = await request('SessionService/Logout', {}, cookie); if (![200, 401].includes(result.status)) sessionsClean = false; } catch { sessionsClean = false; } }
  report.cleanup.ownSessions = sessionsClean;
  if (target) { try { const current = await inventory(); if (!current.suspended) { const cleanup = intent(current.version || '0', true, 'Owned qualification fixture cleanup'); receipt(success(await request('InstanceAdminService/ChangeGolfUserAccess', cleanup, config.adminCookie.value)), cleanup); } report.cleanup.golfFixtureSuspended = Boolean((await inventory()).suspended); } catch { report.cleanup.golfFixtureSuspended = false; } }
  report.passed = report.passed && report.cleanup.ownSessions && report.cleanup.golfFixtureSuspended;
  await writeFile(resolve(config.output, 'manifest.json'), privateFree(report, secrets), { mode: 0o600 });
  config.adminPassword = ''; config.target.token = ''; config.adminCookie.value = '';
}
process.stdout.write(report.passed ? 'PASS owned Golf access API qualification; wrapper still owns native cleanup\n' : 'FAIL owned Golf access qualification; inspect the sanitized manifest\n');
process.exitCode = report.passed ? 0 : 1;
