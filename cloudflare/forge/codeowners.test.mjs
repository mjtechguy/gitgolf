import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codeOwnerSuggestions} from './src/codeowners.mjs';

test('CODEOWNERS uses case-sensitive last-match globs, root paths and empty-owner overrides',()=>{
 const source='* @default\n*.ts @typescript\n/src/ @source\n/src/private\n/src/team/** @org/team @lead\n/docs/* @docs\n**/logs @logs';
 const paths=['index.ts','nested/file.ts','src/file.ts','src/private/file.ts','src/team/deep/file.ts','docs/readme.md','docs/deep/readme.md','build/logs/output','Index.TS'];
 assert.deepEqual(codeOwnerSuggestions(source,paths),{routingComplete:true,unsupportedRules:0,matches:[
  {path:'index.ts',owners:['@typescript']},{path:'nested/file.ts',owners:['@typescript']},{path:'src/file.ts',owners:['@source']},
  {path:'src/team/deep/file.ts',owners:['@org/team','@lead']},{path:'docs/readme.md',owners:['@docs']},
  {path:'docs/deep/readme.md',owners:['@default']},{path:'build/logs/output',owners:['@logs']},{path:'Index.TS',owners:['@default']}]});
});
test('CODEOWNERS supports directory rules, double-star zero-depth and single-character patterns',()=>{
 assert.deepEqual(codeOwnerSuggestions('assets/ @art\n/a/**/b?.txt @text', ['assets/icon.svg','other/assets/icon.svg','a/b1.txt','a/deep/b2.txt','a/deep/b22.txt','assets']).matches,[
  {path:'assets/icon.svg',owners:['@art']},{path:'other/assets/icon.svg',owners:['@art']},{path:'a/b1.txt',owners:['@text']},{path:'a/deep/b2.txt',owners:['@text']}]);
});
test('CODEOWNERS does not claim routing completeness for unsupported syntax or excessive work',()=>{
 for(const source of ['!src @x','[ab] @x','src user@example.com','a\\ b @x','a**b @x','../a @x','* @x\n'.repeat(201),'x'.repeat(16385),'x\0 @x']) {
  const result=codeOwnerSuggestions(source,['src/file']);assert.equal(result.routingComplete,false);assert.equal(result.matches.length,0);assert.ok(result.unsupportedRules>0);
 }
 assert.equal(codeOwnerSuggestions('# comment\n\n/src/ @team # note',['src/a']).matches[0].owners[0],'@team');
 const path='a'.repeat(4096)+'b';assert.deepEqual(codeOwnerSuggestions('*a*a*a*a*a*a*a*a*a*a*c @x',[path]).matches,[]);
});
