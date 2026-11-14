/**
 * Quick capture + share target (docs/REMINDERS_TASKS_SPEC.md sections 5, 6, 9):
 * shortcut does not clash, payload building, one-shot worker hand-off, memory
 * only (no storage, no cache), 64 KiB bound, 2-minute expiry, manifest shape.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const QC = require('../app/static/js/quick-capture.js');

// --- shortcut ---
const ev = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
assert.ok(QC.isCaptureShortcut(ev('K', { ctrlKey: true, shiftKey: true })));
assert.ok(QC.isCaptureShortcut(ev('k', { metaKey: true, shiftKey: true })));
assert.ok(!QC.isCaptureShortcut(ev('k', { ctrlKey: true })), 'Ctrl+K stays search');
assert.ok(!QC.isCaptureShortcut(ev('n', { ctrlKey: true, shiftKey: true })), 'browser keeps Ctrl+Shift+N');
assert.ok(!QC.isCaptureShortcut(ev('K', { shiftKey: true })), 'plain Shift+K (list nav) is not capture');
assert.ok(!QC.isCaptureShortcut(ev('K', { ctrlKey: true, shiftKey: true, altKey: true })));
assert.ok(!QC.isCaptureShortcut(ev('K', { ctrlKey: true, shiftKey: true, isComposing: true })), 'IME');

// The app's existing global shortcuts must not match the new one.
const appJs = fs.readFileSync(path.join(ROOT, 'app/static/js/app.js'), 'utf8');
assert.match(appJs, /e\.key\.toLowerCase\(\) === 'k' && !e\.shiftKey/, 'Ctrl+K search excludes Shift');
const core = require('../app/static/js/agenda-scroll-core.js');
const agendaAction = core.agendaShortcutAction || (global.NotesAgendaScrollCore || {}).agendaShortcutAction;
if (agendaAction) {
  assert.strictEqual(agendaAction(ev('K', { ctrlKey: true, shiftKey: true, target: {} }), { paneVisible: true }), '');
}

// --- payload ---
const base = { type: 'note', title: '', content: '', tags: [] };
const note = QC.buildCapturePayload('  Buy milk\nand bread  ', 'note', base);
assert.strictEqual(note.type, 'note');
assert.strictEqual(note.title, 'Buy milk');
assert.strictEqual(note.content, 'and bread');
const task = QC.buildCapturePayload('Call Ann\ndetails', 'task', base);
assert.strictEqual(task.title, 'Call Ann');
assert.strictEqual(task.content, '- [ ] Call Ann\n\ndetails');
assert.strictEqual(QC.buildCapturePayload('   ', 'note', base), null);
assert.strictEqual(base.title, '', 'base not mutated');

// --- share text ---
assert.strictEqual(QC.shareToText({ title: 'T', text: 'body', url: 'https://x.test/a' }), 'T\nbody\nhttps://x.test/a');
assert.strictEqual(QC.shareToText({ title: '', text: 'see https://x.test/a', url: 'https://x.test/a' }), 'see https://x.test/a');
assert.strictEqual(QC.shareToText({ text: 42, title: {} }), '');
assert.strictEqual(QC.shareToText(null), '');

// --- service worker: POST handler, memory only, one-shot, expiry ---
function loadSw() {
  const listeners = {};
  const touched = [];
  const spy = (name) => new Proxy({}, { get(_, k) { touched.push(`${name}.${String(k)}`); return () => Promise.resolve(); } });
  const timers = [];
  let now = 1_000_000;
  const self = {
    location: { origin: 'https://notes.test' },
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() {},
    clients: { matchAll: async () => [] },
  };
  const ctx = {
    self,
    caches: spy('caches'),
    indexedDB: spy('indexedDB'),
    localStorage: spy('localStorage'),
    URL,
    Response: { redirect: (url, status) => ({ redirected: url, status }) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date: { now: () => now },
    fetch: () => { touched.push('fetch'); return Promise.resolve(); },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/static/sw.js'), 'utf8'), ctx);
  return { listeners, touched, timers, advance(ms) { now += ms; } };
}

function postShare(sw, fields, url = 'https://notes.test/app/share-target') {
  let responded = null;
  sw.listeners.fetch({
    request: {
      method: 'POST',
      url,
      formData: async () => ({ get: (k) => (k in fields ? fields[k] : null) }),
    },
    respondWith(p) { responded = Promise.resolve(p); },
  });
  return responded;
}

function take(sw, origin = 'https://notes.test') {
  let reply = null;
  sw.listeners.message({
    data: { type: 'notes-share-take' },
    source: { url: `${origin}/app?action=share` },
    ports: [{ postMessage(msg) { reply = msg; } }],
  });
  return JSON.parse(JSON.stringify(reply));
}

(async () => {
  const sw = loadSw();
  const res = await postShare(sw, { title: 'Hello', text: 'secret shared words', url: 'https://x.test' });
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.redirected, 'https://notes.test/app?action=share');
  assert.ok(!res.redirected.includes('secret'), 'content never in URL');
  assert.deepStrictEqual(sw.touched, [], 'share never touches caches/IDB/localStorage/network');
  assert.deepStrictEqual(take(sw, 'https://evil.test'), { share: null }, 'cross-origin client gets nothing');
  // A cross-origin probe does not consume it; the app page still gets it.
  assert.deepStrictEqual(take(sw).share, { title: 'Hello', text: 'secret shared words', url: 'https://x.test' });
  await postShare(sw, { text: 'again' });
  assert.deepStrictEqual(take(sw).share, { title: '', text: 'again', url: '' });
  assert.deepStrictEqual(take(sw), { share: null }, 'delete on read');

  // Other POST paths / cross-origin are ignored (not intercepted).
  assert.strictEqual(postShare(sw, { text: 'x' }, 'https://notes.test/api/items'), null);
  assert.strictEqual(postShare(sw, { text: 'x' }, 'https://evil.test/app/share-target'), null);

  // Expiry after 2 minutes.
  await postShare(sw, { text: 'old' });
  sw.advance(2 * 60 * 1000 + 1);
  assert.deepStrictEqual(take(sw), { share: null });
  assert.ok(sw.timers.some((t) => t.ms === 120000), 'drop timer armed');

  // Bounded to 64 KiB with a visible marker.
  await postShare(sw, { text: 'a'.repeat(70 * 1024) });
  const big = take(sw).share;
  assert.ok(big.text.length <= 64 * 1024 + 40);
  assert.ok(big.text.endsWith('[… shared text was cut off]'));
  assert.deepStrictEqual(sw.touched, []);

  // --- requestPendingShare: one-shot MessageChannel to the controller ---
  const fake = {
    controller: {
      postMessage(msg, ports) {
        assert.strictEqual(msg.type, 'notes-share-take');
        ports[0].postMessage({ share: { title: '', text: 'from sw', url: '' } });
      },
    },
  };
  const got = await QC.requestPendingShare(fake, { timeoutMs: 1000 });
  assert.strictEqual(got.text, 'from sw');
  assert.strictEqual(await QC.requestPendingShare(null, { timeoutMs: 10 }), null);
  assert.strictEqual(await QC.requestPendingShare({ controller: null, ready: new Promise(() => {}) }, { timeoutMs: 20 }), null);

  // --- manifest ---
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/static/manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.share_target, {
    action: '/app/share-target',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: { title: 'title', text: 'text', url: 'url' },
  });
  assert.ok(!('files' in manifest.share_target.params), 'files not accepted in v1');
  assert.ok(manifest.shortcuts.some((s) => s.url === '/app?action=capture'));

  // --- module never touches storage ---
  const src = fs.readFileSync(path.join(ROOT, 'app/static/js/quick-capture.js'), 'utf8');
  assert.ok(!/localStorage|sessionStorage|indexedDB|caches\./.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));

  console.log('test_quick_capture ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
