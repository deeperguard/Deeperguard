/**
 * Round 59: View server copy + /verify page client contracts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const footer = fs.readFileSync(path.join(root, 'app/templates/partials/mk-footer.html'), 'utf8');
const marketing = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');
const authPy = fs.readFileSync(path.join(root, 'app/auth.py'), 'utf8');

assert.ok(storeJs.includes('async function fetchServerItem'));
assert.ok(storeJs.includes('/api/sync/item/'));
assert.ok(storeJs.includes('fetchServerItem,'));
assert.ok(appPy.includes('@app.get("/api/sync/item/<item_uuid>")'));
assert.ok(appPy.includes('def api_sync_item'));
assert.ok(appPy.includes('def verify_page'));
assert.ok(authPy.includes('"/verify"'));

assert.ok(html.includes('id="server-copy-dialog"'));
assert.ok(html.includes('id="note-info-server-copy"'));
assert.ok(html.includes('Without your vault password it\'s unreadable.')
  || html.includes('Without your vault password it&apos;s unreadable.')
  || html.includes("Without your vault password it's unreadable."));
assert.ok(appJs.includes('async function openServerCopyView'));
assert.ok(appJs.includes('SERVER_COPY_META_FIELDS'));
assert.ok(appJs.includes('plaintext metadata'));
assert.ok(appJs.includes('data-server-copy'));
// Each item type gets an entry point.
assert.ok(appJs.includes('note-info-server-copy'));
assert.ok(appJs.includes('totp-item-server-copy'));
assert.ok(appJs.includes('folder-server-copy'));
assert.ok(appJs.includes('data-manage-tag') && appJs.includes('View on server for tag'));
// Attachments (files) also get an On server control in the attachment list.
assert.ok(
  appJs.includes('data-server-copy="${escapeAttr(a.uuid)}"')
  || /data-server-copy="\$\{escapeAttr\(a\.uuid\)\}"/.test(appJs),
);

assert.ok(footer.includes('href="/verify"'));
assert.ok(marketing.includes('href="/verify"'));
assert.ok(verify.includes('/api/auth/srp/challenge'));
assert.ok(verify.includes('/api/auth/srp/verify'));
assert.ok(verify.includes('/api/sync/pull'));
assert.ok(verify.includes('/api/sync/items'));
assert.ok(verify.includes('What these tests'));
assert.ok(verify.includes('How to check the code'));
assert.ok(verify.includes('Our claim fails if'));
// Round 65: one SRI asset_script for release-hash check is allowed; no raw tags.
assert.ok(!/<script[\s>]/i.test(verify), '/verify must not use raw <script> tags');

console.log('test_round59_server_copy ok');
