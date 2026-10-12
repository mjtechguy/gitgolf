import { QueryObserver } from '../node_modules/@tanstack/react-query/build/modern/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Code, ConnectError } from '@connectrpc/connect';
import { createQueryClient, forgetPrivateQueries } from '../src/queryClient.ts';

test('private navigation has bounded retention and logout removes late work', async () => {
  const client = createQueryClient();
  try {
    for (let i = 0; i < 80; i++) await client.fetchQuery({ queryKey: ['repository', '1', 'alice', 'repo', 'source', i], meta: { privateNavigation: true }, staleTime: Infinity, queryFn: () => ({ content: 'x'.repeat(150_000), size: 12n }) });
    const retained = client.getQueryCache().getAll();
    assert.ok(retained.length <= 64);
    assert.ok(retained.length * 150_000 <= 8 * 1024 * 1024);
    let release!: (value: string) => void;
    const pending = client.fetchQuery({ queryKey: ['repository', '1', 'alice', 'repo', 'source', 'late'], queryFn: () => new Promise<string>(resolve => { release = resolve; }) }).catch(() => null);
    forgetPrivateQueries(client); release('private source'); await pending;
    assert.equal(client.getQueryCache().getAll().length, 0);
  } finally { client.clear(); }
});

test('denial purges only the affected repository; unauthentication purges every account', async () => {
  const client = createQueryClient();
  const put = (user: string, repo: string) => client.fetchQuery({ queryKey: ['repository', user, 'alice', repo, 'source'], meta: { privateNavigation: true }, queryFn: () => 'private' });
  try {
    await put('1', 'one'); await put('1', 'two'); await put('2', 'one');
    await assert.rejects(client.fetchQuery({ queryKey: ['repository', '1', 'alice', 'one', 'access'], queryFn: () => { throw new ConnectError('revoked', Code.NotFound); } }));
    assert.equal(client.getQueryData(['repository', '1', 'alice', 'one', 'source']), undefined);
    assert.equal(client.getQueryData(['repository', '1', 'alice', 'two', 'source']), 'private');
    assert.equal(client.getQueryData(['repository', '2', 'alice', 'one', 'source']), 'private');
    await assert.rejects(client.fetchQuery({ queryKey: ['session'], queryFn: () => { throw new ConnectError('signed out', Code.Unauthenticated); } }));
    assert.equal(client.getQueryCache().findAll({ queryKey: ['repository'] }).length, 0);
  } finally { client.clear(); }
});

test('a missing image does not evict authorized source navigation', async () => {
  const client = createQueryClient();
  try {
    await client.fetchQuery({ queryKey: ['repository', '1', 'alice', 'one', 'source'], meta: { privateNavigation: true }, queryFn: () => 'authorized source' });
    await assert.rejects(client.fetchQuery({ queryKey: ['repository', '1', 'alice', 'one', 'image', 'missing'], queryFn: () => { throw new ConnectError('Missing image', Code.NotFound); } }));
    assert.equal(client.getQueryData(['repository', '1', 'alice', 'one', 'source']), 'authorized source');
  } finally { client.clear(); }
});

test('an absent optional overview revalidates core authority without evicting immutable source', async () => {
  const client = createQueryClient(), scope = ['repository', '1', 'alice', 'one'];
  try {
    await client.fetchQuery({ queryKey: [...scope, 'source'], meta: { privateNavigation: true }, queryFn: () => 'authorized source' });
    await client.fetchQuery({ queryKey: [...scope, 'metadata'], queryFn: () => ({ id: '1' }) });
    await assert.rejects(client.fetchQuery({ queryKey: [...scope, 'metadata', 'sidebar', '1'], queryFn: () => { throw new ConnectError('Missing overview', Code.NotFound); } }));
    assert.equal(client.getQueryData([...scope, 'source']), 'authorized source');
    assert.equal(client.getQueryCache().find({ queryKey: [...scope, 'metadata'], exact: true })?.state.isInvalidated, true);
  } finally { client.clear(); }
});

test('disabled offscreen history placeholders do not evict materialized source snapshots', async () => {
  const client = createQueryClient();
  const source = ['repository', '1', 'alice', 'one', 'source'];
  try {
    await client.fetchQuery({ queryKey: source, meta: { privateNavigation: true }, queryFn: () => 'cached source' });
    const observers = Array.from({ length: 100 }, (_, index) => new QueryObserver(client, { queryKey: ['repository', '1', 'alice', 'one', 'source-entry-commit', index], meta: { privateNavigation: true }, enabled: false, queryFn: () => 'history' }));
    const stop = observers.map(observer => observer.subscribe(() => {}));
    for (const unsubscribe of stop) unsubscribe();
    assert.equal(client.getQueryData(source), 'cached source');
  } finally { client.clear(); }
});
