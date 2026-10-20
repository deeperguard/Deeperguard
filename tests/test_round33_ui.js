/**
 * Round 33: login hint width/gap, empty-draft discard, Untitled list label,
 * self-host **bold**, phone ≥44px tap targets, backup cooldown toast.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NotesSearch = require('../app/static/js/search.js');
const {
  noteMayHardDiscard,
  noteHasBeenSaved,
} = NotesSearch;

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const searchJs = fs.readFileSync(path.join(root, 'app/static/js/search.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const adminApi = fs.readFileSync(path.join(root, 'app/admin_api.py'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

function note(content, extra = {}) {
  return {
    uuid: 'n1',
    rev: extra.rev || 0,
    content: { type: 'note', tags: [], attachments: [], revisions: [], ...content },
  };
}

// 1. Login subtitle + hint match form width; ~12px gap.
assert.ok(css.includes('.brand p.zk-plain') || css.includes('.brand .zk-plain'));
assert.ok(css.includes('.brand .auth-hint') || css.includes('.auth-hint'));
assert.ok(/\.brand \.auth-hint,\s*\n\.auth-hint \{[\s\S]*?margin:\s*12px 0 0/.test(css)
  || css.includes('margin: 12px 0 0'));
assert.ok(css.includes('width: 100%'));

// 2. Brand-new empty drafts may discard; ever-saved must not.
assert.strictEqual(noteMayHardDiscard(note({ title: '', content: '' })), true);
assert.strictEqual(noteMayHardDiscard(note({ title: '', content: '', folder_id: 'f1' })), false);
assert.strictEqual(noteMayHardDiscard(note({
  title: '   ',
  content: '  \n ',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: 'x', content: 'body' }],
})), false);
assert.strictEqual(noteHasBeenSaved(note({
  title: '',
  content: '',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: '', content: 'saved' }],
})), true);
assert.ok(appJs.includes('discardEmptyDraftNote(previousId)'));
assert.ok(searchJs.includes('folder_id'));

// List placeholder is Untitled (not Title).
assert.ok(appJs.includes('note-title-placeholder">Untitled</span>'));
assert.ok(!appJs.includes('note-title-placeholder">Title</span>'));
assert.ok(appJs.includes("|| 'Untitled'"));
assert.ok(appJs.includes("display === 'Untitled'"));

// 3. Self-host inline **bold**.
assert.ok(adminApi.includes(String.raw`\*\*([^*]+)\*\*`));
assert.ok(adminApi.includes('<strong>'));

// 4. Phone tap targets ≥44px for back / tags / new tag / history Restore.
assert.ok(css.includes('.editor-head #btn-back') || /#btn-back[\s\S]{0,80}min-height:\s*44px/.test(css));
const phoneHead = css.includes('grid-template-columns: 44px minmax(0, 1fr)');
assert.ok(phoneHead, 'editor-head back column is 44px on phone');
assert.ok(/\.editor-head \.tag-bar-toggle \{[\s\S]*?min-height:\s*44px/.test(css));
assert.ok(/\.tag-section \.tag-new-btn \{[\s\S]*?min-height:\s*44px/.test(css)
  || /#btn-new-tag[\s\S]*?min-height:\s*44px/.test(css));
assert.ok(/\.history-item \.btn \{[\s\S]*?min-height:\s*44px/.test(css));

// 5. Backup cooldown toast wording (verified + unverified paths).
assert.ok(appJs.includes('Code already sent — resend in'));
assert.ok(appJs.includes('Verify this email first — a code was already sent. Resend in'));
assert.ok(appJs.includes('armBackupNowCooldown'));
assert.ok(appJs.includes('backupNowCooldownLeft'));
assert.ok(appPy.includes('Code already sent — resend in'));
assert.ok(!appJs.includes('check your inbox, resend in'));
assert.ok(!appPy.includes('check your inbox, resend in'));

console.log('test_round33_ui ok');
