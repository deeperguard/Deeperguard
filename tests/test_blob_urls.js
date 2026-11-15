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
console.log('blob urls ok');
