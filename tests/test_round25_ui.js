const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

// A quiet pull that actually fetched rows still marks the header synced.
assert.ok(store.includes('const quietPullTouched = (pull.processed || 0) > 0 || (dirtyAtStart > 0 && state.dirty.size === 0)'));
assert.ok(store.includes('const announceSync = !quiet || hasChanges || quietPullTouched'));
assert.ok(store.includes('} else if (announceSync) {'));

// Files is a view inside Notes, so the Notes tab stays the active app tab.
const tabs = appJs.split('function syncAppTabButtons')[1].split('function setAppTab')[0];
assert.ok(tabs.includes('const shown = normalizeAppTab(tab)'));
assert.ok(tabs.includes('btn.dataset.appTab === shown'));

// Folder selection and the phone view picker stay on the same folder.
assert.ok(appJs.includes('function syncFilterSelect()'));
assert.ok(appJs.includes("extra.dataset.folderOption = '1'"));
assert.ok(appJs.includes("if (filterSelect.value === 'folder') return"));

// Long folder titles stay on one line in the phone toolbar.
const phoneTitle = css.split('@media (max-width: 999px)')[1].split('@media (min-width: 1000px)')[0];
const titleRule = phoneTitle.split('.note-list-title {')[1].split('}')[0];
assert.ok(titleRule.includes('white-space: nowrap'));
assert.ok(titleRule.includes('text-overflow: ellipsis'));

// Compact editor shows the same sign-in banner the list uses.
assert.ok(html.includes('id="editor-sync-banner"'));
assert.ok(appJs.includes('function mirrorEditorSessionBanner'));
assert.ok(css.includes('.shell.editor-open #editor-sync-banner:not([hidden])'));
assert.ok(css.includes('html.layout-compact .shell.editor-open #editor-sync-banner:not([hidden])'));

// Opening the drawer locks the page scroll and keeps the space the panel left.
assert.ok(appJs.includes('function lockDrawerScroll()'));
assert.ok(appJs.includes('document.body.style.top = `-${navDrawerScrollY}px`'));
assert.ok(appJs.includes('function reserveDrawerFlow(panel)'));
assert.ok(appJs.includes("window.scrollTo(0, y)"));
assert.strictEqual(css.split('@media (min-width: 1000px)').length - 1, 5);

console.log('round 25 ui ok');
