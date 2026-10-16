import type { QueryClient } from '@tanstack/react-query';
import { privateNavigationQuery } from './RepositoryUI';
import { readExactSource } from './sourceReads';
import { SourceEntryType } from './gen/golf/v1/golf_pb';
import type { SourceEntry } from './gen/golf/v1/golf_pb';

export function sourceNavigationOptions(scope: readonly unknown[], repositoryId: string, commitId: string, path: string) {
  return { ...privateNavigationQuery, queryKey: [...scope, 'source', repositoryId, commitId, path, 'latest-changes'],
    initialPageParam: 1, queryFn: ({ signal, pageParam }: { signal: AbortSignal; pageParam: number }) =>
      readExactSource({ owner: String(scope[2]), name: String(scope[3]) }, repositoryId, commitId, path, signal, true, pageParam) };
}

// Directories first, then names in the default locale's order. One collator serves every comparison (localeCompare
// without arguments repeats the locale lookup), and a listing is sorted once per received entries array.
const entryCollator = new Intl.Collator();
const sortedListings = new WeakMap<readonly SourceEntry[], SourceEntry[]>();
export function sortedSourceEntries(entries: readonly SourceEntry[]) {
  let sorted = sortedListings.get(entries);
  if (!sorted) { sorted = [...entries].sort((a, b) => Number(b.type === SourceEntryType.DIRECTORY) - Number(a.type === SourceEntryType.DIRECTORY) || entryCollator.compare(a.name, b.name)); sortedListings.set(entries, sorted); }
  return sorted;
}

const pending = new WeakMap<QueryClient, Set<string>>();
// Intent-only prefetch: two reads at a time, small files, existing private cache bounds.
export function prefetchSource(client: QueryClient, scope: readonly unknown[], repositoryId: string, commitId: string, entry: SourceEntry) {
  if (![SourceEntryType.DIRECTORY, SourceEntryType.FILE].includes(entry.type) || entry.type === SourceEntryType.FILE && entry.size > 256n * 1024n) return;
  let active = pending.get(client);
  if (!active) { active = new Set(); pending.set(client, active); }
  const options = sourceNavigationOptions(scope, repositoryId, commitId, entry.path), key = JSON.stringify(options.queryKey);
  if (active.size >= 2 || active.has(key)) return;
  active.add(key);
  void client.prefetchInfiniteQuery(options).finally(() => active!.delete(key));
}
