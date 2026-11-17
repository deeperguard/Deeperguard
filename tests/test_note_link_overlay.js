/**
 * Edit-mode link overlay: [Title](dg-note:<uuid>) links in the plain editor
 * become clickable note links (live or dead) and never web links.
 */
const assert = require('assert');
globalThis.NotesSuperscript = require('../app/static/js/superscript.js');
globalThis.NotesLinks = require('../app/static/js/notelinks.js');
const { renderHtml } = require('../app/static/js/link-overlay.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const vault = new Map([[A, { title: 'Alpha', trashed: false }], [B, { title: 'Beta', trashed: true }]]);
const noteLookup = (id) => vault.get(id) || null;
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Live link: internal anchor, same characters as the textarea (overlay alignment).
const src = `See [Alpha](dg-note:${A}) now`;
let html = renderHtml(src, { noteLookup });
assert.match(html, new RegExp(`<a class="edit-link note-link" href="#note/${A}" data-dg-note="${A}">\\[Alpha\\]\\(dg-note:${A}\\)</a>`));
assert.strictEqual(text(html), src);
assert.doesNotMatch(html, /target="_blank"/);

// Deleted and trashed targets are dead, with the reason.
vault.delete(A);
html = renderHtml(src, { noteLookup });
assert.match(html, /class="edit-link note-link note-link-dead" data-dead="missing"/);
assert.match(renderHtml(`[B](dg-note:${B})`, { noteLookup }), /data-dead="trashed"/);
vault.set(A, { title: 'Alpha', trashed: false });

// Mixed with web links: each gets its own kind; an external link is never internal.
const mixed = `[W](https://example.com/dg-note:${A}) [Alpha](dg-note:${A}) https://x.example`;
html = renderHtml(mixed, { noteLookup });
assert.strictEqual((html.match(/data-dg-note=/g) || []).length, 1);
assert.match(html, new RegExp(`<a class="edit-link" href="https://example.com/dg-note:${A}"[^>]*target="_blank"`));
assert.match(html, /<a class="edit-link" href="https:\/\/x\.example"/);
assert.strictEqual(text(html), mixed);

// Many links, and links in code are left alone.
const many = `[a](dg-note:${A}) [b](dg-note:${B}) \`[c](dg-note:${A})\``;
html = renderHtml(many, { noteLookup });
assert.strictEqual((html.match(/data-dg-note=/g) || []).length, 2);
assert.strictEqual(text(html), many);

// Not a valid id: plain text, no anchor.
assert.doesNotMatch(renderHtml('[x](dg-note:not-a-uuid) [y](dg-note:javascript:alert(1))', { noteLookup }), /<a[\s>]/);
// Malicious label stays escaped.
assert.doesNotMatch(renderHtml(`[<img src=x onerror=alert(1)>](dg-note:${A})`, { noteLookup }), /<img/);

console.log('note link overlay ok');
