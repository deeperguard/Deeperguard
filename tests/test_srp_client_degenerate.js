/**
 * Client-side SRP degenerate server values: B = 0, N, 2N, non-hex, empty, and u == 0
 * must all fail with the same generic error. A valid B must still work.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const src = fs.readFileSync(path.join(jsRoot, 'srp-auth.js'), 'utf8');
global.window = global;
if (!global.crypto || !global.crypto.subtle) global.crypto = crypto.webcrypto;
global.fetch = async () => ({ ok: false });
vm.runInThisContext(src);
const { SrpClient } = global.NotesSrpAuth;

// Group prime N, evaluated from the decimal literal in srp-auth.js
const m = src.match(/const N = (BigInt\([^;]*\));/);
assert(m, 'could not locate N in srp-auth.js');
const N = vm.runInNewContext(m[1]);
const GENERIC = 'Invalid server public value';
const SALT = 'ab'.repeat(16);

async function attempt(bHex) {
  const c = new SrpClient();
  c.step1('user@e2e.test', 'pw-secret');
  try {
    await c.step2(SALT, bHex);
  } catch (e) {
    return e.message;
  }
  return null;
}

(async () => {
  const cases = [
    ['B=0', '0'],
    ['B=N', N.toString(16)],
    ['B=2N', (2n * N).toString(16)],
    ['B empty', ''],
    ['B non-hex', 'zz!'],
  ];
  for (const [name, b] of cases) {
    assert.strictEqual(await attempt(b), GENERIC, name);
  }

  // u == 0: force the digest of (A || B) to zero; other hashes (x derivation) stay real.
  const origDigest = global.crypto.subtle.digest.bind(global.crypto.subtle);
  global.crypto.subtle.digest = async (alg, data) => (
    data.length > 300 ? new ArrayBuffer(32) : origDigest(alg, data)
  );
  try {
    assert.strictEqual(await attempt('2'), GENERIC, 'u=0');
  } finally {
    global.crypto.subtle.digest = origDigest;
  }

  // Normal value still accepted.
  assert.strictEqual(await attempt('2'), null, 'valid B');
  console.log('ok srp client degenerate checks');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
