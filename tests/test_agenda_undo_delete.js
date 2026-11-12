/**
 * Deleting an event or one occurrence offers Undo (toast with a button); Undo puts the
 * saved content back, clears the delete marker and re-plans reminders.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

assert.ok(app.includes('window.notesAgendaToastUndo = (message, onUndo) => toastWithUndo(message, onUndo);'));

const offer = js.slice(js.indexOf('function offerUndoDelete'), js.indexOf('function deleteEditorConfirmed'));
assert.ok(offer.includes('S.upsertAgendaEvent(id, savedContent)'), 'undo restores the saved content');
assert.ok(offer.includes('syncRemindersAfterSave(id)'), 'undo re-plans reminders');
assert.ok(offer.includes('global.notesAgendaToastUndo(message, undo)'));

const del = js.slice(js.indexOf('function deleteEditorConfirmed'), js.indexOf('async function importIcsFile'));
assert.ok(del.includes("offerUndoDelete(savedId, savedBase, 'Occurrence deleted')"), 'occurrence delete offers undo');
assert.ok(del.includes("offerUndoDelete(savedId, savedContent, 'Event deleted')"), 'event delete offers undo');
assert.ok(del.indexOf('const savedContent') < del.indexOf('S.removeAgendaEvent(state.selectedId);'), 'content is captured before removing');
assert.ok(del.includes('const savedBase = { ...base }'), 'series content is captured before adding the EXDATE');

// Store round trip: removing leaves a tombstone, restoring clears it and brings the event back.
const h = require('./sync_harness');
const { NotesStore } = h;
(async () => {
  await h.unlockFresh();
  const id = NotesStore.newUuid();
  const content = {
    type: 'agenda_event',
    title: 'Dentist',
    start: '2026-11-20T09:00:00.000Z',
    end: '2026-11-20T10:00:00.000Z',
    all_day: false,
    rrule: 'FREQ=WEEKLY',
    ics_exdates: ['20261127T090000Z'],
    scheduled_reminder_ids: [{ id: 'r1', channel: 'email', fire_at: 1 }],
  };
  NotesStore.upsertAgendaEvent(id, content);
  const saved = (() => { const { id: _i, ...rest } = NotesStore.listAgendaEvents().find((e) => e.id === id); return rest; })();
  NotesStore.removeAgendaEvent(id);
  assert.ok(!NotesStore.listAgendaEvents().some((e) => e.id === id));
  assert.ok(NotesStore.get(NotesStore.AGENDA_PACK_UUID).content.deleted_events[id]);
  NotesStore.upsertAgendaEvent(id, saved);
  const back = NotesStore.listAgendaEvents().find((e) => e.id === id);
  assert.strictEqual(back.title, 'Dentist');
  assert.deepStrictEqual(back.ics_exdates, ['20261127T090000Z']);
  assert.deepStrictEqual(back.scheduled_reminder_ids, content.scheduled_reminder_ids);
  assert.ok(!NotesStore.get(NotesStore.AGENDA_PACK_UUID).content.deleted_events[id], 'tombstone cleared by undo');
  console.log('agenda undo delete ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
