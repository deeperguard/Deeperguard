/**
 * Moltbook: /verify Ask AI pin notice in AI settings.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app/static/js/verify-ask-ai-provider.js'), 'utf8');

function makeSandbox(storage = {}) {
  const store = { ...storage };
  return {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      querySelector: () => null,
      getElementById: () => null,
    },
    globalThis: {},
  };
}

function runInSandbox(sandbox) {
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'verify-ask-ai-provider.js' });
  return sandbox.NotesVerifyAskAiPin;
}

const pin = 'c12309b8e10a8d58ab99b46ea51f2efaa9e299d2beb0bedc14aa9dc4f7930345';

{
  const noticeEl = { hidden: true, setAttribute() {} };
  const sandbox = makeSandbox();
  sandbox.document.querySelector = (sel) => (
    sel === 'meta[name="notes-verify-ask-ai-pin"]'
      ? { getAttribute: () => pin }
      : null
  );
  sandbox.document.getElementById = (id) => (id === 'ai-chat-verify-pin-notice' ? noticeEl : null);
  const api = runInSandbox(sandbox);
  assert.strictEqual(api.needsNotice(), true);
  api.paintSettingsNotice();
  assert.strictEqual(noticeEl.hidden, false);
  api.acknowledge();
  assert.strictEqual(api.needsNotice(), false);
  api.paintSettingsNotice();
  assert.strictEqual(noticeEl.hidden, true);
}

{
  const sandbox = makeSandbox();
  sandbox.document.getElementById = (id) => (
    id === 'verify-ask-ai'
      ? { getAttribute: () => pin }
      : null
  );
  const api = runInSandbox(sandbox);
  api.start();
  assert.strictEqual(sandbox.localStorage.getItem('notes_verify_ask_ai_pin_seen'), pin);
}

const verifyHtml = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
assert.ok(verifyHtml.includes('id="verify-ask-ai"'));
assert.ok(verifyHtml.includes('Ask AI details → section 6.'));

console.log('test_moltbook_verify_ask_ai_provider ok');
