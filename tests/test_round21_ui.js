const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { install } = require('./domstub.js');

install();

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const previewSrc = fs.readFileSync(path.join(root, 'app/static/js/preview.js'), 'utf8');
const { visiblePdfTile, pageBitmapScale } = require('../app/static/js/preview.js');

// A reachable server that says the session is gone must not open the local vault.
const verify = appJs.slice(
  appJs.indexOf('async function verifyAndUnlock'),
  appJs.indexOf('let unlockErrorAnnounce'),
);
const dead = verify.slice(
  verify.indexOf('const err = serverResult.err'),
  verify.indexOf('if (!unlockPrimaryRevealed)'),
);
assert.ok(dead.includes('if (isLoginRequiredError(err)) throw sessionExpiredError()'));
assert.ok(
  dead.indexOf('if (isLoginRequiredError(err)) throw sessionExpiredError()')
    < dead.indexOf('repairUnlockWithPassword'),
);
assert.ok(
  dead.indexOf('throw sessionExpiredError()') < dead.indexOf('passwordProven = true'),
);
assert.ok(verify.includes('if (server?.err && isLoginRequiredError(server.err)) return'));
assert.ok(verify.includes('await revealPrimaryUnlock()'));
const failed = verify.slice(
  verify.indexOf('if (localAllFailed)'),
  verify.indexOf('const hasLocalVault'),
);
assert.ok(
  failed.indexOf('if (isLoginRequiredError(serverResult.err))')
    < failed.indexOf('repairUnlockWithPassword'),
);
assert.ok(failed.includes('if (repaired.sessionExpired)'));
assert.ok(failed.includes('throw sessionExpiredError()'));

const repair = appJs.slice(
  appJs.indexOf('async function repairUnlockWithPassword'),
  appJs.indexOf('async function establishServerSessionAfterVaultUnlock'),
);
assert.ok(repair.indexOf('isLoginRequiredError(err)') < repair.indexOf('wrongPassword: true'));
assert.ok(repair.includes('sessionExpired: true'));

assert.ok(appJs.includes('let sessionExpiredHold = false'));
assert.ok(appJs.includes("showSyncBanner('session', 'Not syncing — sign in again')"));
assert.ok(appJs.includes("meta.textContent = sessionExpiredHold"));
assert.ok(appJs.includes('if (sessionExpiredHold) return'));
assert.ok(html.includes('id="unlock-session-signin"'));
assert.ok(html.includes('id="sync-status-signin"'));
assert.ok(html.includes('Sign in again'));
assert.ok(appJs.includes('function armExpiredLoginLinks'));
assert.ok(appJs.includes("params.set('reason', 'session-expired')"));

// Visible PDF region stays at least 2× backing/CSS at 100%, 200% and 400%.
global.devicePixelRatio = 1;
const bitmap = pageBitmapScale();
assert.ok(bitmap >= 2);
const pdfWidth = 595.28;
const pdfHeight = 841.89;
for (const zoom of [1, 2, 4]) {
  const pageWidth = 1889 * zoom;
  const pageHeight = pageWidth * (pdfHeight / pdfWidth);
  const view = {
    left: pageWidth * 0.2,
    top: pageHeight * 0.15,
    width: Math.min(1200, pageWidth * 0.5),
    height: Math.min(800, pageHeight * 0.4),
  };
  const tile = visiblePdfTile(
    { left: 0, top: 0, width: pageWidth, height: pageHeight, pdfWidth, pdfHeight },
    view,
    bitmap,
  );
  assert.ok(tile.visualWidth > 0 && tile.visualHeight > 0, `zoom ${zoom}`);
  assert.ok(tile.backingWidth / tile.visualWidth >= 2, `width ratio at ${zoom * 100}%`);
  assert.ok(tile.backingHeight / tile.visualHeight >= 2, `height ratio at ${zoom * 100}%`);
  assert.ok(tile.backingWidth * tile.backingHeight <= 16000000, `pixels at ${zoom * 100}%`);
  assert.ok(tile.offsetX < 0 && tile.offsetY < 0, `clip offset at ${zoom * 100}%`);
}

const upgrade = previewSrc.slice(
  previewSrc.indexOf('async function upgradePdfQuality'),
  previewSrc.indexOf('function mimeFromMeta'),
);
assert.ok(upgrade.includes('paintPdfViewportTiles'));
assert.ok(upgrade.includes('offsetX: tile.offsetX') || previewSrc.includes('offsetX: tile.offsetX'));
assert.ok(previewSrc.includes('canvas.doc-page-tile'));
assert.ok(previewSrc.includes('schedulePdfViewportTiles'));
assert.ok(previewSrc.includes('onScroll(scale)'));

console.log('round21 ui ok');
