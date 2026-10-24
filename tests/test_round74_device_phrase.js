/**
 * Round 74: signed-in devices prefer device_phrase over hex suffix.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const phrasePy = fs.readFileSync(path.join(root, 'app/device_phrase.py'), 'utf8');

assert.ok(appJs.includes('device_phrase'), 'app.js reads device_phrase');
assert.ok(
  appJs.includes("prefer memorable device_phrase") ||
    appJs.includes('item?.device_phrase'),
  'formatDeviceRowName prefers phrase'
);

const fmt = appJs.split('function formatDeviceRowName')[1].split('function renderSignedInDevices')[0];
assert.ok(fmt.includes('device_phrase'), 'formatDeviceRowName uses device_phrase');
assert.ok(fmt.includes('device_id_suffix'), 'hex suffix remains as fallback');
// Phrase branch must come before suffix return.
assert.ok(
  fmt.indexOf('device_phrase') < fmt.indexOf('device_id_suffix'),
  'phrase checked before suffix'
);

assert.ok(phrasePy.includes('_ADJECTIVES'), 'word list present');
assert.ok(phrasePy.includes('_NOUNS'), 'noun list present');
assert.ok(phrasePy.includes('def device_phrase'), 'helper exported');

console.log('test_round74_device_phrase ok');
