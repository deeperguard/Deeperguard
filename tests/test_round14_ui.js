const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const searchJs = fs.readFileSync(path.join(root, 'app/static/js/search.js'), 'utf8');
const markdown = fs.readFileSync(path.join(root, 'app/static/js/markdown.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'app/templates/login.html'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

// 1. Unlock Sign out refreshes CSRF and posts logout before leaving.
assert.ok(appJs.includes('async function refreshCsrfFromAccount('));
assert.ok(appJs.includes("await NotesStore.api('/api/auth/logout'"));
assert.ok(html.includes("sessionStorage.setItem('notes_csrf', account.csrf)"));
const unlockHandler = appJs.slice(appJs.indexOf("getElementById('unlock-signout')"), appJs.indexOf("getElementById('unlock-clear-saved')"));
assert.ok(unlockHandler.includes('requestSignOut()'));

// 2. Resend feedback is inline and the countdown uses the server retry_after.
assert.ok(html.includes('id="account-verify-resend-status"'));
assert.ok(html.includes('id="backup-verify-resend-status"'));
assert.ok(appJs.includes('function showResendStatus('));
assert.ok(appJs.includes("const sent = 'Verification code sent'"));
assert.ok(appJs.includes('Please wait ${Math.ceil(wait)} s before requesting another code'));
assert.ok(appJs.includes('Number(data && data.retry_after)'));
assert.ok(appJs.includes('startResendCooldown(buttonId, wait)'));
assert.ok(appPy.includes('def _verification_sent_response('));
assert.ok(appPy.includes('"retry_after": wait'));

// 3. Edit-mode link overlay uses the same horizontal padding as the textarea.
const padRule = css.split('.editor-pane .editor:not(.doc-preview-active) .note-body,')[1].split('}')[0];
assert.ok(padRule.includes('.note-body-links'));
assert.ok(padRule.includes('padding-left: 32px'));
assert.ok(padRule.includes('padding-right: 32px'));

// 4. Preview autolinks bare http(s) and angle-bracket URLs, not javascript:.
assert.ok(markdown.includes('function autolinkOutsideTags('));
assert.ok(markdown.includes('rel="noopener noreferrer" target="_blank"'));
assert.ok(markdown.includes('https?:\\/\\/|mailto:'));

// 5. List highlight follows the open note and the active folder view.
assert.ok(appJs.includes('function editorNoteOpen('));
assert.ok(appJs.includes('return editorNoteOpen() ? currentId :'));
assert.ok(appJs.includes('currentFolder === folder.uuid'));
const closeFn = appJs.slice(appJs.indexOf('function closeEditor('), appJs.indexOf('function closeEditor(') + 1800);
assert.ok(closeFn.includes('listSelectionId = null'));
assert.ok(closeFn.includes('renderFolders()'));

// 6. Cancelling a duplicate upload drops an empty untitled draft, and the
// sync toast counts the same notes the list shows.
assert.ok(appJs.includes('function abandonEmptyUploadDraft('));
assert.ok(appJs.includes("if (choice !== 'open') abandonEmptyUploadDraft(targetNoteId)"));
assert.ok(appJs.includes('function listedActiveNoteCount('));
assert.ok(appJs.includes('const noteCount = listedActiveNoteCount()'));

// 7. Wrong-password copy is an alert.
assert.ok(login.includes('id="login-error"'));
assert.ok(login.includes('role="alert"'));
assert.ok(login.includes('aria-live="assertive"'));

// 8. Desktop folders scroll above the footer instead of under a sticky bar.
const scrollCss = css.split('.sidebar-nav .sidebar-scroll {')[1].split('}')[0];
assert.ok(scrollCss.includes('overflow: auto'));
assert.ok(scrollCss.includes('scroll-padding-bottom: 16px'));
const folderCss = css.split('.sidebar-nav #folder-section {')[1].split('}')[0];
assert.ok(folderCss.includes('overflow: visible'));
const footCss = css.split('.sidebar-foot {').map((part) => part.split('}')[0]).find((part) => part.includes('position: static'));
assert.ok(footCss);

// 9. Moving a note does not rewrite the visible edited time.
assert.ok(appJs.includes('touchSyncOnly: true'));
assert.ok(storeJs.includes('touchSyncOnly = false'));
assert.ok(storeJs.includes('if (touchUpdatedAt && !touchSyncOnly)'));
assert.ok(searchJs.includes('content.updated_at is the user-visible edit time'));

console.log('ok');
