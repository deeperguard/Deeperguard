/** Local note reminders: set/change/clear, fire when open, missed after unlock, generic notification, honest text. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app/static/js/note-local-reminders.js'), 'utf8');
const network = [];
global.fetch = () => { network.push('fetch'); throw new Error('network used'); };
global.window = global;
global.__DG_NO_LOCAL_REMINDERS = true;
vm.runInThisContext(src);
const R = global.NotesNoteReminders;

const NOW = new Date('2026-12-01T10:00:00').getTime();
const note = (uuid, extra) => ({ uuid, content: { type: 'note', title: 'Secret title', content: 'Secret body', ...extra } });

// set / change / clear
const r = R.buildReminder('2026-12-01T09:30', { custom: 'keep' });
assert.strictEqual(r.at, '2026-12-01T09:30:00');
assert.strictEqual(r.v, 1);
assert.strictEqual(r.custom, 'keep');
assert.strictEqual(R.buildReminder('', null), null);
assert.strictEqual(R.toInputValue(r), '2026-12-01T09:30');
const changed = R.buildReminder('2026-12-02T08:00', { ...r, fired_at: '2026-12-01T09:31:00.000Z' });
assert.strictEqual(changed.fired_at, '');

function planner(notes, opts = {}) {
  const shown = []; const notified = []; const store = new Map(notes.map((n) => [n.uuid, n]));
  const p = R.createPlanner({
    now: () => opts.now || NOW,
    isUnlocked: () => opts.unlocked !== false,
    listNotes: () => [...store.values()],
    update: (u, rem) => { store.get(u).content.reminder = rem; },
    banner: (x, title) => shown.push({ ...x, title }),
    notify: () => notified.push(1),
    isHidden: () => !!opts.hidden,
  });
  return { p, shown, notified, store };
}

// fires during an open session (due a minute ago), once
let t = planner([note('a', { reminder: R.buildReminder('2026-12-01T09:59') })]);
t.p.check(); t.p.check();
assert.strictEqual(t.shown.length, 1);
assert.strictEqual(t.shown[0].missed, false);
assert.ok(t.store.get('a').content.reminder.fired_at);

// future reminder does not fire
t = planner([note('b', { reminder: R.buildReminder('2026-12-01T11:00') })]);
t.p.check();
assert.strictEqual(t.shown.length, 0);

// missed one appears after unlock, flagged, with no OS notification
t = planner([note('c', { reminder: R.buildReminder('2026-11-30T09:00') })], { hidden: true });
t.p.check();
assert.strictEqual(t.shown.length, 1);
assert.strictEqual(t.shown[0].missed, true);
assert.strictEqual(t.notified.length, 0);

// locked: nothing fires; trashed and too old are skipped
t = planner([note('d', { reminder: R.buildReminder('2026-12-01T09:59') })], { unlocked: false });
assert.strictEqual(t.p.check().length, 0);
t = planner([note('e', { trashed: true, reminder: R.buildReminder('2026-12-01T09:59') }),
  note('f', { reminder: R.buildReminder('2026-10-01T09:59') })]);
assert.strictEqual(t.p.check().length, 0);

// newer version is left alone
t = planner([note('g', { reminder: { ...R.buildReminder('2026-12-01T09:59'), v: 2 } })]);
assert.strictEqual(t.p.check().length, 0);

// OS notification is generic: no title or content, random tag
const made = [];
global.Notification = function Notification(title, opts) { made.push({ title, opts }); this.close = () => {}; };
global.Notification.permission = 'granted';
R.showNotification();
R.showNotification();
assert.strictEqual(made.length, 2);
for (const m of made) {
  assert.strictEqual(m.title, 'Deeperguard');
  assert.strictEqual(m.opts.body, 'You have a reminder');
  assert.ok(!JSON.stringify(m).includes('Secret'));
}
assert.notStrictEqual(made[0].opts.tag, made[1].opts.tag);

// end to end: hidden page + due note -> notification without the note text
made.length = 0;
const store = [note('h', { reminder: R.buildReminder('2026-12-01T09:59') })];
R.createPlanner({
  now: () => NOW, isUnlocked: () => true, listNotes: () => store,
  update: (u, rem) => { store[0].content.reminder = rem; }, banner: () => {}, isHidden: () => true,
}).check();
assert.strictEqual(made.length, 1);
assert.ok(!JSON.stringify(made).includes('Secret'));

// permission asked only after confirmation text
global.Notification.permission = 'default';
let asked = 0;
global.Notification.requestPermission = async () => { asked += 1; return 'granted'; };
(async () => {
  assert.strictEqual(await R.requestNotificationPermission(() => false), 'default');
  assert.strictEqual(asked, 0);
  let shownText = '';
  await R.requestNotificationPermission((txt) => { shownText = txt; return true; });
  assert.strictEqual(asked, 1);
  assert.ok(shownText.startsWith('Reminders only work while Deeperguard is open and unlocked.'));

  // UI states the limitation literally, as in the spec
  const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
  const spec = fs.readFileSync(path.join(root, 'docs/REMINDERS_TASKS_SPEC.md'), 'utf8');
  for (const s of [R.SETTINGS_TEXT, R.CLOSED_APP_TEXT]) {
    assert.ok(html.includes(s), 'template has text');
    assert.ok(spec.includes(s), 'spec has text');
  }
  assert.ok(!/fetch|XMLHttpRequest|\/api\//.test(src.replace(/\/\*[\s\S]*?\*\//, '')), 'module uses no network');
  assert.deepStrictEqual(network, []);
  console.log('note local reminders ok');
})().catch((e) => { console.error(e); process.exit(1); });
