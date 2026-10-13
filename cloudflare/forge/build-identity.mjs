import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function nativeBuildIdentity(settings, assets) {
  const root = new URL('./', import.meta.url), source = new URL('./src/', root);
  const files = (await readdir(source)).filter(name => name.endsWith('.mjs')).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(new URL(file, source)));
  hash.update(await readFile(new URL('./data/languages.json', root)));
  hash.update(await readFile(new URL('./schema.sql', root))).update(JSON.stringify(assets));
  const configuration = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  hash.update(configuration);
  return { release: hash.digest('hex'), configuration };
}
