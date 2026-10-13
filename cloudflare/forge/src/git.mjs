export const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const zero = '0'.repeat(40);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function validRef(ref) {
  return typeof ref === 'string' && /^(?:refs\/heads|refs\/tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) &&
    !ref.includes('..') && !ref.includes('//') && ref.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));
}

export async function bounded(stream, limit) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error('payload limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function packet(bytes, offset) {
  if (offset + 4 > bytes.length) throw Error('invalid Git packet');
  const header = decoder.decode(bytes.subarray(offset, offset + 4));
  if (!/^[0-9a-f]{4}$/.test(header)) throw Error('invalid Git length');
  const length = parseInt(header, 16);
  if (length === 0) return { text: '', end: offset + 4, flush: true };
  if (length < 4 || length > 65520 || offset + length > bytes.length) throw Error('invalid Git length');
  return { text: decoder.decode(bytes.subarray(offset + 4, offset + length)), end: offset + length, flush: false };
}

// shortcut: single-ref SHA-1 pushes up to8MiB; widen only with atomic multi-ref
// admission, larger streaming limits and provider outcome qualification.
export function receiveCommand(bytes) {
  const first = packet(bytes, 0);
  if (first.flush) throw Error('missing Git command');
  const [command, capabilities, extra] = first.text.replace(/\n$/, '').split('\0');
  if (!capabilities || extra !== undefined) throw Error('missing Git capabilities');
  const fields = command.split(' ');
  if (fields.length !== 3 || !sha(fields[0]) || !sha(fields[1]) || !validRef(fields[2]) || fields[0] === fields[1]) throw Error('invalid Git command');
  const caps = capabilities.split(' ').filter(Boolean);
  if (!caps.includes('report-status') && !caps.includes('report-status-v2')) throw Error('Git status required');
  if (caps.some(c => !['report-status', 'report-status-v2', 'side-band-64k', 'quiet', 'ofs-delta', 'delete-refs', 'object-format=sha1'].includes(c) && !/^agent=[A-Za-z0-9./_-]{1,128}$/.test(c))) throw Error('unsupported Git capability');
  const end = packet(bytes, first.end);
  if (!end.flush) throw Error('only one ref per push');
  if (fields[1] !== zero && decoder.decode(bytes.subarray(end.end, end.end + 4)) !== 'PACK') throw Error('missing Git pack');
  if (fields[1] === zero && end.end !== bytes.length) throw Error('unexpected deletion body');
  return { old: fields[0], next: fields[1], ref: fields[2] };
}

export function advertisedRefs(bytes) {
  const refs = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const row = packet(bytes, offset);
    offset = row.end;
    if (row.flush || row.text.startsWith('# service=')) continue;
    const text = row.text.split('\0')[0].trimEnd();
    const split = text.indexOf(' '), hash = text.slice(0, split), ref = text.slice(split + 1);
    if (hash === zero && ref === 'capabilities^{}') continue;
    if (!sha(hash) || (ref !== 'HEAD' && !validRef(ref) && !(ref.endsWith('^{}') && validRef(ref.slice(0, -3))))) throw Error('invalid Git advertisement');
    if (refs.has(ref)) throw Error('duplicate Git ref');
    refs.set(ref, hash);
  }
  return refs;
}

export function remote(env, name) {
  if (!/^[a-f0-9]{32}$/.test(env.ACCOUNT_ID) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(env.ARTIFACTS_NAMESPACE) ||
      !/^repo-[a-f0-9]{32}$/.test(name)) throw Error('invalid provider identity');
  return `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${name}.git`;
}

export class GitProviderError extends Error {}

export async function gitRequest(env, repo, name, suffix, service, body, providerFetch = fetch, protocol = null) {
  if (protocol !== null && !['version=1', 'version=2'].includes(protocol)) throw new GitProviderError('Unsupported Git protocol header.');
  const credential = await repo.createToken(service === 'git-receive-pack' ? 'write' : 'read', 60);
  try {
    if (typeof credential.plaintext !== 'string' || credential.plaintext.length > 1024 || !/^[\x21-\x7e]+$/.test(credential.plaintext)) throw new GitProviderError('Provider Git credential format is unsupported.');
    const headers = { Authorization: `Bearer ${credential.plaintext}`, 'User-Agent': 'Golf-Native-Forge/1' };
    if (protocol) headers['Git-Protocol'] = protocol;
    if (body) headers['Content-Type'] = `application/x-${service}-request`;
    const response = await providerFetch(remote(env, name) + '/' + suffix, {
      method: body ? 'POST' : 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000),
    });
    const bytes = await bounded(response.body, body && service === 'git-upload-pack' ? 32 * 1024 * 1024 : 2 * 1024 * 1024);
    if (response.status !== 200) throw new GitProviderError(`Provider Git HTTP status ${response.status}.`);
    if (response.headers.get('Content-Type') !== `application/x-${service}-${body ? 'result' : 'advertisement'}`) throw new GitProviderError('Provider Git content type is unsupported.');
    return { bytes, contentType: response.headers.get('Content-Type') };
  } finally {
    if (await repo.revokeToken(credential.plaintext) !== true) throw new GitProviderError('Provider Git token revocation unconfirmed.');
  }
}

export const packetLine = text => encoder.encode((encoder.encode(text).length + 4).toString(16).padStart(4, '0') + text);

// Golf owns its default branch; advertise the same HEAD to clients without changing Git objects.
export function defaultBranchAdvertisement(bytes, branch) {
  if (!validRef('refs/heads/'+branch)) throw new GitProviderError('Invalid default branch.');
  let offset=0,header=packet(bytes,offset);offset=header.end;
  if(header.text!=='# service=git-upload-pack\n') throw new GitProviderError('Unsupported Git advertisement.');
  const separator=packet(bytes,offset);offset=separator.end;if(!separator.flush) throw new GitProviderError('Invalid Git service separator.');
  if (packet(bytes,offset).text === 'version 2\n') return bytes;
  const refs=[],names=new Set();let capabilities='',ended=false;
  while(offset<bytes.length) {
    const entry=packet(bytes,offset);offset=entry.end;
    if(entry.flush) {ended=true;break;}
    const [value,caps,...extra]=entry.text.replace(/\n$/,'').split('\0');
    if(extra.length||caps!==undefined&&refs.length) throw new GitProviderError('Invalid Git capabilities.');
    if(caps!==undefined) capabilities=caps;
    const [hash,name,...rest]=value.split(' ');
    const refName=name?.endsWith('^{}')?name.slice(0,-3):name;
    const reference=refName?.startsWith('refs/')&&!/[\x00-\x20\x7f~^:?*\[\\]/.test(refName)&&!refName.includes('..')&&!refName.includes('@{')&&refName.split('/').every(p=>p&&!p.startsWith('.')&&!p.endsWith('.')&&!p.endsWith('.lock'));
    if(!sha(hash)||!name||/[\s\0]/.test(name)||rest.length||names.has(name)||!(name==='HEAD'||name==='capabilities^{}'&&hash===zero||reference)) throw new GitProviderError('Invalid advertised ref.');
    names.add(name);refs.push({hash,name});
  }
  if(!ended||offset!==bytes.length) throw new GitProviderError('Incomplete Git advertisement.');
  const selected=refs.find(r=>r.name==='refs/heads/'+branch);
  const kept=refs.filter(r=>r.name!=='HEAD'&&r.name!=='capabilities^{}');
  if(selected) kept.unshift({hash:selected.hash,name:'HEAD'});
  const caps=capabilities.split(' ').filter(c=>c&&!c.startsWith('symref=HEAD:'));
  // A missing default ref stays explicit; clients must not guess a different branch as HEAD.
  caps.push('symref=HEAD:refs/heads/'+branch);
  if(!kept.length) kept.push({hash:zero,name:'capabilities^{}'});
  const chunks=[packetLine(header.text),encoder.encode('0000'),...kept.map((r,i)=>packetLine(r.hash+' '+r.name+(i===0?'\0'+caps.join(' '):'')+'\n')),encoder.encode('0000')];
  const result=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let cursor=0;
  for(const chunk of chunks) {result.set(chunk,cursor);cursor+=chunk.length;}
  return result;
}

export function gitV2Command(bytes) {
  const first = packet(bytes, 0);
  return first.text.replace(/\n$/, '');
}

// v2 negotiates shallow boundaries in fetch; retain Golf's default branch in ls-refs.
export function defaultBranchRefsV2(bytes, branch, head) {
  if (!validRef('refs/heads/'+branch) || head !== undefined && !sha(head)) throw new GitProviderError('Invalid default branch identity.');
  const chunks=[]; let offset=0, ended=false, sawHead=false;
  while(offset<bytes.length) {
    const row=packet(bytes,offset); offset=row.end;
    if(row.flush) {chunks.push(encoder.encode('0000'));ended=true;break;}
    const fields=row.text.replace(/\n$/,'').split(' ');
    if(fields[1]==='HEAD') {
      if(sawHead || !sha(fields[0]) && fields[0]!=='unborn') throw new GitProviderError('Invalid advertised HEAD.');
      sawHead=true;
      if(head) chunks.push(packetLine(head+' HEAD'+(fields.some(f=>f.startsWith('symref-target:'))?' symref-target:refs/heads/'+branch:'')+'\n'));
    } else chunks.push(packetLine(row.text));
  }
  if(!ended||offset!==bytes.length) throw new GitProviderError('Incomplete v2 ref response.');
  const result=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let cursor=0;
  for(const chunk of chunks) {result.set(chunk,cursor);cursor+=chunk.length;}
  return result;
}
