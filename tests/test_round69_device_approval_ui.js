/**
 * Round 69: Feature C UI follow-ups (banner, offline verify, enter-code field).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const freshnessJs = fs.readFileSync(path.join(root, 'app/static/js/freshness.js'), 'utf8');

// --- Banner placement: notes area (list-pane), not sidebar ---
const listPaneIdx = appHtml.indexOf('class="list-pane list-toolbar"');
const bannerIdx = appHtml.indexOf('id="device-start-banner"');
const sidebarScrollIdx = appHtml.indexOf('id="sidebar-scroll"');
assert.ok(listPaneIdx > 0 && bannerIdx > 0);
assert.ok(bannerIdx > listPaneIdx, 'banner must live inside the notes list pane');
assert.ok(bannerIdx < appHtml.indexOf('id="sync-status-banner"'), 'banner sits above sync status in notes area');
assert.ok(sidebarScrollIdx > 0 && bannerIdx > sidebarScrollIdx, 'banner is after sidebar markup closes into list pane');
assert.ok(!/id="sidebar-scroll"[\s\S]{0,400}id="device-start-banner"/.test(appHtml), 'banner must not sit inside sidebar-scroll');

// --- Banner copy + Later skip ---
assert.ok(appHtml.includes('New device: check it has your latest notes.'));
assert.ok(appHtml.includes('>Verify now<'));
assert.ok(appHtml.includes('>Later<'));
assert.ok(appJs.includes("toast('Later — this device stays labeled Unverified start.')"));
assert.ok(appJs.includes('skipStartVerification'));

// --- Banner Verify opens same flow offline (openSettings, not missing btn-settings) ---
const showVerify = appJs.slice(
  appJs.indexOf('function showVerifyDeviceStartPanel'),
  appJs.indexOf('function setDeviceStartCodeError'),
);
assert.ok(showVerify.includes('openSettings'), 'banner Verify must open Settings locally');
assert.ok(!showVerify.includes("getElementById('btn-settings')"), 'must not click missing #btn-settings');
assert.ok(showVerify.includes('verify-device-start-panel'));

// --- Button role labels ---
assert.ok(appHtml.includes('On a trusted device: Show a code'));
assert.ok(appHtml.includes('On your new device: Enter a code'));

// --- Approval panel ---
assert.ok(appHtml.includes('Scan this on your new device. The code holds only a version number and a fingerprint, never your keys or notes.'));
assert.ok(appHtml.includes('Scan the QR code'));
assert.ok(appHtml.includes('id="btn-approve-new-device-copy"'));
assert.ok(appHtml.includes('>Copy code<'));
assert.ok(appCss.includes('.approve-new-device-code'));
assert.ok(appCss.includes('ui-monospace') || appCss.includes('SFMono-Regular'));
assert.ok(appJs.includes('copyApproveNewDeviceCode'));

// --- Enter code: on-page input, paste/dashes, field errors ---
assert.ok(appHtml.includes('id="device-start-code-input"'));
assert.ok(appHtml.includes('id="device-start-code-error"'));
assert.ok(appHtml.includes('XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX'));
assert.ok(appJs.includes('function normalizeDeviceStartCode'));
assert.ok(appJs.includes("replace(/[\\s-]+/g, '')"));
assert.ok(appJs.includes('function submitDeviceStartCode'));
assert.ok(appJs.includes('fromCodeField'));
assert.ok(appJs.includes("result.error === 'checksum'"));
assert.ok(appJs.includes("result.error === 'version'"));
assert.ok(appJs.includes('Reconnect, then get a fresh code from your other device.'));
assert.ok(!appJs.includes("window.prompt('Enter the short approval code"), 'native prompt removed');

// --- Settings status: chip + technical details + state-aware explainer ---
assert.ok(appHtml.includes('id="vault-freshness-chip"'));
assert.ok(appHtml.includes('id="vault-freshness-tech"'));
assert.ok(appHtml.includes('Technical details'));
assert.ok(appHtml.includes('id="vault-freshness-explainer"'));
assert.ok(appJs.includes("chip.textContent = 'Not verified yet'"));
assert.ok(appJs.includes("chip.textContent = 'Verified'"));
assert.ok(appJs.includes('function deviceStartExplainer'));
assert.ok(appJs.includes("startLabel.textContent = 'Unverified start'"));
assert.ok(appJs.includes('This device’s start is verified'));
assert.ok(appJs.includes('labeled Unverified start'));

// --- Success check mark; toast must not cover device list on success ---
assert.ok(freshnessJs.includes('This device is up to date with your other device.'));
assert.ok(appJs.includes('✓ ${message}') || appJs.includes('✓ '));
assert.ok(appJs.includes('if (!result.ok)') && appJs.includes('toast(result.message'));
assert.ok(appCss.includes('body.settings-open #toast'));

// --- Mobile banner layout ---
assert.ok(appCss.includes('@media (max-width: 430px)'));
assert.ok(appCss.includes('.device-start-banner-actions'));

// --- Online event still triggers sync (and no longer gates on pushDirty ok) ---
const onlineBlock = storeJs.slice(
  storeJs.indexOf("onOnline.call(window, 'online'"),
  storeJs.indexOf("onOnline.call(window, 'online'") + 450,
);
assert.ok(onlineBlock.includes("sync({ quiet: true })"));
assert.ok(!/then\(\(ok\) => \(ok \? sync\(\)/.test(onlineBlock), 'must not skip pull when pushDirty fails');

// --- MUST NOT REGRESS Feature A/C strings ---
assert.ok(freshnessJs.includes('The server returned an older version of this item.'));
assert.ok(freshnessJs.includes('The server gave this device an older version of your vault than your other device has'));
assert.ok(freshnessJs.includes('encodeAnchorPayload'));
assert.ok(freshnessJs.includes('verifyAnchor'));
assert.ok(freshnessJs.includes('skipStartVerification'));

console.log('test_round69_device_approval_ui ok');
