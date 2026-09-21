const assert = require('assert');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

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
global.sessionStorage = global.localStorage;
global.NotesIDB = {
  async putItem() {},
  async deleteItem() {},
  async loadItems() { return []; },
  async getItem() { return null; },
  async getMeta() { return 0; },
  async putMeta() {},
};
global.fetch = async () => ({ ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) });
global.NotesSanitize = { escapeHtml: (s) => s, clearUnchangedDirty() {} };
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

NotesStore.logSync('sync-start', {
  quiet: true,
  full: false,
  local: 12,
  dirty: 0,
  lastSync: 1788000000,
  since: 1788000000,
  kdf: 2,
});
NotesStore.logSync('pull-page', {
  page: 1,
  items: 3,
  bytes: 2048,
  ms: 40,
  hasMore: false,
  decryptOk: 3,
  decryptSkipped: 0,
});
NotesStore.logSync('sync-done', { ok: true, ms: 55, items: 3, pages: 1 });

const text = NotesStore.formatSyncLog();
assert.match(text, /Sync log/);
assert.match(text, /sync-start/);
assert.match(text, /quiet/);
assert.match(text, /kdf=2/);
assert.match(text, /2\.0 KB/);
assert.match(text, /decrypt=3\/0/);
assert.match(text, /sync-done/);
assert.strictEqual(NotesStore.syncLogEntries().length >= 3, true);
console.log('ok');
