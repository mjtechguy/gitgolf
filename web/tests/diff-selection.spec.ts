import { expect, test } from '@playwright/test';
import { parseDiff } from '../src/diff';
import { diffSelection } from '../src/diffSelection';

const prefix='diff-'+ 'a'.repeat(40),marker='#'+prefix+'-file-';
const patch='diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n last\n@@ -10 +10 @@\n-tenth\n+ten\n';

test('diff fragments bind canonical file indices and complete displayed single-hunk old/new ranges',()=>{
 const files=parseDiff(patch+patch).files;
 expect(diffSelection(marker+'1',prefix,files)).toEqual({fileIndex:1});
 expect(diffSelection(marker+'1-L1-L3',prefix,files)).toEqual({fileIndex:1,side:'old',first:1,last:3});
 expect(diffSelection(marker+'0-R10',prefix,files)).toEqual({fileIndex:0,side:'new',first:10,last:10});
 for(const suffix of ['01','2','-1','9007199254740992','0-R0','0-R01','0-R2147483648','0-L1-R3','0-R3-R1','0-R3-R10','0-R1-R4','0-R1junk','0-R1-R3-R4'])expect(diffSelection(marker+suffix,prefix,files),suffix).toBeUndefined();
 expect(diffSelection(marker+'0-R1',prefix+'other',files)).toBeUndefined();
 const repeated=parseDiff(patch.replace('@@ -10 +10 @@','@@ -1 +1 @@')).files;expect(diffSelection(marker+'0-R1-R3',prefix,repeated)).toBeUndefined();
 const invalid=parseDiff(patch.replace('@@ -1,3 +1,3 @@','@@ -1,4 +1,3 @@')).files;expect(diffSelection(marker+'0-R1',prefix,invalid)).toBeUndefined();
 expect(diffSelection(marker+'0',prefix,invalid)).toEqual({fileIndex:0});
});
