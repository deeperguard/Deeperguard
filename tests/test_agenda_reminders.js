/**
 * Agenda reminders: payload shape, series expansion, generic copy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'app/static/js/agenda-reminders.js'), 'utf8'), {
  filename: 'agenda-reminders.js',
});
const R = global.NotesAgendaReminders;
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');
const cron = fs.readFileSync(path.join(root, 'app/agenda_reminder_cron.py'), 'utf8');

assert.ok(R);
assert.ok(appHtml.includes("asset_script('js/agenda-reminders.js')"));
assert.ok(appHtml.includes('agenda-reminder-channel-settings'));

const now = Date.now();
const ev = {
  id: 'ev-1',
  start: new Date(now + 86400000).toISOString(),
  end: new Date(now + 90000000).toISOString(),
  rrule: 'FREQ=WEEKLY;INTERVAL=1',
  reminders: ['m15', 'h1'],
};
const planned = R.computePlannedReminders(ev, ['email', 'push'], now);
assert.ok(planned.length >= 2);
const upload = R.publicUploadRows(planned);
upload.forEach((row) => {
  assert.ok(row.id);
  assert.ok(row.fire_at > 0);
  assert.ok(['email', 'push'].includes(row.channel));
  assert.strictEqual(Object.keys(row).every((k) => R.ALLOWED_UPLOAD_KEYS.has(k)), true);
  assert.ok(!('title' in row));
  assert.ok(!('location' in row));
  assert.ok(!('notes' in row));
});

const starts = R.expandOccurrenceStarts(ev, new Date(now), new Date(now + 60 * 86400000));
assert.ok(starts.length >= 2);

const body = R.genericBody('14:00');
assert.ok(body.includes('14:00'));
assert.ok(!body.includes('Team sync'));

assert.ok(appPy.includes('AGENDA_REMINDER_ALLOWED_KEYS'));
assert.ok(appPy.includes('plaintext event fields forbidden'));
assert.ok(cron.includes('You have an upcoming event'));
assert.ok(cron.includes('Turn off agenda email reminders'));

assert.strictEqual(typeof R.syncEventReminders, 'function');
assert.strictEqual(typeof R.cancelEventReminders, 'function');

console.log('test_agenda_reminders ok');
