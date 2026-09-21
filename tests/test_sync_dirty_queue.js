// Cross-device sync regressions:
//  - unsynced edits/deletes survive vault lock (persisted dirty queue + tombstones)
//  - pull pages on the server's synced_at cursor and stores the server cursor
//  - a lock during a pull never resets the cursor (no surprise full re-download)
//  - "stale" push results clear the local queue
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();
const meta = new Map();
const fetchCalls = [];
let pullPages = [];
let pushResponder = null;

global.addEventListener = () => {};
global.window = global;
const storage = () => ({
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
});
global.localStorage = storage();
global.sessionStorage = storage();
global.NotesIDB = {
  async putItem(row) {
    idb.set(row.uuid, JSON.parse(JSON.stringify(row)));
  },
  async deleteItem(uuid) {
    idb.delete(uuid);
  },
  async loadItems() {
    return [...idb.values()];
  },
  async getItem(uuid) {
    return idb.get(uuid) || null;
  },
  async getMeta(key) {
    return meta.has(key) ? meta.get(key) : null;
  },
  async putMeta(key, value) {
    meta.set(key, JSON.parse(JSON.stringify(value)));
  },
};
global.fetch = async (url, options = {}) => {
  const pathUrl = String(url || '');
  let body = null;
  if (options.body) {
    try {
      body = JSON.parse(options.body);
    } catch (err) {
      body = options.body;
    }
  }
  const call = { url: pathUrl, method: options.method || 'GET', body };
  fetchCalls.push(call);
  if (pathUrl.includes('/api/sync/pull')) {
    const page = pullPages.length ? pullPages.shift() : { items: [], has_more: false };
    if (typeof page === 'function') return { ok: true, json: async () => page(body) };
    return { ok: true, json: async () => ({ server_time: Date.now() / 1000, ...page }) };
  }
  if (pathUrl.includes('/api/sync/items')) {
    const items = body?.items || [];
    const results = pushResponder
      ? pushResponder(items)
      : items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
    return {
      ok: true,
      json: async () => ({
        ok: true,
        results,
        accepted: results.filter((r) => r.status === 'ok').length,
        unchanged: results.filter((r) => r.status === 'unchanged').length,
        stale: results.filter((r) => r.status === 'stale').length,
        server_time: Date.now() / 1000,
      }),
    };
  }
  if (pathUrl.includes('/api/sync/watermark')) {
    return { ok: true, json: async () => ({ watermark: 1, synced_watermark: 5000, item_count: 1 }) };
  }
  return { ok: true, json: async () => ({}) };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

const SALT = '74b797214bcbc094863155104fb361bb';
const PASSWORD = 'vault-password';

async function tick(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor(predicate, label, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function stopPushTimer() {
  clearTimeout(NotesStore.state.saveTimer);
  NotesStore.state.saveTimer = null;
}

async function unlockFresh() {
  await NotesStore.unlock(PASSWORD, SALT, { kdfVersion: 1 });
  NotesStore.state.localReady = true;
}

async function encryptedRow(uuid, content, updatedAt, syncedAt) {
  const payload = await NotesCrypto.encryptObject(NotesStore.state.cryptoKey, content);
  const ciphertext = JSON.stringify(payload);
  return {
    item_uuid: uuid,
    content_version: 1,
    ciphertext,
    blob_ciphertext: '',
    content_hash: await NotesCrypto.hashText(ciphertext),
    deleted: false,
    updated_at: updatedAt,
    synced_at: syncedAt,
  };
}

(async () => {
  // --- 1. Dirty queue persists across lock and is pushed after unlock -------
  await unlockFresh();
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Offline edit' });
  stopPushTimer();
  await waitFor(() => idb.get(noteId)?.ciphertext, 'note persisted');
  await waitFor(() => Array.isArray(meta.get('dirty')) && meta.get('dirty').includes(noteId), 'dirty persisted');

  const delId = NotesStore.newUuid();
  NotesStore.upsert(delId, { ...NotesStore.defaultNote(), title: 'Delete me' });
  stopPushTimer();
  await waitFor(() => idb.get(delId)?.ciphertext, 'second note persisted');
  assert.ok(NotesStore.remove(delId), 'remove returns true');
  stopPushTimer();
  await waitFor(() => idb.get(delId) && idb.get(delId).deleted === true && !idb.get(delId).ciphertext, 'tombstone written');

  // Lock with the push still pending (e.g. iOS auto-lock while offline).
  NotesStore.lock();
  assert.strictEqual(NotesStore.state.dirty.size, 0, 'memory queue cleared on lock');
  await waitFor(() => Array.isArray(meta.get('dirty')) && meta.get('dirty').length === 2, 'queue persisted at lock');
  assert.deepStrictEqual(
    [...meta.get('dirty')].sort(),
    [noteId, delId].sort(),
    'persisted queue must survive lock()',
  );

  fetchCalls.length = 0;
  await NotesStore.pushDirtyPersisted({ quiet: true });
  const lockedPush = fetchCalls.find((c) => c.url.includes('/api/sync/items') && c.method === 'POST');
  assert.ok(lockedPush, 'encrypted queue can push while vault is locked');
  assert.ok(lockedPush.body.items.some((row) => row.item_uuid === noteId), 'edit pushes from IndexedDB ciphertext');
  assert.strictEqual(
    lockedPush.body.items.some((row) => row.item_uuid === delId),
    false,
    'tombstone without stored ciphertext waits for unlock',
  );
  await waitFor(
    () => Array.isArray(meta.get('dirty')) && meta.get('dirty').length === 1 && meta.get('dirty')[0] === delId,
    'delete tombstone stays queued until unlock',
  );

  await unlockFresh();
  NotesStore.state.localReady = false;
  const opened = await NotesStore.loadLocal();
  assert.ok(opened.opened >= 1, 'note decrypts after unlock');
  assert.ok(!NotesStore.state.dirty.has(noteId), 'edit was already pushed while vault was locked');
  assert.ok(NotesStore.state.dirty.has(delId), 'delete restored to dirty queue');
  assert.strictEqual(NotesStore.get(delId)?.deleted, true, 'tombstone restored');
  assert.strictEqual(NotesStore.listNotes().some((n) => n.uuid === delId), false, 'tombstone hidden from lists');

  fetchCalls.length = 0;
  await NotesStore.pushDirty({ quiet: true });
  const push = fetchCalls.find((c) => c.url.includes('/api/sync/items') && c.method === 'POST');
  assert.ok(push, 'restored queue is pushed');
  assert.strictEqual(push.body.items.length, 1, 'only the pending tombstone is pushed after unlock');
  const deletedRow = push.body.items.find((row) => row.item_uuid === delId);
  assert.ok(deletedRow, 'tombstone delete is pushed after unlock');
  assert.strictEqual(deletedRow.deleted, true, 'tombstone pushes as a delete');
  assert.ok(deletedRow.ciphertext, 'delete still carries ciphertext for the server');
  assert.strictEqual(NotesStore.state.dirty.size, 0, 'queue drained after push');
  await tick();
  assert.strictEqual(idb.has(delId), false, 'tombstone row removed after successful push');
  await waitFor(() => Array.isArray(meta.get('dirty')) && meta.get('dirty').length === 0, 'persisted queue drained');

  // --- 2. Stale result (server has a newer copy) clears the queue ----------
  NotesStore.upsert(noteId, { ...NotesStore.get(noteId).content, title: 'Old edit' });
  stopPushTimer();
  pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'stale' }));
  await NotesStore.pushDirty({ quiet: true });
  pushResponder = null;
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false, 'stale write is dropped, not retried forever');

  // --- 3. Pull uses the synced_at cursor and keeps the server cursor --------
  await NotesStore.rememberLastSync(1000);
  const rowA = await encryptedRow(NotesStore.newUuid(), { ...NotesStore.defaultNote(), title: 'A' }, 50, 1001.5);
  const rowB = await encryptedRow(NotesStore.newUuid(), { ...NotesStore.defaultNote(), title: 'B' }, 40, 1002.5);
  const rowC = await encryptedRow(NotesStore.newUuid(), { ...NotesStore.defaultNote(), title: 'C' }, 30, 1003.5);
  pullPages = [
    { items: [rowA, rowB], has_more: true, total_undeleted: 3, cursor: 1002.5 },
    { items: [rowC], has_more: false, total_undeleted: 3, cursor: 1990 },
  ];
  fetchCalls.length = 0;
  await NotesStore.sync({ quiet: true });
  const pulls = fetchCalls.filter((c) => c.url.includes('/api/sync/pull'));
  assert.strictEqual(pulls.length, 2, 'two pages requested');
  assert.strictEqual(pulls[0].body.cursor, 'synced_at', 'client asks for the server-time cursor');
  assert.strictEqual(pulls[0].body.since, 1000);
  assert.strictEqual(pulls[1].body.since, 1002.5, 'second page continues from last synced_at, not updated_at');
  assert.strictEqual(pulls[1].body.after, rowB.item_uuid);
  assert.strictEqual(NotesStore.state.lastSync, 1990, 'cursor comes from the server response');
  assert.ok(NotesStore.get(rowC.item_uuid), 'late row with old updated_at was applied');
  assert.ok(NotesStore.state.lastSyncAt > 0, 'local completion clock recorded');

  // --- 4. Lock mid-pull aborts without touching the cursor -----------------
  const before = NotesStore.state.lastSync;
  const rowD = await encryptedRow(NotesStore.newUuid(), { ...NotesStore.defaultNote(), title: 'D' }, 20, 2001);
  pullPages = [
    (body) => {
      NotesStore.lock();
      return { items: [rowD], has_more: false, total_undeleted: 6, cursor: 2500, server_time: 2600 };
    },
  ];
  let aborted = null;
  try {
    await NotesStore.sync({ quiet: true });
  } catch (err) {
    aborted = err;
  }
  assert.strictEqual(aborted?.code, 'VAULT_LOCKED', 'sync reports the lock, not a decrypt failure');
  assert.strictEqual(Number(localStorage.getItem('notes_last_sync')), before, 'cursor untouched by a lock mid-pull');
  assert.strictEqual(NotesStore.state.items.size, 0, 'nothing leaks past lock');

  // --- 5. Change poll compares against the synced cursor ------------------
  await unlockFresh();
  await NotesStore.rememberLastSync(6000);
  assert.strictEqual(await NotesStore.hasRemoteChanges(), false, 'no changes when server watermark is behind');
  await NotesStore.rememberLastSync(4000);
  assert.strictEqual(await NotesStore.hasRemoteChanges(), true, 'newer server watermark triggers a sync');

  console.log('test_sync_dirty_queue.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
