const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const marketing = fs.readFileSync(path.join(root, 'app/static/css/marketing.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const home = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const topbar = fs.readFileSync(path.join(root, 'app/templates/partials/mk-topbar.html'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'app/auth.py'), 'utf8');

assert.ok(css.includes(':not(#tag-composer)'));
assert.ok(html.includes('id="tag-manage-name"'));
assert.ok(appJs.includes('function createTagFromManage'));
assert.ok(appJs.includes('navigate = true'));
assert.ok(appJs.includes('navigate: false'));

assert.ok(auth.includes('def _align_session_with_request'));
assert.ok(auth.includes('rotate_session_token'));
assert.ok(!auth.includes('if request_label =='));

assert.ok(appJs.includes('dirtyCount === 0 && quiet'));
assert.ok(appJs.includes("addEventListener('online'"));
assert.ok(appJs.includes("syncNow({ quiet: true, force: true })"));
const phase = appJs.split('function displaySyncPhase')[1].split('function refreshSyncMeta')[0];
assert.ok(phase.includes("return 'pending'"));
assert.ok(phase.includes('dirty > 0'));

assert.ok(appJs.includes('Changes are saved on this device and will sync when you'));
assert.ok(appJs.includes('function selfHostNotes'));
assert.ok(appJs.includes('Join home Wi'));

assert.ok(appJs.includes('details.attachment-overflow[open]'));
assert.ok(appJs.includes("getElementById('totp-add-dialog')"));
assert.ok(appJs.includes('function showTotpEditDialog'));
assert.ok(storeJs.includes('function updateTotpAccount'));
assert.ok(appJs.includes('data-totp-edit'));
assert.ok(appJs.includes('Base32 letters A–Z and digits 2–7'));

assert.ok(home.includes('class="mk-nav-menu"'));
assert.ok(topbar.includes('class="mk-nav-menu"'));
assert.ok(home.includes('aria-label="Menu"'));
assert.ok(marketing.includes('min-width: 1400px'));
assert.ok(marketing.includes('.mk-nav a { white-space: nowrap;'));
assert.ok(marketing.includes('min-height: 44px'));

assert.ok(appJs.includes('flex-direction: column') || css.includes('flex-direction: column'));
const phone = css.split('@media (max-width: 999px)')[1].split('@media (min-width: 1000px)')[0];
assert.ok(phone.includes('.note-list-head-copy'));
assert.ok(phone.includes('flex-direction: column'));
assert.ok(!phone.split('.note-list-title {')[1].split('}')[0].includes('max-width: 100%'));

assert.ok(appJs.includes('function closeEditorIfNoteLeftView'));
assert.ok(appJs.includes('syncNoteFolderControl(NotesStore.get(currentId))'));
assert.ok(appJs.includes('drawer-over-menu'));
assert.ok(html.includes('id="btn-drawer-close"'));
assert.ok(css.includes('body.drawer-over-menu #btn-list-menu'));
assert.ok(!html.includes('role="radiogroup"'));
assert.ok(html.includes('aria-pressed="false"'));
assert.ok(css.includes('bottom: calc(100% + 6px)'));
assert.ok(appJs.includes("bar.hidden = !show || total === 0"));
assert.ok(appJs.includes('No starred notes yet'));
assert.ok(appJs.includes('No archived notes yet'));
assert.ok(appJs.includes('No ${listingFiles ? \'files\' : \'notes\'} match'));
assert.ok(appJs.includes('Clear the search or filters'));
assert.ok(appJs.includes('function tagColorName'));
assert.ok(appJs.includes('Set ${tagColorName'));
assert.ok(appJs.includes('Verify this address in Account'));
assert.ok(html.includes('dir="auto"'));
assert.ok(appJs.includes('function markAutoDir'));
assert.ok(css.includes('width: min(720px, 100%)'));
assert.ok(!css.includes('margin-left: auto;\n  color: var(--muted);'));
assert.strictEqual(css.split('@media (min-width: 1000px)').length - 1, 5);

const devices = appJs.split('function renderSignedInDevices')[1].split('function stopSignedInDevicesRefresh')[0];
assert.ok(devices.includes('if (item.current)'));
assert.ok(!devices.includes('navigator.userAgent'));

console.log('round27 ui ok');
