// A browser navigation that ends in the edge's plain-text 404 or 503 gets a small Golf page instead.
// Same status, no-store, no script and nothing loaded from elsewhere. API, Git, MCP and RPC clients keep the exact plain body.
const machinePath = /^\/(?:rpc|git|api|native|mcp|auth)(?:\/|$)|\.git(?:\/|$)|\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;
const pages = {
  404: ['404 · Out of bounds', 'This hole doesn’t exist.', 'Page not found', 'Nothing in this workspace answers at this address. Check the link, or start again from your repositories.', ['/', 'Back to repositories']],
  503: ['503 · Rain delay', 'Play is suspended.', 'Golf is temporarily unavailable', 'This workspace did not answer just now. Wait a moment, then try again.', ['', 'Try again']],
};
const style = `:root{color-scheme:light dark;--bg:#f3f3f3;--panel:#fafafa;--text:#101010;--muted:#5d5d5d;--line:#d0d0d0;--accent:#3f6400;--lime:#d4ff3a}
@media(prefers-color-scheme:dark){:root{--bg:#090909;--panel:#111;--text:#ececec;--muted:#aaa;--line:#343434;--accent:#d4ff3a}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{width:100%;max-width:600px;padding:28px 32px 32px;border:1px solid var(--line);border-top:3px solid var(--lime);background:var(--panel)}
.brand{display:inline-flex;align-items:center;gap:8px;font-size:1.5rem;font-weight:900;letter-spacing:-.08em;color:inherit;text-decoration:none}.mark{display:grid;place-items:center;width:28px;height:28px;padding:0 2px 5px 0;background:var(--lime);color:#0c0c0c;line-height:1}.dot{color:var(--accent)}
svg{display:block;width:100%;max-width:280px;margin:24px 0 8px;stroke-linecap:round}
.code{margin:0;color:var(--accent);font:600 .75rem ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase}
.quip{margin:6px 0;font-size:clamp(1.75rem,6vw,2.5rem);font-weight:900;line-height:1.05;letter-spacing:-.045em;text-transform:uppercase}
h1{margin:0;font-size:1.125rem}p{margin:8px 0 0}.body{color:var(--muted)}
.action{display:inline-block;margin-top:18px;padding:10px 15px;background:var(--lime);color:#0c0c0c;font-weight:600;text-decoration:none}
.trace{margin-top:20px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:.8125rem}code{color:var(--text);font-family:ui-monospace,monospace;overflow-wrap:anywhere}`;

export function browserErrorPage(request, response, requestId) {
  const page = pages[response.status];
  if (!page || request.method !== 'GET' || !(request.headers.get('Accept') || '').includes('text/html')) return null;
  if (machinePath.test(new URL(request.url).pathname) || !/^text\/plain\b/.test(response.headers.get('Content-Type') || '')) return null;
  const [code, quip, title, body, [href, action]] = page;
  // Nothing from the request is echoed (an empty href reloads it); the request ID is a UUID from crypto.randomUUID().
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Golf</title><style>${style}</style></head>
<body><main><a class="brand" href="/" aria-label="Golf home"><span class="mark" aria-hidden="true">g</span><span>golf<span class="dot">.</span></span></a>
<svg viewBox="0 0 240 64" aria-hidden="true"><path d="M4 56H236" stroke="currentColor" opacity=".4"/><path d="M196 56V14" stroke="currentColor" stroke-width="1.5"/><path d="M196 14L214 20L196 26Z" fill="#d4ff3a" stroke="#3f6400"/><path d="${response.status === 404 ? 'M18 48Q120-18 230 52' : 'M18 48H40'}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 6" opacity=".6"/><circle cx="${response.status === 404 ? 230 : 44}" cy="${response.status === 404 ? 52 : 48}" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
<p class="code">${code}</p><p class="quip">${quip}</p><h1>${title}</h1><p class="body">${body}</p>
<a class="action" href="${href}">${action}</a>
${/^[0-9a-f-]{36}$/.test(requestId) ? `<p class="trace">Request ID <code>${requestId}</code></p>` : ''}</main></body></html>`;
  return new Response(html, { status: response.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
}
