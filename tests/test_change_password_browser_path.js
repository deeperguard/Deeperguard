// Investigation (docs/CHANGE_PASSWORD_LOCKOUT.md): run changePassword with the
// browser code path of unlock() (keyVerified is NOT forced true by the Node
// shortcut). Documents today's behaviour: the change fails safely, nothing is
// pushed, no sign-in commit happens, and a double click or a retry does not
// change the verifier.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore } = h;
const NEW_PASSWORD = 'brand-new-password';
const commits = [];

function installAccountRoutes() {
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

(async () => {
  await h.unlockFresh();
  const id = NotesStore.newUuid();
  NotesStore.upsert(id, { ...NotesStore.defaultNote(), title: 'T', content: 'keep me' });
  h.stopPushTimer();
  h.resetServer();
  h.server.pushResponder = (items) => items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev: 1 }));
  await NotesStore.pushDirty({ quiet: true });
  assert.strictEqual(NotesStore.state.dirty.size, 0);

  // Emulate a browser: unlock() only sets keyVerified under Node.
  const realName = process.release.name;
  Object.defineProperty(process.release, 'name', { value: 'browser', configurable: true });
  try {
    h.resetServer();
    installAccountRoutes();
    h.server.pushResponder = (items) => items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev: 2 }));
    // Double click: the second call starts while the first is in flight.
    const first = NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD);
    const second = NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD);
    await assert.rejects(second, /already in progress/);
    await assert.rejects(first, (err) => err.code === 'REKEY_UPLOAD_FAILED');
    assert.strictEqual(h.pushCalls().length, 0, 'no POST /api/sync/items is ever sent (idea #28)');
    assert.strictEqual(commits.length, 0, 'verifier/sign-in never committed');
    assert.strictEqual(NotesStore.state.keyVerified, false, 'rollback leaves the key unverified in a browser');
    // A later retry fails the same safe way (verifyVaultPassword needs a verified key).
    await assert.rejects(NotesStore.changePassword(h.PASSWORD, NEW_PASSWORD));
    assert.strictEqual(commits.length, 0);
    assert.strictEqual(h.pushCalls().length, 0);
  } finally {
    Object.defineProperty(process.release, 'name', { value: realName, configurable: true });
  }
  console.log('test_change_password_browser_path.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
