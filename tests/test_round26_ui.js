const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'app/static/sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const home = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const preview = fs.readFileSync(path.join(root, 'app/static/js/preview.js'), 'utf8');
const { render: superRender } = require('../app/static/js/superscript.js');

assert.ok(store.includes('function renameFolder(uuid, title)'));
assert.ok(store.includes('String(item.content?.title || \'\').trim().toLowerCase() === name.toLowerCase()'));
assert.ok(appJs.includes('function beginRenameFolder(uuid)'));
assert.ok(appJs.includes('data-folder-rename='));
assert.ok(appJs.includes('beginRenameFolder(btn.dataset.folderSelect)'));
assert.ok(appJs.includes("toast('A folder with that name already exists', true)"));
assert.ok(appJs.includes("toast('Enter a folder name', true)"));

assert.ok(css.includes('.tag-section.is-empty:not(#folder-section) > :not(summary):not(.tag-section-actions)'));

const placement = appJs.match(/function drawerPanelPlacement\(menuBox, sideBox, transformed, viewportHeight\) \{[\s\S]*?\n  \}/);
assert.ok(placement, 'drawer placement helper');
eval(placement[0]);
const lowMenu = drawerPanelPlacement(
  { top: 400, bottom: 444 },
  { top: 0, bottom: 556 },
  true,
  556,
);
assert.strictEqual(lowMenu.top, 0);
assert.ok(lowMenu.bottom > 8);
const phoneMenu = drawerPanelPlacement(
  { top: 40, bottom: 84 },
  { top: 0, bottom: 852 },
  true,
  852,
);
assert.ok(phoneMenu.top >= 84);
assert.strictEqual(phoneMenu.bottom, 0);
assert.ok(appJs.includes('panel.style.top'));
assert.ok(appJs.includes('panel.style.bottom'));
assert.ok(appJs.includes("panel.style.paddingTop = '8px'"));

const navFn = sw.split('async function networkFirstNavigate')[1].split('async function ')[0];
assert.ok(navFn.includes('if (fresh && fresh.status >= 400) return fresh;'));
assert.ok(navFn.includes('if (forced && forced.status >= 400) return forced;'));

assert.ok(home.includes('<a href="/download">Download</a>'));
assert.ok(home.includes('<a href="/contact">Contact</a>'));

assert.ok(css.includes('.tag-bar .tag-chip .tag-chip-label'));
assert.ok(css.includes('text-overflow: ellipsis'));
assert.ok(appJs.includes('class="tag-chip-label"'));
assert.ok(appJs.includes('function syncTagLimitHint(input)'));
assert.ok(appJs.includes('names stop at'));

const hoist = appJs.split('const hoistPinned = ')[1].split(';')[0];
assert.ok(hoist.includes("currentFilter !== 'trash'"));
assert.ok(hoist.includes("currentFilter !== 'archived'"));
assert.ok(appJs.includes('const hidePin = currentFilter === \'trash\' || currentFilter === \'archived\''));

assert.ok(appJs.includes('btn.hidden = total === 0'));
// Round 32: Empty trash stays visible (disabled) when trash is empty.
assert.ok(
  appJs.includes('settingsBtn.hidden = total === 0')
  || appJs.includes('settingsBtn.disabled = total === 0'),
);

assert.ok(html.includes('data-theme-opt="dark" aria-pressed="false"'));
assert.ok(appJs.includes("btn.setAttribute('aria-pressed', on ? 'true' : 'false')"));

const phoneTitle = css.split('@media (max-width: 999px)')[1].split('@media (min-width: 1000px)')[0];
const titleRule = phoneTitle.split('.note-list-title {')[1].split('}')[0];
assert.ok(titleRule.includes('white-space: nowrap'));
assert.ok(titleRule.includes('text-overflow: ellipsis'));
assert.ok(!titleRule.includes('max-width: 100%'));
assert.ok(css.includes('flex: 1 1 0%'));

const zoom = preview.split('function zoomBy(factor)')[1].split('function on(')[0];
assert.ok(zoom.includes('const clientX = rect.left'));
assert.ok(zoom.includes('const clientY = rect.top'));
assert.ok(!zoom.includes('clientWidth / 2'));
assert.ok(appJs.includes('Re-run OCR'));
assert.ok(appJs.includes('function attachmentOcrSucceeded(att)'));

assert.ok(appJs.includes("toastWithUndo('Attachment removed'"));

const devices = appJs.split('function renderSignedInDevices')[1].split('function stopSignedInDevicesRefresh')[0];
assert.ok(devices.includes('if (item.current)'));
assert.ok(!devices.includes('navigator.userAgent'));
assert.ok(!devices.includes('userAgent'));

assert.ok(appJs.includes('noteListSectionMs(file.note, sortMode)'));
assert.ok(appJs.includes('const editedMs = noteListSectionMs(note, sortMode)'));

const superHtml = superRender('_italic_ and __bold__ and foo_bar_baz');
assert.match(superHtml, /<em>italic<\/em>/);
assert.match(superHtml, /<strong>bold<\/strong>/);
assert.doesNotMatch(superHtml, /<em>bar<\/em>/);

assert.strictEqual(css.split('@media (min-width: 1000px)').length - 1, 5);

console.log('round 26 ui ok');
