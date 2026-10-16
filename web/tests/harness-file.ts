import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Harness pages and modules live in web/.tmp (ignored by git), inside the dev server's root, so Vite watches them. Once
// Vite has served a harness, rewriting or deleting it sends a full reload to every open page of every worker, and a
// worker that deletes it in afterAll breaks another worker still using it. So a harness is written only when its content
// changes, atomically (a concurrent reader never sees a truncated file), and is never removed.
export async function writeHarness(file: string, content: string) {
  try { if (await readFile(file, 'utf8') === content) return; } catch { /* not written yet */ }
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  await writeFile(partial, content);
  await rename(partial, file);
}
