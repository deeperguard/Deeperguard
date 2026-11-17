const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Worker } = require('worker_threads');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
vm.runInThisContext(
  fs.readFileSync(path.join(vendorRoot, 'noble-argon2.js'), 'utf8') + ';globalThis.NobleArgon2=NobleArgon2;',
);
const NotesCrypto = require(path.join(jsRoot, 'crypto.js'));

// Runs crypto-worker.js in a real worker thread: its own realm and globals, so
// the worker must load the vendor files itself through importScripts, as in
// the browser. (A vm.createContext sandbox made Argon2 about 30x slower,
// because every global lookup goes through the context's interceptors.)
// Timers are not stubbed: setInterval/clearInterval are the real worker-thread
// timers, which crypto-worker.js uses for its progress ticks (every 700 ms
// during deriveKey). The earlier vm sandbox stubbed them as no-ops instead.
const WORKER_HOST = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const load = (file) => vm.runInThisContext(
  fs.readFileSync(path.join(workerData.jsRoot, file), 'utf8'),
  { filename: file },
);
globalThis.self = globalThis;
globalThis.importScripts = (...urls) => urls.forEach(load);
globalThis.postMessage = (msg) => parentPort.postMessage(msg);
parentPort.on('message', (data) => self.onmessage({ data }));
load('crypto-worker.js');
`;

function loadCryptoWorker() {
  const thread = new Worker(WORKER_HOST, { eval: true, workerData: { jsRoot } });
  const pending = new Map();
  let nextId = 1;
  thread.on('message', (msg) => {
    const entry = pending.get(msg.id);
    if (!entry || msg.progress !== undefined) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error || 'worker request failed'));
  });
  thread.on('error', (err) => {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });
  function request(data) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      thread.postMessage({ ...data, id });
    });
  }
  return {
    async deriveKey(password, salt, kdfVersion) {
      return (await request({ type: 'deriveKey', password, salt, kdfVersion })).result;
    },
    async decrypt(rawKey, payload) {
      return (await request({ type: 'decrypt', rawKey, payload })).content;
    },
    terminate() {
      return thread.terminate();
    },
  };
}

(async () => {
  const salt = 'c2FsdC0xMjM0NQ=='; // base64 "salt-12345"

  const { key: v1Key } = await NotesCrypto.deriveKey('vault-password', salt, { kdfVersion: 1 });
  const plain = new TextEncoder().encode('scanned-file-bytes');
  const enc = await NotesCrypto.encryptBytes(v1Key, plain);
  assert.strictEqual(enc.v, 1);
  assert.ok(enc.iv);
  assert.ok(enc.data);
  assert.ok(!enc.data.includes('scanned-file-bytes'));
  const dec = await NotesCrypto.decryptBytes(v1Key, enc);
  assert.deepStrictEqual(Buffer.from(dec), Buffer.from(plain));

  const { key: other } = await NotesCrypto.deriveKey('other-password', salt, { kdfVersion: 1 });
  await assert.rejects(() => NotesCrypto.decryptBytes(other, enc));

  const { key: v2Key } = await NotesCrypto.deriveKey('vault-password', salt, { kdfVersion: 2 });
  assert.notDeepStrictEqual(Buffer.from(v1Key.raw), Buffer.from(v2Key.raw));
  const enc2 = await NotesCrypto.encryptBytes(v2Key, plain);
  const dec2 = await NotesCrypto.decryptBytes(v2Key, enc2);
  assert.deepStrictEqual(Buffer.from(dec2), Buffer.from(plain));
  await assert.rejects(() => NotesCrypto.decryptBytes(v1Key, enc2));

  const worker = loadCryptoWorker();
  const workerKey = await worker.deriveKey('vault-password', salt, 2);
  assert.deepStrictEqual(
    Buffer.from(workerKey.raw, 'base64'),
    Buffer.from(v2Key.raw),
    'worker Argon2 salt must match the main-thread salt',
  );
  const note = { type: 'note', title: 'worker' };
  const noteEnc = await NotesCrypto.encryptObject(v2Key, note);
  const workerNote = await worker.decrypt(workerKey.raw, noteEnc);
  assert.strictEqual(JSON.stringify(workerNote), JSON.stringify(note));
  await worker.terminate();

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
