// Locked vault: watermark-gated pull + known_hashes from IDB (no full ciphertext re-fetch).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const idb = new Map();
const meta = new Map();
const fetchCalls = [];

let syncedWatermark = 5000;
let pullResponse = { items: [], has_more: false };

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
  fetchCalls.push({ url: pathUrl, method: options.method || 'GET', body });
  if (pathUrl.includes('/api/sync/watermark')) {
    return { ok: true, json: async () => ({ synced_watermark: syncedWatermark }) };
  }
  if (pathUrl.includes('/api/sync/pull')) {
    return { ok: true, json: async () => pullResponse };
  }
  return { ok: true, json: async () => ({}) };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

(async () => {
  await NotesIDB.putItem({
    uuid: 'note-a',
    ciphertext: 'cipher-a',
    content_hash: 'hash-a',
    updated_at: 1000,
    deleted: false,
  });
  await NotesIDB.putItem({
    uuid: 'note-b',
    ciphertext: 'cipher-b',
    content_hash: 'hash-b',
    updated_at: 1001,
    deleted: false,
  });
  await NotesStore.rememberLastSync(6000);
  syncedWatermark = 5000;

  NotesStore.lock();
  assert.strictEqual(NotesStore.isUnlocked(), false);

  fetchCalls.length = 0;
  await NotesStore.syncWhileLocked({ quiet: true });
  assert.strictEqual(
    fetchCalls.filter((c) => c.url.includes('/api/sync/pull')).length,
    0,
    'no pull when remote watermark is behind local',
  );

  syncedWatermark = 7000;
  pullResponse = { items: [{ item_uuid: 'note-a', unchanged: true, synced_at: 7000 }], has_more: false };
  fetchCalls.length = 0;
  await NotesStore.syncWhileLocked({ quiet: true });

  const pulls = fetchCalls.filter((c) => c.url.includes('/api/sync/pull'));
  assert.strictEqual(pulls.length, 1, 'pull runs when watermark is ahead');
  assert.deepStrictEqual(pulls[0].body.known_hashes, { 'note-a': 'hash-a', 'note-b': 'hash-b' });

  const log = NotesStore.syncLogEntries().filter((e) => e.kind === 'pull-cipher-locked');
  const last = log[log.length - 1];
  assert.ok(last, 'pull telemetry logged');
  assert.strictEqual(typeof last.known_hash_count, 'number');
  assert.strictEqual(last.known_hash_count, 2);

  console.log('test_sync_locked_pull.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
