/**
 * Round 42 part 1: Drive not-configured visible+disabled by default,
 * restore dialog copy, restore toast counts, Back up / Restore grouping.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

// Drive: server-side disabled when not configured; not-configured visible by default.
assert.ok(appHtml.includes('google_drive_configured'));
assert.ok(/btn-backup-google-drive[\s\S]*?disabled/.test(appHtml) || appHtml.includes('if not google_drive_configured'));
assert.ok(
  appHtml.includes('Google Drive: Not set up yet')
  || appHtml.includes('Google Drive: Not configured on this server.'),
);
assert.ok(
  appJs.includes('Not set up yet — add your own key')
  || appJs.includes('Not configured on this server'),
);

// Restore dialog copy
assert.ok(appJs.includes("Add missing only"));
assert.ok(appJs.includes('never changes existing notes'));
assert.ok(!appJs.includes('Replace missing only'));
assert.ok(!appJs.includes('Replace skips items that already exist'));

// Restore outcome toast
assert.ok(appJs.includes('Restore complete:'));
assert.ok(appJs.includes('already up to date'));
assert.ok(appJs.includes('importResultToast(result, { restore: true })'));

// Store returns created/updated/unchanged
assert.ok(storeJs.includes('let created = 0'));
assert.ok(storeJs.includes('let updated = 0'));
assert.ok(storeJs.includes('let unchanged = 0'));
assert.ok(storeJs.includes('unchanged += 1'));

// Settings groups
assert.ok(appHtml.includes('>Back up</h4>') || appHtml.includes('>Back up<'));
assert.ok(appHtml.includes('Restore &amp; import') || appHtml.includes('Restore & import'));
assert.ok(appHtml.includes('Restore Deeperguard backup'));
assert.ok(appHtml.includes('Import from Standard Notes'));
assert.ok(appHtml.includes('.dgbackup'));
assert.ok(appHtml.includes('btn-save-backup-file'));
assert.ok(appHtml.includes('btn-backup-now'));
// Download encrypted vault kept as hidden alias (no functional regression).
assert.ok(appHtml.includes('btn-download-backup'));

console.log('test_round42_backups_polish ok');
