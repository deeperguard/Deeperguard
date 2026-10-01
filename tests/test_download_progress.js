const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseVaultSyncProgressMessage,
  syncBannerProgressText,
} = require('../app/static/js/vault-sync-progress.js');

assert.deepStrictEqual(parseVaultSyncProgressMessage(''), {
  pct: null,
  done: null,
  total: null,
  isDownload: false,
});
assert.deepStrictEqual(parseVaultSyncProgressMessage('Downloading notes… 42%'), {
  pct: 42,
  done: null,
  total: null,
  isDownload: true,
});
assert.deepStrictEqual(parseVaultSyncProgressMessage('Sync (3/10) · 30%'), {
  pct: 30,
  done: 3,
  total: 10,
  isDownload: false,
});

assert.strictEqual(
  syncBannerProgressText('Downloading notes… 55%', 'Downloading notes…'),
  'Downloading notes… 55%',
);
assert.strictEqual(
  syncBannerProgressText('Sync (2/5) · 40%', 'Downloading notes…'),
  'Downloading notes… 2 / 5 · 40%',
);

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app', 'templates', 'app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'app.js'), 'utf8');

assert.ok(html.includes('id="sync-status-progress"'));
assert.ok(html.includes('id="sync-status-progress-track"'));
assert.ok(html.includes('id="sync-status-progress-bar"'));
assert.ok(html.includes('id="file-download-progress"'));
assert.ok(html.includes('aria-modal="true"'));
assert.ok(html.includes('id="file-download-progress-track"'));
assert.ok(html.includes('id="file-download-progress-bar"'));

const reloadBlock = appJs.slice(
  appJs.indexOf("document.getElementById('btn-reload-notes')"),
  appJs.indexOf("document.getElementById('btn-copy-diagnostics')"),
);
assert.ok(reloadBlock.includes('syncNow({ full: true, force: true })'));
assert.ok(reloadBlock.includes('btn-reload-notes'));
assert.ok(appJs.includes("toast('Download already in progress', true)"));
assert.ok(appJs.includes('openFileDownloadOverlayA11y'));
assert.ok(appJs.includes('closeFileDownloadOverlayA11y'));
assert.ok(appJs.includes('app.inert = true'));

const vaultSrc = html.indexOf('/static/js/vault-sync-progress.js');
const appSrc = html.indexOf('/static/js/app.js');
assert.ok(vaultSrc > 0 && vaultSrc < appSrc);

console.log('ok');
