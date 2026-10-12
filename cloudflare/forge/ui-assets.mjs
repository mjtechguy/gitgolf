import { readdir, lstat, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

// Static Assets currently drops ctx.access; keep this bounded UI in the control Worker.
export async function readUIAssets(directory) {
  const assets = {}, types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  let bytes = 0;
  async function visit(path = '') {
    if (path.split('/').length > 3) throw Error('Native UI asset nesting exceeds its bound');
    for (const entry of await readdir(resolve(directory, path))) {
      const name = path ? path + '/' + entry : entry;
      if (!/^[A-Za-z0-9_./-]+$/.test(name) || entry.startsWith('.')) throw Error('Unsafe native UI asset');
      const file = resolve(directory, name), stat = await lstat(file);
      if (stat.isDirectory()) await visit(name);
      else {
        const type = types[extname(name)];
        if (!stat.isFile() || !type || stat.size + bytes > 4 * 1024 * 1024 || Object.keys(assets).length >= 192) throw Error('Unsupported native UI asset');
        const content = await readFile(file); bytes += content.length;
        if (bytes > 4 * 1024 * 1024) throw Error('Native UI bundle exceeds 4 MiB');
        assets['/' + name] = { type, content: content.toString('base64') };
      }
    }
  }
  await visit();
  if (!assets['/native.html']) throw Error('Build the native UI first');
  return assets;
}
