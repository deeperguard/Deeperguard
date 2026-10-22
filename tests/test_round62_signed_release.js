/**
 * Round 62: RELEASE_TAG points at a Sigstore-signed release.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tag = fs.readFileSync(path.join(root, 'RELEASE_TAG'), 'utf8').trim();
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const clientAssets = fs.readFileSync(path.join(root, 'app/client_assets.py'), 'utf8');

assert.ok(/^v0\.61\.\d+$/.test(tag) || tag.startsWith('v'), `unexpected RELEASE_TAG: ${tag}`);
assert.ok(verify.includes('release_signed'));
assert.ok(verify.includes('cosign verify-blob'));
assert.ok(!verify.includes('v0.60.0'));
assert.ok(clientAssets.includes('def release_is_signed'));
assert.ok(fs.existsSync(path.join(root, '.github/workflows/release-client.yml')));

console.log('test_round62_signed_release ok', tag);
