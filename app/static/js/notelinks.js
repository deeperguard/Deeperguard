/**
 * ID-based note links (docs/NOTES_ORGANIZATION_SPEC.md section 3).
 *
 * Stored form inside the encrypted note text: [Title](dg-note:<uuid>).
 * Everything here is client-side: the picker searches already-decrypted titles
 * in memory and never touches the network. Link text and titles are untrusted
 * and are only ever escaped text, never HTML.
 */
const NotesLinks = (() => {
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const UUID_RE = new RegExp(`^${UUID}$`, 'i');
  const LINK_SRC = `\\[([^\\]\\n]*)\\]\\(dg-note:(${UUID})\\)`;
  const MAX_RESULTS = 8;

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isValidId(id) {
    return UUID_RE.test(String(id || ''));
  }

  // Link text must not break out of [...]: drop brackets and newlines.
  function cleanLabel(title) {
    return String(title || '').replace(/[\[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
  }

  function buildLink(uuid, title) {
    if (!isValidId(uuid)) return '';
    return `[${cleanLabel(title)}](dg-note:${String(uuid).toLowerCase()})`;
  }

  // Spans of fenced and inline code, where links are ignored.
  function codeRanges(text) {
    const ranges = [];
    const re = /```[\s\S]*?```|`[^`\n]+`/g;
    let m = re.exec(text);
    while (m) {
      ranges.push([m.index, m.index + m[0].length]);
      m = re.exec(text);
    }
    return ranges;
  }

  function inRanges(ranges, i) {
    return ranges.some(([a, b]) => i >= a && i < b);
  }

  /** All stored links outside code: [{start,end,label,uuid}]. */
  function findLinks(text) {
    const src = String(text || '');
    const ranges = codeRanges(src);
    const out = [];
    const re = new RegExp(LINK_SRC, 'gi');
    let m = re.exec(src);
    while (m) {
      if (!inRanges(ranges, m.index)) {
        out.push({ start: m.index, end: m.index + m[0].length, label: m[1], uuid: m[2].toLowerCase() });
      }
      m = re.exec(src);
    }
    return out;
  }

  /**
   * Open `[[query` directly before the caret (same line, no `]]` yet).
   * Returns {start, end, query} or null.
   */
  function findTrigger(value, caret) {
    const text = String(value || '');
    const pos = typeof caret === 'number' ? caret : text.length;
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const before = text.slice(lineStart, pos);
    const open = before.lastIndexOf('[[');
    if (open < 0) return null;
    const query = before.slice(open + 2);
    if (/[\]\[]/.test(query) || query.length > 80) return null;
    const start = lineStart + open;
    if (inRanges(codeRanges(text), start)) return null;
    let end = pos;
    if (text.slice(pos, pos + 2) === ']]') end = pos + 2; // auto-closed brackets
    return { start, end, query };
  }

  /** Client-side title search over in-memory notes. */
  function searchNotes(notes, query, { excludeId = '', limit = MAX_RESULTS } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const scored = [];
    for (const n of notes || []) {
      if (!n || n.uuid === excludeId || n.trashed || n.is_template) continue;
      const title = String(n.title || '').trim() || 'Untitled';
      const t = title.toLowerCase();
      let score;
      if (!q) score = 3;
      else if (t === q) score = 0;
      else if (t.startsWith(q)) score = 1;
      else if (t.includes(q)) score = 2;
      else continue;
      scored.push({ uuid: n.uuid, title, score, updated: n.updated_at || '' });
    }
    scored.sort((a, b) => a.score - b.score || (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0)
      || a.title.localeCompare(b.title));
    return scored.slice(0, limit);
  }

  /** Replace the open `[[query` span by the stored link. */
  function applyChoice(value, trigger, note) {
    const text = String(value || '');
    const link = buildLink(note.uuid, note.title);
    return { value: text.slice(0, trigger.start) + link + text.slice(trigger.end), caret: trigger.start + link.length };
  }

  /**
   * Resolve a target. `lookup(uuid)` returns {title, trashed, deleted} or
   * undefined. Never asks the server.
   */
  function resolve(uuid, lookup) {
    const n = lookup ? lookup(uuid) : null;
    if (!n || n.deleted) return { state: 'missing', title: '' };
    if (n.trashed) return { state: 'trashed', title: String(n.title || '') };
    return { state: 'ok', title: String(n.title || '').trim() || 'Untitled' };
  }

  function anchorHtml(link, info) {
    const id = escapeHtml(link.uuid);
    if (info.state === 'ok') {
      const shown = escapeHtml(info.title);
      return `<a href="#note/${id}" class="note-link" data-dg-note="${id}">${shown}</a>`;
    }
    const text = escapeHtml(cleanLabel(link.label));
    const label = escapeHtml(`Link to missing note: ${cleanLabel(link.label)}`);
    const why = info.state === 'trashed' ? 'in the trash' : 'deleted or not in your vault';
    return `<a href="#note/${id}" class="note-link note-link-dead" data-dg-note="${id}" data-dead="${info.state}" role="button" aria-label="${label}">`
      + `<span aria-hidden="true">⚠ </span>${text}<span class="note-link-dead-tag"> (note ${why})</span></a>`;
  }

  /**
   * Swap stored links for placeholders before the normal renderer runs.
   * Returns {text, restore(html)}; restore puts safe anchors back.
   */
  function prepareRender(text, lookup) {
    const src = String(text || '');
    const links = findLinks(src);
    if (!links.length) return { text: src, restore: (html) => html };
    let out = '';
    let last = 0;
    links.forEach((l, i) => {
      out += `${src.slice(last, l.start)}@@NOTELINK${i}@@`;
      last = l.end;
    });
    out += src.slice(last);
    return {
      text: out,
      restore: (html) => String(html).replace(/@@NOTELINK(\d+)@@/g, (full, i) => {
        const l = links[Number(i)];
        return l ? anchorHtml(l, resolve(l.uuid, lookup)) : full;
      }),
    };
  }

  function removeLink(text, uuid) {
    const id = String(uuid || '').toLowerCase();
    return findLinks(text).filter((l) => l.uuid === id).reduceRight(
      (acc, l) => acc.slice(0, l.start) + l.label + acc.slice(l.end), String(text || ''),
    );
  }

  function relinkLink(text, oldUuid, note) {
    const id = String(oldUuid || '').toLowerCase();
    return findLinks(text).filter((l) => l.uuid === id).reduceRight(
      (acc, l) => acc.slice(0, l.start) + buildLink(note.uuid, l.label) + acc.slice(l.end), String(text || ''),
    );
  }

  /**
   * ARIA 1.2 combobox + listbox attached to a textarea. `getNotes()` returns
   * [{uuid,title,updated_at,trashed}]; `onChoose(note, trigger)` is called on pick.
   */
  function attachPicker({ textarea, doc, getNotes, getExcludeId, onChoose }) {
    const document_ = doc || (typeof document !== 'undefined' ? document : null);
    const list = document_.createElement('ul');
    list.id = `note-link-picker-${Math.random().toString(36).slice(2, 8)}`;
    list.className = 'note-link-picker';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Link to note');
    list.hidden = true;
    textarea.setAttribute('role', 'combobox');
    textarea.setAttribute('aria-autocomplete', 'list');
    textarea.setAttribute('aria-haspopup', 'listbox');
    textarea.setAttribute('aria-controls', list.id);
    textarea.setAttribute('aria-expanded', 'false');
    if (textarea.parentNode) textarea.parentNode.appendChild(list);
    const state = { open: false, results: [], index: 0, trigger: null };

    function close() {
      state.open = false;
      state.trigger = null;
      list.hidden = true;
      list.textContent = '';
      textarea.setAttribute('aria-expanded', 'false');
      textarea.removeAttribute('aria-activedescendant');
    }

    function paint() {
      list.textContent = '';
      if (!state.results.length) {
        const empty = document_.createElement('li');
        empty.className = 'note-link-picker-empty';
        empty.setAttribute('role', 'option');
        empty.setAttribute('aria-disabled', 'true');
        empty.textContent = 'No matching notes';
        list.appendChild(empty);
      }
      state.results.forEach((r, i) => {
        const li = document_.createElement('li');
        li.id = `${list.id}-opt-${i}`;
        li.className = 'note-link-picker-option';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === state.index ? 'true' : 'false');
        li.textContent = r.title; // text only, never HTML
        li.addEventListener('mousedown', (ev) => {
          if (ev.preventDefault) ev.preventDefault();
          choose(i);
        });
        list.appendChild(li);
      });
      if (state.results.length) textarea.setAttribute('aria-activedescendant', `${list.id}-opt-${state.index}`);
      else textarea.removeAttribute('aria-activedescendant');
    }

    function choose(i) {
      const r = state.results[i];
      const trigger = state.trigger;
      if (!r || !trigger) return;
      close();
      onChoose(r, trigger);
    }

    function update() {
      const trigger = findTrigger(textarea.value, textarea.selectionStart);
      if (!trigger) { close(); return; }
      state.trigger = trigger;
      state.results = searchNotes(getNotes(), trigger.query, { excludeId: getExcludeId ? getExcludeId() : '' });
      state.index = Math.min(state.index, Math.max(0, state.results.length - 1));
      state.open = true;
      list.hidden = false;
      textarea.setAttribute('aria-expanded', 'true');
      paint();
    }

    textarea.addEventListener('input', () => { state.index = 0; update(); });
    textarea.addEventListener('click', update);
    textarea.addEventListener('blur', () => close());
    textarea.addEventListener('keydown', (ev) => {
      if (!state.open) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!state.results.length) return;
        ev.preventDefault();
        const n = state.results.length;
        state.index = (state.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
        paint();
      } else if (ev.key === 'Enter' || ev.key === 'Tab') {
        if (!state.results.length) return;
        ev.preventDefault();
        choose(state.index);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        close();
      }
    });
    return { close, update, element: list, state };
  }

  const api = {
    isValidId, buildLink, findLinks, findTrigger, searchNotes, applyChoice, resolve,
    prepareRender, removeLink, relinkLink, attachPicker, escapeHtml,
  };
  if (typeof window !== 'undefined') window.NotesLinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
