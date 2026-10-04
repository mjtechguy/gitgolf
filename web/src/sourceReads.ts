import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { isCommitID } from './navigation';
import { SourceEntryType } from './gen/golf/v1/golf_pb';
import type { GetContentsResponse, GetRepositoryImageResponse, RepositoryKey, SourceEntry, Commit } from './gen/golf/v1/golf_pb';

type Repository = Pick<RepositoryKey, 'owner' | 'name'>;
const failure = (message: string): never => { throw new ConnectError(message, Code.FailedPrecondition); };
export const sourceRepositoryID = (id: string) => id.length <= 19 && /^[1-9][0-9]*$/.test(id) && BigInt(id) <= 9223372036854775807n;
export const sourcePath = (path: string) => new TextEncoder().encode(path).length <= 4096 && !/[\\\p{Cc}\uD800-\uDFFF]/u.test(path) && (path === '' || path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
export const sourceRef = (ref: string) => ref !== '' && new TextEncoder().encode(ref).length <= 1024 && ref !== '@' && !ref.startsWith('-') && !/[ ~^:?*[\\\p{Cc}\uD800-\uDFFF]/u.test(ref) && !ref.includes('..') && !ref.includes('@{') && ref.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
const kinds = [SourceEntryType.DIRECTORY, SourceEntryType.FILE, SourceEntryType.SYMLINK, SourceEntryType.SUBMODULE];
const validEntry = (entry: SourceEntry) => sourcePath(entry.path) && entry.path !== '' && entry.path.split('/').at(-1) === entry.name && isCommitID(entry.sha) && kinds.includes(entry.type) && entry.size >= 0n;

export const validSourceLatestChange = (commit: Commit, head: string) => commit.sha === head && isCommitID(head) && new TextEncoder().encode(commit.message).length <= 256 * 1024 && !/[\u0000\uD800-\uDFFF]/u.test(commit.message) && new TextEncoder().encode(commit.authorName).length <= 1024 && !/[\p{Cc}\uD800-\uDFFF]/u.test(commit.authorName) && Number.isFinite(Date.parse(commit.authoredAt));

export function validateSource(response: GetContentsResponse, repositoryId: string, commitId: string, path: string) {
  if (!sourceRepositoryID(repositoryId) || !isCommitID(commitId) || !sourcePath(path) || response.repositoryId !== repositoryId || response.commitId !== commitId || response.path !== path || !kinds.includes(response.kind)) failure('The source receipt does not match this repository, path and exact snapshot.');
  if (response.kind === SourceEntryType.DIRECTORY) {
    const seen = new Set<string>();
    if (response.file || response.entries.length > 1000) failure('The folder response exceeds the supported inventory or includes conflicting file data.');
    for (const entry of response.entries) {
      if (entry.latestChange && !validSourceLatestChange(entry.latestChange, commitId)) failure('The latest change does not identify this exact source snapshot.');
      if (!validEntry(entry) || entry.path !== (path ? `${path}/` : '') + entry.name || seen.has(entry.path)) failure('The folder contains invalid or duplicate direct-child metadata.');
      seen.add(entry.path);
    }
  } else if (response.file?.entry?.latestChange) failure('Latest-change projection is only supported for directory entries.');
  else if (response.entries.length || !response.file?.entry || !validEntry(response.file.entry) || response.file.entry.path !== path || response.file.entry.type !== response.kind) failure('The file metadata does not match the selected source path.');
  return response;
}

export async function readExactSource(repository: Repository, repositoryId: string, commitId: string, path: string, signal: AbortSignal, includeLatestChanges = false) {
  if (!sourceRepositoryID(repositoryId) || !isCommitID(commitId) || !sourcePath(path)) failure('Select a valid repository identity, full commit and literal source path.');
  signal.throwIfAborted();
  const response = await repositoryClient.getContents({ repository, repositoryId, ref: commitId, path, includeLatestChanges }, { signal, timeoutMs: 8000 });
  signal.throwIfAborted();
  return validateSource(response, repositoryId, commitId, path);
}

export function validateSourceImage(response: GetRepositoryImageResponse, repositoryId: string, commitId: string, documentPath: string, imageUrl: string) {
  if (!sourceRepositoryID(repositoryId) || !isCommitID(commitId) || !sourcePath(documentPath) || response.repositoryId !== repositoryId || response.commitId !== commitId || response.documentPath !== documentPath || response.imageUrl !== imageUrl) failure('The image receipt does not match its repository and immutable source document.');
  return response;
}
