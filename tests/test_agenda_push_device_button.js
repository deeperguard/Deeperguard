/**
 * The "push on this device" button in Calendar settings (review follow-up for task 251).
 * Runs the real agenda-reminders.js through its click handler against a fake service worker and
 * fake server. Checks the label flip in both directions, and that a failed server request keeps
 * the browser subscription so the same button can retry.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const storage = new Map();
global.window = global;
global.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
global.HTMLInputElement = class HTMLInputElement {};
global.HTMLSelectElement = class HTMLSelectElement {};

const ENDPOINT = 'https://push.example.invalid/sub/1';
let browserSub = null; // what the browser's push manager holds for this device
const unsubscribed = [];
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: {
    serviceWorker: {
      pushManager: {},
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => browserSub,
        },
      }),
    },
  },
});

const button = {
  textContent: '',
  hidden: false,
  dataset: {},
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
};
const toasts = [];
global.notesAgendaToast = (message, isError) => { toasts.push({ message, isError: !!isError }); };

global.document = {
  documentElement: { lang: 'en' },
  readyState: 'complete',
  getElementById: (id) => (id === 'agenda-reminder-enable-push' ? button : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};

let serverFails = false;
const apiCalls = [];
global.NotesStore = {
  cachedAccount: () => ({ plan: 'pro', plan_features: { agenda_reminders: true } }),
  isUnlocked: () => true,
  async api(url, opts) {
    apiCalls.push({ url, opts });
    if (url === '/api/agenda-reminders/push-config') {
      return { push_ready: true, email_ready: true, vapid_public_key: 'AQAB' };
    }
    if (url === '/api/agenda-reminders/push-unsubscribe') {
      if (serverFails) throw new Error('server down');
      return { ok: true };
    }
    throw new Error(`unexpected request ${url}`);
  },
};

const src = fs.readFileSync(path.join(root, 'app/static/js/agenda-reminders.js'), 'utf8');
vm.runInThisContext(src, { filename: 'agenda-reminders.js' });
const R = global.NotesAgendaReminders;
assert.ok(R && typeof R.wireAgendaReminderSettings === 'function', 'module loaded');

const SUBSCRIBED_TEXT = 'Turn off push on this device';
const UNSUBSCRIBED_TEXT = 'Enable push on this device';

// Let the click handler and its refresh run to the end (they only await resolved promises).
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const fakeSub = () => ({
  endpoint: ENDPOINT,
  unsubscribe: async () => { unsubscribed.push(ENDPOINT); browserSub = null; return true; },
});
const unsubscribeCalls = () => apiCalls.filter((c) => c.url === '/api/agenda-reminders/push-unsubscribe');

(async () => {
  // Wiring the settings reads the device state: a subscribed device shows the turn-off label.
  browserSub = fakeSub();
  R.wireAgendaReminderSettings();
  await settle();
  assert.strictEqual(button.textContent, SUBSCRIBED_TEXT);
  assert.strictEqual(button.dataset.subscribed, '1');

  // A failed server request keeps the browser subscription and the label, and says so.
  serverFails = true;
  button.listeners.click({ currentTarget: button });
  await settle();
  assert.strictEqual(unsubscribeCalls().length, 1, 'the server was asked to forget the endpoint');
  assert.deepStrictEqual(unsubscribed, [], 'the browser subscription is kept when the server fails');
  assert.ok(browserSub && browserSub.endpoint === ENDPOINT, 'device still subscribed');
  assert.strictEqual(button.textContent, SUBSCRIBED_TEXT, 'label still offers turning off');
  assert.strictEqual(button.dataset.subscribed, '1');
  assert.deepStrictEqual(toasts[toasts.length - 1], { message: 'Could not change push on this device', isError: true });

  // Retrying with the server back removes the browser subscription and flips the label.
  serverFails = false;
  button.listeners.click({ currentTarget: button });
  await settle();
  assert.strictEqual(unsubscribeCalls().length, 2, 'retry sends the request again');
  assert.deepStrictEqual(unsubscribeCalls()[1].opts.body, JSON.stringify({ endpoint: ENDPOINT }));
  assert.deepStrictEqual(unsubscribed, [ENDPOINT]);
  assert.strictEqual(browserSub, null);
  assert.strictEqual(button.textContent, UNSUBSCRIBED_TEXT, 'label now offers enabling');
  assert.strictEqual(button.dataset.subscribed, '');
  assert.deepStrictEqual(toasts[toasts.length - 1], { message: 'Push turned off on this device', isError: false });

  // A later settings refresh with no subscription held shows the enable label and sends nothing.
  R.wireAgendaReminderSettings();
  await settle();
  assert.strictEqual(button.textContent, UNSUBSCRIBED_TEXT);
  assert.strictEqual(unsubscribeCalls().length, 2, 'nothing is sent to the server when no subscription is held');

  console.log('agenda push device button: ok');
})().catch((e) => { console.error(e); process.exit(1); });
