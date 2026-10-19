const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { install } = require('./domstub.js');

install();

const root = path.join(__dirname, '..');
const previewSrc = fs.readFileSync(path.join(root, 'app/static/js/preview.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const ocrJs = fs.readFileSync(path.join(root, 'app/static/js/client-ocr-engine.js'), 'utf8');
const ocrPy = fs.readFileSync(path.join(root, 'app/ocr.py'), 'utf8');

const { pageBitmapScale } = require('../app/static/js/preview.js');

global.devicePixelRatio = 1;
assert.strictEqual(pageBitmapScale(), 2);
global.devicePixelRatio = 2;
assert.strictEqual(pageBitmapScale(), 2);
global.devicePixelRatio = 3;
assert.strictEqual(pageBitmapScale(), 3);
global.devicePixelRatio = 4;
assert.strictEqual(pageBitmapScale(), 3);

assert.ok(previewSrc.includes('const MAX_PAGE_DPR = 3'));
assert.ok(previewSrc.includes('Math.max(2, dpr)'));
assert.ok(previewSrc.includes('deferSwap: true'));
assert.ok(previewSrc.includes('keepBaseWidth: true'));
assert.ok(!previewSrc.includes('img.src = canvas.toDataURL'));
assert.ok(previewSrc.includes('paint.renderedWidth = paint.naturalWidth'));

assert.ok(appJs.includes('const THUMB_CSS_PX = 72'));
assert.ok(appJs.includes('Math.round(THUMB_CSS_PX * scale)'));
assert.ok(appJs.includes('Math.max(720, thumbOutputPx() * 2)'));
assert.ok(appJs.includes('Math.max(thumbOutputPx(), stageWidth || THUMB_CSS_PX)'));
assert.ok(appJs.includes("canvas.toBlob(resolve, 'image/jpeg', 0.92)"));
assert.ok(appJs.includes("canvas.toBlob(resolve, 'image/png')"));
assert.ok(appJs.includes('dataset.fullResolution = \'1\''));
assert.ok(appJs.includes('NotesPreview.upgradePdfQuality(stage, scale)'));
assert.ok(appJs.includes('NotesPreview.upgradePdfQuality(stage, stage._docZoom?.getScale?.() || 1)'));
const pdfThumb = appJs.slice(appJs.indexOf("if (entry.kind === 'pdf')"), appJs.indexOf("if (entry.kind === 'text')"));
assert.ok(pdfThumb.includes('renderPdfPage(doc, 1, width)'));

assert.ok(css.includes('width: 72px'));
assert.ok(css.includes('height: 72px'));
assert.ok(css.includes('object-fit: contain'));
assert.ok(css.includes('image-rendering: auto'));
assert.ok(!css.includes('image-rendering: pixelated'));

assert.ok(ocrJs.includes('const LIST_PREVIEW_PX = 432'));
assert.ok(ocrJs.includes('const LIST_PREVIEW_QUALITY = 0.92'));
assert.ok(ocrJs.includes('doc.getPage(1)'));
assert.ok(ocrPy.includes('LIST_PREVIEW_PX = 432'));
assert.ok(ocrPy.includes('LIST_PREVIEW_JPEG_QUALITY = 92'));
assert.ok(ocrPy.includes('"-r"') && ocrPy.includes('"144"'));

console.log('ok');
