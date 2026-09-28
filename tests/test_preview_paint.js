const assert = require('assert');
const { install } = require('./domstub.js');

install();

const NotesPreview = require('../app/static/js/preview.js');

function makeImageWrap(boxes, query) {
  const img = document.createElement('img');
  img.naturalWidth = 1200;
  img.naturalHeight = 1600;
  img.complete = true;
  return NotesPreview.wrapMediaWithHits(img, boxes, query);
}

const spacedGlyphs = [
  { str: 'PL', transform: [1, 0, 0, 10, 10, 20], width: 16, height: 10 },
  { str: 'AG', transform: [1, 0, 0, 10, 40, 20], width: 16, height: 10 },
];
assert.ok(
  NotesPreview.matchTextItems(spacedGlyphs, 'PLAG').size >= 1,
  'pdf.js glyphs with a gap must still match a tight search word',
);

const invoiceBoxes = [
  { text: 'Le', l: 0.1, t: 0.33, w: 0.02, h: 0.008, page: 0 },
  { text: 'ha', l: 0.13, t: 0.33, w: 0.02, h: 0.008, page: 0 },
  { text: 'atendido', l: 0.16, t: 0.33, w: 0.05, h: 0.008, page: 0 },
  { text: 'Irene', l: 0.22, t: 0.33, w: 0.03, h: 0.008, page: 0 },
  { text: 'Rodriguez', l: 0.26, t: 0.33, w: 0.06, h: 0.008, page: 0 },
];

const wrap = makeImageWrap(invoiceBoxes, 'Rodri');
const hits = wrap.querySelectorAll('.doc-search-hit');
assert.strictEqual(hits.length, 1, 'expected one painted highlight');

const hit = hits[0];
assert.strictEqual(hit.style.left, '26%');
const hitTop = parseFloat(hit.style.top);
const hitHeight = parseFloat(hit.style.height);
assert.ok(hitTop >= 33 && hitTop <= 34, `highlight should cover the word, got top ${hitTop}%`);
assert.ok(hitHeight >= 1 && hitHeight <= 2, `highlight height should match the word box, got ${hitHeight}%`);

const widthPct = parseFloat(hit.style.width);
assert.ok(widthPct > 0 && widthPct <= 12, `highlight width should track the word, got ${widthPct}%`);

const tiny = makeImageWrap([{ text: 'I', l: 0.5, t: 0.5, w: 0.0001, h: 0.0001, page: 0 }], 'I');
const tinyHit = tiny.querySelector('.doc-search-hit');
assert.ok(parseFloat(tinyHit.style.width) >= 0.5, 'tiny words still get a visible minimum highlight width');
const tinyHeight = parseFloat(tinyHit.style.height);
assert.ok(tinyHeight >= 1, `tiny highlights still get a minimum height, got ${tinyHeight}%`);

const stage = document.createElement('div');
stage.appendChild(makeImageWrap(invoiceBoxes, 'Rodri'));
assert.strictEqual(NotesPreview.repaintAllSearchHits(stage, invoiceBoxes, 'Rodri'), 1);
assert.strictEqual(stage.querySelectorAll('.doc-search-hit').length, 1);

const pdfWrap = document.createElement('div');
pdfWrap.className = 'doc-page-wrap';
const canvas = document.createElement('canvas');
canvas.className = 'doc-page';
canvas.width = 900;
canvas.height = 1200;
pdfWrap.appendChild(canvas);
NotesPreview.rememberPdfHits(pdfWrap, [{ l: 0.2, t: 0.4, w: 0.08, h: 0.01 }]);
assert.strictEqual(NotesPreview.countStoredSearchHits(pdfWrap), 1, 'stored PDF rects count before paint');
const pdfStage = document.createElement('div');
pdfStage.appendChild(pdfWrap);

assert.strictEqual(
  NotesPreview.repaintAllSearchHits(pdfStage, [], 'Rodri'),
  1,
  'embedded PDF text highlights must survive a repaint with no OCR boxes',
);
assert.strictEqual(pdfStage.querySelectorAll('.doc-search-hit').length, 1);

assert.strictEqual(
  NotesPreview.repaintAllSearchHits(pdfStage, invoiceBoxes, 'Rodri'),
  1,
  'embedded PDF text hits take priority over OCR boxes on the same page',
);
assert.strictEqual(pdfStage.querySelectorAll('.doc-search-hit').length, 1);

const identityViewport = { convertToViewportPoint: (x, y) => [x, y] };
const repeatGlyphs = [
  { str: 'foo', transform: [1, 0, 0, 10, 10, 20], width: 20, height: 10 },
  { str: ' bar ', transform: [1, 0, 0, 10, 40, 20], width: 30, height: 10 },
  { str: 'foo', transform: [1, 0, 0, 10, 80, 20], width: 20, height: 10 },
];
const repeatRects = NotesPreview.pdfTextHitRects(identityViewport, repeatGlyphs, 'foo', 900, 1200);
assert.strictEqual(repeatRects.length, 2, 'every PDF text match should get its own underline');
repeatRects.forEach((rect, i) => {
  assert.ok(rect.l >= 0 && rect.l <= 1, `rect ${i} left must be on-page, got ${rect.l}`);
  assert.ok(rect.l + rect.w <= 1.02, `rect ${i} must not spill off-page, got l=${rect.l} w=${rect.w}`);
});

const pdfJsViewport = {
  width: 595 * 2,
  height: 842 * 2,
  transform: [2, 0, 0, -2, 0, 842 * 2],
  convertToViewportPoint(x, y) {
    return [2 * x, (842 * 2) - 2 * y];
  },
};
const letterItems = [
  { str: 'de heer D. Example', width: 120, height: 12, transform: [12, 0, 0, 12, 72, 700] },
  { str: 'Geachte heer Example,', width: 140, height: 12, transform: [12, 0, 0, 12, 72, 600] },
];
const letterRects = NotesPreview.pdfTextHitRects(
  pdfJsViewport,
  letterItems,
  'Example',
  pdfJsViewport.width,
  pdfJsViewport.height,
);
assert.strictEqual(letterRects.length, 2, 'Example should produce two on-page PDF hits');
letterRects.forEach((rect, i) => {
  assert.ok(rect.l >= 0.1 && rect.l <= 0.5, `Example hit ${i} should sit in the left margin, got l=${rect.l}`);
  assert.ok(rect.w > 0.02 && rect.w < 0.2, `Example hit ${i} should be word-sized, got w=${rect.w}`);
});

const repeatBoxes = [
  { text: 'tax', l: 0.1, t: 0.2, w: 0.03, h: 0.01, page: 0 },
  { text: 'and', l: 0.14, t: 0.2, w: 0.03, h: 0.01, page: 0 },
  { text: 'tax', l: 0.18, t: 0.2, w: 0.03, h: 0.01, page: 0 },
];
assert.strictEqual(NotesPreview.ocrHitRects(repeatBoxes, 'tax', 0).length, 2, 'every OCR match should get its own underline');

const ocrOnlyWrap = document.createElement('div');
ocrOnlyWrap.className = 'doc-page-wrap';
const ocrCanvas = document.createElement('canvas');
ocrCanvas.className = 'doc-page';
ocrCanvas.width = 900;
ocrCanvas.height = 1200;
ocrOnlyWrap.appendChild(ocrCanvas);
const ocrOnlyStage = document.createElement('div');
ocrOnlyStage.appendChild(ocrOnlyWrap);
assert.strictEqual(
  NotesPreview.repaintAllSearchHits(ocrOnlyStage, invoiceBoxes, 'Rodri'),
  1,
  'OCR boxes still paint when a page has no embedded PDF text hits',
);
assert.ok(
  !ocrCanvas.ops.some((op) => op[0] === 'fill' || op[0] === 'stroke'),
  'search highlights must not paint over the PDF pixels',
);
assert.ok(
  !ocrOnlyWrap.querySelector('.doc-hit-canvas'),
  'search highlights use DOM underlines only',
);
assert.ok(
  !ocrCanvas.ops.some((op) => op[0] === 'fill' || op[0] === 'stroke'),
  'search highlights must not paint over the PDF pixels',
);

const emptyStage = document.createElement('div');
emptyStage.appendChild(makeImageWrap(invoiceBoxes, 'Rodri'));
assert.strictEqual(NotesPreview.repaintAllSearchHits(emptyStage, [], 'nomatch'), 0);
assert.strictEqual(emptyStage.querySelectorAll('.doc-search-hit').length, 0);

// A match on a later page sits far below the fold, inside two nested scrollers.
// Centring only the inner one leaves it off screen, which reads as "no highlight".
global.innerHeight = 400;

const editor = document.createElement('div');
editor.style.overflowY = 'auto';
editor.layoutTop = 0;
editor.layoutHeight = 400;
editor.clientHeight = 400;
editor.scrollHeight = 1000;

const docInline = document.createElement('div');
docInline.className = 'doc-inline';
docInline.style.overflowY = 'auto';
docInline.layoutTop = 150;
docInline.layoutHeight = 330;
docInline.clientHeight = 330;
docInline.scrollHeight = 800;
editor.appendChild(docInline);
document.body.appendChild(editor);

const pageOne = document.createElement('div');
pageOne.className = 'doc-page-wrap';
const pageTwo = document.createElement('div');
pageTwo.className = 'doc-page-wrap';
docInline.appendChild(pageOne);
docInline.appendChild(pageTwo);

const layer = document.createElement('div');
layer.className = 'doc-text-layer';
pageTwo.appendChild(layer);
const lateHit = document.createElement('span');
lateHit.className = 'doc-search-hit';
lateHit.layoutTop = 1032;
lateHit.layoutHeight = 10;
layer.appendChild(lateHit);

const summary = NotesPreview.hitSummary(docInline);
assert.deepStrictEqual(summary, { count: 1, page: 2, pages: 2 });
assert.ok(!NotesPreview.hitIsOnScreen(docInline), 'hit starts below the fold');

NotesPreview.scrollFirstHitIntoView(docInline);
assert.ok(
  NotesPreview.hitIsOnScreen(docInline),
  `highlight must end up on screen, got top ${lateHit.getBoundingClientRect().top}`,
);
assert.ok(docInline.scrollTop > 0, 'inner document scroller moved');
assert.ok(editor.scrollTop > 0, 'outer editor scroller also moved');

// Multi-page PDF: jumping to a hit on page 2 must scroll that page into view.
const multiPageStage = document.createElement('div');
multiPageStage.className = 'doc-stage';
multiPageStage.style.overflowY = 'auto';
multiPageStage.layoutTop = 0;
multiPageStage.layoutHeight = 400;
multiPageStage.clientHeight = 400;
multiPageStage.scrollHeight = 2400;
document.body.appendChild(multiPageStage);

const pdfPageOne = document.createElement('div');
pdfPageOne.className = 'doc-page-wrap';
pdfPageOne.style.height = '1000px';
const pdfPageTwo = document.createElement('div');
pdfPageTwo.className = 'doc-page-wrap';
pdfPageTwo.style.height = '1000px';
multiPageStage.appendChild(pdfPageOne);
multiPageStage.appendChild(pdfPageTwo);

const pdfLayer = document.createElement('div');
pdfLayer.className = 'doc-text-layer';
pdfPageTwo.appendChild(pdfLayer);
const hitOne = document.createElement('span');
hitOne.className = 'doc-search-hit';
hitOne.style.top = '20%';
hitOne.style.height = '2%';
hitOne.layoutTop = 1200;
hitOne.layoutHeight = 10;
pdfLayer.appendChild(hitOne);
const hitTwo = document.createElement('span');
hitTwo.className = 'doc-search-hit';
hitTwo.style.top = '40%';
hitTwo.style.height = '2%';
hitTwo.layoutTop = 1280;
hitTwo.layoutHeight = 10;
pdfLayer.appendChild(hitTwo);

assert.ok(!NotesPreview.hitIsOnScreen(multiPageStage, 1), 'second-page hit starts off screen');
assert.ok(NotesPreview.scrollHitIntoViewSettled(multiPageStage, 1), 'scroll to second hit on later page');
assert.ok(NotesPreview.hitIsOnScreen(multiPageStage, 1), 'second-page hit ends on screen');
assert.ok(multiPageStage.scrollTop > 500, 'pdf stage scrolled to later page');
assert.ok(hitTwo.classList.contains('doc-search-hit-current'), 'active hit is marked current');

const inlineHost = document.createElement('div');
inlineHost.className = 'doc-inline';
const card = document.createElement('div');
card.className = 'doc-inline-card';
const inlineStage = document.createElement('div');
inlineStage.className = 'doc-inline-stage';
card.appendChild(inlineStage);
inlineHost.appendChild(card);
assert.strictEqual(NotesPreview.hitNoteHost(inlineStage), inlineHost);

const viewer = document.createElement('div');
viewer.className = 'doc-viewer';
const head = document.createElement('header');
head.className = 'doc-viewer-head';
const docStage = document.createElement('div');
docStage.className = 'doc-stage';
viewer.appendChild(head);
viewer.appendChild(docStage);
const page = document.createElement('div');
assert.strictEqual(NotesPreview.hitNoteHost(docStage), viewer);
assert.notStrictEqual(NotesPreview.hitNoteHost(docStage), page);

const zoomViewport = document.createElement('div');
zoomViewport.clientWidth = 400;
zoomViewport.clientHeight = 600;
zoomViewport.scrollLeft = 0;
zoomViewport.scrollTop = 0;
const zoomPage = document.createElement('div');
zoomPage.className = 'doc-page-wrap';
zoomPage.scrollHeight = 800;
zoomViewport.appendChild(zoomPage);
const zoomApi = NotesPreview.enablePinchZoom(zoomViewport);
assert.strictEqual(zoomApi.getScale(), 1);
assert.strictEqual(zoomApi.zoomIn(), 1.5);
assert.strictEqual(zoomApi.getScale(), 1.5);
zoomApi.refresh();
assert.strictEqual(zoomApi.getScale(), 1.5);
assert.strictEqual(zoomApi.zoomOut(), 1);
zoomApi.zoomIn();
zoomApi.reset();
assert.strictEqual(zoomApi.getScale(), 1);
assert.ok(zoomApi.zoomOut() < 1);
assert.ok(zoomApi.getScale() >= 0.4);

const dtViewport = document.createElement('div');
dtViewport.clientWidth = 400;
dtViewport.clientHeight = 600;
dtViewport.scrollLeft = 0;
dtViewport.scrollTop = 0;
dtViewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600 });
const dtPage = document.createElement('div');
dtPage.className = 'doc-page-wrap';
dtPage.scrollWidth = 400;
dtPage.scrollHeight = 800;
dtViewport.appendChild(dtPage);
const dtApi = NotesPreview.enablePinchZoom(dtViewport);
function fireTouchEnd(viewport, x, y) {
  const touch = { clientX: x, clientY: y };
  const event = {
    touches: [],
    changedTouches: [touch],
    preventDefault() { event.defaultPrevented = true; },
    defaultPrevented: false,
  };
  (viewport.listeners.touchend || []).forEach((fn) => fn(event));
  return event;
}
fireTouchEnd(dtViewport, 120, 140);
fireTouchEnd(dtViewport, 125, 145);
assert.ok(dtApi.getScale() > 2, `double-tap should zoom in, got ${dtApi.getScale()}`);
dtApi.destroy();

console.log('ok');
