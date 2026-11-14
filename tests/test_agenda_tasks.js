/**
 * Dated tasks: payload build/normalise, encrypt + decrypt round trip, agenda placement
 * (due day, overdue on today, done hidden after 7 days) and the rendered markup in
 * list, month and week views.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const storage = new Map();
global.window = global;
global.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
global.document = {
  documentElement: { lang: 'en' },
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
};
vm.runInThisContext(read('app/static/js/vendor/noble-crypto.js'));
const NotesCrypto = require(path.join(root, 'app/static/js/crypto.js'));
for (const f of ['agenda-ics', 'agenda-recurrence', 'agenda-occurrence', 'agenda-scroll-core', 'agenda-reminders', 'agenda-tasks', 'agenda']) {
  vm.runInThisContext(read(`app/static/js/${f}.js`), { filename: `${f}.js` });
}
const T = global.NotesAgendaTasks;
const A = global.NotesAgenda;
assert.ok(T && A);

const NOW = new Date(2026, 10, 14, 10, 0); // Sat 14 Nov 2026
const day = (y, m, d) => new Date(y, m - 1, d).getTime();

(async () => {
  // --- buildTask -------------------------------------------------------------
  const t1 = T.buildTask({ title: '  Renew passport ', due: '2026-12-01', due_time: '09:30' }, null, '2026-11-14T10:00:00.000Z');
  assert.deepStrictEqual(t1, {
    type: 'agenda_task',
    version: 1,
    title: 'Renew passport',
    notes: '',
    due: '2026-12-01',
    due_time: '09:30',
    tz: '',
    rrule: '',
    done_at: '',
    note_uuid: '',
    reminder: null,
    created_at: '2026-11-14T10:00:00.000Z',
    updated_at: '2026-11-14T10:00:00.000Z',
  }, 'payload follows the spec data format');
  assert.strictEqual(T.buildTask({ title: 'x', due: '2026-02-30' }, null), null, 'invalid date rejected');
  assert.strictEqual(T.buildTask({ title: ' ', due: '2026-02-03' }, null), null, 'empty title rejected');
  assert.strictEqual(T.buildTask({ title: 'x', due: '2026-02-03', due_time: '25:00' }, null).due_time, '', 'bad time = all-day');
  const edited = T.buildTask({ due: '2026-12-05' }, { ...t1, id: 'abc', future: 1 }, '2026-11-15T00:00:00.000Z');
  assert.strictEqual(edited.due, '2026-12-05');
  assert.strictEqual(edited.title, 'Renew passport');
  assert.strictEqual(edited.future, 1, 'unknown keys survive an edit');
  assert.strictEqual(edited.created_at, t1.created_at);
  assert.ok(!('id' in edited), 'the item id is not stored inside the payload');

  // --- encrypt, decrypt: due date only in the ciphertext ---------------------
  const { key } = await NotesCrypto.deriveKey('pw', '74b797214bcbc094863155104fb361bb', { kdfVersion: 1 });
  assert.ok(key, 'derived a key');
  const enc = await NotesCrypto.encryptObject(key, t1);
  const wire = JSON.stringify(enc);
  for (const s of ['2026-12-01', '09:30', 'Renew', 'agenda_task', 'due']) {
    assert.ok(!wire.includes(s), `"${s}" not visible in the encrypted payload`);
  }
  assert.deepStrictEqual(await NotesCrypto.decryptObject(key, enc), t1, 'round trip is lossless');

  // --- normalise: old / malformed / newer items never throw ------------------
  const legacy = T.normalizeTask({ title: 'No version', due: '2026-11-20' });
  assert.strictEqual(legacy.version, 1);
  assert.strictEqual(legacy.readOnly, false);
  assert.strictEqual(T.normalizeTask({ version: 9, due: '2026-11-20' }).readOnly, true);
  assert.strictEqual(T.normalizeTask(null).dueValid, false);
  assert.strictEqual(T.normalizeTask({ due: 'garbage' }).dueValid, false);

  // --- placement ---------------------------------------------------------------
  const tasks = [
    { id: 'a', ...t1 },                                                    // 1 Dec
    { id: 'b', title: 'Old overdue', due: '2026-11-10', done_at: '' },    // overdue -> today
    { id: 'c', title: 'Done recent', due: '2026-11-12', done_at: '2026-11-12T08:00:00.000Z' },
    { id: 'd', title: 'Done long ago', due: '2026-11-01', done_at: '2026-11-01T08:00:00.000Z' },
    { id: 'e', title: 'Broken', due: 'not-a-date' },
    { id: 'f', title: 'Today 08:00', due: '2026-11-14', due_time: '08:00' },
    { type: 'note', id: 'g', title: 'An old note without due' },
  ];
  const weekStart = new Date(2026, 10, 9); // Mon 9 Nov
  const weekEnd = new Date(2026, 10, 16);
  let placed = T.placeTasks(tasks, weekStart, weekEnd, NOW);
  assert.deepStrictEqual(placed.map((p) => [p.task.id, p.dayMs, p.overdue]), [
    ['c', day(2026, 11, 12), false],
    ['b', day(2026, 11, 14), true],
    ['f', day(2026, 11, 14), false],
  ], 'overdue once on today (first), done-recent on its day, done-old hidden, malformed skipped');
  assert.ok(!placed.some((p) => p.dayMs === day(2026, 11, 10)), 'overdue not repeated on its past day');
  placed = T.placeTasks(tasks, weekStart, weekEnd, NOW, { showCompleted: true });
  assert.ok(placed.some((p) => p.task.id === 'c'));
  assert.ok(!placed.some((p) => p.task.id === 'd'), 'd is outside this week');
  assert.ok(T.placeTasks(tasks, new Date(2026, 10, 1), new Date(2026, 10, 2), NOW, { showCompleted: true }).some((p) => p.task.id === 'd'),
    'Show completed brings back an old done task');
  assert.deepStrictEqual(T.placeTasks(tasks, new Date(2026, 11, 1), new Date(2026, 11, 2), NOW).map((p) => p.task.id), ['a']);
  assert.deepStrictEqual(T.placeTasks([], weekStart, weekEnd, NOW), []);
  assert.deepStrictEqual(T.placeTasks(undefined, weekStart, weekEnd, NOW), []);

  // --- toggling ---------------------------------------------------------------------
  const done = T.withDone({ id: 'x', ...t1, readOnly: false }, true, '2026-11-14T11:00:00.000Z');
  assert.strictEqual(done.done_at, '2026-11-14T11:00:00.000Z');
  assert.ok(!('id' in done) && !('readOnly' in done));
  assert.strictEqual(T.withDone(done, false).done_at, '');

  // --- accessible name ------------------------------------------------------------
  const name = T.accessibleName(tasks[1], true, 'en-GB');
  assert.ok(/^Task: Old overdue, due .*10.*Nov.*2026, overdue$/.test(name), name);

  // --- rendered markup in the agenda views -------------------------------------------
  const realPlaced = T.placeTasks(tasks, weekStart, weekEnd, NOW);
  const list = A._renderAgendaList([], { start: weekStart, end: weekEnd }, realPlaced);
  assert.ok(list.includes('data-agenda-task="b"') && list.includes('data-agenda-task="f"'), 'tasks render in the list view');
  assert.ok(/<input type="checkbox" class="agenda-task-check"[^>]*data-agenda-task-toggle="c"[^>]* checked/.test(list), 'done task is checked');
  assert.ok(list.includes('Overdue'), 'overdue group heading');
  assert.ok(list.indexOf('data-agenda-task="c"') < list.indexOf('data-agenda-task="b"'), 'days in order');
  assert.ok(/role="listitem"/.test(list) && /<label class="agenda-task-label" for=/.test(list), 'native checkbox with visible label');
  assert.ok(list.includes('aria-label="Edit task Old overdue"'), 'visible edit button with a name');
  assert.ok(!list.includes('agenda-list-empty'), 'a week with only tasks is not empty');

  const monthDays = [];
  for (let i = 0; i < 42; i += 1) monthDays.push(new Date(2026, 9, 26 + i));
  A._state.anchor = new Date(2026, 10, 14);
  const monthPlaced = T.placeTasks(tasks, monthDays[0], new Date(2026, 11, 7), NOW);
  const month = A._renderMonthGrid(monthDays, [], monthPlaced);
  const cell = (ms) => {
    const at = month.indexOf(`data-agenda-month-day="${ms}"`);
    const next = month.indexOf('data-agenda-month-day="', at + 30);
    return month.slice(at, next < 0 ? undefined : next);
  };
  assert.ok(cell(day(2026, 11, 14)).includes('data-agenda-task="b"'), 'overdue chip on today');
  assert.ok(cell(day(2026, 12, 1)).includes('data-agenda-task="a"'), 'dated chip on its day in month view');
  assert.ok(cell(day(2026, 12, 1)).includes('1 task'), 'day button name counts tasks');
  assert.ok(!cell(day(2026, 11, 10)).includes('data-agenda-task'), 'not on the past due day');

  const strip = A._renderTaskStrip([0, 1, 2, 3, 4, 5, 6].map((i) => new Date(2026, 10, 9 + i)), realPlaced);
  const stripCell = (ms) => strip.slice(strip.indexOf(`data-agenda-task-day="${ms}"`), strip.indexOf('</div>', strip.indexOf(`data-agenda-task-day="${ms}"`)));
  assert.ok(stripCell(day(2026, 11, 14)).includes('data-agenda-task="f"'), 'week view strip places task on its column');
  assert.strictEqual(A._renderTaskStrip([new Date(2026, 10, 9)], []), '', 'no strip without tasks');

  // "Show tasks" off hides them everywhere.
  const fakeStore = { listAgendaTasks: () => tasks.filter((t) => t.type !== 'note'), listAgendaEvents: () => [] };
  global.NotesStore = fakeStore;
  assert.strictEqual(A._placedTasksForRange({ start: weekStart, end: weekEnd }).length > 0, true);
  localStorage.setItem('notes_agenda_show_tasks', '0');
  assert.strictEqual(A._placedTasksForRange({ start: weekStart, end: weekEnd }).length, 0, 'Show tasks off');
  localStorage.removeItem('notes_agenda_show_tasks');

  console.log('test_agenda_tasks.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
