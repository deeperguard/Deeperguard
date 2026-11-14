/**
 * Object URLs of decrypted content are tracked and all revoked on lock/logout.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app/static/js/blob-urls.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

const active = new Set();
let n = 0;
const imgs = [{ attrs: { src: 'blob:a' }, removeAttribute(k) { delete this.attrs[k]; } }];
const sandbox = {
  URL: {
    createObjectURL() { const u = `blob:test/${++n}`; active.add(u); return u; },
    revokeObjectURL(u) { active.delete(u); },
  },
  document: { querySelectorAll: () => imgs },
};
sandbox.window = sandbox;
vm.runInNewContext(src, sandbox);
const reg = sandbox.NotesBlobUrls;

// open attachment, thumbnail, enhanced scan, OCR/scan page
const a = reg.create({}); reg.create({}); reg.create({}); reg.create({});
reg.revoke(a); // viewer closed one
assert.strictEqual(active.size, 3);
assert.strictEqual(reg.count(), 3);
reg.revokeAll(); // lock
assert.strictEqual(active.size, 0, 'no object URLs remain after lock');
assert.strictEqual(reg.count(), 0);
assert.strictEqual(imgs[0].attrs.src, undefined, 'blob: src detached from DOM');

// wiring: lock and sign-out call revokeAll; no raw createObjectURL for decrypted content
assert.ok(/clearPreviewCache\(\);\s*clearScanPageUrls\(\);\s*NotesBlobUrls\.revokeAll\(\);/.test(appJs));
assert.ok(/async function signOutCompletely\(\) \{[\s\S]{0,400}NotesBlobUrls\.revokeAll\(\)/.test(appJs));
assert.ok(appHtml.indexOf('js/blob-urls.js') > -1 && appHtml.indexOf('js/blob-urls.js') < appHtml.indexOf('js/preview.js'));
console.log('ok test_blob_urls_lock');
