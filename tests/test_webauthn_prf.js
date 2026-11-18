const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
const C = require(path.join(jsRoot, 'crypto.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'webauthn-client.js'), 'utf8'));
const W = globalThis.NotesWebAuthn;

const hex = (b) => Buffer.from(b).toString('hex');
const vk = { raw: new Uint8Array(32).map((_, i) => (i * 5 + 1) & 255) };
const salt = new Uint8Array(32).fill(7);
const options = { challenge: new Uint8Array(1) };

// Fake authenticator: the PRF output depends on credential and salt, like a real one.
const fakeOutput = (cred, s) => new Uint8Array(
  crypto.createHash('sha256').update(cred).update(Buffer.from(s)).digest(),
);

// caps: 'none' = no WebAuthn, null = no getClientCapabilities, object = its answer
function install({ caps, prf = true, cred = 'credA', seen = [] }) {
  if (caps === 'none') {
    delete globalThis.PublicKeyCredential;
  } else {
    globalThis.PublicKeyCredential = function PublicKeyCredential() {};
    if (caps) globalThis.PublicKeyCredential.getClientCapabilities = async () => caps;
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      credentials: {
        get: async ({ publicKey }) => {
          seen.push(publicKey);
          const first = publicKey.extensions.prf.eval.first;
          const results = prf ? { prf: { results: { first: fakeOutput(cred, first).buffer } } } : {};
          return { id: cred, getClientExtensionResults: () => results };
        },
      },
    },
  });
  return seen;
}

(async () => {
  // domain separation: the PRF wrap key is not the raw output nor the recovery-info key
  const out = fakeOutput('credA', salt);
  const wk = C.derivePrfWrapKey(out);
  assert.strictEqual(hex(wk.raw), hex(C.hkdfSha256(out, null, 'deeperguard/prf/v1', 32)));
  assert.notStrictEqual(hex(wk.raw), hex(C.hkdfSha256(out, null, 'deeperguard/recovery/v1', 32)));
  assert.notStrictEqual(hex(wk.raw), hex(out));
  assert.throws(() => C.derivePrfWrapKey(new Uint8Array(16)), /PRF output/);

  // round trip through a mocked ceremony, with the credential id in the AAD
  const seen = install({ caps: { 'extension:prf': true } });
  assert.strictEqual(await W.prfBrowserSupport(), 'available');
  const res = await W.requestPrfOutput(options, salt);
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(seen[0].userVerification, 'required');
  assert.strictEqual(hex(seen[0].extensions.prf.eval.first), hex(salt));
  const ctx = { accountId: '42', type: 'prf', binding: res.credentialId };
  const wrap = await C.wrapVaultKey(vk, C.derivePrfWrapKey(res.output), ctx);
  assert.strictEqual(wrap.key_id, C.vaultKeyId(vk));
  const again = await W.requestPrfOutput(options, salt);
  const back = await C.unwrapVaultKey(C.derivePrfWrapKey(again.output), wrap, ctx);
  assert.strictEqual(hex(back.raw), hex(vk.raw));

  // a different passkey fails: its own PRF output, or this one's output under its credential id
  install({ caps: { 'extension:prf': true }, cred: 'credB' });
  const other = await W.requestPrfOutput(options, salt);
  await assert.rejects(C.unwrapVaultKey(C.derivePrfWrapKey(other.output), wrap, { ...ctx, binding: 'credB' }));
  await assert.rejects(C.unwrapVaultKey(C.derivePrfWrapKey(res.output), wrap, { ...ctx, binding: 'credB' }));

  // authenticator returns no PRF: a clear "unsupported" outcome, nothing derived
  install({ caps: { 'extension:prf': true }, prf: false });
  assert.deepStrictEqual(
    await W.requestPrfOutput(options, salt),
    { status: 'unsupported', reason: 'authenticator' },
  );

  // browser reports no PRF, or has no WebAuthn: unsupported without opening a ceremony
  const unused = install({ caps: { 'extension:prf': false } });
  assert.strictEqual(await W.prfBrowserSupport(), 'unsupported');
  assert.deepStrictEqual(await W.requestPrfOutput(options, salt), { status: 'unsupported', reason: 'browser' });
  assert.strictEqual(unused.length, 0);
  install({ caps: 'none' });
  assert.strictEqual(await W.prfBrowserSupport(), 'unsupported');

  // browser cannot say: unknown, and the ceremony decides
  install({ caps: null });
  assert.strictEqual(await W.prfBrowserSupport(), 'unknown');
  assert.strictEqual((await W.requestPrfOutput(options, salt)).status, 'ok');

  // odd results are treated as "no PRF"
  assert.strictEqual(W.prfOutputFromCredential(null), null);
  assert.strictEqual(W.prfOutputFromCredential({ getClientExtensionResults: () => ({ prf: { enabled: true } }) }), null);
  assert.strictEqual(
    W.prfOutputFromCredential({ getClientExtensionResults: () => ({ prf: { results: { first: new ArrayBuffer(16) } } }) }),
    null,
  );
  assert.throws(() => W.prfExtension(new Uint8Array(0)), /salt/);

  console.log('ok');
})().catch((err) => { console.error(err); process.exit(1); });
