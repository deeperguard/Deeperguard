// Note templates (docs/NOTES_ORGANIZATION_SPEC.md section 2).
// A template is a normal note with `is_template: true` inside the encrypted
// payload, so the server never sees the flag or the text. Variables are
// filled here, client-side, in the local time zone, as plain text.
(() => {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const pad = (n) => String(n).padStart(2, '0');

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

  const isTemplate = (note) => !!(note && (note.content || note).is_template);

  const BUILTINS = [
    {
      id: 'builtin:meeting',
      title: 'Meeting note',
      template_title: '{{title}} – {{date}}',
      content: '# {{title}}\n\nDate: {{date}} {{time}}\nAttendees:\n\n## Agenda\n- \n\n## Notes\n\n## Action items\n- [ ] \n',
    },
    {
      id: 'builtin:journal',
      title: 'Journal',
      template_title: 'Journal {{date}}',
      content: '# {{date}}\n\n## How do I feel?\n\n## What happened today?\n\n## Grateful for\n- \n',
    },
    {
      id: 'builtin:task',
      title: 'Task',
      template_title: '{{title}}',
      content: '# {{title}}\n\nCreated: {{date}} {{time}}\nDue: \n\n## Steps\n- [ ] \n\n## Done when\n',
    },
  ];

  // Content for "Save as template". Protected notes are refused: copying
  // them would drop the protection and expose the text without the gate.
  function templateFromNote(source, base) {
    if (!source || source.type !== 'note') return { error: 'missing' };
    if (source.locked) return { error: 'locked' };
    const now = new Date().toISOString();
    return {
      content: {
        ...base,
        title: source.title || 'Untitled template',
        title_manual: true,
        content: source.content || '',
        tags: [...(source.tags || [])],
        folder_id: source.folder_id || '',
        editor: source.editor || 'plain',
        is_template: true,
        template_title: source.template_title || '{{title}}',
        created_at: now,
        updated_at: now,
      },
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
      content: fill(tpl.content || '', vars),
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
    const made = templateFromNote(note?.content, store.defaultNote());
    if (made.error) return made;
    const id = store.newUuid();
    store.upsert(id, made.content);
    return { id };
  }

  function listTemplates(store) {
    return store.listNotes()
      .filter((n) => isTemplate(n) && !n.content.trashed)
      .sort((a, b) => String(a.content.title || '').localeCompare(String(b.content.title || '')));
  }

  function createFromTemplate(store, ref, { title, now } = {}) {
    const builtin = BUILTINS.find((b) => b.id === ref);
    const tpl = builtin || store.get(ref)?.content;
    if (!tpl || (!builtin && !tpl.is_template)) return null;
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
  function createDialog({ store, onCreate, onClose, onManage, now }) {
    const items = [
      ...listTemplates(store).map((n) => ({ id: n.uuid, title: n.content.title || 'Untitled template', builtin: false, content: n.content.content || '' })),
      ...BUILTINS.map((b) => ({ id: b.id, title: b.title, builtin: true, content: b.content })),
    ];
    const s = { open: true, index: 0, title: '', items };
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
            + 'Manage templates under Views → Templates: open one to rename or edit it, or move it to Trash to delete it.</p>';
        return `<ul class="tpl-list" role="listbox" aria-label="Templates" tabindex="0" aria-activedescendant="tpl-opt-${s.index}">${items.map(row).join('')}</ul>${empty}`
          + `<pre class="tpl-preview" aria-label="Preview">${esc(api.preview())}</pre>`;
      },
    };
    return api;
  }

  const api = {
    fill,
    formatDate,
    isTemplate,
    BUILTINS,
    templateFromNote,
    noteFromTemplate,
    saveAsTemplate,
    listTemplates,
    createFromTemplate,
    createDialog,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.NotesTemplates = api;
})();
