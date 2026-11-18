/*
 * Evernote import (.enex): strict XML parsing and conversion of ENML to Markdown.
 * Mapping, limits and sanitising: docs/IMPORT_EXPORT_SPEC.md sections 3.2, 4.1, 4.3 and 4.5.
 *
 * NotesEnexImport.parse(files, { now }) -> Promise<{ notes, skipped, attachmentCount }>
 *   files: [{ name, bytes: Uint8Array }]  (.enex)
 *   notes: same shape as NotesMdImport.parse, so NotesStore.importMarkdownNotes stores them.
 * A refused file (size, notes limit, DOCTYPE or entity declaration, not well-formed XML) throws; nothing
 * is fetched and nothing is written. Only text is produced from ENML (never HTML), and the DTD named in
 * a genuine export is cut out of the text, never loaded. The parsed trees are never inserted into the page.
 */
const NotesEnexImport = (() => {
  const MAX_ENEX_BYTES = 256 * 1024 * 1024;
  const MAX_NOTE_ELEMENT_BYTES = 80 * 1024 * 1024;
  const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
  const MAX_NOTES = 10000;
  const MAX_RESOURCES_PER_NOTE = 100;
  const MAX_DEPTH = 64;
  const MAX_TAGS = 64;
  const MAX_TAG_CHARS = 100;
  const MAX_TITLE_CHARS = 200;
  const MAX_NAME_BYTES = 255;
  const DAY_MS = 24 * 3600 * 1000;
  const EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json',
    'application/zip': 'zip', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'video/mp4': 'mp4',
  };
  const ENEX_DOCTYPE = /<!DOCTYPE\s+en-export\s+SYSTEM\s+(?:"http:\/\/xml\.evernote\.com\/pub\/evernote-export[34]\.dtd"|'http:\/\/xml\.evernote\.com\/pub\/evernote-export[34]\.dtd')\s*>/g;
  const ENML_DOCTYPE = /<!DOCTYPE\s+en-note\s+SYSTEM\s+(?:"http:\/\/xml\.evernote\.com\/pub\/enml2\.dtd"|'http:\/\/xml\.evernote\.com\/pub\/enml2\.dtd')\s*>/g;
  const FORBIDDEN_DECL = /<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i;
  const DROP_ELEMENTS = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math']);

  const stripControl = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const byteLength = (s) => new TextEncoder().encode(s).length;

  // ---- MD5 (the hash ENML uses to link <en-media> to a resource; not used for security) -------------------

  const MD5_SHIFT = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

  function md5Hex(bytes) {
    let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
    const words = new Uint32Array(16);
    const block = (src, offset) => {
      for (let i = 0; i < 16; i += 1) {
        const p = offset + i * 4;
        words[i] = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
      }
      let a = a0; let b = b0; let c = c0; let d = d0;
      for (let i = 0; i < 64; i += 1) {
        let f; let g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const sum = (a + f + MD5_K[i] + words[g]) >>> 0;
        const s = MD5_SHIFT[(i >> 4) * 4 + (i & 3)];
        a = d; d = c; c = b;
        b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    };
    const full = bytes.length - (bytes.length % 64);
    for (let off = 0; off < full; off += 64) block(bytes, off);
    const rest = bytes.length - full;
    const tail = new Uint8Array(rest + 9 <= 64 ? 64 : 128);
    tail.set(bytes.subarray(full));
    tail[rest] = 0x80;
    const bits = bytes.length * 8;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, bits >>> 0, true);
    view.setUint32(tail.length - 4, Math.floor(bits / 4294967296), true);
    for (let off = 0; off < tail.length; off += 64) block(tail, off);
    const out = new DataView(new ArrayBuffer(16));
    [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
    return Array.from(new Uint8Array(out.buffer), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- strict XML (spec 4.3) ---------------------------------------------------------------------------------

  function parseXml(text, label) {
    if (typeof DOMParser === 'undefined') throw new Error('Import refused: this browser cannot parse XML.');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
      throw new Error(`Import refused: ${label} is not well-formed XML.`);
    }
    const walk = (node, depth) => {
      if (depth > MAX_DEPTH) throw new Error(`Import refused: ${label} is nested deeper than ${MAX_DEPTH} levels.`);
      for (const child of node.childNodes) if (child.nodeType === 1) walk(child, depth + 1);
    };
    walk(doc.documentElement, 1);
    return doc;
  }

  /** Throws on any DOCTYPE or entity declaration; the two fixed Evernote DOCTYPEs are cut out first. */
  function cutDeclarations(text, pattern, label) {
    const cut = text.replace(pattern, '');
    if (FORBIDDEN_DECL.test(cut)) {
      throw new Error(`Import refused: ${label} contains a DOCTYPE or entity declaration.`);
    }
    return cut;
  }

  // ---- ENML to Markdown (spec 3.2) ---------------------------------------------------------------------------

  function escapeText(text) {
    return text.replace(/[\\`*_[\]<]/g, '\\$&');
  }

  function safeLabel(text) {
    return text.replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').trim();
  }

  function linkTarget(name) {
    return /[\s()]/.test(name) ? `<${name}>` : name;
  }

  function fenceFor(text) {
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map((m) => m.length));
    return '`'.repeat(Math.max(3, longest + 1));
  }

  function convertEnml(enmlText, resources, label) {
    const cut = cutDeclarations(enmlText, ENML_DOCTYPE, `${label} (ENML)`);
    const doc = parseXml(cut.replace(/^﻿/, ''), `${label} (ENML)`);
    const root = doc.documentElement;
    if (root.localName !== 'en-note') throw new Error('not an en-note');
    const mediaMarkdown = (el) => {
      const hash = String(el.getAttribute('hash') || '').toLowerCase();
      const res = resources.find((r) => r.hash() === hash);
      if (!res) return '[missing attachment]';
      const image = /^image\//i.test(res.mime || el.getAttribute('type') || '');
      const name = safeLabel(res.name).replace(/[[\]]/g, '\\$&');
      return `${image ? '!' : ''}[${name}](${linkTarget(res.name.replace(/[<>\r\n]/g, ''))})`;
    };

    const tableMarkdown = (table) => {
      const rows = [...table.getElementsByTagName('tr')].map((tr) => [...tr.children]
        .filter((c) => /^t[dh]$/.test(c.localName))
        .map((cell) => ({ cell, text: inlineText(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|') })));
      const nonEmpty = rows.filter((r) => r.length);
      if (!nonEmpty.length) return '';
      const width = nonEmpty[0].length;
      const rectangular = nonEmpty.every((r) => r.length === width
        && r.every((c) => !c.cell.hasAttribute('colspan') && !c.cell.hasAttribute('rowspan')));
      if (!rectangular) return nonEmpty.map((r) => r.map((c) => c.text).filter(Boolean).join(' ')).join('\n');
      const line = (r) => `| ${r.map((c) => c.text).join(' | ')} |`;
      return [line(nonEmpty[0]), `|${' --- |'.repeat(width)}`, ...nonEmpty.slice(1).map(line)].join('\n');
    };

    // Inline content of an element on one logical line (used for headings and table cells).
    const inlineText = (el) => blocks(el).map((b) => b.text).join(' ');

    const inline = (el) => {
      const name = el.localName.toLowerCase();
      if (DROP_ELEMENTS.has(name)) return '';
      if (name === 'br') return '\\\n';
      if (name === 'en-media') return mediaMarkdown(el);
      if (name === 'en-crypt') return '[encrypted text not imported]';
      const inner = () => [...el.childNodes].map((n) => (n.nodeType === 3 || n.nodeType === 4
        ? escapeText(n.nodeValue.replace(/\s+/g, ' '))
        : (n.nodeType === 1 ? inline(n) : ''))).join('');
      const wrap = (mark) => { const t = inner(); return t.trim() ? `${t.match(/^\s*/)[0]}${mark}${t.trim()}${mark}${t.match(/\s*$/)[0]}` : t; };
      if (name === 'b' || name === 'strong') return wrap('**');
      if (name === 'i' || name === 'em') return wrap('*');
      if (name === 'strike' || name === 's' || name === 'del') return wrap('~~');
      if (name === 'code') {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (!t) return '';
        const fence = '`'.repeat(Math.max(1, ...(t.match(/`+/g) || ['']).map((m) => m.length + 1)));
        return `${fence}${/^`|`$/.test(t) ? ` ${t} ` : t}${fence}`;
      }
      if (name === 'a') {
        const text = inner().trim();
        const href = String(el.getAttribute('href') || '').trim();
        if (!/^(?:https?:|mailto:)/i.test(href) || /[\u0000-\u001f\u007f\s<>]/.test(href)) return text;
        const target = href.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
        return `[${text || escapeText(href)}](${target})`;
      }
      return inner();
    };

    const BLOCK = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'table', 'blockquote', 'center', 'hr']);

    /** Child nodes -> [{ text, task }] with inline runs merged into paragraphs. */
    function blocks(parent) {
      const out = [];
      let run = '';
      let task = null;
      const flush = () => {
        const text = run.replace(/(?:\\\n)+$/, '').replace(/[ \t]+\n/g, '\n').replace(/^(\\\n)+/, '').trim();
        if (text) {
          const safe = text.split('\n').map((l) => (/^\s*(?:[#>+-]|\d+[.)])(?:\s|$)/.test(l) ? `\\${l.trimStart()}` : l)).join('\n');
          out.push(task ? { text: `- [${task}] ${text}`, task: true } : { text: safe, task: false });
        } else if (task) {
          out.push({ text: `- [${task}]`, task: true });
        }
        run = '';
        task = null;
      };
      for (const node of parent.childNodes) {
        if (node.nodeType === 3 || node.nodeType === 4) {
          run += escapeText(node.nodeValue.replace(/\s+/g, ' '));
          continue;
        }
        if (node.nodeType !== 1) continue;
        const name = node.localName.toLowerCase();
        if (DROP_ELEMENTS.has(name)) continue;
        if (name === 'en-todo') {
          flush();
          task = node.getAttribute('checked') === 'true' ? 'x' : ' ';
        } else if (BLOCK.has(name)) {
          flush();
          if (/^h[1-6]$/.test(name)) {
            const text = inlineText(node).trim();
            if (text) out.push({ text: `${'#'.repeat(Number(name[1]))} ${text}`, task: false });
          } else if (name === 'ul' || name === 'ol') {
            const items = [...node.children].filter((c) => c.localName.toLowerCase() === 'li').map((li, i) => {
              const inner = blocks(li);
              if (!inner.length) return '';
              const marker = name === 'ol' ? `${i + 1}. ` : '- ';
              const pad = ' '.repeat(marker.length);
              const lines = inner.map((b, k) => (k ? `${b.list ? '\n' : '\n\n'}${b.text}` : b.text)).join('').split('\n');
              if (inner[0].task) return lines.map((l, j) => (j === 0 ? l : `${pad}${l}`)).join('\n');
              return lines.map((l, j) => (j === 0 ? `${marker}${l}` : (l ? `${pad}${l}` : l))).join('\n');
            }).filter(Boolean);
            if (items.length) out.push({ text: items.join('\n'), task: false, list: true });
          } else if (name === 'pre') {
            const text = node.textContent.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
            const fence = fenceFor(text);
            if (text) out.push({ text: `${fence}\n${text}\n${fence}`, task: false });
          } else if (name === 'table') {
            const text = tableMarkdown(node);
            if (text) out.push({ text, task: false });
          } else if (name === 'hr') {
            out.push({ text: '---', task: false });
          } else {
            out.push(...blocks(node));
          }
        } else {
          run += inline(node);
        }
      }
      flush();
      return out;
    }

    const parts = blocks(root);
    let text = '';
    parts.forEach((b, i) => {
      if (i) text += parts[i - 1].task && b.task ? '\n' : '\n\n';
      text += b.text;
    });
    return text;
  }

  // ---- notes --------------------------------------------------------------------------------------------------

  function childText(el, name) {
    for (const c of el.children) if (c.localName === name) return c.textContent;
    return null;
  }

  function enexDate(value, now) {
    const m = /^\s*(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\s*$/.exec(String(value || ''));
    const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
    if (!Number.isFinite(ms) || ms <= 0 || ms > now.getTime() + DAY_MS) return null;
    return new Date(ms).toISOString();
  }

  function decodeBase64(text) {
    const clean = text.replace(/\s+/g, '');
    if (clean.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(clean)) return null;
    try {
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch (err) { return null; }
  }

  function fileNameFor(raw, mime, index, taken) {
    let name = stripControl(raw || '').replace(/[\\/]+/g, '_').trim();
    if (!name || name === '.' || name === '..') name = `attachment-${index}${EXT[mime] ? `.${EXT[mime]}` : ''}`;
    while (byteLength(name) > MAX_NAME_BYTES) name = [...name].slice(0, -1).join('');
    let unique = name;
    for (let n = 2; taken.has(unique.toLowerCase()); n += 1) {
      const dot = name.lastIndexOf('.');
      unique = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    }
    taken.add(unique.toLowerCase());
    return unique;
  }

  function isChecklist(body) {
    const lines = body.split('\n').filter((l) => l.trim());
    return lines.length > 0 && lines.every((l) => /^- \[[ x]\](?: |$)/.test(l));
  }

  function convertNote(noteEl, source, now, skipped) {
    let weight = 0;
    for (const c of noteEl.children) weight += c.textContent.length;
    if (weight > MAX_NOTE_ELEMENT_BYTES) return { skip: 'note larger than 80 MiB' };

    let title = stripControl(childText(noteEl, 'title') || '').trim();
    const titleManual = !!title;
    title = [...(title || 'Untitled')].slice(0, MAX_TITLE_CHARS).join('');

    const tagSet = new Map();
    for (const c of noteEl.children) {
      if (c.localName !== 'tag') continue;
      const clean = stripControl(c.textContent).trim();
      if (clean && [...clean].length <= MAX_TAG_CHARS && tagSet.size < MAX_TAGS) tagSet.set(clean.toLowerCase(), clean);
    }

    const resources = [];
    const taken = new Set();
    let dropped = 0;
    for (const c of noteEl.children) {
      if (c.localName !== 'resource') continue;
      if (resources.length >= MAX_RESOURCES_PER_NOTE) { dropped += 1; continue; }
      const dataEl = [...c.children].find((x) => x.localName === 'data');
      const raw = dataEl ? dataEl.textContent : '';
      if ((raw.length * 3) / 4 > MAX_ATTACHMENT_BYTES * 1.01) { skipped.push({ name: source, reason: `attachment over ${MAX_ATTACHMENT_BYTES / 1048576} MiB` }); continue; }
      const bytes = decodeBase64(raw);
      if (!bytes || !bytes.length) continue;
      if (bytes.length > MAX_ATTACHMENT_BYTES) { skipped.push({ name: source, reason: `attachment over ${MAX_ATTACHMENT_BYTES / 1048576} MiB` }); continue; }
      const rawMime = String(childText(c, 'mime') || '').trim().toLowerCase();
      const mime = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(rawMime) ? rawMime : 'application/octet-stream';
      const attrs = [...c.children].find((x) => x.localName === 'resource-attributes');
      const name = fileNameFor(attrs ? childText(attrs, 'file-name') : '', mime, resources.length + 1, taken);
      let hash = null;
      resources.push({ name, mime, bytes, hash: () => { if (hash === null) hash = md5Hex(bytes); return hash; } });
    }

    let content = '';
    const contentEl = [...noteEl.children].find((x) => x.localName === 'content');
    if (contentEl && contentEl.textContent.trim()) {
      try {
        content = convertEnml(contentEl.textContent, resources, source);
      } catch (err) {
        if (/DOCTYPE or entity/.test(err.message) || /nested deeper/.test(err.message)) throw err;
        return { skip: 'content is not valid ENML' };
      }
    }
    const attrsEl = [...noteEl.children].find((x) => x.localName === 'note-attributes');
    const sourceUrl = stripControl(attrsEl ? childText(attrsEl, 'source-url') || '' : '').trim().slice(0, 2000);
    if (sourceUrl) content += `${content ? '\n\n' : ''}Source: ${escapeText(sourceUrl)}`;

    const created = enexDate(childText(noteEl, 'created'), now) || now.toISOString();
    return {
      note: {
        source,
        title,
        titleManual,
        content,
        editor: isChecklist(content) ? 'checklist' : 'markdown',
        tags: [...tagSet.values()],
        created_at: created,
        updated_at: enexDate(childText(noteEl, 'updated'), now) || created,
        attachments: resources.map((r) => ({ name: r.name, mime: r.mime, bytes: r.bytes })),
      },
      dropped,
    };
  }

  function parseFile(name, bytes, now, notes, skipped) {
    if (bytes.length > MAX_ENEX_BYTES) throw new Error(`Import refused: ${name} is larger than 256 MiB.`);
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    // Both fixed Evernote DOCTYPEs are cut for the scan; the ENEX one is also cut from the parsed text.
    cutDeclarations(text.replace(ENML_DOCTYPE, ''), ENEX_DOCTYPE, name);
    const doc = parseXml(text.replace(ENEX_DOCTYPE, ''), name);
    if (doc.documentElement.localName !== 'en-export') throw new Error(`Import refused: ${name} is not an Evernote export.`);
    const noteEls = [...doc.documentElement.children].filter((c) => c.localName === 'note');
    if (notes.length + noteEls.length > MAX_NOTES) throw new Error(`Import refused: more than ${MAX_NOTES} notes.`);
    let index = 0;
    for (const noteEl of noteEls) {
      index += 1;
      const result = convertNote(noteEl, name, now, skipped);
      if (result.skip) { skipped.push({ name: `${name}: note ${index}`, reason: result.skip }); continue; }
      if (result.dropped) skipped.push({ name: `${name}: ${result.note.title}`, reason: `${result.dropped} attachment(s) over the limit of ${MAX_RESOURCES_PER_NOTE} per note` });
      notes.push(result.note);
    }
  }

  async function parse(files, { now = new Date() } = {}) {
    const notes = [];
    const skipped = [];
    for (const file of files || []) {
      const name = String(file.name || '');
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || 0);
      if (!/\.enex$/i.test(name)) { skipped.push({ name, reason: 'not an .enex file' }); continue; }
      parseFile(name, bytes, now, notes, skipped);
    }
    const attachmentCount = notes.reduce((n, note) => n + note.attachments.length, 0);
    return { notes, skipped, attachmentCount };
  }

  return { parse, md5Hex };
})();
if (typeof window !== 'undefined') window.NotesEnexImport = NotesEnexImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesEnexImport;
