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

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
