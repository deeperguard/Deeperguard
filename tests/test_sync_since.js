const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');

global.addEventListener = () => {};
global.window = global;
global.localStorage = {
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
};
global.sessionStorage = {
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
};
global.NotesIDB = {
  async putItem() {},
  async deleteItem() {},
  async loadItems() {
    return [];
  },
  async getMeta() {
    return null;
  },
  async putMeta() {},
};
const requested = [];
global.fetch = async (url, options = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  requested.push(method === 'GET' ? String(url) : `${method} ${url}`);
  return { ok: true, json: async () => ({ items: [], server_time: 999, total_undeleted: 0 }) };
};
global.NotesSanitize = { clearUnchangedDirty() {} };
global.NotesCrypto = {
  async deriveKey() {
    return { key: 'k', encoding: 'hex' };
  },
};

vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8'));
const NotesStore = global.NotesStore;

function reset() {
  NotesStore.state.items.clear();
  NotesStore.state.lastSync = 0;
  NotesStore.state.localReady = false;
  localStorage.removeItem('notes_last_sync');
  requested.length = 0;
}

reset();
assert.strictEqual(NotesStore.syncSince(), 0);

NotesStore.state.items.set('a', { updated_at: 100 });
assert.strictEqual(NotesStore.syncSince(), 0, 'local notes alone must not raise the pull cursor');
assert.strictEqual(NotesStore.syncSince(true), 0, 'full flag forces since=0');

NotesStore.state.lastSync = 250;
assert.strictEqual(NotesStore.syncSince(), 250);
assert.strictEqual(NotesStore.syncSince(true), 0);

reset();
localStorage.setItem('notes_last_sync', '80');
assert.strictEqual(NotesStore.syncSince(), 80);

(async () => {
  reset();
  NotesStore.state.cryptoKey = 'k';
  // Unlocked but localReady false used to skip sync entirely (PC empty vault bug).
  // It must still pull from the server.
  await NotesStore.sync();
  assert.ok(requested.length >= 1, 'unlocked sync must hit the server even before loadLocal');
  assert.ok(requested[0].includes('since=0') || requested[0] === 'POST /api/sync/pull');

  reset();
  NotesStore.state.cryptoKey = 'k';
  NotesStore.state.localReady = true;
  NotesStore.state.lastSync = 321;
  NotesStore.state.items.set('a', { updated_at: 321 });
  await NotesStore.sync();
  assert.deepStrictEqual(requested, ['POST /api/sync/pull']);

  reset();
  NotesStore.state.cryptoKey = 'k';
  NotesStore.state.localReady = true;
  NotesStore.state.lastSync = 321;
  NotesStore.state.items.set('a', { updated_at: 321 });
  await NotesStore.sync({ full: true });
  assert.ok(requested[0] === 'POST /api/sync/pull', 'full sync uses POST pull');

  reset();
  NotesStore.state.cryptoKey = 'k';
  NotesStore.state.localReady = true;
  await NotesStore.sync();
  assert.deepStrictEqual(requested, ['POST /api/sync/pull']);

  reset();
  NotesStore.state.lastSync = 99;
  localStorage.setItem('notes_last_sync', '99');
  await NotesStore.rememberLastSync(0);
  assert.strictEqual(NotesStore.state.lastSync, 0);
  assert.strictEqual(localStorage.getItem('notes_last_sync'), null);
  reset();
  NotesStore.state.cryptoKey = 'k';
  NotesStore.state.localReady = true;
  NotesStore.state.lastSync = 50;
  // Tag-only vault: liveCount matches serverTotal — must not force a second full pull.
  NotesStore.state.items.set('tag-1', { deleted: false, content: { type: 'tag', title: 'x' }, updated_at: 50 });
  let tagOnlyCalls = 0;
  global.fetch = async (url, options = {}) => {
    tagOnlyCalls += 1;
    const method = String(options.method || 'GET').toUpperCase();
    requested.push(method === 'GET' ? String(url) : `${method} ${url}`);
    return {
      ok: true,
      json: async () => ({ items: [], server_time: 999, total_undeleted: 1, has_more: false }),
    };
  };
  await NotesStore.sync({ quiet: true });
  assert.strictEqual(tagOnlyCalls, 1, 'tag-only vault must not loop into a full re-download');
  assert.strictEqual(requested[0], 'POST /api/sync/pull');

  global.fetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    requested.push(method === 'GET' ? String(url) : `${method} ${url}`);
    return { ok: true, json: async () => ({ items: [], server_time: 999, total_undeleted: 0 }) };
  };

  // Test sessionStorage CSRF fallback in api()
  let capturedHeaders = null;
  global.fetch = async (url, options = {}) => {
    capturedHeaders = options.headers;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  NotesStore.state.csrf = '';
  sessionStorage.setItem('notes_csrf', 'session-csrf-secret');
  await NotesStore.api('/api/test', { method: 'POST', body: '{}' });
  assert.strictEqual(capturedHeaders['X-CSRF-Token'], 'session-csrf-secret', 'api() should fallback to sessionStorage CSRF');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
