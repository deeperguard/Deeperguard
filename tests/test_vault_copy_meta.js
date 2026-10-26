/**
 * Vault copy meta (device-local counts) and clipboard rotate hints.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const metaJs = fs.readFileSync(path.join(root, 'app/static/js/vault-copy-meta.js'), 'utf8');
const clipboardJs = fs.readFileSync(path.join(root, 'app/static/js/clipboard-sensitive.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

assert.ok(appHtml.includes('js/vault-copy-meta.js'));
assert.ok(appJs.includes('NotesVaultCopyMeta'));
assert.ok(appJs.includes('copyScope'));
assert.ok(appJs.includes('totp-list-head'));
assert.ok(appJs.includes('totp-item-meta'));
assert.ok(clipboardJs.includes('rotateHint'));

const storage = new Map();
const sandbox = {
  window: {},
  module: { exports: {} },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  },
};
sandbox.window = sandbox;
vm.runInNewContext(metaJs, sandbox);
const Meta = sandbox.window.NotesVaultCopyMeta;
assert.ok(Meta);

assert.strictEqual(Meta.getMeta('totp', 'abc').count, 0);
const first = Meta.recordCopy('totp', 'abc');
assert.strictEqual(first.count, 1);
assert.ok(first.lastUsedAt > 0);
const second = Meta.recordCopy('totp', 'abc');
assert.strictEqual(second.count, 2);
assert.ok(!Meta.rotateHint(1));
assert.ok(Meta.rotateHint(2).includes('Copied twice'));
assert.ok(Meta.rotateHint(5).includes('5 times'));
assert.ok(Meta.rotateHint(2).includes('consider rotating'));
assert.ok(!Meta.rotateHint(2).match(/guarantee|secure|safe/i));

const csSandbox = {
  window: {},
  module: { exports: {} },
  setTimeout: () => 1,
  clearTimeout: () => {},
  navigator: { clipboard: { writeText: async () => {}, readText: async () => '' } },
  document: {
    createElement: () => ({ value: '', style: {}, setAttribute() {}, select() {}, remove() {} }),
    execCommand: () => false,
    body: { appendChild() {} },
  },
};
csSandbox.window = csSandbox;
vm.runInNewContext(clipboardJs, csSandbox);
const CSapi = csSandbox.window.NotesClipboardSensitive;
assert.ok(CSapi.countdownMessage('Code', 30, { rotateHint: 'Copied twice on this device.' }).includes('Copied twice'));
assert.ok(CSapi.countdownMessage('Password', 45, { shownBelow: true, rotateHint: 'hint' }).includes('shown below and copied'));

console.log('test_vault_copy_meta ok');
