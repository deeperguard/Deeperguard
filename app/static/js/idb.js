window.NotesIDB = (() => {
  // Before accounts were scoped every account on a device shared this
  // database. It now belongs to the account recorded in notes_idb_owner (the
  // first account seen after the upgrade keeps it, so nothing is re-downloaded
  // or wiped); every other account gets its own database.
  const LEGACY_DB_NAME = 'deeperguard';
  const OWNER_KEY = 'notes_idb_owner';
  const EMAIL_KEY = 'notes_email';
  const DB_VERSION = 2;
  let dbPromise = null;
  let openedName = '';
  let account = '';

  function readLocal(key) {
    try {
      return String(localStorage.getItem(key) || '').trim().toLowerCase();
    } catch (err) {
      return '';
    }
  }

  function writeLocal(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      /* ignore quota / private mode */
    }
  }

  function normalizeAccount(email) {
    return String(email || '').trim().toLowerCase();
  }

  // Short, stable, non-secret tag for a database name (the address itself
  // already lives in localStorage; this only keeps names filesystem-friendly).
  function accountTag(email) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < email.length; i += 1) {
      hash ^= email.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function currentAccount() {
    return account || readLocal(EMAIL_KEY);
  }

  function dbName() {
    const email = currentAccount();
    if (!email) return LEGACY_DB_NAME;
    let owner = readLocal(OWNER_KEY);
    if (!owner) {
      writeLocal(OWNER_KEY, email);
      owner = email;
    }
    if (owner === email) return LEGACY_DB_NAME;
    return `${LEGACY_DB_NAME}-${accountTag(email)}`;
  }

  // Tell the store which account is signed in. Switching accounts closes the
  // current database so the next access opens that account's own one.
  function setAccount(email) {
    const next = normalizeAccount(email);
    if (next === account) return;
    account = next;
    if (dbPromise && openedName && openedName !== dbName()) {
      dbPromise.then((db) => {
        try { db.close(); } catch (err) { /* ignore */ }
      }).catch(() => {});
      dbPromise = null;
      openedName = '';
    }
  }

  function openDb() {
    const name = dbName();
    if (dbPromise && openedName === name) return dbPromise;
    if (dbPromise) {
      dbPromise.then((db) => {
        try { db.close(); } catch (err) { /* ignore */ }
      }).catch(() => {});
      dbPromise = null;
    }
    openedName = name;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onerror = () => {
        dbPromise = null;
        openedName = '';
        reject(req.error);
      };
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('items')) {
          db.createObjectStore('items', { keyPath: 'uuid' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'uuid' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
          openedName = '';
        };
        db.onclose = () => {
          dbPromise = null;
          openedName = '';
        };
        resolve(db);
      };
    });
    return dbPromise;
  }

  async function putItem(item) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      tx.objectStore('items').put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function deleteItem(uuid) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'blobs'], 'readwrite');
      tx.objectStore('items').delete(uuid);
      tx.objectStore('blobs').delete(uuid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadItems() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const req = tx.objectStore('items').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function iterateItems(onRow) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const row = cursor.value;
        const light = {
          uuid: row.uuid,
          ciphertext: row.ciphertext,
          content_hash: row.content_hash,
          updated_at: row.updated_at,
          deleted: row.deleted,
          content: row.content,
          has_blob: !!row.has_blob,
        };
        if (row.rev != null) light.rev = row.rev;
        const done = onRow(light);
        if (done === false) {
          resolve();
          return;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getItem(uuid) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const req = tx.objectStore('items').get(uuid);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function putBlob(uuid, blobCiphertext) {
    if (!blobCiphertext) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ uuid, blob_ciphertext: blobCiphertext });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getBlob(uuid) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readonly');
      const req = tx.objectStore('blobs').get(uuid);
      req.onsuccess = () => resolve(req.result ? req.result.blob_ciphertext || '' : '');
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteBlob(uuid) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(uuid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function putMeta(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getMeta(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAll() {
    const db = await openDb();
    const stores = ['items', 'blobs', 'meta'];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const name of stores) {
        tx.objectStore(name).clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    setAccount,
    currentAccount,
    dbName,
    putItem,
    deleteItem,
    loadItems,
    iterateItems,
    getItem,
    putBlob,
    getBlob,
    deleteBlob,
    putMeta,
    getMeta,
    clearAll,
  };
})();
