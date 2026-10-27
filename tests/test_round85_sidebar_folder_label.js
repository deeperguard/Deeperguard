/**
 * Sidebar folder rows: action cluster hidden until hover/focus so names stay readable.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

const renderFolders = appJs.split('function renderFolders()')[1].split('function hideTagComposer()')[0];
assert.ok(renderFolders.includes('folder-head-actions'));
assert.ok(renderFolders.includes('role="group" aria-label="Folder actions"'));

assert.ok(appCss.includes('.folder-head:hover .folder-head-actions'));
assert.ok(appCss.includes('.folder-head:focus-within .folder-head-actions'));
assert.ok(appCss.includes('.sidebar-nav .tag-chip .tag-name'));

const actionsBlock = appCss.split('.folder-head-actions {')[1].split('}')[0];
assert.ok(actionsBlock.includes('position: absolute'), 'folder actions overlay must not steal flex width from the label');
assert.ok(appCss.includes('@media (hover: none), (pointer: coarse)'));
assert.ok(appCss.includes('.folder-head-actions') && appCss.includes('pointer-events: auto'));

console.log('test_round85_sidebar_folder_label: ok');
