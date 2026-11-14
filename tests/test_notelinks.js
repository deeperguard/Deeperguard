/**
 * ID-based note links: insert via [[ picker, rename, deleted/trashed target,
 * malicious link text (XSS) and no network traffic while searching.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../app/static/js/notelinks.js');
const { render } = require('../app/static/js/markdown.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';

// Vault stand-in: uuid -> note content.
const vault = new Map([
  [A, { title: 'Alpha plan', trashed: false }],
  [B, { title: 'Beta notes', trashed: false }],
]);
const lookup = (id) => vault.get(id) || null;
const notes = () => [...vault].map(([uuid, c]) => ({ uuid, ...c }));
const view = (text) => { const p = L.prepareRender(text, lookup); return p.restore(render(p.text)); };

// Network spy: any fetch / XHR / beacon / WebSocket use fails the test.
let netCalls = 0;
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
  global[name] = function spy() { netCalls += 1; throw new Error(`network: ${name}`); };
}
global.navigator = { sendBeacon() { netCalls += 1; return false; } };

// --- trigger + search + insert ---
const typed = 'See [[alp';
const trig = L.findTrigger(typed, typed.length);
assert.deepStrictEqual([trig.start, trig.end, trig.query], [4, 9, 'alp']);
assert.strictEqual(L.findTrigger('no trigger here', 5), null);
assert.strictEqual(L.findTrigger('done [[x]] and more', 19), null, 'closed span is not a trigger');
assert.strictEqual(L.findTrigger('```\n[[a\n```', 8), null, 'code is ignored');
const hits = L.searchNotes(notes(), 'alp');
assert.deepStrictEqual(hits.map((h) => h.uuid), [A]);
assert.strictEqual(L.searchNotes(notes(), '', { excludeId: A }).some((h) => h.uuid === A), false, 'never links to itself');
const picked = L.applyChoice(typed, trig, hits[0]);
assert.strictEqual(picked.value, `See [Alpha plan](dg-note:${A})`);
assert.strictEqual(picked.caret, picked.value.length);
assert.strictEqual(L.applyChoice('x [[a]]', L.findTrigger('x [[a]]', 5), hits[0]).value, `x [Alpha plan](dg-note:${A})`, 'auto-closed ]] is consumed');

// --- renders as a link to the target with the current title; rename keeps working ---
const body = `Go to ${picked.value.slice(4)}`;
let html = view(body);
assert.match(html, new RegExp(`<a href="#note/${A}" class="note-link" data-dg-note="${A}">Alpha plan</a>`));
vault.get(A).title = 'Alpha plan v2';
html = view(body);
assert.match(html, />Alpha plan v2<\/a>/, 'renamed target shows new title');
assert.match(html, new RegExp(`data-dg-note="${A}"`));
assert.doesNotMatch(html, /note-link-dead/);

// --- deleted / unknown / trashed target is a visible dead link ---
vault.delete(A);
html = view(body);
assert.match(html, /note-link-dead/);
assert.match(html, /data-dead="missing"/);
assert.match(html, /aria-label="Link to missing note: Alpha plan"/);
assert.match(html, /deleted or not in your vault/);
assert.match(view(`[x](dg-note:${GONE})`), /data-dead="missing"/);
vault.set(A, { title: 'Alpha plan v2', trashed: true });
assert.match(view(body), /data-dead="trashed"/);
vault.set(A, { title: 'Alpha plan v2', trashed: false });
assert.doesNotMatch(view(body), /note-link-dead/, 'restoring brings the link back');
// repair actions
const text = `a [Old](dg-note:${GONE}) b [Old](dg-note:${GONE})`;
assert.strictEqual(L.removeLink(text, GONE), 'a Old b Old');
assert.strictEqual(L.relinkLink(text, GONE, { uuid: B, title: 'ignored' }), `a [Old](dg-note:${B}) b [Old](dg-note:${B})`);
assert.strictEqual(L.findLinks('`[c](dg-note:' + A + ')`').length, 0, 'links in code are ignored');

// --- XSS: malicious link text / titles / ids ---
const evil = '<img src=x onerror=alert(1)>';
vault.set(B, { title: evil, trashed: false });
html = view(`[z](dg-note:${B})`);
assert.doesNotMatch(html, /<img/);
assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
vault.delete(B);
html = view(`[${evil}](dg-note:${B})`);
assert.doesNotMatch(html, /<img/);
assert.doesNotMatch(html, /onerror=alert\(1\)>/);
for (const bad of [`[x](dg-note:javascript:alert(1))`, `[x](dg-note:${A}" onclick="alert(1))`, `[x](dg-note:../../etc)`,
  `[x](javascript:alert(1))`, `[x](https://evil.example)(dg-note:${A})`]) {
  const out = view(bad);
  assert.doesNotMatch(out, /href="(javascript|dg-note):/i, bad);
  assert.doesNotMatch(out, /<[^>]*onclick=/i, bad);
}
assert.doesNotMatch(view(`[x](dg-note:${A})`), /href="(?!#note\/)/, 'only the internal scheme');
assert.strictEqual(L.buildLink('not-a-uuid', 'x'), '');
assert.strictEqual(L.buildLink(A, 'a] [b'), `[a b](dg-note:${A})`, 'brackets stripped from label');

// --- picker: ARIA, keyboard, no network ---
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.hidden = false; this.textContent = ''; this.value = ''; this.selectionStart = 0; this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  fire(t, ev = {}) { (this.listeners[t] || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {}, ...ev })); }
}
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._t || ''; },
  set(v) { this._t = v; if (v === '') this.children = []; },
});
const wrap = new El('div');
const ta = new El('textarea');
wrap.appendChild(ta);
const chosen = [];
const picker = L.attachPicker({
  textarea: ta, doc: { createElement: (t) => new El(t) }, getNotes: notes, getExcludeId: () => '',
  onChoose: (n, t) => chosen.push([n, t]),
});
assert.strictEqual(ta.attrs.role, 'combobox');
assert.strictEqual(ta.attrs['aria-expanded'], 'false');
assert.strictEqual(picker.element.attrs.role, 'listbox');
vault.set(A, { title: 'Alpha plan v2', trashed: false });
vault.set(B, { title: 'Beta notes', trashed: false });
ta.value = 'x [[';
ta.selectionStart = 4;
ta.fire('input');
assert.strictEqual(ta.attrs['aria-expanded'], 'true');
assert.strictEqual(picker.element.children.length, 2);
assert.ok(picker.element.children.every((li) => li.attrs.role === 'option'));
assert.strictEqual(picker.element.children[0].attrs['aria-selected'], 'true');
ta.fire('keydown', { key: 'ArrowDown' });
assert.strictEqual(picker.element.children[1].attrs['aria-selected'], 'true');
assert.strictEqual(ta.attrs['aria-activedescendant'], picker.element.children[1].id);
ta.fire('keydown', { key: 'Enter' });
assert.strictEqual(chosen.length, 1);
assert.strictEqual(chosen[0][0].uuid, B);
assert.strictEqual(ta.attrs['aria-expanded'], 'false', 'closes after choosing');
ta.value = 'x [[beta';
ta.selectionStart = 8;
ta.fire('input');
assert.strictEqual(picker.element.children.length, 1);
ta.fire('keydown', { key: 'Escape' });
assert.strictEqual(ta.attrs['aria-expanded'], 'false');
ta.value = 'x [[zzz';
ta.selectionStart = 7;
ta.fire('input');
assert.strictEqual(picker.element.children[0].textContent, 'No matching notes');
assert.strictEqual(netCalls, 0, 'searching/picking makes no network request');

// --- wiring: notelinks.js is loaded and used by the app ---
const appJs = fs.readFileSync(path.join(__dirname, '../app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(__dirname, '../app/templates/app.html'), 'utf8');
assert.ok(appHtml.includes('js/notelinks.js'));
assert.ok(appJs.includes('NotesLinks.attachPicker') && appJs.includes('activateNoteLink'));
assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(fs.readFileSync(path.join(__dirname, '../app/static/js/notelinks.js'), 'utf8')), 'module has no network code');

console.log('notelinks ok');
