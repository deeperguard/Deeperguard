/** Round 49 L1/L2 asset and escapeAttr checks. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pdfVer = fs.readFileSync(path.join(root, 'app/static/js/vendor/pdfjs/.pdfjs-ver'), 'utf8').trim();
const jspdfVer = fs.readFileSync(path.join(root, 'app/static/js/vendor/jspdf/.jspdf-ver'), 'utf8').trim();
assert.ok(pdfVer && !pdfVer.startsWith('3.'), `pdf.js should be 4.x+, got ${pdfVer}`);
assert.ok(jspdfVer && Number(jspdfVer.split('.')[0]) >= 3, `jsPDF should be 3.x+, got ${jspdfVer}`);

const pdfMjs = path.join(root, 'app/static/js/vendor/pdfjs/pdf.min.mjs');
const workerMjs = path.join(root, 'app/static/js/vendor/pdfjs/pdf.worker.min.mjs');
assert.ok(fs.existsSync(pdfMjs), 'pdf.min.mjs missing');
assert.ok(fs.existsSync(workerMjs), 'pdf.worker.min.mjs missing');
assert.ok(!fs.existsSync(path.join(root, 'app/static/js/vendor/pdfjs/pdf.min.js')), 'old UMD pdf.min.js should be gone');

const preview = fs.readFileSync(path.join(root, 'app/static/js/preview.js'), 'utf8');
assert.match(preview, /pdf\.min\.mjs/);
assert.match(preview, /isEvalSupported:\s*false/);

const ocr = fs.readFileSync(path.join(root, 'app/static/js/client-ocr-engine.js'), 'utf8');
assert.match(ocr, /pdf\.min\.mjs/);
assert.match(ocr, /isEvalSupported:\s*false/);

const sheet = fs.readFileSync(path.join(root, 'app/static/js/spreadsheet.js'), 'utf8');
assert.match(sheet, /function escapeAttr/);
assert.match(sheet, /data-sheet="\$\{escapeAttr\(name\)\}"/);

const md = fs.readFileSync(path.join(root, 'app/static/js/markdown.js'), 'utf8');
assert.match(md, /const safeLang = escapeAttr\(fence\.lang\)/);

console.log('ok round49 assets');
