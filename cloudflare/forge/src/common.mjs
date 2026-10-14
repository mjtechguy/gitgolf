export const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');

const jsonHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
export const uuidOK = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const reply = (value, status = 200) => Response.json(value, { status, headers: jsonHeaders });
export class Fault extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
export const deny = () => { throw new Fault('not_found', 404, 'Repository unavailable.'); };
export const invalid = message => { throw new Fault('invalid_argument', 400, message); };
export const unsupported = () => { throw new Fault('unimplemented', 501, 'This capability is not implemented on the native forge.'); };
export const conflict = () => { throw new Fault('failed_precondition', 412, 'An unresolved operation fences further changes.'); };
// Uploads carry at most 256 KiB of content, about 350 KiB as Connect JSON base64. Every other request keeps 96 KiB.
export const bodyLimit = path => /^\/rpc\/golf\.v1\.(?:RepositoryReleaseManagementService\/SubmitRepositoryReleaseOperation|DiscussionAttachmentUploadService\/SubmitDiscussionAttachmentUpload|RepositoryFileMutationService\/SubmitRepositoryFileMutation|RepositoryFileBatchService\/SubmitRepositoryFileBatch)$/.test(path) ? 400 * 1024 : 96 * 1024;

export function page(body) {
  const number = body.page?.page || 1, limit = body.page?.limit || 20;
  if (!Number.isInteger(number) || number < 1 || number > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Invalid page.');
  return { number, limit, offset: (number - 1) * limit };
}

export function user(row) { return { id: String(row.id), login: row.login, fullName: row.full_name }; }
