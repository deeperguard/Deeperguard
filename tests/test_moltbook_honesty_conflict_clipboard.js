/**
 * Moltbook honesty items 3 (conflict-copy wording) and 5 (clipboard clear-if-ours).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const conflictJs = fs.readFileSync(path.join(root, 'app/static/js/conflict-copy.js'), 'utf8');
const clipboardJs = fs.readFileSync(path.join(root, 'app/static/js/clipboard-sensitive.js'), 'utf8');

// --- item 3: conflict copy honesty -----------------------------------------
assert.ok(conflictJs.includes('neither was discarded'));
assert.ok(conflictJs.includes(' (conflict copy)'));
assert.ok(appHtml.includes('id="note-info-conflict-row"'));
assert.ok(appHtml.includes('id="note-info-conflict-hint"'));
assert.ok(appJs.includes('NotesConflictCopy.toastMessage'));
assert.ok(appJs.includes('NotesConflictCopy.noteInfoHint'));
assert.ok(storeJs.includes('NotesConflictCopy.SUFFIX'));
assert.ok(!appJs.includes('was changed on another device too — kept both'));

const conflictSandbox = { window: {}, NotesConflictCopy: null };
vm.runInNewContext(conflictJs, conflictSandbox);
const CC = conflictSandbox.window.NotesConflictCopy;
assert.ok(CC);
assert.strictEqual(CC.titledCopyName('Plan'), 'Plan (conflict copy)');
assert.ok(CC.toastMessage('Plan').includes('Plan (conflict copy)'));
assert.ok(CC.noteInfoHint().includes('nothing was merged or deleted'));

// --- item 5: clipboard clear-if-ours ---------------------------------------
assert.ok(appHtml.includes('js/clipboard-sensitive.js'));
assert.ok(appJs.includes('copySensitiveToClipboard'));
assert.ok(appJs.includes('NotesClipboardSensitive'));
assert.ok(clipboardJs.includes('not older clipboard items'));
assert.ok(!clipboardJs.match(/clipboard history/i));
assert.ok(clipboardJs.includes('current !== want'));

const writes = [];
let readValue = '';
const sandbox = {
  window: {},
  module: { exports: {} },
  setTimeout() { return 1; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
  navigator: {
    clipboard: {
      writeText: async (t) => { writes.push(t); },
      readText: async () => readValue,
    },
  },
  document: {
    createElement: () => ({
      value: '',
      style: {},
      setAttribute() {},
      select() {},
      remove() {},
    }),
    execCommand: () => false,
    body: { appendChild() {}, removeChild() {} },
  },
};
sandbox.window = sandbox;
vm.runInNewContext(clipboardJs, sandbox);
const CS = sandbox.window.NotesClipboardSensitive;
assert.ok(CS);

assert.ok(CS.countdownMessage('Code', 12).includes('not older clipboard items'));
assert.ok(CS.countdownMessage('Password', 45, { shownBelow: true }).includes('shown below and copied'));
assert.ok(appJs.includes('shownBelow: true'));
assert.ok(!clipboardJs.includes('setInterval'));
assert.ok(CS.resultMessage('Code', 'cleared').includes('we copied'));
assert.ok(CS.resultMessage('Code', 'changed').includes('left as-is'));
assert.ok(!CS.resultMessage('Code', 'cleared').match(/history/i));

(async () => {
  readValue = '123456';
  const cleared = await CS.clearIfStillOurs('123456');
  assert.strictEqual(cleared, 'cleared');
  assert.strictEqual(writes[writes.length - 1], '');

  readValue = 'other';
  const unchanged = await CS.clearIfStillOurs('123456');
  assert.strictEqual(unchanged, 'changed');

  let toasts = [];
  let timers = 0;
  const timerSandbox = {
    window: {},
    module: { exports: {} },
    setTimeout(fn) {
      timers += 1;
      return timers;
    },
    clearTimeout() {},
    navigator: {
      clipboard: {
        writeText: async (t) => { writes.push(t); },
        readText: async () => null,
      },
    },
    document: {
      createElement: () => ({
        value: '',
        style: {},
        setAttribute() {},
        select() {},
        remove() {},
      }),
      execCommand: () => false,
      body: { appendChild() {}, removeChild() {} },
    },
  };
  timerSandbox.window = timerSandbox;
  vm.runInNewContext(clipboardJs, timerSandbox);
  const CSTimer = timerSandbox.window.NotesClipboardSensitive;
  toasts = [];
  await CSTimer.copySensitive('secret', {
    label: 'Password',
    shownBelow: true,
    onToast: (m) => toasts.push(m),
  });
  assert.strictEqual(timers, 0, 'no auto-clear timer when clipboard read is unavailable');
  assert.ok(toasts.length === 1, 'single initial toast without countdown spam');
  assert.ok(toasts[0].includes('shown below and copied'));
  assert.ok(toasts[0].includes('clear it yourself'));

  console.log('test_moltbook_honesty_conflict_clipboard ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
