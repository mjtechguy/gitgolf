import { expect, test } from '@playwright/test';
import { parseDiff, splitLines } from '../src/diff';
import { sourceLanguage } from '../src/sourceLanguage';

test('maps old/new lines without treating source content as file headers', () => {
  const text = 'commit abc\n\ndiff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,3 @@\n keep\n-old\n+++ b/forged.py\n+new\n\\ No newline at end of file\n';
  const parsed = parseDiff(text);
  expect(parsed.preamble).toBe('commit abc');
  expect(parsed.files).toHaveLength(1);
  const file = parsed.files[0]!;
  expect(file.path).toBe('a.py'); expect(file.valid).toBe(true);
  expect(file.additions).toBe(2); expect(file.deletions).toBe(1);
  expect(file.hunks[0]!.lines).toEqual([
    {kind:'context',text:'keep',old:1,next:1}, {kind:'delete',text:'old',old:2},
    {kind:'add',text:'++ b/forged.py',next:2}, {kind:'add',text:'new',next:3},
    {kind:'notice',text:'\\ No newline at end of file'},
  ]);
  expect(splitLines(file.hunks[0]!.lines)[1]).toEqual({left:{kind:'delete',text:'old',old:2},right:{kind:'add',text:'++ b/forged.py',next:2}});
});

test('handles quoted UTF-8 paths, renames, zero ranges, deleted files and binary metadata', () => {
  const text = 'diff --git "a/\\344\\270\\226\\347\\225\\214.txt" "b/\\344\\270\\226\\347\\225\\214.txt"\n--- /dev/null\n+++ "b/\\344\\270\\226\\347\\225\\214.txt"\n@@ -0,0 +1 @@\n+hello\ndiff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\ndiff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\ndiff --git a/logo b/logo\nBinary files a/logo and b/logo differ\n';
  const files = parseDiff(text).files;
  expect(files.map((file)=>file.path)).toEqual(['世界.txt','new name','gone','logo']);
  expect(files.every((file)=>file.valid)).toBe(true);
  expect(files[0]!.hunks[0]!.lines[0]).toEqual({kind:'add',text:'hello',next:1});
  expect(files[1]!.oldPath).toBe('old name');
  expect(files[2]!.hunks[0]!.lines[0]).toEqual({kind:'delete',text:'bye',old:1});
  expect(files[3]!.binary).toBe(true);
});

test('refuses fabricated line mapping for malformed hunk counts and preserves native text', () => {
  for(const body of ['@@ -1,2 +1,2 @@\n only one\n','@@ -1 +1 @@\n+extra\n+overflow\n','@@@ combined diff\n+text\n']) {
    const text='diff --git a/a b/a\n--- a/a\n+++ b/a\n'+body;
    const file=parseDiff(text).files[0]!;
    if(body.startsWith('@@ ')) expect(file.valid).toBe(false);
    else expect(file.hunks).toHaveLength(0);
    expect(file.raw).toBe(text);
  }
});

test('source language mapping treats unknown and prototype-named files as plain text',()=>{
 for(const path of ['constructor','__proto__','src/constructor','src/file.__proto__','src/file.constructor','unknown.ext'])expect(sourceLanguage(path)).toBe('');
 expect(sourceLanguage('src/example.TS')).toBe('typescript');expect(sourceLanguage('build/Dockerfile')).toBe('dockerfile');expect(sourceLanguage('blog.py')).toBe('python');
});


test('native empty side-header delimiters preserve Unicode identities, indices and source whitespace',()=>{
 const path='src/context ü.txt';
 const first='diff --git a/first b/first\n--- a/first\n+++ b/first\n@@ -1 +1 @@\n-old\n+new\n';
 const native=`diff --git a/${path} b/${path}\n--- a/${path}\t\n+++ b/${path}\t\n@@ -1,2 +1,2 @@\n-old\t \n+new \t\n context \t\n@@ -10 +12 @@\n-later\n+last\n`;
 const files=parseDiff(first+native).files;expect(files).toHaveLength(2);const file=files[1]!;
 expect(file.valid).toBe(true);expect(file.oldPath).toBe(path);expect(file.path).toBe(path);expect(file.raw).toBe(native);
 expect(file.hunks[0]!.lines).toEqual([{kind:'delete',text:'old\t ',old:1},{kind:'add',text:'new \t',next:1},{kind:'context',text:'context \t',old:2,next:2}]);
 expect(file.hunks[1]!.lines).toEqual([{kind:'delete',text:'later',old:10},{kind:'add',text:'last',next:12}]);
 for(const suffix of ['\t\t','\t2026-10-03 12:00:00','\tother/path','\t ','\t\r','\tother/path\t'])for(const side of ['--- a/','+++ b/']){
  const malformed=native.replace(side+path+'\t\n',side+path+suffix+'\n');const parsed=parseDiff(first+malformed).files;
  expect(parsed).toHaveLength(2);expect(parsed[1]!.valid).toBe(false);expect(parsed[1]!.raw).toBe(malformed);expect(parsed[0]!.valid).toBe(true);
 }
 expect(parseDiff('diff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\t\n@@ -1 +0,0 @@\n-old\n').files[0]!.valid).toBe(false);
 // Existing quoted control bytes remain literal decoded bytes, not delimiters.
 const quoted=parseDiff('diff --git "a/control\\t" "b/control\\t"\n--- "a/control\\t"\n+++ "b/control\\t"\n@@ -1 +1 @@\n-old\n+new\n').files[0]!;
 expect(quoted.oldPath).toBe('control\t');expect(quoted.path).toBe('control\t');
});
