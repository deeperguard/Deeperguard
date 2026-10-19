const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

// Pinned desktop hides both menu buttons. .btn.icon must not win.
const pinned = css.split('html:not(.layout-compact) #btn-list-menu')[1].split('}')[0];
assert.ok(pinned.includes('#btn-nav-menu'));
assert.ok(pinned.includes('display: none !important'));
assert.ok(css.includes("matchMedia('(min-width: 1000px)')") || appJs.includes("matchMedia('(min-width: 1000px)')"));
assert.ok(appJs.includes("!document.documentElement.classList.contains('layout-compact')"));

// Open drawer paints above the backdrop, and only one toggle is shown.
const backdrop = css.split('body.nav-drawer-open .sidebar-nav-backdrop {\n  display: block !important;')[1].split('}')[0];
assert.ok(backdrop.includes('z-index: 30'));
const side = css.split('body.nav-drawer-open .sidebar,\nhtml.layout-compact body.nav-drawer-open .sidebar')[1].split('}')[0];
assert.ok(side.includes('z-index: 36 !important'));
assert.ok(css.includes('html.layout-compact .shell:not(.editor-open) #btn-nav-menu'));
assert.ok(css.includes('html.layout-compact .shell.editor-open #btn-list-menu'));

// Phone drawer starts under the menu button instead of padding a tall empty band.
assert.ok(appJs.includes('panel.style.top'));
assert.ok(appJs.includes("getComputedStyle(sidebar).transform !== 'none'"));
assert.strictEqual(css.split('@media (min-width: 1000px)').length - 1, 5);

console.log('round 24 ui ok');
