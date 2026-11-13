/**
 * Docs: revocation limits — honest wording, linked from README and SECURITY.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs/REVOCATION_LIMITS.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');

// Linked from README and SECURITY.md.
assert.ok(readme.includes('docs/REVOCATION_LIMITS.md'));
assert.ok(security.includes('docs/REVOCATION_LIMITS.md'));

// Core claims stay in the doc.
assert.ok(doc.includes('There is no offline lease'));
assert.ok(doc.includes('Nothing on the server is in that decryption path'));
assert.ok(doc.includes('Key rotation: not available'));
assert.ok(doc.includes('Remember password on this device'));

// No guarantee wording for clearing.
assert.ok(!/\bwiped\b/i.test(doc));
assert.ok(!/\berased\b/i.test(doc));

// Relative links in the doc resolve to real files.
const links = [...doc.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]);
for (const link of links) {
  if (/^https?:/.test(link)) continue;
  assert.ok(fs.existsSync(path.join(root, 'docs', link)), `missing link target: ${link}`);
}

console.log('test_revocation_limits_doc: ok');
