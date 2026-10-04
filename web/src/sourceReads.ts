import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { isCommitID } from './navigation';
import { RepositorySourceRefKind, SourceEntryType } from './gen/golf/v1/golf_pb';
import type { GetContentsResponse, GetRepositoryImageResponse, RepositoryKey, RepositorySourceSelector, SourceEntry } from './gen/golf/v1/golf_pb';

type Repository = Pick<RepositoryKey, 'owner' | 'name'>;
type Selector = Pick<RepositorySourceSelector, 'kind' | 'name'>;
const failure = (message: string): never => { throw new ConnectError(message, Code.FailedPrecondition); };
export const sourceRepositoryID = (id: string) => id.length <= 19 && /^[1-9][0-9]*$/.test(id) && BigInt(id) <= 9223372036854775807n;
export const sourcePath = (path: string) => new TextEncoder().encode(path).length <= 4096 && !/[\\\p{Cc}\uD800-\uDFFF]/u.test(path) && (path === '' || path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const sourceRef = (ref: string) => ref !== '' && new TextEncoder().encode(ref).length <= 1024 && ref !== '@' && !ref.startsWith('-') && !/[ ~^:?*[\\\p{Cc}\uD800-\uDFFF]/u.test(ref) && !ref.includes('..') && !ref.includes('@{') && ref.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
const kinds = [SourceEntryType.DIRECTORY, SourceEntryType.FILE, SourceEntryType.SYMLINK, SourceEntryType.SUBMODULE];
const validEntry = (entry: SourceEntry) => sourcePath(entry.path) && entry.path !== '' && entry.path.split('/').at(-1) === entry.name && isCommitID(entry.sha) && kinds.includes(entry.type) && entry.size >= 0n;

export function validateSource(response: GetContentsResponse, repositoryId: string, commitId: string, path: string) {
  if (!sourceRepositoryID(repositoryId) || !isCommitID(commitId) || !sourcePath(path) || response.repositoryId !== repositoryId || response.commitId !== commitId || response.path !== path || !kinds.includes(response.kind)) failure('The source receipt does not match this repository, path and exact snapshot.');
  if (response.kind === SourceEntryType.DIRECTORY) {
    const seen = new Set<string>();
    if (response.file || response.entries.length > 1000) failure('The folder response exceeds the supported inventory or includes conflicting file data.');
    for (const entry of response.entries) {
      if (!validEntry(entry) || entry.path !== (path ? `${path}/` : '') + entry.name || seen.has(entry.path)) failure('The folder contains invalid or duplicate direct-child metadata.');
      seen.add(entry.path);
    }
  } else if (response.entries.length || !response.file?.entry || !validEntry(response.file.entry) || response.file.entry.path !== path || response.file.entry.type !== response.kind) failure('The file metadata does not match the selected source path.');
  return response;
}

export async function readExactSource(repository: Repository, repositoryId: string, commitId: string, path: string, signal: AbortSignal) {
  if (!sourceRepositoryID(repositoryId) || !isCommitID(commitId) || !sourcePath(path)) failure('Select a valid repository identity, full commit and literal source path.');
  signal.throwIfAborted();
  const response = await repositoryClient.getContents({ repository, repositoryId, ref: commitId, path }, { signal, timeoutMs: 8000 });
  signal.throwIfAborted();
  return validateSource(response, repositoryId, commitId, path);
}

async function resolveSource(repository: Repository, repositoryId: string, selector: Selector, path: string, signal: AbortSignal) {
  const response = await repositoryClient.resolveRepositorySource({ repository, repositoryId, selector, path }, { signal, timeoutMs: 8000 });
  signal.throwIfAborted();
  const selected = response.selection;
  if (response.repositoryId !== repositoryId || response.path !== path || response.repository?.owner.toLowerCase() !== repository.owner.toLowerCase() || response.repository.name.toLowerCase() !== repository.name.toLowerCase() || !selected || selected.kind !== selector.kind || !isCommitID(selected.commitId) || (selector.kind === RepositorySourceRefKind.DEFAULT_BRANCH ? !sourceRef(selected.name) : selected.name !== selector.name) || selector.kind === RepositorySourceRefKind.COMMIT && selected.commitId !== selector.name || selected.tagObjectId !== undefined && (selector.kind !== RepositorySourceRefKind.TAG || !isCommitID(selected.tagObjectId) || selected.tagObjectId.length !== selected.commitId.length)) failure('The resolved source selection does not match this repository and requested ref.');
  return selected!;
}

export async function readSourceSnapshot(repository: Repository, repositoryId: string, ref: string, path: string, signal: AbortSignal, typed?: 'branch' | 'tag') {
  if (!sourceRepositoryID(repositoryId) || !sourcePath(path)) failure('Select a valid repository identity and literal source path.');
  if (!typed && isCommitID(ref)) return readExactSource(repository, repositoryId, ref, path, signal);
  let selected;
  if (!ref || typed) selected = await resolveSource(repository, repositoryId, { kind: !ref ? RepositorySourceRefKind.DEFAULT_BRANCH : typed === 'tag' ? RepositorySourceRefKind.TAG : RepositorySourceRefKind.BRANCH, name: ref }, path, signal);
  else {
    // A legacy untyped name has two exact namespaces, never branch-first precedence.
    const candidates = await Promise.allSettled([RepositorySourceRefKind.BRANCH, RepositorySourceRefKind.TAG].map(kind => resolveSource(repository, repositoryId, { kind, name: ref }, path, signal)));
    const matches = [];
    for (const result of candidates) {
      if (result.status === 'fulfilled') matches.push(result.value);
      else if (!(result.reason instanceof ConnectError) || result.reason.code !== Code.NotFound) throw result.reason;
    }
    if (matches.length > 1) failure('This ref name identifies both a branch and a tag. Choose its explicit type in the ref picker.');
    if (!matches.length) throw new ConnectError('The selected branch or tag was not found or is inaccessible.', Code.NotFound);
    selected = matches[0]!;
  }
  return readExactSource(repository, repositoryId, selected.commitId, path, signal);
}

export function validateSourceImage(response: GetRepositoryImageResponse, repositoryId: string, commitId: string, documentPath: string, imageUrl: string) {
  if (!sourceRepositoryID(repositoryId) || !isCommitID(commitId) || !sourcePath(documentPath) || response.repositoryId !== repositoryId || response.commitId !== commitId || response.documentPath !== documentPath || response.imageUrl !== imageUrl) failure('The image receipt does not match its repository and immutable source document.');
  return response;
}
