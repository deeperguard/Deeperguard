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
  getItem() {
    return null;
  },
  setItem() {},
  removeItem() {},
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
global.fetch = async () => ({ ok: true, json: async () => ({ items: [], server_time: 0 }) });
global.NotesSanitize = { clearUnchangedDirty() {} };
global.NotesCrypto = {
  async deriveKey() {
    return { key: 'k', encoding: 'hex' };
  },
};

vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8'));
const { mergeCrossDeviceProtection } = global.NotesStore;

const base = {
  type: 'note',
  title: 'Hello',
  content: 'body',
  locked: false,
  prevent_edit: false,
};

const lockedRemote = { ...base, locked: true };
const merged = mergeCrossDeviceProtection(base, lockedRemote);
assert.strictEqual(merged.changed, true);
assert.strictEqual(merged.content.locked, true);

const alreadyLocked = mergeCrossDeviceProtection({ ...base, locked: true }, lockedRemote);
assert.strictEqual(alreadyLocked.changed, false);

const unlockedRemote = { ...base, locked: false };
const cleared = mergeCrossDeviceProtection({ ...base, locked: true }, unlockedRemote);
assert.strictEqual(cleared.changed, false);
assert.strictEqual(cleared.content.locked, true);

const editLockedRemote = { ...base, prevent_edit: true };
const mergedEdit = mergeCrossDeviceProtection(base, editLockedRemote);
assert.strictEqual(mergedEdit.changed, true);
assert.strictEqual(mergedEdit.content.prevent_edit, true);

const keepEditLock = mergeCrossDeviceProtection(
  { ...base, prevent_edit: true },
  { ...base, prevent_edit: false },
);
assert.strictEqual(keepEditLock.changed, false);
assert.strictEqual(keepEditLock.content.prevent_edit, true);

const tagLocal = { type: 'tag', title: 'Work' };
assert.strictEqual(mergeCrossDeviceProtection(tagLocal, lockedRemote).changed, false);

console.log('test_note_protection_sync.js: ok');
