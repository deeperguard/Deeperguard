// Per-event IANA timezone (docs/design/calendar-multi.md): DST changes in Europe and the US,
// an event across a date line, an old event without tz, and tz only leaving the device encrypted.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'app/static/js/agenda-tz.js'), 'utf8'));
const Tz = global.NotesAgendaTz;
const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';
const at = (s, tz) => Tz.fromLocalInput(s, tz);
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600000;

// --- DST: the same wall-clock time keeps its local time across the change -------------
// Europe/Amsterdam: summer -> winter on 2026-10-25, winter -> summer on 2026-03-29.
assert.strictEqual(iso(at('2026-10-24T09:00', AMS)), '2026-10-24T07:00:00.000Z');
assert.strictEqual(iso(at('2026-10-26T09:00', AMS)), '2026-10-26T08:00:00.000Z');
assert.strictEqual((at('2026-10-26T09:00', AMS) - at('2026-10-24T09:00', AMS)) / HOUR, 49, 'AMS fall back: 49 h');
assert.strictEqual((at('2026-03-30T09:00', AMS) - at('2026-03-28T09:00', AMS)) / HOUR, 47, 'AMS spring forward: 47 h');
// America/New_York: summer -> winter on 2026-11-01, winter -> summer on 2026-03-08.
assert.strictEqual(iso(at('2026-10-31T09:00', NYC)), '2026-10-31T13:00:00.000Z');
assert.strictEqual(iso(at('2026-11-02T09:00', NYC)), '2026-11-02T14:00:00.000Z');
assert.strictEqual((at('2026-11-02T09:00', NYC) - at('2026-10-31T09:00', NYC)) / HOUR, 49, 'NYC fall back: 49 h');
assert.strictEqual((at('2026-03-09T09:00', NYC) - at('2026-03-07T09:00', NYC)) / HOUR, 47, 'NYC spring forward: 47 h');
// Round trip wall -> instant -> wall on both sides of each change.
const zones = [
  [AMS, ['2026-10-24', '2026-10-26', '2026-03-28', '2026-03-30']],
  [NYC, ['2026-10-31', '2026-11-02', '2026-03-07', '2026-03-09']],
];
for (const [tz, days] of zones) {
  for (const d of days) {
    for (const t of ['00:30', '09:00', '12:00', '23:30']) {
      assert.strictEqual(Tz.toLocalInput(at(`${d}T${t}`, tz), tz), `${d}T${t}`, `${tz} ${d} ${t}`);
    }
  }
}
// Overlap picks the first pass, gap moves forward.
assert.strictEqual(iso(at('2026-10-25T02:30', AMS)), '2026-10-25T00:30:00.000Z');
assert.strictEqual(iso(at('2026-03-29T02:30', AMS)), '2026-03-29T01:30:00.000Z');
assert.strictEqual(Tz.toLocalInput(at('2026-03-29T02:30', AMS), AMS), '2026-03-29T03:30');

// --- date boundary: 23:30 in New York is already the next day in Amsterdam -----------
const late = at('2026-11-01T23:30', NYC); // EST, after the change
assert.strictEqual(iso(late), '2026-11-02T04:30:00.000Z');
assert.strictEqual(Tz.toLocalInput(late, AMS), '2026-11-02T05:30');
assert.strictEqual(Tz.toLocalInput(late, NYC), '2026-11-01T23:30');
assert.strictEqual(Tz.toLocalInput(at('2026-12-31T23:30', 'UTC'), 'Asia/Tokyo'), '2027-01-01T08:30');

// --- display: local time plus original time ------------------------------------------
const meeting = at('2026-11-20T09:00', NYC);
assert.strictEqual(Tz.toLocalInput(meeting, AMS), '2026-11-20T15:00');
assert.strictEqual(Tz.originalTimeLabel(meeting, NYC, AMS), '09:00 New York');
assert.strictEqual(Tz.originalTimeLabel(meeting, AMS, AMS), '', 'same zone: nothing extra');

// --- old event without tz: nothing changes -------------------------------------------
const oldStart = Date.parse('2026-11-20T09:00:00Z');
assert.strictEqual(Tz.originalTimeLabel(oldStart, undefined, AMS), '');
assert.strictEqual(Tz.originalTimeLabel(oldStart, '', AMS), '');
assert.strictEqual(Tz.originalTimeLabel(oldStart, 'Not/AZone', AMS), '');
assert.strictEqual(Tz.effectiveTz(undefined), Tz.deviceTz());
assert.ok(!Tz.isValidTz('Not/AZone'));

// --- zone list and fallback -----------------------------------------------------------
assert.ok(Tz.listZones().includes(AMS) && Tz.listZones().includes(NYC));
const orig = Intl.supportedValuesOf;
Intl.supportedValuesOf = undefined;
assert.ok(Tz.listZones().includes(AMS), 'fallback list without Intl.supportedValuesOf');
Intl.supportedValuesOf = orig;

// --- tz leaves the device only inside the encrypted pack -----------------------------
const h = require('./sync_harness');

const { NotesStore } = h;
(async () => {
  await h.unlockFresh();
  h.resetServer();
  const bodies = [];
  h.server.pushResponder = (items, body) => {
    bodies.push(JSON.stringify(body));
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 6 }));
  };
  NotesStore.upsertAgendaEvent('ev-tz', {
    title: 'Call', start: iso(meeting), end: iso(meeting + HOUR), all_day: false, tz: NYC,
  });
  h.stopPushTimer();
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  assert.ok(bodies.length >= 1);
  const wire = bodies.join('\n');
  for (const secret of ['America/New_York', 'New_York', '"tz"']) {
    assert.ok(!wire.includes(secret), `server request must not contain ${secret}`);
  }
  const sent = JSON.parse(bodies[bodies.length - 1]).items.find((r) => r.item_uuid === NotesStore.AGENDA_PACK_UUID);
  const pack = await h.decryptRow(sent);
  assert.strictEqual(pack.events['ev-tz'].tz, NYC, 'tz is inside the ciphertext');
  console.log('agenda tz ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
