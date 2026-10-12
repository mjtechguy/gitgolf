import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddedAssets } from './release.mjs';

test('release retention parses only bounded embedded static manifests without executing bundle code', () => {
  const bundle = 'var define_GOLF_NATIVE_ASSETS_default = { "/native.html": { type: "text/html", content: "aGk=" }, "/assets/old-abcd1234.js": { type: "text/javascript", content: "aGk=" } };';
  assert.equal(embeddedAssets(bundle)['/assets/old-abcd1234.js'].content, 'aGk=');
  for (const invalid of [bundle.replace('old-abcd1234.js', '../private-abcd1234.js'), bundle.replace('"aGk="', 'process.exit()'), bundle.replace('"aGk="', '"not base64!"'), 'no manifest']) assert.throws(() => embeddedAssets(invalid));
});
