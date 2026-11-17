/**
 * Reminders on dated tasks: the window-push path (docs/design/reminders.md M3).
 * Runs the real modules against a fake store/API and asserts on what is uploaded and withdrawn.
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
global.document = { documentElement: { lang: 'en' }, getElementById: () => null, querySelector: () => null, addEventListener() {} };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';
let subscribed = true;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => (subscribed ? { endpoint: ENDPOINT } : null) } }) } },
});
for (const f of ['agenda-reminders', 'agenda-tasks', 'agenda-task-reminders']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, `app/static/js/${f}.js`), 'utf8'), { filename: `${f}.js` });
}
const T = global.NotesAgendaTasks;
const TR = global.NotesAgendaTaskReminders;

let plan = 'pro';
let online = true;
let calls = [];
const tasks = new Map();
global.NotesStore = {
  cachedAccount: () => ({ plan }),
  isUnlocked: () => true,
  listAgendaTasks: () => [...tasks.entries()].map(([id, c]) => ({ ...c, id })),
  upsertAgendaTask: (id, content) => { tasks.set(id, { ...content }); return id; },
  async api(url, opts) {
    if (!online) throw new Error('offline');
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  },
};

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const reset = () => { tasks.clear(); calls = []; storage.clear(); plan = 'pro'; online = true; subscribed = true; };
const puts = () => calls.filter((c) => c.url === '/api/push-windows');
const dels = () => calls.filter((c) => c.url === '/api/push-windows/delete');
const save = (id, fields) => tasks.set(id, T.buildTask({ title: 'SECRET-TITLE', ...fields }, tasks.get(id)));

(async () => {
  // A task with a date and a reminder is planned in the right 15-minute window, as id + window only.
  reset();
  const due = fmt(inDays(5));
  save('t1', { due, due_time: '14:30', reminder: { offsets: [10, 1440] } });
  await TR.syncTaskReminders('t1');
  assert.strictEqual(puts().length, 1);
  const body = puts()[0].body;
  assert.deepStrictEqual(Object.keys(body).sort(), ['endpoint', 'windows']);
  assert.strictEqual(body.endpoint, ENDPOINT);
  const [y, m, d] = due.split('-').map(Number);
  const at = (min) => Math.floor(new Date(y, m - 1, d, 14, 30).getTime() / 1000 - min * 60);
  const win = (min) => Math.floor(at(min) / 900) * 900;
  assert.deepStrictEqual(body.windows.map((w) => w.window_start), [win(1440), win(10)]);
  for (const w of body.windows) {
    assert.deepStrictEqual(Object.keys(w).sort(), ['id', 'window_start']);
    assert.match(w.id, /^[0-9a-f]{32}$/);
    assert.strictEqual(w.window_start % 900, 0);
  }
  assert.ok(!JSON.stringify(calls).includes('SECRET'), 'no title leaves the device');
  assert.deepStrictEqual(tasks.get('t1').reminder_windows.map((w) => w.id), body.windows.map((w) => w.id));

  // The same action twice uploads nothing new.
  await TR.syncTaskReminders('t1');
  assert.strictEqual(puts().length, 1);

  // A date-only task is reminded at 09:00 local.
  reset();
  save('t2', { due, reminder: { offsets: [0] } });
  await TR.syncTaskReminders('t2');
  assert.strictEqual(puts()[0].body.windows[0].window_start, Math.floor(new Date(y, m - 1, d, 9, 0).getTime() / 1000 / 900) * 900);

  // Ticking the task off withdraws the windows (by id, not by device); reopening schedules again.
  reset();
  save('t3', { due, due_time: '14:30', reminder: { offsets: [10, 60] } });
  await TR.syncTaskReminders('t3');
  const ids = tasks.get('t3').reminder_windows.map((w) => w.id);
  assert.strictEqual(ids.length, 2);
  tasks.set('t3', T.withDone(tasks.get('t3'), true));
  await TR.syncTaskReminders('t3');
  assert.strictEqual(dels().length, 1);
  assert.deepStrictEqual(dels()[0].body, { ids });
  assert.deepStrictEqual(tasks.get('t3').reminder_windows, []);
  await TR.syncTaskReminders('t3');
  assert.strictEqual(dels().length, 1, 'second sync of a done task does nothing');
  tasks.set('t3', T.withDone(tasks.get('t3'), false));
  await TR.syncTaskReminders('t3');
  assert.strictEqual(puts().length, 2);
  assert.strictEqual(tasks.get('t3').reminder_windows.length, 2);

  // Deleting the task withdraws its windows; without windows nothing is sent.
  const row = tasks.get('t3');
  calls = [];
  await TR.cancelTaskReminders(row);
  assert.deepStrictEqual(dels()[0].body.ids, row.reminder_windows.map((w) => w.id));
  calls = [];
  await TR.cancelTaskReminders({ reminder_windows: [] });
  assert.strictEqual(calls.length, 0);

  // Changing the date replaces the windows; removing the reminder withdraws them.
  reset();
  save('t4', { due, due_time: '14:30', reminder: { offsets: [10] } });
  await TR.syncTaskReminders('t4');
  const old = tasks.get('t4').reminder_windows[0];
  save('t4', { due: fmt(inDays(6)), reminder: { offsets: [10] } });
  await TR.syncTaskReminders('t4');
  assert.deepStrictEqual(dels()[0].body.ids, [old.id]);
  assert.notStrictEqual(tasks.get('t4').reminder_windows[0].id, old.id);
  save('t4', { reminder: null });
  await TR.syncTaskReminders('t4');
  assert.deepStrictEqual(tasks.get('t4').reminder_windows, []);

  // Offline cancel is queued as bare ids and retried.
  reset();
  save('t5', { due, due_time: '14:30', reminder: { offsets: [10] } });
  await TR.syncTaskReminders('t5');
  const pending = tasks.get('t5');
  online = false;
  await assert.rejects(TR.cancelTaskReminders(pending));
  assert.deepStrictEqual(JSON.parse(storage.get('task_reminder_pending_deletes_v1')), pending.reminder_windows.map((w) => w.id));
  online = true;
  calls = [];
  await TR.flushPending();
  assert.deepStrictEqual(dels()[0].body.ids, pending.reminder_windows.map((w) => w.id));
  assert.strictEqual(storage.has('task_reminder_pending_deletes_v1'), false);

  // No push subscription on this device: nothing is uploaded and the caller is told why.
  reset();
  subscribed = false;
  save('t6', { due, reminder: { offsets: [0] } });
  await assert.rejects(TR.syncTaskReminders('t6'), (e) => e.code === 'no_device');
  assert.strictEqual(calls.length, 0);

  // Free plan: no server reminders. Past or too-far dates and no reminder: nothing planned.
  reset();
  plan = 'free';
  save('t7', { due, reminder: { offsets: [0] } });
  await TR.syncTaskReminders('t7');
  assert.strictEqual(calls.length, 0);
  const now = Date.now();
  assert.deepStrictEqual(TR.plannedWindows({ due: fmt(inDays(-1)), reminder: { offsets: [0] } }, now), []);
  assert.deepStrictEqual(TR.plannedWindows({ due: fmt(inDays(400)), reminder: { offsets: [0] } }, now), []);
  assert.deepStrictEqual(TR.plannedWindows({ due, reminder: null }, now), []);

  // The editor offsets are normalised.
  assert.deepStrictEqual(T.normalizeReminder({ offsets: [60, 10, 10, -1, 'x', 99999999] }), { offsets: [10, 60] });
  assert.strictEqual(T.normalizeReminder({ offsets: [] }), null);
  console.log('agenda task reminders OK');
})().catch((e) => { console.error(e); process.exit(1); });
