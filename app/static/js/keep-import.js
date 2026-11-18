/*
 * Google Keep import (Takeout .zip): reads Keep/*.json only. Mapping, limits and sanitising:
 * docs/IMPORT_EXPORT_SPEC.md sections 3.3, 4.1, 4.2, 4.4 and 4.5.
 *
 * NotesKeepImport.parse(files, { now }) -> Promise<{ notes, skipped, attachmentCount }>
 *   files: [{ name, bytes: Uint8Array }]  (.zip)
 *   notes: same shape as NotesMdImport.parse plus `archived` and `pinned`, so
 *   NotesStore.importMarkdownNotes stores them.
 * A refused ZIP (limits, unsafe entry names) or a Keep JSON that is too large or too deep throws; nothing
 * is fetched and nothing is written. Notes in the trash are skipped. HTML copies are ignored; HTML is only
 * used when a note has no plain text and no list, and then only after the allowlist of NotesMdImport.
 */
const NotesKeepImport = (() => {
  const MAX_JSON_BYTES = 10 * 1024 * 1024;
  const MAX_NOTES = 10000;
  const MAX_ATTACHMENTS_PER_NOTE = 100;
  const MAX_TAGS = 64;
  const MAX_TAG_CHARS = 100;
  const MAX_TITLE_CHARS = 200;
  const MAX_DEPTH = 64;
  const DAY_MS = 24 * 3600 * 1000;
  const NOTE_FIELDS = ['title', 'textContent', 'textContentHtml', 'listContent', 'attachments', 'createdTimestampUsec', 'userEditedTimestampUsec'];

  const stripControl = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const baseName = (path) => String(path).split('/').pop();
  const str = (v) => (typeof v === 'string' ? v : '');

  function zipLib() {
    return typeof NotesZip !== 'undefined' ? NotesZip : require('./ziplib.js');
  }

  function mdLib() {
    return typeof NotesMdImport !== 'undefined' ? NotesMdImport : require('./md-import.js');
  }

  function tooDeep(value, depth = 0) {
    if (depth > MAX_DEPTH) return true;
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) if (tooDeep(child, depth + 1)) return true;
    }
    return false;
  }

  function usecDate(value, now) {
    const ms = Number(value) / 1000;
    if (!Number.isFinite(ms) || ms <= 0 || ms > now.getTime() + DAY_MS) return null;
    return new Date(ms).toISOString();
  }

  function mimeOf(raw) {
    const mime = str(raw).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) ? mime : 'application/octet-stream';
  }

  function itemText(text) {
    return stripControl(str(text)).replace(/\s*\n\s*/g, ' ').trim();
  }

  function convertNote(source, json, files, now) {
    const lines = [];
    const text = stripControl(str(json.textContent)).replace(/\r\n?/g, '\n').trim();
    const list = (Array.isArray(json.listContent) ? json.listContent : [])
      .filter((item) => item && typeof item === 'object')
      .map((item) => `- [${item.isChecked === true ? 'x' : ' '}] ${itemText(item.text)}`.trimEnd());
    let body = '';
    if (text) body = text;
    else if (!list.length && str(json.textContentHtml).trim()) body = mdLib().sanitizeBody(stripControl(str(json.textContentHtml))).trim();
    if (list.length) body += `${body ? '\n\n' : ''}${list.join('\n')}`;
    for (const a of Array.isArray(json.annotations) ? json.annotations : []) {
      const url = a && typeof a === 'object' ? str(a.url).trim() : '';
      if (!/^https?:\/\/[^\s<>()[\]]+$/i.test(url)) continue;
      const label = itemText(a.title).replace(/[[\]]/g, '') || url;
      lines.push(`[${label}](${url})`);
    }
    if (lines.length) body += `${body ? '\n\n' : ''}${lines.join('\n')}`;

    let title = stripControl(str(json.title)).trim();
    const titleManual = !!title;
    if (!title) title = (body.split('\n').find((l) => l.trim()) || '').replace(/^- \[[ x]\] /, '').trim();
    title = [...(title || 'Untitled')].slice(0, MAX_TITLE_CHARS).join('');

    const tagSet = new Map();
    for (const label of Array.isArray(json.labels) ? json.labels : []) {
      const clean = stripControl(label && typeof label === 'object' ? str(label.name) : '').trim();
      if (clean && [...clean].length <= MAX_TAG_CHARS && tagSet.size < MAX_TAGS && !tagSet.has(clean.toLowerCase())) tagSet.set(clean.toLowerCase(), clean);
    }

    const attachments = [];
    const missing = [];
    let dropped = 0;
    for (const att of Array.isArray(json.attachments) ? json.attachments : []) {
      const wanted = baseName(att && typeof att === 'object' ? str(att.filePath) : '');
      if (!wanted) continue;
      if (attachments.length >= MAX_ATTACHMENTS_PER_NOTE) { dropped += 1; continue; }
      const hit = files.find((f) => !f.used && f.base === wanted.toLowerCase());
      if (!hit) { missing.push(wanted); continue; }
      hit.used = true;
      attachments.push({ name: baseName(hit.name), mime: mimeOf(att.mimetype), bytes: hit.bytes });
    }

    const created = usecDate(json.createdTimestampUsec, now);
    const updated = usecDate(json.userEditedTimestampUsec, now);
    const first = created || updated || now.toISOString();
    return {
      note: {
        source,
        title,
        titleManual,
        content: body,
        editor: body && body.split('\n').filter((l) => l.trim()).every((l) => /^- \[[ x]\](?: |$)/.test(l)) ? 'checklist' : 'plain',
        tags: [...tagSet.values()],
        archived: json.isArchived === true,
        pinned: json.isPinned === true,
        created_at: first,
        updated_at: updated || first,
        attachments,
      },
      missing,
      dropped,
    };
  }

  async function parseZip(name, bytes, now, notes, skipped) {
    const entries = await zipLib().readZip(bytes);
    const files = entries
      .filter((e) => !/\.(json|html?)$/i.test(e.name))
      .map((e) => ({ name: e.name, base: baseName(e.name).toLowerCase(), bytes: e.bytes, used: false }));
    let attachmentCount = 0;
    for (const entry of entries) {
      if (!/\.json$/i.test(entry.name)) continue;
      const label = `${name}: ${entry.name}`;
      if (entry.bytes.length > MAX_JSON_BYTES) throw new Error(`Import refused: ${entry.name} is larger than 10 MiB.`);
      let json;
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(entry.bytes)); } catch (err) {
        skipped.push({ name: label, reason: 'not valid JSON' });
        continue;
      }
      if (tooDeep(json)) throw new Error(`Import refused: ${entry.name} is nested deeper than ${MAX_DEPTH} levels.`);
      if (!json || typeof json !== 'object' || Array.isArray(json) || !NOTE_FIELDS.some((k) => k in json)) {
        skipped.push({ name: label, reason: 'not a Keep note' });
        continue;
      }
      if (json.isTrashed === true) { skipped.push({ name: label, reason: 'in the Keep trash' }); continue; }
      if (notes.length >= MAX_NOTES) throw new Error(`Import refused: more than ${MAX_NOTES} notes.`);
      const { note, missing, dropped } = convertNote(entry.name, json, files, now);
      if (!note.content && !note.attachments.length && !note.titleManual) { skipped.push({ name: label, reason: 'empty note' }); continue; }
      for (const m of missing) skipped.push({ name: `${label}: ${m}`, reason: 'attachment is not in the ZIP' });
      if (dropped) skipped.push({ name: label, reason: `${dropped} attachment(s) over the limit of ${MAX_ATTACHMENTS_PER_NOTE} per note` });
      attachmentCount += note.attachments.length;
      notes.push(note);
    }
    return attachmentCount;
  }

  async function parse(files, { now = new Date() } = {}) {
    const notes = [];
    const skipped = [];
    let attachmentCount = 0;
    for (const file of files || []) {
      const name = String(file.name || '');
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || 0);
      if (!/\.zip$/i.test(name)) { skipped.push({ name, reason: 'not a .zip file' }); continue; }
      attachmentCount += await parseZip(name, bytes, now, notes, skipped);
    }
    return { notes, skipped, attachmentCount };
  }

  return { parse };
})();
if (typeof window !== 'undefined') window.NotesKeepImport = NotesKeepImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesKeepImport;
