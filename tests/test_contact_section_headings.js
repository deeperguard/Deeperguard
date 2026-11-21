const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Loads contactSectionHeading from app.js and checks the headings the Add contact form shows.
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'js', 'app.js'), 'utf8');
const start = src.indexOf('function contactSectionHeading(');
const end = src.indexOf('// One repeatable row', start);
assert.ok(start >= 0 && end > start, 'contactSectionHeading source not found');
const contactSectionHeading = new Function(`${src.slice(start, end)}; return contactSectionHeading;`)();

assert.strictEqual(contactSectionHeading('Phone'), 'Phones');
assert.strictEqual(contactSectionHeading('Email'), 'Emails');
assert.strictEqual(contactSectionHeading('Website'), 'Websites');
assert.strictEqual(contactSectionHeading('Address'), 'Addresses');

// The form uses CSS text-transform: uppercase on section labels, so check the uppercase text too.
assert.ok(['ADDRESS', 'ADDRESSES'].includes(contactSectionHeading('Address').toUpperCase()));

for (const noun of ['Phone', 'Email', 'Address', 'Website']) {
  const heading = contactSectionHeading(noun).toUpperCase();
  assert.ok(!/(.)\1\1/.test(heading), `heading "${heading}" repeats a letter three times`);
}
