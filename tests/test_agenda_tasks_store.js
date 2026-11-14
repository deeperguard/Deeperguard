// Dated tasks through the real NotesStore: create, edit, complete, delete, push
// (encrypted), and load again after lock + fresh unlock from server rows.
const assert = require('assert');
const path = require('path');
const h = require('./sync_harness');
const Tasks = require(path.join(__dirname, '..', 'app', 'static', 'js', 'agenda-tasks.js'));

const { NotesStore } = h;

function pushedRows() {
  return h.pushCalls().flatMap((c) => c.body.items || []);
}

(async () => {
  await h.unlockFresh();
  h.resetServer();

  // Legacy note without any task fields keeps loading and listing.
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Old note', content: '- [ ] buy milk' });

  // --- create -------------------------------------------------------------
  const payload = Tasks.buildTask({ title: 'Renew passport', due: '2026-12-01', due_time: '09:30' }, null);
  const id = NotesStore.upsertAgendaTask('', payload);
  assert.ok(id, 'upsertAgendaTask returns the new id');
  let tasks = NotesStore.listAgendaTasks();
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].id, id);
  assert.strictEqual(tasks[0].due, '2026-12-01');
  assert.strictEqual(tasks[0].due_time, '09:30');
  assert.strictEqual(tasks[0].type, 'agenda_task');

  // A task is not a note and not an event.
  assert.ok(!NotesStore.listNotes().some((n) => n.uuid === id), 'task is not in listNotes');
  assert.ok(NotesStore.listNotes().some((n) => n.uuid === noteId), 'old note still listed');
  assert.ok(!NotesStore.listAgendaEvents().some((e) => e.id === id), 'task is not in listAgendaEvents');
  // A note id can never be overwritten as a task.
  assert.strictEqual(NotesStore.upsertAgendaTask(noteId, payload), '');
  assert.strictEqual(NotesStore.get(noteId).content.type, 'note');

  // --- edit (move to another day) keeps unknown keys -------------------------
  const stored = NotesStore.listAgendaTasks()[0];
  const edited = Tasks.buildTask({ title: 'Renew passport!', due: '2026-12-03', due_time: '' }, { ...stored, future_key: 'x' });
  NotesStore.upsertAgendaTask(id, edited);
  tasks = NotesStore.listAgendaTasks();
  assert.strictEqual(tasks.length, 1, 'edit does not duplicate');
  assert.strictEqual(tasks[0].due, '2026-12-03');
  assert.strictEqual(tasks[0].due_time, '');
  assert.strictEqual(tasks[0].future_key, 'x');
  assert.strictEqual(tasks[0].created_at, stored.created_at, 'created_at is preserved');

  // --- complete -----------------------------------------------------------
  NotesStore.upsertAgendaTask(id, Tasks.withDone(tasks[0], true, '2026-11-14T10:00:00.000Z'));
  assert.strictEqual(NotesStore.listAgendaTasks()[0].done_at, '2026-11-14T10:00:00.000Z');

  // --- push: the due date only exists inside the ciphertext ------------------
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  const rows = pushedRows();
  const taskRow = rows.find((r) => r.item_uuid === id);
  assert.ok(taskRow, 'task item is pushed');
  const wire = JSON.stringify(taskRow);
  for (const secret of ['2026-12-03', 'Renew passport', 'agenda_task', 'done_at', 'due']) {
    assert.ok(!wire.includes(secret), `"${secret}" must not appear outside the ciphertext`);
  }
  const plain = await h.decryptRow(taskRow);
  assert.strictEqual(plain.type, 'agenda_task');
  assert.strictEqual(plain.due, '2026-12-03');
  assert.strictEqual(plain.done_at, '2026-11-14T10:00:00.000Z');

  // --- log out, log in again: state comes back from the server rows ----------
  const serverRows = rows.map((r) => ({ ...r, synced_at: Date.now() / 1000 }));
  NotesStore.lock();
  await NotesIDB.clearAll();
  NotesStore.state.items.clear();
  NotesStore.state.lastSync = 0;
  localStorage.removeItem('notes_last_sync');
  await h.unlockFresh();
  await NotesStore.loadLocal({});
  assert.strictEqual(NotesStore.listAgendaTasks().length, 0, 'local cache was wiped');
  h.resetServer();
  h.server.pullPages = [{ items: serverRows, has_more: false }];
  await NotesStore.sync({ full: true, quiet: true });
  tasks = NotesStore.listAgendaTasks();
  assert.strictEqual(tasks.length, 1, 'task is back after re-login');
  assert.strictEqual(tasks[0].due, '2026-12-03');
  assert.ok(Tasks.isDone(tasks[0]), 'completion survives re-login');
  assert.ok(NotesStore.listNotes().some((n) => n.uuid === noteId && n.content.title === 'Old note'), 'old note loads without errors');

  // Placement of the reloaded task: done 2026-11-14, shown on 2026-12-03.
  const placed = Tasks.placeTasks(tasks, new Date(2026, 11, 1), new Date(2026, 11, 8), new Date(2026, 10, 16, 12));
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(placed[0].task.id, id);
  assert.strictEqual(
    Tasks.placeTasks(tasks, new Date(2026, 11, 1), new Date(2026, 11, 8), new Date(2026, 11, 2, 12)).length,
    0,
    'done more than 7 days ago: hidden',
  );
  assert.strictEqual(placed[0].dayMs, new Date(2026, 11, 3).getTime());

  // --- un-complete and delete -------------------------------------------------
  NotesStore.upsertAgendaTask(id, Tasks.withDone(tasks[0], false));
  assert.ok(!Tasks.isDone(NotesStore.listAgendaTasks()[0]));
  assert.strictEqual(NotesStore.removeAgendaTask(noteId), false, 'removeAgendaTask ignores notes');
  assert.ok(!NotesStore.get(noteId).deleted);
  assert.strictEqual(NotesStore.removeAgendaTask(id), true);
  assert.strictEqual(NotesStore.listAgendaTasks().length, 0, 'deleted task is gone');
  h.stopPushTimer();
  h.resetServer();
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(pushedRows().some((r) => r.item_uuid === id && r.deleted), 'tombstone is pushed');

  console.log('test_agenda_tasks_store.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
