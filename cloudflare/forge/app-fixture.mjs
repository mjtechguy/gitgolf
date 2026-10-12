import assert from 'node:assert/strict';

// Controlled provider responses test lifecycle decisions, not hosted Cloudflare availability.
export function allocateApps(f) {
  const policy = { namespace: 'golf-apps', entry: 'worker.mjs', migration: 'schema.sql', ttl: 14400,
    zone: 'a'.repeat(32), gateway: 'golf-preview', outbound: 'golf-native-outbound', secret: { store: 'b'.repeat(32), name: 'demo-message' } };
  const values = new Map(), effects = [], uploads = new Map(); let lose = '', duringFetch = async () => {};
  Object.assign(f.env, { APP_POLICY: JSON.stringify(policy), APP_PROVISIONER_NAME: 'golf-management',
    APP_PROVISIONER: { async get() { return 'private_management_token_123456789'; } },
    APP_DISPATCH: { get(script, args, options) {
      assert.equal(options.limits.cpuMs, 50); assert.deepEqual(args, {});
      return { async fetch(request) {
        assert.equal(request.headers.has('Authorization'), false); assert.equal(request.headers.has('Cookie'), false);
        assert.equal(request.headers.has('Cf-Access-Jwt-Assertion'), false);
        await duringFetch(request);
        return script.endsWith('-cleanup') ? Response.json({ empty: true }) : Response.json({ commit: f.selection.headCommitId, method: request.method, query: new URL(request.url).search });
      } };
    } },
    async appProviderFetch(url, options) {
      assert.equal(options.headers.Authorization, 'Bearer private_management_token_123456789');
      assert.equal(options.redirect, 'manual');
      const path = new URL(url).pathname.split('/accounts/' + f.env.ACCOUNT_ID)[1], method = options.method;
      let result;
      if (method === 'GET') {
        if (path === '/workers/domains') result = [...values].filter(([key]) => key.startsWith('/workers/domains/')).map(([, v]) => v);
        else if (path.endsWith('/bindings')) result = uploads.get(path.slice(0, -9))?.bindings;
        else result = values.get(path);
        if (result === undefined) return /^\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/.test(path)
          ? Response.json({ success: true, result: { dispatch_namespace: policy.namespace, script: null } })
          : new Response('', { status: 404 });
      } else {
        effects.push([method, path]);
        if (method === 'DELETE') { values.delete(path); result = {}; }
        else if (path === '/d1/database') {
          result = { uuid: crypto.randomUUID(), name: JSON.parse(options.body).name };
          values.set(path + '/' + result.uuid, result);
        } else if (path.endsWith('/query')) result = [{ success: true, results: [] }];
        else if (path === '/r2/buckets') {
          result = { name: JSON.parse(options.body).name, creation_date: new Date().toISOString() }; values.set(path + '/' + result.name, result);
        } else if (path === '/workers/domains') {
          result = { ...JSON.parse(options.body), id: crypto.randomUUID().replaceAll('-', '') + 'a'.repeat(8) }; values.set(path + '/' + result.id, result);
        } else {
          assert.ok(options.body instanceof FormData);
          const metadata = JSON.parse(options.body.get('metadata')), source = await options.body.get('worker.mjs').text();
          assert.equal(JSON.stringify(metadata).includes('private_management_token'), false);
          assert.equal(metadata.bindings.some(b => b.name === 'APP_PROVISIONER'), false);
          uploads.set(path, { ...metadata, source });
          result = { id: path.split('/').at(-1), etag: crypto.randomUUID(), tags: metadata.tags };
          values.set(path, { script: result });
        }
        if (lose && path.endsWith(lose)) { lose = ''; throw Error('Lost response with private_management_token_123456789'); }
      }
      return Response.json({ success: true, result });
    },
  });
  const get = f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get = async name => {
    const repo = await get(name), tree = repo.readTree, blob = repo.readBlob;
    repo.readTree = async hash => hash === 'f'.repeat(40) ? [...await tree(hash), { name: 'worker.mjs', type: 'blob', mode: '100644', hash: '6'.repeat(40) }, { name: 'schema.sql', type: 'blob', mode: '100644', hash: '7'.repeat(40) }] : tree(hash);
    repo.readBlob = async hash => hash === '6'.repeat(40) ? new Blob(['export default {fetch(){return Response.json({ok:true})}}']) : hash === '7'.repeat(40) ? new Blob(['CREATE TABLE messages(body TEXT);']) : blob(hash);
    return repo;
  };
  return { policy, values, uploads, effects, lose: suffix => { lose = suffix; }, during: callback => { duringFetch = callback; } };
}
