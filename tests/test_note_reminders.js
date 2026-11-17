/**
 * Note reminders on the window-push path (docs/design/reminders.md §3.2, §4, M4).
 * Runs the real modules against a fake store/API and asserts on what is uploaded, withdrawn and opened.
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
for (const f of ['agenda-reminders', 'agenda-tasks', 'agenda-task-reminders', 'note-reminders']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, `app/static/js/${f}.js`), 'utf8'), { filename: `${f}.js` });
}
const NR = global.NotesNoteReminders;

let plan = 'pro';
let online = true;
let calls = [];
const notes = new Map();
global.NotesStore = {
  cachedAccount: () => ({ plan }),
  get: (uuid) => (notes.has(uuid) ? { uuid, content: notes.get(uuid) } : null),
  upsert: (uuid, content) => { notes.set(uuid, { ...content }); },
  listNotes: () => [...notes.entries()].map(([uuid, content]) => ({ uuid, content })),
  async api(url, opts) {
    if (!online) throw new Error('offline');
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  },
};

const reset = () => { notes.clear(); calls = []; storage.clear(); plan = 'pro'; online = true; subscribed = true; };
const puts = () => calls.filter((c) => c.url === '/api/push-windows');
const dels = () => calls.filter((c) => c.url === '/api/push-windows/delete');
const inMs = (ms) => new Date(Date.now() + ms).toISOString();
const win = (iso) => Math.floor(Date.parse(iso) / 1000 / 900) * 900;
const note = (uuid, extra) => notes.set(uuid, { type: 'note', title: 'SECRET-TITLE', text: 'SECRET-BODY', ...extra });

(async () => {
  // A note with a push reminder is scheduled in the right 15-minute window, as id + window only.
  reset();
  const at = inMs(3 * 3600 * 1000 + 37000);
  note('11111111-aaaa-bbbb-cccc-000000000001', { reminders: [{ at, push: true }] });
  const U = '11111111-aaaa-bbbb-cccc-000000000001';
  await NR.syncNoteReminders(U);
  assert.strictEqual(puts().length, 1);
  const body = puts()[0].body;
  assert.deepStrictEqual(Object.keys(body).sort(), ['endpoint', 'windows']);
  assert.strictEqual(body.endpoint, ENDPOINT);
  assert.strictEqual(body.windows.length, 1);
  assert.deepStrictEqual(Object.keys(body.windows[0]).sort(), ['id', 'window_start']);
  assert.match(body.windows[0].id, /^[0-9a-f]{32}$/);
  assert.strictEqual(body.windows[0].window_start, win(at));
  assert.strictEqual(body.windows[0].window_start % 900, 0);
  const wire = JSON.stringify(calls);
  assert.ok(!wire.includes('SECRET') && !wire.includes(U), 'no title, text or note id leaves the device');
  assert.ok(!wire.includes(String(Math.floor(Date.parse(at) / 1000))), 'no exact time leaves the device');
  assert.strictEqual(notes.get(U).reminders[0].rid, body.windows[0].id);

  // The same action twice uploads nothing new.
  await NR.syncNoteReminders(U);
  assert.strictEqual(puts().length, 1);
  assert.strictEqual(dels().length, 0);

  // Moving the reminder withdraws the old window and uploads the new one.
  const oldRid = notes.get(U).reminders[0].rid;
  const later = inMs(5 * 3600 * 1000);
  notes.set(U, { ...notes.get(U), reminders: [{ ...notes.get(U).reminders[0], at: later }] });
  await NR.syncNoteReminders(U);
  assert.deepStrictEqual(dels()[0].body, { ids: [oldRid] });
  assert.strictEqual(puts().length, 2);
  assert.strictEqual(puts()[1].body.windows[0].window_start, win(later));
  assert.notStrictEqual(notes.get(U).reminders[0].rid, oldRid);

  // Turning push off withdraws it; the reminder itself stays in the note.
  const rid2 = notes.get(U).reminders[0].rid;
  notes.set(U, { ...notes.get(U), reminders: [{ ...notes.get(U).reminders[0], push: false }] });
  await NR.syncNoteReminders(U);
  assert.deepStrictEqual(dels()[1].body, { ids: [rid2] });
  assert.strictEqual(notes.get(U).reminders[0].rid, undefined);
  assert.strictEqual(notes.get(U).reminders[0].at, later);

  // Deleting / trashing / clearing: cancel withdraws the stored id; without one nothing is sent.
  reset();
  note(U, { reminders: [{ at, push: true }] });
  await NR.syncNoteReminders(U);
  const stored = notes.get(U);
  calls = [];
  await NR.cancelNoteReminders(stored);
  assert.deepStrictEqual(dels()[0].body, { ids: [stored.reminders[0].rid] });
  calls = [];
  await NR.cancelNoteReminders({ reminders: [{ at, push: true }] });
  await NR.cancelNoteReminders({});
  assert.strictEqual(calls.length, 0);

  // A trashed note schedules nothing, and withdraws what it had.
  notes.set(U, { ...stored, trashed: true });
  calls = [];
  await NR.syncNoteReminders(U);
  assert.strictEqual(puts().length, 0);
  assert.strictEqual(dels().length, 1);

  // Offline withdrawal is queued as bare ids and retried through the shared queue.
  reset();
  note(U, { reminders: [{ at, push: true }] });
  await NR.syncNoteReminders(U);
  const pending = notes.get(U);
  online = false;
  await assert.rejects(NR.cancelNoteReminders(pending));
  assert.deepStrictEqual(JSON.parse(storage.get('task_reminder_pending_deletes_v1')), [pending.reminders[0].rid]);
  online = true;
  calls = [];
  await global.NotesAgendaTaskReminders.flushPending();
  assert.deepStrictEqual(dels()[0].body.ids, [pending.reminders[0].rid]);

  // No push subscription: nothing uploaded, the caller is told why, the note keeps its reminder.
  reset();
  subscribed = false;
  note(U, { reminders: [{ at, push: true }] });
  await assert.rejects(NR.syncNoteReminders(U), (e) => e.code === 'no_device');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(notes.get(U).reminders[0].at, at);

  // Free plan, push off, no reminder, past and too-far reminders: nothing planned.
  reset();
  plan = 'free';
  note(U, { reminders: [{ at, push: true }] });
  await NR.syncNoteReminders(U);
  assert.strictEqual(calls.length, 0);
  const now = Date.now();
  assert.strictEqual(NR.plannedWindow({ reminders: [{ at, push: false }] }, now), 0);
  assert.strictEqual(NR.plannedWindow({}, now), 0);
  assert.strictEqual(NR.plannedWindow({ reminders: [{ at: inMs(-3600000), push: true }] }, now), 0);
  assert.strictEqual(NR.plannedWindow({ reminders: [{ at: inMs(400 * 86400000), push: true }] }, now), 0);
  assert.strictEqual(NR.plannedWindow({ reminders: [{ at: 'garbage', push: true }] }, now), 0);

  // Opening the notification: the client finds the note locally from the window alone.
  const t = Date.now() / 1000;
  const start = Math.floor(t / 900) * 900;
  const rid = (n) => n.toString(16).padStart(32, '0');
  const list = [
    { uuid: 'a', content: { reminders: [{ at, push: true, rid: rid(1), window_start: start - 3600 }] } }, // too old
    { uuid: 'b', content: { reminders: [{ at, push: true, rid: rid(2), window_start: start - 900 }] } },
    { uuid: 'c', content: { reminders: [{ at, push: true, rid: rid(3), window_start: start }] } },
    { uuid: 'd', content: { reminders: [{ at, push: true, rid: rid(4), window_start: start + 900 }] } }, // future
    { uuid: 'e', content: { trashed: true, reminders: [{ at, push: true, rid: rid(5), window_start: start }] } },
    { uuid: 'f', deleted: true, content: { reminders: [{ at, push: true, rid: rid(6), window_start: start }] } },
    { uuid: 'g', content: { reminders: [{ at, push: false }] } },
  ];
  assert.strictEqual(NR.findDueNote(list, t * 1000), 'c');
  assert.strictEqual(NR.findDueNote([list[3], list[6]], t * 1000), '');
  assert.strictEqual(NR.findDueNote([], t * 1000), '');
  reset();
  note('c', { reminders: [{ at, push: true, rid: rid(3), window_start: start }] });
  NR.markDelivered('c');
  assert.strictEqual(NR.findDueNote(global.NotesStore.listNotes(), t * 1000), '', 'opens once');
  assert.strictEqual(notes.get('c').reminders[0].at, at);

  console.log('note reminders OK');
})().catch((e) => { console.error(e); process.exit(1); });
