const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const historyJs = fs.readFileSync(path.join(root, 'app/static/js/note-history.js'), 'utf8');

// 1. Every add-tag entry point toasts "Tag already exists" for duplicates.
const commitTag = appJs.split('function commitTagBarInput()')[1].split('function renderTagBar(')[0];
assert.ok(commitTag.includes("toast('Tag already exists')"), 'note tag input path');
assert.ok(!commitTag.includes("toast('Tag added')"), 'note tag input must not say Tag added');

const createTag = appJs.split('function createTag(')[1].split('function layoutFindBarOverDocViewer')[0];
assert.ok(createTag.includes("toast('Tag already exists')"), 'createTag / sidebar / Manage path');
assert.ok(!createTag.includes("toast(assignToCurrent ? 'Tag added'"), 'createTag must not prefer Tag added');

const manage = appJs.split('function createTagFromManage()')[1].split('document.getElementById(\'tag-manage-add\')')[0];
assert.ok(manage.includes("createTag(name, { navigate: false })"), 'Manage tags uses createTag');

assert.ok(appJs.includes("document.getElementById('btn-new-tag')"), 'sidebar + New tag entry');
assert.ok(appJs.includes('createTag(document.getElementById(\'tag-name-input\').value)'), 'sidebar composer');

// 2. Shared storage + note count helpers.
assert.ok(appJs.includes('function accountStorageParts'));
assert.ok(appJs.includes('function vaultActiveNoteCount'));
assert.ok(appJs.includes('accountStorageParts(account)'));
assert.ok(appJs.includes('accountStorageParts(full)'));
assert.ok(appJs.includes('vaultActiveNoteCount()'));
assert.ok(storeJs.includes('...live'));
assert.ok(storeJs.includes('live.email || localStorage.getItem(\'notes_email\')'));

// 3. Version labels use snapshot title only.
assert.ok(historyJs.includes('never the live note title'));
assert.ok(historyJs.includes('.sort((a, b) => revisionTimestamp(b) - revisionTimestamp(a))'));
assert.ok(appJs.includes('Version ${revisions.length - idx}'));

// 4. Empty password unlock.
const submitUnlock = appJs.split('async function submitUnlockForm()')[1].split('unlockForm?.addEventListener')[0];
assert.ok(submitUnlock.includes("showUnlockError('Enter your password')"));
assert.ok(submitUnlock.indexOf("showUnlockError('Enter your password')") < submitUnlock.indexOf('Checking…'));

// 5–6. Offline editor status + online recovery.
assert.ok(appJs.includes("phase === 'offline' && ui.saveStatus"));
assert.ok(appJs.includes("Saved on this device · will sync when online"));
assert.ok(storeJs.includes("notifyStatus('Saved on this device · will sync when online')"));
assert.ok(appJs.includes('function startOfflineWatch'));
assert.ok(appJs.includes('function stopOfflineWatch'));
assert.ok(appJs.includes('10000'));
assert.ok(appJs.includes('onlineRecoveryGeneration'));
assert.ok(appJs.includes('Always probe'));

console.log('test_round30_ui ok');
