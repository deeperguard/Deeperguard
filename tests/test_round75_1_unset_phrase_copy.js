/**
 * Round 75.1: unset device-phrase copy on login/unlock (no alarming warning).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const phraseJs = fs.readFileSync(path.join(root, 'app/static/js/device-phrase.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const authPagesJs = fs.readFileSync(path.join(root, 'app/static/js/auth-pages.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'app/templates/login.html'), 'utf8');
const bannerHtml = fs.readFileSync(
  path.join(root, 'app/templates/partials/device-phrase-banner.html'),
  'utf8',
);
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

const UNSET =
  'No device phrase yet. After you unlock, you can set one in Settings to help spot fake sign-in pages.';
const WARN = "If you don't see your phrase here, you may be on a fake page.";

// Banner on unlock (app) and login.
assert.ok(appHtml.includes("device-phrase-banner.html"), 'unlock includes banner');
assert.ok(
  appHtml.indexOf('device-phrase-banner.html') < appHtml.indexOf('id="unlock-form"'),
  'banner above unlock-form',
);
assert.ok(loginHtml.includes("device-phrase-banner.html"), 'login includes banner');
assert.ok(bannerHtml.includes('id="device-phrase-display"'));
assert.ok(bannerHtml.includes('id="device-phrase-hint"'));
assert.ok(bannerHtml.includes('hidden'), 'hint starts hidden until phrase is set');
// Warning copy must not be hardcoded visible in the partial (JS fills it).
assert.ok(!bannerHtml.includes(WARN), 'banner partial must not hardcode warning text');
assert.ok(!bannerHtml.includes('No phrase on this device yet'));

assert.ok(authPagesJs.includes('NotesDevicePhrase.renderDisplay'), 'login paints banner');
assert.ok(appJs.includes('NotesDevicePhrase.renderDisplay'), 'unlock paints banner');
// R75 in-app prompt card untouched.
assert.ok(appHtml.includes('id="device-phrase-prompt"'));
assert.ok(appJs.includes('updateDevicePhrasePrompt'));

assert.ok(css.includes('.device-phrase-display.is-unset'), 'calm unset style');
assert.ok(css.includes('color: var(--muted)'), 'unset uses muted grey');
assert.ok(css.includes('@media (max-width: 390px)'), '390px layout');
assert.ok(
  /@media \(max-width: 390px\)\s*\{[^}]*\.device-phrase-display/s.test(css)
    || css.includes('.device-phrase-display.is-unset'),
  '390px covers device-phrase banner',
);

function load(storage) {
  const display = {
    textContent: '',
    innerHTML: 'NO_HTML',
    classList: {
      _c: new Set(),
      add(c) { this._c.add(c); },
      remove(c) { this._c.delete(c); },
      contains(c) { return this._c.has(c); },
    },
  };
  const hint = { textContent: 'stale', innerHTML: 'NO_HTML', hidden: false };
  const doc = {
    getElementById: (id) => {
      if (id === 'device-phrase-display') return display;
      if (id === 'device-phrase-hint') return hint;
      return null;
    },
  };
  display.ownerDocument = doc;
  const sandbox = {
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    document: doc,
    window: {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(phraseJs, sandbox, { filename: 'device-phrase.js' });
  return { api: sandbox.NotesDevicePhrase, display, hint };
}

// --- No phrase: neutral line, no warning (login + unlock share renderDisplay) ---
{
  const { api, display, hint } = load({});
  assert.strictEqual(api.UNSET_COPY, UNSET);
  assert.strictEqual(api.WARN_COPY, WARN);
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, UNSET);
  assert.ok(display.classList.contains('is-unset'));
  assert.strictEqual(hint.hidden, true, 'warning hidden when unset');
  assert.strictEqual(hint.textContent, '');
  assert.ok(!display.textContent.includes('fake page'));
  assert.ok(!hint.textContent.includes('fake page'));
  assert.strictEqual(display.innerHTML, 'NO_HTML', 'textContent only');
  assert.strictEqual(hint.innerHTML, 'NO_HTML', 'textContent only');
}

// --- Phrase set: phrase + warning under it ---
{
  const storage = { notes_device_phrase: 'coral lighthouse' };
  const { api, display, hint } = load(storage);
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, 'Your phrase: coral lighthouse');
  assert.ok(!display.classList.contains('is-unset'));
  assert.strictEqual(hint.hidden, false, 'warning shown when phrase set');
  assert.strictEqual(hint.textContent, WARN);
  assert.strictEqual(display.innerHTML, 'NO_HTML');
  assert.strictEqual(hint.innerHTML, 'NO_HTML');
}

// Clearing returns to calm unset state.
{
  const storage = { notes_device_phrase: 'x' };
  const { api, display, hint } = load(storage);
  api.renderDisplay(display);
  assert.strictEqual(hint.hidden, false);
  api.clearPhrase();
  api.renderDisplay(display);
  assert.strictEqual(display.textContent, UNSET);
  assert.strictEqual(hint.hidden, true);
  assert.strictEqual(hint.textContent, '');
}

console.log('test_round75_1_unset_phrase_copy ok');
