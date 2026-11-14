// Feed subscriptions (weblink/webcal calendars) in the encrypted agenda pack:
// the feed url never reaches the server or the sync log in plain text, a legacy
// localStorage copy is migrated once and only cleared after the upload is confirmed,
// and the local agenda backup brings subscriptions back. See docs/AGENDA_SYNC_BUG.md.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const PACK = NotesStore.AGENDA_PACK_UUID;
const SECRET = 'tok-9f2c1e7a55b04d1e';
const URL_A = `https://calendar.example.org/private/${SECRET}/basic.ics`;
const URL_LEGACY = 'https://cal.example.net/feed.ics?key=legacy-secret-4471';
const LEGACY_KEY = 'deeperguard-agenda-subscriptions';
const urls = () => NotesStore.listAgendaSubscriptions().map((s) => s.url).sort();

(async () => {
  await h.unlockFresh();
  await NotesStore.rememberLastSync(1000);
  h.resetServer();
  const pushed = [];
  let rev = 1;
  let accept = true;
  h.server.pushResponder = (items) => items.map((row) => {
    pushed.push(JSON.stringify(row));
    if (!accept) return { item_uuid: row.item_uuid, status: 'error', error: 'offline' };
    rev += 1;
    return { item_uuid: row.item_uuid, status: 'ok', rev };
  });

  // 1. A subscription with a secret token in its url never goes out in plain text.
  NotesStore.addAgendaSubscription({ name: 'Work', url: URL_A });
  h.server.pullPages = [{ items: [], has_more: false, total_undeleted: 0, cursor: 2000 }];
  await NotesStore.sync({ quiet: true });
  h.stopPushTimer();
  assert.ok(pushed.length, 'the agenda pack was pushed');
  for (const body of pushed) {
    assert.ok(!body.includes(SECRET) && !body.includes('calendar.example.org'), 'feed url not in the sync request');
    assert.ok(!body.includes('Work'), 'feed name not in the sync request');
  }
  assert.ok(!JSON.stringify(localStorage.store).includes(SECRET), 'feed url not in localStorage (sync log included)');
  assert.deepStrictEqual(urls(), [URL_A]);

  // 2. Legacy plain localStorage copy: migrated, kept until the upload is confirmed.
  localStorage.setItem(LEGACY_KEY, JSON.stringify([{ id: 'legacy-1', name: 'Club', url: URL_LEGACY, color: '#ff8800' }]));
  accept = false;
  pushed.length = 0;
  h.server.pullPages = [{ items: [], has_more: false, total_undeleted: 1, cursor: 3000 }];
  await NotesStore.sync({ quiet: true });
  h.stopPushTimer();
  assert.deepStrictEqual(urls(), [URL_LEGACY, URL_A].sort(), 'legacy subscription is in the encrypted pack');
  assert.ok(localStorage.getItem(LEGACY_KEY), 'legacy copy kept while the upload is not confirmed');
  for (const body of pushed) assert.ok(!body.includes('legacy-secret-4471'), 'legacy url not sent in plain text');

  accept = true;
  h.server.pullPages = [{ items: [], has_more: false, total_undeleted: 1, cursor: 4000 }];
  await NotesStore.sync({ quiet: true });
  h.stopPushTimer();
  assert.strictEqual(localStorage.getItem(LEGACY_KEY), null, 'legacy copy removed after a confirmed upload');
  assert.deepStrictEqual(urls(), [URL_LEGACY, URL_A].sort(), 'migrated subscription kept');
  const club = NotesStore.listAgendaSubscriptions().find((s) => s.url === URL_LEGACY);
  assert.strictEqual(club.name, 'Club');
  assert.strictEqual(club.color, '#ff8800');
  // Running again does not duplicate.
  await NotesStore.migrateLegacyAgendaSubscriptions();
  assert.strictEqual(NotesStore.listAgendaSubscriptions().length, 2);

  // 3. An empty server set never removes local subscriptions.
  const iso = (ms) => new Date(ms).toISOString();
  const empty = { type: 'agenda_pack', version: 1, created_at: iso(Date.now()), updated_at: iso(Date.now() + 5000), events: {} };
  const row = await h.encryptedRow(PACK, empty, Date.now() / 1000 + 5, 5001, { rev: rev + 5 });
  h.server.pullPages = [{ items: [row], has_more: false, total_undeleted: 1, cursor: 5000 }];
  await NotesStore.sync({ quiet: true });
  h.stopPushTimer();
  assert.deepStrictEqual(urls(), [URL_LEGACY, URL_A].sort(), 'empty server pack removes no subscription');

  // 4. The local encrypted agenda backup restores a removed subscription.
  assert.ok((await NotesStore.listAgendaBackups()).length >= 1, 'a local backup exists');
  const work = NotesStore.listAgendaSubscriptions().find((s) => s.url === URL_A);
  NotesStore.removeAgendaSubscription(work.id);
  h.stopPushTimer();
  assert.deepStrictEqual(urls(), [URL_LEGACY]);
  const res = await NotesStore.restoreAgendaBackup();
  h.stopPushTimer();
  assert.ok(res.ok);
  assert.deepStrictEqual(urls(), [URL_LEGACY, URL_A].sort(), 'restore brings the subscription back');

  console.log('sync agenda subscriptions ok');
  process.exit(0);
})().catch((err) => {
  // Never print a feed url, even on failure.
  console.error(String(err && err.stack || err).split(SECRET).join('<redacted>'));
  process.exit(1);
});
