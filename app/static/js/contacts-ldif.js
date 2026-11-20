// LDIF (RFC 2849) reader for contacts: Thunderbird address book export, OpenLDAP, Apple Address Book
// (docs/CONTACTS_SPEC.md sections 6.4, 2.4 and 9.4). Pure functions of bytes/text to plain objects: no DOM,
// no network, no store. Written here on purpose (no library). Everything read from a file is data: values are
// never interpreted as HTML and `attr:< url` values are never fetched.
const NotesContactsLdif = (() => {
  const LIMITS = { fileBytes: 64 * 1024 * 1024, lines: 1000000, extraEntries: 200, extraValue: 4096, extraBytes: 32 * 1024, listEntries: 50, photoBytes: 3 * 1024 * 1024, labels: 20 };
  const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
  const PERSON_CLASSES = new Set(['person', 'inetorgperson', 'mozillaabpersonalpha', 'organizationalperson']);
  const GROUP_CLASSES = new Set(['groupofnames', 'mozillaablist']);
  const CONTACT_ATTRS = ['mail', 'mozillasecondemail', 'telephonenumber', 'homephone', 'mobile', 'cellphone', 'fax', 'facsimiletelephonenumber', 'pager', 'givenname', 'sn', 'cn', 'displayname'];
  const PHONES = [['telephonenumber', 'work'], ['homephone', 'home'], ['mobile', 'mobile'], ['cellphone', 'mobile'], ['fax', 'fax'], ['facsimiletelephonenumber', 'fax'], ['pager', 'pager']];
  const ATTR = /^([A-Za-z0-9_][A-Za-z0-9._;-]*)(::|:<|:) *(.*)$/;
  const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function nullMap() { return Object.create(null); }

  // Returns { text, encoding }: UTF-8, else Windows-1252 (6.0); a BOM decides for UTF-8 and UTF-16.
  function decodeBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let start = 0;
    let label = '';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) { start = 2; label = 'utf-16le'; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { start = 2; label = 'utf-16be'; }
    const body = bytes.subarray(start);
    if (label) return { text: new TextDecoder(label).decode(body), encoding: label };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' }; } catch (err) { /* not UTF-8 */ }
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' };
  }

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

  // A line that starts with one space continues the previous line; the space is removed. A comment line
  // is unfolded like any other, so its continuation lines are part of the comment.
  function unfold(physical) {
    const out = [];
    for (const line of physical) {
      if (line[0] === ' ' && out.length && out[out.length - 1] !== '') out[out.length - 1] += line.slice(1);
      else out.push(line);
    }
    return out;
  }

  function valueText(v) {
    if (v.text === null) v.text = clean(v.bytes ? decodeBytes(v.bytes).text : v.raw).trim();
    return v.text;
  }

  // postalAddress lines are separated by `$`; `\24` and `\5C` are the escaped `$` and backslash.
  function postalLines(s) {
    return s.split('$').map((x) => x.replace(/\\24/gi, '$').replace(/\\5c/gi, '\\').trim()).filter(Boolean).join('\n');
  }

  function birthday(y, m, d) {
    if (m && d) {
      const month = Number(m);
      const day = Number(d);
      if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d) || month < 1 || month > 12 || day < 1 || day > DAYS[month - 1]) return null;
      const md = String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      return /^\d{4}$/.test(y) && y !== '0000' ? y + '-' + md : '--' + md;
    }
    if (!m && !d && /^\d{4}$/.test(y) && y !== '0000') return y;
    return null;
  }

  // One record (a list of attribute values) -> { contact } | { group } | { skip }
  function mapRecord(rec, ctx) {
    const attrs = new Map();
    for (const v of rec) {
      if (!attrs.has(v.key)) attrs.set(v.key, []);
      attrs.get(v.key).push(v);
    }
    const taken = new Set();
    const all = (keys) => keys.flatMap((k) => attrs.get(k) || []).filter((v) => valueText(v));
    const take = (v) => { taken.add(v); return valueText(v); };
    // Value of the first of `keys` that has one; the other values stay in `extra` unless they repeat it.
    const first = (keys) => {
      const vs = all(keys);
      if (!vs.length) return '';
      const chosen = take(vs[0]);
      for (const v of vs) if (valueText(v) === chosen) taken.add(v);
      return chosen;
    };
    const classNames = all(['objectclass']).map(valueText);
    const classes = classNames.map((x) => x.toLowerCase());
    const kindName = classNames.filter((x) => x.toLowerCase() !== 'top').pop() || 'no object class';

    if (classes.some((x) => GROUP_CLASSES.has(x))) {
      const members = all(['member', 'mozillaablistmember']).map((v) => {
        const t = valueText(v);
        const m = /(?:^|,) *mail=([^,]+)/i.exec(t);
        return (m ? m[1] : t).trim().toLowerCase();
      });
      return { group: { name: first(['cn', 'displayname']), members, kindName } };
    }
    // Without a person class, a mail or phone attribute is enough; a name alone only when the record names no other kind.
    const untyped = classes.every((x) => x === 'top');
    if (!classes.some((x) => PERSON_CLASSES.has(x)) && !(untyped ? CONTACT_ATTRS : CONTACT_ATTRS.slice(0, 9)).some((k) => all([k]).length)) {
      return { skip: 'not a contact: ' + kindName };
    }

    const c = {
      uid: '', name: { prefix: '', given: '', additional: '', family: '', suffix: '', formatted: '' }, nickname: '',
      org: { name: '', unit: '' }, title: '', phones: [], emails: [], addresses: [], urls: [], ims: [], dates: [],
      note: '', photo: null, labels: [], favorite: false, extra: {}, photoSource: null,
    };
    c.name.given = first(['givenname']);
    c.name.family = first(['sn']);
    c.name.formatted = first(['displayname', 'cn']);
    c.nickname = first(['mozillanickname', 'nickname', 'xmozillanickname']);
    for (const v of all(['mail', 'mozillasecondemail'])) c.emails.push({ type: 'other', label: '', value: take(v), pref: !c.emails.length });
    for (const [key, type] of PHONES) for (const v of all([key])) c.phones.push({ type, label: '', value: take(v), pref: false });

    const addr = (type, parts) => {
      const a = { po_box: '', extended: '', street: '', city: '', region: '', postal: '', country: '' };
      for (const f of Object.keys(parts)) a[f] = parts[f];
      if (Object.values(a).some(Boolean)) c.addresses.push({ ...a, type, label: '', pref: false });
    };
    addr('home', {
      street: first(['mozillahomestreet']), extended: first(['mozillahomestreet2']), city: first(['mozillahomelocalityname']),
      region: first(['mozillahomestate']), postal: first(['mozillahomepostalcode']), country: first(['mozillahomecountryname']),
    });
    const street = first(['street']);
    const postal = all(['postaladdress'])[0];
    addr('work', {
      street: street || (postal ? postalLines(take(postal)) : ''), city: first(['l']), region: first(['st']),
      postal: first(['postalcode']), country: first(['co', 'c']),
    });

    c.org.name = first(['o']);
    c.org.unit = all(['ou']).map(take).join(' / ');
    c.title = first(['title']);
    for (const [key, type] of [['mozillahomeurl', 'home'], ['mozillaworkurl', 'work']]) for (const v of all([key])) c.urls.push({ type, label: '', value: take(v) });
    for (const v of all(['labeleduri'])) {
      const m = /^(\S+)\s*(.*)$/.exec(take(v));
      c.urls.push({ type: m[2] ? 'custom' : 'other', label: m[2], value: m[1] });
    }

    const y = all(['birthyear'])[0];
    const mo = all(['birthmonth'])[0];
    const d = all(['birthday'])[0];
    if (y || mo || d) {
      let value = birthday(y ? valueText(y) : '', mo ? valueText(mo) : '', d ? valueText(d) : '');
      if (value === null && !mo && d) { // `birthday` holding a whole date
        const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(valueText(d));
        if (m) value = birthday(m[1], m[2], m[3]);
      }
      if (value) {
        c.dates.push({ type: 'birthday', label: '', value });
        for (const v of [y, mo, d]) if (v) taken.add(v);
      } else ctx.warnings.push('record ' + ctx.index + ': the birthday could not be read and was kept as an unknown field');
    }
    c.note = all(['description', 'notes']).map(take).join('\n\n');

    for (const v of ['jpegphoto', 'photo'].flatMap((k) => attrs.get(k) || [])) {
      if (!v.bytes) continue;
      taken.add(v);
      if (v.bytes.length > LIMITS.photoBytes) { ctx.warnings.push('record ' + ctx.index + ': photo is larger than 3 MiB and was left out'); continue; }
      const mime = sniffImage(v.bytes);
      if (!mime) { ctx.warnings.push('record ' + ctx.index + ': photo is not a PNG, JPEG, GIF, WebP or BMP image and was left out'); continue; }
      if (!c.photoSource) c.photoSource = { mime, bytes: v.bytes };
    }

    // Everything not mapped is kept by attribute name; a repeated attribute keeps all its values (2.4).
    const ldif = nullMap();
    const names = new Map();
    let size = 0;
    let count = 0;
    for (const v of rec) {
      if (taken.has(v) || !valueText(v)) continue;
      const t = valueText(v);
      if (FORBIDDEN.has(v.name.toLowerCase())) { ctx.droppedKeys += 1; continue; }
      if (t.length > LIMITS.extraValue || count >= LIMITS.extraEntries || size + t.length > LIMITS.extraBytes) { ctx.droppedExtra += 1; continue; }
      if (!names.has(v.key)) names.set(v.key, v.name);
      const name = names.get(v.key);
      size += t.length + name.length;
      count += 1;
      if (!(name in ldif)) ldif[name] = t;
      else if (Array.isArray(ldif[name])) ldif[name].push(t);
      else ldif[name] = [ldif[name], t];
    }
    c.extra = { source: { format: 'ldif' } };
    if (count) c.extra.ldif = ldif;

    const words = c.name.formatted.split(/\s+/).filter(Boolean);
    if (!c.name.given && !c.name.family && words.length === 2) [c.name.given, c.name.family] = words;
    if (!c.name.formatted) {
      c.name.formatted = [c.name.given, c.name.family].filter(Boolean).join(' ') || c.org.name || (c.emails[0] && c.emails[0].value) || (c.phones[0] && c.phones[0].value) || '';
    }
    return { contact: c };
  }

  // `input` is text or bytes. -> { contacts, skipped:[{index,reason}], warnings, stats }
  function parse(input) {
    let text;
    let encoding = 'utf-8';
    const result = { contacts: [], skipped: [], warnings: [], stats: { records: 0, encoding, photos: 0, droppedExtra: 0 } };
    if (typeof input === 'string') text = input;
    else {
      if ((input.byteLength || 0) > LIMITS.fileBytes) {
        result.skipped.push({ index: 0, reason: 'This file is larger than 64 MiB.' });
        return result;
      }
      ({ text, encoding } = decodeBytes(input));
      result.stats.encoding = encoding;
    }
    const physical = text.replace(/^\ufeff/, '').split(/\r\n?|\n/);
    if (physical.length > LIMITS.lines) {
      result.skipped.push({ index: 0, reason: 'This file has more than 1,000,000 lines.' });
      return result;
    }
    const records = [];
    let cur = null;
    let unreadable = 0;
    let urlValues = 0;
    let badBase64 = 0;
    for (const line of unfold(physical)) {
      if (line === '') { cur = null; continue; }
      if (line[0] === '#') continue;
      const m = ATTR.exec(line);
      if (!m) { unreadable += 1; continue; }
      const key = m[1].split(';')[0].toLowerCase();
      if (!cur && !records.length && key === 'version') continue;
      if (m[2] === ':<') { urlValues += 1; continue; }
      if (!m[3].trim()) continue;
      const v = { name: m[1], key, raw: m[3], bytes: null, text: null };
      if (m[2] === '::') {
        v.bytes = base64ToBytes(m[3]);
        if (!v.bytes) { badBase64 += 1; continue; }
      }
      if (!cur) { cur = []; records.push(cur); }
      cur.push(v);
    }
    const ctx = { index: 0, warnings: result.warnings, droppedExtra: 0, droppedKeys: 0 };
    const groups = [];
    records.forEach((rec, i) => {
      ctx.index = i + 1;
      result.stats.records += 1;
      let r;
      try { r = mapRecord(rec, ctx); } catch (err) { result.skipped.push({ index: ctx.index, reason: 'record ' + ctx.index + ' could not be read' }); return; }
      if (r.skip) { result.skipped.push({ index: ctx.index, reason: r.skip }); return; }
      if (r.group) { groups.push({ ...r.group, index: ctx.index }); return; }
      const c = r.contact;
      for (const list of ['phones', 'emails', 'addresses', 'urls', 'ims', 'dates']) {
        if (c[list].length > LIMITS.listEntries) {
          result.warnings.push('record ' + ctx.index + ': kept ' + LIMITS.listEntries + ' of ' + c[list].length + ' ' + list);
          c[list].length = LIMITS.listEntries;
        }
      }
      if (!c.name.formatted && !c.org.name && !c.emails.length && !c.phones.length) {
        result.skipped.push({ index: ctx.index, reason: 'record ' + ctx.index + ' has no name, phone or email' });
        return;
      }
      c.cardIndex = ctx.index;
      if (c.photoSource) result.stats.photos += 1;
      result.contacts.push(c);
    });
    // A group becomes a label on the contacts whose mail address it lists; otherwise it is skipped.
    for (const g of groups) {
      const hit = g.name ? result.contacts.filter((c) => c.emails.some((e) => g.members.includes(e.value.toLowerCase()))) : [];
      for (const c of hit) if (!c.labels.includes(g.name) && c.labels.length < LIMITS.labels) c.labels.push(g.name);
      if (!hit.length) result.skipped.push({ index: g.index, reason: 'not a contact: ' + g.kindName });
    }
    if (urlValues) result.warnings.push(urlValues + ' attribute(s) with a URL value were not followed and were left out');
    if (badBase64) result.warnings.push(badBase64 + ' base64 value(s) could not be decoded and were left out');
    if (unreadable) result.warnings.push(unreadable + ' line(s) were not attribute lines and were ignored');
    if (ctx.droppedKeys) result.warnings.push(ctx.droppedKeys + ' attribute(s) named __proto__, constructor or prototype were dropped');
    result.stats.droppedExtra = ctx.droppedExtra;
    return result;
  }

  return { LIMITS, decodeBytes, parse };
})();

if (typeof window !== 'undefined') window.NotesContactsLdif = NotesContactsLdif;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsLdif;
