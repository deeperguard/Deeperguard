const NotesTotp = (() => {
  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const OTP_AUTH_RE = /otpauth:\/\/(totp|hotp)\/([^\s]+)/gi;
  const TWO_FA_HEADING = /^2\s*fa\b/i;
  const TWO_FA_TITLE = /(?:^|[^A-Za-z0-9])2\s*fa\b|two[\s-]*factor|\btotp\b|authenticators?/i;

  function normalizeTitle(title) {
    return String(title || '').trim();
  }

  function noteBody(note) {
    const raw = note && note.content ? note.content.content : '';
    if (raw == null) return '';
    if (typeof raw === 'object') {
      try { return JSON.stringify(raw); } catch (err) { return ''; }
    }
    return String(raw);
  }

  function tagTitleMap(tags) {
    const map = new Map();
    for (const tag of tags || []) {
      const uuid = tag && tag.uuid;
      if (!uuid) continue;
      map.set(uuid, String(tag.content && tag.content.title || tag.title || ''));
    }
    return map;
  }

  function noteHasTwoFaTag(note, tagMap) {
    if (!tagMap || !tagMap.size) return false;
    for (const id of (note && note.content && note.content.tags) || []) {
      if (TWO_FA_TITLE.test(tagMap.get(id) || '')) return true;
    }
    return false;
  }

  function walkJsonText(node, parts) {
    if (node == null) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walkJsonText(child, parts);
      return;
    }
    const type = String(node.type || '');
    if (type === 'hardBreak' || type === 'break') {
      parts.push('\n');
      return;
    }
    if (typeof node.text === 'string') parts.push(node.text);
    const kids = Array.isArray(node.content)
      ? node.content
      : Array.isArray(node.children) ? node.children : null;
    if (!kids) return;
    for (const child of kids) walkJsonText(child, parts);
    if (
      type === 'paragraph'
      || type === 'heading'
      || type === 'listItem'
      || type === 'tableRow'
      || type === 'blockquote'
      || type === 'codeBlock'
    ) {
      parts.push('\n');
    }
  }

  function tokenEntriesFromUnknown(data) {
    if (!data) return [];
    if (Array.isArray(data)) {
      const out = [];
      for (const item of data) out.push(...tokenEntriesFromUnknown(item));
      return out;
    }
    if (typeof data !== 'object') return [];
    if (data.type === 'doc' || data.type === 'paragraph' || data.type === 'text') return [];
    const secret = data.secret || data.token || data.key || data.otpSecret;
    if (looksLikeSecret(secret)) {
      return [{
        issuer: String(data.service || data.issuer || data.name || data.provider || '').trim(),
        account: String(data.account || data.username || data.user || data.login || data.email || '').trim(),
        secret,
        digits: data.digits,
        period: data.period || data.step,
        algorithm: data.algorithm,
      }];
    }
    if (Array.isArray(data.tokens)) return tokenEntriesFromUnknown(data.tokens);
    if (Array.isArray(data.entries)) return tokenEntriesFromUnknown(data.entries);
    if (Array.isArray(data.accounts)) return tokenEntriesFromUnknown(data.accounts);
    if (Array.isArray(data.items)) return tokenEntriesFromUnknown(data.items);
    return [];
  }

  function tryParseJsonPayload(text) {
    const trimmed = String(text || '').trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      return null;
    }
  }

  function stripHtml(text) {
    return String(text || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+\n/g, '\n');
  }

  function extractNoteBody(raw) {
    let text = typeof raw === 'object' && raw != null
      ? (() => { try { return JSON.stringify(raw); } catch (err) { return ''; } })()
      : String(raw || '');
    const tokens = [];
    let format = 'plain';

    const ingestJson = (value) => {
      const found = tokenEntriesFromUnknown(value);
      if (found.length) {
        tokens.push(...found);
        format = 'token-json';
        return true;
      }
      if (value && typeof value === 'object' && (value.type === 'doc' || Array.isArray(value.content))) {
        const parts = [];
        walkJsonText(value, parts);
        text = parts.join('').replace(/\n{3,}/g, '\n\n');
        format = 'super';
        return false;
      }
      return false;
    };

    const parsed = tryParseJsonPayload(text);
    if (parsed != null) {
      if (ingestJson(parsed)) return { text: '', tokens, format };
    } else if (/<[a-z][\s\S]*>/i.test(text)) {
      text = stripHtml(text);
      format = 'html';
    }

    const inner = tryParseJsonPayload(text);
    if (inner != null && ingestJson(inner) && tokens.length) {
      return { text: '', tokens, format: 'token-json' };
    }

    return { text, tokens, format };
  }

  function isTwoFaTitle(title) {
    return TWO_FA_TITLE.test(normalizeTitle(title));
  }

  function bodyLooksLikeVault(raw) {
    const source = String(raw || '');
    if (/otpauth:\/\//i.test(source)) return true;
    try {
      const extracted = extractNoteBody(source);
      if (extracted.tokens.length) return true;
      if (/otpauth:\/\//i.test(extracted.text)) return true;
    } catch (err) { /* ignore */ }
    return false;
  }

  function isTwoFaNote(note, { tags = [] } = {}) {
    if (!note || note.deleted || note.content?.type !== 'note') return false;
    if (note.content.trashed) return false;
    if (isTwoFaTitle(note.content.title)) return true;
    if (noteHasTwoFaTag(note, tagTitleMap(tags))) return true;
    return bodyLooksLikeVault(noteBody(note));
  }

  function listTwoFaNotes(notes, { tags = [] } = {}) {
    return (notes || []).filter((note) => isTwoFaNote(note, { tags }));
  }

  function decodeBase32(secret) {
    const raw = String(secret || '').toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, '');
    if (!raw || /[^A-Z2-7]/.test(raw)) return null;
    let bits = '';
    for (const ch of raw) {
      const val = BASE32_ALPHABET.indexOf(ch);
      if (val < 0) return null;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return bytes.length ? new Uint8Array(bytes) : null;
  }

  function looksLikeSecret(value, { min = 8 } = {}) {
    const raw = String(value || '').toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, '');
    return raw.length >= min && raw.length <= 128 && !/[^A-Z2-7]/.test(raw);
  }

  async function hmac(algorithm, keyBytes, dataBytes) {
    const hash = algorithm === 'SHA256' ? 'SHA-256' : algorithm === 'SHA512' ? 'SHA-512' : 'SHA-1';
    if (globalThis.crypto?.subtle) {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);
      return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
    }
    if (typeof require === 'function') {
      const nodeCrypto = require('crypto');
      const name = hash.toLowerCase().replace('-', '');
      return new Uint8Array(nodeCrypto.createHmac(name, Buffer.from(keyBytes)).update(Buffer.from(dataBytes)).digest());
    }
    throw new Error('HMAC is not available');
  }

  function counterBytes(counter) {
    const buf = new Uint8Array(8);
    let value = BigInt(counter);
    for (let i = 7; i >= 0; i -= 1) {
      buf[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    return buf;
  }

  function truncate(hmacBytes, digits) {
    const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
    const bin = ((hmacBytes[offset] & 0x7f) << 24)
      | ((hmacBytes[offset + 1] & 0xff) << 16)
      | ((hmacBytes[offset + 2] & 0xff) << 8)
      | (hmacBytes[offset + 3] & 0xff);
    const mod = 10 ** digits;
    return String(bin % mod).padStart(digits, '0');
  }

  async function generate({ secret, now = Date.now(), period = 30, digits = 6, algorithm = 'SHA1' } = {}) {
    const key = decodeBase32(secret);
    if (!key) throw new Error('Invalid authenticator secret');
    const step = Math.max(1, Number(period) || 30);
    const len = Math.min(10, Math.max(6, Number(digits) || 6));
    const counter = Math.floor(Number(now) / 1000 / step);
    const mac = await hmac(String(algorithm || 'SHA1').toUpperCase().replace('-', ''), key, counterBytes(counter));
    const remaining = step - (Math.floor(Number(now) / 1000) % step);
    return {
      code: truncate(mac, len),
      remaining,
      period: step,
      progress: remaining / step,
    };
  }

  function decodeLabel(raw) {
    let text = String(raw || '');
    try { text = decodeURIComponent(text); } catch (err) { /* keep */ }
    const slash = text.indexOf('/');
    if (slash >= 0) text = text.slice(slash + 1);
    const colon = text.indexOf(':');
    if (colon > 0) {
      return {
        issuer: text.slice(0, colon).trim(),
        account: text.slice(colon + 1).trim(),
      };
    }
    return { issuer: '', account: text.trim() };
  }

  function parseOtpauth(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return null;
    }
    if (parsed.protocol !== 'otpauth:') return null;
    const type = String(parsed.hostname || '').toLowerCase();
    if (type !== 'totp') return null;
    const secret = parsed.searchParams.get('secret') || '';
    if (!looksLikeSecret(secret)) return null;
    const label = decodeLabel(parsed.pathname.replace(/^\//, ''));
    const issuer = (parsed.searchParams.get('issuer') || label.issuer || '').trim();
    return {
      issuer,
      account: label.account || issuer || 'Account',
      secret: secret.toUpperCase().replace(/[\s\-]/g, ''),
      digits: Number(parsed.searchParams.get('digits') || 6) || 6,
      period: Number(parsed.searchParams.get('period') || 30) || 30,
      algorithm: (parsed.searchParams.get('algorithm') || 'SHA1').toUpperCase().replace('-', ''),
    };
  }

  function stripDecor(line) {
    return String(line || '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/^[`*_]+|[`*_]+$/g, '')
      .trim();
  }

  function parseLabeledLine(line) {
    const text = stripDecor(line);
    const match = text.match(/^(?:secret|key|token|code)\s*[:=]\s*(.+)$/i)
      || text.match(/^(.+?)\s*[:=|]\s*([A-Za-z2-7=\s\-]{8,})$/);
    if (!match) return null;
    if (match[2] == null) {
      const secret = match[1];
      if (!looksLikeSecret(secret)) return null;
      return { label: '', secret };
    }
    const label = stripDecor(match[1]);
    const secret = match[2];
    if (!looksLikeSecret(secret)) return null;
    if (/^(secret|key|token|code)$/i.test(label)) return { label: '', secret };
    return { label, secret };
  }

  function addEntry(entries, seen, entry, noteId) {
    if (!entry || !looksLikeSecret(entry.secret)) return;
    const secret = entry.secret.toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, '');
    const issuer = String(entry.issuer || '').trim();
    const account = String(entry.account || entry.label || issuer || 'Account').trim();
    const key = `${secret}:${issuer}:${account}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      id: `${noteId || 'note'}:${entries.length}:${secret.slice(0, 6)}`,
      noteId: noteId || '',
      issuer,
      account: account || issuer || 'Account',
      secret,
      digits: Number(entry.digits || 6) || 6,
      period: Number(entry.period || 30) || 30,
      algorithm: String(entry.algorithm || 'SHA1').toUpperCase().replace('-', ''),
    });
  }

  function parseMarkdownTables(source, entries, seen, noteId) {
    const lines = String(source || '').split('\n');
    let headers = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!/^\|.+\|/.test(line) && !/^\|/.test(line)) {
        headers = null;
        continue;
      }
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      if (!cells.length || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      if (!headers) {
        const secretIdx = cells.findIndex((cell) => looksLikeSecret(cell, { min: 16 }));
        if (secretIdx >= 0) {
          const label = cells.filter((_, i) => i !== secretIdx).join(' ').trim();
          addEntry(entries, seen, {
            issuer: label,
            account: label,
            secret: cells[secretIdx],
          }, noteId);
          headers = [];
          continue;
        }
        headers = cells.map((cell) => cell.toLowerCase());
        continue;
      }
      const get = (...names) => {
        for (const name of names) {
          const idx = headers.findIndex((header) => header === name || header.includes(name));
          if (idx >= 0 && cells[idx]) return cells[idx];
        }
        return '';
      };
      const secret = get('secret', 'token', 'key', 'otp')
        || cells.find((cell) => looksLikeSecret(cell, { min: 16 }))
        || '';
      if (!looksLikeSecret(secret)) continue;
      const issuer = get('service', 'issuer', 'name', 'provider', 'app') || cells[0] || '';
      const account = get('account', 'user', 'username', 'login', 'email') || issuer;
      addEntry(entries, seen, { issuer, account, secret }, noteId);
    }
  }

  function parseText(text, { noteId = '' } = {}) {
    const extracted = extractNoteBody(text);
    const source = String(extracted.text || '').replace(/\r\n/g, '\n');
    const entries = [];
    const seen = new Set();
    const used = new Set();

    for (const token of extracted.tokens) {
      addEntry(entries, seen, token, noteId);
      if (token && token.secret) {
        used.add(String(token.secret).toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, ''));
      }
    }

    for (const match of source.matchAll(OTP_AUTH_RE)) {
      const parsed = parseOtpauth(match[0]);
      if (!parsed) continue;
      addEntry(entries, seen, parsed, noteId);
      used.add(parsed.secret);
    }

    parseMarkdownTables(source, entries, seen, noteId);

    const lines = source.split('\n');
    let pendingLabel = '';
    let pendingIssuer = '';
    let pendingAccount = '';
    for (const raw of lines) {
      const line = stripDecor(raw);
      if (!line) {
        pendingLabel = '';
        pendingIssuer = '';
        pendingAccount = '';
        continue;
      }
      if (/^\|/.test(line)) continue;
      if (OTP_AUTH_RE.test(line)) {
        OTP_AUTH_RE.lastIndex = 0;
        pendingLabel = '';
        pendingIssuer = '';
        pendingAccount = '';
        continue;
      }
      OTP_AUTH_RE.lastIndex = 0;
      if (TWO_FA_HEADING.test(line) && line.length <= 8) continue;

      const field = line.match(/^(service|issuer|account|name|user|username|login|secret|key|token|code)\s*[:=]\s*(.+)$/i);
      if (field) {
        const kind = field[1].toLowerCase();
        const value = field[2].trim();
        if (kind === 'service' || kind === 'issuer' || kind === 'name') pendingIssuer = value;
        else if (kind === 'account' || kind === 'user' || kind === 'username' || kind === 'login') pendingAccount = value;
        else if (looksLikeSecret(value)) {
          addEntry(entries, seen, {
            issuer: pendingIssuer || pendingLabel,
            account: pendingAccount || pendingIssuer || pendingLabel,
            secret: value,
          }, noteId);
          pendingLabel = '';
          pendingIssuer = '';
          pendingAccount = '';
        }
        continue;
      }

      const labeled = parseLabeledLine(line);
      if (labeled) {
        if (used.has(labeled.secret.toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, ''))) {
          pendingLabel = labeled.label || pendingLabel;
          continue;
        }
        addEntry(entries, seen, {
          issuer: labeled.label || pendingIssuer || pendingLabel,
          account: pendingAccount || labeled.label || pendingLabel,
          secret: labeled.secret,
        }, noteId);
        pendingLabel = labeled.label || pendingLabel;
        continue;
      }

      if (looksLikeSecret(line, { min: 16 })) {
        const secret = line;
        const normalized = secret.toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, '');
        if (!used.has(normalized)) {
          addEntry(entries, seen, {
            issuer: pendingIssuer || pendingLabel,
            account: pendingAccount || pendingIssuer || pendingLabel,
            secret,
          }, noteId);
        }
        pendingLabel = '';
        pendingIssuer = '';
        pendingAccount = '';
        continue;
      }
      pendingLabel = line;
    }

    return entries;
  }

  function parseNotes(notes, { tags = [] } = {}) {
    const list = listTwoFaNotes(notes, { tags });
    const entries = [];
    const sources = [];
    for (const note of list) {
      const raw = noteBody(note);
      let extracted = { text: '', tokens: [], format: 'plain' };
      try {
        extracted = extractNoteBody(raw);
      } catch (err) { /* keep empty extract */ }
      const parsed = parseText(raw, { noteId: note.uuid });
      sources.push({
        uuid: note.uuid,
        title: normalizeTitle(note.content.title) || '2FA',
        chars: raw.length,
        lines: String(extracted.text || '').split('\n').length,
        format: extracted.format,
        secrets: parsed.length,
      });
      entries.push(...parsed);
    }
    entries.sort((a, b) => {
      const left = `${a.issuer} ${a.account}`.toLowerCase();
      const right = `${b.issuer} ${b.account}`.toLowerCase();
      return left.localeCompare(right);
    });
    return { notes: sources, entries };
  }

  function normalizeSecret(secret) {
    return String(secret || '').toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, '');
  }

  function entryFromFields({ issuer = '', account = '', secret = '', digits, period, algorithm } = {}) {
    const raw = String(secret || '').trim();
    if (/otpauth:\/\//i.test(raw)) {
      OTP_AUTH_RE.lastIndex = 0;
      const match = raw.match(OTP_AUTH_RE);
      OTP_AUTH_RE.lastIndex = 0;
      const parsed = parseOtpauth(match ? match[0] : raw);
      if (!parsed) return null;
      return {
        ...parsed,
        issuer: String(issuer || parsed.issuer || '').trim(),
        account: String(account || parsed.account || parsed.issuer || 'Account').trim() || 'Account',
      };
    }
    if (!looksLikeSecret(raw)) return null;
    const iss = String(issuer || '').trim();
    return {
      issuer: iss,
      account: String(account || iss || 'Account').trim() || 'Account',
      secret: normalizeSecret(raw),
      digits: Number(digits || 6) || 6,
      period: Number(period || 30) || 30,
      algorithm: String(algorithm || 'SHA1').toUpperCase().replace('-', ''),
    };
  }

  function isDeletableTwoFaNote(note) {
    if (!note || note.deleted || note.content?.type !== 'note') return false;
    if (note.content.trashed) return false;
    return /(?:^|[^A-Za-z0-9])2\s*fa\b/i.test(normalizeTitle(note.content.title));
  }

  function isDedicatedTwoFaNote(note, { tags = [] } = {}) {
    if (!note || note.deleted || note.content?.type !== 'note') return false;
    if (note.content.trashed) return false;
    if (isTwoFaTitle(note.content.title)) return true;
    return noteHasTwoFaTag(note, tagTitleMap(tags));
  }

  function migrateFromNotes(notes, existing = [], { tags = [] } = {}) {
    // Include notes that store otpauth/secrets in the body (not only "2FA" title/tag).
    const sources = listTwoFaNotes(notes, { tags });
    const have = new Set((existing || []).map((entry) => normalizeSecret(entry.secret)).filter(Boolean));
    const toAdd = [];
    for (const note of sources) {
      for (const entry of parseText(noteBody(note), { noteId: note.uuid })) {
        const key = normalizeSecret(entry.secret);
        if (!key || have.has(key)) continue;
        have.add(key);
        toAdd.push(entry);
      }
    }
    const noteIds = [];
    for (const note of sources) {
      if (!isDeletableTwoFaNote(note)) continue;
      const raw = noteBody(note).trim();
      const parsed = parseText(raw, { noteId: note.uuid });
      if (!raw || (parsed.length && parsed.every((entry) => have.has(normalizeSecret(entry.secret))))) {
        noteIds.push(note.uuid);
      }
    }
    return { toAdd, noteIds };
  }

  function labelScore(entry) {
    const issuer = String(entry && entry.issuer || '').trim();
    const account = String(entry && entry.account || '').trim();
    let score = 0;
    if (issuer) score += 2;
    if (account && account.toLowerCase() !== issuer.toLowerCase()) score += 2;
    else if (account) score += 1;
    return score;
  }

  function planDedupe(entries) {
    const groups = new Map();
    for (const entry of entries || []) {
      const key = normalizeSecret(entry && entry.secret);
      if (!key) continue;
      const list = groups.get(key) || [];
      list.push(entry);
      groups.set(key, list);
    }
    const keep = [];
    const removeIds = [];
    for (const list of groups.values()) {
      list.sort((a, b) => {
        const byScore = labelScore(b) - labelScore(a);
        if (byScore) return byScore;
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
      });
      keep.push(list[0]);
      for (const extra of list.slice(1)) {
        if (extra && extra.id) removeIds.push(extra.id);
      }
    }
    keep.sort((a, b) => {
      const left = `${a.issuer || ''} ${a.account || ''}`.toLowerCase();
      const right = `${b.issuer || ''} ${b.account || ''}`.toLowerCase();
      return left.localeCompare(right);
    });
    return { keep, removeIds };
  }

  return {
    isTwoFaNote,
    isDedicatedTwoFaNote,
    isDeletableTwoFaNote,
    listTwoFaNotes,
    decodeBase32,
    looksLikeSecret,
    parseOtpauth,
    parseText,
    parseNotes,
    extractNoteBody,
    entryFromFields,
    migrateFromNotes,
    planDedupe,
    normalizeSecret,
    generate,
  };
})();

if (typeof window !== 'undefined') window.NotesTotp = NotesTotp;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesTotp;
