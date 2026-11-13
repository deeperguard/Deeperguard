/**
 * Templates UI flow: "Save as template" from the note menu, the "New from
 * template" dialog (arrow keys, Escape, title field, Create), built-ins,
 * the Templates view with management empty state, and the protected-note
 * refusal. Runs the real template section of app.js against a DOM stub and
 * the real NotesStore.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./sync_harness');
const T = require('../app/static/js/templates.js');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const { NotesStore } = h;

// --- markup ---
for (const id of ['template-dialog', 'template-dialog-list', 'template-dialog-name', 'template-dialog-create',
  'template-dialog-cancel', 'template-dialog-manage', 'btn-new-from-template', 'btn-save-template']) {
  assert.ok(appHtml.includes(`id="${id}"`), `missing #${id}`);
}
assert.ok(/id="template-dialog"[^>]*role="dialog"[^>]*aria-modal="true"/.test(appHtml));
assert.ok(appHtml.includes('data-filter="templates"') && appHtml.includes('<option value="templates">Templates</option>'));
assert.ok(appHtml.includes('{% raw %}{{date}}'), 'variable names in the help text are not evaluated by Jinja');
assert.ok(appHtml.indexOf("js/templates.js") < appHtml.indexOf("js/app.js')"), 'templates.js loads before app.js');
assert.ok(appJs.includes("getElementById('btn-new-from-template')?.addEventListener('click', () => openTemplateDialog())"));
assert.ok(appJs.includes("getElementById('btn-save-template')?.addEventListener('click', () => saveCurrentAsTemplate())"));
assert.ok(appJs.includes("title: 'No templates yet'") && appJs.includes('move it to Trash to delete it'), 'Templates view explains management');
assert.ok(appJs.includes('data-empty-template'), 'Templates empty view offers New from template');
assert.ok(appJs.includes("templates: 'Templates'"), 'list title for the Templates view');

// --- DOM stub ---
class El {
  constructor(id) { this.id = id; this.hidden = true; this.value = ''; this.innerHTML = ''; this.listeners = {}; this.isConnected = true; this.dataset = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, ev = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev };
    (this.listeners[type] || []).forEach((fn) => fn(event));
    return event;
  }
  focus() { doc.activeElement = this; }
  querySelector() { return { scrollIntoView() {} }; }
}
const els = new Map();
const doc = {
  activeElement: null,
  getElementById(id) { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
};
const $ = (id) => doc.getElementById(id);

// --- run the real template section of app.js ---
const start = appJs.indexOf('  // --- Templates (spec section 2)');
const end = appJs.indexOf('  function createTag(title,', start);
assert.ok(start > 0 && end > start, 'template section found in app.js');
const section = appJs.slice(start, end);

const log = { toasts: [], opened: [], filters: [] };
const ctx = {
  document: doc,
  NotesStore,
  NotesTemplates: T,
  currentId: null,
  currentFilter: 'all',
  toast: (msg, err) => log.toasts.push({ msg, err: !!err }),
  flushSave() {},
  renderNotes() {},
  renderTags() {},
  openNote: (id) => { log.opened.push(id); },
  setFilter: (name) => { log.filters.push(name); ctx.currentFilter = name; },
};
vm.createContext(ctx);
vm.runInContext(`${section}\nthis.api = { saveCurrentAsTemplate, openTemplateDialog, get dialog() { return templateDialog; } };`, ctx);
// currentId/currentFilter are closure vars in app.js; in the vm they are context globals.
const ui = ctx.api;

(async () => {
  await h.unlockFresh();
  h.resetServer();
  const label = NotesStore.createTag('Meetings');
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Standup', content: 'Standup {{title}} on {{date}} at {{time}}', tags: [label] });

  // 1. Save as template via the menu button
  ctx.currentId = noteId;
    const tplId = ui.saveCurrentAsTemplate();
  assert.ok(tplId, 'template created');
  assert.strictEqual(NotesStore.get(tplId).content.is_template, true);
  assert.strictEqual(log.toasts.pop().msg, 'Saved as template');

  // 2. Protected note is refused, nothing created
  const lockedId = NotesStore.newUuid();
  NotesStore.upsert(lockedId, { ...NotesStore.defaultNote(), title: 'Secret', content: 'x', locked: true });
  ctx.currentId = lockedId;
  assert.strictEqual(ui.saveCurrentAsTemplate(), null);
  assert.ok(log.toasts.pop().err, 'error toast for protected note');
  assert.strictEqual(T.listTemplates(NotesStore).length, 1);

  // 3. Open the dialog: user template first, then the three built-ins
  const opener = $('btn-new-from-template');
  opener.focus();
  ui.openTemplateDialog();
  const dialogEl = $('template-dialog');
  assert.strictEqual(dialogEl.hidden, false, 'dialog visible');
  assert.strictEqual(doc.activeElement, $('template-dialog-name'), 'focus moves to title field');
  let html = $('template-dialog-list').innerHTML;
  assert.ok(html.includes('role="listbox"'));
  assert.strictEqual((html.match(/role="option"/g) || []).length, 4);
  assert.ok(html.includes('Standup') && html.includes('Meeting note') && html.includes('Journal') && html.includes('Task'));
  assert.strictEqual((html.match(/Built-in/g) || []).length, 3);
  assert.ok(/data-tpl-index="0" aria-selected="true"/.test(html));

  // Arrow keys move the selection (and are consumed), clamped at the ends
  let ev = dialogEl.fire('keydown', { key: 'ArrowDown' });
  assert.ok(ev.defaultPrevented);
  assert.ok(/data-tpl-index="1" aria-selected="true"/.test($('template-dialog-list').innerHTML));
  dialogEl.fire('keydown', { key: 'ArrowUp' });
  dialogEl.fire('keydown', { key: 'ArrowUp' });
  assert.ok(/data-tpl-index="0" aria-selected="true"/.test($('template-dialog-list').innerHTML), 'clamped at top');
  dialogEl.fire('keydown', { key: 'End' });
  assert.ok(/data-tpl-index="3" aria-selected="true"/.test($('template-dialog-list').innerHTML));
  assert.ok(!dialogEl.fire('keydown', { key: 'a' }).defaultPrevented, 'typing is not swallowed');

  // Escape closes without creating anything, focus returns to the opener
  const before = NotesStore.listNotes().length;
  dialogEl.fire('keydown', { key: 'Escape' });
  assert.strictEqual(dialogEl.hidden, true);
  assert.strictEqual(ui.dialog, null);
  assert.strictEqual(doc.activeElement, opener);
  assert.strictEqual(NotesStore.listNotes().length, before);

  // 4. Reopen, pick the user template, type a title, confirm
  ui.openTemplateDialog();
  dialogEl.fire('keydown', { key: 'ArrowDown' });
  $('template-dialog-list').fire('click', { target: { closest: () => ({ dataset: { tplIndex: '0' } }) }, detail: 1 });
  assert.ok(/data-tpl-index="0" aria-selected="true"/.test($('template-dialog-list').innerHTML), 'click selects');
  $('template-dialog-name').value = 'Team A';
  $('template-dialog-name').fire('input');
  assert.ok($('template-dialog-list').innerHTML.includes('Standup Team A on'), 'preview shows filled variables');
  $('template-dialog-create').fire('click');
  assert.strictEqual(dialogEl.hidden, true);
  const newId = log.opened.pop();
  assert.ok(newId && newId !== tplId);
  const made = NotesStore.get(newId).content;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  assert.ok(new RegExp(`^Standup Team A on ${today} at \\d\\d:\\d\\d$`).test(made.content), made.content);
  assert.strictEqual(made.title, 'Team A');
  assert.strictEqual(made.is_template, false);
  assert.deepStrictEqual(made.tags, [label], 'labels carried over');

  // 5. Built-in via Enter, from the Templates view: switches back to All notes
  ctx.currentFilter = 'templates';
  ui.openTemplateDialog();
  dialogEl.fire('keydown', { key: 'ArrowDown' }); // Meeting note
  $('template-dialog-name').value = 'Kickoff';
  $('template-dialog-name').fire('input');
  dialogEl.fire('keydown', { key: 'Enter' });
  const meeting = NotesStore.get(log.opened.pop()).content;
  assert.strictEqual(meeting.title, `Kickoff – ${today}`);
  assert.ok(meeting.content.startsWith('# Kickoff\n\nDate: ' + today));
  assert.strictEqual(log.filters.pop(), 'all');
  assert.strictEqual(T.listTemplates(NotesStore).length, 1, 'built-ins are not stored as templates');

  // 6. Manage templates -> Templates view; empty-state hint when no user templates
  ui.openTemplateDialog();
  $('template-dialog-manage').fire('click');
  assert.strictEqual(dialogEl.hidden, true);
  assert.strictEqual(log.filters.pop(), 'templates');
  // Rename/edit = normal note edit; trash hides it from the dialog
  NotesStore.upsert(tplId, { ...NotesStore.get(tplId).content, title: 'Daily standup', content: 'Edited {{title}}' });
  ui.openTemplateDialog();
  assert.ok($('template-dialog-list').innerHTML.includes('Daily standup'), 'renamed template listed');
  $('template-dialog-cancel').fire('click');
  NotesStore.upsert(tplId, { ...NotesStore.get(tplId).content, trashed: true });
  ui.openTemplateDialog();
  html = $('template-dialog-list').innerHTML;
  assert.ok(!html.includes('Daily standup'), 'trashed template not offered');
  assert.ok(html.includes('No templates of your own yet') && html.includes('Save as template'), 'empty-state help');
  dialogEl.fire('click', { target: dialogEl });
  assert.strictEqual(dialogEl.hidden, true, 'backdrop click closes');

  console.log('test_templates_ui.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
