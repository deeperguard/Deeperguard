/**
 * Opt-in 5-minute server window (docs/design/finer-reminder-window.md).
 * Runs the real reminder modules against a fake store/API and asserts on what leaves the device.
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
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: ENDPOINT }) } }) } },
});
for (const f of ['agenda-recurrence', 'agenda-reminders', 'agenda-tasks', 'agenda-task-reminders', 'note-reminders']) {
  const file = path.join(root, `app/static/js/${f}.js`);
  if (fs.existsSync(file)) vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: `${f}.js` });
}
const R = global.NotesAgendaReminders;
const T = global.NotesAgendaTasks;
const TR = global.NotesAgendaTaskReminders;
const NR = global.NotesNoteReminders;

let calls = [];
const tasks = new Map();
const notes = new Map();
const events = new Map();
global.NotesStore = {
  cachedAccount: () => ({ plan: 'pro' }),
  isUnlocked: () => true,
  listAgendaTasks: () => [...tasks.entries()].map(([id, c]) => ({ ...c, id })),
  upsertAgendaTask: (id, content) => { tasks.set(id, { ...content }); return id; },
  listAgendaEvents: () => [...events.entries()].map(([id, c]) => ({ ...c, id })),
  upsertAgendaEvent: (id, content) => { events.set(id, { ...content }); return id; },
  get: (uuid) => (notes.has(uuid) ? { uuid, content: notes.get(uuid) } : null),
  upsert: (uuid, content) => { notes.set(uuid, content); },
  async api(url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    if (url === '/api/agenda-reminders/channels') return { email: true, push: true };
    return { ok: true };
  },
};

const setWindow = (minutes) => {
  const prefs = { agenda_reminder_email: true };
  if (minutes === 5) prefs.reminder_window_min = 5;
  storage.set('deeperguard-prefs', JSON.stringify(prefs));
};
const reset = (minutes) => { tasks.clear(); notes.clear(); events.clear(); calls = []; storage.clear(); setWindow(minutes); };
const puts = () => calls.filter((c) => c.url === '/api/push-windows');
const dels = () => calls.filter((c) => c.url === '/api/push-windows/delete');
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n, hh, mm) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(hh, mm, 0, 0); return d; };
const sec = (d) => Math.floor(d.getTime() / 1000);

(async () => {
  // ---- the choice itself: 15 minutes unless this device stored exactly 5 ----
  reset(15);
  assert.strictEqual(R.serverWindowSec(), 900);
  storage.set('deeperguard-prefs', JSON.stringify({ reminder_window_min: 1 }));
  assert.strictEqual(R.serverWindowSec(), 900, 'only 5 is an accepted finer choice');
  storage.set('deeperguard-prefs', 'not json');
  assert.strictEqual(R.serverWindowSec(), 900);
  reset(5);
  assert.strictEqual(R.serverWindowSec(), 300);

  // ---- tasks ----
  // 14:37 minus 10 minutes = 14:27: the 15-minute window starts 14:15, the 5-minute window 14:25.
  const due = inDays(5, 14, 37);
  const fireSec = sec(due) - 600;
  reset(15);
  tasks.set('t1', T.buildTask({ title: 'SECRET-TITLE', due: fmt(due), due_time: '14:37', reminder: { offsets: [10] } }));
  await TR.syncTaskReminders('t1');
  assert.strictEqual(puts().length, 1);
  assert.deepStrictEqual(Object.keys(puts()[0].body).sort(), ['endpoint', 'windows'], 'no opt-in field by default');
  const coarse = puts()[0].body.windows[0];
  assert.strictEqual(coarse.window_start, fireSec - 12 * 60);

  // Opting in re-plans the same task: the coarse window is withdrawn, a 5-minute one uploaded with the flag.
  setWindow(5);
  calls = [];
  await TR.syncTaskReminders('t1');
  assert.deepStrictEqual(dels().map((c) => c.body.ids), [[coarse.id]]);
  assert.strictEqual(puts().length, 1);
  assert.strictEqual(puts()[0].body.window_sec, 300);
  assert.deepStrictEqual(Object.keys(puts()[0].body).sort(), ['endpoint', 'window_sec', 'windows']);
  const fine = puts()[0].body.windows[0];
  assert.strictEqual(fine.window_start, fireSec - 2 * 60);
  assert.deepStrictEqual(Object.keys(fine).sort(), ['id', 'window_start']);
  assert.ok(!JSON.stringify(calls).includes('SECRET-TITLE'));
  assert.ok(!JSON.stringify(calls).includes(String(fireSec)), 'the exact time never leaves the device');

  // The same action twice uploads nothing more.
  calls = [];
  await TR.syncTaskReminders('t1');
  assert.strictEqual(calls.length, 0);

  // Opting out again moves the task back to the 15-minute window, without the flag.
  setWindow(15);
  calls = [];
  await TR.syncTaskReminders('t1');
  assert.deepStrictEqual(dels().map((c) => c.body.ids), [[fine.id]]);
  assert.strictEqual(puts()[0].body.windows[0].window_start, coarse.window_start);
  assert.ok(!('window_sec' in puts()[0].body));

  // With the opt-in, a reminder that falls on a quarter hour needs no flag: nothing finer is revealed.
  reset(5);
  const onQuarter = inDays(6, 9, 30);
  tasks.set('t2', T.buildTask({ title: 'x', due: fmt(onQuarter), due_time: '09:30', reminder: { offsets: [0] } }));
  await TR.syncTaskReminders('t2');
  assert.strictEqual(puts()[0].body.windows[0].window_start, sec(onQuarter));
  assert.ok(!('window_sec' in puts()[0].body));

  // Many reminders, mixed: one on a quarter, one not -> one upload carrying the flag.
  reset(5);
  tasks.set('t3', T.buildTask({ title: 'x', due: fmt(onQuarter), due_time: '09:30', reminder: { offsets: [0, 10] } }));
  await TR.syncTaskReminders('t3');
  assert.deepStrictEqual(puts()[0].body.windows.map((w) => w.window_start), [sec(onQuarter) - 600, sec(onQuarter)]);
  assert.strictEqual(puts()[0].body.window_sec, 300);

  // No reminders: nothing is sent, with or without the opt-in.
  reset(5);
  tasks.set('t4', T.buildTask({ title: 'x', due: fmt(onQuarter), due_time: '09:30' }));
  await TR.syncTaskReminders('t4');
  assert.strictEqual(calls.length, 0);

  // ---- notes ----
  const at = inDays(3, 8, 52);
  reset(15);
  notes.set('n1', { title: 'SECRET-NOTE', reminders: [{ at: at.toISOString(), push: true }] });
  await NR.syncNoteReminders('n1');
  assert.strictEqual(puts()[0].body.windows[0].window_start, sec(at) - 7 * 60);
  assert.ok(!('window_sec' in puts()[0].body));
  reset(5);
  notes.set('n1', { title: 'SECRET-NOTE', reminders: [{ at: at.toISOString(), push: true }] });
  await NR.syncNoteReminders('n1');
  assert.strictEqual(puts()[0].body.windows[0].window_start, sec(at) - 2 * 60);
  assert.strictEqual(puts()[0].body.window_sec, 300);
  assert.strictEqual(notes.get('n1').reminders[0].window_start, sec(at) - 2 * 60);
  assert.ok(!JSON.stringify(calls).includes('SECRET-NOTE'));

  // ---- event email reminders ----
  const start = inDays(4, 11, 3); // 10 minutes before = 10:53: windows 10:45 (15 min) and 10:50 (5 min)
  const ev = { title: 'SECRET-EVENT', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), all_day: false, reminders: [10] };
  const syncs = () => calls.filter((c) => c.url === '/api/agenda-reminders/sync');
  reset(15);
  events.set('e1', { ...ev });
  await R.syncEventReminders('e1');
  assert.strictEqual(syncs().length, 1);
  assert.deepStrictEqual(syncs()[0].body.reminders.map((r) => [r.channel, r.fire_at]), [['email', sec(start) - 18 * 60]]);
  assert.ok(!('window_sec' in syncs()[0].body));
  reset(5);
  events.set('e1', { ...ev });
  await R.syncEventReminders('e1');
  assert.deepStrictEqual(syncs()[0].body.reminders.map((r) => [r.channel, r.fire_at]), [['email', sec(start) - 13 * 60]]);
  assert.strictEqual(syncs()[0].body.window_sec, 300);
  assert.ok(!JSON.stringify(calls).includes('SECRET-EVENT'));
  assert.ok(!JSON.stringify(syncs()).includes(String(sec(start) - 600)), 'the exact reminder time is not uploaded');

  // ---- the texts that name the window follow the choice ----
  const hint = 'The server learns a 15-minute window, and it can come up to 15 minutes early.';
  setWindow(15);
  assert.strictEqual(R.windowCopy(hint), hint);
  setWindow(5);
  assert.strictEqual(R.windowCopy(hint), 'The server learns a 5-minute window, and it can come up to 5 minutes early.');

  console.log('reminder fine window OK');
})().catch((err) => { console.error(err); process.exit(1); });
