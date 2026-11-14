// Two devices, one account: does the agenda (events + feed subscriptions) survive sync?
// See docs/AGENDA_SYNC_BUG.md. Every device step runs in its own Node process with its
// own IndexedDB/meta/localStorage (persisted to a temp dir), the real store.js, and a
// fake server that follows the push rules of app/db.py (_plan_sync_item: rev,
// base_rev -> conflict, no base_rev -> last-writer-wins by updated_at -> stale).
//
//   node tests/test_sync_agenda_two_devices.js            report; exit 0 while the
//                                                          known bug reproduces, exit 1
//                                                          on "UNEXPECTED PASS" or a crash
//   AGENDA_SYNC_STRICT=1 node tests/...two_devices.js     exit 1 on any data loss
//                                                          (expected failure on main)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FEED_URL = 'https://calendar.example.org/team.ics';

/* ------------------------------------------------------------------ fake server */

function loadServer(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { rows: {}, clock: 1000 };
}

function serverRoute(srv, h) {
  const tick = () => {
    srv.clock = Math.max(srv.clock + 1, Math.floor(Date.now() / 1000) + 0.5);
    return srv.clock;
  };
  const publicRow = (row) => ({ ...row });
  return async (url, body) => {
    if (url.includes('/api/sync/pull')) {
      const since = Number(body?.since) || 0;
      const items = Object.values(srv.rows)
        .filter((r) => r.synced_at > since)
        .sort((a, b) => a.synced_at - b.synced_at)
        .map(publicRow);
      const cursor = items.length ? items[items.length - 1].synced_at : since;
      return {
        items,
        has_more: false,
        cursor,
        total_undeleted: Object.values(srv.rows).filter((r) => !r.deleted).length,
        server_time: Date.now() / 1000,
      };
    }
    if (url.includes('/api/sync/refetch')) {
      const ids = body?.uuids || [];
      return { items: ids.map((id) => srv.rows[id]).filter(Boolean).map(publicRow), server_time: Date.now() / 1000 };
    }
    if (url.includes('/api/sync/items')) {
      const results = (body?.items || []).map((item) => {
        const uuid = item.item_uuid;
        const existing = srv.rows[uuid];
        const existingRev = existing ? existing.rev : 0;
        let updatedAt = Number(item.updated_at) || Date.now() / 1000;
        const sameHash = !!(existing && item.content_hash && existing.content_hash === item.content_hash);
        if (sameHash && updatedAt <= existing.updated_at) return { item_uuid: uuid, status: 'unchanged', rev: existingRev };
        const baseRev = item.base_rev == null ? null : Number(item.base_rev);
        if (existing && baseRev != null) {
          if (baseRev !== existingRev) {
            if (sameHash) return { item_uuid: uuid, status: 'unchanged', rev: existingRev };
            return { item_uuid: uuid, status: 'conflict', rev: existingRev, server_item: publicRow(existing) };
          }
          updatedAt = Math.max(updatedAt, existing.updated_at);
        } else if (existing && updatedAt < existing.updated_at) {
          return { item_uuid: uuid, status: 'stale', rev: existingRev };
        }
        const rev = existingRev + 1;
        srv.rows[uuid] = {
          item_uuid: uuid,
          ciphertext: item.ciphertext,
          blob_ciphertext: item.blob_ciphertext || '',
          content_version: item.content_version || 1,
          content_hash: item.content_hash || '',
          deleted: !!item.deleted,
          updated_at: updatedAt,
          synced_at: tick(),
          rev,
        };
        srv.pushLog = srv.pushLog || [];
        srv.pushLog.push({ uuid, rev, base_rev: baseRev, device: process.env.AGENDA_DEVICE });
        return { item_uuid: uuid, status: 'ok', rev, updated_at: updatedAt };
      });
      return { ok: true, results, server_time: Date.now() / 1000 };
    }
    if (url.includes('/api/sync/watermark')) {
      return { watermark: srv.clock, synced_watermark: srv.clock, item_count: Object.keys(srv.rows).length };
    }
    return undefined;
  };
}

/* ------------------------------------------------------------------ device step */

async function runDevice(stateFile, serverFile, action) {
  const h = require('./sync_harness');
  const { NotesStore } = h;
  const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  if (saved) {
    for (const [k, v] of saved.idb) h.idb.set(k, v);
    for (const [k, v] of saved.meta) h.meta.set(k, v);
    Object.assign(localStorage.store, saved.localStorage);
  }
  const srv = loadServer(serverFile);
  h.server.route = serverRoute(srv, h);

  // Same order as an app start on an already signed-in device: unlock, load the local
  // cache, unlock maintenance (store.js runUnlockMaintenance), then sync.
  await h.unlockFresh();
  await NotesStore.loadLocal();
  await NotesStore.finishUnlockMaintenance();

  if (action === 'create') {
    NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
      title: 'Dentist', start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T10:00:00.000Z', all_day: false,
    });
    NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
      title: 'Team lunch', start: '2026-11-21T11:00:00.000Z', end: '2026-11-21T12:00:00.000Z', all_day: false,
    });
    NotesStore.addAgendaSubscription({ name: 'Team', url: FEED_URL });
  }
  if (action === 'create-offline-b') {
    // B adds its own appointments before its first sync has reached the server.
    for (const title of ['B: gym', 'B: dinner', 'B: school', 'B: train']) {
      NotesStore.upsertAgendaEvent(NotesStore.newUuid(), {
        title, start: '2026-11-22T18:00:00.000Z', end: '2026-11-22T19:00:00.000Z', all_day: false,
      });
    }
  }
  await NotesStore.sync({ quiet: true });
  await h.tick(10);
  if (NotesStore.state.dirty.size) await NotesStore.pushDirty({ quiet: true });
  h.stopPushTimer();
  await h.tick(10);

  const out = {
    events: NotesStore.listAgendaEvents().map((e) => e.title).sort(),
    feeds: NotesStore.listAgendaSubscriptions().map((s) => s.url).sort(),
    dirty: NotesStore.state.dirty.size,
  };
  fs.writeFileSync(serverFile, JSON.stringify(srv));
  fs.writeFileSync(stateFile, JSON.stringify({
    idb: [...h.idb.entries()],
    meta: [...h.meta.entries()],
    localStorage: localStorage.store,
  }));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ scenarios */

function step(dir, device, action) {
  const outText = execFileSync(process.execPath, [
    __filename, '--device', path.join(dir, `${device}.json`), path.join(dir, 'server.json'), action,
  ], { encoding: 'utf8', env: { ...process.env, AGENDA_DEVICE: device }, timeout: 60000 });
  const lines = outText.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const WANT_FEEDS = [FEED_URL];

function check(label, got, failures, WANT_EVENTS) {
  const okEvents = JSON.stringify(got.events) === JSON.stringify(WANT_EVENTS);
  const okFeeds = JSON.stringify(got.feeds) === JSON.stringify(WANT_FEEDS);
  console.log(`  ${label}: events=${JSON.stringify(got.events)} feeds=${JSON.stringify(got.feeds)} dirty=${got.dirty}`
    + `${okEvents && okFeeds ? '' : '  <-- DATA LOSS'}`);
  if (!okEvents) failures.push(`${label}: events ${JSON.stringify(got.events)} != ${JSON.stringify(WANT_EVENTS)}`);
  if (!okFeeds) failures.push(`${label}: feeds ${JSON.stringify(got.feeds)} != ${JSON.stringify(WANT_FEEDS)}`);
}

function scenario(name, wantEvents, steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-two-devices-'));
  const failures = [];
  console.log(`scenario ${name}`);
  try {
    for (const [device, action, label] of steps) {
      const got = step(dir, device, action);
      if (label) check(label, got, failures, wantEvents);
    }
    const srv = loadServer(path.join(dir, 'server.json'));
    console.log(`  server pushes: ${JSON.stringify(srv.pushLog || [])}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failures;
}

async function main() {
  const failures = [];
  // 1. A creates + syncs; B (fresh) syncs and must see it; A syncs again and keeps it.
  // C is a third, fresh device (or A after clearing site data): it shows the server copy.
  const AB = ['Dentist', 'Team lunch'];
  failures.push(...scenario('A-creates-then-B-syncs', AB, [
    ['A', 'create', 'A after create+sync'],
    ['B', 'sync', 'B after first sync'],
    ['A', 'sync', 'A after re-sync'],
    ['B', 'sync', 'B after re-sync'],
    ['C', 'sync', 'C (fresh) after sync'],
  ]));
  // 2. B syncs first while the account is still empty; then A creates; both re-sync.
  failures.push(...scenario('B-first-empty-then-A', AB, [
    ['B', 'sync', null],
    ['A', 'create', 'A after create+sync'],
    ['B', 'sync', 'B after sync'],
    ['A', 'sync', 'A after re-sync'],
    ['C', 'sync', 'C (fresh) after sync'],
  ]));
  // 3. As 1, but B adds its own events before its first sync: everyone must see the union.
  const UNION = ['B: dinner', 'B: gym', 'B: school', 'B: train', 'Dentist', 'Team lunch'];
  failures.push(...scenario('A-creates-B-adds-offline-then-syncs', UNION, [
    ['A', 'create', null],
    ['B', 'create-offline-b', 'B after first sync'],
    ['A', 'sync', 'A after re-sync'],
    ['C', 'sync', 'C (fresh) after sync'],
  ]));

  const strict = process.env.AGENDA_SYNC_STRICT === '1';
  if (!failures.length) {
    console.log('agenda two devices: no data loss');
    if (strict) {
      console.log('agenda two devices ok');
      process.exit(0);
    }
    // The known bug no longer reproduces: drop the expected-failure marker in
    // tests/test_round60_client_integrity.py and update docs/AGENDA_SYNC_BUG.md.
    console.error('UNEXPECTED PASS: agenda data loss no longer reproduces (docs/AGENDA_SYNC_BUG.md)');
    process.exit(1);
  }
  console.log(`agenda two devices: ${failures.length} data-loss findings`);
  failures.forEach((f) => console.log(`  - ${f}`));
  if (strict) {
    assert.fail(`agenda data lost across devices (docs/AGENDA_SYNC_BUG.md):\n${failures.join('\n')}`);
  }
  console.log('agenda two devices: KNOWN BUG reproduced (docs/AGENDA_SYNC_BUG.md)');
  process.exit(0);
}

if (process.argv[2] === '--device') {
  runDevice(process.argv[3], process.argv[4], process.argv[5]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
