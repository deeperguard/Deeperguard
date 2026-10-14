// Regression: every account on a device shared one IndexedDB database, so
// signing in with a second account read (and synced!) the first account's
// rows. The local database is now per account; the pre-upgrade database stays
// with the account that was using it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');

// --- minimal in-memory IndexedDB ------------------------------------------
const databases = new Map();
const opened = [];

function later(fn) {
  setTimeout(fn, 0);
}

function request(result, error = null) {
  const req = { onsuccess: null, onerror: null, result, error };
  later(() => {
    if (error) req.onerror && req.onerror({ target: req });
    else req.onsuccess && req.onsuccess({ target: req });
  });
  return req;
}

class FakeStore {
  constructor(map, keyPath) {
    this.map = map;
    this.keyPath = keyPath;
  }

  put(value) {
    this.map.set(value[this.keyPath], JSON.parse(JSON.stringify(value)));
    return request(undefined);
  }

  get(key) {
    return request(this.map.has(key) ? this.map.get(key) : undefined);
  }

  delete(key) {
    this.map.delete(key);
    return request(undefined);
  }

  clear() {
    this.map.clear();
    return request(undefined);
  }

  getAll() {
    return request([...this.map.values()]);
  }

  openCursor() {
    const rows = [...this.map.values()];
    const req = { onsuccess: null, onerror: null, result: null };
    let i = 0;
    const step = () => {
      if (i >= rows.length) {
        req.result = null;
      } else {
        const value = rows[i];
        i += 1;
        req.result = { value, continue: () => later(step) };
      }
      req.onsuccess && req.onsuccess({ target: req });
    };
    later(step);
    return req;
  }
}

class FakeDB {
  constructor(name, data) {
    this.name = name;
    this.data = data;
    this.objectStoreNames = { contains: (store) => data.stores.has(store) };
    this.onversionchange = null;
    this.onclose = null;
  }

  createObjectStore(name, { keyPath }) {
    this.data.stores.set(name, { map: new Map(), keyPath });
  }

  transaction(names) {
    const list = Array.isArray(names) ? names : [names];
    const tx = { oncomplete: null, onerror: null, error: null };
    tx.objectStore = (name) => {
      assert.ok(list.includes(name), `store ${name} not in transaction`);
      const store = this.data.stores.get(name);
      return new FakeStore(store.map, store.keyPath);
    };
    later(() => later(() => tx.oncomplete && tx.oncomplete()));
    return tx;
  }

  close() {}
}

global.indexedDB = {
  open(name) {
    opened.push(name);
    let data = databases.get(name);
    const fresh = !data;
    if (fresh) {
      data = { stores: new Map() };
      databases.set(name, data);
    }
    const db = new FakeDB(name, data);
    const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db, error: null };
    later(() => {
      if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
      req.onsuccess && req.onsuccess({ target: req });
    });
    return req;
  },
};

const storage = {
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
global.localStorage = storage;
global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'idb.js'), 'utf8'));
const NotesIDB = global.NotesIDB;

(async () => {
  // A device that already used the shared database with one account.
  const legacy = { stores: new Map() };
  databases.set('deeperguard', legacy);
  legacy.stores.set('items', { map: new Map([['n1', { uuid: 'n1', ciphertext: 'alice-row' }]]), keyPath: 'uuid' });
  legacy.stores.set('meta', { map: new Map([['lastSync', { key: 'lastSync', value: 4242 }]]), keyPath: 'key' });
  legacy.stores.set('blobs', { map: new Map(), keyPath: 'uuid' });

  // 1. The first account seen after the upgrade keeps the shared database.
  localStorage.setItem('notes_email', 'Alice@Example.com');
  assert.strictEqual(NotesIDB.dbName(), 'deeperguard');
  assert.strictEqual(localStorage.getItem('notes_idb_owner'), 'alice@example.com', 'the shared database is claimed for its first account');
  assert.deepStrictEqual((await NotesIDB.loadItems()).map((r) => r.uuid), ['n1'], 'nothing is re-downloaded or wiped for that account');
  assert.strictEqual(await NotesIDB.getMeta('lastSync'), 4242);

  // 2. Another account gets its own database and sees none of Alice's rows.
  NotesIDB.setAccount('bob@example.com');
  assert.notStrictEqual(NotesIDB.dbName(), 'deeperguard');
  assert.ok(/^deeperguard-[0-9a-f]{8}$/.test(NotesIDB.dbName()), `scoped name: ${NotesIDB.dbName()}`);
  assert.deepStrictEqual(await NotesIDB.loadItems(), [], 'Bob does not see Alice\'s notes');
  assert.strictEqual(await NotesIDB.getMeta('lastSync'), null, 'Bob does not inherit Alice\'s sync cursor');
  assert.strictEqual(await NotesIDB.getItem('n1'), null);
  await NotesIDB.putItem({ uuid: 'b1', ciphertext: 'bob-row' });
  await NotesIDB.putMeta('dirty', ['b1']);

  // 3. Clearing Bob's device data leaves Alice's database alone.
  await NotesIDB.clearAll();
  assert.deepStrictEqual(await NotesIDB.loadItems(), []);
  assert.strictEqual(legacy.stores.get('items').map.size, 1, 'Alice\'s rows survive Bob\'s sign-out');
  assert.strictEqual(legacy.stores.get('meta').map.size, 1);

  // 4. Back to Alice: the shared database again, rows intact; Bob's writes
  //    never landed there.
  NotesIDB.setAccount('alice@example.com');
  assert.strictEqual(NotesIDB.dbName(), 'deeperguard');
  const rows = await NotesIDB.loadItems();
  assert.deepStrictEqual(rows.map((r) => r.uuid), ['n1']);
  assert.strictEqual(await NotesIDB.getMeta('dirty'), null, 'Bob\'s dirty queue is not Alice\'s');

  // 5. Names are stable per account across reloads.
  NotesIDB.setAccount('bob@example.com');
  const bobName = NotesIDB.dbName();
  NotesIDB.setAccount('');
  localStorage.setItem('notes_email', 'bob@example.com');
  assert.strictEqual(NotesIDB.dbName(), bobName, 'the database name follows notes_email when no account was set explicitly');

  // 6. Account switch bookkeeping on the sign-in page and in the app shell:
  //    the previous account claims the shared database before the new address
  //    replaces notes_email.
  const authPages = fs.readFileSync(path.join(jsRoot, 'auth-pages.js'), 'utf8');
  assert.ok(authPages.includes("localStorage.setItem('notes_idb_owner', previousEmail)"), 'login hands the shared database to the previous account');
  const store = fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8');
  assert.ok(store.includes('function rememberAccountEmail'), 'store records the account for NotesIDB');
  assert.ok(store.includes('NotesIDB.setAccount(next)'));

  console.log('test_idb_account_scope.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
