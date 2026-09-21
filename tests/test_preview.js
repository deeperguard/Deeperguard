const assert = require('assert');
const { install } = require('./domstub.js');

install();

const {
  kindFromMeta,
  resolveKind,
  looksLikeTextBytes,
  mimeFromMeta,
  decodeText,
  renderTextPreview,
  listSearchHits,
  ensurePdf,
  openPdf,
  enablePinchZoom,
  upgradePdfQuality,
  upgradeImageQuality,
  rememberImagePaint,
  fileFromBytes,
  matchTextItems,
  pdfTextHitRects,
  matchOcrBoxes,
  matchOcrBoxesLoose,
  boxesMatchQuery,
} = require('../app/static/js/preview.js');

assert.strictEqual(typeof ensurePdf, 'function');
assert.strictEqual(typeof openPdf, 'function');
assert.strictEqual(typeof enablePinchZoom, 'function');
assert.strictEqual(typeof upgradePdfQuality, 'function');
assert.strictEqual(typeof upgradeImageQuality, 'function');
assert.strictEqual(typeof rememberImagePaint, 'function');
assert.strictEqual(typeof fileFromBytes, 'function');
assert.strictEqual(mimeFromMeta('', 'scan.pdf'), 'application/pdf');
assert.strictEqual(mimeFromMeta('image/jpeg', 'scan.jpg'), 'image/jpeg');
const zoom = enablePinchZoom(null);
assert.strictEqual(typeof zoom.reset, 'function');
assert.strictEqual(typeof zoom.destroy, 'function');
assert.strictEqual(typeof zoom.zoomIn, 'function');
assert.strictEqual(typeof zoom.zoomOut, 'function');
assert.strictEqual(zoom.getScale(), 1);

assert.strictEqual(kindFromMeta('image/jpeg', 'scan.jpg'), 'image');
assert.strictEqual(kindFromMeta('image/png', ''), 'image');
assert.strictEqual(kindFromMeta('', 'photo.WEBP'), 'image');
assert.strictEqual(kindFromMeta('application/pdf', 'invoice.pdf'), 'pdf');
assert.strictEqual(kindFromMeta('', 'form.PDF'), 'pdf');
assert.strictEqual(kindFromMeta('text/plain', 'notes.txt'), 'text');
assert.strictEqual(kindFromMeta('', 'readme.md'), 'text');
assert.strictEqual(kindFromMeta('application/zip', 'files.zip'), 'other');
assert.strictEqual(kindFromMeta('', 'unknown.bin'), 'other');

assert.strictEqual(decodeText(new TextEncoder().encode('Invoice 42')), 'Invoice 42');

const utf16le = new Uint8Array([0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00]);
assert.strictEqual(decodeText(utf16le), 'Hi');

const utf8Bom = new Uint8Array([0xEF, 0xBB, 0xBF, 0x48, 0x69]);
assert.strictEqual(decodeText(utf8Bom), 'Hi');

assert.strictEqual(kindFromMeta('application/octet-stream', 'fans 1a txt'), 'other');
assert.strictEqual(
  resolveKind('application/octet-stream', 'fans 1a txt', new TextEncoder().encode('Line one\nLine two')),
  'text',
);
assert.ok(looksLikeTextBytes(new TextEncoder().encode('plain text file')));

const textStage = document.createElement('div');
global.NotesSearch = require('../app/static/js/search.js');
renderTextPreview(textStage, new TextEncoder().encode('Alpha\nBeta'), 'Beta');
const pre = textStage.children[0];
assert.strictEqual(pre.tagName, 'PRE');
assert.ok(String(pre.innerHTML).includes('search-hit'));
assert.ok(String(pre.innerHTML).includes('Beta'));

const hits = matchTextItems([{ str: 'Inv' }, { str: 'oice 42' }, { str: ' paid' }], 'invoice');
assert.ok(hits.has(0));
assert.ok(hits.has(1));
assert.ok(!hits.has(2));
assert.strictEqual(matchTextItems([{ str: 'Hello' }], 'xyz').size, 0);
const wordRects = pdfTextHitRects({
  convertToViewportPoint: (x, y) => [x, 800 - y],
}, [{
  str: 'Eerdere analyse toonde FAM110B-PLAG1 fusie',
  width: 320,
  height: 12,
  transform: [1, 0, 0, 12, 30, 80],
}], 'PLAG', 600, 800);
assert.strictEqual(wordRects.length, 1);
assert.ok(wordRects[0].w < 0.08, `PLAG box must be word-sized, got ${wordRects[0].w}`);
assert.ok(wordRects[0].l > 0.3, `PLAG box must start inside the text line, got ${wordRects[0].l}`);
assert.ok(wordRects[0].l + wordRects[0].w <= 1.02, `PLAG box must stay on-page, got l=${wordRects[0].l} w=${wordRects[0].w}`);
assert.ok(wordRects[0].t > 0.8, `PLAG box must sit on the flipped text line, got ${wordRects[0].t}`);
assert.ok(wordRects[0].h < 0.02, `PLAG box height should match the word ascent, got ${wordRects[0].h}`);

const phrase = matchTextItems([
  { str: 'Invoice', width: 40, height: 10, transform: [1, 0, 0, 1, 0, 0] },
  { str: '42', width: 16, height: 10, transform: [1, 0, 0, 1, 52, 0] },
], 'invoice 42');
assert.ok(phrase.has(0));
assert.ok(phrase.has(1));

const ocrHits = matchOcrBoxes([
  { text: 'Invoice', l: 0.1, t: 0.2, w: 0.2, h: 0.05, page: 0 },
  { text: '42', l: 0.32, t: 0.2, w: 0.08, h: 0.05, page: 0 },
  { text: 'paid', l: 0.1, t: 0.3, w: 0.1, h: 0.05, page: 0 },
], 'invoice 42', 0);
assert.strictEqual(ocrHits.length, 2);
assert.strictEqual(ocrHits[0].text, 'Invoice');
assert.strictEqual(ocrHits[1].text, '42');
assert.strictEqual(matchOcrBoxes(ocrHits, 'invoice', null).length, 1);
assert.strictEqual(matchOcrBoxes([{ text: 'registration', l: 0.1, t: 0.2, w: 0.2, h: 0.05, page: 0 }], 'reg', 0).length, 1);
assert.strictEqual(matchOcrBoxesLoose([
  { text: 'Vehicle', l: 0.1, t: 0.2, w: 0.1, h: 0.05, page: 0 },
  { text: 'registration', l: 0.22, t: 0.2, w: 0.12, h: 0.05, page: 0 },
], 'vehicle reg', 0).length, 2);
assert.strictEqual(boxesMatchQuery([
  { text: 'Invoice', l: 0.1, t: 0.2, w: 0.2, h: 0.05, page: 0 },
  { text: '42', l: 0.32, t: 0.2, w: 0.08, h: 0.05, page: 0 },
], 'invoice', 0), true);
assert.strictEqual(boxesMatchQuery([
  { text: 'Invoice', l: 0.1, t: 0.2, w: 0.2, h: 0.05, page: 0 },
], 'xyz', 0), false);

console.log('ok');
