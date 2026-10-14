// A deploy replaces the hashed page chunks. A tab opened before it reloads once onto the new build instead of failing to open a page;
// a second failure for the same build is left to surface, so a broken deploy cannot loop.
export function reloadOnceForBuild(storage: Pick<Storage, 'getItem' | 'setItem'>, build: string, reload: () => void): boolean {
  const key = 'golf.reloadedForBuild';
  try { if (!build || storage.getItem(key) === build) return false; storage.setItem(key, build); } catch { return false; }
  reload();
  return true;
}
