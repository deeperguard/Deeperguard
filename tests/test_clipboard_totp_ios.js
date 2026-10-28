/**
 * iOS TOTP copy: sync list code + clipboard helper prefers execCommand before await.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const clipboardJs = fs.readFileSync(path.join(root, 'app/static/js/clipboard-sensitive.js'), 'utf8');

assert.ok(appJs.includes('function totpCodeFromListRow'));
assert.ok(appJs.includes('copyTotpEntry(row.dataset.totpId, totpCodeFromListRow(row))'));
assert.ok(appJs.includes('prefilledCode'));
assert.ok(clipboardJs.includes('writeClipboardTextSync'));
assert.ok(clipboardJs.includes('try sync copy before any await'));

let execCalls = 0;
let clipboardWrites = 0;
const sandbox = {
  window: {},
  module: { exports: {} },
  setTimeout() { return 1; },
  clearTimeout() {},
  navigator: {
    clipboard: {
      writeText: async () => {
        clipboardWrites += 1;
        throw new Error('clipboard blocked');
      },
      readText: async () => null,
    },
  },
  document: {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => {
      const el = {
        value: '',
        style: {},
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
        remove() {},
      };
      return el;
    },
    execCommand: () => {
      execCalls += 1;
      return true;
    },
  },
};
sandbox.window = sandbox;
vm.runInNewContext(clipboardJs, sandbox);
const CS = sandbox.window.NotesClipboardSensitive;
assert.ok(CS?.writeClipboardTextSync);

(async () => {
  execCalls = 0;
  clipboardWrites = 0;
  const ok = await CS.writeClipboardText('153639');
  assert.strictEqual(ok, true);
  assert.strictEqual(execCalls, 1, 'sync execCommand before async clipboard');
  assert.strictEqual(clipboardWrites, 0, 'clipboard API not needed when execCommand succeeds');

  console.log('test_clipboard_totp_ios ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
