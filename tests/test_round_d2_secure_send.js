/**
 * D2 Secure Send — opaque file meta, Argon2id+fragment passphrase, manifest/SRI.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const secureJs = fs.readFileSync(path.join(root, 'app/static/js/secure-send.js'), 'utf8');
const receiveJs = fs.readFileSync(path.join(root, 'app/static/js/secure-send-receive.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const receiveHtml = fs.readFileSync(path.join(root, 'app/templates/receive.html'), 'utf8');
const verifyHtml = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'app/static/client-manifest.json'), 'utf8'),
);

assert.ok(appHtml.includes('id="secure-send-settings"'));
assert.ok(appHtml.includes('Number of opens'));
assert.ok(appHtml.includes('Default 1. The link stops working after this many opens or 7 days.'));
assert.ok(appHtml.includes('The key is in the link itself and never reaches our server'));
assert.ok(appHtml.includes('max="10"'));
assert.ok(appHtml.includes('btn-secure-send-copy'));
assert.ok(appHtml.includes('<textarea id="secure-send-link"'));
assert.ok(receiveHtml.includes('receive-open'));
assert.ok(receiveHtml.includes('Someone sent you an encrypted note'));
assert.ok(receiveHtml.includes('receive-heading'));
assert.ok(receiveHtml.includes('viewsRemaining'));
assert.ok(receiveHtml.includes('receive_intro') || receiveHtml.includes('This can be opened'));
assert.ok(receiveHtml.includes('This link stops working after it has been opened the number of times the sender chose.'));
assert.ok(receiveHtml.includes('asset_script'));
assert.ok(verifyHtml.includes('verify-secure-send'));
assert.ok(receiveJs.includes("getElementById('receive-heading')"));
assert.ok(manifest.assets['js/secure-send.js']);
assert.ok(manifest.assets['js/secure-send-receive.js']);
for (const key of ['js/secure-send.js', 'js/secure-send-receive.js']) {
  const entry = manifest.assets[key];
  assert.ok(entry.sri || entry.integrity || entry.sha384, `${key} needs SRI in manifest`);
}
assert.ok(secureJs.includes('VAULT_KDF_V2'));
assert.ok(secureJs.includes('derivePassphraseContentKey'));
assert.ok(secureJs.includes('computeOpenVerifier'));
assert.ok(secureJs.includes('dg-secure-send-verify-v1'));
assert.ok(secureJs.includes('size: buf.length') || /size:\s*buf\.length/.test(secureJs));
assert.ok(!secureJs.includes('Math.random'));
assert.ok(!receiveJs.includes('Math.random'));
assert.ok(appJs.includes('NotesSecureSend.sealPayload'));
assert.ok(appJs.includes('assertNoFragmentLeak'));
assert.ok(appJs.includes('open_verifier'));
assert.ok(appJs.includes('Revoke link?'));
assert.ok(appHtml.includes('id="secure-send-detail"'));
assert.ok(appHtml.includes('secure-send-detail-no-local'));
assert.ok(
  appHtml.includes('This send was created before multi-device Sent'),
  'missing-vault copy explains pre-v0.65.8 sends',
);
assert.ok(!appHtml.includes('Link key isn’t on this device'));
assert.ok(!appHtml.includes('Full link and contents stay on the device that created this link'));
assert.ok(appJs.includes('SECURE_SEND_NO_VAULT_RECORD_MSG'));
assert.ok(appHtml.includes('btn-secure-send-detail-copy'));
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const detailBackdropZ = appCss.match(/#secure-send-detail-backdrop\s*\{\s*z-index:\s*(\d+)/);
const detailSheetZ = appCss.match(/#secure-send-detail\s*\{\s*z-index:\s*(\d+)/);
const settingsPanelZ = appCss.match(/\.settings-panel\s*\{[\s\S]*?z-index:\s*(\d+)/);
assert.ok(detailBackdropZ, 'sent-detail backdrop needs ID z-index above settings');
assert.ok(detailSheetZ, 'sent-detail sheet needs ID z-index above settings');
assert.ok(settingsPanelZ, 'settings panel z-index must be documented in CSS');
assert.ok(
  Number(detailBackdropZ[1]) > Number(settingsPanelZ[1]),
  'sent-detail backdrop must stack above settings panel',
);
assert.ok(
  Number(detailSheetZ[1]) > Number(settingsPanelZ[1]),
  'sent-detail sheet must stack above settings panel',
);
assert.ok(appJs.includes('saveSecureSendSentRecord'));
assert.ok(appJs.includes('getSecureSendSentRecord'));
assert.ok(appJs.includes('openSecureSendSentDetail'));
const detailBlock = appJs.match(/function openSecureSendSentDetail\([\s\S]*?\n  async function revokeSecureSendSentItem/);
assert.ok(detailBlock, 'openSecureSendSentDetail must exist');
assert.ok(!detailBlock[0].includes('/open'), 'sent detail must not call /open');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
assert.ok(storeJs.includes("type: SECURE_SEND_SENT_TYPE") || storeJs.includes("'secure_send_sent'"));
assert.ok(storeJs.includes('saveSecureSendSentRecord'));
assert.ok(storeJs.includes('getSecureSendSentRecord'));
assert.ok(appJs.includes('function openSecureSendForNote'));
assert.ok(appJs.includes('function prefillSecureSendFromNote'));
assert.ok(appJs.includes('secureSendPendingFile'));
assert.ok(appJs.includes('NotesSecureSendNoteAttachments'));
assert.ok(appJs.includes('stageSecureSendNoteAttachments'));
const noteAttJs = fs.readFileSync(path.join(root, 'app/static/js/secure-send-note-attachments.js'), 'utf8');
assert.ok(noteAttJs.includes('stageSecureSendNoteAttachments'));
assert.ok(noteAttJs.includes('includedNames'));
assert.ok(appHtml.includes('secure-send-file-inclusion'));
assert.ok(appJs.includes('paintSecureSendFileInclusion'));
assert.ok(appJs.includes('stageSecureSendEntries'));
assert.ok(appJs.includes('mergeSecureSendPickedFiles'));
assert.ok(appJs.includes('removeSecureSendStagedFile'));
assert.ok(appJs.includes('scrollSecureSendSectionIntoView'));
assert.ok(appJs.includes('Including (as zip):'));
assert.ok(appJs.includes('From this note'));
assert.ok(appHtml.includes('btn-secure-send-add-files'));
assert.ok(appHtml.includes('secure-send-file-add'));
assert.ok(appJs.includes('secure-send-file-remove'));
assert.ok(!appHtml.includes('Use a different file'));
assert.ok(!appHtml.includes('btn-secure-send-use-different-file'));
assert.ok(appJs.includes('updateSecureSendFilePickerUi'));
assert.ok(!appJs.includes('secureSendFilePickerRevealed'));
assert.ok(appJs.includes('clearSecureSendStagedFiles'));
assert.ok(appHtml.includes('secure-send-file-picker-wrap'));
assert.ok(noteAttJs.includes('stageSecureSendEntries'));
assert.ok(fs.readFileSync(path.join(root, 'app/static/js/snimport.js'), 'utf8').includes('zipStored'));
assert.ok(appHtml.includes('secure-send-note-attachments.js'));
assert.ok(appHtml.includes('id="btn-note-secure-send"'));
assert.ok(appHtml.includes('id="note-row-menu-secure-send"'));
assert.ok(appJs.includes('note-row-more'));
assert.ok(appJs.includes('openNoteRowMenu'));
assert.ok(!/\bdeleted\b/i.test(secureJs));
assert.ok(!/\bdeleted\b/i.test(receiveJs));

const nobleCrypto = fs.readFileSync(path.join(root, 'app/static/js/vendor/noble-crypto.js'), 'utf8');
const nobleArgon = fs.readFileSync(path.join(root, 'app/static/js/vendor/noble-argon2.js'), 'utf8');
const cryptoJs = fs.readFileSync(path.join(root, 'app/static/js/crypto.js'), 'utf8');

function loadCrypto() {
  const nodeCrypto = require('crypto');
  const webcrypto = nodeCrypto.webcrypto;
  const sandbox = {
    console,
    Buffer,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    require,
    crypto: {
      getRandomValues: (arr) => webcrypto.getRandomValues(arr),
      subtle: webcrypto.subtle,
    },
    globalThis: null,
    window: null,
    module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(nobleCrypto, sandbox, { filename: 'noble-crypto.js' });
  vm.runInNewContext(nobleArgon, sandbox, { filename: 'noble-argon2.js' });
  // Full vault Argon2id (~64 MiB) is ~90s+ per derive in this harness; stub a
  // deterministic stand-in so passphrase/fragment logic still exercises end-to-end.
  const realArgon = sandbox.NobleArgon2;
  sandbox.NobleArgon2 = {
    ...realArgon,
    argon2idAsync: async (pwd, saltBytes) => {
      const h = nodeCrypto.createHash('sha256');
      h.update(Buffer.from(pwd));
      h.update(Buffer.from(saltBytes));
      h.update(Buffer.from('dg-secure-send-test-kdf'));
      return new Uint8Array(h.digest());
    },
  };
  vm.runInNewContext(cryptoJs, sandbox, { filename: 'crypto.js' });
  vm.runInNewContext(secureJs, sandbox, { filename: 'secure-send.js' });
  return sandbox.NotesSecureSend;
}

async function main() {
  const SS = loadCrypto();
  assert.strictEqual(SS.MAX_FILE_BYTES, 50 * 1024 * 1024);
  assert.strictEqual(SS.MAX_VIEWS_CAP, 10);
  assert.strictEqual(SS.DEFAULT_MAX_VIEWS, 1);

  // File name/MIME/size encrypted inside ciphertext (spec §1).
  const fakeFile = {
    name: 'invoice-Q3.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  };
  const sealedFile = await SS.sealPayload({
    title: 'Doc',
    body: 'see attach',
    file: fakeFile,
    passphrase: '',
  });
  const ctStr = JSON.stringify(sealedFile.ciphertext);
  assert.ok(!ctStr.includes('invoice-Q3.pdf'), 'filename must not appear in ciphertext JSON fields as plaintext envelope meta');
  // After decrypt, metadata is present.
  const openedFile = await SS.openPayload(sealedFile.ciphertext, sealedFile.fragment, '');
  assert.strictEqual(openedFile.file.name, 'invoice-Q3.pdf');
  assert.strictEqual(openedFile.file.mime, 'application/pdf');
  assert.strictEqual(openedFile.file.size, 4);
  assert.strictEqual(SS.downloadNameFromPayload(openedFile.file), 'invoice-Q3.pdf');

  // Create body must not carry filename (client wiring).
  assert.ok(!/has_file:\s*sealed/.test(appJs) || !appJs.includes('filename:'));

  // Passphrase: Argon2id + fragment key; link alone fails (spec §2).
  const sealedP = await SS.sealPayload({
    title: 'P',
    body: 'with pass',
    passphrase: 'correct horse',
  });
  assert.ok(sealedP.fragment.startsWith('v1p.'));
  const parts = sealedP.fragment.split('.');
  assert.strictEqual(parts.length, 3, 'v1p.salt.fragKey');
  let failed = false;
  try {
    await SS.openPayload(sealedP.ciphertext, sealedP.fragment, '');
  } catch (err) {
    failed = err.code === 'passphrase_required';
  }
  assert.ok(failed, 'empty passphrase must fail');
  let wrong = false;
  try {
    await SS.openPayload(sealedP.ciphertext, sealedP.fragment, 'wrong');
  } catch (err) {
    wrong = true;
  }
  assert.ok(wrong, 'wrong passphrase must fail');
  // Fragment key alone (empty pass already tested); passphrase alone: forge fragment without real fragKey.
  const forged = `v1p.${parts[1]}.${SS.b64url(new Uint8Array(32))}`;
  let forgedFail = false;
  try {
    await SS.openPayload(sealedP.ciphertext, forged, 'correct horse');
  } catch (err) {
    forgedFail = true;
  }
  assert.ok(forgedFail, 'passphrase without correct fragment key must fail');
  const ok = await SS.openPayload(sealedP.ciphertext, sealedP.fragment, 'correct horse');
  assert.strictEqual(ok.body, 'with pass');
  assert.ok(sealedP.openVerifier, 'passphrase seal must produce open_verifier');
  const key = await SS.resolveContentKey(sealedP.fragment, 'correct horse');
  const verifier = await SS.computeOpenVerifier(key);
  assert.strictEqual(verifier, sealedP.openVerifier);
  const wrongKey = await SS.resolveContentKey(sealedP.fragment, 'wrong horse');
  const wrongVer = await SS.computeOpenVerifier(wrongKey);
  assert.notStrictEqual(wrongVer, sealedP.openVerifier);

  SS.assertNoFragmentLeak('/api/secure-send', {
    ciphertext: sealedP.ciphertext,
    expires_in: 3600,
    max_views: 1,
    open_verifier: sealedP.openVerifier,
  });

  console.log('test_round_d2_secure_send ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
