// Drawings in notes (docs/DRAWING_SPEC.md): PNG validation, limits, encrypted-only storage.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const idb = new Map();
const blobs = new Map();

global.addEventListener = () => {};
global.window = global;
const mem = () => ({
  store: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
});
global.localStorage = mem();
global.sessionStorage = mem();
global.NotesIDB = {
  async putItem(row) { idb.set(row.uuid, JSON.parse(JSON.stringify(row))); },
  async deleteItem(uuid) { idb.delete(uuid); blobs.delete(uuid); },
  async loadItems() { return [...idb.values()]; },
  async iterateItems(fn) { for (const r of idb.values()) fn(r); },
  async getItem(uuid) { return idb.get(uuid) || null; },
  async putBlob(uuid, b) { blobs.set(uuid, b); },
  async getBlob(uuid) { return blobs.get(uuid) || ''; },
  async deleteBlob(uuid) { blobs.delete(uuid); },
  async getMeta() { return null; },
  async putMeta() {},
};
global.fetch = async () => ({ ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) });
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const Drawing = require(path.join(jsRoot, 'drawing.js'));
global.NotesDrawing = Drawing;
const NotesStore = require(path.join(jsRoot, 'store.js'));
const NotesPreview = require(path.join(jsRoot, 'preview.js'));

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, noise = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  const row = Buffer.alloc(w + 1);
  for (let i = 1; i <= w; i += 1) row[i] = noise ? (i * 31 + noise) & 0xff : 255;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
const pngBlob = (bytes) => ({
  type: 'image/png',
  size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

(async () => {
  // --- PNG validation: valid, invalid, too large ---
  const good = makePng(40, 30);
  assert.ok(good.length >= Drawing.MIN_PNG_BYTES);
  assert.deepStrictEqual(
    { ...Drawing.validatePng(good) },
    { ok: true, width: 40, height: 30, reason: '' },
  );
  assert.ok(Drawing.validatePng(good, { expectW: 40, expectH: 30 }).ok);
  assert.strictEqual(Drawing.validatePng(good, { expectW: 41, expectH: 30 }).reason, 'dimension-mismatch');
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(100, ' '));
  assert.strictEqual(Drawing.validatePng(svg).reason, 'bad-magic');
  assert.strictEqual(Drawing.validatePng(new TextEncoder().encode('<html>'.padEnd(100, ' '))).reason, 'bad-magic');
  assert.strictEqual(Drawing.validatePng(good.slice(0, 20)).reason, 'too-small');
  assert.strictEqual(Drawing.validatePng(null).ok, false);
  const badIhdr = good.slice();
  badIhdr[12] = 0x58;
  assert.strictEqual(Drawing.validatePng(badIhdr).reason, 'bad-ihdr');
  assert.strictEqual(Drawing.validatePng(makePng(2049, 2)).reason, 'bad-dimensions');
  assert.strictEqual(Drawing.validatePng(makePng(0, 2)).reason, 'bad-dimensions');
  const huge = new Uint8Array(Drawing.MAX_DRAWING_BYTES + 1);
  huge.set(good);
  assert.strictEqual(Drawing.validatePng(huge).reason, 'too-large');

  // --- limits ---
  assert.ok(Drawing.checkNoteLimits([], 1000).ok);
  const ten = Array.from({ length: 10 }, (_, i) => ({ uuid: `d${i}`, size: 10 }));
  assert.ok(!Drawing.checkNoteLimits(ten, 10).ok);
  assert.ok(Drawing.checkNoteLimits(ten, 10, 'd3').ok, 'replacing one does not add a drawing');
  assert.ok(!Drawing.checkNoteLimits([{ uuid: 'a', size: 8 * 1024 * 1024 - 5 }], 10).ok);
  assert.ok(Drawing.isDrawingMeta({ type: 'attachment', mime: 'image/png', drawing: { v: 1 } }));
  assert.ok(!Drawing.isDrawingMeta({ type: 'attachment', mime: 'image/svg+xml', drawing: { v: 1 } }));
  assert.ok(!Drawing.isDrawingMeta({ type: 'attachment', mime: 'image/png' }));
  assert.ok(!Drawing.canEditDrawing({ type: 'attachment', mime: 'image/png', drawing: { v: 2 } }));

  // --- store: only the encrypted payload carries the drawing ---
  await NotesStore.unlock('vault-password', 'salt-1');
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, NotesStore.defaultNote());
  const alt = 'geheime-keukenschets-42';
  const png = makePng(64, 48, 7);
  const id = await NotesStore.addDrawing(noteId, pngBlob(png), { alt });
  const att = NotesStore.get(id);
  assert.deepStrictEqual(att.content.drawing, { v: 1, w: 64, h: 48, alt });
  assert.strictEqual(att.content.mime, 'image/png');
  assert.strictEqual(att.content.ocr_method, '');
  assert.ok(NotesStore.get(noteId).content.attachments.includes(id));
  for (let i = 0; i < 40 && !idb.get(id)?.ciphertext; i += 1) await new Promise((r) => setImmediate(r));
  const row = idb.get(id);
  const rowJson = JSON.stringify(row);
  assert.ok(!rowJson.includes(alt), 'alt text must not be readable in the stored row');
  assert.ok(!rowJson.includes('"drawing"'), 'drawing metadata must not be a plaintext field');
  assert.ok(!rowJson.includes('"w"'));
  const inner = await NotesCrypto.decryptObject(NotesStore.state.cryptoKey, JSON.parse(row.ciphertext));
  assert.deepStrictEqual(inner.drawing, { v: 1, w: 64, h: 48, alt }, 'drawing field survives wrap/unwrap');
  const blobJson = blobs.get(id);
  assert.ok(blobJson && !blobJson.includes(Buffer.from(png.slice(0, 8)).toString('latin1')));
  const back = await NotesStore.getAttachmentBytes(id);
  assert.deepStrictEqual(Array.from(back), Array.from(png));

  // oldest-client view: still an ordinary image attachment
  assert.strictEqual(NotesPreview.kindFromMeta(att.content.mime, att.content.filename), 'image');

  // non-PNG and oversized are refused
  await assert.rejects(() => NotesStore.addDrawing(noteId, { type: 'image/svg+xml', size: 5, arrayBuffer: async () => new ArrayBuffer(5) }), /PNG/);
  await assert.rejects(() => NotesStore.addDrawing(noteId, pngBlob(svg)), /Ongeldige tekening/);
  await assert.rejects(() => NotesStore.addDrawing(noteId, pngBlob(huge)), /Tekening te groot/);

  // edit: same uuid, new bytes
  const png2 = makePng(64, 48, 9);
  await NotesStore.replaceAttachmentBytes(id, pngBlob(png2), { alt: 'nieuw' });
  assert.strictEqual(NotesStore.get(id).content.drawing.alt, 'nieuw');
  assert.deepStrictEqual(Array.from(await NotesStore.getAttachmentBytes(id)), Array.from(png2));
  assert.strictEqual(NotesStore.listAttachments(noteId).length, 1);

  // --- source hygiene: no innerHTML with drawing content, no network ---
  const src = fs.readFileSync(path.join(jsRoot, 'drawing.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(|XMLHttpRequest/.test(src));
  const appSrc = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
  const block = appSrc.slice(appSrc.indexOf('function decorateDrawings'), appSrc.indexOf('async function addDrawingToNote'));
  assert.ok(block.length > 200 && !/innerHTML/.test(block));

  // --- CSP untouched ---
  const auth = fs.readFileSync(path.join(__dirname, '..', 'app', 'auth.py'), 'utf8');
  assert.ok(auth.includes("img-src 'self' data: blob:"));
  console.log('drawing tests ok');
})().catch((err) => { console.error(err); process.exit(1); });
