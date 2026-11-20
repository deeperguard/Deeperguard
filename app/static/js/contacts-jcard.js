// jCard (RFC 7095) reader for contacts (docs/CONTACTS_SPEC.md sections 6.5, 2.4 and 9.4). Pure functions of
// bytes/text to plain objects: no DOM, no network, no store. Written here on purpose (no library).
// Everything read from a file is data: values are never interpreted as HTML. The JSON is parsed with a
// reviver that drops the keys __proto__, constructor and prototype, and only own keys are copied into
// Object.create(null) maps, so file data can never reach an object prototype.
const NotesContactsJcard = (() => {
  const LIMITS = { fileBytes: 64 * 1024 * 1024, depth: 32, cardBytes: 4 * 1024 * 1024, extraEntries: 200, extraValue: 4096, extraBytes: 32 * 1024, listEntries: 50, photoBytes: 3 * 1024 * 1024 };
  const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
  const NOT_JCARD = 'not a jCard';
  const IM_SERVICES = ['xmpp', 'skype', 'signal', 'whatsapp', 'matrix', 'telegram', 'aim', 'icq', 'jabber', 'twitter', 'other'];
  const IM_BY_PROPERTY = { 'X-AIM': 'aim', 'X-ICQ': 'icq', 'X-JABBER': 'jabber', 'X-SKYPE': 'skype', 'X-MSN': 'other', 'X-YAHOO': 'other', 'X-GOOGLE-TALK': 'xmpp', 'X-GADUGADU': 'other' };
  const IGNORED_TYPES = new Set(['voice', 'text', 'msg', 'video', 'internet', 'pref', 'x400', 'textphone']);
  const TYPE_WORDS = {
    cell: 'mobile', iphone: 'mobile', mobile: 'mobile', 'x-mobile': 'mobile', home: 'home', work: 'work', main: 'main',
    fax: 'fax', homefax: 'fax', workfax: 'fax', otherfax: 'fax', pager: 'pager', other: 'other',
  };
  const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function nullMap() { return Object.create(null); }

  // Control characters other than newline and lone surrogates are removed.
  function clean(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '').replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
  }

  function base64ToBytes(b64) {
    const s = String(b64).replace(/\s+/g, '');
    if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
    if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(s, 'base64'));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function sniffImage(b) {
    if (!b || b.length < 12) return '';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    return '';
  }

  // Nesting of [ and { outside strings, stopped as soon as it passes the limit. One pass, always advances.
  function tooDeep(text) {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '[' || ch === '{') { depth += 1; if (depth > LIMITS.depth) return true; }
      else if (ch === ']' || ch === '}') depth -= 1;
    }
    return false;
  }

  // Scalars as text; arrays joined with `sep`; objects are not text.
  function asText(x, sep) {
    if (typeof x === 'string') return x;
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    if (Array.isArray(x)) return x.map((y) => asText(y, sep)).filter(Boolean).join(sep);
    return '';
  }

  // Own keys only, into a null-prototype map; values are arrays of strings (the vCard parameter map of 2.4).
  function paramMap(obj) {
    const out = nullMap();
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN.has(key)) continue;
      const raw = obj[key];
      const list = (Array.isArray(raw) ? raw : [raw]).filter((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').map(String);
      if (list.length) out[key.toLowerCase()] = list;
    }
    return out;
  }

  function parseDate(raw, omitYear) {
    let v = String(raw).trim();
    const t = v.search(/T/i);
    if (t > 0) v = v.slice(0, t);
    let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
    let y = '';
    let mo;
    let d;
    if (m) { [, y, mo, d] = m; }
    else if ((m = /^--(\d{2})-?(\d{2})$/.exec(v))) { [, mo, d] = m; }
    else if ((m = /^(\d{4})$/.exec(v))) { return m[1]; }
    else return '';
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > DAYS[month - 1]) return '';
    if (omitYear || y === '1604') y = '';
    return y ? y + '-' + mo + '-' + d : '--' + mo + '-' + d;
  }

  function typeFrom(p) {
    const words = (p.type || []).map((w) => w.toLowerCase());
    for (const w of words) if (TYPE_WORDS[w]) return { type: TYPE_WORDS[w], label: '' };
    for (const w of words) if (!IGNORED_TYPES.has(w)) return { type: 'custom', label: w };
    return { type: 'other', label: '' };
  }

  function isPref(p) {
    return (p.type || []).some((w) => w.toLowerCase() === 'pref') || !!(p.pref && p.pref[0] === '1');
  }

  // A property array -> { g, n, p, values } or null when it is not [name, params, type, value...].
  function readProperty(raw) {
    if (!Array.isArray(raw) || raw.length < 4 || typeof raw[0] !== 'string' || !raw[0]) return null;
    const p = paramMap(raw[1]);
    const g = p.group ? p.group[0] : '';
    delete p.group;
    return { g, n: raw[0].toUpperCase(), p, values: raw.slice(3) };
  }

  // The value kept in `extra.vcard`: text as it is, anything else JSON-encoded.
  function rawValue(prop) {
    const v = prop.values.length === 1 ? prop.values[0] : prop.values;
    return clean(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\n/g, '\\n');
  }

  function mapCard(props, ctx) {
    const c = {
      uid: '', name: { prefix: '', given: '', additional: '', family: '', suffix: '', formatted: '' }, nickname: '',
      org: { name: '', unit: '' }, title: '', phones: [], emails: [], addresses: [], urls: [], ims: [], dates: [],
      note: '', photo: null, labels: [], favorite: false, extra: {}, photoSource: null,
    };
    const extra = [];
    const keep = (prop) => {
      const v = rawValue(prop);
      if (v.length > LIMITS.extraValue) { ctx.droppedExtra += 1; return; }
      extra.push({ g: prop.g, n: prop.n, p: prop.p, v });
    };
    const text = (prop) => clean(asText(prop.values[0], ', ')).trim();
    const notes = [];
    let fn = '';
    let version = '';
    let rev = '';
    let prodid = '';
    let kind = '';
    const members = [];
    for (const prop of props) {
      const { n, p } = prop;
      switch (n) {
        case 'VERSION': version = text(prop); break;
        case 'UID': c.uid = text(prop); break;
        case 'REV': rev = text(prop); break;
        case 'PRODID': prodid = text(prop); break;
        case 'FN': fn = text(prop); break;
        case 'N': {
          const parts = Array.isArray(prop.values[0]) ? prop.values[0] : [];
          const [fam, giv, add, pre, suf] = [0, 1, 2, 3, 4].map((i) => clean(asText(parts[i], ' ')).trim());
          c.name = { prefix: pre, given: giv, additional: add, family: fam, suffix: suf, formatted: '' };
          break;
        }
        case 'NICKNAME': c.nickname = prop.values.map((x) => clean(asText(x, ', ')).trim()).filter(Boolean).join(', '); break;
        case 'ORG': {
          const parts = (Array.isArray(prop.values[0]) ? prop.values[0] : prop.values).map((x) => clean(asText(x, ' ')).trim());
          const units = parts.slice(1).filter(Boolean);
          c.org = { name: parts[0] || '', unit: units.join(' / ') };
          if (units.length > 1) keep(prop);
          break;
        }
        case 'TITLE': c.title = text(prop); break;
        case 'TEL': case 'EMAIL': case 'URL': {
          let value = text(prop);
          if (n === 'TEL') value = value.replace(/^tel:/i, '');
          if (!value) break;
          const { type, label } = typeFrom(p);
          c[n === 'TEL' ? 'phones' : n === 'EMAIL' ? 'emails' : 'urls'].push({ type, label, value, pref: isPref(p) });
          break;
        }
        case 'ADR': {
          const parts = Array.isArray(prop.values[0]) ? prop.values[0] : [];
          const [po, ext, street, city, region, postal, country] = [0, 1, 2, 3, 4, 5, 6].map((i) => clean(asText(parts[i], ', ')).trim());
          const a = { po_box: po, extended: ext, street, city, region, postal, country };
          if (!Object.values(a).some(Boolean) && p.label) a.street = p.label[0];
          const { type, label } = typeFrom(p);
          c.addresses.push({ ...a, type, label, pref: isPref(p) });
          break;
        }
        case 'IMPP': case 'X-AIM': case 'X-ICQ': case 'X-JABBER': case 'X-SKYPE': case 'X-MSN': case 'X-YAHOO': case 'X-GOOGLE-TALK': case 'X-GADUGADU': {
          let value = text(prop);
          let service = IM_BY_PROPERTY[n] || 'other';
          if (n === 'IMPP') {
            const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
            const fromParam = ((p.type || [])[0] || '').toLowerCase();
            if (m && IM_SERVICES.includes(m[1].toLowerCase())) { service = m[1].toLowerCase(); value = m[2]; }
            else service = IM_SERVICES.includes(fromParam) ? fromParam : 'other';
          }
          if (value) c.ims.push({ service, value });
          break;
        }
        case 'BDAY': case 'ANNIVERSARY': {
          const value = parseDate(text(prop), !!p['x-apple-omit-year']);
          if (!value) { keep(prop); ctx.warnings.push('card ' + ctx.index + ': date "' + text(prop).slice(0, 40) + '" is not a valid date and was kept as an unknown field'); break; }
          c.dates.push({ type: n === 'BDAY' ? 'birthday' : 'anniversary', label: '', value });
          break;
        }
        case 'NOTE': { const t = text(prop); if (t) notes.push(t); break; }
        case 'CATEGORIES':
          for (const x of prop.values) {
            const name = clean(asText(x, ', ')).trim();
            if (name && name.toLowerCase() !== 'mycontacts') c.labels.push(name);
          }
          break;
        case 'KIND': kind = text(prop).toLowerCase(); if (kind !== 'group') keep(prop); break;
        case 'MEMBER': members.push(text(prop)); break;
        case 'PHOTO': {
          const value = text(prop);
          const m = /^data:[^;,]*(?:;[^;,]*)*;base64,(.*)$/is.exec(value);
          if (!m) { keep(prop); break; }
          const bytes = base64ToBytes(m[1]);
          if (!bytes) { ctx.warnings.push('card ' + ctx.index + ': photo could not be read and was left out'); break; }
          if (bytes.length > LIMITS.photoBytes) { ctx.warnings.push('card ' + ctx.index + ': photo is larger than 3 MiB and was left out'); break; }
          const mime = sniffImage(bytes);
          if (!mime) { ctx.warnings.push('card ' + ctx.index + ': photo is not a PNG, JPEG, GIF, WebP or BMP image and was left out'); break; }
          if (!c.photoSource) c.photoSource = { mime, bytes };
          break;
        }
        default: keep(prop);
      }
    }
    c.note = notes.join('\n\n');
    c.labels = c.labels.filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
    if (kind === 'group') c.groupCard = { name: fn, members };
    const words = fn.split(/\s+/).filter(Boolean);
    if (!c.name.family && !c.name.given && !c.name.additional && !c.name.prefix && !c.name.suffix && words.length === 2) [c.name.given, c.name.family] = words;
    const parts = [c.name.prefix, c.name.given, c.name.additional, c.name.family, c.name.suffix].filter(Boolean).join(' ');
    c.name.formatted = fn || parts || c.org.name || (c.emails[0] && c.emails[0].value) || (c.phones[0] && c.phones[0].value) || '';
    const source = { format: 'jcard', version: ['3.0', '4.0'].includes(version) ? version : '4.0' };
    if (rev) source.rev = rev.slice(0, 64);
    if (prodid) source.prodid = prodid.slice(0, 200);
    c.extra = { source };
    let size = 0;
    const kept = [];
    for (const e of extra) {
      const s = JSON.stringify(e).length;
      if (kept.length >= LIMITS.extraEntries || size + s > LIMITS.extraBytes) { ctx.droppedExtra += 1; continue; }
      size += s;
      kept.push(e);
    }
    if (kept.length) c.extra.vcard = kept;
    return c;
  }

  // `input` is text or bytes. -> { contacts, skipped:[{index,reason}], warnings, stats }
  function parse(input) {
    const result = { contacts: [], skipped: [], warnings: [], stats: { cards: 0, photos: 0, droppedExtra: 0 } };
    const refuse = (reason) => { result.skipped.push({ index: 0, reason }); return result; };
    if ((input.byteLength || input.length || 0) > LIMITS.fileBytes) return refuse('This file is larger than 64 MiB.');
    const text = (typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input)).replace(/^﻿/, '');
    if (tooDeep(text)) return refuse(NOT_JCARD + ': the JSON is nested more than ' + LIMITS.depth + ' levels deep');
    let droppedKeys = 0;
    let data;
    try {
      data = JSON.parse(text, (key, value) => {
        if (FORBIDDEN.has(key)) { droppedKeys += 1; return undefined; }
        return value;
      });
    } catch (err) { return refuse(NOT_JCARD + ': the file is not valid JSON'); }
    let cards;
    if (Array.isArray(data) && data[0] === 'vcard') cards = [data];
    else if (Array.isArray(data) && data.length) cards = data;
    else return refuse(NOT_JCARD);
    const ctx = { index: 0, warnings: result.warnings, droppedExtra: 0 };
    let malformed = 0;
    const groups = [];
    cards.forEach((card, i) => {
      ctx.index = i + 1;
      if (!Array.isArray(card) || card[0] !== 'vcard' || !Array.isArray(card[1])) { result.skipped.push({ index: ctx.index, reason: 'card ' + ctx.index + ' is not a jCard' }); return; }
      result.stats.cards += 1;
      const props = [];
      for (const raw of card[1]) {
        const prop = readProperty(raw);
        if (prop) props.push(prop); else malformed += 1;
      }
      let c;
      try { c = mapCard(props, ctx); } catch (err) { result.skipped.push({ index: ctx.index, reason: 'card ' + ctx.index + ' could not be read' }); return; }
      c.cardIndex = ctx.index;
      if (c.groupCard) { groups.push(c); return; }
      for (const list of ['phones', 'emails', 'addresses', 'urls', 'ims', 'dates']) {
        if (c[list].length > LIMITS.listEntries) {
          result.warnings.push('card ' + ctx.index + ': kept ' + LIMITS.listEntries + ' of ' + c[list].length + ' ' + list);
          c[list].length = LIMITS.listEntries;
        }
      }
      if (!c.name.formatted && !c.org.name && !c.emails.length && !c.phones.length) {
        result.skipped.push({ index: ctx.index, reason: 'card ' + ctx.index + ' has no name, phone or email' });
        return;
      }
      if (c.photoSource) result.stats.photos += 1;
      result.contacts.push(c);
    });
    // KIND:group cards become labels of the members whose UID they list (2.5).
    for (const g of groups) {
      const wanted = new Set(g.groupCard.members.map((m) => m.replace(/^urn:uuid:/i, '').toLowerCase()));
      const hit = result.contacts.filter((x) => x.uid && wanted.has(x.uid.replace(/^urn:uuid:/i, '').toLowerCase()));
      if (g.groupCard.name && hit.length) hit.forEach((x) => { if (!x.labels.includes(g.groupCard.name)) x.labels.push(g.groupCard.name); });
      else result.skipped.push({ index: g.cardIndex, reason: 'card ' + g.cardIndex + ' is a group card, not a contact' });
    }
    if (malformed) result.warnings.push(malformed + ' propert' + (malformed === 1 ? 'y' : 'ies') + ' that are not [name, parameters, type, value] were ignored');
    if (droppedKeys) result.warnings.push(droppedKeys + ' key(s) named __proto__, constructor or prototype were dropped');
    result.stats.droppedExtra = ctx.droppedExtra;
    return result;
  }

  return { LIMITS, parse };
})();

if (typeof window !== 'undefined') window.NotesContactsJcard = NotesContactsJcard;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsJcard;
