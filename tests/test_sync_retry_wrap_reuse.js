/**
 * Same dirty-cycle push retries must reuse ciphertext + hash; only mint a new
 * retry key when content/tombstone changes (or after retry_conflict rotation).
 */
const assert = require('assert');
const path = require('path');

const NotesStore = require(path.join(__dirname, '..', 'app/static/js/store.js'));

const content = { type: 'note', title: 'T', content: 'body' };
const row = {
  item_uuid: 'uuid-1',
  ciphertext: '{"v":1}',
  content_hash: 'hash-stable',
  sync_retry_key: 'retry-1',
  sync_request_hash: 'hash-stable',
};

(() => {
  const item = { updated_at: 100, deleted: false, sync_retry_key: 'retry-1', sync_push_wrap: null };
  const stamp = NotesStore.syncPushWrapStamp(item, content);
  item.sync_push_wrap = { stamp, row: { ...row } };

  const first = NotesStore.reuseCachedPushRow(item, content);
  assert.strictEqual(first.ciphertext, row.ciphertext);
  assert.strictEqual(first.content_hash, row.content_hash);
  assert.strictEqual(first.sync_request_hash, row.content_hash);
  assert.strictEqual(first.sync_retry_key, 'retry-1');

  const key2 = NotesStore.rotateSyncRetryKey(item);
  assert.notStrictEqual(key2, 'retry-1');
  const afterRotate = NotesStore.reuseCachedPushRow(item, content);
  assert.strictEqual(afterRotate.ciphertext, row.ciphertext);
  assert.strictEqual(afterRotate.content_hash, row.content_hash);
  assert.strictEqual(afterRotate.sync_retry_key, key2);

  item.updated_at = 101;
  assert.strictEqual(NotesStore.reuseCachedPushRow(item, content), null, 'content clock bump invalidates cache');

  const tomb = { ...content, deleted: true };
  item.updated_at = 100;
  item.sync_push_wrap.stamp = NotesStore.syncPushWrapStamp(item, tomb);
  assert.strictEqual(NotesStore.reuseCachedPushRow(item, content), null, 'tombstone stamp mismatch');

  console.log('test_sync_retry_wrap_reuse.js: ok');
})();
