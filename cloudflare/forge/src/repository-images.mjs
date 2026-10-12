import { Fault, deny, invalid } from './common.mjs';
import { bounded, sha } from './git.mjs';

const limit = 256 * 1024;
const hosts = ['raw.githubusercontent.com', 'img.shields.io', 'avatars.githubusercontent.com', 'user-images.githubusercontent.com', 'github.githubassets.com', 'badgen.net', 'expressjs.com', 'sindresorhus.com', 'api.securityscorecards.dev', 'github.com', 'vite.dev', 'sponsors.vite.dev'];
export function externalImageURL(reference) {
  let url; try { url = new URL(reference); } catch { invalid('Unsupported external image URL.'); }
  if (reference.length > 2048 || /[\x00-\x20\x7f\\]/.test(reference) || !/^https:\/\/[a-z\d.-]+(?:[/?]|$)/.test(reference) ||
      url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !hosts.includes(url.host)) invalid('Unsupported external image URL.');
  return url;
}
export function repositoryImagePath(document, reference, literalPath) {
  if (!reference || /^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith('//') || /[\x00-\x1f\\]/.test(reference)) invalid('Use a repository image path.');
  const path = reference.split(/[?#]/)[0], parts = path.startsWith('/') ? [] : document.split('/').slice(0, -1);
  for (const piece of path.split('/')) {
    let name; try { name = decodeURIComponent(piece); } catch { invalid('Invalid repository image path.'); }
    if (!name || name === '.') continue;
    if (name === '..') { if (!parts.length) invalid('Image path leaves this repository.'); parts.pop(); }
    else { if (name.includes('/')) invalid('Invalid repository image path.'); parts.push(name); }
  }
  if (!parts.length) invalid('Use a repository image file.');
  return literalPath(parts.join('/'));
}
export function imageType(bytes) {
  if (!bytes.length || bytes.length > limit) throw new Fault('resource_exhausted', 429, 'Image exceeds preview limits.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = (width, height, type) => {
    if (!width || !height || width > 16384 || height > 16384 || width * height > 32_000_000) invalid('Image dimensions exceed preview limits.');
    return type;
  };
  if (bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v) && view.getUint32(8) === 13 && String.fromCharCode(...bytes.slice(12,16)) === 'IHDR') return dimensions(view.getUint32(16), view.getUint32(20), 'image/png');
  if (bytes.length >= 13 && ['GIF87a','GIF89a'].includes(String.fromCharCode(...bytes.slice(0,6)))) return dimensions(view.getUint16(6,true), view.getUint16(8,true), 'image/gif');
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset++] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
      const size = view.getUint16(offset); if (size < 2 || offset + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) return dimensions(view.getUint16(offset+5), view.getUint16(offset+3), 'image/jpeg');
      offset += size;
    }
  }
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid('Unsupported image content.'); }
  const root = text.replace(/^\s*(?:(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*/, '').match(/^<svg\b[^>]*>/);
  // SVG is returned only to the shared DOMPurify renderer, never as an active document.
  if (root && /\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/.test(root[0]) && !/<!DOCTYPE|<!ENTITY/i.test(text)) return 'image/svg+xml';
  invalid('Unsupported image content.');
}
async function imageFile(repo, treeHash, path) {
  let entry = { type: 'tree', hash: treeHash };
  for (const component of path.split('/')) {
    if (entry.type !== 'tree') deny();
    const tree = await repo.readTree(entry.hash);
    if (!Array.isArray(tree)) deny();
    if (tree.length > 1000) throw new Fault('resource_exhausted', 429, 'Image tree exceeds its read bound.');
    entry = tree.find(child => child.name === component);
    if (!entry || !sha(entry.hash)) deny();
  }
  if (!['blob', 'exec'].includes(entry.type)) invalid('Image source must be an ordinary file.');
  const blob = await repo.readBlob(entry.hash);
  if (!blob) deny();
  if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > limit) throw new Fault('resource_exhausted', 429, 'Image source exceeds preview limits.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length !== blob.size) throw Error('Image blob size changed');
  return bytes;
}
export async function repositoryImage(repo, row, body, literalPath, imageFetch = fetch) {
  if (body.repositoryId !== String(row.id) || !sha(body.commitId) || !body.documentPath || typeof body.imageUrl !== 'string' || !body.imageUrl || body.imageUrl.length > 2048 || /[\x00-\x1f\\]/.test(body.imageUrl)) invalid('Select an immutable document and image reference.');
  const path = literalPath(body.documentPath), commit = await repo.readCommit(body.commitId);
  if (!commit || commit.hash !== body.commitId || !sha(commit.treeHash)) deny();
  const document = new TextDecoder('utf-8', { fatal: true }).decode(await imageFile(repo, commit.treeHash, path));
  const unescaped = document.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[a-f\d]+);/gi, entity => {
    const known = { '&amp;':'&', '&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>' }; if (known[entity]) return known[entity];
    const value = Number.parseInt(entity.slice(entity[2]?.toLowerCase() === 'x' ? 3 : 2, -1), entity[2]?.toLowerCase() === 'x' ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
  });
  if (!unescaped.includes(body.imageUrl)) invalid('Image is not referenced by this source document.');
  let bytes;
  if (body.imageUrl.startsWith('https://')) {
    let url = externalImageURL(body.imageUrl); const signal = AbortSignal.timeout(6000);
    for (let redirects = 0; redirects <= 3; redirects++) {
      // Only anonymous public upstream bytes use edge caching; Golf responses remain private.
      const response = await imageFetch(url.href, { redirect:'manual', signal, cf: { cacheTtlByStatus: { '200': 300, '201-599': -1 } }, headers:{ Accept:'image/png,image/jpeg,image/gif,image/svg+xml', 'User-Agent':'Golf-Repository-Image/1.0' } });
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('Location'); if (!location || redirects === 3) invalid('Image redirect could not be confirmed.');
        url = externalImageURL(new URL(location, url).href); continue;
      }
      if (response.status !== 200) { await response.body?.cancel(); throw new Fault('unavailable', 503, 'External image is unavailable.'); }
      try { bytes = await bounded(response.body, limit); } catch (error) {
        if (error.message === 'payload limit') throw new Fault('resource_exhausted', 429, 'Image exceeds preview limits.'); throw error;
      }
      break;
    }
  } else bytes = await imageFile(repo, commit.treeHash, repositoryImagePath(path, body.imageUrl, literalPath));
  const mediaType = imageType(bytes); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset+16384));
  return { repositoryId:String(row.id), commitId:body.commitId, documentPath:path, imageUrl:body.imageUrl, mediaType, content:btoa(binary) };
}
