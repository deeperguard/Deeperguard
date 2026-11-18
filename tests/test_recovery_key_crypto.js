const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
const C = require(path.join(jsRoot, 'crypto.js'));

const hex = (b) => Buffer.from(b).toString('hex');
const vk = () => ({ raw: new Uint8Array(32).map((_, i) => (i * 7 + 3) & 255) });
const ctx = { accountId: '42', type: 'recovery' };
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const FIXED_RK = Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f10111213', 'hex'));
const FIXED_SALT = Uint8Array.from(Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex'));

(async () => {
  // HKDF-SHA256: RFC 5869 test cases 1 and 3
  assert.strictEqual(
    hex(C.hkdfSha256(
      Buffer.alloc(22, 0x0b),
      Buffer.from('000102030405060708090a0b0c', 'hex'),
      Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
      42,
    )),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  );
  assert.strictEqual(
    hex(C.hkdfSha256(Buffer.alloc(22, 0x0b), null, '', 42)),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  );

  // fixed vectors for our own info strings (values from Node's crypto.hkdfSync)
  assert.strictEqual(
    hex(C.deriveRecoveryWrapKey(FIXED_RK, FIXED_SALT).raw),
    '070ae62aa313847005a4e6e4aafd60d510587e535ae8b4c7f75bc37d9bd1727c',
  );
  assert.strictEqual(C.vaultKeyId(vk()), '973c7c0d096f8dba6a66dfc005442ec5');

  // entropy: at least 128 bits, and two keys differ
  const rk = C.generateRecoveryKey();
  assert.ok(rk.length * 8 >= 128);
  assert.notStrictEqual(hex(rk), hex(C.generateRecoveryKey()));

  // encode / decode round trip and format
  const text = C.encodeRecoveryKey(rk);
  assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{2}$/);
  assert.strictEqual(hex(C.decodeRecoveryKey(text)), hex(rk));
  assert.strictEqual(hex(C.decodeRecoveryKey(text.toLowerCase().replace(/-/g, ' '))), hex(rk));
  assert.ok(C.encodeRecoveryKey(new Uint8Array(20)).startsWith('0000-0000-0000-0000-0000-0000-0000-0000-'));

  // typo detection: single-character substitutions and neighbour swaps
  const compact = C.encodeRecoveryKey(FIXED_RK).replace(/-/g, '');
  let caught = 0;
  let total = 0;
  const tryDecode = (candidate) => {
    total += 1;
    try {
      C.decodeRecoveryKey(candidate);
    } catch (err) {
      caught += 1;
    }
  };
  for (let i = 0; i < compact.length; i += 1) {
    for (const ch of ALPHABET) {
      if (ch !== compact[i]) tryDecode(compact.slice(0, i) + ch + compact.slice(i + 1));
    }
  }
  for (let i = 0; i < compact.length - 1; i += 1) {
    if (compact[i] !== compact[i + 1]) {
      tryDecode(compact.slice(0, i) + compact[i + 1] + compact[i] + compact.slice(i + 2));
    }
  }
  assert.ok(caught / total > 0.99, `caught ${caught}/${total}`);
  assert.throws(() => C.decodeRecoveryKey(compact.slice(1)), /length/);
  assert.throws(() => C.decodeRecoveryKey(`U${compact.slice(1)}`), /invalid character/);
  assert.throws(() => C.decodeRecoveryKey(''), /length/);
  assert.throws(() => C.encodeRecoveryKey(new Uint8Array(8)));

  // wrap / unwrap round trip
  const salt = C.generateRecoverySalt();
  const wk = C.deriveRecoveryWrapKey(rk, salt);
  assert.strictEqual(wk.raw.length, 32);
  assert.strictEqual(hex(wk.raw), hex(C.deriveRecoveryWrapKey(rk, salt).raw));
  assert.notStrictEqual(hex(wk.raw), hex(C.deriveRecoveryWrapKey(rk, C.generateRecoverySalt()).raw));
  const key = vk();
  const wrap = await C.wrapVaultKey(key, wk, ctx);
  assert.strictEqual(wrap.wrap_version, 1);
  assert.strictEqual(wrap.key_id, C.vaultKeyId(key));
  assert.match(wrap.key_id, /^[0-9a-f]{32}$/);
  assert.strictEqual(wrap.blob.v, 2);
  assert.strictEqual(hex((await C.unwrapVaultKey(wk, wrap, ctx)).raw), hex(key.raw));

  // wrong key fails
  await assert.rejects(C.unwrapVaultKey(C.deriveRecoveryWrapKey(C.generateRecoveryKey(), salt), wrap, ctx));
  await assert.rejects(C.unwrapVaultKey(C.deriveRecoveryWrapKey(rk, C.generateRecoverySalt()), wrap, ctx));

  // wrong AAD fails: other account, type, binding, key_id
  await assert.rejects(C.unwrapVaultKey(wk, wrap, { ...ctx, accountId: '43' }));
  await assert.rejects(C.unwrapVaultKey(wk, wrap, { ...ctx, type: 'prf' }));
  await assert.rejects(C.unwrapVaultKey(wk, wrap, { ...ctx, binding: 'cred' }));
  await assert.rejects(C.unwrapVaultKey(wk, { ...wrap, key_id: 'a'.repeat(32) }, ctx));
  await assert.rejects(C.unwrapVaultKey(wk, { ...wrap, wrap_version: 2 }, ctx), /version/);
  const bad = Buffer.from(wrap.blob.data, 'base64');
  bad[0] ^= 1;
  await assert.rejects(C.unwrapVaultKey(wk, { ...wrap, blob: { ...wrap.blob, data: bad.toString('base64') } }, ctx));

  // prf wraps bind the credential id
  const prfCtx = { accountId: '42', type: 'prf', binding: 'credA' };
  const prf = await C.wrapVaultKey(key, wk, prfCtx);
  assert.strictEqual(hex((await C.unwrapVaultKey(wk, prf, prfCtx)).raw), hex(key.raw));
  await assert.rejects(C.unwrapVaultKey(wk, prf, { ...prfCtx, binding: 'credB' }));

  // invalid inputs
  await assert.rejects(C.wrapVaultKey(key, wk, { accountId: '4|2', type: 'recovery' }), /Invalid wrap context/);
  await assert.rejects(C.wrapVaultKey(key, wk, { accountId: '42', type: 'nope' }), /wrap type/);
  await assert.rejects(C.wrapVaultKey({ raw: new Uint8Array(16) }, wk, ctx));

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
