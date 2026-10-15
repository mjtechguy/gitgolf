import { Fault } from './common.mjs';

// API token scope (AM-3). actor() attaches person.token_scope = { repositories: null | [repositoryId strings], permission: 'read' | 'write',
// branchPattern: '' | exact | 'prefix*', label?: 'agent task token' } to a token caller; a session or native credential has none and is
// limited only by its grant. The grant still applies on every call: scope can only narrow it. Anything malformed fails closed.
function refusal(person, repositoryId, { write = false, ref = '' } = {}) {
  const scope = person?.token_scope;
  if (scope === undefined || scope === null) return '';
  if (typeof scope !== 'object') return 'This API token has no usable scope.';
  if (scope.repositories !== null && !(Array.isArray(scope.repositories) && scope.repositories.includes(String(repositoryId)))) return `This ${scope.label || 'API token'}'s scope does not include this repository.`;
  if (!write) return '';
  if (scope.permission !== 'write') return `This ${scope.label || 'API token'} is read-only.`;
  const pattern = scope.branchPattern ?? '';
  if (pattern === '') return '';
  const branch = typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice(11) : typeof ref === 'string' && !ref.startsWith('refs/') ? ref : '';
  const allowed = typeof pattern === 'string' && Boolean(branch) && (pattern.endsWith('*') ? branch.startsWith(pattern.slice(0, -1)) : branch === pattern);
  return allowed ? '' : `This ${scope.label || 'API token'} may write only to branches matching ${String(pattern).slice(0, 200)}.`;
}

// True when the caller's token scope (if any) allows this repository and, for a write, the permission and branch (short name or refs/heads/…).
export const scopeAllows = (person, repositoryId, options) => !refusal(person, repositoryId, options);

// 403 permission_denied naming the scope that refused.
export function requireScope(person, repositoryId, options) {
  const message = refusal(person, repositoryId, options);
  if (message) throw new Fault('permission_denied', 403, message);
}
