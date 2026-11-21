// Contacts data model (docs/CONTACTS_SPEC.md sections 2, 3.3, 3.4 and 5.1): normalising a contact,
// display name and sort key, the tab's own search, the field-level merge used on sync conflicts and
// the photo re-encoder. Pure functions; NotesStore does the storing and the encryption.
const NotesContacts = (() => {
  const LIMITS = {
    namePart: 200,
    nickname: 200,
    orgName: 200,
    title: 200,
    listEntries: 50,
    label: 60,
    value: 500,
    note: 20000,
    labels: 20,
    labelName: 40,
    extraBytes: 32 * 1024,
    contactBytes: 128 * 1024,
    photoBytes: 12288,
    photoSide: 192,
  };
  const PHONE_TYPES = ['home', 'work', 'mobile', 'main', 'fax', 'pager', 'other', 'custom'];
  const LIST_FIELDS = ['phones', 'emails', 'addresses', 'urls', 'ims', 'dates'];
  // Top-level fields that carry an edit clock (`fc`) and take part in the merge.
  const MERGE_FIELDS = ['name', 'nickname', 'org', 'title', ...LIST_FIELDS, 'note', 'photo', 'labels', 'favorite'];
  const NAME_PARTS = ['prefix', 'given', 'additional', 'family', 'suffix', 'formatted', 'phonetic_given', 'phonetic_family'];
  const ADDRESS_PARTS = ['street', 'extended', 'po_box', 'city', 'region', 'postal', 'country'];
  const IM_SERVICES = ['xmpp', 'skype', 'signal', 'whatsapp', 'matrix', 'telegram', 'aim', 'icq', 'jabber', 'twitter', 'other'];
  const DATE_TYPES = ['birthday', 'anniversary', 'other'];
  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const CONFLICT_SUFFIX = ' (conflict copy)';

  function randomBytes(n) {
    const bytes = new Uint8Array(n);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  function newEntryId() {
    return Array.from(randomBytes(8), (b) => BASE32[b % 32]).join('');
  }

  function newUid() {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function text(value, max, { newlines = false } = {}) {
    let s = value == null || typeof value === 'object' ? '' : String(value);
    s = s.normalize('NFC');
    // eslint-disable-next-line no-control-regex
    s = newlines ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]/g, ' ');
    s = s.trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  // Parsed from files and the network: drop keys that could pollute prototypes, copy into null-prototype maps.
  function cleanTree(value, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(value)) return value.slice(0, 500).map((v) => cleanTree(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = Object.create(null);
      for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        out[key] = cleanTree(value[key], depth + 1);
      }
      return out;
    }
    if (typeof value === 'string') return value.slice(0, 4096);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return null;
  }

  function plain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normName(src) {
    const out = {};
    for (const key of NAME_PARTS) out[key] = text(src && src[key], LIMITS.namePart);
    return out;
  }

  function normDate(value) {
    const v = text(value, 40);
    const m = /^(\d{4})-(\d{2})-(\d{2})$|^--(\d{2})-?(\d{2})$|^(\d{4})$/.exec(v.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
    if (!m) return '';
    const month = Number(m[2] || m[4]);
    const day = Number(m[3] || m[5]);
    if (m[2] || m[4]) {
      if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    }
    if (m[1]) return v.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (m[4]) return `--${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return v;
  }

  // Entries get a stable id; at most one `pref`; list capped. `report.dropped` counts what was cut.
  function normList(field, src, report) {
    const list = Array.isArray(src) ? src : [];
    const out = [];
    const seen = new Set();
    let pref = false;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      let entry;
      if (field === 'addresses') {
        entry = {};
        for (const part of ADDRESS_PARTS) entry[part] = text(raw[part], LIMITS.value);
        if (!ADDRESS_PARTS.some((part) => entry[part])) continue;
      } else if (field === 'dates') {
        const value = normDate(raw.value);
        if (!value) { report.dropped.dates = (report.dropped.dates || 0) + 1; continue; }
        entry = { value };
        entry.type = DATE_TYPES.includes(raw.type) ? raw.type : 'other';
        if (entry.type === 'birthday' && out.some((e) => e.type === 'birthday')) entry.type = 'other';
      } else {
        const value = text(raw.value, LIMITS.value);
        if (!value) continue;
        entry = { value };
        if (field === 'ims') {
          entry.service = IM_SERVICES.includes(raw.service) ? raw.service : 'other';
        }
      }
      if (field !== 'ims' && field !== 'dates') entry.type = PHONE_TYPES.includes(raw.type) ? raw.type : 'other';
      entry.label = text(raw.label, LIMITS.label);
      if (entry.type === 'custom' && !entry.label) entry.type = 'other';
      if (field === 'phones' || field === 'emails' || field === 'addresses') {
        entry.pref = !pref && raw.pref === true;
        pref = pref || entry.pref;
      }
      let id = text(raw.id, 16);
      if (!id || seen.has(id)) id = newEntryId();
      seen.add(id);
      out.push({ id, ...entry });
    }
    if (out.length > LIMITS.listEntries) {
      report.dropped[field] = (report.dropped[field] || 0) + out.length - LIMITS.listEntries;
      out.length = LIMITS.listEntries;
    }
    return out;
  }

  function normLabels(src) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(src) ? src : []) {
      const name = text(raw, LIMITS.labelName);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= LIMITS.labels) break;
    }
    return out;
  }

  function base64Bytes(data) {
    if (typeof data !== 'string' || !data || data.length > 4 * LIMITS.photoBytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return -1;
    return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  }

  // A stored photo is always a JPEG of at most 12 KiB (3.4); anything else is dropped, never kept as-is.
  function normPhoto(src, report) {
    if (!src || typeof src !== 'object') return null;
    const size = base64Bytes(src.data);
    if (src.mime !== 'image/jpeg' || size < 0 || size > LIMITS.photoBytes) {
      report.dropped.photo = 1;
      return null;
    }
    const side = (n) => Math.min(LIMITS.photoSide, Math.max(1, Math.floor(Number(n)) || LIMITS.photoSide));
    return { mime: 'image/jpeg', data: src.data, w: side(src.w), h: side(src.h) };
  }

  function emptyContact() {
    const out = { type: 'contact', schema: 1, uid: '', name: normName({}), nickname: '', org: { name: '', unit: '' }, title: '' };
    for (const f of LIST_FIELDS) out[f] = [];
    return Object.assign(out, { note: '', photo: null, labels: [], favorite: false, extra: {}, created_at: '', updated_at: '', fc: {}, fb: {} });
  }

  function normField(field, value, report) {
    switch (field) {
      case 'name': return normName(value);
      case 'nickname': return text(value, LIMITS.nickname);
      case 'org': return { name: text(value && value.name, LIMITS.orgName), unit: text(value && value.unit, LIMITS.orgName) };
      case 'title': return text(value, LIMITS.title);
      case 'note': return text(value, LIMITS.note, { newlines: true });
      case 'photo': return normPhoto(value, report);
      case 'labels': return normLabels(value);
      case 'favorite': return value === true;
      default: return normList(field, value, report);
    }
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // Build the content to store: `prev` is the stored content (unknown top-level keys survive), `input`
  // holds the fields to set. Returns { content, dropped } or throws when the contact exceeds 128 KiB.
  function buildContact(input, prev = null, now = new Date().toISOString()) {
    const src = input && typeof input === 'object' ? input : {};
    const report = { dropped: {} };
    const out = prev ? plain(prev) : emptyContact();
    out.type = 'contact';
    out.schema = 1;
    out.fc = out.fc && typeof out.fc === 'object' ? out.fc : {};
    out.fb = out.fb && typeof out.fb === 'object' ? out.fb : {};
    const empty = emptyContact();
    for (const field of MERGE_FIELDS) {
      if (!prev && !Object.prototype.hasOwnProperty.call(src, field)) { out[field] = empty[field]; continue; }
      if (!Object.prototype.hasOwnProperty.call(src, field)) continue;
      const next = normField(field, src[field], report);
      if (prev && deepEqual(next, prev[field])) continue;
      out.fb[field] = out.fc[field] || '';
      out.fc[field] = now;
      out[field] = next;
    }
    if (!prev) for (const field of MERGE_FIELDS) { if (deepEqual(out[field], empty[field])) continue; out.fc[field] = now; out.fb[field] = ''; }
    if (Object.prototype.hasOwnProperty.call(src, 'extra')) {
      const extra = cleanTree(src.extra);
      out.extra = extra && typeof extra === 'object' && !Array.isArray(extra) ? plain(extra) : {};
    }
    if (JSON.stringify(out.extra || {}).length > LIMITS.extraBytes) {
      out.extra = {};
      report.dropped.extra = 1;
    }
    if (typeof src.uid === 'string' && src.uid.trim() && !out.uid) out.uid = text(src.uid, 200);
    if (!out.uid) out.uid = newUid();
    if (!out.created_at) out.created_at = now;
    out.updated_at = now;
    if (JSON.stringify(out).length > LIMITS.contactBytes && out.extra && Object.keys(out.extra).length) {
      out.extra = {};
      report.dropped.extra = 1;
    }
    if (JSON.stringify(out).length > LIMITS.contactBytes && out.photo) {
      out.photo = null;
      report.dropped.photo = 1;
    }
    if (JSON.stringify(out).length > LIMITS.contactBytes) throw new Error('Contact is too large');
    return { content: out, dropped: report.dropped };
  }

  // --- display, sort, initials (2.3, 4.3) ---------------------------------------------------------
  function foldText(value) {
    return String(value == null ? '' : value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function displayName(c, order = 'given') {
    const n = (c && c.name) || {};
    const parts = (list) => list.map((k) => n[k] || '').filter(Boolean).join(' ');
    const structured = ['prefix', 'given', 'additional', 'family', 'suffix'].some((k) => n[k]);
    if (!structured && n.formatted) return n.formatted;
    if (structured) {
      if (order === 'family' && n.family) {
        const rest = parts(['prefix', 'given', 'additional', 'suffix']);
        return rest ? `${n.family}, ${rest}` : n.family;
      }
      return parts(['prefix', 'given', 'additional', 'family', 'suffix']);
    }
    if (c && c.org && c.org.name) return c.org.name;
    const email = c && c.emails && c.emails[0] && c.emails[0].value;
    if (email) return email;
    const phone = c && c.phones && c.phones[0] && c.phones[0].value;
    return phone || 'No name';
  }

  function sortKey(c, order = 'given') {
    return foldText(displayName(c, order));
  }

  // Letter used for grouping and avatar initials; `#` for digits, symbols and the empty name.
  function initial(c, order = 'given') {
    const ch = Array.from(String(displayName(c, order)).normalize('NFD').replace(/[̀-ͯ]/g, ''))[0] || '';
    const up = ch.toUpperCase();
    return up && up.toLowerCase() !== up ? up : '#';
  }

  function compareContacts(a, b, order = 'given') {
    const ka = sortKey(a, order);
    const kb = sortKey(b, order);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  // --- search (5.1) -----------------------------------------------------------------------------
  function digitsOf(value) {
    return String(value || '').replace(/\D/g, '').replace(/^00/, '');
  }

  function haystack(c) {
    const out = [];
    const n = c.name || {};
    for (const k of NAME_PARTS) out.push(n[k]);
    out.push(c.nickname, c.org && c.org.name, c.org && c.org.unit, c.title, c.note);
    for (const f of ['phones', 'emails', 'urls', 'ims', 'dates']) for (const e of c[f] || []) out.push(e.value);
    for (const a of c.addresses || []) for (const k of ADDRESS_PARTS) out.push(a[k]);
    for (const l of c.labels || []) out.push(l);
    const vcard = c.extra && Array.isArray(c.extra.vcard) ? c.extra.vcard : [];
    for (const v of vcard) if (v && v.n === 'X-ABRELATEDNAMES') out.push(v.v);
    return foldText(out.filter(Boolean).join('\n'));
  }

  // `list` holds contact contents. Every word must match (AND); `label:x` and `is:favorite` restrict.
  function filterContacts(list, query = '', activeLabel = '', favouritesOnly = false, order = 'given') {
    let label = foldText(activeLabel);
    let fav = favouritesOnly === true;
    const words = [];
    for (const tok of foldText(query).split(/\s+/).filter(Boolean)) {
      if (tok === 'is:favorite' || tok === 'is:favourite') fav = true;
      else if (tok.startsWith('label:') && tok.length > 6) label = tok.slice(6);
      else words.push(tok);
    }
    const phrase = words.join(' ');
    const rows = [];
    for (const c of list || []) {
      if (fav && !c.favorite) continue;
      if (label && !(c.labels || []).some((l) => foldText(l) === label)) continue;
      if (words.length) {
        const hay = haystack(c);
        const phoneDigits = (c.phones || []).map((p) => digitsOf(p.value));
        const ok = words.every((w) => {
          if (hay.includes(w)) return true;
          const d = digitsOf(w.replace(/^\+/, ''));
          return /^[\d\s()+.-]+$/.test(w) && d.length >= 3 && phoneDigits.some((p) => p.includes(d));
        });
        if (!ok) continue;
      }
      rows.push(c);
    }
    rows.sort((a, b) => {
      if (phrase) {
        const pa = sortKey(a, order).startsWith(phrase) ? 0 : 1;
        const pb = sortKey(b, order).startsWith(phrase) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      return compareContacts(a, b, order);
    });
    return rows;
  }

  function labelCounts(list) {
    const map = new Map();
    for (const c of list || []) {
      for (const name of c.labels || []) {
        const key = name.toLowerCase();
        const cur = map.get(key);
        if (cur) cur.count += 1; else map.set(key, { name, count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  }

  // Label rename/delete (`to` empty deletes); null when the contact does not carry the label.
  function renameLabelIn(labels, from, to = '') {
    const key = String(from || '').toLowerCase();
    if (!(labels || []).some((l) => l.toLowerCase() === key)) return null;
    return normLabels((labels || []).map((l) => (l.toLowerCase() === key ? to : l)));
  }

  // --- duplicates: detection and merge (docs/CONTACTS_SPEC.md 7.4 and 7.10) -----------------------
  const PHONE_MIN_DIGITS = 6;

  function emailKey(value) {
    return String(value == null ? '' : value).normalize('NFKC').trim().replace(/^mailto:/i, '').trim().toLowerCase();
  }

  // { kind: 'intl' | 'national' | 'plain', digits } or null. `00` counts as `+`; a single leading `0` marks a national
  // number (the trunk prefix is dropped from `digits`); anything else has no country information.
  function phoneKey(value) {
    const s = String(value == null ? '' : value).normalize('NFKC').trim();
    const digits = s.replace(/\D/g, '');
    if (s.startsWith('+')) return digits.length >= PHONE_MIN_DIGITS ? { kind: 'intl', digits } : null;
    if (digits.startsWith('00')) return digits.length - 2 >= PHONE_MIN_DIGITS ? { kind: 'intl', digits: digits.slice(2) } : null;
    if (digits.startsWith('0')) return digits.length - 1 >= PHONE_MIN_DIGITS ? { kind: 'national', digits: digits.slice(1) } : null;
    return digits.length >= PHONE_MIN_DIGITS ? { kind: 'plain', digits } : null;
  }

  // Name key: given/additional/family folded (case, accents, whitespace), words sorted so "Jan Visser" = "Visser, Jan".
  // A contact without a name of its own (display name taken from organisation, email or phone) has none.
  function nameKey(c) {
    const n = (c && c.name) || {};
    const structured = ['prefix', 'given', 'additional', 'family', 'suffix'].some((k) => n[k]);
    const raw = structured ? ['given', 'additional', 'family'].map((k) => n[k] || '').join(' ') : (n.formatted || '');
    const words = foldText(String(raw).normalize('NFKC')).split(/[\s,]+/).filter(Boolean);
    return words.length ? words.sort().join(' ') : '';
  }

  // Number of filled fields: used to pick the contact to keep by default.
  function filledCount(c) {
    let n = 0;
    const nm = (c && c.name) || {};
    for (const k of NAME_PARTS) if (nm[k]) n += 1;
    for (const k of ['nickname', 'title', 'note']) if (c && c[k]) n += 1;
    if (c && c.org) { if (c.org.name) n += 1; if (c.org.unit) n += 1; }
    for (const f of LIST_FIELDS) n += ((c && c[f]) || []).length;
    n += ((c && c.labels) || []).length;
    if (c && c.photo) n += 1;
    if (c && c.favorite) n += 1;
    return n;
  }

  // The contact to keep: most filled fields; on a tie the oldest, then the first in the list.
  function pickKeeper(contacts) {
    let best = null;
    for (const c of contacts) {
      if (!best) { best = c; continue; }
      const a = filledCount(c);
      const b = filledCount(best);
      if (a > b || (a === b && c.created_at && best.created_at && c.created_at < best.created_at)) best = c;
    }
    return best;
  }

  function groupKey(ids) {
    return [...ids].sort().join('|');
  }

  // Groups of contacts that are probably the same person.
  //   kind 'exact':    linked by an equal email or an equal phone number (group.reasons says which, group.via the values);
  //   kind 'possible': linked only by the same name; contacts of an exact group are not offered again here.
  // Phones: spaces, dashes, dots and brackets are ignored, `00` = `+`, at least 6 digits. A national number
  // (`0612345678`) matches an international one (`+31612345678`) only when exactly one international number in
  // the list ends in the same digits behind a 1 to 3 digit country code; with two candidates it is ambiguous and
  // matches none. `ignore` is a Set of group keys (groupKey) the user marked "Not duplicates".
  // Linear in the number of contacts: everything goes through hash maps.
  function findDuplicateGroups(contacts, { ignore = null } = {}) {
    const list = Array.isArray(contacts) ? contacts : [];
    const parent = list.map((_, i) => i);
    const find = (i) => { let x = i; while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
    const byEmail = new Map();
    const byIntl = new Map();
    const byPlain = new Map();
    const byNational = new Map();
    const add = (map, key, i) => { const set = map.get(key); if (set) set.add(i); else map.set(key, new Set([i])); };
    list.forEach((c, i) => {
      for (const e of c.emails || []) { const k = emailKey(e.value); if (k) add(byEmail, k, i); }
      for (const p of c.phones || []) {
        const k = phoneKey(p.value);
        if (!k) continue;
        add(k.kind === 'intl' ? byIntl : k.kind === 'national' ? byNational : byPlain, k.digits, i);
      }
    });
    // Per link: the reason and the shared value, to show why contacts are grouped.
    const links = [];
    const link = (set, reason, value) => {
      if (set.size < 2) return;
      const idx = [...set];
      for (let j = 1; j < idx.length; j += 1) union(idx[0], idx[j]);
      links.push({ at: idx[0], reason, value });
    };
    for (const [k, set] of byEmail) link(set, 'email', k);
    for (const [k, set] of byIntl) link(set, 'phone', `+${k}`);
    for (const [k, set] of byPlain) link(set, 'phone', k);
    for (const [k, set] of byNational) link(set, 'phone', `0${k}`);
    // National with international: only when exactly one international number fits.
    const intlBySuffix = new Map();
    for (const digits of byIntl.keys()) {
      for (let cc = 1; cc <= 3; cc += 1) if (digits.length - cc >= PHONE_MIN_DIGITS) add(intlBySuffix, digits.slice(cc), digits);
    }
    for (const [national, owners] of byNational) {
      const fits = intlBySuffix.get(national);
      if (!fits || fits.size !== 1) continue;
      const intl = [...fits][0];
      link(new Set([...owners, ...byIntl.get(intl)]), 'phone', `0${national} = +${intl}`);
    }
    const buckets = new Map();
    list.forEach((c, i) => {
      const r = find(i);
      if (!buckets.has(r)) buckets.set(r, []);
      buckets.get(r).push(i);
    });
    const reasonsOf = new Map();
    for (const l of links) {
      const r = find(l.at);
      if (!reasonsOf.has(r)) reasonsOf.set(r, { reasons: new Set(), via: [] });
      const entry = reasonsOf.get(r);
      entry.reasons.add(l.reason);
      if (entry.via.length < 6 && !entry.via.includes(l.value)) entry.via.push(l.value);
    }
    const out = [];
    const grouped = new Set();
    for (const [root, members] of buckets) {
      if (members.length < 2) continue;
      const info = reasonsOf.get(root) || { reasons: new Set(), via: [] };
      const ids = members.map((i) => list[i].uuid);
      for (const i of members) grouped.add(i);
      out.push({ kind: 'exact', key: groupKey(ids), ids, reasons: [...info.reasons].sort(), via: info.via });
    }
    const byName = new Map();
    list.forEach((c, i) => {
      if (grouped.has(i)) return;
      const k = nameKey(c);
      if (k) add(byName, k, i);
    });
    for (const [k, set] of byName) {
      if (set.size < 2) continue;
      const ids = [...set].map((i) => list[i].uuid);
      out.push({ kind: 'possible', key: groupKey(ids), ids, reasons: ['name'], via: [k] });
    }
    return out.filter((g) => !(ignore && ignore.has(g.key)));
  }

  // Which of the contacts of an import (parsed, not stored yet) are duplicates: of a contact in `existing` or of an
  // earlier one in the same file. One entry per incoming contact: null, or
  // { kind: 'exact' | 'possible', reasons, via, existing, target }, where `target` is { id } (a contact of the vault,
  // the best filled one of its group) or { index } (the earlier incoming contact that is kept). It is the matcher of
  // findDuplicateGroups run over both lists, so phone and email rules are the same as in "Find duplicates"; a
  // contact with the UID of an existing one counts as exact too. Inside a file alone, two contacts count as the same
  // only when their names agree or one has no name (people who share a landline are not duplicates of each other).
  const INCOMING_PREFIX = 'incoming:';
  function matchIncoming(incoming, existing) {
    const inc = Array.isArray(incoming) ? incoming : [];
    const own = Array.isArray(existing) ? existing : [];
    const out = new Array(inc.length).fill(null);
    const uidOwner = new Map();
    for (const c of own) if (c.uid && !uidOwner.has(c.uid)) uidOwner.set(c.uid, c.uuid);
    inc.forEach((c, i) => {
      if (c && c.uid && uidOwner.has(c.uid)) out[i] = { kind: 'exact', reasons: ['uid'], via: [], existing: true, target: { id: uidOwner.get(c.uid) } };
    });
    const byUuid = new Map(own.map((c) => [c.uuid, c]));
    const all = own.concat(inc.map((c, i) => ({ ...c, uuid: `${INCOMING_PREFIX}${i}` })));
    for (const group of findDuplicateGroups(all)) {
      const owned = [];
      const mine = [];
      for (const id of group.ids) {
        if (id.startsWith(INCOMING_PREFIX)) mine.push(Number(id.slice(INCOMING_PREFIX.length)));
        else owned.push(byUuid.get(id));
      }
      const info = { kind: group.kind, reasons: group.reasons, via: group.via };
      mine.sort((a, b) => a - b);
      if (owned.length) {
        const target = { id: pickKeeper(owned).uuid };
        for (const i of mine) if (!out[i]) out[i] = { ...info, existing: true, target };
        continue;
      }
      const kept = [];
      for (const i of mine) {
        if (out[i]) continue;
        const key = nameKey(inc[i]);
        const first = kept.find((j) => !key || !nameKey(inc[j]) || nameKey(inc[j]) === key);
        if (first === undefined) kept.push(i); else out[i] = { ...info, existing: false, target: { index: first } };
      }
    }
    return out;
  }

  // --- merging ---
  const SINGLE_FIELDS = ['name', 'nickname', 'org', 'title', 'birthday', 'photo', 'favorite'];

  function singleValue(c, field) {
    if (field === 'birthday') {
      const b = (c.dates || []).find((d) => d.type === 'birthday');
      return b ? b.value : '';
    }
    if (field === 'favorite') return c.favorite === true;
    if (field === 'photo') return c.photo || null;
    return c[field];
  }

  function isEmptySingle(field, value) {
    if (field === 'name') return !NAME_PARTS.some((k) => value && value[k]);
    if (field === 'org') return !(value && (value.name || value.unit));
    if (field === 'favorite') return value !== true;
    return !value;
  }

  // For each single-value field where the contacts hold different non-empty values: the options (each with the
  // ids of the contacts that have it) and the default. Returns [{ field, options: [{ value, from }], chosen }].
  // The default is the value of `keepId` when it has one, otherwise the first contact that has one. A favourite
  // is never a choice: the merged contact is a favourite when any of them was.
  function mergeChoices(contacts, keepId) {
    const ordered = [...contacts].sort((a, b) => (a.uuid === keepId ? -1 : b.uuid === keepId ? 1 : 0));
    const out = [];
    for (const field of SINGLE_FIELDS) {
      if (field === 'favorite') continue;
      const options = [];
      for (const c of ordered) {
        const value = singleValue(c, field);
        if (isEmptySingle(field, value)) continue;
        const key = JSON.stringify(value);
        const found = options.find((o) => o.key === key);
        if (found) found.from.push(c.uuid); else options.push({ key, value, from: [c.uuid] });
      }
      if (options.length > 1) out.push({ field, options: options.map(({ value, from }) => ({ value, from })), chosen: 0 });
    }
    return out;
  }

  function listKey(field, e) {
    if (field === 'phones') { const k = phoneKey(e.value); return k ? `${k.kind}:${k.digits}` : `raw:${String(e.value).replace(/[\s\-.()]/g, '')}`; }
    if (field === 'emails') return emailKey(e.value);
    if (field === 'addresses') return ADDRESS_PARTS.map((p) => foldText(e[p]).replace(/\s+/g, ' ').trim()).join('|');
    if (field === 'urls') {
      // Scheme and host are case-insensitive and a trailing slash adds nothing; the path is compared as written.
      try { const u = new URL(String(e.value).trim()); return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`; } catch (err) { return String(e.value).trim(); }
    }
    if (field === 'ims') return `${e.service}|${String(e.value).trim().toLowerCase()}`;
    return `${e.type}|${e.value}`;
  }

  // Unknown imported fields (2.4) of all contacts: `vcard` lines are appended (identical ones once; a property
  // group such as item5 that clashes with another contact's gets a new name so the pairs stay apart), `csv`
  // and `ldif` keys are added (the same key with a different value is kept as "key (2)"); other keys: first wins.
  function mergeExtra(contacts) {
    const out = {};
    const seen = new Set();
    const groupsTaken = new Set();
    contacts.forEach((c, n) => {
      const x = c.extra && typeof c.extra === 'object' ? c.extra : {};
      for (const key of Object.keys(x)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const v = x[key];
        if (key === 'vcard' && Array.isArray(v)) {
          out.vcard = out.vcard || [];
          const rename = new Map();
          for (const entry of v) {
            if (!entry || typeof entry !== 'object') continue;
            const sig = JSON.stringify(entry);
            if (seen.has(sig)) continue;
            seen.add(sig);
            let g = entry.g || '';
            if (g && n > 0) {
              if (!rename.has(g)) {
                let candidate = g;
                let i = 2;
                while (groupsTaken.has(candidate)) { candidate = `${g}-${i}`; i += 1; }
                rename.set(g, candidate);
              }
              g = rename.get(g);
            }
            if (g) groupsTaken.add(g);
            out.vcard.push({ ...entry, g });
          }
        } else if ((key === 'csv' || key === 'ldif') && v && typeof v === 'object' && !Array.isArray(v)) {
          out[key] = out[key] || {};
          for (const k of Object.keys(v)) {
            if (FORBIDDEN_KEYS.has(k)) continue;
            const same = (name) => JSON.stringify(out[key][name]) === JSON.stringify(v[k]);
            if (!(k in out[key])) { out[key][k] = v[k]; continue; }
            if (same(k)) continue;
            let i = 2;
            while (`${k} (${i})` in out[key] && !same(`${k} (${i})`)) i += 1;
            out[key][`${k} (${i})`] = v[k];
          }
        } else if (!(key in out)) out[key] = plain(v);
      }
    });
    return out;
  }

  // The result of merging `contacts` into the one with `keepId`: { patch, removeIds, error }.
  // `picks` maps a field of mergeChoices to the index of the chosen option (default 0).
  // Nothing is lost: every distinct phone, email, address, URL, IM handle, date, label and imported field is kept
  // (a birthday that lost stays as a plain date); notes are joined with a blank line; identical values are not
  // doubled. `error` is set when the result would not fit the limits, so that data would be cut: save nothing then.
  function planMerge(contacts, keepId, picks = {}) {
    const keep = contacts.find((c) => c.uuid === keepId);
    if (!keep) return { patch: null, removeIds: [], error: 'The contact to keep was not found' };
    const ordered = [keep, ...contacts.filter((c) => c.uuid !== keepId)];
    const choices = mergeChoices(contacts, keepId);
    const winner = (field) => {
      const choice = choices.find((ch) => ch.field === field);
      if (choice) return choice.options[Math.min(Math.max(Number(picks[field]) || 0, 0), choice.options.length - 1)].value;
      const holder = ordered.find((c) => !isEmptySingle(field, singleValue(c, field)));
      return singleValue(holder || keep, field);
    };
    const patch = {
      name: plain(winner('name')),
      nickname: winner('nickname'),
      org: plain(winner('org')),
      title: winner('title'),
      photo: plain(winner('photo')),
      favorite: ordered.some((c) => c.favorite === true),
    };
    const birthday = winner('birthday');
    for (const field of LIST_FIELDS) {
      const seen = new Set();
      const merged = [];
      const take = (entry) => {
        const key = listKey(field, entry);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(plain(entry));
      };
      if (field === 'dates' && birthday) take({ type: 'birthday', value: birthday });
      for (const c of ordered) {
        for (const entry of c[field] || []) {
          if (field === 'dates' && entry.type === 'birthday') { if (entry.value !== birthday) take({ ...entry, type: 'other' }); continue; }
          take(entry);
        }
      }
      patch[field] = merged;
    }
    const notes = [];
    for (const c of ordered) { const n = String(c.note || '').trim(); if (n && !notes.includes(n)) notes.push(n); }
    patch.note = notes.join('\n\n');
    patch.labels = normLabels(ordered.flatMap((c) => c.labels || []));
    patch.extra = mergeExtra(ordered);
    const wanted = new Set(ordered.flatMap((c) => c.labels || []).map((l) => String(l).trim().toLowerCase()).filter(Boolean));
    let error = '';
    if (patch.labels.length < wanted.size) error = 'The merged contact would have more groups than a contact can hold';
    if (!error) {
      try {
        const { dropped } = buildContact(patch, keep);
        const lost = Object.keys(dropped).filter((k) => dropped[k]);
        if (lost.length) error = `The merged contact would be too large (${lost.join(', ')})`;
      } catch (err) {
        error = 'The merged contact would be too large';
      }
    }
    return { patch, removeIds: ordered.slice(1).map((c) => c.uuid), error };
  }

  // The patch that puts `contact` (as it was listed) back: used by Undo.
  function restorePatch(contact) {
    const patch = {};
    for (const field of MERGE_FIELDS) patch[field] = plain(contact[field]);
    patch.extra = plain(contact.extra || {});
    return patch;
  }

  // --- merge on sync conflict (3.3) ---------------------------------------------------------------
  // Returns { content, copy }. `copy` is a contact holding the values that lost a real conflict (the
  // same scalar field changed on both devices from the same earlier state), or null.
  function mergeContacts(local, remote) {
    const lf = (local && local.fc) || {};
    const rf = (remote && remote.fc) || {};
    const lb = (local && local.fb) || {};
    const rb = (remote && remote.fb) || {};
    const newer = String((local && local.updated_at) || '') >= String((remote && remote.updated_at) || '') ? local : remote;
    const older = newer === local ? remote : local;
    const merged = { ...older, ...newer };
    const fc = { ...rf };
    const fb = { ...rb };
    const lost = {};
    for (const field of MERGE_FIELDS) {
      const lv = local[field];
      const rv = remote[field];
      const lt = lf[field] || '';
      const rt = rf[field] || '';
      if (deepEqual(lv, rv)) {
        merged[field] = lv;
        if (lt || rt) { fc[field] = lt > rt ? lt : rt; fb[field] = lt > rt ? (lb[field] || '') : (rb[field] || ''); }
        continue;
      }
      if (LIST_FIELDS.includes(field)) {
        const first = lt >= rt ? lv : rv;
        const second = lt >= rt ? rv : lv;
        const ids = new Set((first || []).map((e) => e.id));
        merged[field] = [...(first || []), ...(second || []).filter((e) => !ids.has(e.id))];
        fc[field] = lt > rt ? lt : rt;
        fb[field] = lt > rt ? (lb[field] || '') : (rb[field] || '');
        continue;
      }
      const localWins = lt >= rt;
      const winnerTime = localWins ? lt : rt;
      const loserTime = localWins ? rt : lt;
      merged[field] = localWins ? lv : rv;
      fc[field] = winnerTime;
      fb[field] = localWins ? (lb[field] || '') : (rb[field] || '');
      // Concurrent: the loser also changed the field, and from the same earlier state.
      const winnerBase = localWins ? (lb[field] || '') : (rb[field] || '');
      const loserBase = localWins ? (rb[field] || '') : (lb[field] || '');
      const concurrent = loserTime && winnerBase !== loserTime && winnerBase === loserBase && field !== 'favorite';
      if (concurrent) lost[field] = localWins ? rv : lv;
    }
    merged.fc = fc;
    merged.fb = fb;
    // Contact-wide bookkeeping follows the side that was edited last.
    merged.updated_at = newer.updated_at;
    let copy = null;
    if (Object.keys(lost).length) {
      copy = plain({ ...merged, ...lost });
      // Named like a note conflict copy; the structured parts are folded into `formatted`.
      copy.name = { ...plain(merged.name), prefix: '', given: '', additional: '', family: '', suffix: '', formatted: `${displayName(copy)}${CONFLICT_SUFFIX}` };
      delete copy.__fid;
      delete copy.__fv;
      copy.uid = newUid();
      copy.favorite = false;
    }
    return { content: merged, copy };
  }

  // --- photo re-encoder (3.4, 9.3); browser only ----------------------------------------------------
  const MAX_PHOTO_INPUT_BYTES = 20 * 1024 * 1024;
  const MAX_PHOTO_SIDE = 8192;
  const MAX_PHOTO_PIXELS = 16 * 1000 * 1000;

  function imageSize(bytes) {
    const u = (i) => bytes[i];
    if (bytes.length > 24 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4e && u(3) === 0x47) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (bytes.length > 10 && u(0) === 0x47 && u(1) === 0x49 && u(2) === 0x46) {
      return { w: u(6) | (u(7) << 8), h: u(8) | (u(9) << 8) };
    }
    if (bytes.length > 4 && u(0) === 0xff && u(1) === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (u(i) !== 0xff) { i += 1; continue; }
        const marker = u(i + 1);
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
        const len = (u(i + 2) << 8) | u(i + 3);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: (u(i + 5) << 8) | u(i + 6), w: (u(i + 7) << 8) | u(i + 8) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (bytes.length > 30 && String.fromCharCode(u(0), u(1), u(2), u(3)) === 'RIFF' && String.fromCharCode(u(8), u(9), u(10), u(11)) === 'WEBP') {
      const kind = String.fromCharCode(u(12), u(13), u(14), u(15));
      if (kind === 'VP8X') return { w: 1 + (u(24) | (u(25) << 8) | (u(26) << 16)), h: 1 + (u(27) | (u(28) << 8) | (u(29) << 16)) };
      if (kind === 'VP8L') {
        const b = u(21) | (u(22) << 8) | (u(23) << 16) | (u(24) << 24);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >>> 14) & 0x3fff) };
      }
      if (kind === 'VP8 ') return { w: (u(26) | (u(27) << 8)) & 0x3fff, h: (u(28) | (u(29) << 8)) & 0x3fff };
    }
    return null;
  }

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // Checks a picked file before anything is decoded: { w, h } or { error } with a message for the user.
  async function inspectPhoto(blob) {
    if (!blob || blob.size > MAX_PHOTO_INPUT_BYTES) return { error: 'Picture file is too large (20 MB at most)' };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dims = imageSize(bytes);
    if (!dims || !dims.w || !dims.h) return { error: 'Picture format not supported. Use a JPEG, PNG, GIF or WebP image' };
    if (dims.w > MAX_PHOTO_SIDE || dims.h > MAX_PHOTO_SIDE || dims.w * dims.h > MAX_PHOTO_PIXELS) return { error: 'Picture dimensions are too large' };
    return dims;
  }

  // Square crop in image fractions: the centre (cx, cy) and zoom >= 1 (1 = the largest centred square).
  // Returns the source square in pixels, always inside the image.
  function cropSquare(w, h, crop) {
    const zoom = Math.max(1, Number(crop && crop.zoom) || 1);
    const side = Math.max(1, Math.floor(Math.min(w, h) / zoom));
    const at = (c, len) => Math.min(len - side, Math.max(0, Math.round((Number.isFinite(c) ? c : 0.5) * len - side / 2)));
    return { sx: at(crop && crop.cx, w), sy: at(crop && crop.cy, h), side };
  }

  // Blob (+ optional crop) -> { photo } (a 192 px JPEG of at most 12 KiB, pixels only: no EXIF, no alpha) or { error }.
  async function encodePhoto(blob, crop) {
    const dims = await inspectPhoto(blob);
    if (dims.error) return dims;
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
      const { sx, sy, side: crop2 } = cropSquare(bitmap.width, bitmap.height, crop);
      for (const side of [LIMITS.photoSide, 144]) {
        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, side, side);
        ctx.drawImage(bitmap, sx, sy, crop2, crop2, 0, 0, side, side);
        for (const q of [0.78, 0.65, 0.5]) {
          const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
          if (out && out.size <= LIMITS.photoBytes) {
            return { photo: { mime: 'image/jpeg', data: bytesToBase64(new Uint8Array(await out.arrayBuffer())), w: side, h: side } };
          }
        }
      }
      return { error: 'Picture too complex' };
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  return {
    LIMITS,
    LIST_FIELDS,
    MERGE_FIELDS,
    CONFLICT_SUFFIX,
    buildContact,
    displayName,
    sortKey,
    initial,
    compareContacts,
    foldText,
    filterContacts,
    labelCounts,
    renameLabelIn,
    mergeContacts,
    emailKey,
    phoneKey,
    nameKey,
    filledCount,
    pickKeeper,
    groupKey,
    findDuplicateGroups,
    matchIncoming,
    mergeChoices,
    planMerge,
    restorePatch,
    encodePhoto,
    inspectPhoto,
    cropSquare,
    imageSize,
    normLabels,
  };
})();

if (typeof window !== 'undefined') window.NotesContacts = NotesContacts;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContacts;
