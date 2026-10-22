/**
 * Round 60: client integrity contracts (templates, SW, crypto worker, verify).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'app/static/sw.js'), 'utf8');
const cryptoJs = fs.readFileSync(path.join(root, 'app/static/js/crypto.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');
const authHead = fs.readFileSync(path.join(root, 'app/templates/partials/auth-head.html'), 'utf8');

assert.ok(fs.existsSync(path.join(root, 'scripts/build-client-manifest.py')));
assert.ok(fs.existsSync(path.join(root, '.python-version')));
assert.ok(fs.existsSync(path.join(root, '.nvmrc')));
assert.ok(fs.existsSync(path.join(root, 'requirements.lock')));
assert.ok(fs.existsSync(path.join(root, 'deploy/github-workflows/client-integrity.yml')));
assert.ok(fs.existsSync(path.join(root, 'deploy/github-workflows/release-client.yml')));

assert.ok(appHtml.includes("asset_script('js/app.js')"));
assert.ok(appHtml.includes("asset_stylesheet('css/app.css')"));
assert.ok(appHtml.includes('name="notes-client-hash"'));
assert.ok(appHtml.includes('name="notes-crypto-worker"'));
assert.ok(appHtml.includes('id="settings-about"'));
assert.ok(appHtml.includes('id="about-client-hash"'));
assert.ok(appHtml.includes('about-release-link'));
assert.ok(!appHtml.includes('/static/js/app.js?v={{ build }}'));

assert.ok(authHead.includes('notes-client-hash'));
assert.ok(authHead.includes("asset_stylesheet('css/app.css')"));

assert.ok(cryptoJs.includes('notes-crypto-worker'));
assert.ok(appJs.includes('prefetchShellAssets'));
assert.ok(appJs.includes('/static\\/[^"]+\\.(?:css|js|mjs)'));

assert.ok(sw.includes('Keep this file byte-stable'));
assert.ok(sw.includes('[a-f0-9]{16}'));
assert.ok(!/NOTES_BUILD|__NOTES_BUILD__|const BUILD\s*=/.test(sw));

assert.ok(appPy.includes('client_assets'));
assert.ok(appPy.includes('client_hash'));
assert.ok(appPy.includes('_serve_hashed_static'));

assert.ok(verify.includes('cosign verify-blob'));
assert.ok(verify.includes('build-client-manifest.py'));
assert.ok(verify.includes('manifest_sha256'));
assert.ok(!verify.includes('Placeholder for Round 60'));
assert.ok(!/<script[\s>]/i.test(verify), '/verify must stay script-free');

// Dual-build repro (SOURCE_DATE_EPOCH pinned).
const out = execFileSync(
  process.env.PYTHON || 'python3',
  [path.join(root, 'scripts/build-client-manifest.py'), '--check-repro'],
  { cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: '0' }, encoding: 'utf8' },
);
assert.ok(out.includes('repro check ok'), out);

// Release workflow must be keyless (no secrets).
const releaseYml = fs.readFileSync(
  path.join(root, 'deploy/github-workflows/release-client.yml'),
  'utf8',
);
assert.ok(releaseYml.includes('id-token: write'));
assert.ok(releaseYml.includes('cosign sign-blob'));
assert.ok(!/secrets\.[A-Z0-9_]+/.test(releaseYml.replace(/GITHUB_TOKEN/g, '')));

console.log('test_round60_client_integrity ok');
