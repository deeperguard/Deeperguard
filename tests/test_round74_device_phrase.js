/**
 * Round 74: user-chosen anti-phishing device phrase (localStorage only).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const phraseJs = fs.readFileSync(path.join(root, 'app/static/js/device-phrase.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const authPagesJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'app/templates/login.html'), 'utf8');
const bannerHtml = fs.readFileSync(
  path.join(root, 'app/templates/partials/device-phrase-banner.html'),
  'utf8',
);

// --- Source / template wiring -------------------------------------------------
assert.ok(appHtml.includes("device-phrase-banner.html"), 'unlock brand includes banner');
assert.ok(
  appHtml.indexOf('device-phrase-banner.html') < appHtml.indexOf('id="unlock-form"'),
  'banner is above #unlock-form',
);
assert.ok(loginHtml.includes("device-phrase-banner.html"), 'login brand includes banner');
assert.ok(loginHtml.includes("js/device-phrase.js"), 'login loads device-phrase.js');
assert.ok(appHtml.includes("js/device-phrase.js"), 'app loads device-phrase.js');
assert.ok(bannerHtml.includes('id="device-phrase-display"'));
assert.ok(bannerHtml.includes('id="device-phrase-hint"'));
assert.ok(
  phraseJs.includes("If you don't see your phrase here, you may be on a fake page."),
  'fake-page warning copy lives in device-phrase.js',
);
assert.ok(appHtml.includes('id="device-phrase-input"'));
assert.ok(appHtml.includes('id="btn-device-phrase-save"'));
assert.ok(appHtml.includes('id="btn-device-phrase-clear"'));
assert.ok(appHtml.includes('maxlength="64"'));

assert.ok(authPagesJs.includes('NotesDevicePhrase.renderDisplay'));
assert.ok(appJs.includes('NotesDevicePhrase.setPhrase'));
assert.ok(appJs.includes('NotesDevicePhrase.clearPhrase'));
assert.ok(
  storeJs.includes('Keep notes_device_phrase')
    || storeJs.includes('notes_device_phrase (+ prompt dismissal)'),
  'sign-out keeps notes_device_phrase',
);
assert.ok(
  !storeJs.includes("removeItem('notes_device_phrase')")
    && !storeJs.includes('removeItem("notes_device_phrase")'),
  'sign-out must not remove notes_device_phrase',
);

// Never ship the phrase over the network.
for (const [name, src] of [
  ['app.js', appJs],
  ['auth-pages.js', authPagesJs],
  ['device-phrase.js', phraseJs],
  ['store.js', storeJs],
]) {
  assert.ok(
    !/fetch\([^)]*device_phrase|notes_device_phrase[^;\n]{0,80}(fetch|api\(|JSON\.stringify)/i.test(src),
    `${name} must not send notes_device_phrase on the network`,
  );
  assert.ok(
    !/body:\s*\{[^}]*device_phrase|device_phrase\s*:/.test(src)
      || name === 'device-phrase.js',
    `${name} must not include device_phrase in request bodies`,
  );
}

// --- Storage + rendering (vm sandbox) ----------------------------------------
function loadModule(storage) {
  const display = {
    textContent: '',
    innerHTML: 'SHOULD_NOT_USE',
    classList: {
      _c: new Set(),
      add(c) { this._c.add(c); },
      remove(c) { this._c.delete(c); },
      contains(c) { return this._c.has(c); },
    },
  };
  const hint = { textContent: '', innerHTML: 'SHOULD_NOT_USE', hidden: true };
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    document: {
      getElementById: (id) => {
        if (id === 'device-phrase-display') return display;
        if (id === 'device-phrase-hint') return hint;
        return null;
      },
    },
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  display.ownerDocument = sandbox.document;
  vm.runInNewContext(phraseJs, sandbox, { filename: 'device-phrase.js' });
  return { api: sandbox.NotesDevicePhrase, display, hint, storage };
}

{
  const storage = {};
  const { api, display, hint } = loadModule(storage);
  assert.strictEqual(api.KEY, 'notes_device_phrase');
  assert.strictEqual(api.MAX_LEN, 64);
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, api.UNSET_COPY);
  assert.ok(display.classList.contains('is-unset'));
  assert.strictEqual(hint.hidden, true);
  assert.strictEqual(hint.textContent, '');
  assert.strictEqual(display.innerHTML, 'SHOULD_NOT_USE', 'must use textContent, not innerHTML');

  const saved = api.setPhrase('  coral lighthouse  ');
  assert.strictEqual(saved, 'coral lighthouse');
  assert.strictEqual(storage.notes_device_phrase, 'coral lighthouse');
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, 'Your phrase: coral lighthouse');
  assert.ok(!display.classList.contains('is-unset'));
  assert.strictEqual(hint.hidden, false);
  assert.strictEqual(hint.textContent, api.WARN_COPY);

  // XSS: angle brackets must not become HTML.
  api.setPhrase('<img src=x onerror=alert(1)>');
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, 'Your phrase: <img src=x onerror=alert(1)>');
  assert.strictEqual(display.innerHTML, 'SHOULD_NOT_USE');
  assert.strictEqual(hint.innerHTML, 'SHOULD_NOT_USE');

  // Length cap.
  const long = 'a'.repeat(100);
  assert.strictEqual(api.setPhrase(long).length, 64);
  assert.strictEqual(storage.notes_device_phrase.length, 64);

  // Clear.
  api.clearPhrase();
  assert.strictEqual(storage.notes_device_phrase, undefined);
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, api.UNSET_COPY);
  assert.strictEqual(hint.hidden, true);
}

// Survival across sign-out: clearDeviceData key list must leave phrase intact.
{
  const storage = { notes_device_phrase: 'my secret phrase', notes_email: 'x@y.z' };
  const cleared = [
    'notes_last_sync',
    'notes_kdf_salt',
    'notes_vault_kdf_version',
    'notes_device_password',
    'notes_email',
  ];
  for (const k of cleared) delete storage[k];
  // Emulate: store.clearDeviceData does not touch notes_device_phrase.
  assert.strictEqual(storage.notes_device_phrase, 'my secret phrase');
  const { api, display } = loadModule(storage);
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, 'Your phrase: my secret phrase');
}

console.log('test_round74_device_phrase ok');
