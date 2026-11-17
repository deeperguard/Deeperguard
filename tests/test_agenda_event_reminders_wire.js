// Event reminders leave the device only inside the encrypted agenda pack.
const assert = require('assert');
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
  const start = Date.parse('2026-12-01T09:00:00Z');
  NotesStore.upsertAgendaEvent('ev-rem', {
    title: 'Call', start: new Date(start).toISOString(), end: new Date(start + 3600000).toISOString(),
    all_day: false, reminders: [5, 1234],
  });
  h.stopPushTimer();
  assert.strictEqual(await NotesStore.pushDirty({ quiet: true }), true);
  const wire = bodies.join('\n');
  for (const secret of ['reminders', '1234', '2026-12-01', '08:55']) {
    assert.ok(!wire.includes(secret), `server request must not contain ${secret}`);
  }
  const sent = JSON.parse(bodies[bodies.length - 1]).items.find((r) => r.item_uuid === NotesStore.AGENDA_PACK_UUID);
  const pack = await h.decryptRow(sent);
  assert.deepStrictEqual(pack.events['ev-rem'].reminders, [5, 1234], 'reminders are inside the ciphertext');
  console.log('agenda event reminders wire ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
