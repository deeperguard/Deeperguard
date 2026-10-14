// Regression: changePassword committed the new sign-in password even when the
// re-encrypted vault never reached the server (flush() result ignored), and a
// light-vault attachment whose bytes were never downloaded was pushed without
// its blob, leaving the server's old-key file unreadable with the new password.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore, NotesCrypto } = h;
const NEW_PASSWORD = 'brand-new-password';
const THIRD_PASSWORD = 'third-password-xyz';

function fakeFile(text, name) {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    type: 'text/plain',
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const passwordCommits = [];
const serverBlobs = new Map();
function installAccountRoutes() {
  h.server.route = (url, body) => {
    if (url.includes('/api/account/unlock')) return {};
    if (url.includes('/api/account/password/prove')) return { rotation_token: 'rot-1' };
    if (url.includes('/api/account/password')) {
      passwordCommits.push(body);
      return { ok: true, password_changed_at: Date.now() / 1000 };
    }
    if (url.includes('/api/account')) return { email: 'me@example.com', kdf_salt: h.SALT };
    return undefined;
  };
  h.server.blobResponder = (body) => body.uuids
    .map((uuid) => ({ item_uuid: uuid, blob_ciphertext: serverBlobs.get(uuid) || '' }))
    .filter((row) => row.blob_ciphertext);
}

async function decryptWith(key, row) {
  return NotesCrypto.decryptObject(key, JSON.parse(row.ciphertext));
}

(async () => {
  await h.unlockFresh();
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Taxes', content: 'keep me' });
  const attId = await NotesStore.addAttachment(noteId, fakeFile('invoice body', 'invoice.txt'));
  h.stopPushTimer();
  await h.waitFor(() => h.blobs.get(attId) && h.idb.get(noteId)?.ciphertext, 'items persisted');
  // Pretend this device never downloaded the file (light vault): the bytes
  // live on the server only.
  serverBlobs.set(attId, h.blobs.get(attId));
  h.blobs.delete(attId);
  const att = NotesStore.get(attId);
  assert.strictEqual(att.content.file_enc_stored, true);
  assert.strictEqual(att.content.file_enc, undefined);
  h.resetServer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 1 }));
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // --- 1. the file cannot be downloaded: nothing changes --------------------
  h.resetServer();
  installAccountRoutes();
  h.server.blobResponder = () => { throw new TypeError('Failed to fetch'); };
  const keyBefore = NotesStore.state.cryptoKey;
  await assert.rejects(NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD), /downloaded before the vault can be re-encrypted/);
  assert.strictEqual(passwordCommits.length, 0, 'sign-in is not changed');
  assert.strictEqual(h.pushCalls().length, 0, 'nothing is uploaded');
  assert.strictEqual(NotesStore.state.cryptoKey, keyBefore, 'the vault key is untouched');
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // --- 2. the upload fails: sign-in is not changed, local data stays readable
  h.resetServer();
  installAccountRoutes();
  h.server.pushResponder = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD), (err) => err.code === 'REKEY_UPLOAD_FAILED');
  assert.strictEqual(passwordCommits.length, 0, 'sign-in is not changed when the re-encrypted vault did not reach the server');
  assert.ok(await NotesStore.verifyVaultPassword(h.PASSWORD), 'the vault still opens with the current password');
  assert.ok(!(await NotesStore.verifyVaultPassword(NEW_PASSWORD)));
  const oldKey = NotesStore.state.cryptoKey;
  assert.strictEqual((await decryptWith(oldKey, h.idb.get(noteId))).content, 'keep me', 'IndexedDB rows are back under the current key');
  const blobAfterRollback = JSON.parse(h.blobs.get(attId));
  assert.strictEqual(new TextDecoder().decode(await NotesCrypto.decryptBytes(oldKey, blobAfterRollback)), 'invoice body', 'the downloaded file bytes are stored under the current key');
  assert.strictEqual(new TextDecoder().decode(await NotesStore.getAttachmentBytes(attId)), 'invoice body');
  // Whatever may have reached the server goes back out under the current key.
  assert.ok(NotesStore.state.dirty.has(noteId), 'rows are queued for a re-push under the current key');
  h.resetServer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 2 }));
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.size, 0);
  for (const call of h.pushCalls()) {
    for (const row of call.body.items) {
      const plain = await decryptWith(oldKey, row);
      assert.ok(plain, 'every re-pushed row reads with the current key');
    }
  }

  // --- 3. success: the missing file is fetched and re-encrypted too ----------
  h.resetServer();
  installAccountRoutes();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 3 }));
  const result = await NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD);
  assert.ok(result.reencrypted >= 2);
  assert.strictEqual(passwordCommits.length, 1, 'sign-in is changed once the vault is on the server');
  const newKey = NotesStore.state.cryptoKey;
  assert.notStrictEqual(newKey, oldKey);
  const pushedAtt = h.pushCalls().flatMap((c) => c.body.items).find((row) => row.item_uuid === attId);
  assert.ok(pushedAtt, 'the attachment is re-uploaded');
  assert.ok(pushedAtt.blob_ciphertext, 'the file bytes are uploaded, not just the metadata');
  const bytes = await NotesCrypto.decryptBytes(newKey, JSON.parse(pushedAtt.blob_ciphertext));
  assert.strictEqual(new TextDecoder().decode(bytes), 'invoice body', 'the uploaded file reads with the new password');
  await assert.rejects(NotesCrypto.decryptBytes(oldKey, JSON.parse(pushedAtt.blob_ciphertext)), 'the old key no longer opens it');
  const pushedNote = h.pushCalls().flatMap((c) => c.body.items).find((row) => row.item_uuid === noteId);
  assert.strictEqual((await decryptWith(newKey, pushedNote)).content, 'keep me');
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // --- 4. a failure half-way through a chunked upload rolls everything back --
  h.resetServer();
  installAccountRoutes();
  passwordCommits.length = 0;
  const ids = [];
  for (let i = 0; i < 205; i += 1) {
    const id = NotesStore.newUuid();
    ids.push(id);
    NotesStore.upsert(id, { ...NotesStore.defaultNote(), title: `n${i}`, content: String(i) });
  }
  h.stopPushTimer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 1 }));
  await NotesStore.pushDirty({ quiet: true });
  h.resetServer();
  installAccountRoutes();
  let requests = 0;
  h.server.pushResponder = (items) => {
    requests += 1;
    if (requests === 2) throw new TypeError('Failed to fetch');
    return items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 5 }));
  };
  await assert.rejects(NotesStore.changePassword(NEW_PASSWORD, THIRD_PASSWORD), (err) => err.code === 'REKEY_UPLOAD_FAILED');
  assert.strictEqual(passwordCommits.length, 0, 'a partial upload does not change sign-in');
  assert.ok(await NotesStore.verifyVaultPassword(NEW_PASSWORD), 'the vault still opens with the current password');
  // The chunk that landed under the rejected key is re-uploaded under the
  // current one (the rollback flushes right away; anything left drains later).
  const currentKey = NotesStore.state.cryptoKey;
  const rollbackCalls = h.pushCalls().slice(2);
  h.resetServer();
  h.server.pushResponder = (items) => items.map((row) => ({ item_uuid: row.item_uuid, status: 'ok', rev: 6 }));
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.size, 0, 'rollback re-push drains');
  rollbackCalls.push(...h.pushCalls());
  const sentIds = new Set(rollbackCalls.flatMap((c) => c.body.items).map((row) => row.item_uuid));
  for (const id of [...ids, noteId, attId]) assert.ok(sentIds.has(id), `every item goes back out under the current key (${id})`);
  for (const call of rollbackCalls) {
    for (const row of call.body.items) await decryptWith(currentKey, row);
  }

  console.log('test_sync_change_password.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
