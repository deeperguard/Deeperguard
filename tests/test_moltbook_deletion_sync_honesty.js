/**
 * Features room: deletion / revoke sync honesty — pending vs confirmed gone copy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const securityHtml = fs.readFileSync(path.join(root, 'app/templates/security.html'), 'utf8');
const honestyJs = fs.readFileSync(
  path.join(root, 'app/static/js/deletion-sync-honesty.js'),
  'utf8',
);

assert.ok(appHtml.includes('js/deletion-sync-honesty.js'));
assert.ok(appJs.includes('NotesDeletionSyncHonesty'));
assert.ok(!appJs.includes('Other devices drop them on next sync'));
assert.ok(!appJs.includes('Other devices drop it on their next sync'));
assert.ok(!appJs.includes('It will stop working for anyone who still has it'));
assert.ok(!appJs.includes('stops working now'));
assert.ok(securityHtml.includes('never shown as confirmed gone'));

const sandbox = { window: {} };
sandbox.window = sandbox;
vm.runInNewContext(honestyJs, sandbox);
const H = sandbox.window.NotesDeletionSyncHonesty;
assert.ok(H);

const singleConfirm = H.permanentDeleteConfirmMessage({ count: 1 });
assert.ok(singleConfirm.includes('confirmed gone on this device'));
assert.ok(singleConfirm.includes('pending until sync uploads'));
assert.ok(singleConfirm.includes('not treat an offline'));
assert.ok(!singleConfirm.match(/drop them on next sync/i));
assert.ok(singleConfirm.includes('Not removed:'));
assert.ok(singleConfirm.includes('Existing backups'));
assert.ok(!singleConfirm.includes('Secure Send'));
const sharedConfirm = H.permanentDeleteConfirmMessage({ count: 1, sharedLinks: 1 });
assert.ok(sharedConfirm.includes('A Secure Send link made from this note'));
assert.ok(H.permanentDeleteConfirmMessage({ count: 2, sharedLinks: 2 }).includes('2 Secure Send links'));
assert.ok(appJs.includes("setAttribute('aria-describedby', 'confirm-message')"));
assert.ok(appJs.includes('activeSecureSendLinkCount([id])'));
assert.ok(singleConfirm.includes('encrypted marker'));
assert.ok(!singleConfirm.match(/permanently erased|gone everywhere|no copies remain/i));

const bulkConfirm = H.permanentDeleteConfirmMessage({ count: 3 });
assert.ok(bulkConfirm.includes('These 3 notes'));

const toastOne = H.permanentDeleteToastMessage({ count: 1 });
assert.ok(toastOne.includes('Confirmed gone on this device'));
assert.ok(toastOne.includes('Still pending'));

const revokeConfirm = H.secureSendRevokeConfirmMessage();
assert.ok(revokeConfirm.includes('pending until they fetch again'));
assert.ok(revokeConfirm.includes('cannot confirm'));

const revokeToast = H.secureSendRevokeToastMessage();
assert.ok(revokeToast.includes('pending'));

const emptyTrashFn = appJs.split('async function emptyTrash()')[1].split('function syncNavFilterActive')[0];
assert.ok(emptyTrashFn.includes('NotesDeletionSyncHonesty.permanentDeleteConfirmMessage'));

const delForeverFn = appJs.split('async function deleteNoteForever(id)')[1].split('function deleteFromList(id)')[0];
assert.ok(delForeverFn.includes('NotesDeletionSyncHonesty.permanentDeleteConfirmMessage'));
assert.ok(delForeverFn.includes('NotesDeletionSyncHonesty.permanentDeleteToastMessage'));

// --- Delete-confirmation dialog: wording, shared-copy listing, keyboard / screen reader, no "permanent".
const allCopy = [
  singleConfirm,
  sharedConfirm,
  bulkConfirm,
  toastOne,
  H.permanentDeleteToastMessage({ count: 3 }),
  revokeConfirm,
  revokeToast,
  H.permanentDeleteConfirmMessage({ count: 2, sharedLinks: 2 }),
].join('\n');
assert.ok(!/permanent(ly)?\b/i.test(allCopy), 'user-facing delete copy must not say "permanent"');

// Shared copies are listed only when present.
for (const sharedLinks of [0, undefined, null, -0]) {
  const msg = H.permanentDeleteConfirmMessage({ count: 1, sharedLinks });
  assert.ok(!/Secure Send/.test(msg), `no shared line when sharedLinks=${sharedLinks}`);
  assert.ok(msg.includes('Not removed:'));
}
assert.ok(!/Secure Send/.test(H.permanentDeleteConfirmMessage()));
assert.ok(!/Secure Send/.test(H.permanentDeleteConfirmMessage({ count: 4 })));
assert.ok(/1 Secure Send|A Secure Send link/.test(H.permanentDeleteConfirmMessage({ count: 1, sharedLinks: 1 })));

// Run the real confirmAction against a minimal fake DOM.
const confirmSrc = 'function confirmAction(' + appJs.split('function confirmAction(')[1].split('NotesStore.setCsrf(')[0];
function makeEl(id) {
  const listeners = {};
  const attrs = {};
  const classes = new Set();
  return {
    id,
    hidden: true,
    textContent: '',
    focused: false,
    attrs,
    listeners,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return !!on; },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    focus() { this.focused = true; },
    click() { (listeners.click || []).slice().forEach((f) => f({})); },
  };
}
function runConfirm(message, opts) {
  const els = {};
  ['confirm-backdrop', 'confirm-dialog', 'confirm-title', 'confirm-message',
    'confirm-ok', 'confirm-cancel', 'confirm-extra', 'unlock-screen'].forEach((id) => { els[id] = makeEl(id); });
  const docListeners = [];
  const body = makeEl('body');
  const doc = {
    body,
    getElementById: (id) => els[id] || null,
    addEventListener: (t, fn) => { if (t === 'keydown') docListeners.push(fn); },
    removeEventListener: (t, fn) => {
      const i = docListeners.indexOf(fn);
      if (i >= 0) docListeners.splice(i, 1);
    },
  };
  const timers = [];
  const ctx = {
    document: doc,
    window: { confirm: () => { throw new Error('fallback confirm used'); }, setTimeout: (fn) => timers.push(fn) },
    Promise,
  };
  vm.runInNewContext(`${confirmSrc}; this.confirmAction = confirmAction;`, ctx);
  const result = ctx.confirmAction(message, opts);
  const settled = { done: false, value: undefined };
  result.then((v) => { settled.done = true; settled.value = v; });
  const key = (k) => {
    let prevented = false;
    docListeners.slice().forEach((fn) => fn({
      key: k, preventDefault: () => { prevented = true; }, stopPropagation() {},
    }));
    return prevented;
  };
  return { els, body, settled, result, key, timers, docListeners };
}

(async () => {
  const msg = H.permanentDeleteConfirmMessage({ count: 1, sharedLinks: 1 });
  const opts = { title: 'Delete forever', confirmLabel: 'Delete', danger: true };

  // Rendering: wording, labels, ARIA wiring.
  let r = runConfirm(msg, opts);
  assert.strictEqual(r.els['confirm-message'].textContent, msg);
  assert.strictEqual(r.els['confirm-title'].textContent, 'Delete forever');
  assert.strictEqual(r.els['confirm-ok'].textContent, 'Delete');
  assert.ok(r.els['confirm-ok'].classList.contains('danger'));
  assert.strictEqual(r.els['confirm-dialog'].hidden, false);
  assert.strictEqual(r.els['confirm-dialog'].attrs['aria-labelledby'], 'confirm-title');
  assert.strictEqual(r.els['confirm-dialog'].attrs['aria-describedby'], 'confirm-message');
  assert.ok(r.body.classList.contains('confirm-open'));
  assert.ok(!/permanent/i.test(r.els['confirm-title'].textContent + r.els['confirm-ok'].textContent));
  assert.ok(r.els['confirm-message'].textContent.includes('Secure Send'));

  // Template declares the dialog semantics for screen readers.
  assert.ok(/<div id="confirm-dialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="confirm-title"/.test(appHtml));
  assert.ok(/<p id="confirm-message">/.test(appHtml));

  // Keyboard: focus lands on Cancel (safe default), Escape cancels and cleans up.
  r.timers.forEach((fn) => fn());
  assert.ok(r.els['confirm-cancel'].focused, 'Cancel is focused first');
  assert.ok(!r.els['confirm-ok'].focused, 'destructive button is not focused by default');
  assert.strictEqual(r.key('Enter'), false, 'Enter is not intercepted by the dialog');
  assert.strictEqual(r.key('Escape'), true);
  assert.strictEqual(await r.result, false);
  assert.strictEqual(r.els['confirm-dialog'].hidden, true);
  assert.strictEqual(r.els['confirm-backdrop'].hidden, true);
  assert.ok(!r.body.classList.contains('confirm-open'));
  assert.strictEqual(r.docListeners.length, 0, 'keydown listener removed');

  // Confirm button resolves true; Cancel and backdrop resolve false.
  r = runConfirm(msg, opts);
  r.els['confirm-ok'].click();
  assert.strictEqual(await r.result, true);
  r = runConfirm(msg, opts);
  r.els['confirm-cancel'].click();
  assert.strictEqual(await r.result, false);
  r = runConfirm(msg, opts);
  r.els['confirm-backdrop'].click();
  assert.strictEqual(await r.result, false);

  // Without shared links the rendered dialog text has no shared-copy line.
  r = runConfirm(H.permanentDeleteConfirmMessage({ count: 1, sharedLinks: 0 }), opts);
  assert.ok(!/Secure Send/.test(r.els['confirm-message'].textContent));
  r.els['confirm-cancel'].click();
  await r.result;

  console.log('test_moltbook_deletion_sync_honesty ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
