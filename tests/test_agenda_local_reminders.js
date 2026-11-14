/**
 * Local reminders (docs/design/calendar-multi.md §5.1): planner timing, one display across two
 * open tabs, missed reminders shown once, no network or server endpoint, honest settings text,
 * and the Pro server path staying off for free accounts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// Any network use fails the test.
const network = [];
global.fetch = (...args) => { network.push(['fetch', args[0]]); throw new Error('network used'); };
global.XMLHttpRequest = function XMLHttpRequest() { network.push(['xhr']); throw new Error('network used'); };
let account = { plan: 'free', plan_features: { agenda_reminders: false } };
let events = [];
global.NotesStore = {
  api: async (url) => { network.push(['api', url]); throw new Error('network used'); },
  cachedAccount: () => account,
  isUnlocked: () => true,
  listAgendaEvents: () => events,
  upsertAgendaEvent() {},
};

global.window = global;
global.localStorage = memoryStorage();
global.document = {
  documentElement: { lang: 'en' },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
};
global.__DG_NO_LOCAL_REMINDERS = true; // the test drives the planner itself
for (const f of ['agenda-ics', 'agenda-recurrence', 'agenda-occurrence', 'agenda-scroll-core', 'agenda-reminders', 'agenda', 'agenda-local-reminders']) {
  vm.runInThisContext(read(`app/static/js/${f}.js`), { filename: `${f}.js` });
}
const R = global.NotesAgendaReminders;
const L = global.NotesAgendaLocalReminders;
assert.ok(R && L, 'modules loaded');

const MIN = 60000;
const T0 = Date.parse('2026-11-16T08:00:00Z');
const savedAt = new Date(T0 - 3600000).toISOString();
const ev = (over) => ({
  id: 'ev-1', type: 'agenda_event', title: 'Dentist', start: new Date(T0 + 30 * MIN).toISOString(),
  end: new Date(T0 + 60 * MIN).toISOString(), all_day: false, rrule: '', reminders: [15, 0], updated_at: savedAt, ...over,
});

/** Web Locks stand-in: one holder at a time, shared by every "tab" that uses it. */
function fakeLocks() {
  let chain = Promise.resolve();
  let holders = 0;
  let maxHolders = 0;
  return {
    request(name, fn) {
      const run = chain.then(async () => {
        holders += 1;
        maxHolders = Math.max(maxHolders, holders);
        await new Promise((r) => setImmediate(r)); // give the other tab a chance to interleave
        try { return await fn(); } finally { holders -= 1; }
      });
      chain = run.catch(() => {});
      return run;
    },
    get maxHolders() { return maxHolders; },
  };
}

function tab(clock, storage, locks, shown) {
  return L.createPlanner({
    now: () => clock.now,
    storage,
    locks,
    listEvents: () => events,
    isUnlocked: () => true,
    show: (r) => shown.push(r),
  });
}

(async () => {
  // --- offsets: presets, legacy keys and a custom value, all in minutes --------------------
  assert.deepStrictEqual(R.offsetMinutes(['m15', 20, '20', 'x', -1, 99999999, 'none', 0]), [0, 15, 20]);
  assert.deepStrictEqual(R.offsetMinutes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).length, R.MAX_OFFSETS, 'at most 8 per event');
  assert.strictEqual(R.offsetLabel(1440), '1 day before');
  assert.strictEqual(R.offsetLabel(90), '90 min before');
  // Server ids for preset values do not change now that offsets are stored as minutes.
  const legacy = R.computePlannedReminders({ ...ev(), reminders: ['m15'] }, ['email'], T0);
  const minutes = R.computePlannedReminders({ ...ev(), reminders: [15] }, ['email'], T0);
  assert.strictEqual(legacy[0]._key, minutes[0]._key, 'stable reminder id key for preset offsets');

  // --- planner: fires on time, once per offset ---------------------------------------------
  events = [ev()];
  {
    const clock = { now: T0 };
    const shown = [];
    const p = tab(clock, memoryStorage(), fakeLocks(), shown);
    assert.deepStrictEqual(await p.check(), [], 'nothing due yet');
    clock.now = T0 + 15 * MIN; // 15 min before the start
    await p.check();
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].minutes, 15);
    assert.strictEqual(shown[0].missed, false, 'on time is not "missed"');
    clock.now += 20000;
    await p.check();
    assert.strictEqual(shown.length, 1, 'not shown twice by the same tab');
    clock.now = T0 + 30 * MIN + 10000; // start
    await p.check();
    assert.strictEqual(shown.length, 2);
    assert.strictEqual(shown[1].minutes, 0);
    const text = L.reminderText(shown[1]);
    assert.strictEqual(text.title, 'Dentist');
    assert.ok(/at start/.test(text.body), text.body);
  }

  // --- repeating event: each occurrence gets its own reminder ------------------------------
  events = [ev({ rrule: 'FREQ=DAILY;COUNT=3', reminders: [5] })];
  {
    const clock = { now: T0 + 25 * MIN };
    const shown = [];
    const p = tab(clock, memoryStorage(), fakeLocks(), shown);
    await p.check();
    clock.now += 86400000;
    await p.check();
    assert.strictEqual(shown.length, 2, 'one per day');
    assert.notStrictEqual(shown[0].key, shown[1].key);
  }

  // --- two tabs: every reminder exactly once ------------------------------------------------
  events = [
    ev(),
    ev({ id: 'ev-2', title: 'Standup', reminders: [15, 10, 5] }),
    ev({ id: 'ev-3', title: 'Call', start: new Date(T0 + 12 * MIN).toISOString(), reminders: [5] }),
  ];
  {
    const storage = memoryStorage(); // localStorage is shared by tabs of one origin
    const locks = fakeLocks(); // navigator.locks is shared by tabs of one origin
    const clock = { now: T0 };
    const shownA = [];
    const shownB = [];
    const a = tab(clock, storage, locks, shownA);
    const b = tab(clock, storage, locks, shownB);
    for (let t = T0; t <= T0 + 40 * MIN; t += 15000) {
      clock.now = t;
      await Promise.all([a.check(), b.check(), b.check(), a.check()]);
    }
    const all = [...shownA, ...shownB].map((r) => r.key);
    // ev-1: 2, ev-2: 3, ev-3: 1
    assert.strictEqual(all.length, 6, `six reminders, each shown once over both tabs (got ${all.length})`);
    assert.strictEqual(new Set(all).size, 6, 'no reminder shown by both tabs');
    assert.strictEqual(locks.maxHolders, 1, 'the claim runs under an exclusive lock');
    assert.ok(all.every((k) => !storage.getItem(L.SHOWN_KEY).includes(k)), 'stored keys are hashed, not event ids');
  }

  // --- missed while closed: shown once on open, marked missed --------------------------------
  events = [ev()];
  {
    const storage = memoryStorage();
    const shown = [];
    const before = tab({ now: T0 }, storage, fakeLocks(), shown);
    await before.check();
    assert.strictEqual(shown.length, 0);
    // Tab closed. Opened again two hours later: both reminders were missed.
    const clock = { now: T0 + 2 * 3600000 };
    const reopened = tab(clock, storage, fakeLocks(), shown);
    await reopened.check();
    assert.strictEqual(shown.length, 2, 'both missed reminders shown');
    assert.ok(shown.every((r) => r.missed), 'marked as missed');
    assert.ok(L.reminderText(shown[0]).title.startsWith('Missed: '));
    // A second tab opened right after, and the same tab later: nothing again.
    const second = tab(clock, storage, fakeLocks(), shown);
    await second.check();
    clock.now += 60000;
    await reopened.check();
    assert.strictEqual(shown.length, 2, 'a missed reminder is shown only once');
  }
  {
    // Older than 24 hours: not shown.
    const shown = [];
    await tab({ now: T0 + 30 * MIN + L.MISSED_WINDOW_MS + MIN }, memoryStorage(), fakeLocks(), shown).check();
    assert.strictEqual(shown.length, 0, 'missed reminders older than 24h are dropped');
    // Saved after the reminder time had passed: never "upcoming", so not reported as missed.
    events = [ev({ updated_at: new Date(T0 + 20 * MIN).toISOString() })];
    await tab({ now: T0 + 40 * MIN }, memoryStorage(), fakeLocks(), shown).check();
    assert.deepStrictEqual(shown.map((r) => r.minutes), [0], 'only the reminder that came due after saving');
  }
  {
    // Locked vault: nothing is read or shown.
    const shown = [];
    const p = L.createPlanner({ now: () => T0 + 15 * MIN, storage: memoryStorage(), locks: fakeLocks(), listEvents: () => { throw new Error('read while locked'); }, isUnlocked: () => false, show: (r) => shown.push(r) });
    assert.deepStrictEqual(await p.check(), []);
  }

  // --- Notification only with permission, never for missed ones ---------------------------
  {
    const made = [];
    global.Notification = function N(title, opts) { made.push({ title, opts }); };
    global.Notification.permission = 'default';
    global.Notification.requestPermission = () => { throw new Error('asked without a click'); };
    events = [ev()];
    const p = L.createPlanner({ now: () => T0 + 15 * MIN, storage: memoryStorage(), locks: null, listEvents: () => events, isUnlocked: () => true });
    await p.check();
    assert.strictEqual(made.length, 0, 'no notification without permission (and no prompt from the planner)');
    global.Notification.permission = 'granted';
    const p2 = L.createPlanner({ now: () => T0 + 15 * MIN, storage: memoryStorage(), locks: null, listEvents: () => events, isUnlocked: () => true });
    await p2.check();
    assert.strictEqual(made.length, 1, 'notification when allowed');
    assert.strictEqual(made[0].title, 'Dentist');
    const p3 = L.createPlanner({ now: () => T0 + 5 * 3600000, storage: memoryStorage(), locks: null, listEvents: () => events, isUnlocked: () => true });
    await p3.check();
    assert.strictEqual(made.length, 1, 'missed reminders only show in the app');
    delete global.Notification;
  }

  // --- no network, no server endpoint -------------------------------------------------------
  assert.deepStrictEqual(network, [], 'the planner made no network request');
  const localJs = read('app/static/js/agenda-local-reminders.js');
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /\.api\s*\(/, /pushManager/, /\/api\//]) {
    assert.ok(!bad.test(localJs), `agenda-local-reminders.js must not use ${bad}`);
  }
  const appPy = read('app/app.py');
  assert.ok(!/local[-_]reminder/i.test(appPy), 'no server route for local reminders');
  const routes = [...appPy.matchAll(/route\(\s*["']([^"']*remind[^"']*)["']/gi)].map((m) => m[1]);
  assert.ok(routes.every((r) => r.startsWith('/api/agenda-reminders/') || r.startsWith('/api/reminders')), `only the existing reminder routes: ${routes}`);

  // --- free account: offsets are stored, the Pro server path stays off ----------------------
  account = { plan: 'free', plan_features: { agenda_reminders: false } };
  global.localStorage.setItem('deeperguard-prefs', JSON.stringify({ agenda_reminder_email: true }));
  events = [ev({ reminders: [15, 20] })];
  await R.syncEventReminders('ev-1');
  await R.topUp(true);
  await R.flushPending();
  await R.cancelEventReminders('ev-1', { scheduled_reminder_ids: [{ id: 'x' }] });
  assert.deepStrictEqual(network, [], 'free account: no server reminder calls for local offsets');
  assert.strictEqual(R.editorHint(), '', 'no server-channel hint for free accounts');

  // --- honest text in settings and editor; Pro channels stay separate ----------------------
  const html = read('app/templates/app.html');
  const settings = html.slice(html.indexOf('id="agenda-local-reminder-settings"'));
  assert.ok(/Reminders only work while Deeperguard is open in your browser/.test(settings.slice(0, 1500)), 'settings: only while open');
  assert.ok(/send no email and no push message/.test(settings.slice(0, 1500)), 'settings: no email or push');
  assert.ok(/separate, optional Pro feature/.test(settings.slice(0, 1500)), 'settings: Pro channels are separate');
  assert.ok(/id="agenda-local-reminder-allow"[^>]*hidden/.test(html), 'permission button, asked only after a click');
  const editor = html.slice(html.indexOf('id="agenda-edit-reminders-wrap"'), html.indexOf('id="agenda-edit-reminders-wrap"') + 4000);
  assert.ok(/Reminders only work while Deeperguard is open in your browser/.test(editor), 'editor: only while open');
  assert.ok(/These reminders send no email and no push message/.test(editor), 'editor: no email or push');
  assert.ok(/The server sees reminder times and channel, never event titles, locations or notes\./.test(editor), 'editor keeps the server privacy hint');
  assert.ok(/data-plan-feature="agenda_reminders"/.test(editor), 'server-channel part of the editor stays Pro-gated');
  assert.ok(/<input type="checkbox" data-agenda-reminder-offset="1440">/.test(editor) && /id="agenda-edit-reminders-custom"/.test(editor), 'presets and a custom value');
  assert.ok(/settings-hint muted">Email and push reminders are a separate, optional Pro feature/.test(html));
  assert.ok(html.includes("asset_script('js/agenda-local-reminders.js')"), 'module is loaded by the app');
  assert.ok(/agenda-local-reminders\.js/.test(read('app/static/client-manifest.json')), 'client manifest lists the module');

  console.log('test_agenda_local_reminders ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
