// Shared Node fixture for NotesStore sync tests: an in-memory IndexedDB stub,
// a scriptable fetch for /api/sync/*, and helpers to unlock, encrypt rows, and
// wait for asynchronous store work. Required by tests/test_sync_*.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');

const idb = new Map();
const blobs = new Map();
const meta = new Map();
const fetchCalls = [];
const server = {
  pullPages: [],
  pushResponder: null,
  pushStatus: 200,
  refetchResponder: null,
  blobResponder: null,
  watermark: { watermark: 1, synced_watermark: 5000, item_count: 1 },
};

global.addEventListener = () => {};
global.window = global;
global.navigator = { onLine: true };
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
    blobs.delete(uuid);
  },
  async loadItems() {
    return [...idb.values()];
  },
  async getItem(uuid) {
    return idb.get(uuid) || null;
  },
  async putBlob(uuid, blob) {
    if (blob) blobs.set(uuid, blob);
  },
  async getBlob(uuid) {
    return blobs.get(uuid) || '';
  },
  async deleteBlob(uuid) {
    blobs.delete(uuid);
  },
  async getMeta(key) {
    return meta.has(key) ? meta.get(key) : null;
  },
  async putMeta(key, value) {
    meta.set(key, JSON.parse(JSON.stringify(value)));
  },
  async clearAll() {
    idb.clear();
    blobs.clear();
    meta.clear();
  },
};

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

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
    const page = server.pullPages.length ? server.pullPages.shift() : { items: [], has_more: false };
    if (typeof page === 'function') return jsonResponse(200, await page(body));
    return jsonResponse(200, { server_time: Date.now() / 1000, ...page });
  }
  if (pathUrl.includes('/api/sync/items')) {
    const items = body?.items || [];
    const answer = server.pushResponder
      ? await server.pushResponder(items, body)
      : items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok' }));
    if (answer && !Array.isArray(answer) && typeof answer === 'object' && answer.__status) {
      return jsonResponse(answer.__status, answer.body || {});
    }
    const results = answer;
    return jsonResponse(server.pushStatus, {
      ok: true,
      results,
      accepted: results.filter((r) => r.status === 'ok').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      stale: results.filter((r) => r.status === 'stale').length,
      server_time: Date.now() / 1000,
    });
  }
  if (pathUrl.includes('/api/sync/refetch')) {
    const items = server.refetchResponder ? await server.refetchResponder(body) : [];
    return jsonResponse(200, { items, server_time: Date.now() / 1000 });
  }
  if (pathUrl.includes('/api/sync/blobs')) {
    const out = server.blobResponder ? await server.blobResponder(body) : [];
    return jsonResponse(200, { blobs: out, server_time: Date.now() / 1000 });
  }
  if (pathUrl.includes('/api/sync/watermark')) {
    return jsonResponse(200, server.watermark);
  }
  return jsonResponse(200, {});
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

async function unlockFresh(password = PASSWORD) {
  await NotesStore.unlock(password, SALT, { kdfVersion: 1 });
  NotesStore.state.localReady = true;
}

async function encryptedRow(uuid, content, updatedAt, syncedAt, extra = {}) {
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
    ...extra,
  };
}

async function decryptRow(row) {
  return NotesCrypto.decryptObject(NotesStore.state.cryptoKey, JSON.parse(row.ciphertext));
}

function pushCalls() {
  return fetchCalls.filter((c) => c.url.includes('/api/sync/items') && c.method === 'POST');
}

function pullCalls() {
  return fetchCalls.filter((c) => c.url.includes('/api/sync/pull'));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetServer() {
  server.pullPages = [];
  server.pushResponder = null;
  server.pushStatus = 200;
  server.refetchResponder = null;
  server.blobResponder = null;
  fetchCalls.length = 0;
}

module.exports = {
  NotesStore,
  NotesCrypto,
  idb,
  blobs,
  meta,
  fetchCalls,
  server,
  SALT,
  PASSWORD,
  tick,
  waitFor,
  stopPushTimer,
  unlockFresh,
  encryptedRow,
  decryptRow,
  pushCalls,
  pullCalls,
  deferred,
  resetServer,
};
