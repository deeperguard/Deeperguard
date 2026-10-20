const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const progressJs = fs.readFileSync(path.join(root, 'app/static/js/vault-sync-progress.js'), 'utf8');

// Delayed compact overlay — not an immediate tall inline block.
assert.ok(appJs.includes('const SYNC_PROGRESS_BANNER_DELAY_MS = 2000'));
assert.ok(appJs.includes('function armDelayedSyncProgressBanner'));
assert.ok(appJs.includes('function cancelDelayedSyncProgressBanner'));
assert.ok(appJs.includes('function resetSyncProgressBannerState'));

// Routine non-full sync must not open the downloading banner up front.
const syncNowStart = appJs.split('if (isVaultReadyForSync()) setBusy(true);')[1]
  .split('syncInFlight = NotesStore.loadAccount()')[0];
assert.ok(syncNowStart.includes('if (full)'));
assert.ok(syncNowStart.includes('armDelayedSyncProgressBanner'));
assert.ok(!/showSyncBanner\(\s*'downloading'/.test(syncNowStart));

// beginVaultPull arms the delayed overlay instead of showing a tall block immediately.
const beginPull = appJs.split('function beginVaultPull(expectedTotal = 0)')[1]
  .split('function endVaultPull()')[0];
assert.ok(beginPull.includes('armDelayedSyncProgressBanner'));
assert.ok(!/showSyncBanner\(\s*'downloading'/.test(beginPull));

// Overlay CSS: downloading mode reserves no layout height.
const downloadingRule = css.split('.sync-status-banner[data-mode="downloading"] {')[1].split('}')[0];
assert.ok(downloadingRule.includes('height: 0 !important'));
assert.ok(downloadingRule.includes('max-height: 0 !important'));
assert.ok(downloadingRule.includes('overflow: visible !important'));
assert.ok(css.includes('max-height: 44px'));

// Progress copy is determinate and note-oriented.
assert.ok(progressJs.includes('Downloading ${shown} of ${expected} notes'));
assert.ok(progressJs.includes('(\\d+)\\s+of\\s+(\\d+)'));

// Quiet sync → Synced HH:MM path must remain (round 24/25).
assert.ok(appJs.includes('Synced ${when}'));
assert.ok(appJs.includes("captions[phase] || 'Sync'"));

console.log('test_round31b_ui ok');
