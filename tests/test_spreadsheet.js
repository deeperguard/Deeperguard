const assert = require('assert');
const NotesSpreadsheet = require('../app/static/js/spreadsheet.js');

const payload = '{"activeSheet":"Sheet1","sheets":[{"name":"Sheet1","rows":[{"index":0,"cells":[{"value":"Date","index":0},{"value":"Amount","index":1}]},{"index":1,"cells":[{"value":"2026-01-01","index":0},{"value":"42","index":1}]}]}]}';

assert.ok(NotesSpreadsheet.isPayload(payload));
const html = NotesSpreadsheet.renderPreview(payload);
assert.match(html, /spreadsheet-table/);
assert.match(html, /Date/);
assert.match(html, /View source/);
assert.doesNotMatch(html, /"index":0,"cells"/);

console.log('ok');
