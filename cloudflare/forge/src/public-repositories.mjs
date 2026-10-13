import { digest, deny, invalid, Fault } from './common.mjs';
import { settingsAuthority } from './repository-settings.mjs';

// Public means source and Git history. Collaboration, execution and settings
// retain their existing grants; new APIs are private unless explicitly listed.
export const publicSourceMethods = new Set(['GetRepository', 'ListRepositories', 'GetRepositoryOverview',
  'ListBranches', 'ListTags', 'ResolveRepositorySource', 'GetRepositoryFileIndex', 'GetContents',
  'GetRepositoryImage', 'ListCommits', 'GetCommitDiff', 'GetRepositoryComparison']);
export function publicReadRequest(request) {
  const url = new URL(request.url);
  if (request.method === 'POST' && !url.search) {
    if (['/native/discover', '/native/public-profile'].includes(url.pathname)) return true;
    const route = /^\/rpc\/golf\.v1\.RepositoryService\/([A-Za-z]+)$/.exec(url.pathname);
    if (route && publicSourceMethods.has(route[1])) return true;
    if (url.pathname === '/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess') return true;
  }
  return /^\/git\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\.git\/(?:info\/refs|git-upload-pack)$/.test(url.pathname)
    && (request.method === 'GET' && url.pathname.endsWith('/info/refs') && url.search === '?service=git-upload-pack'
      || request.method === 'POST' && url.pathname.endsWith('/git-upload-pack') && !url.search);
}

export async function repositoryVisibility(db, env, person, row, body) {
  if (env.PUBLIC_REPOSITORIES !== 'true' || row.role !== 'admin' || body.repositoryId !== String(row.id)) deny();
  const current = await db.prepare('SELECT * FROM repository_visibility WHERE repository_id=?').bind(row.id).first()
    || { is_public: 0, version: 0 };
  const revision = await digest(JSON.stringify([row.id, row.artifact_name, current.is_public, current.version]));
  if (body.action === 'get') return { repositoryId: String(row.id), isPublic: Boolean(current.is_public), revision };
  if (body.action !== 'set' || typeof body.isPublic !== 'boolean' || Object.keys(body).some(k => !['action', 'repository', 'repositoryId', 'isPublic', 'expectedRevision'].includes(k))) invalid('Choose public or private source visibility.');
  if (body.expectedRevision !== revision) throw new Fault('failed_precondition', 412, 'Repository visibility changed. Refresh before editing.');
  const authority = settingsAuthority(person, row);
  const changed = await db.prepare(`INSERT INTO repository_visibility(repository_id,is_public,version)
    SELECT ?,?,1 WHERE ${authority.sql} AND COALESCE((SELECT version FROM repository_visibility WHERE repository_id=?),0)=?
    ON CONFLICT(repository_id) DO UPDATE SET is_public=excluded.is_public,version=repository_visibility.version+1 WHERE repository_visibility.version=?`)
    .bind(row.id, Number(body.isPublic), ...authority.values, row.id, current.version, current.version).run();
  if (changed.meta.changes !== 1) throw new Fault('failed_precondition', 412, 'Repository visibility or authority changed.');
  return repositoryVisibility(db, env, person, row, { ...body, action: 'get' });
}
