/**
 * Round 34b: phone Tags + Folders share one compact 44px chip row.
 * Expanded panel overlays (does not permanently push the NOTES header).
 * Desktop sidebar and drawer stay stacked/full-width.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

// Markup: shared browse wrapper + overlay panel hosts.
assert.ok(html.includes('id="nav-browse"'));
assert.ok(html.includes('class="nav-browse"'));
assert.ok(/id="tag-section"[\s\S]*?class="nav-browse-panel"/.test(html));
assert.ok(/id="folder-section"[\s\S]*?class="nav-browse-panel"/.test(html));
assert.ok(html.includes('id="btn-new-tag"'));
assert.ok(html.includes('id="btn-manage-tags"'));
assert.ok(html.includes('id="btn-new-folder"'));

// Phone chip row (not drawer).
assert.ok(css.includes('body:not(.nav-drawer-open) .nav-browse'));
assert.ok(css.includes('min-height: 44px'));
assert.ok(/body:not\(\.nav-drawer-open\) \.nav-browse > \.tag-section summary\.section-label[\s\S]*?min-height:\s*44px/.test(css)
  || css.includes('body:not(.nav-drawer-open) .nav-browse > .tag-section:not([open]) .section-label'));
assert.ok(css.includes('text-transform: none'));
assert.ok(css.includes('letter-spacing: 0'));

// Overlay panel under the chip row.
assert.ok(css.includes('.nav-browse-panel'));
assert.ok(css.includes('top: calc(44px + 6px)'));
assert.ok(css.includes('max-height: min(42dvh, 320px)'));

// Desktop unchanged: nav-browse is display:contents in the sidebar.
assert.ok(css.includes('.sidebar-nav .nav-browse'));
assert.ok(/\.sidebar-nav \.nav-browse \{[\s\S]*?display:\s*contents/.test(css));

// Drawer keeps full-width stacked sections.
assert.ok(css.includes('body.nav-drawer-open #sidebar-scroll > .nav-browse'));
assert.ok(css.includes('html.layout-compact body.nav-drawer-open .sidebar .tag-section'));

// Prefs + accordion still wired.
assert.ok(appJs.includes('prefs.tagsCollapsed'));
assert.ok(appJs.includes('prefs.foldersCollapsed'));
assert.ok(appJs.includes('only one browse panel open') || appJs.includes('folderSection.open = false'));

// Collapsed row height budget: one 44px chip row, not two stacked 44px rows.
const phoneBrowse = css.split('body:not(.nav-drawer-open) .nav-browse {')[1].split('body:not(.nav-drawer-open) .nav-browse > .tag-section,')[0];
assert.ok(phoneBrowse.includes('flex-direction: row') || css.includes('flex-direction: row'));
assert.ok(!/body:not\(\.nav-drawer-open\) \.nav-browse \{[^}]*flex-direction:\s*column/.test(css));

console.log('test_round34b_phone_browse ok');
