const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const searchJs = fs.readFileSync(path.join(root, 'app/static/js/search.js'), 'utf8');
const authJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const marketing = fs.readFileSync(path.join(root, 'app/static/css/marketing.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const home = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const topbar = fs.readFileSync(path.join(root, 'app/templates/partials/mk-topbar.html'), 'utf8');
const compare = fs.readFileSync(path.join(root, 'app/templates/compare-standard-notes.html'), 'utf8');
const register = fs.readFileSync(path.join(root, 'app/templates/register.html'), 'utf8');

for (const page of [home, topbar, compare]) {
  assert.ok(page.includes('class="mk-nav-check"'));
  assert.ok(page.includes('class="mk-nav-toggle"'));
  assert.ok(page.includes('<nav class="mk-nav"'));
  assert.ok(!page.includes('mk-nav-menu'));
  assert.ok(page.includes('href="/download">Download</a>'));
  assert.ok(page.includes('href="/contact">Contact</a>'));
  assert.ok(page.includes('Open notes app</a>'));
}
assert.ok(marketing.includes('.mk-nav-check:checked ~ .mk-nav'));
assert.ok(marketing.includes('min-width: 1024px'));
assert.ok(!marketing.includes('min-width: 1400px'));
assert.ok(!marketing.includes('display: contents'));
assert.ok(marketing.includes('right: 0'));
assert.ok(marketing.includes('max-width: 100%'));
assert.ok(marketing.includes('min-height: 44px'));
assert.ok(!marketing.includes('min-height: 36px'));
assert.ok(marketing.includes('white-space: nowrap'));
const tight = marketing.split('@media (min-width: 1024px) and (max-width: 1365px)')[1].split('@media')[0];
assert.ok(tight.includes('.mk-brand small { display: none;'));

assert.ok(appJs.includes('function scheduleOnlineRecovery'));
assert.ok(appJs.includes('scheduleOnlineRecovery(0)'));
assert.ok(appJs.includes('const delays = [500, 1000, 2000, 4000]'));
assert.ok(storeJs.includes('will sync when online'));
assert.ok(storeJs.includes("if (!state.dirty.size && /will sync when online/.test(lastStatusText)) notifyStatus('Saved')"));
assert.ok(appJs.includes("ui.saveStatus.textContent = 'Saved'"));

assert.ok(register.includes('id="register-recover-ack"'));
assert.ok(register.includes("I understand Deeperguard can't recover my notes if I forget this password"));
assert.ok(authJs.includes('register-recover-ack'));
assert.ok(authJs.includes("notes_verify_email_hint"));
assert.ok(html.includes('Your password is the only key'));
assert.ok(appJs.includes('notes_verify_email_hint'));
assert.ok(appJs.includes('We emailed a verification code'));

assert.ok(appJs.includes('function emptyListActionsHtml'));
assert.ok(appJs.includes("currentFilter === 'pinned' || currentFilter === 'archived'"));
assert.ok(appJs.includes('data-empty-new>New note</button>'));
assert.ok(html.includes('id="empty-state-tips"'));
assert.ok(html.includes('Open the 2FA tab'));
assert.ok(appJs.includes('Welcome to Deeperguard'));

const hideTotp = appJs.split('function hideTotpAddDialog')[1].split('function showTotpAddDialog')[0];
assert.ok(hideTotp.includes('totpEditingId ? totpDialogTrigger : totpUi.add'));
assert.ok(hideTotp.includes('requestAnimationFrame(focusReturn)'));

const createTag = appJs.split('function createTag(')[1].split('function layoutFindBarOverDocViewer')[0];
assert.ok(createTag.includes('currentTag = id'));
assert.ok(createTag.includes('closeEditorIfNoteLeftView()'));

const filter = searchJs.split("if (filter === 'pinned'")[1].split('\n')[0];
assert.ok(filter.includes('!c.starred'));
assert.ok(!filter.includes('noteIsPinned'));
assert.ok(searchJs.includes('return !!(c.pinned || c.starred)'));

assert.ok(html.includes('id="btn-star"'));
assert.ok(html.includes('editor-toolbar-row-item" data-editor-proxy="btn-star"'));
assert.ok(html.includes('class="editor-menu-label">Star<'));
const starRow = html.indexOf('data-editor-proxy="btn-star" title="Star"');
const menuAt = html.indexOf('editor-toolbar-menu-panel');
assert.ok(starRow > 0 && starRow < menuAt);

assert.strictEqual(css.split('@media (min-width: 1000px)').length - 1, 5);

console.log('test_round28_ui ok');
