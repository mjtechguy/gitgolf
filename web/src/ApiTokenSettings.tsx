import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { nativeAPI as api } from './nativeAPI';
import { CopyButton, DateLabel, Loading, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';

// API tokens (docs/AGENT_ACCESS.md): personal golf_pat_ tokens for the remote MCP endpoint, the Source API and HTTPS Git.
export type ApiToken = { id: string; label: string; permission: 'read' | 'write'; branchPattern: string; state: 'active' | 'expired' | 'revoked' | 'invalidated';
  repositories: { id: string; fullName: string }[] | null; createdAt: string; expiresAt: string; lastUsedAt: string; revokedAt: string;
  // The workspace's current one-minute window for this token (cloudflare/forge/src/agent-budgets.mjs); absent where nothing is counted.
  usage?: { requests: number; writes: number; resetsInSeconds: number } };
type Budget = { enabled: boolean; requestsPerMinute: number; writesPerMinute: number };
type Inventory = { tokens: ApiToken[]; active: number; limit: number; mcpUrl: string; origin: string; budget?: Budget | null };
type Created = { token: ApiToken; secret: string; mcpUrl: string; origin: string };
type RepositoryPage = { repositories: { id: string; fullName: string }[]; nextPage: number };

const message = (error: unknown) => error instanceof Error ? error.message : 'The API token operation could not be confirmed.';
const stateLabels: Record<ApiToken['state'], string> = { active: 'Active', expired: 'Expired', revoked: 'Revoked', invalidated: 'Ended by an account change' };
const repositoryText = (token: ApiToken) => token.repositories === null ? 'All repositories you can access' : token.repositories.map(r => r.fullName || `Repository ${r.id} (unavailable)`).join(', ');
const branchText = (token: ApiToken) => token.permission !== 'write' ? 'No writes' : token.branchPattern || 'Any branch';
const usageText = (token: ApiToken, budget?: Budget | null) => !token.usage || !budget ? 'Not counted here'
  : `${token.usage.requests} of ${budget.requestsPerMinute} requests · ${token.usage.writes} of ${budget.writesPerMinute} writes`;
const budgetText = (budget: Budget) => `Each token may make ${budget.requestsPerMinute.toLocaleString('en-US')} requests and ${budget.writesPerMinute.toLocaleString('en-US')} writes a minute` +
  (budget.enabled ? '; past that, Golf answers “retry in N s”.' : '; budgets are off on this installation, so use is counted but never refused.') +
  ' Counts are a throttle kept in memory and restart when the workspace restarts.';
export const expiryChoices = [[24, '1 day'], [168, '7 days'], [720, '30 days'], [2160, '90 days']] as const;

export function ApiTokenSettings({ userId }: { userId: string }) {
  const inventory = useQuery({ ...privateQuery, queryKey: ['native-api-tokens', userId], queryFn: ({ signal }) => api<Inventory>('/native/api-tokens', { action: 'list' }, signal) });
  const [creating, setCreating] = useState(false), [created, setCreated] = useState<Created>();
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const revoke = async (token: ApiToken) => {
    if (!window.confirm(`Revoke API token ${token.label}? Agents using it lose access at their next request.`)) return;
    setBusy(true); setError(undefined); setNotice('');
    try { await api('/native/api-tokens', { action: 'revoke', id: token.id }); setNotice(`${token.label} was revoked.`); await inventory.refetch(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const data = inventory.data;
  const columns: DataTableColumn<ApiToken>[] = [
    { accessorKey: 'label', header: 'Token', cell: ({ row: { original: t } }) => <div><strong>{t.label}</strong><small className="muted"> · created <DateLabel value={t.createdAt} /></small></div> },
    { id: 'repositories', header: 'Repositories', accessorFn: repositoryText },
    { id: 'permission', header: 'Permission', accessorFn: t => t.permission === 'write' ? 'Read and write' : 'Read' },
    { id: 'branch', header: 'Write branches', accessorFn: branchText, cell: ({ row: { original: t } }) => t.permission === 'write' && t.branchPattern ? <code>{t.branchPattern}</code> : branchText(t) },
    { id: 'expires', header: 'Expires', accessorFn: t => t.expiresAt, cell: ({ row: { original: t } }) => <DateLabel value={t.expiresAt} relative /> },
    { id: 'used', header: 'Last used', accessorFn: t => t.lastUsedAt, cell: ({ row: { original: t } }) => t.lastUsedAt ? <DateLabel value={t.lastUsedAt} relative /> : <span className="muted">Never</span> },
    { id: 'minute', header: 'This minute', accessorFn: t => t.usage?.requests ?? -1, cell: ({ row: { original: t } }) => t.state !== 'active' ? <span className="muted">—</span>
      : <div>{usageText(t, data?.budget)}{t.usage && data?.budget?.enabled && (t.usage.requests >= data.budget.requestsPerMinute || t.usage.writes >= data.budget.writesPerMinute)
        ? <> <span className="visibility refused">At budget · resets in {t.usage.resetsInSeconds} s</span></> : null}</div> },
    { id: 'state', header: 'State', accessorFn: t => stateLabels[t.state], cell: ({ row: { original: t } }) => <span className={`visibility${t.state === 'active' ? ' available' : ''}`}>{stateLabels[t.state]}</span> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: t } }) => t.state === 'active'
      ? <button className="button secondary danger-action" disabled={busy} aria-label={`Revoke ${t.label}`} onClick={() => void revoke(t)}>Revoke</button> : null },
  ];
  return <div className="page-stack">
    <section className="browser-panel" aria-labelledby="api-tokens-title"><div className="browser-panel-heading"><h2 id="api-tokens-title">Your API tokens</h2>
      <div className="row-actions"><button className="button secondary" aria-label="Refresh API tokens" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}><RefreshCw size={15} className={inventory.isFetching ? 'spin' : ''} />Refresh</button>
        <button className="button primary" onClick={() => { setCreated(undefined); setNotice(''); setCreating(!creating); }} aria-expanded={creating}><Plus size={15} />New token</button></div></div>
      <p className="field-help">Tokens let coding agents such as Claude Code, Codex and OpenCode use Golf’s MCP endpoint, the Source API and HTTPS Git as you. A token never does more than your account can do right now, and changing your account’s access ends every token.{data ? ` ${data.active} of ${data.limit} active.` : ''}</p>
      {data?.budget ? <p className="field-help">{budgetText(data.budget)}</p> : null}
      {notice ? <p className="field-help" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      {inventory.isError ? <p className="error" role="alert">{message(inventory.error)}</p> : !data ? <Loading label="Reading API tokens…" /> :
        <DataTable data={data.tokens} columns={columns} getRowId={t => t.id} label="API tokens" emptyMessage="You have no API tokens yet. Choose New token to create one." />}
    </section>
    {creating ? <NewToken close={() => setCreating(false)} done={value => { setCreated(value); setCreating(false); void inventory.refetch(); }} /> : null}
    {created ? <CreatedToken created={created} close={() => setCreated(undefined)} /> : null}
  </div>;
}

function NewToken({ close, done }: { close: () => void; done: (value: Created) => void }) {
  const [error, setError] = useState<unknown>();
  // Selectable repositories: exactly those a token can name (the ones this account holds a grant on), by owner and name, 100 a page.
  const repositories = useInfiniteQuery({ ...privateQuery, queryKey: ['api-token-repositories'], initialPageParam: 1, getNextPageParam: (last: RepositoryPage) => last.nextPage || undefined,
    queryFn: ({ signal, pageParam }) => api<RepositoryPage>('/native/api-tokens', { action: 'repositories', page: pageParam }, signal) });
  const form = useForm({ defaultValues: { label: '', scope: 'all' as 'all' | 'selected', repositories: [] as string[], permission: 'read' as 'read' | 'write', branchPattern: '', lifetimeHours: 720 as number },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        done(await api<Created>('/native/api-tokens', { action: 'create', label: value.label.trim(), repositories: value.scope === 'all' ? null : value.repositories, permission: value.permission,
          ...(value.permission === 'write' && value.branchPattern.trim() ? { branchPattern: value.branchPattern.trim() } : {}), lifetimeHours: value.lifetimeHours }));
      } catch (e) { setError(e); }
    } });
  const listed = repositories.data?.pages.flatMap(page => page.repositories) || [];
  return <form className="browser-panel credential-form-content" aria-label="New API token" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>New API token</h3>
    <form.Field name="label">{field => <label>Name<input required maxLength={64} value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="Claude Code on my laptop" autoComplete="off" /></label>}</form.Field>
    <form.Field name="scope">{field => <fieldset className="policy-choices"><legend>Repositories</legend>
      <label className="policy-choice"><input type="radio" name="api-token-scope" checked={field.state.value === 'all'} onChange={() => field.handleChange('all')} /><span><strong>All repositories I can access</strong><small>Including repositories you are given later.</small></span></label>
      <label className="policy-choice"><input type="radio" name="api-token-scope" checked={field.state.value === 'selected'} onChange={() => field.handleChange('selected')} /><span><strong>Only selected repositories</strong><small>Up to 100.</small></span></label>
    </fieldset>}</form.Field>
    <form.Subscribe selector={state => state.values.scope}>{scope => scope === 'selected' ? <form.Field name="repositories">{field => <fieldset className="policy-choices"><legend>Selected repositories</legend>
      {repositories.isError ? <p className="error" role="alert">{message(repositories.error)}</p> : !repositories.data ? <Loading label="Reading your repositories…" /> : !listed.length ? <p className="field-help">You cannot access any repository yet.</p> :
        listed.map(r => <label key={r.id} className="policy-choice"><input type="checkbox" checked={field.state.value.includes(r.id)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, r.id] : field.state.value.filter(id => id !== r.id))} /><span><strong>{r.fullName}</strong></span></label>)}
      {listed.length ? <p className="field-help">Repositories you are a member of, by owner and name. Public repositories you are not a member of cannot be selected.</p> : null}
      {repositories.hasNextPage ? <button type="button" className="text-button" disabled={repositories.isFetchingNextPage} onClick={() => void repositories.fetchNextPage()}>{repositories.isFetchingNextPage ? 'Loading…' : 'Load more repositories'}</button> : null}
    </fieldset>}</form.Field> : null}</form.Subscribe>
    <form.Field name="permission">{field => <label>Permission<select value={field.state.value} onChange={e => field.handleChange(e.target.value as 'read' | 'write')}><option value="read">Read: clone, read files, issues and pull requests</option><option value="write">Read and write: also commit, push, open pull requests and comment</option></select></label>}</form.Field>
    <form.Subscribe selector={state => state.values.permission}>{permission => permission === 'write' ? <form.Field name="branchPattern">{field => <><label>Write branches<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="agent/*" maxLength={200} autoComplete="off" /></label>
      <p className="field-help">Optional. An exact branch name, or a prefix ending in <code>*</code> such as <code>agent/*</code>, limits commits and pushes to matching branches; tags are then refused. Empty allows every branch your access and the repository’s rules allow.</p></>}</form.Field> : null}</form.Subscribe>
    <form.Field name="lifetimeHours">{field => <label>Expires after<select value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))}>{expiryChoices.map(([hours, text]) => <option key={hours} value={hours}>{text}</option>)}</select></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, state.values.scope === 'selected' && !state.values.repositories.length] as const}>{([submitting, empty]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || empty}>Create token</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function CreatedToken({ created, close }: { created: Created; close: () => void }) {
  const { secret, mcpUrl, origin, token } = created, host = origin.replace(/^https?:\/\//, '');
  const example = token.repositories?.[0]?.fullName || 'owner/name';
  const snippets: [string, string][] = [
    ['Claude Code', `claude mcp add --transport http golf ${mcpUrl} --header "Authorization: Bearer ${secret}"`],
    ['Codex (~/.codex/config.toml, with GOLF_API_TOKEN set to the token)', `[mcp_servers.golf]\nurl = "${mcpUrl}"\nbearer_token_env_var = "GOLF_API_TOKEN"`],
    ['OpenCode (opencode.json)', JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { golf: { type: 'remote', url: mcpUrl, enabled: true, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2)],
    ['Git over HTTPS', `git clone https://x:${secret}@${host}/git/${example}.git`],
  ];
  return <section className="browser-panel credential-form-content pipeline-runner-command" aria-label="Your new API token"><h3>Copy your new token now</h3>
    <p className="field-help">This is the only time Golf shows <strong>{token.label}</strong>. Golf keeps only a hash of it; if you lose it, revoke it and create another.</p>
    <pre>{secret}</pre>
    <div className="credential-actions"><CopyButton text={secret} label="Copy token" /></div>
    {snippets.map(([title, text]) => <div key={title} className="pipeline-runner-command"><strong>{title}</strong><pre>{text}</pre><div className="credential-actions"><CopyButton text={text} label={`Copy ${title.split(' (')[0]} setup`} /></div></div>)}
    <p className="field-help">A token in a clone URL is saved in that repository’s <code>.git/config</code>; prefer a Git credential helper on shared machines. Git accepts any user name with the token as the password.</p>
    <div className="credential-actions"><button className="button secondary" onClick={close}>Done</button></div>
  </section>;
}
