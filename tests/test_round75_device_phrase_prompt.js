/**
 * Round 75: one-time in-app device-phrase prompt for existing users.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const phraseJs = fs.readFileSync(path.join(root, 'app/static/js/device-phrase.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'app/templates/login.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');

assert.ok(appHtml.includes('id="device-phrase-prompt"'), 'in-app prompt card');
assert.ok(appHtml.includes('btn-device-phrase-prompt-set'));
assert.ok(appHtml.includes('btn-device-phrase-prompt-dismiss'));
assert.ok(!loginHtml.includes('device-phrase-prompt'), 'never on login.html');
assert.ok(
  !appHtml.split('id="unlock-form"')[0].includes('device-phrase-prompt'),
  'prompt must not sit in unlock brand (above unlock-form)',
);
assert.ok(css.includes('.device-phrase-prompt'));
assert.ok(css.includes('@media (max-width: 390px)'), '390px mobile layout');
assert.ok(appJs.includes('updateDevicePhrasePrompt'));
assert.ok(appJs.includes('NotesDevicePhrase.renderPromptCard'));
assert.ok(storeJs.includes('notes_device_phrase'));
assert.ok(
  !storeJs.includes("removeItem('notes_device_phrase_prompt_dismissed')"),
  'dismissal survives sign-out',
);

for (const [name, src] of [
  ['device-phrase.js', phraseJs],
  ['app.js', appJs],
]) {
  assert.ok(
    !/fetch\([^)]*device_phrase_prompt|notes_device_phrase_prompt_dismissed[^;\n]{0,80}fetch/i.test(src),
    `${name} must not send prompt dismissal on the network`,
  );
}

function load(storage) {
  const copy = { textContent: '', innerHTML: 'NO' };
  const card = {
    hidden: true,
    querySelector: (sel) => (sel.includes('copy') ? copy : null),
  };
  const sandbox = {
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    document: { getElementById: () => null },
    window: {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(phraseJs, sandbox, { filename: 'device-phrase.js' });
  return { api: sandbox.NotesDevicePhrase, card, copy, storage };
}

{
  const storage = {};
  const { api, card, copy } = load(storage);
  assert.strictEqual(api.DISMISS_KEY, 'notes_device_phrase_prompt_dismissed');
  assert.strictEqual(api.PROMPT_COPY, 'Set a device phrase so you can spot fake sign-in pages');
  assert.ok(api.shouldShowPrompt());
  assert.strictEqual(api.renderPromptCard(card, { unlocked: false }), false);
  assert.strictEqual(card.hidden, true);
  assert.strictEqual(api.renderPromptCard(card, { unlocked: true }), true);
  assert.strictEqual(card.hidden, false);
  assert.strictEqual(copy.textContent, api.PROMPT_COPY);
  assert.strictEqual(copy.innerHTML, 'NO', 'textContent only');

  api.dismissPrompt();
  assert.strictEqual(storage.notes_device_phrase_prompt_dismissed, '1');
  assert.ok(!api.shouldShowPrompt());
  assert.strictEqual(api.renderPromptCard(card, { unlocked: true }), false);

  // Survives "sign-out" clearing of other keys.
  delete storage.notes_email;
  assert.strictEqual(storage.notes_device_phrase_prompt_dismissed, '1');
}

{
  const storage = {};
  const { api, card } = load(storage);
  api.setPhrase('coral lighthouse');
  assert.ok(!api.shouldShowPrompt(), 'phrase set suppresses prompt');
  assert.strictEqual(storage.notes_device_phrase_prompt_dismissed, '1');
  assert.strictEqual(api.renderPromptCard(card, { unlocked: true }), false);
}

console.log('test_round75_device_phrase_prompt ok');
