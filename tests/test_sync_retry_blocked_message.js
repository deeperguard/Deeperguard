/**
 * Sync retry_conflict must surface human copy in blocked toasts, not reason codes.
 */
const assert = require('assert');
const path = require('path');

const NotesStore = require(path.join(__dirname, '..', 'app/static/js/store.js'));

const HUMAN_EN = 'This save could not be applied safely. The note may have changed — edit and save again.';
const TITLE = 'Budget note';

(() => {
  const line = NotesStore.retryConflictBlockedLine(TITLE, HUMAN_EN);
  assert.ok(line.startsWith(`“${TITLE}” did not sync:`));
  assert.ok(line.includes(HUMAN_EN));
  assert.ok(!line.includes('retry_hash_mismatch'), 'toast must not show internal reason code');

  const fallback = NotesStore.retryConflictBlockedLine(TITLE, '');
  assert.ok(fallback.startsWith(`“${TITLE}” did not sync:`));
  assert.ok(fallback.includes(NotesStore.syncRetryConflictUserMessage()));

  const stale = 'client-retry-key-stale';
  const item = { content: { title: TITLE }, sync_retry_key: stale };
  const rotated = NotesStore.rotateSyncRetryKey(item);
  assert.ok(rotated);
  assert.notStrictEqual(rotated, stale, 'conflict must rotate retry key');
  assert.strictEqual(item.sync_retry_key, rotated);

  const again = NotesStore.rotateSyncRetryKey(item);
  assert.notStrictEqual(again, rotated);

  console.log('test_sync_retry_blocked_message.js: ok');
})();
