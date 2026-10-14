const route = /^\/api\/repositories\/([^/]+)\/([^/]+)\/([1-9][0-9]{0,15})\/releases\/([1-9][0-9]{0,15})\/assets\/([1-9][0-9]{0,15})\/download$/;
const refuse = (status, text) => new Response(text, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// The workspace authorizes the caller and names the private object; its bytes stream from this stateless Worker.
export async function releaseAssetDownload(request, env, owner, headers) {
  const url = new URL(request.url), selected = route.exec(url.pathname);
  // Another site may link here, but may not embed or script a credentialed download.
  if (!selected || !env.EVIDENCE_BUCKET || request.method !== 'GET' || url.search || request.headers.has('Upgrade') || !['same-origin', 'none', null].includes(request.headers.get('Sec-Fetch-Site'))) return refuse(404, 'Unavailable');
  const grant = await owner.fetch(new Request(env.PUBLIC_ORIGIN + '/native/release-asset/read', { method: 'POST', headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ repository: { owner: selected[1], name: selected[2] }, repositoryId: selected[3], releaseId: selected[4], assetId: selected[5] }) }));
  if (!grant.ok) return grant.status === 401 ? refuse(401, 'Sign-in required') : grant.status >= 500 || grant.status === 429 ? refuse(503, 'Temporarily unavailable') : refuse(404, 'Unavailable');
  const asset = await grant.json(), object = await env.EVIDENCE_BUCKET.get(asset.key);
  if (!object || object.size !== asset.size || object.customMetadata?.sha256 !== asset.sha256) return refuse(503, 'Asset bytes could not be verified');
  const fallback = asset.name.replace(/[^\x20-\x7e]|["\\]/g, '_'), encoded = encodeURIComponent(asset.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size), 'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' } });
}
