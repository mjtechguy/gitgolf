export type DiffLine = { kind: 'context' | 'add' | 'delete' | 'notice'; text: string; old?: number; next?: number };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = { path: string; oldPath: string; headers: string[]; hunks: DiffHunk[]; raw: string; additions: number; deletions: number; binary: boolean; valid: boolean };

// Git quotes paths as C strings, including UTF-8 bytes expressed in octal.
// Decode only known escapes. A malformed name remains visible literally.
function gitPath(value: string) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) return value;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') {
      const point = value.codePointAt(i)!;
      bytes.push(...new TextEncoder().encode(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
    } else {
      const char = value[++i] ?? '';
      if (/[0-7]/.test(char || '')) {
        const octal = value.slice(i, i + 3);
        if (!/^[0-7]{3}$/.test(octal)) return value;
        bytes.push(parseInt(octal, 8)); i += 2;
      } else if (char in escapes) bytes.push(escapes[char]!);
      else return value;
    }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch { return value; }
}
function filePath(value: string) {
  const path = gitPath(value);
  return path === '/dev/null' ? '' : path.replace(/^[ab]\//, '');
}

// Only side headers have this native empty terminal delimiter. Do not trim
// generic Git paths or hunk text, and never infer a path from a timestamp suffix.
function sideHeaderPath(value: string): string | undefined {
  const tab = value.indexOf('\t');
  if (tab >= 0) {
    if (tab !== value.length - 1 || value.slice(0, tab) === '/dev/null') return undefined;
    value = value.slice(0, tab);
  }
  return filePath(value);
}

export function parseDiff(text: string): { files: DiffFile[]; preamble: string } {
  const files: DiffFile[] = [];
  const preamble: string[] = [];
  let file: DiffFile | undefined;
  let raw: string[] = [];
  let hunk: DiffHunk | undefined;
  let oldLine = 0, nextLine = 0, oldLeft = 0, nextLeft = 0;
  const finish = () => {
    if (!file) return;
    if (oldLeft || nextLeft) file.valid = false;
    file.raw = raw.join('\n');
    files.push(file);
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      // The explicit ---/+++ or rename headers below disambiguate space-bearing names.
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(line);
      file = { path: match ? filePath(match[2]!) : line.slice(11), oldPath: match ? filePath(match[1]!) : '', headers: [line], hunks: [], raw: '', additions: 0, deletions: 0, binary: false, valid: true };
      raw = [line]; hunk = undefined; oldLeft = 0; nextLeft = 0;
      continue;
    }
    if (!file) { preamble.push(line); continue; }
    raw.push(line);
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (range) {
      if (oldLeft || nextLeft) file.valid = false;
      oldLine = Number(range[1]); oldLeft = Number(range[2] ?? 1);
      nextLine = Number(range[3]); nextLeft = Number(range[4] ?? 1);
      if (![oldLine, oldLeft, nextLine, nextLeft].every(Number.isSafeInteger)) file.valid = false;
      hunk = { header: line, lines: [] }; file.hunks.push(hunk); continue;
    }
    if (hunk && (oldLeft || nextLeft)) {
      if (line.startsWith('\\ No newline at end of file')) hunk.lines.push({ kind: 'notice', text: line });
      else if (line.startsWith(' ') && oldLeft > 0 && nextLeft > 0) {
        hunk.lines.push({ kind: 'context', text: line.slice(1), old: oldLine++, next: nextLine++ }); oldLeft--; nextLeft--;
      } else if (line.startsWith('-') && oldLeft > 0) {
        hunk.lines.push({ kind: 'delete', text: line.slice(1), old: oldLine++ }); oldLeft--; file.deletions++;
      } else if (line.startsWith('+') && nextLeft > 0) {
        hunk.lines.push({ kind: 'add', text: line.slice(1), next: nextLine++ }); nextLeft--; file.additions++;
      } else file.valid = false;
      continue;
    }
    if (hunk) {
      if (line.startsWith('\\ No newline at end of file')) hunk.lines.push({ kind: 'notice', text: line });
      else if (line !== '') file.valid = false;
      continue;
    }
    file.headers.push(line);
    if (line.startsWith('--- ')) {
      const path = sideHeaderPath(line.slice(4));
      if (path === undefined) file.valid = false; else file.oldPath = path;
    }
    if (line.startsWith('+++ ')) {
      const path = sideHeaderPath(line.slice(4));
      if (path === undefined) file.valid = false; else file.path = path || file.oldPath;
    }
    if (line.startsWith('rename from ')) file.oldPath = gitPath(line.slice(12));
    if (line.startsWith('rename to ')) file.path = gitPath(line.slice(10));
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
  }
  finish();
  return { files, preamble: preamble.join('\n').trim() };
}

export function splitLines(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
  const rows: { left?: DiffLine; right?: DiffLine }[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.kind !== 'delete' && lines[i]!.kind !== 'add') {
      rows.push({ left: lines[i]!, right: lines[i]! }); i++; continue;
    }
    const left: DiffLine[] = [], right: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'delete') left.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === 'add') right.push(lines[i++]!);
    for (let j = 0; j < Math.max(left.length, right.length); j++) rows.push({ left: left[j], right: right[j] });
  }
  return rows;
}
