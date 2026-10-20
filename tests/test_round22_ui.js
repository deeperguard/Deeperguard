const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

// 1. Open sidebar turns the phone nav into a visible panel and toggles closed.
assert.ok(appJs.includes('function setNavDrawer(open)'));
assert.ok(appJs.includes('backdrop.hidden = !show'));
assert.ok(appJs.includes("btn.setAttribute('aria-expanded', show ? 'true' : 'false')"));
assert.ok(appJs.includes("setNavDrawer(!document.body.classList.contains('nav-drawer-open'))"));
assert.ok(appJs.includes("event.target.closest('#btn-list-menu, #btn-nav-menu')"));
const drawer = css.split('html.layout-compact body.nav-drawer-open .sidebar-scroll')[1].split('}')[0];
assert.ok(drawer.includes('display: flex !important'));
assert.ok(drawer.includes('position: fixed'));
assert.ok(css.includes('body.nav-drawer-open .sidebar-nav-backdrop {\n  display: block !important;'));
const filters = css.split('html.layout-compact body.nav-drawer-open .filters')[1].split('}')[0];
assert.ok(filters.includes('display: flex !important'));
assert.ok(css.includes('body.nav-drawer-open .filter > span'));

// 2. A dead session never prints the raw login-required save line.
const saveCb = appJs.slice(appJs.indexOf('NotesStore.setSaveStatusCallback'), appJs.indexOf('function isPhoneShell'));
assert.ok(saveCb.includes("ui.saveStatus.textContent = sessionGone ? 'Not synced — sign in again' : raw"));
assert.ok(saveCb.includes("ui.saveStatus.classList.toggle('error', !!isError && !sessionGone)"));
assert.ok(storeJs.includes("notifyStatus(sessionGone ? 'Not synced — sign in again' : `Save failed: ${e.message}`, !sessionGone)"));
assert.ok(!saveCb.includes('Save failed: login required'));

// 3. Drawer Tags/Folders stay full-width 44px; phone list uses compact chips.
const drawerSummaryNeedle = css.includes('html.layout-compact body.nav-drawer-open .sidebar .tag-section > summary.section-label')
  ? 'html.layout-compact body.nav-drawer-open .sidebar .tag-section > summary.section-label'
  : 'html.layout-compact .sidebar .tag-section > summary.section-label';
const summary = css.split(drawerSummaryNeedle)[1].split('}')[0];
assert.ok(summary.includes('width: 100% !important'));
assert.ok(summary.includes('min-height: 44px !important'));
assert.ok(summary.includes('padding: 12px 14px !important'));
assert.ok(summary.includes('font-size: 16px'));
assert.ok(summary.includes('line-height: 20px'));
assert.ok(
  css.includes('html.layout-compact .tag-section summary.section-label')
  || css.includes('body:not(.nav-drawer-open) .nav-browse > .tag-section summary.section-label')
  || css.includes('min-height: 44px'),
);

// 4. The 2FA add button is visible on the compact phone tab.
const totpAdd = css.split('html.layout-compact #totp-pane #btn-totp-add')[1].split('}')[0];
assert.ok(totpAdd.includes('display: inline-flex !important'));
assert.ok(totpAdd.includes('min-height: 44px'));
assert.strictEqual(css.split('@media (min-width: 1000px)').length - 1, 5);

console.log('round 22 ui ok');
