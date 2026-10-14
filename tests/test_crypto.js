const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
vm.runInThisContext(
  fs.readFileSync(path.join(vendorRoot, 'noble-argon2.js'), 'utf8') + ';globalThis.NobleArgon2=NobleArgon2;',
);
const NotesCrypto = require(path.join(jsRoot, 'crypto.js'));

function loadCryptoWorker() {
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    atob,
    btoa,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (...urls) => {
    for (const url of urls) {
      vm.runInContext(fs.readFileSync(path.join(jsRoot, url), 'utf8'), sandbox);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(jsRoot, 'crypto-worker.js'), 'utf8'), sandbox);
  return {
    deriveKey(password, salt, kdfVersion) {
      return new Promise((resolve, reject) => {
        sandbox.postMessage = (msg) => {
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error || 'worker derive failed'));
        };
        sandbox.onmessage({
          data: { id: 1, type: 'deriveKey', password, salt, kdfVersion },
        }).catch(reject);
      });
    },
    decrypt(rawKey, payload) {
      return new Promise((resolve, reject) => {
        sandbox.postMessage = (msg) => {
          if (msg.ok) resolve(msg.content);
          else reject(new Error(msg.error || 'worker decrypt failed'));
        };
        sandbox.onmessage({
          data: { id: 2, type: 'decrypt', rawKey, payload },
        }).catch(reject);
      });
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

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
