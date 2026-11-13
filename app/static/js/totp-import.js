// 2FA import: otpauth list, plain Aegis JSON, plain 2FAS JSON (docs/2FA_IMPORT_SPEC.md, section 3).
// Input is untrusted. Errors are generic codes and never contain input. Nothing here logs,
// stores or sends data; secrets only leave through the returned entries.
const NotesTotpImport = (() => {
  const Totp = (typeof NotesTotp !== 'undefined') ? NotesTotp : require('./totp.js');
  const LIMITS = { maxChars: 5 * 1024 * 1024, maxEntries: 2000, maxDepth: 32 };
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
  };
  const SKIP_MESSAGES = {
    invalid: 'Invalid entry',
    hotp: 'HOTP not supported yet',
    unsupported: 'Unsupported type',
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

  return { LIMITS, MESSAGES, SKIP_MESSAGES, parse, decryptAndParse, plan, previewRows };
})();

if (typeof window !== 'undefined') window.NotesTotpImport = NotesTotpImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesTotpImport;
