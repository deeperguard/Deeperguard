// Switching a Markdown note between edit and preview must never change the stored note: the body,
// the note object (including updated_at) and its AES-256-GCM ciphertext stay byte-identical.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
const NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesMarkdown = require(path.join(jsRoot, 'markdown.js'));
const NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
const { RENDER_VECTORS } = require('./rich_xss_vectors.js');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* sanitizer step covered by the browser test */ }
const win = JSDOM ? new JSDOM('<!doctype html><body></body>').window : null;

// Deterministic IV so two encryptions of the same object can be compared byte for byte.
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
function withFixedIv(fn) {
  globalThis.crypto.getRandomValues = (arr) => { arr.fill(7); return arr; };
  return Promise.resolve(fn()).finally(() => { globalThis.crypto.getRandomValues = realGetRandomValues; });
}

(async () => {
  const key = { raw: new Uint8Array(32).fill(3) };
  const bodies = [
    '',
    '# Kop\r\n\r\n* item\n* [ ] taak\n\n> citaat\n\n[link](https://example.org) **vet** _schuin_\n',
    '![bijlage](blob:https://app.example/1234)\n\n1. een\n2. twee\n',
    ...RENDER_VECTORS.map((v) => v.md).filter(Boolean),
  ];
  for (const body of bodies) {
    const note = {
      type: 'note', title: 'T', body, editor: 'markdown', tags: [], updated_at: '2026-01-01T00:00:00.000Z',
    };
    const snapshot = JSON.stringify(note);
    const before = await withFixedIv(() => NotesCrypto.encryptObject(key, note));

    // preview -> edit -> preview -> edit: the same action twice, as the toggle button does.
    for (let i = 0; i < 2; i += 1) {
      const html = NotesMarkdown.render(note.body);
      assert.strictEqual(typeof html, 'string');
      if (win) NotesSanitize.sanitizeRichHtml(html, win);
    }

    assert.strictEqual(JSON.stringify(note), snapshot, 'rendering mutated the note object');
    assert.strictEqual(note.updated_at, '2026-01-01T00:00:00.000Z', 'updated_at changed');
    const after = await withFixedIv(() => NotesCrypto.encryptObject(key, note));
    assert.deepStrictEqual(Object.keys(after).sort(), ['data', 'iv', 'v']);
    assert.strictEqual(after.v, before.v);
    assert.strictEqual(after.data, before.data, 'ciphertext changed after rendering');
    assert.strictEqual(after.iv, before.iv);
    const back = await NotesCrypto.decryptObject(key, after);
    assert.strictEqual(back.body, body, 'body not byte-identical after decrypt');
    assert.strictEqual(back.editor, 'markdown', 'note format changed');
    assert.strictEqual(back.updated_at, note.updated_at);
  }
  console.log(`ok (${bodies.length} bodies, ciphertext unchanged${win ? ', sanitizer ran' : ''})`);
})().catch((err) => { console.error(err); process.exit(1); });
