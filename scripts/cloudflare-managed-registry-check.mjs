// Disposable real registry/Docker proof; CLI authentication does not qualify hosted Secrets Store or native CI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedOrigin, managedJobRequest, managedRegistry } from '../cloudflare/forge/src/managed-registry.mjs';

const [profile, account] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{1,63}$/.test(profile || '') || !/^[a-f0-9]{32}$/.test(account || '')) throw Error('Use PROFILE ACCOUNT_ID');
const directory = await mkdtemp(join(tmpdir(), 'golf-managed-registry-'));
const jobId = crypto.randomUUID(), local = 'golf-managed-proof-' + jobId, repository = local + '-r1', name = account + '/' + repository, tag = 'ci-' + jobId;
const entries = new Map(); let manifestPublished = false, publishedDigest;
const command = (executable, args, options = {}) => execFileSync(executable, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
const dockerEndpoint = process.env.DOCKER_HOST || command('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
if (!dockerEndpoint.startsWith('unix://')) throw Error('This disposable check requires the selected local Docker daemon.');
const sha = async bytes => 'sha256:' + Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
try {
  const mint = command('cf', ['--profile', profile, 'containers', 'registries', 'credentials', 'generate', 'registry.cloudflare.com', '--expiration-minutes', '10', '--permissions', 'pull', 'push']);
  let credential = JSON.parse(mint); credential = credential.result || credential;
  assert.equal(credential.account_id, account); assert.equal(credential.registry_host, 'registry.cloudflare.com');
  const provider = async (url, options) => {
    if (url.startsWith('https://api.cloudflare.com/')) return Response.json({ success: true, result: credential });
    const response = await fetch(url, options);
    console.error(JSON.stringify({ operation: options.method || 'GET', path: new URL(url).pathname, status: response.status }));
    if (new URL(url).pathname.endsWith('/tags/list') && response.ok) { const data = await response.clone().json(); console.error(JSON.stringify({ inventoryName: data.name, tags: data.tags })); }
    return response;
  };
  const env = { REGISTRY_PROVIDER: 'cloudflare', REGISTRY_ACCOUNT: account, REGISTRY_ORIGIN: managedOrigin, REGISTRY_REPOSITORY_PREFIX: account + '/' + local + '-r',
    REGISTRY_API_TOKEN: { get: async () => 'cli-credential-proof' }, registryUploadStore: { get: async k => entries.get(k), put: async (k,v) => entries.set(k,v), delete: async k => entries.delete(k), list: async () => new Map(entries) } };
  await writeFile(join(directory, 'Dockerfile'), 'FROM scratch\nCOPY demo.txt /demo.txt\n');
  await writeFile(join(directory, 'demo.txt'), 'Golf managed registry: real Docker build and scoped publication.\n');
  command('docker', ['build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '-t', local, directory]);
  const originalImage = JSON.parse(command('docker', ['image', 'inspect', local]))[0];
  command('docker', ['save', '-o', join(directory, 'image.tar'), local]);
  const archive = JSON.parse(command('python3', ['-c', `import tarfile,json,base64,gzip,sys
with tarfile.open(sys.argv[1]) as t:
 m=json.load(t.extractfile('manifest.json'))[0]
 config=t.extractfile(m['Config']).read()
 layers=[]
 for path in m['Layers']:
  data=t.extractfile(path).read()
  if data[:2]!=b'\\x1f\\x8b': data=gzip.compress(data,mtime=0)
  layers.append(base64.b64encode(data).decode())
 print(json.dumps({'config':base64.b64encode(config).decode(),'layers':layers}))`, join(directory, 'image.tar')]));
  const execution = { jobId, expiresAt: Date.now() + 600000 };
  const request = (path, method = 'GET', body, type = 'application/octet-stream') => managedJobRequest(env, name, execution,
    new Request(managedOrigin + path, { method, body, headers: { 'Content-Type': type, Authorization: 'Bearer untrusted-caller' } }), provider);
  const publish = async bytes => {
    const digest = await sha(bytes);
    const start = await request('/v2/' + name + '/blobs/uploads/', 'POST');
    assert.equal(start.status, 202, await start.clone().text());
    const location = new URL(start.headers.get('Location'));
    const finish = await request(location.pathname + '?digest=' + digest, 'PUT', bytes);
    assert.equal(finish.status, 201, await finish.clone().text()); assert.equal(finish.headers.get('Docker-Content-Digest'), digest);
    const downloaded = await request('/v2/' + name + '/blobs/' + digest);
    assert.equal(downloaded.status, 200); assert.equal(await sha(await downloaded.arrayBuffer()), digest);
    return { digest, size: bytes.length };
  };
  const config = await publish(Buffer.from(archive.config, 'base64')), layers = [];
  for (const layer of archive.layers) layers.push({ ...await publish(Buffer.from(layer, 'base64')), mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' });
  const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { ...config, mediaType: 'application/vnd.oci.image.config.v1+json' }, layers });
  const digest = await sha(new TextEncoder().encode(manifest)), published = await request('/v2/' + name + '/manifests/' + tag, 'PUT', manifest, 'application/vnd.oci.image.manifest.v1+json');
  assert.equal(published.status, 201, await published.clone().text()); assert.equal(published.headers.get('Docker-Content-Digest'), digest);
  manifestPublished = true;
  publishedDigest = digest;
  const inventory = await managedRegistry(env, async () => ({ read: true }), provider).manage({ action: 'status', binding: { repositoryId: '1', name: 'demo/proof' } });
  assert.equal(inventory.artifacts.find(a => a.tag === tag)?.digest, digest);
  await assert.rejects(request('/v2/' + name + '/manifests/latest', 'PUT', manifest));
  await assert.rejects(request('/v2/' + account + '/foreign/manifests/' + tag, 'PUT', manifest));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ auths: { 'registry.cloudflare.com': { auth: Buffer.from(credential.username + ':' + credential.password).toString('base64') } } }), { mode: 0o600 });
  command('docker', ['--host', dockerEndpoint, '--config', directory, 'pull', 'registry.cloudflare.com/' + name + '@' + digest]);
  const pulledImage = JSON.parse(command('docker', ['image', 'inspect', 'registry.cloudflare.com/' + name + '@' + digest]))[0];
  for (const key of ['Architecture', 'Os', 'RootFS', 'Config']) assert.deepEqual(pulledImage[key], originalImage[key]);
  console.log(JSON.stringify({ schema: 'golf.managed-registry.proof.v1', account, image: name + '@' + digest, dockerBuild: true, scopedPublish: true, digestReadback: true, inventory: true, dockerPull: true,
    boundary: 'Real registry and Docker; credential mint uses the operator CLI. No hosted Worker, Secrets Store or native CI qualification.' }));
} finally {
  let cleanupError;
  try {
    if (manifestPublished) command('cf', ['--profile', profile, 'containers', 'images', 'delete', repository + ':' + tag, '--force']);
  } catch (error) { cleanupError = error; }
  for (const image of [local, ...(publishedDigest ? ['registry.cloudflare.com/' + name + '@' + publishedDigest] : [])]) try { command('docker', ['image', 'rm', image]); } catch {}
  await rm(directory, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
}
