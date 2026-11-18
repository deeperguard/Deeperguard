/*
 * Markdown import: single .md files and ZIP folders (including the readable
 * export of NotesReadableExport). Mapping, limits and sanitising:
 * docs/IMPORT_EXPORT_SPEC.md sections 3.1, 4.1, 4.2, 4.4 and 4.5.
 *
 * NotesMdImport.parse(files, { now }) -> Promise<{ notes, skipped, attachmentCount }>
 *   files: [{ name, bytes: Uint8Array }]  (.md, .markdown or .zip)
 *   notes: [{ source, title, titleManual, content, editor, tags: [title],
 *             created_at, updated_at, attachments: [{ name, mime, bytes }] }]
 *   skipped: [{ name, reason }]
 * A refused ZIP (limits, unsafe names) throws; nothing is read from the network
 * and nothing is written anywhere. The caller stores the result via
 * NotesStore.importMarkdownNotes.
 */
const NotesMdImport = (() => {
  const MAX_MD_BYTES = 10 * 1024 * 1024;
  const MAX_NOTES = 10000;
  const MAX_ATTACHMENTS_PER_NOTE = 100;
  const MAX_TAGS = 64;
  const MAX_TAG_CHARS = 100;
  const MAX_TITLE_CHARS = 200;
  const DAY_MS = 24 * 3600 * 1000;
  const NOTE_FILE = /\.(md|markdown)$/i;
  const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    heic: 'image/heic', zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4',
  };

  // The allowlist is the one of NotesSanitize (spec 4.5); only `button` is not accepted from imports, and
  // attributes the renderer sets itself (aria-/data-) are not taken over from input.
  const sanitizeLib = typeof NotesSanitize !== 'undefined' ? NotesSanitize : require('./sanitize.js');
  const ALLOWED_TAGS = new Set(sanitizeLib.RICH_ALLOWED_TAGS.filter((t) => t !== 'button'));
  const ALLOWED_ATTR = new Set(sanitizeLib.RICH_ALLOWED_ATTR.filter((a) => !/^(?:aria|data)-/.test(a)));
  const DROP_WITH_CONTENT = 'script|style|iframe|object|embed|noscript|template|textarea|title|xmp|svg|math|form|link|meta|head';

  const decoder = () => new TextDecoder('utf-8', { fatal: false });
  const baseName = (path) => String(path).split('/').pop();

  function zipLib() {
    if (typeof NotesZip !== 'undefined') return NotesZip;
    return require('./ziplib.js');
  }

  // ---- front-matter (spec 2.1 syntax, no YAML library) -------------------------------------------------

  function unquote(raw) {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1).replace(/\\(["\\n])/g, (m, c) => (c === 'n' ? '\n' : c));
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value;
  }

  function parseList(raw) {
    const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
    const items = [];
    const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^,]*))\s*(?:,|$)/gy;
    let m;
    while (re.lastIndex < inner.length && (m = re.exec(inner))) {
      if (m[1] !== undefined) items.push(unquote(`"${m[1]}"`));
      else if (m[2] !== undefined) items.push(unquote(`'${m[2]}'`));
      else if (m[3].trim()) items.push(m[3].trim());
      if (m[0] === '') break;
    }
    return items;
  }

  /** -> { meta, body }. No closing line means no front-matter: the whole text is the body. */
  function splitFrontMatter(text) {
    const lines = text.split('\n');
    if (lines[0].trimEnd() !== '---') return { meta: {}, body: text };
    let end = -1;
    for (let i = 1; i < Math.min(lines.length, 200); i += 1) {
      if (lines[i].trimEnd() === '---') { end = i; break; }
    }
    if (end < 0) return { meta: {}, body: text };
    const meta = {};
    let listKey = '';
    for (const line of lines.slice(1, end)) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && listKey) { meta[listKey].push(unquote(item[1])); continue; }
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      listKey = '';
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      if (!['title', 'created', 'modified', 'tags', 'attachments'].includes(key)) continue;
      const value = kv[2].trim();
      if (value.startsWith('[')) meta[key] = parseList(value);
      else if (value === '' && (key === 'tags' || key === 'attachments')) { meta[key] = []; listKey = key; }
      else meta[key] = unquote(value);
    }
    let body = lines.slice(end + 1).join('\n');
    if (body.startsWith('\n')) body = body.slice(1);
    return { meta, body };
  }

  // ---- HTML inside the body: dropped or reduced to the allowlist (spec 4.5) ---------------------------------

  function cleanTag(match, closing, name, attrs) {
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (closing) return `</${tag}>`;
    let out = '';
    const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = attrRe.exec(attrs || ''))) {
      const key = m[1].toLowerCase();
      const value = m[2] ?? m[3] ?? m[4] ?? '';
      if (!ALLOWED_ATTR.has(key) || key.startsWith('on')) continue;
      if (key === 'href' && !/^(?:https?:|mailto:|#)/i.test(value)) continue;
      if (key === 'src' && !/^data:image\/(?:png|jpeg|gif|webp)[;,]/i.test(value)) continue;
      out += ` ${key}="${value.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]))}"`;
    }
    if (tag === 'img' && !/ src=/.test(out)) return '';
    return `<${tag}${out}>`;
  }

  function sanitizeSegment(text) {
    let out = text.replace(new RegExp(`<\\s*(${DROP_WITH_CONTENT})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'), '');
    // An opening tag that is never closed would run to the end of the text in a browser.
    const open = new RegExp(`<\\s*(?:${DROP_WITH_CONTENT})\\b`, 'i').exec(out);
    if (open) out = out.slice(0, open.index);
    // Quote-aware tag scanner; `/` may separate attributes. Autolinks stay; every other `<` is escaped.
    const tokenRe = /<((?:https?:\/\/|mailto:)[^\s<>]*|[^\s<>@]+@[^\s<>]+\.[^\s<>]+)>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>|</g;
    return out.replace(tokenRe, (match, auto, closing, name, attrs) => {
      if (auto) return match;
      if (name === undefined) return '&lt;';
      return cleanTag(match, closing, name, attrs);
    });
  }

  /** Removes script and event handlers from HTML in Markdown text; code blocks and code spans stay verbatim. */
  function sanitizeBody(text) {
    const code = /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[`~]*[ \t]*$|(?![\s\S]))|`[^`\n]*`)/gm;
    let out = '';
    let last = 0;
    let m;
    while ((m = code.exec(text))) {
      out += sanitizeSegment(text.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + sanitizeSegment(text.slice(last));
  }

  // ---- paths and attachments ------------------------------------------------------------------------------

  /** Resolve a relative link against the note's folder. null when it points outside the archive or is not relative. */
  function resolveLink(noteDir, href) {
    let target = String(href || '').trim().replace(/[?#].*$/, '');
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('\\') || target.startsWith('//')) return null;
    try { target = decodeURIComponent(target); } catch (err) { return null; }
    if (/[\\\u0000-\u001f]/.test(target)) return null;
    const parts = noteDir ? noteDir.split('/') : [];
    for (const seg of target.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
    }
    return parts.length ? parts.join('/') : null;
  }

  function displayName(path) {
    const name = baseName(path);
    // The readable export prefixes attachments with the first 8 hex characters of the id (or the full uuid).
    if (/^attachments\//.test(path)) {
      const stripped = name.replace(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})-(?=.)/i, '');
      if (stripped) return stripped;
    }
    return name;
  }

  function mimeFor(name) {
    const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1];
    return (ext && MIME[ext.toLowerCase()]) || 'application/octet-stream';
  }

  function isoDate(value, now) {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms) || ms <= 0 || ms > now.getTime() + DAY_MS) return now.toISOString();
    return new Date(ms).toISOString();
  }

  const stripControl = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

  function isChecklist(body) {
    const lines = body.split('\n').filter((l) => l.trim());
    return lines.length > 0 && lines.every((l) => /^\s*[-*] \[[ xX]\] /.test(l));
  }

  /** Drops the "Attachments:" list the readable export appends, when every link in it was resolved. */
  function stripExportedAttachmentList(body, resolvedPaths, noteDir) {
    const m = /(?:^|\n\n)Attachments:\n\n((?:- !?\[[^\]\n]*\]\([^)\n]*\)(?:\n|$))+)$/.exec(body);
    if (!m) return body;
    const hrefs = [...m[1].matchAll(/\]\(([^)\n]*)\)/g)].map((x) => resolveLink(noteDir, x[1]));
    if (!hrefs.every((p) => p && resolvedPaths.has(p))) return body;
    return body.slice(0, m.index);
  }

  function convertNote(source, text, archive, now) {
    const noteDir = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
    const { meta, body: rawBody } = splitFrontMatter(text);
    let body = rawBody.replace(/\n$/, '');

    // Attachments: front-matter list (names inside attachments/) plus relative links into the archive.
    const wanted = [];
    const seen = new Set();
    const add = (path) => {
      if (path && archive.has(path) && !NOTE_FILE.test(path) && !seen.has(path)) { seen.add(path); wanted.push(path); }
    };
    for (const name of [].concat(meta.attachments || [])) add(resolveLink('attachments', name));
    for (const m of body.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) add(resolveLink(noteDir, m[1]));
    const kept = wanted.slice(0, MAX_ATTACHMENTS_PER_NOTE);
    const attachments = kept.map((path) => ({
      name: displayName(path), mime: mimeFor(path), bytes: archive.get(path),
    }));
    const dropped = wanted.length - kept.length;
    if (meta.attachments && attachments.length) body = stripExportedAttachmentList(body, seen, noteDir);

    let title = stripControl(meta.title || '').trim();
    const titleManual = !!title;
    if (!title) {
      const heading = /^\s*\n*# +(.+?)[ \t#]*(?:\n|$)/.exec(body);
      if (heading) {
        title = stripControl(heading[1]).trim();
        body = body.slice(heading[0].length).replace(/^\n+/, '');
      }
    }
    if (!title) title = baseName(source).replace(/\.(md|markdown)$/i, '').trim();
    title = [...(title || 'Untitled')].slice(0, MAX_TITLE_CHARS).join('');

    let tags = meta.tags || [];
    if (typeof tags === 'string') tags = tags.split(',');
    const tagSet = new Map();
    for (const t of tags) {
      const clean = stripControl(t).trim();
      if (clean && [...clean].length <= MAX_TAG_CHARS && tagSet.size < MAX_TAGS) tagSet.set(clean.toLowerCase(), clean);
    }

    body = sanitizeBody(body);
    const created = isoDate(meta.created, now);
    return {
      note: {
        source,
        title,
        titleManual,
        content: body,
        editor: isChecklist(body) ? 'checklist' : 'markdown',
        tags: [...tagSet.values()],
        created_at: created,
        updated_at: meta.modified ? isoDate(meta.modified, now) : created,
        attachments,
      },
      dropped,
      paths: kept,
    };
  }

  function decodeText(bytes) {
    if (bytes.includes(0)) return null;
    let text = decoder().decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text.replace(/\r\n?/g, '\n');
  }

  async function parse(files, { now = new Date() } = {}) {
    const notes = [];
    const skipped = [];
    let attachmentCount = 0;
    const addNote = (source, bytes, archive, used) => {
      if (notes.length >= MAX_NOTES) throw new Error(`Import refused: more than ${MAX_NOTES} notes.`);
      if (bytes.length > MAX_MD_BYTES) { skipped.push({ name: source, reason: 'larger than 10 MiB' }); return; }
      const text = decodeText(bytes);
      if (text === null) { skipped.push({ name: source, reason: 'not a text file' }); return; }
      const { note, dropped, paths } = convertNote(source, text, archive, now);
      paths.forEach((path) => used.add(path));
      if (dropped > 0) skipped.push({ name: source, reason: `${dropped} attachment(s) over the limit of ${MAX_ATTACHMENTS_PER_NOTE} per note` });
      attachmentCount += note.attachments.length;
      notes.push(note);
    };
    for (const file of files || []) {
      const name = String(file.name || '');
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || 0);
      if (/\.zip$/i.test(name)) {
        const entries = await zipLib().readZip(bytes);
        const archive = new Map(entries.map((e) => [e.name, e.bytes]));
        const used = new Set();
        for (const entry of entries) if (NOTE_FILE.test(entry.name)) addNote(entry.name, entry.bytes, archive, used);
        for (const entry of entries) {
          if (NOTE_FILE.test(entry.name) || used.has(entry.name) || entry.name === 'README.txt') continue;
          skipped.push({ name: `${name}: ${entry.name}`, reason: 'not a note and not linked from a note' });
        }
      } else if (NOTE_FILE.test(name)) {
        addNote(name, bytes, new Map(), new Set());
      } else {
        skipped.push({ name, reason: 'not a .md or .zip file' });
      }
    }
    return { notes, skipped, attachmentCount };
  }

  return { parse, splitFrontMatter, sanitizeBody };
})();
if (typeof window !== 'undefined') window.NotesMdImport = NotesMdImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesMdImport;
