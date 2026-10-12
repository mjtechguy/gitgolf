import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultBranchAdvertisement,packetLine,advertisedRefs} from './src/git.mjs';
const main='a'.repeat(40),next='b'.repeat(40);
const advertisement=lines=>new Uint8Array(Buffer.concat([packetLine('# service=git-upload-pack\n'),Buffer.from('0000'),...lines.map(packetLine),Buffer.from('0000')]));
test('Golf default branch replaces provider HEAD and symref while preserving refs and capabilities',()=>{
 const raw=advertisement([main+' HEAD\0multi_ack symref=HEAD:refs/heads/main object-format=sha1\n',main+' refs/heads/main\n',next+' refs/heads/next\n',main+' refs/notes/commits\n',next+' refs/tags/v1^{}\n']);
 const changed=defaultBranchAdvertisement(raw,'next'),text=new TextDecoder().decode(changed);
 assert.ok(text.includes(next+' HEAD\0'));assert.ok(text.includes(main+' refs/heads/main'));assert.ok(text.includes(next+' refs/heads/next'));
 assert.ok(text.includes(main+' refs/notes/commits'));assert.ok(text.includes(next+' refs/tags/v1^{}'));
 assert.ok(text.includes('multi_ack object-format=sha1 symref=HEAD:refs/heads/next'));assert.equal(text.includes('symref=HEAD:refs/heads/main'),false);
 assert.deepEqual(defaultBranchAdvertisement(changed,'next'),changed);
});
test('missing and unborn defaults are not advertised as another branch',()=>{
 const raw=advertisement([main+' HEAD\0symref=HEAD:refs/heads/main\n',main+' refs/heads/main\n']);
 const changed=defaultBranchAdvertisement(raw,'missing');assert.equal(advertisedRefs(changed).has('HEAD'),false);assert.ok(new TextDecoder().decode(changed).includes('symref=HEAD:refs/heads/missing'));
 const empty=defaultBranchAdvertisement(advertisement([]),'main');assert.ok(new TextDecoder().decode(empty).includes('capabilities^{}'));assert.equal(advertisedRefs(empty).size,0);
});
test('malformed advertisements and invalid branch names fail closed',()=>{
 for(const branch of ['../main','main.lock',''])assert.throws(()=>defaultBranchAdvertisement(advertisement([]),branch));
 for(const raw of [new Uint8Array(),advertisement(['garbage\n']),advertisement([main+' refs/heads/main\0one\0two\n']),new Uint8Array([...advertisement([]),1])])assert.throws(()=>defaultBranchAdvertisement(raw,'main'));
});
