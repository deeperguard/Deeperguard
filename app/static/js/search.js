const NotesSearch = (() => {
  const searchBlobs = new Map();

  function normalize(text) {
    return (text || '').toLowerCase().trim();
  }

  const SEARCH_BLOB_BODY_MAX = 8192;

  function buildSearchBlob(note, tagMap) {
    if (!note || !note.content || note.content.type !== 'note') return '';
    // Locked notes stay findable by title only — body/OCR/filenames must not leak.
    if (note.content.locked) return normalize(note.content.title || '');
    let body = String(note.content.content || '');
    if (looksLikeSpreadsheetPayload(body) && body.length > SEARCH_BLOB_BODY_MAX) {
      body = body.slice(0, SEARCH_BLOB_BODY_MAX);
    }
    const parts = [
      effectiveNoteTitle(note),
      body,
      note.content.ocr_text || '',
      note.content.attachment_names || '',
    ];
    for (const tagId of note.content.tags || []) {
      const tag = tagMap.get(tagId);
      if (tag) parts.push(tag.content.title || '');
    }
    return normalize(parts.join('\n'));
  }

  function indexNote(note, tagMap) {
    if (!note || note.deleted) {
      searchBlobs.delete(note?.uuid);
      return;
    }
    if (note.content?.type !== 'note') return;
    searchBlobs.set(note.uuid, buildSearchBlob(note, tagMap));
  }

  function indexNotes(notes, tagMap) {
    searchBlobs.clear();
    for (const note of notes) indexNote(note, tagMap);
  }

  function removeFromIndex(uuid) {
    searchBlobs.delete(uuid);
  }

  function indexedMatch(uuid, query) {
    const blob = searchBlobs.get(uuid);
    if (!blob) return null;
    const q = normalize(query);
    if (!q) return true;
    return blob.includes(q);
  }

  function snippetAround(text, query, width = 42) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    const q = normalize(query);
    const at = normalize(source).indexOf(q);
    if (at < 0) return '';
    const start = Math.max(0, at - width);
    const end = Math.min(source.length, at + query.length + width);
    return `${start ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
  }

  function matchesNoteOrFileName(note, query, { includeFileNames = true } = {}) {
    const q = normalize(query);
    if (!q) return false;
    const title = effectiveNoteTitle(note);
    if (normalize(title).includes(q)) return true;
    if (!includeFileNames || note.content?.locked) return false;
    const files = note.content?.attachment_names || '';
    return normalize(files).includes(q);
  }

  function describeMatch(note, query, tagMap, { titlesOnly = false } = {}) {
    if (!query) return null;
    const q = normalize(query);
    const title = effectiveNoteTitle(note);
    if (normalize(title).includes(q)) return { field: 'title', label: 'Title', snippet: title };
    const files = note.content.attachment_names || '';
    if (!note.content?.locked && normalize(files).includes(q)) {
      return { field: 'file', label: 'Filename', snippet: snippetAround(files, query, 56) || files };
    }
    if (titlesOnly || note.content?.locked) return null;
    const body = note.content.content || '';
    if (normalize(body).includes(q)) return { field: 'body', label: 'Note', snippet: snippetAround(body, query) };
    const ocr = note.content.ocr_text || '';
    if (normalize(ocr).includes(q)) return { field: 'ocr', label: 'Scanned document', snippet: snippetAround(ocr, query) };
    for (const tagId of note.content.tags || []) {
      const tag = tagMap.get(tagId);
      if (tag && normalize(tag.content.title).includes(q)) {
        return { field: 'tag', label: 'Tag', snippet: tag.content.title };
      }
    }
    return null;
  }

  function matches(note, query, tagMap, options = {}) {
    if (!query) return true;
    if (options.titlesOnly) {
      return matchesNoteOrFileName(note, query, { includeFileNames: true });
    }
    if (note.content?.locked) {
      return matchesNoteOrFileName(note, query, { includeFileNames: false });
    }
    const indexed = indexedMatch(note.uuid, query);
    if (indexed === true) return true;
    if (describeMatch(note, query, tagMap, options)) return true;
    return false;
  }

  function parseNoteTime(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw > 1e12 ? raw : raw * 1000;
    }
    const text = String(raw || '').trim();
    if (/^\d+(\.\d+)?$/.test(text)) {
      const num = Number(text);
      return num > 1e12 ? num : num * 1000;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /** Last modified time (ms), newest-first lists — prefers content.updated_at, then sync row updated_at. */
  function updatedStamp(note) {
    const edited = parseNoteTime(note?.content?.updated_at);
    const item = parseNoteTime(note?.updated_at);
    const best = Math.max(edited, item);
    if (best > 0) return best;
    return parseNoteTime(note?.content?.created_at);
  }

  /** Creation time (ms) for sort-by-created. */
  function createdStamp(note) {
    const created = parseNoteTime(note?.content?.created_at);
    if (created > 0) return created;
    return updatedStamp(note);
  }

  function editedStamp(note) {
    return updatedStamp(note);
  }

  function noteIsPinned(note) {
    const c = note?.content || {};
    return !!(c.pinned || c.starred);
  }

  function partitionPinnedNotes(notes) {
    const pinned = [];
    const rest = [];
    for (const note of notes || []) {
      if (noteIsPinned(note)) pinned.push(note);
      else rest.push(note);
    }
    return { pinned, rest };
  }

  function derivedTitleFromBody(text) {
    const line = String(text || '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) || '';
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    if (collapsed.length <= 60) return collapsed;
    return `${collapsed.slice(0, 59).trimEnd()}…`;
  }

  function safeParseJson(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('{')) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof RangeError) return null;
      return null;
    }
  }

  function looksLikeSpreadsheetJson(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('{') || raw.length < 12) return false;
    const data = safeParseJson(raw);
    return !!(data && (data.activeSheet || (Array.isArray(data.sheets) && data.sheets.length)));
  }

  function looksLikeSpreadsheetPayload(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('{')) return false;
    if (looksLikeSpreadsheetJson(raw)) return true;
    return /"activeSheet"\s*:/.test(raw) || /"sheets"\s*:\s*\[/.test(raw.slice(0, 240));
  }

  function isPlaceholderTitle(text) {
    const value = String(text || '').trim();
    return !value || value === 'Untitled' || value === 'Title';
  }

  function fallbackSpreadsheetTitle(text, note) {
    if (looksLikeSpreadsheetJson(text)) {
      const parsed = titleFromSpreadsheetJson(text);
      if (parsed && parsed !== 'Spreadsheet') return parsed;
    }
    const when = parseNoteTime(note?.content?.updated_at) || parseNoteTime(note?.content?.created_at);
    if (when > 0) {
      const label = new Date(when).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `Spreadsheet · ${label}`;
    }
    return 'Spreadsheet';
  }

  function spreadsheetCellText(cell) {
    if (cell == null) return '';
    if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
      return String(cell).trim();
    }
    if (typeof cell === 'object') {
      if (cell.value != null) return String(cell.value).trim();
      if (cell.v != null) return String(cell.v).trim();
    }
    return '';
  }

  function titleFromSpreadsheetJson(text) {
    try {
      const data = safeParseJson(text);
      if (!data) return 'Spreadsheet';
      const sheetName = data.activeSheet || data.sheets?.[0]?.name || '';
      const sheet = (data.sheets || []).find((s) => s.name === data.activeSheet) || data.sheets?.[0];
      const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
      let firstCell = '';
      for (const row of rows) {
        if (Array.isArray(row)) {
          for (const cell of row) {
            const part = spreadsheetCellText(cell);
            if (part) {
              firstCell = part;
              break;
            }
          }
        } else if (row && Array.isArray(row.cells)) {
          for (const cell of row.cells) {
            const part = spreadsheetCellText(cell);
            if (part) {
              firstCell = part;
              break;
            }
          }
        }
        if (firstCell) break;
      }
      if (sheetName && firstCell) {
        const cell = firstCell.length > 48 ? `${firstCell.slice(0, 47).trimEnd()}…` : firstCell;
        return `${sheetName}: ${cell}`;
      }
      if (sheetName) return String(sheetName);
      if (firstCell) {
        return firstCell.length > 60 ? `${firstCell.slice(0, 59).trimEnd()}…` : firstCell;
      }
    } catch (_) { /* ignore */ }
    return 'Spreadsheet';
  }

  function isActiveLibraryNote(content) {
    return !!(content && !content.trashed && !content.archived);
  }

  function countLibraryNotes(notes) {
    return (notes || []).filter((n) => isActiveLibraryNote(n.content)).length;
  }

  function effectiveNoteTitle(note) {
    const stored = String(note?.content?.title || '').trim();
    const manual = !!note?.content?.title_manual;
    if (looksLikeSpreadsheetPayload(stored)) {
      return fallbackSpreadsheetTitle(stored, note);
    }
    if (note?.content?.locked || manual) {
      if (isPlaceholderTitle(stored)) return '';
      return stored;
    }
    if (!isPlaceholderTitle(stored)) return stored;
    const body = String(note?.content?.content || '').trim();
    if (looksLikeSpreadsheetPayload(body)) {
      return fallbackSpreadsheetTitle(body, note);
    }
    return derivedTitleFromBody(note?.content?.content);
  }

  function noteIsEmptyStub(note) {
    if (!note?.content || note.content.type !== 'note') return false;
    if (note.content.trashed || note.content.archived) return false;
    if (note.content.locked) return false;
    if (String(note.content.content || '').trim()) return false;
    if (String(note.content.ocr_text || '').trim()) return false;
    if ((note.content.attachments || []).length) return false;
    if ((note.content.tags || []).length) return false;
    const stored = String(note.content.title || '').trim();
    if (stored && !isPlaceholderTitle(stored)) return false;
    return true;
  }

  function compareNotesForSort(a, b, sort) {
    const aPinned = noteIsPinned(a);
    const bPinned = noteIsPinned(b);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (sort === 'title') {
      return effectiveNoteTitle(a).localeCompare(effectiveNoteTitle(b));
    }
    if (sort === 'created') {
      return createdStamp(b) - createdStamp(a);
    }
    return updatedStamp(b) - updatedStamp(a);
  }

  function listUsesDateSections(sort) {
    return sort === 'updated' || sort === 'created';
  }

  function defaultSearchOptions(raw = {}) {
    return {
      titlesOnly: !!raw.titlesOnly,
      includeArchived: !!raw.includeArchived,
      includeTrashed: !!raw.includeTrashed,
      includeProtected: !!raw.includeProtected,
      tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.filter(Boolean) : [],
    };
  }

  function searchContextActive(query, opts) {
    return !!String(query || '').trim()
      || opts.titlesOnly
      || opts.includeArchived
      || opts.includeTrashed
      || opts.includeProtected
      || opts.tagIds.length > 0;
  }

  function countActiveSearchFilters(opts) {
    let count = 0;
    if (opts.titlesOnly) count += 1;
    if (opts.includeArchived) count += 1;
    if (opts.includeTrashed) count += 1;
    if (opts.includeProtected) count += 1;
    if (opts.tagIds.length) count += opts.tagIds.length;
    return count;
  }

  function noteIsProtected(content) {
    return !!(content?.locked || content?.prevent_edit);
  }

  function filterNotes(notes, { query, filter, tagId, folderId, tagMap, sort, searchOptions = {} }) {
    const opts = defaultSearchOptions(searchOptions);
    const q = String(query || '').trim();
    const context = searchContextActive(q, opts);
    let out;
    try {
      out = notes
      .filter((n) => {
        const c = n.content;

        if (c.trashed) {
          if (filter === 'trash') {
            /* keep */
          } else if (context && opts.includeTrashed) {
            /* keep trashed notes in other views while filtering */
          } else {
            return false;
          }
        } else if (filter === 'trash') {
          return false;
        }

        if (c.archived) {
          if (filter === 'archived') {
            /* keep */
          } else if (context && opts.includeArchived) {
            /* keep archived notes in other views while filtering */
          } else if (filter === 'all' || filter === 'pinned' || filter === 'untagged' || filter === 'documents') {
            return false;
          }
        } else if (filter === 'archived') {
          return false;
        }

        if (filter === 'pinned' && !noteIsPinned(n)) return false;
        if (filter === 'all' && !context && (c.archived || c.trashed)) return false;
        if (filter === 'untagged') {
          if (c.archived || c.trashed) return false;
          if ((c.tags || []).length) return false;
        }
        if (filter === 'documents') {
          if (c.archived || c.trashed) return false;
          // Files view is stored attachments only — not OCR text or note bodies.
          if (!(c.attachments || []).length) return false;
        }

        if (tagId && tagId !== '__untagged__' && !(c.tags || []).includes(tagId)) return false;
        if (folderId && c.folder_id !== folderId) return false;
        if (opts.tagIds.length) {
          const noteTags = c.tags || [];
          if (!opts.tagIds.some((id) => noteTags.includes(id))) return false;
        }

        if (context && !opts.includeProtected && noteIsProtected(c)) {
          if (!q) return false;
          const includeFiles = !c.locked;
          return matchesNoteOrFileName(n, q, { includeFileNames: includeFiles });
        }

        return matches(n, q, tagMap, { titlesOnly: opts.titlesOnly });
      })
      .sort((a, b) => compareNotesForSort(a, b, sort));
    } catch (err) {
      if (err instanceof RangeError) {
        if (opts.titlesOnly) return [];
        console.warn('Search filter failed — retrying titles only', err);
        return filterNotes(notes, {
          query,
          filter,
          tagId,
          folderId,
          tagMap,
          sort,
          searchOptions: { ...opts, titlesOnly: true },
        });
      }
      throw err;
    }
    return out;
  }

  function sameNoteContent(prev, next) {
    if (!prev || !next) return false;
    const title = (value) => String(value || '').trim() || 'Untitled';
    return title(prev.title) === title(next.title)
      && String(prev.content || '') === String(next.content || '')
      && String(prev.editor || 'plain') === String(next.editor || 'plain')
      && !!prev.prevent_edit === !!next.prevent_edit
      && !!prev.locked === !!next.locked;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function highlightPlain(text, query, { caseSensitive = false } = {}) {
    const source = String(text ?? '');
    const ranges = findMatches(source, query, { caseSensitive });
    if (!ranges.length) return escapeHtml(source);
    let html = '';
    let last = 0;
    for (const { start, end } of ranges) {
      html += escapeHtml(source.slice(last, start));
      html += `<mark class="search-hit">${escapeHtml(source.slice(start, end))}</mark>`;
      last = end;
    }
    return html + escapeHtml(source.slice(last));
  }

  function applyHighlights(root, query, { caseSensitive = false } = {}) {
    if (!root || !String(query || '').trim()) return 0;
    const needle = String(query).trim();
    const find = caseSensitive ? needle : needle.toLowerCase();
    const doc = root.ownerDocument;
    if (!doc || typeof doc.createTreeWalker !== 'function') return 0;
    const walker = doc.createTreeWalker(root, 4);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let count = 0;
    for (const node of nodes) {
      if (node.parentElement && node.parentElement.closest('mark.search-hit')) continue;
      const text = node.nodeValue || '';
      const hay = caseSensitive ? text : text.toLowerCase();
      let from = 0;
      let last = 0;
      const parts = [];
      while (from <= hay.length - find.length) {
        const at = hay.indexOf(find, from);
        if (at < 0) break;
        if (at > last) parts.push(doc.createTextNode(text.slice(last, at)));
        const mark = doc.createElement('mark');
        mark.className = 'search-hit';
        mark.textContent = text.slice(at, at + needle.length);
        parts.push(mark);
        last = at + needle.length;
        from = last;
        count += 1;
      }
      if (!parts.length) continue;
      if (last < text.length) parts.push(doc.createTextNode(text.slice(last)));
      const frag = doc.createDocumentFragment();
      parts.forEach((part) => frag.appendChild(part));
      node.parentNode.replaceChild(frag, node);
    }
    return count;
  }

  function findMatches(text, query, { caseSensitive = false } = {}) {
    const source = String(text || '');
    const needle = String(query || '');
    if (!needle) return [];
    const hay = caseSensitive ? source : source.toLowerCase();
    const find = caseSensitive ? needle : needle.toLowerCase();
    const out = [];
    let from = 0;
    while (from <= hay.length - find.length) {
      const at = hay.indexOf(find, from);
      if (at < 0) break;
      out.push({ start: at, end: at + needle.length });
      from = at + Math.max(needle.length, 1);
    }
    return out;
  }

  function replaceAll(text, query, replacement, { caseSensitive = false } = {}) {
    const source = String(text || '');
    const needle = String(query || '');
    if (!needle) return source;
    const matches = findMatches(source, needle, { caseSensitive });
    if (!matches.length) return source;
    let out = '';
    let last = 0;
    for (const { start, end } of matches) {
      out += source.slice(last, start);
      out += replacement;
      last = end;
    }
    return out + source.slice(last);
  }

  return {
    filterNotes,
    findMatches,
    replaceAll,
    describeMatch,
    matchesNoteOrFileName,
    snippetAround,
    sameNoteContent,
    highlightPlain,
    applyHighlights,
    defaultSearchOptions,
    countActiveSearchFilters,
    searchContextActive,
    noteIsProtected,
    indexNote,
    indexNotes,
    removeFromIndex,
    buildSearchBlob,
    parseNoteTime,
    updatedStamp,
    createdStamp,
    noteIsPinned,
    partitionPinnedNotes,
    compareNotesForSort,
    derivedTitleFromBody,
    effectiveNoteTitle,
    noteIsEmptyStub,
    isPlaceholderTitle,
    looksLikeSpreadsheetJson,
    looksLikeSpreadsheetPayload,
    titleFromSpreadsheetJson,
    fallbackSpreadsheetTitle,
    isActiveLibraryNote,
    countLibraryNotes,
    listUsesDateSections,
  };
})();
if (typeof window !== 'undefined') window.NotesSearch = NotesSearch;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesSearch;
