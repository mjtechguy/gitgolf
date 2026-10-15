import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeText, textMergeLimits } from './src/text-merge.mjs';

const gitAvailable = spawnSync('git', ['--version']).status === 0, skip = !gitAvailable && 'git is not installed';
const encoder = new TextEncoder(), bytes = value => typeof value === 'string' ? encoder.encode(value) : value;
const text = list => list.join('');

// `git merge-file -p ours base theirs` with no user or system configuration (merge.conflictStyle changes the outcome).
function gitMergeFile(t) {
  const root = mkdtempSync(join(tmpdir(), 'golf-text-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  return (base, ours, theirs) => {
    writeFileSync(join(root, 'base'), bytes(base)); writeFileSync(join(root, 'ours'), bytes(ours)); writeFileSync(join(root, 'theirs'), bytes(theirs));
    const run = spawnSync('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], { cwd: root, env, maxBuffer: 1 << 28 });
    return { status: run.status, stdout: new Uint8Array(run.stdout) };
  };
}

// The same outcome as git: identical bytes for a clean merge, a conflict (with hunks) when git reports conflicts.
function agree(git, name, base, ours, theirs) {
  const native = git(base, ours, theirs), result = mergeText(bytes(base), bytes(ours), bytes(theirs));
  assert.ok(native.status >= 0 && native.status < 128, `${name}: git merge-file failed (${native.status})`);
  if (native.status === 0) {
    assert.ok(result.merged, `${name}: git merges cleanly, mergeText reports ${result.reason}`);
    assert.deepEqual(result.merged, native.stdout, name);
    return 'clean';
  }
  assert.equal(result.conflict, true, `${name}: git reports ${native.status} conflicts, mergeText merged`);
  assert.equal(result.reason, 'both_modified', name);
  assert.ok(result.hunks.length >= 1 && result.hunks.length <= textMergeLimits.hunks, name);
  for (const hunk of result.hunks) assert.ok(hunk.baseStart <= hunk.baseEnd && hunk.oursStart <= hunk.oursEnd && hunk.theirsStart <= hunk.theirsEnd, name);
  return 'conflict';
}

// mulberry32: a fixed-seed generator so every run checks the same cases.
function random(seed) {
  return n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
}

const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`);
const edit = (list, at, remove, ...insert) => { const out = [...list]; out.splice(at, remove, ...insert); return out; };
const ten = lines(10), crlf = ten.map(line => line.replace('\n', '\r\n')), open = s => s.replace(/\r?\n$/, '');

// [name, base, ours, theirs]; the expected outcome is whatever git does, asserted against `git merge-file`.
const handWritten = [
  ['disjoint edits far apart', text(ten), text(edit(ten, 1, 1, 'TWO\n')), text(edit(ten, 8, 1, 'NINE\n'))],
  ['edits with one unchanged line between', text(ten), text(edit(ten, 3, 1, 'FOUR\n')), text(edit(ten, 5, 1, 'SIX\n'))],
  ['edits on adjacent lines conflict in git', text(ten), text(edit(ten, 3, 1, 'FOUR\n')), text(edit(ten, 4, 1, 'FIVE\n'))],
  ['insert right after the line the other side edits', text(ten), text(edit(ten, 3, 1, 'FOUR\n')), text(edit(ten, 4, 0, 'new\n'))],
  ['insert right before the line the other side edits', text(ten), text(edit(ten, 4, 0, 'new\n')), text(edit(ten, 4, 1, 'FIVE\n'))],
  ['the same edit on both sides', text(ten), text(edit(ten, 2, 1, 'THREE\n')), text(edit(ten, 2, 1, 'THREE\n'))],
  ['the same edit plus a disjoint one', text(ten), text(edit(edit(ten, 2, 1, 'THREE\n'), 8, 1, 'NINE\n')), text(edit(ten, 2, 1, 'THREE\n'))],
  ['overlapping different edits', text(ten), text(edit(ten, 2, 3, 'A\n')), text(edit(ten, 3, 3, 'B\n'))],
  ['different edits of one line', text(ten), text(edit(ten, 5, 1, 'ours\n')), text(edit(ten, 5, 1, 'theirs\n'))],
  ['inserts at the same place, same lines', text(ten), text(edit(ten, 5, 0, 'x\n', 'y\n')), text(edit(ten, 5, 0, 'x\n', 'y\n'))],
  ['inserts at the same place, different lines', text(ten), text(edit(ten, 5, 0, 'x\n')), text(edit(ten, 5, 0, 'y\n'))],
  ['inserts at the start and at the end', text(ten), text(edit(ten, 0, 0, 'first\n')), text(edit(ten, 10, 0, 'last\n'))],
  ['both insert at the start, differently', text(ten), text(edit(ten, 0, 0, 'a\n')), text(edit(ten, 0, 0, 'b\n'))],
  ['both append at the end, differently', text(ten), text(edit(ten, 10, 0, 'a\n')), text(edit(ten, 10, 0, 'b\n'))],
  ['both delete the same line', text(ten), text(edit(ten, 4, 1)), text(edit(ten, 4, 1))],
  ['disjoint deletes', text(ten), text(edit(ten, 1, 2)), text(edit(ten, 6, 2))],
  ['delete against an edit of the same line', text(ten), text(edit(ten, 4, 1)), text(edit(ten, 4, 1, 'FIVE\n'))],
  ['delete next to an edit', text(ten), text(edit(ten, 4, 1)), text(edit(ten, 5, 1, 'SIX\n'))],
  ['overlapping deletes', text(ten), text(edit(ten, 2, 3)), text(edit(ten, 3, 3))],
  ['one side deletes everything, the other edits', text(ten), '', text(edit(ten, 4, 1, 'FIVE\n'))],
  ['both delete everything', text(ten), '', ''],
  ['one side unchanged', text(ten), text(ten), text(edit(ten, 4, 1, 'FIVE\n'))],
  ['other side unchanged', text(ten), text(edit(ten, 4, 1, 'FIVE\n')), text(ten)],
  ['CRLF disjoint edits', text(crlf), text(edit(crlf, 1, 1, 'TWO\r\n')), text(edit(crlf, 8, 1, 'NINE\r\n'))],
  ['CRLF adjacent edits', text(crlf), text(edit(crlf, 1, 1, 'TWO\r\n')), text(edit(crlf, 2, 1, 'THREE\r\n'))],
  ['line endings changed on one line by one side', text(ten), text(edit(ten, 2, 1, 'line 3\r\n')), text(edit(ten, 8, 1, 'NINE\n'))],
  ['every line ending changed by one side', text(ten), text(crlf), text(edit(ten, 8, 1, 'NINE\n'))],
  ['mixed line endings', text(edit(crlf, 5, 5, ...ten.slice(5))), text(edit(edit(crlf, 5, 5, ...ten.slice(5)), 0, 1, 'ONE\r\n')), text(edit(edit(crlf, 5, 5, ...ten.slice(5)), 9, 1, 'TEN\n'))],
  ['no final newline, the last line edited by one side', open(text(ten)), open(text(edit(ten, 9, 1, 'TEN\n'))), open(text(edit(ten, 0, 1, 'ONE\n')))],
  ['no final newline, one side appends a line', open(text(ten)), text(ten) + 'eleven', open(text(edit(ten, 0, 1, 'ONE\n')))],
  ['no final newline, one side adds the newline', open(text(ten)), text(ten), open(text(edit(ten, 0, 1, 'ONE\n')))],
  ['no final newline, one side adds it and the other edits the last line', open(text(ten)), text(ten), open(text(edit(ten, 9, 1, 'TEN\n')))],
  ['both remove the final newline', text(ten), open(text(ten)), open(text(ten))],
  ['one removes the final newline, the other edits the start', text(ten), open(text(ten)), text(edit(ten, 0, 1, 'ONE\n'))],
  ['empty base, both add the same', '', 'a\nb\n', 'a\nb\n'],
  ['empty base, both add different files', '', 'a\n', 'b\n'],
  ['empty base, one side stays empty', '', '', 'b\n'],
  ['empty base, adds sharing lines', '', 'a\nb\nc\n', 'a\nB\nc\n'],
  ['all empty', '', '', ''],
  ['single line without newline edited on both sides', 'x', 'y', 'z'],
  ['single line without newline, one side', 'x', 'x\n', 'x'],
  ['blank lines', '\n\n\n\n\n', '\nA\n\n\n\n', '\n\n\n\nB\n'],
  ['blank lines inserted on both sides', 'a\nb\nc\n', 'a\n\nb\nc\n', 'a\nb\n\nc\n'],
  ['repeated lines', 'x\nx\nx\nx\nx\nx\n', 'x\nx\nx\nx\nx\nx\nx\n', 'x\nx\ny\nx\nx\nx\n'],
  ['repeated lines, both insert a duplicate', 'x\ny\nx\ny\n', 'x\ny\nx\ny\nx\ny\n', 'x\ny\nx\ny\nx\ny\n'],
  ['a moved block against an edit', text(ten), text([...ten.slice(5), ...ten.slice(0, 5)]), text(edit(ten, 2, 1, 'THREE\n'))],
  ['unicode and a byte-order mark', '﻿é\nü\n日本\n語\n😀\n', '﻿é\nÜ\n日本\n語\n😀\n', '﻿é\nü\n日本\n語\n😀!\n'],
  ['whitespace-only edit against a disjoint edit', text(ten), text(edit(ten, 1, 1, 'line 2 \n')), text(edit(ten, 7, 1, 'EIGHT\n'))],
  ['whitespace-only edits that differ', text(ten), text(edit(ten, 1, 1, 'line 2 \n')), text(edit(ten, 1, 1, 'line 2\t\n'))],
  ['a long line', 'a\n' + 'x'.repeat(100_000) + '\nb\n', 'A\n' + 'x'.repeat(100_000) + '\nb\n', 'a\n' + 'x'.repeat(100_000) + '\nB\n'],
  ['a function edited in two places', 'function f() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n',
    'function f() {\n  const a = 10;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n', 'function f() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a * b * c;\n}\n'],
];

test('mergeText matches git merge-file on hand-written cases', { skip }, t => {
  const git = gitMergeFile(t), outcomes = { clean: 0, conflict: 0 };
  for (const [name, base, ours, theirs] of handWritten) {
    outcomes[agree(git, name, base, ours, theirs)]++;
    // Swapping the sides gives the same outcome (the merged lines may be ordered differently).
    outcomes[agree(git, name + ' (swapped)', base, theirs, ours)]++;
  }
  assert.ok(outcomes.clean >= 40 && outcomes.conflict >= 30, JSON.stringify(outcomes));
  // Git conflicts on edits of adjacent lines; one unchanged line between them is enough to merge.
  assert.equal(mergeText(bytes(text(ten)), bytes(text(edit(ten, 3, 1, 'FOUR\n'))), bytes(text(edit(ten, 4, 1, 'FIVE\n')))).conflict, true);
  assert.equal(new TextDecoder().decode(mergeText(bytes(text(ten)), bytes(text(edit(ten, 3, 1, 'FOUR\n'))), bytes(text(edit(ten, 5, 1, 'SIX\n')))).merged),
    text(edit(edit(ten, 3, 1, 'FOUR\n'), 5, 1, 'SIX\n')));
  assert.deepEqual(mergeText(bytes(text(ten)), bytes(text(edit(ten, 5, 1, 'ours\n'))), bytes(text(edit(ten, 5, 1, 'theirs\n')))),
    { conflict: true, reason: 'both_modified', hunks: [{ baseStart: 5, baseEnd: 6, oursStart: 5, oursEnd: 6, theirsStart: 5, theirsEnd: 6 }] });
});

test('mergeText matches git merge-file on generated edits around one another', { skip }, t => {
  const git = gitMergeFile(t), rand = random(6), base = lines(30), outcomes = { clean: 0, conflict: 0 };
  // Every pair of one-line edits (replace, insert, delete) at positions up to three lines apart.
  const kinds = [(list, at) => edit(list, at, 1, `ours ${at}\n`), (list, at) => edit(list, at, 0, `new ${at}\n`), (list, at) => edit(list, at, 1)];
  for (const [k1, first] of kinds.entries()) for (const [k2, second] of kinds.entries()) for (let gap = -1; gap <= 3; gap++) {
    const at = 10 + rand(5), ours = first(base, at), theirs = k1 === k2 && gap === 0 ? first(base, at) : second(base, at + gap).map(line => line.replace('ours', 'theirs'));
    outcomes[agree(git, `kinds ${k1}/${k2} gap ${gap}`, text(base), text(ours), text(theirs))]++;
  }
  // Blocks of edits of random size and distance, with LF, CRLF and a missing final newline.
  for (let round = 0; round < 120; round++) {
    const ending = ['\n', '\r\n'][rand(2)], list = lines(20 + rand(40)).map(line => line.replace('\n', ending));
    const change = (side, at) => { const out = [...list]; out.splice(at, rand(4), ...Array.from({ length: rand(4) }, (_, i) => `${side} ${round}.${i}${ending}`)); return out; };
    const at = rand(list.length), ours = change('ours', at), theirs = change('theirs', Math.max(0, at + rand(9) - 4)), cut = rand(4) === 0 ? open : s => s;
    outcomes[agree(git, `block round ${round}`, cut(text(list)), cut(text(ours)), cut(text(theirs)))]++;
  }
  assert.ok(outcomes.clean >= 40 && outcomes.conflict >= 40, JSON.stringify(outcomes));
});

test('mergeText matches git merge-file on random edits (fixed seed)', { skip }, t => {
  const git = gitMergeFile(t), rand = random(20261015), outcomes = { clean: 0, conflict: 0 };
  // Small alphabets make many equal lines, so the diff's choice among equally short alignments matters.
  for (let round = 0; round < 400; round++) {
    const alphabet = 2 + rand(6), line = () => `l${rand(alphabet + 2)}${rand(8) ? '\n' : '\r\n'}`;
    const base = Array.from({ length: rand(25) }, line);
    const mutate = () => {
      const out = [...base];
      for (let k = rand(5); k > 0; k--) { const at = rand(out.length + 1), op = rand(3); if (op === 0) out.splice(at, 0, line()); else if (op === 1) out.splice(at, 1); else if (at < out.length) out[at] = line(); }
      return out;
    };
    const cut = rand(5) === 0 ? open : s => s;
    outcomes[agree(git, `random round ${round}`, cut(text(base)), cut(text(mutate())), cut(text(mutate())))]++;
  }
  assert.ok(outcomes.clean >= 100 && outcomes.conflict >= 50, JSON.stringify(outcomes));
});

test('mergeText matches git merge-file where the diff hits its cost limits', { skip }, t => {
  const git = gitMergeFile(t), rand = random(77), outcomes = { clean: 0, conflict: 0 };
  // Heavy churn in the first and last thirds of long files: edit costs above 256 use git's diagonal heuristics.
  for (let round = 0; round < 12; round++) {
    const size = 1500 + rand(2500), alphabet = [8, 60, size][round % 3], line = () => `x${rand(alphabet)}\n`, base = Array.from({ length: size }, line);
    const churn = (from, to) => base.flatMap((item, i) => i >= from && i < to && rand(100) < 50 ? [[line(), item], [], [line()]][rand(3)] : [item]);
    const third = Math.floor(size / 3);
    outcomes[agree(git, `churn round ${round}`, text(base), text(churn(0, third)), text(churn(2 * third + rand(50), size)))]++;
  }
  assert.ok(outcomes.clean >= 6, JSON.stringify(outcomes));
});

test('mergeText near its bounds: 50,000 lines merge like git, beyond the bounds is too large', { skip }, t => {
  const git = gitMergeFile(t), base = Array.from({ length: textMergeLimits.lines }, (_, i) => `${i}\n`);
  assert.equal(agree(git, 'at the line limit', text(base), text(edit(base, 100, 1, 'ours\n')), text(edit(base, 49_000, 1, 'theirs\n'))), 'clean');
  assert.equal(agree(git, 'at the line limit, conflicting', text(base), text(edit(base, 100, 1, 'ours\n')), text(edit(base, 100, 1, 'theirs\n'))), 'conflict');
  const tooMany = text([...base, 'one more\n']);
  assert.deepEqual(mergeText(bytes(text(base)), bytes(tooMany), bytes(text(base))), { conflict: true, reason: 'too_large_to_merge', hunks: [] });
  // Exactly 1 MiB on every side merges; one byte more is too large.
  const row = 'y'.repeat(1023) + '\n', big = row.repeat(1024), first = 'a'.repeat(1023) + '\n', last = 'z'.repeat(1023) + '\n';
  assert.equal(big.length, textMergeLimits.bytes);
  assert.equal(agree(git, 'at the byte limit', big, first + row.repeat(1023), row.repeat(1023) + last), 'clean');
  assert.equal(mergeText(bytes(big), bytes(big + 'x'), bytes(big)).reason, 'too_large_to_merge');
});

test('mergeText does not merge binary files or invalid UTF-8; git binary probe is the first 8000 bytes', { skip }, t => {
  const git = gitMergeFile(t), nul = new Uint8Array([97, 0, 98, 10]);
  assert.deepEqual(mergeText(nul, bytes('a\n'), bytes('b\n')), { conflict: true, reason: 'binary', hunks: [] });
  assert.equal(mergeText(bytes('a\n'), bytes('a\n'), new Uint8Array([0])).reason, 'binary');
  assert.notEqual(git(nul, 'a\n', 'b\n').status, 0);
  // A NUL after the probe is text to git and to mergeText.
  const late = text(lines(1000)) + '\0\n';
  assert.ok(late.length > textMergeLimits.binaryProbe);
  assert.equal(agree(git, 'NUL after the probe', late, 'top\n' + late, late + 'end\n'), 'clean');
  // Deliberate difference: git merges Latin-1 or other non-UTF-8 text; mergeText reports it as binary.
  const latin1 = new Uint8Array([...bytes('caf'), 0xe9, 10, ...bytes('b\nc\n')]), ours = new Uint8Array([...latin1, ...bytes('d\n')]), theirs = new Uint8Array([...bytes('A\n'), ...latin1]);
  assert.equal(git(latin1, ours, theirs).status, 0);
  assert.equal(mergeText(latin1, ours, theirs).reason, 'binary');
  assert.throws(() => mergeText('a', 'b', 'c'), TypeError);
});
