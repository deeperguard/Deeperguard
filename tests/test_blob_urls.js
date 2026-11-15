// NotesBlobUrls: every created object URL is revoked with URL.revokeObjectURL
// on revoke() (viewer closes or switches) and revokeAll() (lock/logout).
const assert = require('assert');

const created = [];
const revoked = [];
let n = 0;
globalThis.URL.createObjectURL = () => { const u = `blob:test/${n += 1}`; created.push(u); return u; };
globalThis.URL.revokeObjectURL = (u) => { revoked.push(u); };
require('../app/static/js/blob-urls.js');

const { NotesBlobUrls } = globalThis;
const a = NotesBlobUrls.create({});
const b = NotesBlobUrls.create({});
assert.strictEqual(NotesBlobUrls.count(), 2);
NotesBlobUrls.revoke(a);
assert.deepStrictEqual(revoked, [a]);
assert.strictEqual(NotesBlobUrls.count(), 1);
NotesBlobUrls.revokeAll();
assert.deepStrictEqual(revoked, [a, b]);
assert.strictEqual(NotesBlobUrls.count(), 0);

// viewer wiring: closing and switching release enhance blob URLs, and the
// inline viewer destroys its controls (fullscreen listener, observer) when cleared
const fs = require('fs');
const path = require('path');
const appJs = fs.readFileSync(path.join(__dirname, '../app/static/js/app.js'), 'utf8');
function fnBody(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = appJs.indexOf('\n  function ', start + 10);
  return appJs.slice(start, next < 0 ? undefined : next);
}
assert.ok(/NotesBlobUrls\.revoke\(/.test(fnBody('releaseDocEnhanceObjects')), 'release helper revokes');
assert.ok(/releaseDocEnhanceObjects\(ui\.docStage\)/.test(fnBody('closeDocPreview')), 'close path revokes');
assert.ok(/releaseDocEnhanceObjects\(ui\.docStage\)/.test(fnBody('openDocPreview')), 'switch path revokes');
assert.ok(/_docControls\.destroy\(\)/.test(fnBody('resetDocInline')), 'inline reset destroys controls');
assert.strictEqual(appJs.split("ui.docInline.innerHTML = ''").length - 1, 1, 'only resetDocInline clears the inline viewer');
console.log('blob urls ok');
