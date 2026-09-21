window.NotesIDB = (() => {
  const DB_NAME = 'deeperguard';
  const DB_VERSION = 2;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => {
        dbPromise = null;
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
        };
        db.onclose = () => {
          dbPromise = null;
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
