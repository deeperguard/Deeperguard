// Regression (docs/CHANGE_PASSWORD_LOCKOUT.md, idea #28): run changePassword
// with the browser code path of unlock() (keyVerified is NOT forced true by the
// Node shortcut). Covers success (items pushed, change committed, new key in
// use), rollback (push fails: old password and previous keyVerified intact,
// rows re-pushed under the old key) and a double call.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore, NotesCrypto } = h;
const NEW_PASSWORD = 'brand-new-password';
let commits = [];

function installAccountRoutes() {
  commits = [];
  h.server.route = (url, body) => {
    if (url.includes('/api/account/unlock')) return {};
    if (url.includes('/api/account/password/prove')) return { rotation_token: 'rot-1' };
    if (url.includes('/api/account/password')) {
      commits.push(body);
      return { ok: true, password_changed_at: Date.now() / 1000 };
    }
    if (url.includes('/api/account')) return { email: 'me@example.com', kdf_salt: h.SALT };
    return undefined;
  };
}

const okResponder = (rev) => (items) => items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev }));
const pushedRows = () => h.pushCalls().flatMap((c) => c.body.items);

(async () => {
  await h.unlockFresh();
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title: 'T', content: 'keep me' });
  h.stopPushTimer();
  h.resetServer();
  h.server.pushResponder = okResponder(1);
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.size, 0);
  const oldKey = NotesStore.state.cryptoKey;

  // Emulate a browser: unlock() only sets keyVerified under Node.
  const realName = process.release.name;
  Object.defineProperty(process.release, 'name', { value: 'browser', configurable: true });
  try {
    // --- rollback: the upload fails -------------------------------------
    NotesStore.state.keyVerified = true;
    h.resetServer();
    installAccountRoutes();
    h.server.pushResponder = () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD), (e) => e.code === 'REKEY_UPLOAD_FAILED');
    assert.strictEqual(commits.length, 0, 'sign-in never committed');
    assert.strictEqual(NotesStore.state.keyVerified, true, 'previous keyVerified restored');
    assert.ok(await NotesStore.verifyVaultPassword(h.PASSWORD), 'old password still works');
    assert.ok(!(await NotesStore.verifyVaultPassword(NEW_PASSWORD)));
    assert.ok(NotesStore.state.dirty.has(id));
    // Rows go back out under the OLD key (the gate is open for the old key).
    h.resetServer();
    h.server.pushResponder = okResponder(2);
    await NotesStore.pushDirty({ quiet: true });
    assert.strictEqual(NotesStore.state.dirty.size, 0);
    const row = pushedRows().find((r) => r.item_uuid === id);
    assert.strictEqual((await NotesCrypto.decryptObject(oldKey, JSON.parse(row.ciphertext))).content, 'keep me');

    // An unverified key still cannot start a change (gate untouched).
    NotesStore.state.keyVerified = false;
    await assert.rejects(NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD));
    assert.strictEqual(NotesStore.state.keyVerified, false);
    assert.strictEqual(commits.length, 0);

    // --- success + double call ------------------------------------------
    NotesStore.state.keyVerified = true;
    h.resetServer();
    installAccountRoutes();
    h.server.pushResponder = okResponder(3);
    const first = NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD);
    const second = NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD);
    await assert.rejects(second, /already in progress/);
    const result = await first;
    assert.ok(result.reencrypted >= 1);
    assert.strictEqual(commits.length, 1, 'committed exactly once');
    assert.ok(h.pushCalls().length >= 1, 'POST /api/sync/items was sent');
    const newKey = NotesStore.state.cryptoKey;
    assert.notStrictEqual(newKey, oldKey);
    const pushed = pushedRows().find((r) => r.item_uuid === id);
    assert.strictEqual((await NotesCrypto.decryptObject(newKey, JSON.parse(pushed.ciphertext))).content, 'keep me');
    await assert.rejects(NotesCrypto.decryptObject(oldKey, JSON.parse(pushed.ciphertext)));
    // The new password opens the vault, the old one does not.
    assert.ok(await NotesStore.verifyVaultPassword(NEW_PASSWORD));
    assert.ok(!(await NotesStore.verifyVaultPassword(h.PASSWORD)));
    assert.strictEqual(NotesStore.state.dirty.size, 0);
  } finally {
    Object.defineProperty(process.release, 'name', { value: realName, configurable: true });
  }
  console.log('test_change_password_browser_path.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
