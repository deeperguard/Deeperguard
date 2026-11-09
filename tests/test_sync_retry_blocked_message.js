/**
 * Sync retry_conflict must surface human copy in blocked toasts, not reason codes.
 */
const assert = require('assert');
const path = require('path');

const NotesStore = require(path.join(__dirname, '..', 'app/static/js/store.js'));

const HUMAN_EN = 'This save could not be applied safely. The note may have changed — edit and save again.';

function blockedToastLine(info) {
  if (info.status !== 'retry_conflict') return '';
  return info.error || NotesStore.syncRetryConflictUserMessage();
}

(() => {
  const serverResult = {
    status: 'retry_conflict',
    reason: 'retry_hash_mismatch',
    error: HUMAN_EN,
  };
  const line = blockedToastLine({
    status: serverResult.status,
    reason: serverResult.reason,
    error: serverResult.error,
  });
  assert.strictEqual(line, HUMAN_EN);
  assert.ok(!line.includes('retry_hash_mismatch'), 'toast must not show internal reason code');

  const fallback = blockedToastLine({
    status: 'retry_conflict',
    reason: 'retry_hash_mismatch',
    error: '',
  });
  assert.strictEqual(fallback, NotesStore.syncRetryConflictUserMessage());
  assert.ok(fallback.includes('safely') || fallback.includes('veilig'));

  console.log('test_sync_retry_blocked_message.js: ok');
})();
