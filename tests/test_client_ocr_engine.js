const assert = require('assert');
const {
  ocrPickScore,
  chooseBetterOcr,
  weakOcrResult,
  wasmSimdSupported,
  tesseractCoreFile,
} = require('../app/static/js/client-ocr-engine.js');

const weak = { text: '~ id oT JA EE', boxes: [] };
const strong = { text: 'Factuur 2024 Airco installatie BTW 21%', boxes: [{ text: 'Factuur' }] };

assert.ok(ocrPickScore(strong.text, strong.boxes) > ocrPickScore(weak.text, weak.boxes), 'readable text should score higher');
assert.strictEqual(chooseBetterOcr(weak, strong).text, strong.text, 'chooseBetterOcr should prefer readable text');
assert.ok(!weakOcrResult(strong.text, strong.boxes), 'invoice-like text should not be weak');

const core = tesseractCoreFile();
assert.ok(core === 'tesseract-core-simd.wasm.js' || core === 'tesseract-core.wasm.js');
if (wasmSimdSupported()) assert.strictEqual(core, 'tesseract-core-simd.wasm.js');

console.log('ok');
