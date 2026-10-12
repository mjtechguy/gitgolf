const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Golf PR application</title>
<style>body{font:18px system-ui;max-width:48rem;margin:3rem auto;padding:1rem;background:#10201b;color:#eef5f2}input,button{font:inherit;padding:.7rem}li{margin:.7rem 0}code{overflow-wrap:anywhere}</style>
<h1>Golf PR application</h1><p>This private Worker has its own D1 database and R2 bucket. Golf checks your current repository access on each request.</p>
<form id="entry"><label for="message">Leave a demo note</label> <input id="message" maxlength="500" required><button>Save to D1 and R2</button></form>
<p id="status" role="status"></p><p>Canonical Artifacts commit: <code id="commit"></code></p><ul id="messages"></ul>
<script>const status=document.getElementById('status');async function load(){const r=await fetch('/api/messages');if(!r.ok)throw Error('Current preview access unavailable');const data=await r.json();document.getElementById('commit').textContent=data.commit;document.getElementById('messages').replaceChildren(...data.messages.map(m=>{const li=document.createElement('li');li.textContent=m.body;return li}));status.textContent=data.files+' private R2 receipts; Secrets Store signing '+(data.signing?'configured':'unallocated')}
document.getElementById('entry').addEventListener('submit',async e=>{e.preventDefault();try{const r=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'text/plain'},body:document.getElementById('message').value});if(!r.ok)throw Error('Write could not be confirmed');document.getElementById('message').value='';await load()}catch(e){status.textContent=e.message}});load().catch(e=>status.textContent=e.message);</script></html>`;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (path !== '/api/messages') return new Response('Unavailable', { status: 404 });
    if (request.method === 'GET') {
      const messages = await env.DB.prepare('SELECT body,created_at FROM messages ORDER BY created_at DESC LIMIT 100').all();
      const files = await env.FILES.list({ limit: 100 });
      return Response.json({ commit: env.GOLF_COMMIT, messages: messages.results, files: files.objects.length, signing: Boolean(env.APP_SECRET) });
    }
    if (request.method !== 'POST') return new Response('Unavailable', { status: 405 });
    const body = await request.text();
    if (!body.trim() || body.length > 500) return new Response('Use a note of 1–500 characters', { status: 400 });
    const id = crypto.randomUUID(), createdAt = new Date().toISOString(), receipt = JSON.stringify({ id, body, createdAt, commit: env.GOLF_COMMIT });
    let signature = '';
    if (env.APP_SECRET) {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(await env.APP_SECRET.get()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(receipt)))].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    await env.FILES.put(id + '.json', receipt, { httpMetadata: { contentType: 'application/json' }, customMetadata: { signature } });
    await env.DB.prepare('INSERT INTO messages(id,body,created_at) VALUES(?,?,?)').bind(id, body, createdAt).run();
    return Response.json({ id }, { status: 201 });
  },
};
