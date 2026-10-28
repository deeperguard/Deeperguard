const assert = require('assert');
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'fixtures', 'photo-ocr', 'beta-fail-pass.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.ok(Array.isArray(manifest) && manifest.length >= 2, 'beta fail-pass manifest should list fixtures');
for (const entry of manifest) {
  assert.ok(entry.id && entry.file, 'fixture needs id and file');
  assert.ok(Array.isArray(entry.search_tokens) && entry.search_tokens.length === 4, `${entry.id} needs four search tokens`);
  const filePath = path.join(__dirname, 'fixtures', 'photo-ocr', entry.file);
  assert.ok(fs.statSync(filePath).size > 10_000, `${entry.file} should be a real JPEG`);
  assert.ok(entry.pass_rule && String(entry.pass_rule).includes('v0.65.28'), `${entry.id} should document v0.65.28 fail rule`);
}

console.log('ok');
