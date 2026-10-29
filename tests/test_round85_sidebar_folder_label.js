/**
 * Sidebar folder rows: action cluster hidden until hover/focus so names stay readable.
 * On hover/focus, long names expand via data-folder-title popover on .folder-head (not the narrow label flex item).
 * Action hit targets stay clickable above the title popover.
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
assert.ok(renderFolders.includes('class="folder-head" data-folder-title="${escapeAttr(folderTitle)}"'));
assert.ok(renderFolders.includes('data-folder-title="${escapeAttr(folderTitle)}"'));
assert.ok(renderFolders.includes('title="${escapeAttr(folderTitle)}"'));

assert.ok(appCss.includes('.folder-head:hover .folder-head-actions'));
assert.ok(appCss.includes('.folder-head:focus-within .folder-head-actions'));
assert.ok(appCss.includes('.sidebar-nav .tag-chip .tag-name'));

const actionsBlock = appCss.split('.folder-head-actions {')[1].split('}')[0];
assert.ok(actionsBlock.includes('position: absolute'), 'folder actions overlay must not steal flex width from the label');
assert.ok(actionsBlock.includes('z-index: 3'), 'folder actions must stack above the title popover');
assert.ok(appCss.includes('@media (hover: none), (pointer: coarse)'));
assert.ok(appCss.includes('.folder-head-actions > *') && appCss.includes('pointer-events: auto'));
assert.ok(appCss.includes('content: attr(data-folder-title)'));
assert.ok(appCss.includes('.folder-head:not(:has(.folder-rename-input)):hover::after'));
assert.ok(!appCss.includes('.folder-head:hover .folder-select::after'), 'title popover must not be sized inside .folder-select');

const hoverOverlayBlock = appCss.split('.folder-head:not(:has(.folder-rename-input)):hover::after,')[1].split('.folder-block.active > .folder-head:not(:has(.folder-rename-input)):hover::after')[0];
assert.ok(hoverOverlayBlock.includes('white-space: normal'), 'hover title must wrap naturally, not single-line ellipsis');
assert.ok(hoverOverlayBlock.includes('overflow-wrap: break-word'));
assert.ok(hoverOverlayBlock.includes('width: max-content'), 'popover must grow to fit the full title');
assert.ok(hoverOverlayBlock.includes('word-break: normal'), 'must not force per-letter breaks in a narrow box');
assert.ok(!hoverOverlayBlock.includes('max-width: calc(100% + 8.75rem)'), 'must not cap overlay to a partial longer truncation');
assert.ok(!hoverOverlayBlock.includes('white-space: nowrap'), 'hover overlay must not use nowrap truncation');
assert.ok(!hoverOverlayBlock.includes('100cqw'), 'popover must not rely on container queries on the label');
assert.ok(hoverOverlayBlock.includes('z-index: 2'), 'title popover sits under action buttons');

console.log('test_round85_sidebar_folder_label: ok');
