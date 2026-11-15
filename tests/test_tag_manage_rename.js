// Tags > Browse all tags > Manage: renaming a sub-tag ("boodschappen/winkel" ->
// "boodschappen/markt") via Enter and via the 'Rename tag <name>' button must change
// the name in the manage list, the sidebar tree and on the note, show a toast, survive
// lock/unlock and only ever send ciphertext to the server.
//
// Drives the real renderTagManageList / beginManageRename / renderTags from app.js
// (extracted by name) against a tiny HTML-parsing DOM, with the real NotesStore.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./sync_harness');
require('../app/static/js/sanitize.js');
require('../app/static/js/labeltree.js');

const { NotesStore } = h;
const appJs = fs.readFileSync(path.join(__dirname, '..', 'app/static/js/app.js'), 'utf8');

// ---------- minimal DOM: parses the markup app.js writes via innerHTML ----------
let activeElement = null;
class Ev {
  constructor(type, init = {}) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parent = null;
    this.listeners = {}; this.text = ''; this.value = ''; this.hidden = false;
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get id() { return this.attrs.id || ''; }
  get dataset() {
    const out = {};
    for (const [k, v] of Object.entries(this.attrs)) {
      if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
    return out;
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      toggle: (c, on) => { const s = new Set(list()); (on ?? !s.has(c)) ? s.add(c) : s.delete(c); el.className = [...s].join(' '); },
      add: (c) => { const s = new Set(list()); s.add(c); el.className = [...s].join(' '); },
      remove: (c) => { el.className = list().filter((x) => x !== c).join(' '); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  replaceWith(n) { const i = this.parent.children.indexOf(this); n.parent = this.parent; this.parent.children[i] = n; this.parent = null; }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  closest(sel) { for (let x = this; x; x = x.parent) if (x.matches(sel)) return x; return null; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  matches(sel) {
    const m = sel.match(/^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
    if (!m) throw new Error(`unsupported selector ${sel}`);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const c of m[2].split('.').filter(Boolean)) if (!this.classList.contains(c)) return false;
    if (m[3] && !(m[3] in this.attrs)) return false;
    if (m[4] !== undefined && this.attrs[m[3]] !== m[4]) return false;
    return true;
  }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatchEvent(ev) { for (const fn of [...(this.listeners[ev.type] || [])]) fn(ev); return !ev.defaultPrevented; }
  focus() {
    if (activeElement === this) return;
    const prev = activeElement;
    activeElement = this;
    if (prev) prev.dispatchEvent(new Ev('blur'));
  }
  select() {}
  click() { this.dispatchEvent(new Ev('click')); }
  set innerHTML(html) {
    this.children = [];
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const stack = [this];
    const re = /<(\/?)([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
    let m;
    while ((m = re.exec(html))) {
      const top = stack[stack.length - 1];
      if (m[4] !== undefined) { if (m[4].trim()) top.appendChild(Object.assign(new El('#text'), { text: decode(m[4]) })); continue; }
      if (m[1]) { stack.pop(); continue; }
      const el = top.appendChild(new El(m[2]));
      for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.attrs[a[1]] = decode(a[2] ?? '');
      if ('hidden' in el.attrs) el.hidden = true;
      if (!/^(input|br|img)$/i.test(m[2]) && !m[0].endsWith('/>')) stack.push(el);
    }
  }
}
const byId = {
  'tag-manage-dialog': Object.assign(new El('div'), { hidden: false }),
  'tag-manage-list': new El('div'),
  'tag-section': new El('details'),
};
const sidebar = new El('ul');
const document = {
  get activeElement() { return activeElement; },
  getElementById: (id) => byId[id] || null,
  createElement: (t) => new El(t),
};

// ---------- the real Manage-tags code from app.js ----------
function extract(name) {
  const start = appJs.search(new RegExp(`\\n  (?:function ${name}\\(|const ${name} = )`));
  assert.ok(start >= 0, `${name} found in app.js`);
  let i = appJs.slice(start).search(/[[{]/) + start;
  const [open, close] = appJs[i] === '[' ? ['[', ']'] : ['{', '}'];
  for (let depth = 0; ; i += 1) {
    if (appJs[i] === open) depth += 1;
    if (appJs[i] === close && --depth === 0) break;
  }
  return appJs.slice(start, i + 1) + (appJs[i + 1] === ';' ? ';' : '');
}
const toasts = [];
const ctx = vm.createContext({
  document, NotesStore, NotesLabels, NotesLabelTree, NotesSanitize, Event: Ev, console,
  ui: { tagList: sidebar },
  currentId: null,
  currentTag: null,
  toast: (message, isError = false) => toasts.push({ message, isError }),
  invalidateTagMap() {}, renderNotes() {}, renderTagBar() {}, syncTagLimitHint() {},
  bindLabelTree() {}, focusLabel() {}, renderTagColorBar() {}, renderSearchFilterTags() {}, renderFolders() {},
  deleteCurrentTag() {}, openServerCopyView: async () => {},
  openLabels: () => new Set(NotesStore.listTags().map((t) => t.uuid)),
});
vm.runInContext([
  'TAG_COLORS', 'TAG_COLOR_NAMES', 'tagColorName', 'escapeHtml', 'escapeAttr', 'safeColor',
  'labelIndex', 'labelCounts', 'renderTags', 'tagManageOpen', 'renderTagManageList',
  'TAG_RENAME_ERRORS', 'beginManageRename',
].filter((n) => n !== 'TAG_RENAME_ERRORS' || appJs.includes(`const ${n} =`)).map(extract).join('\n') + '\nthis.app = { renderTags };', ctx);

// ---------- helpers mirroring what the user sees ----------
const list = byId['tag-manage-list'];
const renameButton = (title) => list.querySelector(`button[aria-label="Rename tag ${title}"]`);
const manageNames = () => list.querySelectorAll('.tag-manage-name').map((e) => e.textContent);
const sidebarNames = () => sidebar.querySelectorAll('.label-name').map((e) => e.textContent);
const noteTagTitles = (id) => NotesStore.get(id).content.tags.map((t) => NotesStore.get(t).content.title).sort();

function startRename(title, value) {
  const button = renameButton(title);
  assert.ok(button, `manage list has 'Rename tag ${title}'`);
  button.click();
  const input = list.querySelector('input.tag-manage-rename');
  assert.ok(input, 'rename field appears');
  assert.strictEqual(input.getAttribute('aria-label'), 'Rename tag');
  input.focus();
  input.value = value;
  return { input, button };
}

function addNoteWithLegacyTag(title) {
  // Same shape the note tag bar writes (createTag -> NotesStore.defaultTag(name)).
  const tagId = NotesStore.newUuid();
  NotesStore.upsert(tagId, NotesStore.defaultTag(title));
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Lijstje', tags: [tagId] });
  return { tagId, noteId };
}

function assertRenamed(noteId, from, to, sidebarName = to) {
  assert.ok(manageNames().includes(to), `manage list shows ${to}: ${manageNames()}`);
  assert.ok(!manageNames().includes(from), `manage list no longer shows ${from}`);
  assert.ok(renameButton(to) && !renameButton(from), 'rename button carries the new name');
  assert.ok(sidebarNames().includes(sidebarName), `sidebar shows ${sidebarName}: ${sidebarNames()}`);
  assert.deepStrictEqual(noteTagTitles(noteId), [to], 'tag on the note has the new name');
  const last = toasts[toasts.length - 1];
  assert.ok(last && !last.isError && last.message.includes(to), `confirmation toast: ${JSON.stringify(last)}`);
}

(async () => {
  await h.unlockFresh();
  h.resetServer();
  h.stopPushTimer();

  // The original bug: the manage field holds the full name, but renameTag only accepts a
  // leaf name and silently rejects anything with '/'. The manage screen ignored that result.
  const probe = addNoteWithLegacyTag('boodschappen/winkel');
  assert.strictEqual(NotesStore.renameTag(probe.tagId, 'boodschappen/markt'), false, 'leaf-only renameTag rejects a slash');
  NotesStore.deleteTag(probe.tagId);

  // 1) Legacy flat tag, confirmed with Enter.
  const a = addNoteWithLegacyTag('boodschappen/winkel');
  ctx.app.renderTags();
  assert.ok(manageNames().includes('boodschappen/winkel') && sidebarNames().includes('boodschappen/winkel'));
  let { input } = startRename('boodschappen/winkel', 'boodschappen/markt');
  input.dispatchEvent(new Ev('keydown', { key: 'Enter' }));
  assertRenamed(a.noteId, 'boodschappen/winkel', 'boodschappen/markt');
  NotesStore.deleteTag(a.tagId);
  ctx.app.renderTags();

  // 2) Same, confirmed by clicking the 'Rename tag boodschappen/winkel' button
  //    (no focus change, as in Safari) ...
  const b = addNoteWithLegacyTag('boodschappen/winkel');
  ctx.app.renderTags();
  let started = startRename('boodschappen/winkel', 'boodschappen/markt');
  started.button.click();
  assertRenamed(b.noteId, 'boodschappen/winkel', 'boodschappen/markt');
  NotesStore.deleteTag(b.tagId);
  ctx.app.renderTags();

  // ... and with the button taking focus first (Chrome/Firefox: blur commits).
  const c = addNoteWithLegacyTag('boodschappen/winkel');
  ctx.app.renderTags();
  started = startRename('boodschappen/winkel', 'boodschappen/markt');
  started.button.focus();
  started.button.click();
  assertRenamed(c.noteId, 'boodschappen/winkel', 'boodschappen/markt');
  assert.strictEqual(list.querySelectorAll('input.tag-manage-rename').length, 0, 'no second rename field opened');

  // 3) Renaming onto an existing name is never silent: clear error, nothing changes.
  const d = addNoteWithLegacyTag('boodschappen/winkel');
  ctx.app.renderTags();
  ({ input } = startRename('boodschappen/winkel', 'boodschappen/markt'));
  input.dispatchEvent(new Ev('keydown', { key: 'Enter' }));
  assert.ok(toasts[toasts.length - 1].isError, 'duplicate shows an error toast');
  assert.match(toasts[toasts.length - 1].message, /already exists/);
  assert.deepStrictEqual(noteTagTitles(d.noteId), ['boodschappen/winkel']);
  assert.ok(manageNames().includes('boodschappen/winkel'));
  NotesStore.deleteTag(d.tagId);

  // 4) Nested sub-label (boodschappen > winkel): the full path typed in the field renames the leaf.
  const parent = NotesStore.createTag('boodschappen');
  const child = NotesStore.createTag('winkel', parent);
  const grand = NotesStore.createTag('aanbiedingen', child);
  const nested = NotesStore.newUuid();
  NotesStore.upsert(nested, { ...NotesStore.defaultNote(), title: 'Genest', tags: [child] });
  ctx.app.renderTags();
  ({ input } = startRename('boodschappen / winkel', 'boodschappen/markt'));
  input.dispatchEvent(new Ev('keydown', { key: 'Enter' }));
  assertRenamed(nested, 'boodschappen / winkel', 'boodschappen / markt', 'markt');
  assert.strictEqual(NotesStore.get(grand).content.title, 'boodschappen / markt / aanbiedingen', 'children follow');
  // Renaming the parent takes the children along.
  ({ input } = startRename('boodschappen', 'winkelen'));
  input.dispatchEvent(new Ev('keydown', { key: 'Enter' }));
  assert.deepStrictEqual(noteTagTitles(nested), ['winkelen / markt']);
  assert.ok(manageNames().includes('winkelen / markt / aanbiedingen'));
  // Moving to another parent by typing a different path is refused with a message.
  ({ input } = startRename('winkelen / markt', 'elders/markt'));
  input.dispatchEvent(new Ev('keydown', { key: 'Enter' }));
  assert.ok(toasts[toasts.length - 1].isError, 'path change shows an error toast');
  assert.deepStrictEqual(noteTagTitles(nested), ['winkelen / markt']);

  // 5) Encrypted sync + lock/unlock: the server only receives ciphertext and the
  //    renamed tag is still on the note after unlocking.
  const bodies = [];
  h.server.pushResponder = (items, body) => {
    bodies.push(JSON.stringify(body));
    return items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev: 1 }));
  };
  await NotesStore.pushDirty({ quiet: true });
  const wire = bodies.join('\n');
  assert.ok(wire.includes('ciphertext'), 'something was pushed');
  for (const secret of ['boodschappen', 'markt', 'winkel', 'Lijstje', 'aanbiedingen']) {
    assert.ok(!wire.includes(secret), `server never sees "${secret}"`);
  }
  NotesStore.lock();
  assert.ok(!NotesStore.get(c.noteId), 'locked store holds no plaintext');
  await h.unlockFresh();
  await NotesStore.loadLocal({});
  const again = NotesStore.get(c.noteId);
  assert.ok(again, 'note is back after unlock');
  assert.deepStrictEqual(again.content.tags.map((t) => NotesStore.get(t)?.content.title), ['boodschappen/markt']);
  assert.deepStrictEqual(noteTagTitles(nested), ['winkelen / markt']);

  console.log('test_tag_manage_rename.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
