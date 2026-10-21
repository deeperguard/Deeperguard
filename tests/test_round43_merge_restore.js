/**
 * Round 43: merge-restore skips identical items (0 updated, no dirty/revisions)
 * and keeps a newer local edit over an older backup copy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

// UI: not-configured notes sit directly under their buttons
{
  const driveBtn = appHtml.indexOf('btn-backup-google-drive');
  const driveNote = appHtml.indexOf('google-drive-not-configured');
  const driveHelpLong = appHtml.indexOf('id="backup-file-help"');
  assert.ok(driveBtn > 0 && driveNote > driveBtn);
  assert.ok(driveNote < appHtml.indexOf('btn-backup-dropbox'));
  // Short per-button help: long combined paragraph is gone
  assert.ok(!appHtml.includes('Google Drive and Dropbox upload the same client-encrypted blob'));
  assert.ok(driveHelpLong > 0 && driveHelpLong < driveBtn);

  const dropBtn = appHtml.indexOf('btn-backup-dropbox');
  const dropNote = appHtml.indexOf('dropbox-not-configured');
  assert.ok(dropNote > dropBtn);
  assert.ok(dropNote < appHtml.indexOf('btn-backup-now'));
}

// Export section + pCloud own heading
assert.ok(appHtml.includes('>Export</h4>') || appHtml.includes('>Export<'));
assert.ok(appHtml.includes('btn-export-note'));
assert.ok(appHtml.indexOf('btn-export-note') < appHtml.indexOf('Restore &amp; import')
  || appHtml.indexOf('>Export<') < appHtml.indexOf('Restore'));
assert.ok(appHtml.includes('<h3>pCloud backup</h3>'));
assert.ok(appHtml.includes('data-plan-feature="pcloud_backup"'));

// 44px touch targets for backup buttons
assert.ok(appCss.includes('settings-backup-card'));
assert.ok(/settings-backup-card[\s\S]*min-height:\s*var\(--touch\)/.test(appCss));

// Toast + merge counters
assert.ok(appJs.includes('kept newer local'));
assert.ok(storeJs.includes('keptNewer'));
assert.ok(storeJs.includes('backupContentsEqual'));
assert.ok(storeJs.includes('Never overwrite a local item that is newer'));

const idb = new Map();
global.addEventListener = () => {};
global.window = global;
global.navigator = { onLine: true };
global.localStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.sessionStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
};
global.NotesIDB = {
  async putItem(row) {
    idb.set(row.uuid, JSON.parse(JSON.stringify(row)));
  },
  async deleteItem(uuid) {
    idb.delete(uuid);
  },
  async loadItems() {
    return [...idb.values()];
  },
  async iterateItems(onRow) {
    for (const row of idb.values()) onRow(row);
  },
  async getItem(uuid) {
    return idb.get(uuid) || null;
  },
  async putBlob() {},
  async getBlob() {
    return '';
  },
  async deleteBlob() {},
  async getMeta() {
    return null;
  },
  async putMeta() {},
};
global.fetch = async () => ({
  ok: true,
  json: async () => ({ items: [], server_time: Date.now() / 1000, ok: true }),
});
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
global.NotesSearch = require(path.join(jsRoot, 'search.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));

function revisionCount(item) {
  const revs = item?.content?.revisions;
  return Array.isArray(revs) ? revs.length : 0;
}

(async () => {
  await NotesStore.unlock('round43-vault-pass', 'round43-salt');
  NotesStore.markKeyVerified();

  const noteId = NotesStore.newUuid();
  const note = NotesStore.defaultNote();
  note.title = 'Merge restore note';
  note.content = 'Body A';
  note.revisions = [];
  NotesStore.upsert(noteId, note, { touchUpdatedAt: true });
  await NotesStore.flush();

  const local = NotesStore.get(noteId);
  const ts = Number(local.updated_at);
  assert.ok(ts > 0);
  const revsBefore = revisionCount(local);

  // Simulate a backup that re-encrypted with a fresh IV (different content_hash)
  // but identical plaintext + updated_at — the Round 43 bug case.
  const freshWrap = await NotesCrypto.encryptObject(NotesStore.state.cryptoKey, local.content);
  const freshCipher = JSON.stringify(freshWrap);
  const freshHash = await NotesCrypto.hashText(freshCipher);
  assert.notStrictEqual(freshHash, local.content_hash || '');

  const identicalBackup = {
    format: 'deeperguard-backup-v1',
    items: [{
      item_uuid: noteId,
      content_version: 1,
      ciphertext: freshCipher,
      content_hash: freshHash,
      deleted: false,
      updated_at: ts,
    }],
  };

  NotesStore.state.dirty.clear();
  const result = await NotesStore.importBackup(identicalBackup, true);
  assert.strictEqual(result.created, 0, 'identical restore should create nothing');
  assert.strictEqual(result.updated, 0, 'identical restore must not count as updated');
  assert.strictEqual(result.unchanged, 1);
  assert.strictEqual(result.keptNewer || 0, 0);
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false, 'no sync push for identical items');
  assert.strictEqual(revisionCount(NotesStore.get(noteId)), revsBefore, 'no new version-history entry');
  assert.strictEqual(NotesStore.get(noteId).content.content, 'Body A');

  // Newer local edit must survive Merge with an older backup.
  const newer = { ...NotesStore.get(noteId).content, content: 'Body B — local newer', revisions: [] };
  NotesStore.upsert(noteId, newer, { touchUpdatedAt: true, recordRevision: true });
  await NotesStore.flush();
  const afterEdit = NotesStore.get(noteId);
  const newerTs = Number(afterEdit.updated_at);
  assert.ok(newerTs > ts);
  const revsAfterEdit = revisionCount(afterEdit);

  const olderBackupWrap = await NotesCrypto.encryptObject(
    NotesStore.state.cryptoKey,
    { ...afterEdit.content, content: 'Body A', title: 'Merge restore note' },
  );
  const olderBackup = {
    format: 'deeperguard-backup-v1',
    items: [{
      item_uuid: noteId,
      content_version: 1,
      ciphertext: JSON.stringify(olderBackupWrap),
      content_hash: await NotesCrypto.hashText(JSON.stringify(olderBackupWrap)),
      deleted: false,
      updated_at: ts, // older than local
    }],
  };

  NotesStore.state.dirty.clear();
  const kept = await NotesStore.importBackup(olderBackup, true);
  assert.strictEqual(kept.updated, 0);
  assert.strictEqual(kept.keptNewer, 1);
  assert.strictEqual(NotesStore.get(noteId).content.content, 'Body B — local newer');
  assert.strictEqual(NotesStore.state.dirty.has(noteId), false);
  assert.strictEqual(revisionCount(NotesStore.get(noteId)), revsAfterEdit);

  // Older local + newer backup still updates.
  const olderLocalId = NotesStore.newUuid();
  const olderNote = NotesStore.defaultNote();
  olderNote.title = 'Will update';
  olderNote.content = 'old';
  NotesStore.upsert(olderLocalId, olderNote, { touchUpdatedAt: false });
  const olderItem = NotesStore.get(olderLocalId);
  olderItem.updated_at = 1000;
  NotesStore.state.items.set(olderLocalId, olderItem);
  await NotesStore.flush();

  const newerContent = { ...olderItem.content, content: 'from backup' };
  const newerWrap = await NotesCrypto.encryptObject(NotesStore.state.cryptoKey, newerContent);
  const newerCipher = JSON.stringify(newerWrap);
  const apply = await NotesStore.importBackup({
    format: 'deeperguard-backup-v1',
    items: [{
      item_uuid: olderLocalId,
      content_version: 1,
      ciphertext: newerCipher,
      content_hash: await NotesCrypto.hashText(newerCipher),
      deleted: false,
      updated_at: 2000,
    }],
  }, true);
  assert.strictEqual(apply.updated, 1);
  assert.strictEqual(NotesStore.get(olderLocalId).content.content, 'from backup');

  // Equal timestamps keep local (do not count as "updated").
  const tieId = NotesStore.newUuid();
  const tieNote = NotesStore.defaultNote();
  tieNote.title = 'Tie local';
  tieNote.content = 'local-body';
  NotesStore.upsert(tieId, tieNote, { touchUpdatedAt: false });
  const tieItem = NotesStore.get(tieId);
  tieItem.updated_at = 3000;
  NotesStore.state.items.set(tieId, tieItem);
  await NotesStore.flush();
  NotesStore.state.dirty.clear();
  const tieBackupContent = { ...tieItem.content, content: 'backup-body' };
  const tieWrap = await NotesCrypto.encryptObject(NotesStore.state.cryptoKey, tieBackupContent);
  const tieCipher = JSON.stringify(tieWrap);
  const tieResult = await NotesStore.importBackup({
    format: 'deeperguard-backup-v1',
    items: [{
      item_uuid: tieId,
      content_version: 1,
      ciphertext: tieCipher,
      content_hash: await NotesCrypto.hashText(tieCipher),
      deleted: false,
      updated_at: 3000,
    }],
  }, true);
  assert.strictEqual(tieResult.updated, 0, 'equal timestamps must not overwrite local');
  assert.strictEqual(tieResult.keptNewer, 1);
  assert.strictEqual(NotesStore.get(tieId).content.content, 'local-body');

  console.log('test_round43_merge_restore ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
