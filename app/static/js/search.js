const NotesSearch = (() => {
  // Per-note search text, built from the live note and the attachments the
  // note list shows. Memory only — cleared on lock. Each entry remembers what
  // it was built from, so an edit made under it (remote save, OCR arriving,
  // a tag rename, a file hidden or revived) is noticed at query time instead
  // of hiding a note until the next full reindex.
  const noteIndex = new Map();

  function normalize(text) {
    return foldText(text).trim();
  }

  // Lowercase and strip Latin diacritics one character at a time, so offsets
  // into the folded text are offsets into the original ("Eén café" and
  // "een cafe" line up). Characters that would change length stay as they are.
  const foldCache = new Map();
  function foldChar(ch) {
    let out = foldCache.get(ch);
    if (out !== undefined) return out;
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out = base.length === 1 ? base : ch;
    foldCache.set(ch, out);
    return out;
  }

  function foldText(text) {
    const lower = String(text || '').toLowerCase();
    // Latin-1 Supplement and Latin Extended-A/B cover Dutch, German, French,
    // Spanish and Scandinavian letters without touching the rest of the string.
    return /[\u00c0-\u024f]/.test(lower) ? lower.replace(/[\u00c0-\u024f]/g, foldChar) : lower;
  }

  // A short invoice or page number must match that token, not a longer number
  // that happens to contain the same digits (136 vs 1360, or x136y).
  function queryIsShortNumber(query) {
    return /^\d{1,8}$/.test(normalize(query));
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // One search term: a bare word, or a quoted phrase. Words inside a term are
  // separated by any run of whitespace, and short numbers are whole tokens.
  function compileTerm(text, { phrase = false } = {}) {
    const words = text.split(' ').filter(Boolean);
    const shortNumber = words.length === 1 && /^\d{1,8}$/.test(words[0]);
    const plain = words.length === 1 && !shortNumber;
    const source = words.map((word) => (/^\d{1,8}$/.test(word) ? `\\b${word}\\b` : escapeRegExp(word))).join('\\s+');
    return {
      text,
      phrase,
      shortNumber,
      // Plain single words use indexOf; everything else needs the pattern.
      plain,
      regex: plain ? null : new RegExp(source, 'g'),
    };
  }

  const termCache = new Map();

  // "invoice 136" means both words, in any field, in any order.
  // "\"invoice 136\"" means that phrase. Curly quotes from phone keyboards count.
  function parseQueryTerms(query) {
    const raw = String(query || '');
    const cached = termCache.get(raw);
    if (cached) return cached;
    const text = foldText(raw).replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"');
    const terms = [];
    const re = /"([^"]*)"?|(\S+)/g;
    let match = re.exec(text);
    while (match) {
      if (match[1] !== undefined) {
        const phrase = match[1].replace(/\s+/g, ' ').trim();
        if (phrase) terms.push(compileTerm(phrase, { phrase: true }));
      } else {
        const word = match[2].replace(/"/g, '');
        if (word) terms.push(compileTerm(word));
      }
      match = re.exec(text);
    }
    if (termCache.size > 64) termCache.clear();
    termCache.set(raw, terms);
    return terms;
  }

  // Index of the first occurrence of one term in already-folded text.
  function termIndex(hay, term, from = 0) {
    if (term.plain) return hay.indexOf(term.text, from);
    term.regex.lastIndex = from;
    const match = term.regex.exec(hay);
    return match ? match.index : -1;
  }

  function termMatchAt(hay, term, from = 0) {
    if (term.plain) {
      const at = hay.indexOf(term.text, from);
      return at < 0 ? null : { start: at, end: at + term.text.length };
    }
    term.regex.lastIndex = from;
    const match = term.regex.exec(hay);
    if (!match) return null;
    return { start: match.index, end: match.index + Math.max(1, match[0].length) };
  }

  // Texts folded on demand, so a hit in the title never lowercases the scan.
  function lazyFolded(texts) {
    const folded = new Array(texts.length).fill(undefined);
    return (i) => {
      if (folded[i] === undefined) folded[i] = texts[i] ? foldText(texts[i]) : '';
      return folded[i];
    };
  }

  function termInAny(term, folded, count) {
    for (let i = 0; i < count; i += 1) {
      const hay = folded(i);
      if (hay && termIndex(hay, term) >= 0) return true;
    }
    return false;
  }

  // Every term has to appear in at least one of the texts.
  function allTermsIn(terms, texts) {
    const folded = lazyFolded(texts);
    return terms.every((term) => termInAny(term, folded, texts.length));
  }

  // Position of the earliest term hit in text, or -1. Used for snippets.
  function queryIndex(text, query) {
    const terms = parseQueryTerms(query);
    const hay = foldText(text);
    if (!terms.length || !hay) return -1;
    let best = -1;
    for (const term of terms) {
      const at = termIndex(hay, term);
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    return best;
  }

  // True when every term of the query occurs in this one text.
  function textHasQuery(text, query) {
    const terms = parseQueryTerms(query);
    if (!terms.length) return false;
    return allTermsIn(terms, [text]);
  }

  function notesStore() {
    if (typeof NotesStore !== 'undefined' && NotesStore) return NotesStore;
    if (typeof window !== 'undefined' && window.NotesStore) return window.NotesStore;
    return null;
  }

  // Attachments the note list would show. Null when there is no vault yet,
  // so unit tests can still search the note's own ocr_text field.
  function visibleAttachments(note) {
    const store = notesStore();
    if (!store || !note?.uuid || typeof store.listAttachments !== 'function') return null;
    const listed = store.listAttachments(note.uuid);
    return Array.isArray(listed) ? listed : null;
  }

  function attachmentLooksTextual(item) {
    const mime = String(item?.content?.mime || '').toLowerCase();
    const name = String(item?.content?.filename || item?.content?.original_filename || '').toLowerCase();
    if (mime.startsWith('image/') || mime === 'application/pdf') return false;
    if (/\.(pdf|png|jpe?g|gif|webp|bmp|hei[cf]|tif|tiff)$/.test(name)) return false;
    return mime.startsWith('text/')
      || mime.includes('json')
      || mime.includes('csv')
      || mime.includes('xml')
      || mime.includes('yaml')
      || mime.includes('word')
      || mime.includes('officedocument')
      || /\.(txt|md|csv|json|log|xml|yaml|yml|docx)$/.test(name);
  }

  function ocrMatchLabel(note, query) {
    const atts = visibleAttachments(note);
    if (!atts || !atts.length) return 'Scanned document';
    const textual = atts.filter(attachmentLooksTextual);
    if (!textual.length) return 'Scanned document';
    const visual = atts.filter((item) => !attachmentLooksTextual(item));
    if (!visual.length) return 'Attachment text';
    const q = String(query || '');
    const textHit = textual.some((item) => textHasQuery(item.content?.ocr_text || '', q));
    const visualHit = visual.some((item) => textHasQuery(item.content?.ocr_text || '', q));
    if (textHit && !visualHit) return 'Attachment text';
    return 'Scanned document';
  }

  function scanTextForSearch(note) {
    if (!note?.content || note.content.locked) return '';
    const atts = visibleAttachments(note);
    if (atts) {
      return atts.map((item) => String(item.content?.ocr_text || '').trim()).filter(Boolean).join('\n\n');
    }
    return String(note.content.ocr_text || '');
  }

  function fileNamesForSearch(note) {
    if (!note?.content || note.content.locked) return '';
    const atts = visibleAttachments(note);
    if (atts) {
      return atts.map((item) => attachmentNames(item.content)).filter(Boolean).join(' ');
    }
    return String(note.content.attachment_names || '');
  }

  function attachmentNames(content) {
    const parts = [content?.filename, content?.original_filename].filter(Boolean);
    return [...new Set(parts.map((part) => String(part).trim()).filter(Boolean))].join(' ');
  }

  // A spreadsheet note stores JSON. Search its sheet names and cells, not the
  // structure around them — "cells" or "index" must not match every sheet.
  function spreadsheetText(raw) {
    const data = safeParseJson(raw);
    if (!data) return null;
    const sheets = Array.isArray(data.sheets) ? data.sheets : [];
    const lines = [];
    for (const sheet of sheets) {
      if (sheet?.name) lines.push(String(sheet.name));
      const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
      for (const row of rows) {
        const cells = Array.isArray(row) ? row : (Array.isArray(row?.cells) ? row.cells : []);
        const texts = cells.map(spreadsheetCellText).filter(Boolean);
        if (texts.length) lines.push(texts.join(' '));
      }
    }
    return lines.join('\n');
  }

  // The body text search reads: the note text, or a spreadsheet's cells.
  function searchableBody(note) {
    const body = String(note?.content?.content || '');
    if (looksLikeSpreadsheetPayload(body)) {
      const cells = spreadsheetText(body);
      if (cells != null) return cells;
    }
    return body;
  }

  function tagTitlesForSearch(note, tagMap) {
    const titles = [];
    for (const tagId of note?.content?.tags || []) {
      const tag = tagMap?.get?.(tagId);
      if (tag) titles.push(String(tag.content?.title || ''));
    }
    return titles;
  }

  function folderTitleForSearch(note, folderMap) {
    const folderId = note?.content?.folder_id;
    if (!folderId) return '';
    const folder = folderMap?.get?.(folderId);
    if (!folder) return '';
    return String(folder.content?.title || '');
  }

  function buildSearchBlob(note, tagMap, folderMap) {
    if (!note || !note.content || note.content.type !== 'note') return '';
    // Locked notes stay findable by title only — body/OCR/filenames must not leak.
    if (note.content.locked) return normalize(note.content.title || '');
    const parts = [
      effectiveNoteTitle(note),
      searchableBody(note),
      scanTextForSearch(note),
      fileNamesForSearch(note),
      ...tagTitlesForSearch(note, tagMap),
      folderTitleForSearch(note, folderMap),
    ];
    return normalize(parts.join('\n'));
  }

  function numericTokensIn(blob) {
    const found = new Set();
    if (blob) {
      const re = /\b\d{1,8}\b/g;
      let match = re.exec(blob);
      while (match) {
        found.add(match[0]);
        match = re.exec(blob);
      }
    }
    return found;
  }

  // Everything the blob was built from, as a flat list: strings by value,
  // attachment contents by identity. Cheap to compare on every keystroke.
  function indexSignature(note, tagMap, folderMap) {
    const c = note.content || {};
    const atts = c.locked ? null : visibleAttachments(note);
    const sig = [c, c.title, !!c.title_manual, !!c.locked, c.content, c.updated_at, c.created_at];
    if (atts) {
      sig.push(atts.length);
      for (const item of atts) {
        const ac = item.content || {};
        sig.push(ac, ac.ocr_text, ac.filename, ac.original_filename);
      }
    } else {
      sig.push(-1, c.ocr_text, c.attachment_names);
    }
    for (const tagId of c.tags || []) {
      const tag = tagMap?.get?.(tagId);
      if (tag) sig.push(tag.content?.title);
    }
    sig.push(c.folder_id || '', folderTitleForSearch(note, folderMap));
    return sig;
  }

  function sameSignature(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  function buildIndexEntry(note, tagMap, folderMap) {
    const signature = indexSignature(note, tagMap, folderMap);
    const blob = buildSearchBlob(note, tagMap, folderMap);
    const entry = { blob, tokens: numericTokensIn(blob), signature };
    noteIndex.set(note.uuid, entry);
    return entry;
  }

  // The entry for this note, rebuilt when anything it was built from changed.
  function freshIndexEntry(note, tagMap, folderMap) {
    const entry = noteIndex.get(note.uuid);
    if (entry && sameSignature(entry.signature, indexSignature(note, tagMap, folderMap))) return entry;
    return buildIndexEntry(note, tagMap, folderMap);
  }

  function entryHasTerms(entry, terms) {
    for (const term of terms) {
      if (term.shortNumber) {
        if (!entry.tokens.has(term.text)) return false;
      } else if (termIndex(entry.blob, term) < 0) {
        return false;
      }
    }
    return true;
  }

  function clearMemoryIndex() {
    noteIndex.clear();
  }

  function memoryIndexActive() {
    return noteIndex.size > 0;
  }

  function indexNote(note, tagMap, folderMap) {
    if (!note || note.deleted) {
      noteIndex.delete(note?.uuid);
      return;
    }
    if (note.content?.type !== 'note') return;
    buildIndexEntry(note, tagMap, folderMap);
  }

  function indexNotes(notes, tagMap, folderMap) {
    clearMemoryIndex();
    for (const note of notes) indexNote(note, tagMap, folderMap);
  }

  function removeFromIndex(uuid) {
    noteIndex.delete(uuid);
  }

  function snippetAround(text, query, width = 42) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    const terms = parseQueryTerms(query);
    if (!terms.length || !source) return '';
    const hay = foldText(source);
    let hit = null;
    for (const term of terms) {
      const found = termMatchAt(hay, term);
      if (found && (!hit || found.start < hit.start)) hit = found;
    }
    if (!hit) return '';
    const start = Math.max(0, hit.start - width);
    const end = Math.min(source.length, hit.end + width);
    return `${start ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
  }

  function matchesNoteOrFileName(note, query, { includeFileNames = true } = {}) {
    const terms = parseQueryTerms(query);
    if (!terms.length) return false;
    const texts = [effectiveNoteTitle(note)];
    if (includeFileNames && !note.content?.locked) texts.push(fileNamesForSearch(note));
    return allTermsIn(terms, texts);
  }

  // Which field to show for a hit: the first field that holds every term, or
  // — when the words are spread over fields — the field with the first term.
  function describeMatch(note, query, tagMap, { titlesOnly = false, folderMap = null } = {}) {
    const terms = parseQueryTerms(query);
    if (!terms.length) return null;
    const locked = !!note.content?.locked;
    const fields = [{ field: 'title', label: 'Title', text: () => effectiveNoteTitle(note), snippet: (text) => text }];
    if (!locked) {
      fields.push({ field: 'file', label: 'Filename', text: () => fileNamesForSearch(note), snippet: (text) => snippetAround(text, query, 56) || text });
    }
    if (!titlesOnly && !locked) {
      fields.push({ field: 'body', label: 'Note', text: () => searchableBody(note), snippet: (text) => snippetAround(text, query) });
      fields.push({ field: 'ocr', label: ocrMatchLabel(note, query), text: () => scanTextForSearch(note), snippet: (text) => snippetAround(text, query) });
      for (const tagTitle of tagTitlesForSearch(note, tagMap)) {
        fields.push({ field: 'tag', label: 'Tag', text: () => tagTitle, snippet: (text) => text });
      }
      const folderTitle = folderTitleForSearch(note, folderMap);
      if (folderTitle) {
        fields.push({ field: 'folder', label: 'Folder', text: () => folderTitle, snippet: (text) => text });
      }
    }
    // Field text and its folded form are read once, and only when reached.
    const texts = new Array(fields.length).fill(undefined);
    const text = (i) => {
      if (texts[i] === undefined) texts[i] = fields[i].text();
      return texts[i];
    };
    const foldedAt = new Array(fields.length).fill(undefined);
    const at = (i) => {
      if (foldedAt[i] === undefined) foldedAt[i] = text(i) ? foldText(text(i)) : '';
      return foldedAt[i];
    };
    const describe = (i) => ({ field: fields[i].field, label: fields[i].label, snippet: fields[i].snippet(text(i)) });
    for (let i = 0; i < fields.length; i += 1) {
      if (at(i) && terms.every((term) => termIndex(at(i), term) >= 0)) return describe(i);
    }
    if (!terms.every((term) => termInAny(term, at, fields.length))) return null;
    for (let i = 0; i < fields.length; i += 1) {
      if (at(i) && termIndex(at(i), terms[0]) >= 0) return describe(i);
    }
    return null;
  }

  function matches(note, query, tagMap, options = {}) {
    const terms = parseQueryTerms(query);
    if (!terms.length) return true;
    if (options.titlesOnly || note.content?.locked) {
      // The switch is titled "Search titles only" — filenames stay on the normal search.
      return matchesNoteOrFileName(note, query, { includeFileNames: false });
    }
    // The index answers "no" cheaply; a "yes" is confirmed against the live
    // fields, so a row never stays for text it no longer has.
    if (!entryHasTerms(freshIndexEntry(note, tagMap, options.folderMap), terms)) return false;
    return !!describeMatch(note, query, tagMap, options);
  }

  // Files view: this file's own OCR only. A parent note's copied scan does not
  // count, and a protected parent gives up no more than it does in the note list.
  function fileRowMatches(att, note, query, { titlesOnly = false, includeProtected = false } = {}) {
    const terms = parseQueryTerms(query);
    if (!terms.length) return true;
    const title = effectiveNoteTitle(note);
    if (titlesOnly || note?.content?.locked) return allTermsIn(terms, [title]);
    const content = att?.content || att || {};
    const name = attachmentNames(content);
    if (!includeProtected && noteIsProtected(note?.content)) return allTermsIn(terms, [name, title]);
    return allTermsIn(terms, [name, String(content.mime || ''), title, String(content.ocr_text || '')]);
  }

  function listCountLabel(count, { files = false } = {}) {
    const n = Math.max(0, Number(count) || 0);
    const noun = files ? 'file' : 'note';
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }

  function documentHighlightLabel(count, { page = 0, pages = 0 } = {}) {
    const n = Math.max(0, Number(count) || 0);
    if (!n) return 'No highlights in this PDF';
    const noun = n === 1 ? 'highlight' : 'highlights';
    const base = `${n} ${noun} in this PDF`;
    if (pages > 1 && page) return `${base}, page ${page} of ${pages}`;
    return base;
  }

  // How often the query occurs in one attachment's own scanned text. The
  // note's copied ocr_text is not consulted: that would credit this file with
  // hits that live in another file on the same note.
  function attachmentHitCount(att, query) {
    const terms = parseQueryTerms(query);
    if (!terms.length) return 0;
    const content = att?.content || att || {};
    return findMatches(String(content.ocr_text || ''), query).length;
  }

  function attachmentMatchesQuery(att, query) {
    const terms = parseQueryTerms(query);
    if (!terms.length) return false;
    if (attachmentHitCount(att, query) > 0) return true;
    const content = att?.content || att || {};
    return allTermsIn(terms, [attachmentNames(content)]);
  }

  // Badge on an attachment row. Empty when the file has no hits so a row
  // never claims a count it cannot show.
  function attachmentHighlightLabel(count) {
    const n = Math.max(0, Number(count) || 0);
    if (!n) return '';
    return `${n} ${n === 1 ? 'highlight' : 'highlights'} in this file`;
  }

  // The file a note opens on while a query is active: most hits in its own
  // text first, then a filename match, then the stored order. Stable, so
  // notes without a hit keep their usual first attachment.
  function orderAttachmentsForQuery(items, query) {
    const list = Array.isArray(items) ? items : [];
    const terms = parseQueryTerms(query);
    if (!terms.length || list.length < 2) return list.slice();
    const ranked = list.map((att, index) => ({
      att,
      index,
      hits: attachmentHitCount(att, query),
      name: allTermsIn(terms, [attachmentNames(att?.content || att || {})]) ? 1 : 0,
    }));
    ranked.sort((a, b) => b.hits - a.hits || b.name - a.name || a.index - b.index);
    return ranked.map((entry) => entry.att);
  }

  function readingStats(text) {
    const raw = String(text || '').trim();
    const words = raw ? raw.split(/\s+/).length : 0;
    const minutes = words >= 220 ? Math.max(1, Math.round(words / 220)) : 0;
    return { words, minutes };
  }

  function noteBodyReading(note) {
    return readingStats(note?.content?.content || '');
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
    // content.updated_at is the user-visible edit time. A folder move bumps
    // the sync row only, and must not make the list say "just now".
    const edited = parseNoteTime(note?.content?.updated_at);
    if (edited > 0) return edited;
    const item = parseNoteTime(note?.updated_at);
    if (item > 0) return item;
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

  function filterNotes(notes, { query, filter, tagId, folderId, tagMap, folderMap, sort, searchOptions = {} }) {
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

        if (filter === 'pinned' && !c.starred) return false;
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
          if (opts.titlesOnly || c.locked) {
            return matchesNoteOrFileName(n, q, { includeFileNames: false });
          }
          return matchesNoteOrFileName(n, q, { includeFileNames: true });
        }

        return matches(n, q, tagMap, { titlesOnly: opts.titlesOnly, folderMap });
      })
      .sort((a, b) => compareNotesForSort(a, b, sort));
    } catch (err) {
      if (err instanceof RangeError) {
        if (opts.titlesOnly) return [];
        console.warn('Search filter failed — retrying titles only', err);
        const fallback = filterNotes(notes, {
          query,
          filter,
          tagId,
          folderId,
          tagMap,
          folderMap,
          sort,
          searchOptions: { ...opts, titlesOnly: true },
        });
        // Body and scan hits were skipped; the caller should say so.
        fallback.titlesOnlyFallback = true;
        return fallback;
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

  function highlightPlain(text, query, { caseSensitive = false, literal = false } = {}) {
    const source = String(text ?? '');
    const ranges = findMatches(source, query, { caseSensitive, literal });
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

  function applyHighlights(root, query, { caseSensitive = false, literal = false } = {}) {
    if (!root || !String(query || '').trim()) return 0;
    const doc = root.ownerDocument;
    if (!doc || typeof doc.createTreeWalker !== 'function') return 0;
    const walker = doc.createTreeWalker(root, 4);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let count = 0;
    for (const node of nodes) {
      if (node.parentElement && node.parentElement.closest('mark.search-hit')) continue;
      const text = node.nodeValue || '';
      const ranges = findMatches(text, query, { caseSensitive, literal });
      if (!ranges.length) continue;
      const parts = [];
      let last = 0;
      for (const { start, end } of ranges) {
        if (start > last) parts.push(doc.createTextNode(text.slice(last, start)));
        const mark = doc.createElement('mark');
        mark.className = 'search-hit';
        mark.textContent = text.slice(start, end);
        parts.push(mark);
        last = end;
        count += 1;
      }
      if (last < text.length) parts.push(doc.createTextNode(text.slice(last)));
      const frag = doc.createDocumentFragment();
      parts.forEach((part) => frag.appendChild(part));
      node.parentNode.replaceChild(frag, node);
    }
    return count;
  }

  // Ranges to highlight. By default these follow the search box rules (each
  // term, short numbers as whole tokens, phrases across whitespace), so the
  // marks in a row, a preview, or a PDF agree with why the note is listed.
  // The editor's find/replace passes literal: true for exact substrings.
  function findMatches(text, query, { caseSensitive = false, literal = false } = {}) {
    const source = String(text || '');
    if (literal || caseSensitive) return literalMatches(source, String(query || ''), caseSensitive);
    const terms = parseQueryTerms(query);
    if (!terms.length || !source) return [];
    const hay = foldText(source);
    const out = [];
    for (const term of terms) {
      let from = 0;
      while (from <= hay.length) {
        const hit = termMatchAt(hay, term, from);
        if (!hit) break;
        out.push(hit);
        from = hit.end;
      }
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of out) {
      const prev = merged[merged.length - 1];
      if (prev && range.start < prev.end) prev.end = Math.max(prev.end, range.end);
      else merged.push({ start: range.start, end: range.end });
    }
    return merged;
  }

  function literalMatches(source, needle, caseSensitive) {
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
    const matches = findMatches(source, needle, { caseSensitive, literal: true });
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
    textHasQuery,
    queryIsShortNumber,
    parseQueryTerms,
    searchableBody,
    fileRowMatches,
    listCountLabel,
    documentHighlightLabel,
    attachmentHitCount,
    attachmentMatchesQuery,
    attachmentHighlightLabel,
    orderAttachmentsForQuery,
    readingStats,
    noteBodyReading,
    snippetAround,
    clearMemoryIndex,
    memoryIndexActive,
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
