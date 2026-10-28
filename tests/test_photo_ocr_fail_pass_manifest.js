const assert = require('assert');
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'fixtures', 'photo-ocr', 'beta-fail-pass.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.ok(Array.isArray(manifest) && manifest.length >= 2, 'beta fail-pass manifest should list fixtures');
for (const entry of manifest) {
  assert.ok(entry.id && entry.file, 'fixture needs id and file');
  assert.ok(Array.isArray(entry.search_tokens) && entry.search_tokens.length >= 3);
  const filePath = path.join(__dirname, 'fixtures', 'photo-ocr', entry.file);
  assert.ok(fs.statSync(filePath).size > 10_000, `${entry.file} should be a real JPEG`);
  assert.ok(entry.v6528_max_recall < entry.enhanced_min_recall, `${entry.id} thresholds should encode fail→pass`);
}

console.log('ok');
