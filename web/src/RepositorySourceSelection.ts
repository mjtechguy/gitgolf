import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { isCommitID, type RepositoryLocation } from './navigation';
import { sourcePath, sourceRef, sourceRepositoryID } from './sourceReads';
import { privateQuery } from './RepositoryUI';
import { RepositorySourceRefKind as Kind, RepositorySourceResolution as Resolution } from './gen/golf/v1/golf_pb';
import type { RepositorySourceSelection, RepositorySourceSelector, ResolveRepositorySourceResponse } from './gen/golf/v1/golf_pb';

type Selection = Pick<RepositorySourceSelection, 'kind' | 'name' | 'commitId' | 'tagObjectId'>;
type Address = { selector?: Pick<RepositorySourceSelector, 'kind' | 'name'>; suffix?: string; path: string };
type Accepted = { generation:number; identity: string; addressKey: string; selection: Selection; path: string };
const denied = (): never => { throw new ConnectError('The resolved source selection does not match the requested repository, namespace and literal path.', Code.FailedPrecondition); };
const same = (a: Selection, b: Selection) => a.kind === b.kind && a.name === b.name && a.commitId === b.commitId && a.tagObjectId === b.tagObjectId;
function valid(selection: Selection | undefined) {
  return Boolean(selection && [Kind.DEFAULT_BRANCH, Kind.BRANCH, Kind.TAG, Kind.COMMIT].includes(selection.kind) && isCommitID(selection.commitId) &&
    (selection.kind === Kind.COMMIT ? selection.name === selection.commitId : sourceRef(selection.name)) &&
    (selection.kind === Kind.TAG ? Boolean(selection.tagObjectId && isCommitID(selection.tagObjectId) && selection.tagObjectId.length === selection.commitId.length) : selection.tagObjectId === undefined));
}
function address(location: RepositoryLocation): Address {
  if (!sourcePath(location.path)) denied();
  if (location.ref && location.branch === location.ref && location.tag === location.ref) throw new ConnectError('This source selection names both branch and tag namespaces. Choose one explicit ref type.', Code.FailedPrecondition);
  if (location.sourceSuffix) { if (!sourcePath(location.sourceSuffix)) denied(); return { suffix: location.sourceSuffix, path: '' }; }
  if (location.refKind) {
    if (!sourceRef(location.refName || '') || location.ref !== location.refName) denied();
    return { selector: { kind: location.refKind === 'branch' ? Kind.BRANCH : Kind.TAG, name: location.refName! }, path: location.path };
  }
  if (location.sourceRoute && isCommitID(location.ref)) return { selector: { kind: Kind.COMMIT, name: location.ref }, path: location.path };
  if (!location.ref) return { selector: { kind: Kind.DEFAULT_BRANCH, name: '' }, path: location.path };
  if (location.tag === location.ref || location.branch === location.ref) return { selector: { kind: location.tag === location.ref ? Kind.TAG : Kind.BRANCH, name: location.ref }, path: location.path };
  if (isCommitID(location.ref)) return { selector: { kind: Kind.COMMIT, name: location.ref }, path: location.path };
  if (!sourceRef(location.ref)) denied();
  return { suffix: `${location.ref}${location.path ? `/${location.path}` : ''}`, path: '' };
}
export function validateResolvedAddress(response: ResolveRepositorySourceResponse, location: RepositoryLocation, repositoryId: string, requested: Address) {
  if (response.repositoryId !== repositoryId || response.repository?.owner.toLowerCase() !== location.owner.toLowerCase() || response.repository.name.toLowerCase() !== location.name.toLowerCase()) denied();
  if (requested.suffix) {
    if (response.suffix !== requested.suffix || response.candidates.length === 0 || response.candidates.length > 64) denied();
    const seen = new Set<string>();
    for (const candidate of response.candidates) {
      const selection = candidate.selection;
      if (!valid(selection) || ![Kind.BRANCH, Kind.TAG].includes(selection!.kind) || !sourcePath(candidate.path) || `${selection!.name}${candidate.path ? `/${candidate.path}` : ''}` !== requested.suffix) denied();
      const key = `${selection!.kind}:${selection!.name}:${candidate.path}`; if (seen.has(key)) denied(); seen.add(key);
    }
    if (response.resolution === Resolution.AMBIGUOUS) {
      if (response.selection || response.path !== '' || response.candidates.length < 2) denied();
    } else if (response.resolution === Resolution.RESOLVED) {
      if (response.candidates.length !== 1 || !response.selection || !same(response.selection, response.candidates[0]!.selection!) || response.path !== response.candidates[0]!.path) denied();
    } else denied();
  } else {
    const selected = response.selection, selector = requested.selector!;
    if (response.resolution !== Resolution.RESOLVED || response.suffix || response.candidates.length || response.path !== requested.path || !valid(selected) || selected!.kind !== selector.kind || (selector.kind !== Kind.DEFAULT_BRANCH && selected!.name !== selector.name)) denied();
  }
  return response;
}

// Only accepted immutable identities live here. No bodies, paths or refs enter browser storage.
// Named refs are resolved on entry/explicit Latest, never on focus, SSE or reconnect.
export function useRepositorySourceSelection(location: RepositoryLocation, repositoryId: string, userId: string, enabled: boolean, initial?: Selection) {
  const identity = JSON.stringify([userId, location.owner, location.name, repositoryId]);
  const [accepted, setAccepted] = useState<Accepted>();
  const [generation, setGeneration] = useState(0);
  const [refreshAddress, setRefreshAddress] = useState<{identity:string;routeKey:string;selector:Pick<RepositorySourceSelector,'kind'|'name'>;path:string}>();
  let requested: Address | undefined, invalid: unknown;
  try { requested = address(location); if (!sourceRepositoryID(repositoryId)) denied(); } catch (error) { invalid = error; }
  const routeKey = JSON.stringify(requested?.suffix || requested?.selector);
  if (refreshAddress?.identity === identity && refreshAddress.routeKey === routeKey) requested = {selector:refreshAddress.selector,path:requested?.suffix?refreshAddress.path:location.path};
  const addressKey = JSON.stringify(requested?.suffix || requested?.selector);
  const direct = requested?.selector?.kind === Kind.COMMIT;
  const reusable = accepted?.identity === identity && accepted.generation === generation && (accepted.addressKey === addressKey || requested?.selector &&
    requested.selector.name === accepted.selection.name && (requested.selector.kind === accepted.selection.kind || requested.selector.kind === Kind.BRANCH && accepted.selection.kind === Kind.DEFAULT_BRANCH));
  const bootstrap = enabled && !invalid && !accepted && generation === 0 && valid(initial) && initial?.kind === Kind.DEFAULT_BRANCH &&
    requested?.selector && (requested.selector.kind === Kind.DEFAULT_BRANCH || requested.selector.kind === Kind.BRANCH && requested.selector.name === initial.name) ? initial : undefined;
  const query = useQuery({ ...privateQuery, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false, retry: false,
    queryKey: ['repository', userId, location.owner, location.name, 'source-selection', repositoryId, addressKey, generation],
    enabled: enabled && !invalid && !direct && !reusable && !bootstrap,
    queryFn: async ({ signal }) => {
      const response = await repositoryClient.resolveRepositorySource({ repository: { owner: location.owner, name: location.name }, repositoryId,
        selector: requested?.selector, path: requested?.selector ? '' : undefined, suffix: requested?.suffix }, { signal, timeoutMs: 16000 });
      signal.throwIfAborted();
      // Typed resolution is path-independent; content is separately authorized at its literal path.
      return validateResolvedAddress(response, location, repositoryId, requested?.selector ? { ...requested, path: '' } : requested!);
    } });
  const response = enabled && !invalid && !reusable && query.isSuccess && !query.isFetching ? query.data : undefined;
  const resolved = bootstrap || (response?.resolution === Resolution.RESOLVED ? response.selection : undefined);
  useEffect(() => {
    if (resolved) setAccepted({ generation, identity, addressKey, selection: resolved, path: response?.path || requested?.path || '' });
  }, [resolved, response, identity, addressKey, generation]);
  const selection = enabled && !invalid ? direct ? { kind: Kind.COMMIT, name: requested!.selector!.name, commitId: requested!.selector!.name } : reusable ? accepted!.selection : resolved : undefined;
  const path = requested?.selector ? requested.path : reusable ? accepted!.path : response?.path || '';
  const effective = selection ? { ...location, sourceSuffix: undefined, ref: selection.kind === Kind.COMMIT ? selection.commitId : selection.name, path,
    refKind: selection.kind === Kind.COMMIT ? undefined : selection.kind === Kind.TAG ? 'tag' as const : 'branch' as const,
    refName: selection.kind === Kind.COMMIT ? undefined : selection.name,
    branch: selection.kind === Kind.COMMIT ? location.branch : selection.kind === Kind.TAG ? '' : selection.name,
    tag: selection.kind === Kind.COMMIT ? location.tag : selection.kind === Kind.TAG ? selection.name : undefined } : location;
  return { selection, location: effective, error: invalid || (!reusable && query.isError ? query.error : undefined),
    candidates: response?.resolution === Resolution.AMBIGUOUS ? response.candidates : [],
    pending: enabled && !selection && !invalid && !query.isError && !response,
    latest: () => { if (selection && selection.kind !== Kind.COMMIT) setRefreshAddress({identity,routeKey,selector:{kind:selection.kind===Kind.DEFAULT_BRANCH?Kind.BRANCH:selection.kind,name:selection.name},path}); setAccepted(undefined); setGeneration(value => value + 1); },
  };
}
