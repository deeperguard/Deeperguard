const assert = require('assert');
const {
  ocrResultWeak,
  normalizeOcrStorage,
  ocrReadableWordCount,
} = require('../app/static/js/ocr-quality.js');

const gibberish = '~ id = oT JA "EE Ha fo Ea oa go i : i F3 a 4 \\ i) Pc [ | or i | BS mr SR.';
assert.ok(
  ocrResultWeak(gibberish, [], 'image/jpeg', 'image.jpg'),
  'photo gibberish should be treated as weak OCR',
);
assert.strictEqual(
  normalizeOcrStorage(gibberish, [], 'image/jpeg', 'image.jpg').method,
  'none',
);
assert.strictEqual(
  normalizeOcrStorage(gibberish, [], 'image/jpeg', 'image.jpg').text,
  '',
);

assert.ok(
  ocrReadableWordCount('Invoice number 12345 due April') >= 2,
  'real invoice text should have readable words',
);
assert.ok(
  !ocrResultWeak('Invoice number 12345 due April', [], 'image/jpeg', 'scan.jpg'),
  'real invoice text should not be weak',
);

assert.strictEqual(
  normalizeOcrStorage('Vehicle registration expires June', [], 'application/pdf', 'doc.pdf').text,
  'Vehicle registration expires June',
);

const dutchInvoice = 'Factuur 2024-001 Airco installatie BTW 21% Totaal';
assert.ok(
  !ocrResultWeak(dutchInvoice, [], 'application/pdf', 'airco-factuur.pdf', 'weak'),
  'Dutch PDF invoice text should not be discarded on weak engine hint alone',
);
assert.strictEqual(
  normalizeOcrStorage(dutchInvoice, [], 'application/pdf', 'airco-factuur.pdf', 'weak', 'tesseract').text,
  dutchInvoice,
);
assert.strictEqual(
  normalizeOcrStorage('Embedded invoice text with enough readable words here', [], 'application/pdf', 'doc.pdf', 'weak', 'pdftext').text,
  'Embedded invoice text with enough readable words here',
);

console.log('ok');
