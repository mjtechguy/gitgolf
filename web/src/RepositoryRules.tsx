import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { toJson } from '@bufbuild/protobuf';
import { Info, RefreshCw, Shield, X } from 'lucide-react';
import { RepositoryRulesService, GetRepositoryRulesResponseSchema, type GetRepositoryRulesResponse, type RepositoryAccess, type RepositoryBranchProtection, type RepositoryTagProtection, type RepositoryMergeConfiguration } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

export type RulesClient = Client<typeof RepositoryRulesService>;
const branchFlags: [keyof RepositoryBranchProtection, string][] = [
 ['enablePush', 'Push enabled'], ['enablePushWhitelist', 'Push allowlist enabled'], ['pushWhitelistDeployKeys', 'Push allowlist includes deploy keys'],
 ['enableForcePush', 'Force push enabled'], ['enableForcePushAllowlist', 'Force push allowlist enabled'], ['forcePushAllowlistDeployKeys', 'Force push allowlist includes deploy keys'],
 ['enableMergeWhitelist', 'Merge allowlist enabled'], ['enableBypassAllowlist', 'Bypass allowlist enabled'], ['enableStatusCheck', 'Status checks enabled'], ['enableApprovalsWhitelist', 'Approval allowlist enabled'],
 ['blockOnRejectedReviews', 'Block rejected reviews'], ['blockOnOfficialReviewRequests', 'Block outstanding official reviews'], ['blockOnOutdatedBranch', 'Block outdated branch'],
 ['dismissStaleApprovals', 'Dismiss stale approvals'], ['ignoreStaleApprovals', 'Ignore stale approvals'], ['requireSignedCommits', 'Require signed commits'], ['blockAdminMergeOverride', 'Block admin merge override'],
];
const branchLists: [keyof RepositoryBranchProtection, string][] = [
 ['statusCheckContexts', 'Required check contexts'], ['pushUsernames', 'Push accounts'], ['pushTeams', 'Push teams'], ['forcePushUsernames', 'Force push accounts'], ['forcePushTeams', 'Force push teams'],
 ['mergeUsernames', 'Merge accounts'], ['mergeTeams', 'Merge teams'], ['bypassUsernames', 'Bypass accounts'], ['bypassTeams', 'Bypass teams'], ['approvalsUsernames', 'Approval accounts'], ['approvalsTeams', 'Approval teams'],
];
const mergeFlags: [keyof RepositoryMergeConfiguration, string][] = [
 ['allowMergeCommits', 'Merge commit'], ['allowRebase', 'Rebase'], ['allowRebaseExplicit', 'Rebase with merge commit'], ['allowSquashMerge', 'Squash'], ['allowFastForwardOnlyMerge', 'Fast-forward only'],
 ['allowManualMerge', 'Mark manually merged'], ['autodetectManualMerge', 'Detect manual merges'], ['allowMergeUpdate', 'Update by merge'], ['allowRebaseUpdate', 'Update by rebase'], ['defaultDeleteBranchAfterMerge', 'Delete source branch by default'], ['defaultAllowMaintainerEdit', 'Maintainer edits by default'],
];
const signed = (s: string, positive = false) => s.length <= 20 && /^-?(?:0|[1-9][0-9]*)$/.test(s) && s !== '-0' && BigInt(s) >= (positive ? 1n : -9223372036854775808n) && BigInt(s) <= 9223372036854775807n;
const text = (s: string, limit: number, empty = false) => (empty || s.length > 0) && new TextEncoder().encode(s).length <= limit && !/[\p{Cc}]/u.test(s);
const list = (values: string[]) => values.length <= 100 && values.every(v => text(v, 512));
const time = (value: string) => value.length <= 64 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
function verified(r: GetRepositoryRulesResponse, a: RepositoryAccess): GetRepositoryRulesResponse {
 const bad = () => new ConnectError('Repository rules could not be verified. Refresh the current target.', Code.Internal);
 if (r.repositoryId !== a.repositoryId || r.ownerId !== a.ownerId || r.accessRevision !== a.revision || !/^[a-f0-9]{64}$/.test(r.rulesRevision) || !r.mergeConfiguration || r.branchProtections.length > 100 || r.tagProtections.length > 100 || new TextEncoder().encode(JSON.stringify(toJson(GetRepositoryRulesResponseSchema, r))).length > 1 << 20) throw bad();
 if (new Set(r.branchProtections.map(v => v.ruleName)).size !== r.branchProtections.length || new Set(r.tagProtections.map(v => v.id)).size !== r.tagProtections.length || new Set(r.tagProtections.map(v => v.namePattern)).size !== r.tagProtections.length) throw bad();
 for (const v of r.branchProtections) if (!text(v.ruleName, 512) || !signed(v.priority) || !signed(v.requiredApprovals) || BigInt(v.requiredApprovals) < 0n || !time(v.createdAt) || !time(v.updatedAt) || !text(v.protectedFilePatterns, 4096, true) || !text(v.unprotectedFilePatterns, 4096, true) || branchFlags.some(([k]) => typeof v[k] !== 'boolean') || branchLists.some(([k]) => !Array.isArray(v[k]) || !list(v[k] as string[]))) throw bad();
 for (const v of r.tagProtections) if (!signed(v.id, true) || !text(v.namePattern, 512) || !list(v.allowedUsernames) || !list(v.allowedTeams) || !time(v.createdAt) || !time(v.updatedAt)) throw bad();
 const m = r.mergeConfiguration;
 if (!['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'].includes(m.defaultMergeStyle) || !['merge', 'rebase'].includes(m.defaultUpdateStyle) || mergeFlags.some(([k]) => typeof m[k] !== 'boolean')) throw bad();
 return r;
}
function RuleDetails({ item, close }: { item: RepositoryBranchProtection | RepositoryTagProtection; close: () => void }) {
 const dialog = useRef<HTMLDialogElement>(null); const button = useRef<HTMLButtonElement>(null);
 const branch = 'ruleName' in item;
 useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); button.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
 const lists = branch ? branchLists.map(([key, label]) => [label, (item[key] as string[]).join(', ') || 'None reported'] as const) : [['Allowed accounts', item.allowedUsernames.join(', ') || 'None reported'], ['Allowed teams', item.allowedTeams.join(', ') || 'None reported']] as const;
 return <dialog ref={dialog} className="create-dialog details-dialog" aria-label={branch ? `Branch rule ${item.ruleName}` : `Tag rule ${item.namePattern}`} onClose={close}>
  <div className="browser-panel-heading"><h2>{branch ? item.ruleName : item.namePattern}</h2><button ref={button} type="button" className="icon-button" aria-label="Close rule details" onClick={close}><X size={16} /></button></div>
  <dl className="detail-grid">{branch ? <><div><dt>Priority</dt><dd>{item.priority}</dd></div><div><dt>Required approvals</dt><dd>{item.requiredApprovals}</dd></div>{branchFlags.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{item[key] ? 'Yes' : 'No'}</dd></div>)}<div><dt>Protected file patterns</dt><dd>{item.protectedFilePatterns || 'None reported'}</dd></div><div><dt>Unprotected file patterns</dt><dd>{item.unprotectedFilePatterns || 'None reported'}</dd></div></> : <div><dt>Rule ID</dt><dd>{item.id}</dd></div>}
   {lists.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}<div><dt>Created</dt><dd><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></dd></div><div><dt>Updated</dt><dd><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString()}</time></dd></div>
  </dl><p className="field-help">Current native configuration only. Matching, precedence, trusted checks and protected publication are not established by this inventory.</p>
 </dialog>;
}
export function RepositoryRules({ client: rules, userId, owner, name, access, signingOut, revalidating = false }: { client: RulesClient; userId: string; owner: string; name: string; access: RepositoryAccess; signingOut: boolean; revalidating?: boolean }) {
 const cache = useQueryClient(); const [selected, select] = useState<RepositoryBranchProtection | RepositoryTagProtection | null>(null);
 const queryKey = ['repository-rules', userId, owner, name, access.repositoryId, access.ownerId, access.revision];
 const enabled = !signingOut && !revalidating && signed(userId, true) && signed(access.repositoryId, true) && signed(access.ownerId, true) && /^[a-f0-9]{64}$/.test(access.revision);
 const query = useQuery({ ...privateQuery, queryKey, enabled, queryFn: async ({ signal }) => { const response = await rules.getRepositoryRules({ repository: { owner, name }, repositoryId: access.repositoryId, ownerId: access.ownerId, expectedRevision: access.revision }, { signal, timeoutMs: 15000 }); signal.throwIfAborted(); return verified(response, access); } });
 useEffect(() => { select(null); return () => { void cache.cancelQueries({ queryKey }); cache.removeQueries({ queryKey }); }; }, [cache, userId, owner, name, access.repositoryId, access.ownerId, access.revision]);
 useEffect(() => { if (!enabled || query.isFetching || query.error) { select(null); if (!enabled) { void cache.cancelQueries({ queryKey }); cache.removeQueries({ queryKey }); } } }, [enabled, query.isFetching, query.error]);
 const result = enabled && query.isSuccess && !query.isFetching && !query.error ? query.data : undefined;
 const branchColumns = useMemo<DataTableColumn<RepositoryBranchProtection>[]>(() => [
  { accessorKey: 'ruleName', header: 'Rule pattern', cell: ({ row }) => <strong>{row.original.ruleName}</strong> },
  { accessorKey: 'priority', header: 'Priority', accessorFn: v => BigInt(v.priority), sortFn: 'basic' },
  { accessorKey: 'requiredApprovals', header: 'Approvals', accessorFn: v => BigInt(v.requiredApprovals), sortFn: 'basic' },
  { id: 'checks', header: 'Checks', accessorFn: v => v.enableStatusCheck ? v.statusCheckContexts.join(', ') || 'Enabled, no contexts' : 'Disabled' },
  { id: 'push', header: 'Push configuration', accessorFn: v => !v.enablePush ? 'Disabled' : v.enablePushWhitelist ? 'Allowlist enabled' : 'Enabled' },
  { id: 'details', header: 'Details', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <button className="icon-button" aria-label={`Inspect branch rule ${row.original.ruleName}`} onClick={() => select(row.original)}><Info size={16} /></button> },
 ], []);
 const tagColumns = useMemo<DataTableColumn<RepositoryTagProtection>[]>(() => [
  { accessorKey: 'namePattern', header: 'Rule pattern', cell: ({ row }) => <strong>{row.original.namePattern}</strong> },
  { id: 'accounts', header: 'Allowed accounts', accessorFn: v => v.allowedUsernames.join(', ') || 'None reported' }, { id: 'teams', header: 'Allowed teams', accessorFn: v => v.allowedTeams.join(', ') || 'None reported' },
  { id: 'details', header: 'Details', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <button className="icon-button" aria-label={`Inspect tag rule ${row.original.namePattern}`} onClick={() => select(row.original)}><Info size={16} /></button> },
 ], []);
 return <div className="page-stack"><section className="browser-panel"><div className="browser-panel-heading"><h2><Shield size={17} />Repository rules</h2><button className="icon-button" aria-label="Refresh repository rules" disabled={!enabled || query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>
  <p className="panel-footnote">Read-only native configuration. Golf rule editing and protected merge enforcement remain unavailable; current settings do not establish trusted approval/check freshness or effective write fencing.</p>
  {query.error && enabled ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !result ? <Loading label="Loading current repository rules…" /> : null}
 </section>{result ? <><section className="browser-panel credential-list-panel"><div className="browser-panel-heading"><h2>Branch protection</h2><span className="muted">{result.branchProtections.length} reported rules</span></div><DataTable label="Branch protection rules" data={result.branchProtections} columns={branchColumns} getRowId={v => v.ruleName} emptyMessage="No branch protection rules were reported." /></section>
 <section className="browser-panel credential-list-panel"><div className="browser-panel-heading"><h2>Tag protection</h2><span className="muted">{result.tagProtections.length} reported rules</span></div><DataTable label="Tag protection rules" data={result.tagProtections} columns={tagColumns} getRowId={v => v.id} emptyMessage="No tag protection rules were reported." /></section>
 <section className="browser-panel credential-list-panel"><div className="browser-panel-heading"><h2>Merge configuration</h2></div><DataTable label="Native merge configuration" pagination={false} data={mergeFlags.map(([key, label]) => ({ key, label, enabled: Boolean(result.mergeConfiguration![key]) }))} getRowId={v => v.key} columns={[{ accessorKey: 'label', header: 'Configuration' }, { id: 'enabled', header: 'Observed value', accessorFn: v => v.enabled ? 'Enabled' : 'Disabled' }]} /><p className="panel-footnote">Default merge style: {result.mergeConfiguration!.defaultMergeStyle}. Default update style: {result.mergeConfiguration!.defaultUpdateStyle}. These observations do not authorize a merge.</p></section>{selected ? <RuleDetails item={selected} close={() => select(null)} /> : null}</> : null}</div>;
}
