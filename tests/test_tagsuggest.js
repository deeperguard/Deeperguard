const assert = require('assert');
const { suggest } = require('../app/static/js/tagsuggest.js');

const invoiceText = 'Invoice 1042 from Acme Plumbing. Total due $120. Thank you for your business.';
const tags = [
  { uuid: 't-home', content: { title: 'Home' } },
  { uuid: 't-inv', content: { title: 'Invoice' } },
];

const hit = suggest(invoiceText, tags);
assert.strictEqual(hit.existing, true);
assert.strictEqual(hit.tagId, 't-inv');
assert.strictEqual(hit.title, 'Invoice');

const invented = suggest('Quarterly water meter reading for the garden tap', []);
assert.strictEqual(invented.existing, false);
assert.ok(invented.title);
assert.match(invented.title, /[A-Za-z]/);

const fromName = suggest('', [], { filename: 'passport-scan.jpg' });
assert.strictEqual(fromName.existing, false);
assert.strictEqual(fromName.title, 'Passport');

console.log('ok');
