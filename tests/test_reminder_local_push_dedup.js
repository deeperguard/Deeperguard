/**
 * Exact-minute local reminders for tasks and notes, and de-duplication with the server push
 * (docs/design/reminders.md §4). The real planner (agenda-local-reminders.js) and the real service
 * worker (sw.js) share one in-memory IndexedDB, as two contexts of one origin do in a browser. Time
 * is a fake clock for both.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const clock = { now: 0 };
const MIN = 60000;
const later = (fn) => setImmediate(fn);

/** Just enough of IndexedDB for open / upgrade / one get+put per transaction. */
function fakeIndexedDB() {
  const dbs = new Map();
  return {
    dbs,
    open(name) {
      const req = {};
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (fresh) {
          db = new Map();
          dbs.set(name, db);
        }
        req.result = {
          objectStoreNames: { contains: (s) => db.has(s) },
          createObjectStore: (s) => { db.set(s, new Map()); },
          close() {},
          transaction(storeName) {
            const store = db.get(storeName);
            const tx = {};
            tx.objectStore = () => ({
              get(key) {
                const r = {};
                later(() => {
                  r.result = store.has(key) ? structuredClone(store.get(key)) : undefined;
                  if (r.onsuccess) r.onsuccess();
                  later(() => { if (tx.oncomplete) tx.oncomplete(); });
                });
                return r;
              },
              put(value, key) { store.set(key, structuredClone(value)); return {}; },
            });
            return tx;
          },
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

/** The OS notification tray of one origin: same tag replaces, close removes. */
function fakeRegistration() {
  const tray = [];
  const calls = [];
  const reg = {
    tray,
    calls,
    async showNotification(title, opts = {}) {
      calls.push({ title, ...opts });
      const n = { title, body: opts.body || '', tag: opts.tag || '', data: opts.data, icon: opts.icon || '' };
      n.close = () => { const i = tray.indexOf(n); if (i >= 0) tray.splice(i, 1); };
      const same = n.tag ? tray.findIndex((x) => x.tag === n.tag) : -1;
      if (same >= 0) tray.splice(same, 1, n);
      else tray.push(n);
    },
    async getNotifications(filter = {}) {
      return tray.filter((n) => !filter.tag || n.tag === filter.tag);
    },
  };
  return reg;
}

const idb = fakeIndexedDB();
const registration = fakeRegistration();

// ---- page: the app's modules, with network use trapped --------------------------------------
const network = [];
global.fetch = (...args) => { network.push(['fetch', args[0]]); throw new Error('network used'); };
global.XMLHttpRequest = function XMLHttpRequest() { network.push(['xhr']); throw new Error('network used'); };
global.NotesStore = {
  api: async (url) => { network.push(['api', url]); throw new Error('network used'); },
  cachedAccount: () => ({ plan: 'pro', plan_features: { agenda_reminders: true } }),
  isUnlocked: () => true,
  listAgendaEvents: () => [],
  upsertAgendaEvent() {},
};
global.window = global;
global.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();
global.document = {
  documentElement: { lang: 'en' },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
};
Object.defineProperty(global, 'navigator', {
  value: { serviceWorker: { getRegistration: async () => registration } },
  configurable: true,
});
global.Notification = function Notification() { throw new Error('page notifications are not used when a worker is registered'); };
global.Notification.permission = 'granted';
global.indexedDB = idb;
global.__DG_NO_LOCAL_REMINDERS = true;
for (const f of ['agenda-ics', 'agenda-recurrence', 'agenda-occurrence', 'agenda-scroll-core', 'agenda-reminders', 'agenda', 'agenda-tasks', 'agenda-local-reminders']) {
  vm.runInThisContext(read(`app/static/js/${f}.js`), { filename: `${f}.js` });
}
const R = global.NotesAgendaReminders;
const L = global.NotesAgendaLocalReminders;

// ---- service worker: the real sw.js, sharing the IndexedDB and the tray ---------------------
const sw = (() => {
  const listeners = {};
  const self = {
    location: { origin: 'https://notes.test' },
    registration,
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() {},
    clients: { matchAll: async () => [] },
  };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.now])); }
    static now() { return clock.now; }
  }
  const ctx = { self, indexedDB: idb, URL, Date: FakeDate, setTimeout, clearTimeout, console, structuredClone };
  vm.createContext(ctx);
  vm.runInContext(read('app/static/sw.js'), ctx, { filename: 'sw.js' });
  return {
    async push(payload) {
      let done = null;
      listeners.push({
        data: payload === undefined ? null : { json: () => payload },
        waitUntil(p) { done = p; },
      });
      return done;
    },
  };
})();

// ---- fixtures --------------------------------------------------------------------------------
const at = (h, m) => new Date(2026, 10, 20, h, m, 0, 0).getTime(); // local time, like the due date
const iso = (ms) => new Date(ms).toISOString();
const winOf = (ms) => Math.floor(ms / 1000 / 900) * 900;
const rid = (n) => String(n).repeat(32).slice(0, 32);
const savedAt = iso(at(8, 0));

let events = [];
let tasks = [];
let notes = [];
let unlocked = true;
function task(over) {
  return { id: 't1', type: 'agenda_task', title: 'Pay rent', due: '2026-11-20', due_time: '14:37', done_at: '', reminder: { offsets: [0] }, reminder_windows: [], updated_at: savedAt, ...over };
}
function note(over, reminder) {
  return { uuid: 'n1', deleted: false, content: { type: 'note', title: 'Call the bank', updated_at: savedAt, reminders: [reminder], ...over } };
}
function planner() {
  return L.createPlanner({
    now: () => clock.now,
    locks: null,
    listEvents: () => events,
    listTasks: () => tasks,
    listNotes: () => notes,
    isUnlocked: () => unlocked,
  });
}
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}
/** Tick every 15 s like the real planner, from `fromMs` to `toMs`. */
async function run(p, fromMs, toMs) {
  for (let t = fromMs; t <= toMs; t += 15000) {
    clock.now = t;
    await p.check();
    await settle();
  }
}
function reset() {
  registration.tray.length = 0;
  registration.calls.length = 0;
  idb.dbs.clear();
  global.localStorage.removeItem(L.SHOWN_KEY);
  events = [];
  tasks = [];
  notes = [];
  unlocked = true;
}
const visible = () => registration.tray.map((n) => n.title);

(async () => {
  // --- exact minute for a task and a note (fake clock) ------------------------------------------
  reset();
  tasks = [task(), task({ id: 't-done', title: 'Done already', done_at: savedAt })];
  notes = [
    note({}, { at: iso(at(14, 52)), push: false }),
    note({ trashed: true }, { at: iso(at(14, 45)), push: false }),
  ];
  notes[1].uuid = 'n-trashed';
  {
    const p = planner();
    const seen = [];
    for (let t = at(14, 30); t <= at(15, 0); t += 15000) {
      clock.now = t;
      await p.check();
      await settle();
      for (const n of registration.calls.slice(seen.length)) seen.push({ title: n.title, when: t });
    }
    assert.deepStrictEqual(seen.map((s) => s.title), ['Pay rent', 'Call the bank'], 'task then note, nothing for done or trashed items');
    const lateBy = [seen[0].when - at(14, 37), seen[1].when - at(14, 52)];
    assert.ok(lateBy.every((ms) => ms >= 0 && ms < MIN), `within a minute of the exact time (${lateBy})`);
    assert.ok(registration.calls.every((c) => c.tag && !c.silent), 'shown as a normal notification with a tag');
    assert.deepStrictEqual(network, [], 'no network for local reminders');
  }

  // --- a locked vault shows nothing ------------------------------------------------------------
  reset();
  tasks = [task()];
  unlocked = false;
  await run(planner(), at(14, 36), at(14, 39));
  assert.strictEqual(registration.calls.length, 0, 'nothing while the vault is locked');

  // --- task shown locally, then its empty window push: replaced silently, no second alert --------
  reset();
  tasks = [task({ reminder_windows: [{ id: rid('a'), window_start: winOf(at(14, 37)) }] })];
  {
    await run(planner(), at(14, 36), at(14, 38));
    assert.deepStrictEqual(visible(), ['Pay rent']);
    const before = registration.calls.length;
    clock.now = at(14, 40);
    assert.strictEqual(await sw.push(undefined), 'replaced');
    const call = registration.calls[before];
    assert.ok(call, 'the push still calls showNotification (iOS keeps the subscription)');
    assert.strictEqual(call.silent, true, 'without sound or vibration');
    assert.strictEqual(call.tag, registration.calls[0].tag, 'same tag as the local notification, so it replaces it');
    assert.deepStrictEqual(visible(), ['Pay rent'], 'still one notification, with the local title');
  }

  // --- the local one was dismissed: placeholder shown and closed, tray stays empty --------------
  {
    registration.tray.length = 0;
    const before = registration.calls.length;
    clock.now = at(14, 41);
    assert.strictEqual(await sw.push(undefined), 'closed');
    assert.strictEqual(registration.calls.length, before + 1, 'showNotification was called');
    assert.strictEqual(registration.calls[before].silent, true);
    assert.deepStrictEqual(visible(), [], 'and nothing stays visible');
  }

  // --- two items in one window, only one shown yet: the push shows the generic reminder ---------
  reset();
  tasks = [task({ reminder_windows: [{ id: rid('a'), window_start: winOf(at(14, 37)) }] })];
  notes = [note({}, { at: iso(at(14, 44)), push: true, rid: rid('b'), window_start: winOf(at(14, 44)) })];
  {
    await run(planner(), at(14, 36), at(14, 39));
    assert.deepStrictEqual(visible(), ['Pay rent'], 'note not due yet');
    clock.now = at(14, 40);
    assert.strictEqual(await sw.push(undefined), 'window');
    assert.deepStrictEqual(visible(), ['Pay rent', 'Deeperguard'], 'the push for the note is not swallowed');
    // Once the note fired too, both pushes of that window are covered.
    await run(planner(), at(14, 44), at(14, 45));
    clock.now = at(14, 46);
    assert.strictEqual(await sw.push(undefined), 'replaced');
  }

  // --- a task planned with the opt-in 5-minute window (14:35 for 14:37) is deduplicated the same way
  reset();
  tasks = [task({ reminder_windows: [{ id: rid('e'), window_start: Math.floor(at(14, 37) / 1000 / 300) * 300 }] })];
  {
    await run(planner(), at(14, 36), at(14, 38));
    assert.deepStrictEqual(visible(), ['Pay rent']);
    clock.now = at(14, 40);
    assert.strictEqual(await sw.push(undefined), 'replaced', 'the 5-minute window counts as shown locally');
    assert.deepStrictEqual(visible(), ['Pay rent']);
  }

  // --- two windows: the newer one shown, the older one not: the push shows ----------------------
  reset();
  tasks = [
    task({ reminder_windows: [{ id: rid('a'), window_start: winOf(at(14, 37)) }] }),
    // Saved after its own time, so it never fired locally; its window is still on the server.
    task({ id: 't2', title: 'Water plants', due_time: '14:20', updated_at: iso(at(14, 25)), reminder_windows: [{ id: rid('c'), window_start: winOf(at(14, 20)) }] }),
  ];
  {
    await run(planner(), at(14, 36), at(14, 38));
    assert.deepStrictEqual(visible(), ['Pay rent']);
    clock.now = at(14, 41); // a late push for 14:15 and a push for 14:30 look the same
    assert.strictEqual(await sw.push(undefined), 'window');
  }

  // --- no tab has written anything, or the tab is long closed: the push shows -------------------
  reset();
  clock.now = at(14, 40);
  assert.strictEqual(await sw.push(undefined), 'window', 'no snapshot');
  tasks = [
    task({ reminder_windows: [{ id: rid('a'), window_start: winOf(at(14, 37)) }] }),
    task({ id: 't3', title: 'Pick up parcel', due_time: '15:05', reminder_windows: [{ id: rid('d'), window_start: winOf(at(15, 5)) }] }),
  ];
  await run(planner(), at(14, 36), at(14, 38)); // then the tab is closed
  clock.now = at(15, 6); // the push for 15:00: the closed tab's list ends before that window
  assert.strictEqual(await sw.push(undefined), 'window', 'stale snapshot');
  const last = registration.calls[registration.calls.length - 1];
  assert.strictEqual(last.body, 'You have a reminder');
  assert.ok(!last.silent, 'shown with sound, as a new reminder');

  // --- agenda push with the same reminder id as a locally shown event --------------------------
  reset();
  const ev = {
    id: 'ev-1', type: 'agenda_event', title: 'Dentist', start: iso(at(15, 0)), end: iso(at(15, 30)),
    all_day: false, rrule: '', reminders: [15], updated_at: savedAt,
  };
  events = [ev];
  {
    // The id the server row got when the event was synced for push.
    const [row] = await R.planReminders(ev, ['push'], at(9, 0));
    await run(planner(), at(14, 44), at(14, 46));
    assert.deepStrictEqual(visible(), ['Dentist']);
    clock.now = at(14, 46);
    assert.strictEqual(await sw.push({ title: 'Deeperguard', body: 'You have an event at 15:00.', reminder_id: row.id }), 'replaced');
    assert.deepStrictEqual(visible(), ['Dentist'], 'no second notification for the same id');
    assert.strictEqual(await sw.push({ title: 'Deeperguard', body: 'You have an event at 16:00.', reminder_id: 'other-id' }), 'agenda');
    assert.deepStrictEqual(visible(), ['Dentist', 'Deeperguard'], 'another id still shows');
  }

  // --- what is stored for the worker: no titles ---------------------------------------------------
  const stored = JSON.stringify([...idb.dbs.get(L.DEDUP_DB).get(L.DEDUP_STORE).entries()]);
  for (const secret of ['Dentist', 'Pay rent', 'Call the bank', 'ev-1']) {
    assert.ok(!stored.includes(secret), `"${secret}" is not in the shared store`);
  }
  assert.deepStrictEqual(network, [], 'nothing was sent to the server');

  console.log('test_reminder_local_push_dedup ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
