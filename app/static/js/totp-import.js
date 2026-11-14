// 2FA import: otpauth list, plain Aegis JSON, plain 2FAS JSON (docs/2FA_IMPORT_SPEC.md, section 3).
// Input is untrusted. Errors are generic codes and never contain input. Nothing here logs,
// stores or sends data; secrets only leave through the returned entries.
const NotesTotpImport = (() => {
  const Totp = (typeof NotesTotp !== 'undefined') ? NotesTotp : require('./totp.js');
  const LIMITS = { maxChars: 5 * 1024 * 1024, maxEntries: 2000, maxDepth: 32, maxMigrationData: 4096, maxBatches: 50 };
  const ALGOS = { SHA1: 'SHA1', 'SHA-1': 'SHA1', SHA256: 'SHA256', 'SHA-256': 'SHA256', SHA512: 'SHA512', 'SHA-512': 'SHA512' };

  const MESSAGES = {
    empty: 'Nothing to import.',
    too_large: 'That file is too large to import.',
    too_many: 'That file has too many accounts to import.',
    unknown: 'Unknown or damaged import format.',
    invalid: 'Unknown or damaged import format.',
    encrypted: 'This export is encrypted. Enter its password.',
    bad_password: 'Wrong password or damaged file',
    kdf_limit: 'This file asks for more computing power than we allow, so it was not opened.',
    no_slot: 'This Aegis backup has no password slot',
    cancelled: 'Cancelled.',
    none: 'No importable accounts were found.',
    migration_invalid: 'This Google Authenticator export code is damaged or not supported.',
    mixed_batches: 'These codes come from different Google Authenticator exports. Import one export at a time.',
  };
  const SKIP_MESSAGES = {
    invalid: 'Invalid entry',
    hotp: 'HOTP not supported yet',
    unsupported: 'Unsupported type',
    md5: 'Algorithm MD5 not supported',
  };

  function fail(error) { return { ok: false, error, message: MESSAGES[error] || MESSAGES.invalid }; }

  function jsonDepthOk(src, max) {
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < src.length; i += 1) {
      const c = src.charCodeAt(i);
      if (inStr) {
        if (c === 92) i += 1;
        else if (c === 34) inStr = false;
      } else if (c === 34) inStr = true;
      else if (c === 123 || c === 91) { depth += 1; if (depth > max) return false; }
      else if (c === 125 || c === 93) depth -= 1;
    }
    return true;
  }

  function clean(value, max) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
  }

  function intIn(value, min, max, dflt) {
    if (value == null || value === '') return dflt;
    const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
  }

  // Validate one raw account. Returns { entry } or { skip: reasonCode }.
  function buildEntry(raw) {
    const type = String(raw.type || 'TOTP').toLowerCase();
    if (type === 'hotp') return { skip: 'hotp' };
    if (type !== 'totp') return { skip: 'unsupported' };
    const secret = typeof raw.secret === 'string' ? raw.secret.toUpperCase().replace(/[\s\-]/g, '').replace(/=+$/g, '') : '';
    const bytes = secret.length >= 8 && secret.length <= 256 ? Totp.decodeBase32(secret) : null;
    if (!bytes || bytes.length > 128) return { skip: 'invalid' };
    const algorithm = ALGOS[String(raw.algorithm || 'SHA1').toUpperCase()];
    const digits = intIn(raw.digits, 6, 8, 6);
    const period = intIn(raw.period, 1, 300, 30);
    if (!algorithm || digits == null || period == null) return { skip: 'invalid' };
    const issuer = clean(raw.issuer, 128);
    const account = clean(raw.account, 256) || issuer || 'Account';
    const entry = { issuer, account, secret, digits, period, algorithm, otp_type: 'totp' };
    const tags = Totp.normalizeTags ? Totp.normalizeTags(Array.isArray(raw.tags) ? raw.tags : []) : [];
    if (tags.length) entry.tags = tags;
    return { entry };
  }

  function parseOtpauthList(input) {
    const lines = input.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length > LIMITS.maxEntries) return fail('too_many');
    const entries = [];
    const skipped = [];
    for (const line of lines) {
      const res = Totp.parseOtpauthStrict(line);
      if (!res.ok) skipped.push(res.reason === 'hotp-counter' ? 'hotp' : 'invalid');
      else if (res.entry.otp_type === 'hotp') skipped.push('hotp');
      else entries.push(res.entry);
    }
    return { ok: true, format: 'otpauth', entries, skipped };
  }

  function parseJsonRoot(input) {
    if (!jsonDepthOk(input, LIMITS.maxDepth)) return null;
    try {
      const data = JSON.parse(input);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (err) {
      return null;
    }
  }

  function collect(list, mapper) {
    if (!Array.isArray(list)) return null;
    const entries = [];
    const skipped = [];
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { skipped.push('invalid'); continue; }
      const built = buildEntry(mapper(item));
      if (built.entry) entries.push(built.entry);
      else skipped.push(built.skip);
    }
    return { entries, skipped };
  }

  function parseAegis(data) {
    const db = data.db;
    if (typeof db === 'string' || (data.header && (data.header.slots || data.header.params))) {
      return Object.assign(fail('encrypted'), { format: 'aegis' });
    }
    if (data.version !== 1 || !db || typeof db !== 'object' || ![1, 2, 3].includes(db.version)) return fail('invalid');
    if (Array.isArray(db.entries) && db.entries.length > LIMITS.maxEntries) return fail('too_many');
    // db v3: entry.groups holds uuids into db.groups[{uuid,name}]; db v2: entry.group is a name.
    const groupNames = new Map();
    for (const g of Array.isArray(db.groups) ? db.groups : []) {
      if (g && typeof g.uuid === 'string' && typeof g.name === 'string') groupNames.set(g.uuid, g.name);
    }
    const res = collect(db.entries, (e) => {
      const info = e.info && typeof e.info === 'object' ? e.info : {};
      const tags = [];
      if (e.favorite === true) tags.push('Favourite');
      if (typeof e.group === 'string') tags.push(e.group);
      for (const id of Array.isArray(e.groups) ? e.groups : []) {
        if (groupNames.has(id)) tags.push(groupNames.get(id));
      }
      return {
        type: e.type, issuer: e.issuer, account: e.name,
        secret: info.secret, algorithm: info.algo, digits: info.digits, period: info.period, tags,
      };
    });
    if (!res) return fail('invalid');
    return { ok: true, format: 'aegis', entries: res.entries, skipped: res.skipped };
  }

  function parse2fas(data) {
    const hasServices = Array.isArray(data.services) && data.services.length > 0;
    if (typeof data.servicesEncrypted === 'string' && data.servicesEncrypted && !hasServices) {
      return Object.assign(fail('encrypted'), { format: '2fas' });
    }
    if (![3, 4].includes(data.schemaVersion)) return fail('invalid');
    if (Array.isArray(data.services) && data.services.length > LIMITS.maxEntries) return fail('too_many');
    const groupNames = new Map();
    for (const g of Array.isArray(data.groups) ? data.groups : []) {
      if (g && typeof g.id === 'string' && typeof g.name === 'string') groupNames.set(g.id, g.name);
    }
    const res = collect(data.services, (s) => {
      const otp = s.otp && typeof s.otp === 'object' ? s.otp : {};
      const tags = typeof s.groupId === 'string' && groupNames.has(s.groupId) ? [groupNames.get(s.groupId)] : [];
      return {
        type: otp.tokenType, secret: s.secret,
        issuer: otp.issuer || s.name, account: otp.account || otp.label,
        algorithm: otp.algorithm, digits: otp.digits, period: otp.period, tags,
      };
    });
    if (!res) return fail('invalid');
    return { ok: true, format: '2fas', entries: res.entries, skipped: res.skipped };
  }

  // ---- Google Authenticator otpauth-migration:// (spec 3.4) ----
  // Minimal protobuf reader: varint (0) and length-delimited (2); fixed 64/32-bit (1/5) are
  // skipped; groups (3/4), truncation and varints over 10 bytes throw, refusing the batch.
  const MIGRATION_RE = /^otpauth-migration:\/\/offline\?/i;
  function isMigration(text) { return MIGRATION_RE.test(String(text || '').trim()); }

  function pbFields(buf, start, end, onField) {
    let pos = start;
    const varint = () => {
      let v = 0n;
      for (let i = 0; i < 10; i += 1) {
        if (pos >= end) throw new Error('pb');
        const b = buf[pos];
        pos += 1;
        v |= BigInt(b & 0x7f) << BigInt(7 * i);
        if (!(b & 0x80)) return v;
      }
      throw new Error('pb');
    };
    while (pos < end) {
      const key = varint();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      if (field === 0) throw new Error('pb');
      if (wire === 0) onField(field, 0, varint());
      else if (wire === 2) {
        const len = varint();
        if (len > BigInt(end - pos)) throw new Error('pb');
        const from = pos;
        pos += Number(len);
        onField(field, 2, from, pos);
      } else if (wire === 1 || wire === 5) {
        pos += wire === 1 ? 8 : 4;
        if (pos > end) throw new Error('pb');
      } else throw new Error('pb');
    }
  }

  // int32 values arrive as varints; negative numbers use 10 bytes.
  function int32(v) {
    const n = BigInt.asIntN(64, v);
    return n >= -2147483648n && n <= 2147483647n ? Number(n) : null;
  }

  function base32(bytes) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let out = '';
    let bits = 0;
    let acc = 0;
    for (const b of bytes) {
      acc = ((acc << 8) | b) & 0xffff;
      bits += 8;
      while (bits >= 5) { out += A[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += A[(acc << (5 - bits)) & 31];
    return out;
  }

  function utf8(buf, a, b) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(a, b)); } catch (e) { return null; }
  }

  function decodeBase64(text) {
    let s = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return null;
    while (s.length % 4) s += '=';
    let bin;
    try { bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'); } catch (e) { return null; }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  // One OtpParameters message -> { entry } or { skip }. Enums map to our model; unsupported
  // values are skipped with a reason that the preview lists.
  function migrationEntry(buf, a, b) {
    const p = { secret: null, name: '', issuer: '', algorithm: 0, digits: 0, type: 0, counter: 0n };
    pbFields(buf, a, b, (field, wire, x, y) => {
      if (field === 1 && wire === 2) p.secret = buf.slice(x, y);
      else if ((field === 2 || field === 3) && wire === 2) {
        const str = utf8(buf, x, y);
        if (str == null) throw new Error('pb');
        p[field === 2 ? 'name' : 'issuer'] = str;
      } else if (field >= 4 && field <= 6 && wire === 0) p[['algorithm', 'digits', 'type'][field - 4]] = int32(x);
      else if (field === 7 && wire === 0) p.counter = BigInt.asIntN(64, x);
    });
    try {
      if (p.type === 1) {
        // HOTP: the counter is read and validated, but HOTP accounts are not imported yet (same
        // as the otpauth list import), so they are listed as skipped instead of giving wrong codes.
        if (p.counter < 0n || p.counter > BigInt(Number.MAX_SAFE_INTEGER)) return { skip: 'invalid' };
        return { skip: 'hotp', counter: Number(p.counter) };
      }
      if (p.type !== 2) return { skip: 'unsupported' };
      if (p.algorithm === 4) return { skip: 'md5' };
      const algorithm = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }[p.algorithm];
      const digits = { 0: 6, 1: 6, 2: 8 }[p.digits];
      if (!algorithm || !digits) return { skip: 'unsupported' };
      if (!p.secret || p.secret.length < 10 || p.secret.length > 128) return { skip: 'invalid' };
      let issuer = clean(p.issuer, 128);
      let account = clean(p.name, 256);
      const colon = account.indexOf(':');
      if (colon > 0) {
        const head = account.slice(0, colon).trim();
        if (!issuer) issuer = head;
        if (head === issuer) account = account.slice(colon + 1).trim();
      }
      return buildEntry({ type: 'totp', secret: base32(p.secret), issuer, account, algorithm, digits, period: 30 });
    } finally {
      if (p.secret) p.secret.fill(0);
    }
  }

  // Decode one otpauth-migration URI -> { ok, format, batch:{id,size,index}, entries, skipped }.
  function decodeMigration(uri) {
    const text = String(uri || '').trim();
    if (!isMigration(text) || text.length > LIMITS.maxMigrationData * 3 + 64) return fail('migration_invalid');
    const query = text.slice(text.indexOf('?') + 1).split('#')[0];
    const data = query.split('&').filter((kv) => kv.split('=')[0].toLowerCase() === 'data');
    if (data.length !== 1) return fail('migration_invalid');
    let b64;
    // Not URLSearchParams: it turns '+' (valid base64) into a space.
    try { b64 = decodeURIComponent(data[0].slice(data[0].indexOf('=') + 1)); } catch (e) { return fail('migration_invalid'); }
    if (!b64 || b64.length > LIMITS.maxMigrationData) return fail('migration_invalid');
    const buf = decodeBase64(b64);
    if (!buf || !buf.length) return fail('migration_invalid');
    const ranges = [];
    const batch = { size: 1, index: 0, id: '0' };
    try {
      pbFields(buf, 0, buf.length, (field, wire, x, y) => {
        if (field === 1 && wire === 2) {
          if (ranges.length >= LIMITS.maxEntries) throw new Error('pb');
          ranges.push([x, y]);
        } else if (field === 3 && wire === 0) batch.size = int32(x);
        else if (field === 4 && wire === 0) batch.index = int32(x);
        else if (field === 5 && wire === 0) batch.id = String(BigInt.asIntN(64, x));
      });
      if (batch.size === 0) batch.size = 1;
      if (batch.size == null || batch.index == null || batch.size < 1 || batch.size > LIMITS.maxBatches
        || batch.index < 0 || batch.index >= batch.size) throw new Error('pb');
      const entries = [];
      const skipped = [];
      for (const [x, y] of ranges) {
        const built = migrationEntry(buf, x, y);
        if (built.entry) entries.push(built.entry);
        else skipped.push(built.skip);
      }
      return { ok: true, format: 'google', batch, entries, skipped };
    } catch (e) {
      return fail('migration_invalid');
    } finally {
      buf.fill(0);
    }
  }

  // Collects the QR codes of one export. add() never replaces the collection: a code from another
  // export is refused ('other_batch'), so codes scanned before are never dropped silently.
  function createMigrationCollector() {
    let id = null;
    let size = 0;
    let total = 0;
    const batches = new Map();
    const progress = () => ({ have: batches.size, size, complete: size > 0 && batches.size === size });
    const status = (s, extra) => Object.assign({ status: s }, extra || {}, progress());
    return {
      add(uri) {
        const res = decodeMigration(uri);
        if (!res.ok) return status('invalid', { message: res.message });
        const b = res.batch;
        if (id !== null && (b.id !== id || b.size !== size)) return status('other_batch', { message: MESSAGES.mixed_batches });
        if (batches.has(b.index)) return status('duplicate');
        const count = res.entries.length + res.skipped.length;
        if (total + count > LIMITS.maxEntries) return status('too_many', { message: MESSAGES.too_many });
        id = b.id;
        size = b.size;
        total += count;
        batches.set(b.index, res);
        return status('added');
      },
      progress,
      // Merged result in batch order. `incomplete: {have, size}` when codes are missing.
      result() {
        const p = progress();
        const entries = [];
        const skipped = [];
        [...batches.keys()].sort((x, y) => x - y).forEach((k) => {
          entries.push(...batches.get(k).entries);
          skipped.push(...batches.get(k).skipped);
        });
        if (!entries.length && !skipped.length) return fail('none');
        return { ok: true, format: 'google', entries, skipped, incomplete: p.complete ? null : { have: p.have, size: p.size } };
      },
      reset() { id = null; size = 0; total = 0; batches.clear(); },
    };
  }

  // Pasted text with one or more migration URIs. Mixed exports are refused; missing codes are
  // reported through `incomplete` so the preview can warn.
  function parseMigrationList(input) {
    const lines = input.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length > LIMITS.maxBatches) return fail('too_many');
    const collector = createMigrationCollector();
    for (const line of lines) {
      if (!isMigration(line)) return fail('invalid');
      const r = collector.add(line);
      if (r.status === 'invalid') return fail('migration_invalid');
      if (r.status === 'other_batch') return fail('mixed_batches');
      if (r.status === 'too_many') return fail('too_many');
    }
    return collector.result();
  }

  // Detect by content, then parse. Returns { ok, format, entries, skipped[] } or { ok:false, error, message }.
  function parse(input) {
    if (typeof input !== 'string') return fail('invalid');
    const trimmed = input.replace(/^﻿/, '').trim();
    if (!trimmed) return fail('empty');
    if (trimmed.length > LIMITS.maxChars) return fail('too_large');
    let res;
    if (trimmed.startsWith('{')) {
      const data = parseJsonRoot(trimmed);
      if (!data) return fail('invalid');
      if ('header' in data && 'db' in data) res = parseAegis(data);
      else if ('services' in data || 'servicesEncrypted' in data) res = parse2fas(data);
      else return fail('unknown');
    } else if (/^otpauth-migration:\/\//im.test(trimmed)) {
      res = parseMigrationList(trimmed);
    } else if (/^otpauth:\/\//im.test(trimmed)) {
      res = parseOtpauthList(trimmed);
    } else {
      return fail('unknown');
    }
    if (!res.ok) return res;
    if (!res.entries.length && !res.skipped.length) return fail('none');
    return res;
  }

  // Encrypted Aegis / 2FAS. The KDF and decryption run in kdf-worker.js (own CSP). `run(job)` returns
  // a promise of {ok, text} or {ok:false, code}; the default starts a worker that handle.cancel()
  // stops. The password is encoded here and only lives in the job buffer, which the worker zeroes.
  // Nothing is stored, logged or sent.
  function defaultRun(handle) {
    return (job) => new Promise((resolve) => {
      const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="notes-kdf-worker"]') : null;
      let worker;
      try { worker = new Worker((meta && meta.getAttribute('content')) || '/static/js/kdf-worker.js'); } catch (e) { resolve({ ok: false, code: 'bad_password' }); return; }
      const done = (res) => { try { worker.terminate(); } catch (e) { /* ignore */ } handle.cancel = null; resolve(res); };
      handle.cancel = () => done({ ok: false, code: 'cancelled' });
      worker.onmessage = (ev) => done(ev.data && ev.data.ok ? { ok: true, text: ev.data.text } : { ok: false, code: (ev.data && ev.data.code) || 'bad_password' });
      worker.onerror = () => done({ ok: false, code: 'bad_password' });
      worker.postMessage(job, [job.password.buffer]);
    });
  }

  async function decryptAndParse(input, password, opts) {
    const first = parse(input);
    if (first.error !== 'encrypted') return first;
    const root = parseJsonRoot(String(input).replace(/^﻿/, '').trim());
    const handle = (opts && opts.handle) || {};
    const run = (opts && opts.run) || defaultRun(handle);
    const bytes = new TextEncoder().encode(String(password || ''));
    const data = first.format === 'aegis'
      ? { slots: root.header && root.header.slots, params: root.header && root.header.params, db: root.db }
      : { servicesEncrypted: root.servicesEncrypted, reference: root.reference, iterations: root.iterations };
    let out;
    try { out = await run({ id: 1, format: first.format, password: bytes, data }); } finally { bytes.fill(0); }
    if (!out || !out.ok) return fail(out && MESSAGES[out.code] ? out.code : 'bad_password');
    let inner = null;
    if (!jsonDepthOk(out.text, LIMITS.maxDepth)) return fail('bad_password');
    try { inner = JSON.parse(out.text); } catch (e) { return fail('bad_password'); }
    out.text = '';
    let res;
    if (first.format === 'aegis') {
      res = inner && typeof inner === 'object' ? parseAegis({ version: root.version, db: inner }) : fail('bad_password');
    } else {
      res = Array.isArray(inner) ? parse2fas({ schemaVersion: root.schemaVersion, services: inner, groups: root.groups }) : fail('bad_password');
    }
    if (!res.ok) return res;
    if (!res.entries.length && !res.skipped.length) return fail('none');
    return res;
  }

  function norm(secret) { return Totp.normalizeSecret ? Totp.normalizeSecret(secret) : String(secret); }

  // Rows for the preview. `existingSecrets` is an iterable of vault secrets. Duplicates against
  // the vault and within the file are flagged. Rows carry the entry for saving; render only
  // previewRows() output.
  function plan(entries, existingSecrets) {
    const seen = new Set();
    for (const s of existingSecrets || []) seen.add(norm(s));
    return entries.map((entry) => {
      const key = norm(entry.secret);
      const duplicate = seen.has(key);
      seen.add(key);
      return { entry, duplicate };
    });
  }

  function previewRows(rows) {
    return rows.map((r) => ({ issuer: r.entry.issuer, account: r.entry.account, tags: r.entry.tags || [], duplicate: r.duplicate }));
  }

  return {
    LIMITS, MESSAGES, SKIP_MESSAGES, parse, decryptAndParse, plan, previewRows,
    isMigration, decodeMigration, createMigrationCollector,
  };
})();

if (typeof window !== 'undefined') window.NotesTotpImport = NotesTotpImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesTotpImport;
