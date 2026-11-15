// Re-encrypt / re-push paths (docs/FRESHNESS_REENCRYPT.md): every path that
// pushes an existing item again with new ciphertext must carry a newer __fv,
// so a second device holding a hwm for the server copy accepts it without a
// fork (or rollback) warning. Each case drives the real NotesStore path and
// checks the pushed row with a second, independent NotesFreshness instance.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./sync_harness');

const { NotesStore, NotesCrypto } = h;
const AGENDA_PACK_UUID = 'a6da67da-67da-4000-8000-000000000001';
// Vault KDF v2 (case 8) derives with Argon2.
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'js', 'vendor', 'noble-argon2.js'), 'utf8')
    + ';globalThis.NobleArgon2=NobleArgon2;',
);

// A second device: its own freshness state (hwm), same freshness.js code.
function secondDevice() {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '' },
    crypto: globalThis.crypto,
    NotesIDB: { async getMeta() { return null; }, async putMeta() {} },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'js', 'freshness.js'), 'utf8'), ctx);
  return ctx.NotesFreshness;
}

async function contentOf(row, key = NotesStore.state.cryptoKey) {
  return NotesCrypto.decryptObject(key, JSON.parse(row.ciphertext));
}

// Device B accepted `serverRow`; does it take `pushedRow` as a normal newer version?
async function assertDeviceBAccepts(uuid, serverRow, pushedRow, { serverKey, pushedKey } = {}) {
  const B = secondDevice();
  const held = await contentOf(serverRow, serverKey);
  B.noteAccepted(uuid, held, serverRow.content_hash);
  const incoming = await contentOf(pushedRow, pushedKey);
  assert.notStrictEqual(pushedRow.content_hash, serverRow.content_hash, 'new ciphertext');
  assert.ok(incoming.__fv > held.__fv, `__fv ${incoming.__fv} must exceed held ${held.__fv}`);
  const res = B.checkIncoming(uuid, incoming, pushedRow.content_hash);
  assert.strictEqual(res.reject, false, `device B rejected: ${res.warning && res.warning.message}`);
  assert.strictEqual(res.warning, null);
  // Old behaviour (same __fv, new ciphertext) would have been a fork on B.
  const sameVersion = B.checkIncoming(uuid, { ...incoming, __fv: held.__fv }, pushedRow.content_hash);
  assert.strictEqual(sameVersion.reject, true);
  return incoming;
}

const pushedRows = () => h.pushCalls().flatMap((c) => c.body.items);
const lastPushed = (uuid) => pushedRows().filter((r) => r.item_uuid === uuid).pop();
const okResponder = (rev) => (items) => items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev }));

async function pushedNote(title, extra = {}) {
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title, content: title, ...extra });
  h.stopPushTimer();
  h.resetServer();
  h.server.pushResponder = okResponder(1);
  await NotesStore.pushDirty({ quiet: true });
  assert.ok(!NotesStore.state.dirty.has(id));
  return id;
}

// Server copy written by "another device" at the same __fv as our local copy.
async function sameVersionServerRow(uuid, content, rev, updatedAt) {
  return h.encryptedRow(uuid, { ...content, __fv: NotesStore.get(uuid).content.__fv }, updatedAt, updatedAt, { rev });
}

// Pull `rows` through the real sync (push queue first, pull, push again).
async function pullThroughSync(rows, rev) {
  h.resetServer();
  h.server.pushResponder = okResponder(rev);
  h.server.pullPages = [{ items: rows, has_more: false, total_undeleted: 1, cursor: Date.now() }];
  await NotesStore.sync({ quiet: true });
  for (let i = 0; i < 3 && NotesStore.state.dirty.size; i += 1) await NotesStore.pushDirty({ quiet: true });
}

async function conflictThenOk(uuid, serverRow) {
  h.resetServer();
  let calls = 0;
  h.server.pushResponder = (items) => items.map((r) => {
    if (r.item_uuid !== uuid) return { item_uuid: r.item_uuid, status: 'ok', rev: 1 };
    calls += 1;
    return calls === 1
      ? { item_uuid: uuid, status: 'conflict', rev: serverRow.rev, server_item: serverRow }
      : { item_uuid: uuid, status: 'ok', rev: serverRow.rev + 1 };
  });
  for (let i = 0; i < 4 && NotesStore.state.dirty.has(uuid); i += 1) {
    await NotesStore.pushDirty({ quiet: true });
  }
  assert.ok(calls >= 2, 'item pushed again after the conflict');
  assert.ok(!NotesStore.state.dirty.has(uuid));
  return lastPushed(uuid);
}

(async () => {
  await h.unlockFresh();

  // --- 1. push conflict, note: mergeCrossDeviceProtection + winLocal -------
  {
    const id = await pushedNote('ours');
    const local = NotesStore.get(id);
    NotesStore.upsert(id, { ...local.content, content: 'ours edited' });
    h.stopPushTimer();
    const serverRow = await sameVersionServerRow(id, { ...local.content, content: 'theirs', locked: true }, 5, 1);
    const pushed = await conflictThenOk(id, serverRow);
    const incoming = await assertDeviceBAccepts(id, serverRow, pushed);
    assert.strictEqual(incoming.locked, true, 'protection from the server copy kept');
    assert.strictEqual(incoming.content, 'ours edited');
  }

  // --- 2. push conflict, agenda_pack: mergeAgendaPacks + winLocal ----------
  {
    const ev = (id, title) => ({ id, title, start: '2026-11-20T10:00', end: '2026-11-20T11:00', updated_at: new Date().toISOString() });
    NotesStore.upsert(AGENDA_PACK_UUID, { type: 'agenda_pack', version: 1, events: { a: ev('a', 'ours') } });
    h.stopPushTimer();
    const local = NotesStore.get(AGENDA_PACK_UUID);
    const serverRow = await sameVersionServerRow(
      AGENDA_PACK_UUID,
      { type: 'agenda_pack', version: 1, events: { b: ev('b', 'theirs') } },
      7,
      1,
    );
    const pushed = await conflictThenOk(AGENDA_PACK_UUID, serverRow);
    const incoming = await assertDeviceBAccepts(AGENDA_PACK_UUID, serverRow, pushed);
    assert.ok(incoming.events.a && incoming.events.b, 'both event sets merged');
    assert.ok(local);
  }

  // --- 3. push conflict, clock win (no merge) ------------------------------
  {
    const id = await pushedNote('clock');
    const local = NotesStore.get(id);
    NotesStore.upsert(id, { ...local.content, content: 'newer here' });
    h.stopPushTimer();
    const serverRow = await sameVersionServerRow(id, { ...local.content, content: 'older there' }, 9, 1);
    const pushed = await conflictThenOk(id, serverRow);
    const incoming = await assertDeviceBAccepts(id, serverRow, pushed);
    assert.strictEqual(incoming.content, 'newer here');
  }

  // --- 4. pull, local wins, protection merged and pushed again -------------
  {
    const id = await pushedNote('pull-protect');
    const local = NotesStore.get(id);
    NotesStore.upsert(id, { ...local.content, content: 'local newer' });
    h.stopPushTimer();
    const serverRow = await sameVersionServerRow(
      id,
      { ...local.content, content: 'remote older', prevent_edit: true },
      undefined,
      1,
    );
    delete serverRow.rev;
    NotesStore.get(id).rev = undefined;
    await pullThroughSync([serverRow], undefined);
    assert.ok(!NotesStore.state.dirty.has(id));
    const incoming = await assertDeviceBAccepts(id, serverRow, lastPushed(id));
    assert.strictEqual(incoming.prevent_edit, true);
    assert.strictEqual(incoming.content, 'local newer');
  }

  // --- 5. pull, agenda pack merged and pushed again ------------------------
  {
    const ev = (id) => ({ id, title: id, start: '2026-11-21T10:00', end: '2026-11-21T11:00', updated_at: new Date().toISOString() });
    const pack = NotesStore.get(AGENDA_PACK_UUID).content;
    // Local event not on the server yet (local bookkeeping, not queued).
    NotesStore.upsert(AGENDA_PACK_UUID, { ...pack, events: { ...pack.events, c: ev('c') } }, { skipDirty: true });
    h.stopPushTimer();
    // Another device publishes a newer pack (next __fv) without event c.
    const serverRow = await h.encryptedRow(
      AGENDA_PACK_UUID,
      { type: 'agenda_pack', version: 1, events: { ...pack.events, d: ev('d') } },
      Date.now() / 1000 + 60,
      Date.now() / 1000 + 60,
    );
    delete serverRow.rev;
    await pullThroughSync([serverRow], 3);
    assert.ok(!NotesStore.state.dirty.has(AGENDA_PACK_UUID));
    const incoming = await assertDeviceBAccepts(AGENDA_PACK_UUID, serverRow, lastPushed(AGENDA_PACK_UUID));
    assert.ok(incoming.events.c && incoming.events.d);
    // This device's own echo of the push is no fork either.
    const echo = lastPushed(AGENDA_PACK_UUID);
    const own = NotesStore.NotesFreshness || h.NotesFreshness;
    assert.strictEqual(own.checkIncoming(AGENDA_PACK_UUID, incoming, echo.content_hash).reject, false);
  }

  // --- 6. migratePlainAttachments (via unlock maintenance) -----------------
  {
    const id = NotesStore.newUuid();
    const serverRow = await h.encryptedRow(id, {
      type: 'attachment', note_id: '', filename: 'a.txt', mime: 'text/plain', data_b64: 'aGVsbG8=',
    }, 1, 1);
    // Legacy vault item as loaded on this device: plain bytes, synced at the
    // server copy's __fv (device B holds the same copy).
    await NotesIDB.putItem({
      uuid: id,
      ciphertext: serverRow.ciphertext,
      content_hash: serverRow.content_hash,
      updated_at: 1,
      deleted: false,
      has_blob: false,
      rev: 1,
    });
    h.resetServer();
    // Opening the local vault runs migratePlainAttachments (unlock maintenance).
    await NotesStore.loadLocal();
    await NotesStore.finishUnlockMaintenance();
    assert.ok(NotesStore.state.dirty.has(id), 'sealed copy queued');
    h.stopPushTimer();
    h.server.pushResponder = okResponder(2);
    await NotesStore.pushDirty({ quiet: true });
    const incoming = await assertDeviceBAccepts(id, serverRow, lastPushed(id));
    assert.ok(!incoming.data_b64);
  }

  // --- 7. importBackup: restored copy pushed over a newer local item -------
  {
    const id = await pushedNote('backup v1');
    const backupRow = await h.encryptedRow(id, { ...NotesStore.get(id).content, content: 'from backup' }, 1, 1);
    NotesStore.upsert(id, { ...NotesStore.get(id).content, content: 'edited after backup' });
    h.stopPushTimer();
    h.resetServer();
    h.server.pushResponder = okResponder(2);
    await NotesStore.pushDirty({ quiet: true });
    const serverRow = lastPushed(id); // what device B holds now
    NotesStore.get(id).updated_at = 0; // backup copy is the newer one
    h.resetServer();
    h.server.pushResponder = okResponder(3);
    await NotesStore.importBackup({ items: [{ ...backupRow, updated_at: Date.now() / 1000 + 60 }] }, true);
    await NotesStore.pushDirty({ quiet: true });
    assert.ok(!NotesStore.state.dirty.has(id) && lastPushed(id), 'restored copy pushed');
    const incoming = await assertDeviceBAccepts(id, serverRow, lastPushed(id));
    assert.strictEqual(incoming.content, 'from backup');
  }

  // --- 8. vault KDF upgrade re-encrypts every item -------------------------
  {
    const id = await pushedNote('kdf');
    const oldKey = NotesStore.state.cryptoKey;
    const serverRow = lastPushed(id);
    h.resetServer();
    h.server.pushResponder = okResponder(4);
    h.server.route = (url) => (url.includes('/api/account/vault-kdf') ? { ok: true } : undefined);
    NotesStore.state.kdfVersion = 1;
    const res = await NotesStore.migrateVaultKdfIfNeeded(h.PASSWORD, h.SALT);
    assert.strictEqual(res.migrated, true);
    await assertDeviceBAccepts(id, serverRow, lastPushed(id), { serverKey: oldKey });
  }

  // --- 9. password change rolled back after rows went out under the new key -
  {
    const id = await pushedNote('rollback');
    const other = await pushedNote('refused');
    const oldKey = NotesStore.state.cryptoKey;
    let newKey = null;
    h.resetServer();
    h.server.route = (url) => {
      if (url.includes('/api/account/password/prove')) return { rotation_token: 'rot-1' };
      if (url.includes('/api/account')) return { kdf_salt: h.SALT };
      return undefined;
    };
    // `id` goes out under the new key; `other` is refused, so the change is
    // rolled back and `id` must be overwritten with its old-key copy.
    h.server.pushResponder = (items) => {
      if (!newKey) newKey = NotesStore.state.cryptoKey;
      return items.map((r) => ({ item_uuid: r.item_uuid, status: r.item_uuid === other ? 'rejected' : 'ok', rev: 6 }));
    };
    await assert.rejects(NotesStore.changePassword(h.PASSWORD, 'other-password'), (e) => e.code === 'REKEY_UPLOAD_FAILED');
    const newKeyRow = pushedRows().filter((r) => r.item_uuid === id)[0];
    assert.ok(newKeyRow && newKey && newKey !== oldKey, 'rows went out under the new key');
    h.server.pushResponder = okResponder(7);
    await NotesStore.pushDirty({ quiet: true });
    const restoredRow = lastPushed(id);
    assert.notStrictEqual(restoredRow, newKeyRow, 'old-key copy pushed again');
    const incoming = await assertDeviceBAccepts(id, newKeyRow, restoredRow, {
      serverKey: newKey,
      pushedKey: NotesStore.state.cryptoKey,
    });
    assert.strictEqual(incoming.content, 'rollback');
  }

  // --- real fork (same __fv, other content) is still reported --------------
  {
    const B = secondDevice();
    B.noteAccepted('fork-x', { type: 'note', __fv: 4, __fid: 'fork-x' }, 'hash-1');
    const fork = B.checkIncoming('fork-x', { type: 'note', __fv: 4, __fid: 'fork-x', title: 'other' }, 'hash-2');
    assert.strictEqual(fork.reject, true);
    assert.strictEqual(fork.warning.type, B.WARN_TYPES.fork);
  }

  console.log('test_freshness_reencrypt_paths.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
