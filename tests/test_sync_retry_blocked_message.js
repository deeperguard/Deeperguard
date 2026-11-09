/**
 * Sync retry_conflict must surface human copy in blocked toasts, not reason codes.
 */
const assert = require('assert');
const path = require('path');

const NotesStore = require(path.join(__dirname, '..', 'app/static/js/store.js'));

const HUMAN_EN = 'This save could not be applied safely. The note may have changed — edit and save again.';
const HUMAN_NL = 'Deze wijziging kon niet veilig worden opgeslagen. De notitie is mogelijk gewijzigd — bewerk en sla opnieuw op.';
const TITLE = 'Budget note';

function withDocLang(lang, fn) {
  const prev = global.document;
  if (lang == null) {
    delete global.document;
  } else {
    global.document = { documentElement: { lang } };
  }
  try {
    fn();
  } finally {
    if (prev === undefined) delete global.document;
    else global.document = prev;
  }
}

(() => {
  withDocLang('en', () => {
    const line = NotesStore.retryConflictBlockedLine(TITLE);
    assert.ok(line.startsWith(`“${TITLE}” did not sync:`));
    assert.ok(line.includes(HUMAN_EN));
    assert.ok(!line.includes('retry_hash_mismatch'), 'toast must not show internal reason code');
    assert.strictEqual(NotesStore.syncRetryConflictUserMessage(), HUMAN_EN);
  });

  withDocLang('nl', () => {
    const line = NotesStore.retryConflictBlockedLine(TITLE);
    assert.ok(!line.includes('did not sync'), 'NL toast shell must not use English did not sync');
    assert.ok(line.includes('is niet gesynchroniseerd'), 'NL toast shell');
    assert.ok(line.includes(HUMAN_NL), 'NL body from client locale, not server English');
    assert.ok(!line.includes(HUMAN_EN), 'server English error must not appear in NL toast');
    const serverOnly = NotesStore.syncRetryConflictUserMessage();
    assert.strictEqual(serverOnly, HUMAN_NL);
  });

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
