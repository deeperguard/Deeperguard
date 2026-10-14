// Regression: a vault without authenticator entries whose local item count was
// below the server's total_undeleted (a few unreadable rows, for example) was
// re-downloaded from cursor 0 on every quiet sync, forever. The refill now
// accounts for rows this device already knows it cannot read and runs at most
// once per unlock.
const assert = require('assert');
const h = require('./sync_harness');

const { NotesStore, NotesCrypto } = h;

function zeroPulls() {
  return h.pullCalls().filter((c) => Number(c.body.since) === 0).length;
}

async function foreignRow(uuid, syncedAt) {
  // Encrypted with another key: this device can never open it.
  const other = await NotesCrypto.deriveKey('somebody-else', h.SALT, { kdfVersion: 1 });
  const payload = await NotesCrypto.encryptObject(other.key || other, { type: 'note', title: 'x' });
  const ciphertext = JSON.stringify(payload);
  return {
    item_uuid: uuid,
    content_version: 1,
    ciphertext,
    blob_ciphertext: '',
    content_hash: await NotesCrypto.hashText(ciphertext),
    deleted: false,
    updated_at: 10,
    synced_at: syncedAt,
  };
}

(async () => {
  await h.unlockFresh();
  h.resetServer();

  // Server reports 3 live items; only one can be read here, two are unreadable.
  const noteId = NotesStore.newUuid();
  const good = await h.encryptedRow(noteId, { ...NotesStore.defaultNote(), title: 'Readable' }, 10, 1001);
  const badA = await foreignRow(NotesStore.newUuid(), 1002);
  const badB = await foreignRow(NotesStore.newUuid(), 1003);
  const fullPage = () => ({ items: [good, badA, badB], has_more: false, total_undeleted: 3, cursor: 1003 });
  const quietPage = () => ({ items: [], has_more: false, total_undeleted: 3, cursor: 1003 });

  h.server.pullPages = [fullPage()];
  await NotesStore.sync({ quiet: true }).catch(() => {});
  assert.strictEqual(NotesStore.listNotes().length, 1);

  // Quiet syncs afterwards: the gap is explained by the unreadable rows, so
  // there is nothing to refill.
  h.resetServer();
  for (let i = 0; i < 4; i += 1) {
    h.server.pullPages = [quietPage(), fullPage()];
    await NotesStore.sync({ quiet: true }).catch(() => {});
  }
  assert.strictEqual(zeroPulls(), 0, `no full-vault refill when the missing rows are known to be unreadable (${zeroPulls()} refills)`);
  assert.strictEqual(NotesStore.state.undecryptable.size, 2, 'unreadable rows are remembered');

  // A gap that is NOT explained (server says 5, we hold 1 + 2 unreadable) is
  // refilled once per unlock, not on every tick.
  h.resetServer();
  const bigger = () => ({ items: [], has_more: false, total_undeleted: 5, cursor: 1003 });
  const biggerFull = () => ({ items: [good, badA, badB], has_more: false, total_undeleted: 5, cursor: 1003 });
  for (let i = 0; i < 4; i += 1) {
    h.server.pullPages = [bigger(), biggerFull()];
    await NotesStore.sync({ quiet: true }).catch(() => {});
  }
  assert.strictEqual(zeroPulls(), 1, `an unexplained gap is refilled once per unlock (${zeroPulls()} refills)`);

  // After re-unlocking, one more attempt is allowed.
  NotesStore.lock();
  await h.unlockFresh();
  await NotesStore.loadLocal({});
  h.resetServer();
  h.server.pullPages = [bigger(), biggerFull()];
  await NotesStore.sync({ quiet: true }).catch(() => {});
  h.server.pullPages = [bigger(), biggerFull()];
  await NotesStore.sync({ quiet: true }).catch(() => {});
  assert.strictEqual(zeroPulls(), 1, 'a fresh unlock gets exactly one refill attempt');

  console.log('test_sync_refill_once.js: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
