// Note templates (docs/design/notes-organisation.md §3.5, milestone M3).
// A template is its own encrypted item, `type: 'template'`, with `title` (the
// template name) and `body`. Type, name and text live inside the ciphertext,
// so the server never sees them. Older clients wrote templates as notes with
// `is_template: true`; those are still read, and migrateLegacy() converts
// them. Variables are filled here, client-side, in the local time zone, as
// plain text.
(() => {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const pad = (n) => String(n).padStart(2, '0');

  const TYPE = 'template';
  const DATE_DEFAULT = 'YYYY-MM-DD';
  const TIME_DEFAULT = 'HH:mm';
  // Allow-listed tokens only; anything else in the format is kept as typed.
  const TOKEN_RE = /YYYY|MM|DD|HH|mm|ss/g;

  function formatDate(d, fmt) {
    const parts = {
      YYYY: String(d.getFullYear()),
      MM: pad(d.getMonth() + 1),
      DD: pad(d.getDate()),
      HH: pad(d.getHours()),
      mm: pad(d.getMinutes()),
      ss: pad(d.getSeconds()),
    };
    return fmt.replace(TOKEN_RE, (t) => parts[t]);
  }

  // Replace {{date}}, {{time}}, {{title}} (+ {{date:FMT}}, {{time:FMT}}).
  // `\{{x}}` stays literal (without the backslash); unknown names stay as typed.
  function fill(text, { title = '', now = new Date() } = {}) {
    const name = String(title || '').trim() || 'Untitled';
    const d = now instanceof Date ? now : new Date(now);
    return String(text == null ? '' : text).replace(
      /(\\?)\{\{\s*(date|time|title)(?::([^{}\n]{1,32}))?\s*\}\}/g,
      (whole, slash, key, fmt) => {
        if (slash) return whole.slice(1);
        if (key === 'title') return fmt === undefined ? name : whole;
        const f = fmt === undefined ? (key === 'date' ? DATE_DEFAULT : TIME_DEFAULT) : fmt;
        return formatDate(d, f);
      },
    );
  }

  // Accepts a store item ({ uuid, content }) or its content.
  const contentOf = (item) => (item && item.content && typeof item.content === 'object' ? item.content : item);
  const isLegacy = (c) => !!c && c.type === 'note' && !!c.is_template;
  const isTemplate = (item) => {
    const c = contentOf(item);
    return !!c && (c.type === TYPE || isLegacy(c));
  };
  // Template text: `body` on the template type and built-ins, `content` on legacy notes.
  const bodyOf = (c) => String((c && (c.type === TYPE || c.body != null) ? c.body : c && c.content) ?? '');
  // Protected legacy notes keep their gate: no text preview or editing here.
  const isProtected = (c) => !!(c && (c.locked || c.prevent_edit));

  const BUILTINS = [
    {
      id: 'builtin:meeting',
      title: 'Meeting note',
      template_title: '{{title}} – {{date}}',
      body: '# {{title}}\n\nDate: {{date}} {{time}}\nAttendees:\n\n## Agenda\n- \n\n## Notes\n\n## Action items\n- [ ] \n',
    },
    {
      id: 'builtin:journal',
      title: 'Journal',
      template_title: 'Journal {{date}}',
      body: '# {{date}}\n\n## How do I feel?\n\n## What happened today?\n\n## Grateful for\n- \n',
    },
    {
      id: 'builtin:task',
      title: 'Task',
      template_title: '{{title}}',
      body: '# {{title}}\n\nCreated: {{date}} {{time}}\nDue: \n\n## Steps\n- [ ] \n\n## Done when\n',
    },
  ];

  // Content for "Save as template". Protected notes are refused: copying
  // them would drop the protection and expose the text without the gate.
  function templateFromNote(source) {
    if (!source || source.type !== 'note') return { error: 'missing' };
    if (source.locked) return { error: 'locked' };
    const now = new Date().toISOString();
    return {
      content: {
        type: TYPE,
        title: String(source.title || '').trim() || 'Untitled template',
        body: source.content || '',
        template_title: source.template_title || '{{title}}',
        tags: [...(source.tags || [])],
        folder_id: source.folder_id || '',
        editor: source.editor || 'plain',
        created_at: now,
        updated_at: now,
      },
    };
  }

  // Legacy `is_template` note -> template item content, or null when it must
  // stay a note: trashed (the user deleted it), protected (converting would
  // drop the gate) or with attachments (they belong to a note).
  function fromLegacy(c, { hasAttachments = false } = {}) {
    if (!isLegacy(c) || c.trashed || isProtected(c) || hasAttachments) return null;
    return {
      type: TYPE,
      title: String(c.title || '').trim() || 'Untitled template',
      body: c.content || '',
      template_title: c.template_title || '{{title}}',
      tags: [...(c.tags || [])],
      folder_id: c.folder_id || '',
      editor: c.editor || 'plain',
      created_at: c.created_at || c.updated_at || new Date().toISOString(),
      updated_at: c.updated_at || new Date().toISOString(),
    };
  }

  // Content for "New from template" (spec 2.2): copy text, labels, folder and
  // editor; clear flags, revisions and attachments; fresh timestamps.
  function noteFromTemplate(tpl, { title = '', now = new Date(), base = {}, tagExists } = {}) {
    const vars = { title, now };
    const iso = (now instanceof Date ? now : new Date(now)).toISOString();
    const pattern = tpl.template_title || '{{title}}';
    const tags = (tpl.tags || []).filter((id) => !tagExists || tagExists(id));
    const out = {
      ...base,
      title: fill(pattern, vars).trim() || 'Untitled',
      title_manual: true,
      content: fill(bodyOf(tpl), vars),
      tags,
      folder_id: tpl.folder_id || '',
      editor: tpl.editor || base.editor || 'plain',
      is_template: false,
      pinned: false,
      starred: false,
      locked: false,
      revisions: [],
      attachments: [],
      created_at: iso,
      updated_at: iso,
    };
    delete out.template_title;
    delete out.ocr_text;
    return out;
  }

  // Store-level actions; `store` is NotesStore or a compatible stub.
  function saveAsTemplate(store, noteId) {
    const note = store.get(noteId);
    const made = templateFromNote(note?.content);
    if (made.error) return made;
    const id = store.newUuid();
    store.upsert(id, made.content);
    return { id };
  }

  // Template items plus legacy template notes that are not (yet) converted.
  function listTemplates(store) {
    const legacy = store.listNotes().filter((n) => isLegacy(n.content) && !n.content.trashed);
    return [...store.listTemplateItems(), ...legacy]
      .sort((a, b) => String(a.content.title || '').localeCompare(String(b.content.title || '')));
  }

  function liveTemplate(store, id) {
    const item = store.get(id);
    if (!item || item.deleted || !isTemplate(item) || item.content.trashed) return null;
    return item;
  }

  // Rename a template, and change its text when `body` is given. Empty names are refused.
  function updateTemplate(store, id, { title, body } = {}) {
    const item = liveTemplate(store, id);
    if (!item) return { error: 'missing' };
    const name = String(title ?? '').trim();
    if (!name) return { error: 'empty' };
    const next = { ...item.content, title: name };
    if (body !== undefined && !isProtected(item.content)) {
      if (isLegacy(item.content)) next.content = String(body);
      else next.body = String(body);
    }
    store.upsert(id, next);
    return { ok: true };
  }

  // A template item is deleted with a synced tombstone. A legacy template note
  // goes to Trash, as it did before, so it can still be restored there.
  function deleteTemplate(store, id) {
    const item = liveTemplate(store, id);
    if (!item) return { error: 'missing' };
    if (isLegacy(item.content)) {
      store.upsert(id, { ...item.content, trashed: true });
      return { ok: true, trashed: true };
    }
    return store.remove(id) ? { ok: true, trashed: false } : { error: 'failed' };
  }

  // Convert legacy template notes to the template type in place (same uuid,
  // same text). Idempotent; returns the number converted.
  function migrateLegacy(store) {
    let count = 0;
    for (const note of store.listNotes()) {
      const next = fromLegacy(note.content, { hasAttachments: store.noteHasAttachments(note.uuid) });
      if (!next) continue;
      store.replaceWithTemplate(note.uuid, next);
      count += 1;
    }
    return count;
  }

  function createFromTemplate(store, ref, { title, now } = {}) {
    const builtin = BUILTINS.find((b) => b.id === ref);
    const tpl = builtin || liveTemplate(store, ref)?.content;
    if (!tpl) return null;
    const id = store.newUuid();
    store.upsert(id, noteFromTemplate(tpl, {
      title,
      now,
      base: store.defaultNote(),
      tagExists: (tagId) => !!store.get(tagId) && !store.get(tagId).deleted,
    }));
    return id;
  }

  // "New from template" dialog state: one list (user templates, then
  // built-ins), arrow keys move, Enter creates, Escape closes. The host
  // renders `html()` and forwards events; nothing here touches the DOM.
  function createDialog({ store, onCreate, onClose, onManage, now, selectId }) {
    const items = [
      ...listTemplates(store).map((n) => ({
        id: n.uuid,
        title: n.content.title || 'Untitled template',
        builtin: false,
        content: isProtected(n.content) ? '' : bodyOf(n.content),
      })),
      ...BUILTINS.map((b) => ({ id: b.id, title: b.title, builtin: true, content: b.body })),
    ];
    const s = { open: true, index: Math.max(0, items.findIndex((it) => it.id === selectId)), title: '', items };
    const api = {
      state: s,
      selected: () => items[s.index] || null,
      select(i) {
        if (!items.length) return;
        s.index = Math.max(0, Math.min(items.length - 1, i));
      },
      setTitle(v) { s.title = String(v || ''); },
      close() {
        if (!s.open) return;
        s.open = false;
        onClose?.();
      },
      manage() {
        api.close();
        onManage?.();
      },
      confirm() {
        const item = api.selected();
        if (!s.open || !item) return null;
        const id = createFromTemplate(store, item.id, { title: s.title, now: now ? now() : new Date() });
        s.open = false;
        onCreate?.(id);
        onClose?.();
        return id;
      },
      // Returns true when the key was handled (host then preventDefaults).
      keydown(key) {
        if (key === 'Escape') { api.close(); return true; }
        if (key === 'ArrowDown') { api.select(s.index + 1); return true; }
        if (key === 'ArrowUp') { api.select(s.index - 1); return true; }
        if (key === 'Home') { api.select(0); return true; }
        if (key === 'End') { api.select(items.length - 1); return true; }
        if (key === 'Enter') { api.confirm(); return true; }
        return false;
      },
      preview() {
        const item = api.selected();
        return item ? fill(item.content, { title: s.title, now: now ? now() : new Date() }) : '';
      },
      html() {
        const row = (it, i) => `<li role="option" id="tpl-opt-${i}" class="tpl-option${i === s.index ? ' active' : ''}" data-tpl-index="${i}" aria-selected="${i === s.index}">`
          + `<span class="tpl-name">${esc(it.title)}</span>${it.builtin ? '<span class="tpl-badge">Built-in</span>' : ''}</li>`;
        const empty = items.some((it) => !it.builtin) ? ''
          : '<p class="tpl-hint">No templates of your own yet. Open a note and choose “Save as template”. '
            + 'Rename or delete your templates with “Manage templates”.</p>';
        return `<ul class="tpl-list" role="listbox" aria-label="Templates" tabindex="0" aria-activedescendant="tpl-opt-${s.index}">${items.map(row).join('')}</ul>${empty}`
          + `<pre class="tpl-preview" aria-label="Preview">${esc(api.preview())}</pre>`;
      },
    };
    return api;
  }

  const PREVIEW_CHARS = 160;
  // Markup for the "Manage templates" list. The row of `editingId` is a form
  // (name, and text unless protected). Event handling lives in app.js.
  function managerHtml(items, { editingId = '' } = {}) {
    if (!items.length) {
      return '<p class="tpl-hint">No templates yet. Open a note and choose “Save as template” in its ⋯ menu.</p>';
    }
    const row = (n, i) => {
      const c = n.content;
      const id = esc(n.uuid);
      const name = esc(c.title || 'Untitled template');
      const locked = isProtected(c);
      const nameId = `tpl-manage-name-${i}`;
      if (n.uuid === editingId) {
        const text = locked ? ''
          : `<label class="template-dialog-field">Text <textarea name="body" rows="6" spellcheck="false">${esc(bodyOf(c))}</textarea></label>`;
        return `<li class="tpl-manage-row editing" data-tpl-id="${id}"><form class="tpl-manage-form" data-tpl-form="${id}" aria-label="Edit template">`
          + `<label class="template-dialog-field">Name <input type="text" name="name" value="${name}" maxlength="200" autocomplete="off"></label>`
          + text
          + '<p class="tpl-hint tpl-manage-error" role="alert"></p>'
          + '<div class="template-dialog-actions"><button type="button" class="btn ghost sm" data-tpl-action="cancel">Cancel</button>'
          + '<button type="submit" class="btn primary sm">Save</button></div></form></li>';
      }
      const body = bodyOf(c);
      const short = body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body;
      const preview = locked ? '<p class="tpl-hint">Protected note: text hidden.</p>'
        : `<pre class="tpl-preview tpl-manage-preview">${esc(short) || '(empty)'}</pre>`;
      const btn = (action, label) => `<button type="button" class="btn ghost sm" data-tpl-action="${action}" aria-describedby="${nameId}">${label}</button>`;
      return `<li class="tpl-manage-row" data-tpl-id="${id}"><div class="tpl-manage-head"><span class="tpl-name" id="${nameId}">${name}</span>`
        + `<span class="tpl-manage-actions">${btn('use', 'Use')}${btn('edit', 'Rename')}${btn('delete', 'Delete')}</span></div>${preview}</li>`;
    };
    return `<ul class="tpl-manage-list" aria-label="Your templates">${items.map(row).join('')}</ul>`;
  }

  const api = {
    TYPE,
    fill,
    formatDate,
    isTemplate,
    bodyOf,
    BUILTINS,
    templateFromNote,
    fromLegacy,
    noteFromTemplate,
    saveAsTemplate,
    listTemplates,
    updateTemplate,
    deleteTemplate,
    migrateLegacy,
    createFromTemplate,
    createDialog,
    managerHtml,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.NotesTemplates = api;
})();
