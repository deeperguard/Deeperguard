// vCard 2.1 / 3.0 / 4.0 reader and writer for contacts (docs/CONTACTS_SPEC.md sections 6.0, 6.1 and 8.2).
// Pure functions of bytes/text to plain objects: no DOM, no network, no store. Written here on purpose
// (no library). Everything read from a file is data: values are never interpreted as HTML.
const NotesContactsVcard = (() => {
  const LIMITS = {
    fileBytes: 64 * 1024 * 1024,
    cardBytes: 4 * 1024 * 1024,
    lines: 1000000,
    extraEntries: 200,
    extraValue: 4096,
    extraBytes: 32 * 1024,
    listEntries: 50,
    photoBytes: 3 * 1024 * 1024,
  };
  const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
  const IM_SERVICES = ['xmpp', 'skype', 'signal', 'whatsapp', 'matrix', 'telegram', 'aim', 'icq', 'jabber', 'twitter', 'other'];
  const IM_BY_PROPERTY = { 'X-AIM': 'aim', 'X-ICQ': 'icq', 'X-JABBER': 'jabber', 'X-SKYPE': 'skype', 'X-MSN': 'other', 'X-YAHOO': 'other', 'X-GOOGLE-TALK': 'xmpp', 'X-GADUGADU': 'other' };
  const IGNORED_TYPES = new Set(['voice', 'text', 'msg', 'video', 'internet', 'pref', 'x400', 'textphone']);
  const TYPE_WORDS = {
    cell: 'mobile', iphone: 'mobile', mobile: 'mobile', 'x-mobile': 'mobile', home: 'home', work: 'work', main: 'main',
    fax: 'fax', homefax: 'fax', workfax: 'fax', otherfax: 'fax', pager: 'pager', other: 'other',
  };
  const WRITE_TYPE = { mobile: 'CELL', home: 'HOME', work: 'WORK', main: 'MAIN', fax: 'FAX', pager: 'PAGER' };
  const ENCODINGS = ['windows-1252', 'iso-8859-15', 'iso-8859-2', 'utf-8', 'utf-16le', 'shift_jis', 'gbk', 'big5', 'euc-kr', 'koi8-r'];

  // --- 6.0 reading the bytes ---------------------------------------------------------------------
  function decoderFor(label, fatal = false) {
    try { return new TextDecoder(label, { fatal }); } catch (err) { return null; }
  }

  function stripControls(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '').replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
  }

  // Returns { text, encoding }. `forced` is one of ENCODINGS (the "Wrong characters?" choice).
  function decodeBytes(input, forced = '') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let start = 0;
    let label = '';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { start = 3; label = 'utf-8'; }
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) { start = 2; label = 'utf-16le'; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { start = 2; label = 'utf-16be'; }
    const body = bytes.subarray(start);
    if (forced && ENCODINGS.includes(forced) && decoderFor(forced)) {
      return { text: decoderFor(forced).decode(body), encoding: forced };
    }
    if (label) return { text: decoderFor(label).decode(body), encoding: label };
    if (body.length >= 4) {
      let odd = 0;
      let even = 0;
      const n = Math.min(body.length, 200) & ~1;
      for (let i = 0; i < n; i += 2) { if (body[i] === 0) even += 1; if (body[i + 1] === 0) odd += 1; }
      if (odd === n / 2 && even === 0) return { text: decoderFor('utf-16le').decode(body), encoding: 'utf-16le' };
      if (even === n / 2 && odd === 0) return { text: decoderFor('utf-16be').decode(body), encoding: 'utf-16be' };
    }
    try { return { text: decoderFor('utf-8', true).decode(body), encoding: 'utf-8' }; } catch (err) { /* not UTF-8 */ }
    return { text: decoderFor('windows-1252').decode(body), encoding: 'windows-1252' };
  }

  // --- small helpers -----------------------------------------------------------------------------
  function nullMap() { return Object.create(null); }

  // Split on `sep` that is not preceded by an odd number of backslashes.
  function splitUnescaped(value, sep) {
    const out = [];
    let cur = '';
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '\\' && i + 1 < value.length) { cur += ch + value[i + 1]; i += 1; continue; }
      if (ch === sep) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function unescapeText(value, v21) {
    return value.replace(/\\(.)/gs, (m, c) => {
      if (c === 'n' || c === 'N') return v21 ? m : '\n';
      if (c === ';' || c === '\\') return c;
      if (c === ',') return v21 ? m : ',';
      return m;
    });
  }

  function decodeQuotedPrintable(value, charset) {
    const bytes = [];
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(value.substr(i + 1, 2))) { bytes.push(parseInt(value.substr(i + 1, 2), 16)); i += 2; continue; }
      const code = value.charCodeAt(i);
      if (code < 128) bytes.push(code);
      else Array.prototype.push.apply(bytes, Array.from(new TextEncoder().encode(ch)));
    }
    const arr = Uint8Array.from(bytes);
    const label = (charset || 'utf-8').toLowerCase();
    const dec = decoderFor(label === 'utf8' ? 'utf-8' : label) || decoderFor('utf-8');
    return dec.decode(arr);
  }

  function base64ToBytes(b64) {
    const clean = String(b64).replace(/\s+/g, '');
    if (!clean || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) return null;
    if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(clean, 'base64'));
    const bin = atob(clean.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  // The format is decided by the bytes, not by TYPE (6.1.2).
  function sniffImage(b) {
    if (!b || b.length < 12) return '';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    return '';
  }

  // --- 6.1.1 reader: lines, unfolding, properties ------------------------------------------------
  function headerValueSplit(line) {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ':' && !quoted) return [line.slice(0, i), line.slice(i + 1)];
    }
    return null;
  }

  function splitOutsideQuotes(s, sep) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (const ch of s) {
      if (ch === '"') { quoted = !quoted; cur += ch; continue; }
      if (ch === sep && !quoted) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function isEncoded(headerText, kind) {
    const re = kind === 'qp' ? /(?:^|;)\s*(?:ENCODING=)?QUOTED-PRINTABLE\s*(?:;|$)/i : /(?:^|;)\s*(?:ENCODING=)?(?:BASE64|B)\s*(?:;|$)/i;
    return re.test(headerText);
  }

  function logicalLines(physical) {
    const out = [];
    let cur = null;
    for (const line of physical) {
      if (cur !== null) {
        const split = headerValueSplit(cur);
        const header = split ? split[0] : '';
        if (isEncoded(header, 'qp') && cur.endsWith('=')) { cur = cur.slice(0, -1) + line; continue; }
        if (/^[ \t]/.test(line)) { cur += line.slice(1); continue; }
        if (isEncoded(header, 'b') && line !== '' && !line.includes(':') && /^[A-Za-z0-9+/=]+$/.test(line.trim())) { cur += line.trim(); continue; }
        out.push(cur);
      }
      cur = line;
    }
    if (cur !== null) out.push(cur);
    return out;
  }

  // -> { g, n, p: {name: [values]}, raw, qp, b64 } ; `raw` is the value after QP decoding, escapes intact.
  function parseProperty(line, fileCharset) {
    const split = headerValueSplit(line);
    if (!split) return null;
    const segs = splitOutsideQuotes(split[0], ';');
    let head = segs[0].trim();
    let g = '';
    const dot = head.indexOf('.');
    if (dot > 0) { g = head.slice(0, dot); head = head.slice(dot + 1); }
    const n = head.toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(n)) return null;
    const p = nullMap();
    for (const seg of segs.slice(1)) {
      if (!seg.trim()) continue;
      const eq = seg.indexOf('=');
      const key = (eq < 0 ? 'type' : seg.slice(0, eq)).trim().toLowerCase();
      const rawVal = eq < 0 ? seg.trim() : seg.slice(eq + 1);
      if (!key || FORBIDDEN.has(key)) continue;
      const vals = splitOutsideQuotes(rawVal, ',').flatMap((v) => v.trim().replace(/^"(.*)"$/s, '$1').split(',')).map((v) => v.trim()).filter((v) => v !== '');
      p[key] = (p[key] || []).concat(vals);
    }
    const encodings = (p.encoding || []).map((x) => x.toLowerCase()).concat((p.type || []).map((x) => x.toLowerCase()));
    const qp = encodings.includes('quoted-printable');
    const b64 = encodings.some((x) => x === 'b' || x === 'base64');
    let raw = split[1];
    const charset = p.charset && p.charset[0];
    if (qp) raw = decodeQuotedPrintable(raw, charset || (fileCharset === 'windows-1252' ? 'windows-1252' : 'utf-8'));
    if (p.type) p.type = p.type.filter((t) => !['quoted-printable', 'base64', 'b'].includes(t.toLowerCase()));
    if (!p.type || !p.type.length) delete p.type;
    return { g, n, p, raw, qp, b64 };
  }

  // --- model helpers ------------------------------------------------------------------------------
  const APPLE_LABEL = /^_\$!<(.*)>!\$_$/;

  function typeFrom(prop, label) {
    // label: text of the group's X-ABLabel
    if (label) {
      const m = APPLE_LABEL.exec(label);
      const word = (m ? m[1] : '').toLowerCase().replace(/\s+/g, '');
      if (m) {
        if (TYPE_WORDS[word]) return { type: TYPE_WORDS[word], label: '' };
        return { type: 'other', label: '' };
      }
      return { type: 'custom', label };
    }
    const words = ((prop.p && prop.p.type) || []).map((w) => w.toLowerCase());
    for (const w of words) if (TYPE_WORDS[w]) return { type: TYPE_WORDS[w], label: '' };
    for (const w of words) if (!IGNORED_TYPES.has(w)) return { type: 'custom', label: w };
    return { type: 'other', label: '' };
  }

  function isPref(prop) {
    const words = ((prop.p && prop.p.type) || []).map((w) => w.toLowerCase());
    if (words.includes('pref')) return true;
    const pref = prop.p && prop.p.pref;
    return !!(pref && pref[0] === '1');
  }

  const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // -> { value, bad, dropped } ; value '' when unusable.
  function parseDate(raw, omitYear) {
    let v = String(raw).trim();
    let dropped = false;
    const t = v.search(/T/i);
    if (t > 0) { v = v.slice(0, t); dropped = true; }
    let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
    let y = '';
    let mo;
    let d;
    if (m) { [, y, mo, d] = m; }
    else if ((m = /^--(\d{2})-?(\d{2})$/.exec(v))) { [, mo, d] = m; }
    else if ((m = /^(\d{4})$/.exec(v))) { return { value: m[1], dropped }; }
    else return { value: '', bad: true };
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > DAYS[month - 1]) return { value: '', bad: true };
    if (omitYear || y === '1604') y = '';
    return { value: y ? `${y}-${mo}-${d}` : `--${mo}-${d}`, dropped };
  }

  function words(s) { return s.split(/\s+/).filter(Boolean); }

  function builtFormattedName(c) {
    const n = c.name;
    const parts = [n.prefix, n.given, n.additional, n.family, n.suffix].filter(Boolean).join(' ');
    return parts || (c.org && c.org.name) || (c.emails[0] && c.emails[0].value) || (c.phones[0] && c.phones[0].value) || '';
  }

  function orgFromRaw(raw, v21) {
    const parts = splitUnescaped(raw, ';').map((x) => unescapeText(x, v21).trim());
    const name = parts[0] || '';
    const units = parts.slice(1).filter(Boolean);
    return { name, unit: units.join(' / '), multi: units.length > 1 };
  }

  function entryForExtra(prop, ctx) {
    const p = nullMap();
    for (const key of Object.keys(prop.p)) {
      if (key === 'charset') continue;
      if (key === 'encoding' && !prop.b64) continue;
      p[key] = prop.p[key].slice();
    }
    if (prop.b64) p.encoding = ['b'];
    let v = prop.b64 ? prop.raw.replace(/\s+/g, '') : prop.raw.replace(/\r\n?|\n/g, '\\n');
    // eslint-disable-next-line no-control-regex
    v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (v.length > LIMITS.extraValue) { ctx.droppedExtra += 1; return null; }
    return { g: prop.g, n: prop.n, p, v };
  }

  // --- card -> contact ----------------------------------------------------------------------------
  function mapCard(props, version, ctx) {
    const v21 = version === '2.1';
    const c = {
      uid: '', name: { prefix: '', given: '', additional: '', family: '', suffix: '', formatted: '' }, nickname: '',
      org: { name: '', unit: '' }, title: '', phones: [], emails: [], addresses: [], urls: [], ims: [], dates: [],
      note: '', photo: null, labels: [], favorite: false, extra: { vcard: [] }, photoSource: null,
    };
    const labelOf = new Map();
    for (const prop of props) if (prop.n === 'X-ABLABEL' && prop.g) labelOf.set(prop.g.toLowerCase(), unescapeText(prop.raw, v21).trim());
    const labelled = new Set(['TEL', 'EMAIL', 'URL', 'ADR', 'X-ABDATE']);
    const usedGroups = new Set(props.filter((p) => p.g && labelled.has(p.n)).map((p) => p.g.toLowerCase()));
    const labelFor = (prop) => (prop.g ? labelOf.get(prop.g.toLowerCase()) || '' : '');
    const notes = [];
    const extra = [];
    const keep = (prop) => { const e = entryForExtra(prop, ctx); if (e) extra.push(e); };
    const text = (prop) => unescapeText(prop.raw, v21).replace(/\r\n?/g, '\n').trim();
    const flavours = ctx.flavours;
    let rev = '';
    let prodid = '';
    let kind = '';
    const members = [];
    let fn = '';

    for (const prop of props) {
      const { n } = prop;
      switch (n) {
        case 'VERSION': case 'BEGIN': case 'END': break;
        case 'X-ABLABEL': if (!usedGroups.has((prop.g || '').toLowerCase())) keep(prop); break;
        case 'UID': c.uid = text(prop); break;
        case 'REV': rev = text(prop); break;
        case 'PRODID': prodid = text(prop); break;
        case 'FN': fn = text(prop); break;
        case 'N': {
          const [fam, giv, add, pre, suf] = splitUnescaped(prop.raw, ';').map((x) => splitUnescaped(x, ',').map((y) => unescapeText(y, v21).trim()).filter(Boolean).join(' '));
          c.name = { prefix: pre || '', given: giv || '', additional: add || '', family: fam || '', suffix: suf || '', formatted: '' };
          break;
        }
        case 'NICKNAME': c.nickname = splitUnescaped(prop.raw, ',').map((x) => unescapeText(x, v21).trim()).filter(Boolean).join(', '); break;
        case 'ORG': { const o = orgFromRaw(prop.raw, v21); c.org = { name: o.name, unit: o.unit }; if (o.multi) keep(prop); break; }
        case 'TITLE': c.title = text(prop); break;
        case 'TEL': case 'EMAIL': case 'URL': {
          let value = text(prop);
          if (n === 'TEL') value = value.replace(/^tel:/i, '');
          if (!value) break;
          const { type, label } = typeFrom(prop, labelFor(prop));
          c[n === 'TEL' ? 'phones' : n === 'EMAIL' ? 'emails' : 'urls'].push({ type, label, value, pref: isPref(prop) });
          break;
        }
        case 'ADR': {
          const [po, ext, street, city, region, postal, country] = splitUnescaped(prop.raw, ';').map((x) => unescapeText(x, v21).trim());
          const a = { po_box: po || '', extended: ext || '', street: street || '', city: city || '', region: region || '', postal: postal || '', country: country || '' };
          if (!Object.values(a).some(Boolean) && prop.p.label) a.street = prop.p.label[0];
          const { type, label } = typeFrom(prop, labelFor(prop));
          c.addresses.push({ ...a, type, label, pref: isPref(prop) });
          break;
        }
        case 'IMPP': case 'X-AIM': case 'X-ICQ': case 'X-JABBER': case 'X-SKYPE': case 'X-MSN': case 'X-YAHOO': case 'X-GOOGLE-TALK': case 'X-GADUGADU': case 'X-SOCIALPROFILE': {
          let value = text(prop);
          let service = IM_BY_PROPERTY[n] || 'other';
          const fromParam = ((prop.p['x-service-type'] || prop.p.type || [])[0] || '').toLowerCase();
          if (n === 'X-SOCIALPROFILE') {
            if (prop.p['x-user']) value = prop.p['x-user'][0];
            service = IM_SERVICES.includes(fromParam) ? fromParam : 'other';
          } else if (n === 'IMPP') {
            const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
            if (m && IM_SERVICES.includes(m[1].toLowerCase())) { service = m[1].toLowerCase(); value = m[2]; }
            else service = IM_SERVICES.includes(fromParam) ? fromParam : 'other';
          }
          if (value) c.ims.push({ service, value });
          break;
        }
        case 'BDAY': case 'ANNIVERSARY': case 'X-ABDATE': {
          const label = n === 'X-ABDATE' ? labelFor(prop) : '';
          const r = parseDate(text(prop), !!(prop.p['x-apple-omit-year']));
          if (!r.value) { keep(prop); ctx.warnings.push(`card ${ctx.index}: date "${text(prop).slice(0, 40)}" is not a valid date and was kept as an unknown field`); break; }
          let type = n === 'BDAY' ? 'birthday' : n === 'ANNIVERSARY' ? 'anniversary' : 'other';
          let lab = '';
          if (n === 'X-ABDATE' && label) {
            const m = APPLE_LABEL.exec(label);
            if (m && m[1].toLowerCase() === 'anniversary') type = 'anniversary';
            else lab = m ? m[1] : label;
          }
          c.dates.push({ type, label: lab, value: r.value });
          break;
        }
        case 'NOTE': { const t = text(prop); if (t) notes.push(t); break; }
        case 'CATEGORIES': {
          for (const x of splitUnescaped(prop.raw, ',')) {
            const name = unescapeText(x, v21).trim();
            if (name && name.toLowerCase() !== 'mycontacts') c.labels.push(name);
          }
          break;
        }
        case 'KIND': kind = text(prop).toLowerCase(); if (kind !== 'group') keep(prop); break;
        case 'MEMBER': members.push(text(prop)); break;
        case 'PHOTO': {
          let bytes = null;
          const value = prop.raw.trim();
          if (prop.b64) bytes = base64ToBytes(value);
          else if (/^data:/i.test(value)) { const m = /^data:[^;,]*(?:;[^;,]*)*;base64,(.*)$/is.exec(value); bytes = m ? base64ToBytes(m[1]) : null; }
          else { keep(prop); break; }
          if (!bytes) { ctx.warnings.push(`card ${ctx.index}: photo could not be read and was left out`); break; }
          if (bytes.length > LIMITS.photoBytes) { ctx.warnings.push(`card ${ctx.index}: photo is larger than 3 MiB and was left out`); break; }
          const mime = sniffImage(bytes);
          if (!mime) { ctx.warnings.push(`card ${ctx.index}: photo is not a PNG, JPEG, GIF, WebP or BMP image and was left out`); break; }
          if (!c.photoSource) c.photoSource = { mime, bytes };
          break;
        }
        case 'X-ANDROID-CUSTOM': {
          const parts = prop.raw.split(';');
          const mime = (parts[0] || '').trim();
          if (mime === 'vnd.android.cursor.item/nickname' && !c.nickname && parts[1]) c.nickname = unescapeText(parts[1], v21).trim();
          else if (mime === 'vnd.android.cursor.item/contact_event' && parts[1]) {
            const r = parseDate(parts[1].trim(), false);
            const kindCode = (parts[2] || '').trim();
            if (r.value && ['0', '1', '2', '3'].includes(kindCode)) {
              c.dates.push({ type: kindCode === '1' ? 'anniversary' : kindCode === '3' ? 'birthday' : 'other', label: kindCode === '0' ? (parts[3] || '').trim() : '', value: r.value });
            } else keep(prop);
          } else keep(prop);
          flavours.add('android');
          break;
        }
        default: keep(prop);
      }
      if (n === 'X-MS-OL-DEFAULT-POSTAL-ADDRESS') flavours.add('outlook');
      if (/^X-APPLE|^X-ABUID$|^X-ABRELATEDNAMES$/.test(n)) flavours.add('apple');
    }
    c.note = notes.join('\n\n');
    c.labels = c.labels.filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
    if (kind === 'group') { c.groupCard = { name: fn, members, uid: c.uid }; }
    if (!c.name.family && !c.name.given && !c.name.additional && !c.name.prefix && !c.name.suffix && fn && words(fn).length === 2) {
      [c.name.given, c.name.family] = words(fn);
    }
    c.name.formatted = fn || builtFormattedName(c);
    const src = { format: 'vcard', version };
    if (rev) src.rev = rev.slice(0, 64);
    if (prodid) src.prodid = prodid.slice(0, 200);
    const prodLow = prodid.toLowerCase();
    if (/apple/.test(prodLow)) flavours.add('apple');
    if (/sabre|nextcloud|owncloud|radicale/.test(prodLow)) flavours.add('nextcloud');
    if (/proton/.test(prodLow)) flavours.add('proton');
    if (/google/.test(prodLow) || props.some((p) => p.n === 'CATEGORIES' && /mycontacts/i.test(p.raw))) flavours.add('google');
    if (props.some((p) => p.n === 'LABEL') && v21) flavours.add('outlook');
    c.extra = { source: src, vcard: extra };
    return c;
  }

  function finishExtra(c, ctx) {
    const list = c.extra.vcard;
    let size = 0;
    const kept = [];
    for (const e of list) {
      const s = JSON.stringify(e).length;
      if (kept.length >= LIMITS.extraEntries || size + s > LIMITS.extraBytes) { ctx.droppedExtra += 1; continue; }
      size += s;
      kept.push(e);
    }
    c.extra.vcard = kept;
    if (!kept.length) delete c.extra.vcard;
  }

  // --- parse ----------------------------------------------------------------------------------------
  // `input` is text or bytes. -> { contacts, skipped:[{index,reason}], warnings, stats }
  function parse(input, options = {}) {
    let text;
    let encoding = options.fileCharset || '';
    if (typeof input === 'string') text = input;
    else { const d = decodeBytes(input, options.encoding); text = d.text; encoding = d.encoding; }
    text = stripControls(text.replace(/^\ufeff/, '').replace(/\r\n?|\n/g, '\n'));
    const physical = text.split('\n');
    const result = { contacts: [], skipped: [], warnings: [], stats: { cards: 0, versions: [], flavour: '', encoding, photos: 0, droppedExtra: 0 } };
    if (physical.length > LIMITS.lines) {
      result.skipped.push({ index: 0, reason: 'This file has more than 1,000,000 lines.' });
      return result;
    }
    const lines = logicalLines(physical);
    const ctx = { index: 0, warnings: result.warnings, droppedExtra: 0, flavours: new Set() };
    let card = null; // { props, version, bytes, index }
    let agent = 0;
    let lastName = '';
    const cards = [];
    const closeCard = (closed) => {
      if (!card) return;
      if (!closed) result.warnings.push(`card ${card.index} was not closed`);
      cards.push(card);
      card = null;
    };
    for (const line of lines) {
      if (!line.trim()) continue;
      const prop = parseProperty(line, encoding);
      if (!prop) { lastName = ''; continue; }
      if (prop.n === 'BEGIN' && prop.raw.trim().toUpperCase() === 'VCARD') {
        if (agent > 0 || (card && lastName === 'AGENT')) { agent += 1; continue; }
        closeCard(false);
        result.stats.cards += 1;
        card = { props: [], version: '', bytes: 0, index: result.stats.cards };
        lastName = 'BEGIN';
        continue;
      }
      if (prop.n === 'END' && prop.raw.trim().toUpperCase() === 'VCARD') {
        if (agent > 0) { agent -= 1; continue; }
        closeCard(true);
        continue;
      }
      if (!card || agent > 0) continue;
      lastName = prop.n;
      card.bytes += line.length;
      if (card.bytes > LIMITS.cardBytes) { card.tooBig = true; continue; }
      if (prop.n === 'VERSION') card.version = prop.raw.trim();
      card.props.push(prop);
    }
    closeCard(false);
    const flavourCount = new Map();
    const groups = [];
    for (const cd of cards) {
      ctx.index = cd.index;
      if (cd.tooBig) { result.skipped.push({ index: cd.index, reason: `card ${cd.index} is larger than 4 MiB` }); continue; }
      const version = ['2.1', '3.0', '4.0'].includes(cd.version) ? cd.version : '3.0';
      if (!result.stats.versions.includes(version)) result.stats.versions.push(version);
      ctx.flavours = new Set();
      let c;
      try {
        c = mapCard(cd.props, version, ctx);
      } catch (err) {
        result.skipped.push({ index: cd.index, reason: `card ${cd.index} could not be read` });
        continue;
      }
      for (const f of ctx.flavours) flavourCount.set(f, (flavourCount.get(f) || 0) + 1);
      c.cardIndex = cd.index;
      if (c.groupCard) { groups.push(c); continue; }
      for (const list of ['phones', 'emails', 'addresses', 'urls', 'ims', 'dates']) {
        if (c[list].length > LIMITS.listEntries) {
          result.warnings.push(`card ${cd.index}: kept ${LIMITS.listEntries} of ${c[list].length} ${list}`);
          c[list].length = LIMITS.listEntries;
        }
      }
      finishExtra(c, ctx);
      const hasName = c.name.formatted || c.name.given || c.name.family || c.org.name;
      if (!hasName && !c.emails.length && !c.phones.length) {
        result.skipped.push({ index: cd.index, reason: `card ${cd.index} has no name, phone or email` });
        continue;
      }
      if (c.photoSource) result.stats.photos += 1;
      result.contacts.push(c);
    }
    // KIND:group cards become labels of members whose UID they list (2.5).
    for (const g of groups) {
      const wanted = new Set(g.groupCard.members.map((m) => m.replace(/^urn:uuid:/i, '').toLowerCase()));
      const hit = result.contacts.filter((x) => x.uid && wanted.has(x.uid.replace(/^urn:uuid:/i, '').toLowerCase()));
      if (g.groupCard.name && hit.length) hit.forEach((x) => { if (!x.labels.includes(g.groupCard.name)) x.labels.push(g.groupCard.name); });
      else result.skipped.push({ index: g.cardIndex, reason: `card ${g.cardIndex} is a group card, not a contact` });
    }
    result.stats.droppedExtra = ctx.droppedExtra;
    let best = '';
    for (const [f, n] of flavourCount) if (!best || n > flavourCount.get(best)) best = f;
    result.stats.flavour = best;
    return result;
  }

  function looksLikeVcard(text) {
    return /^\s*BEGIN:VCARD/i.test(text.replace(/^\ufeff/, ''));
  }

  // --- 8.2 writer -----------------------------------------------------------------------------------
  function utf8Len(ch) {
    const c = ch.codePointAt(0);
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }

  function fold(line) {
    const out = [];
    let cur = '';
    let bytes = 0;
    let limit = 75;
    for (const ch of line) {
      const w = utf8Len(ch);
      if (bytes + w > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
      cur += ch;
      bytes += w;
    }
    out.push(cur);
    return out.join('\r\n ');
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n?|\n/g, '\\n');
  }

  function paramText(v) {
    return /[;:,\s"]/.test(v) ? `"${v.replace(/"/g, "'")}"` : v;
  }

  function revFrom(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function writeCard(c, version, withPhoto) {
    const v4 = version === '4.0';
    const lines = ['BEGIN:VCARD', `VERSION:${v4 ? '4.0' : '3.0'}`, 'PRODID:-//Deeperguard//Contacts 1//EN'];
    const extra = (c.extra && Array.isArray(c.extra.vcard) ? c.extra.vcard : []).filter((e) => e && typeof e.n === 'string');
    const used = new Set(extra.map((e) => String(e.g || '').toLowerCase()));
    let next = 0;
    const newGroup = () => { do { next += 1; } while (used.has(`item${next}`)); used.add(`item${next}`); return `item${next}`; };
    const name = c.name || {};
    if (c.uid) lines.push(`UID:${esc(c.uid)}`);
    lines.push(`FN:${esc(name.formatted || builtFormattedName({ name, org: c.org || {}, emails: c.emails || [], phones: c.phones || [] }))}`);
    lines.push(`N:${[name.family, name.given, name.additional, name.prefix, name.suffix].map(esc).join(';')}`);
    if (c.nickname) lines.push(`NICKNAME:${esc(c.nickname)}`);
    const org = c.org || {};
    if (org.name || org.unit) {
      const orig = extra.find((e) => e.n === 'ORG');
      const o = orig ? orgFromRaw(String(orig.v), false) : null;
      if (o && o.name === org.name && o.unit === org.unit) lines.push(`ORG:${orig.v}`);
      else lines.push(`ORG:${esc(org.name)}${org.unit ? `;${esc(org.unit)}` : ''}`);
    }
    if (c.title) lines.push(`TITLE:${esc(c.title)}`);
    if (withPhoto && c.photo && c.photo.data) {
      lines.push(v4 ? `PHOTO:data:${c.photo.mime || 'image/jpeg'};base64,${c.photo.data}` : `PHOTO;ENCODING=b;TYPE=JPEG:${c.photo.data}`);
    }
    const typed = (prop, e, value, extraParams = '') => {
      const params = [];
      let group = '';
      if (e.type === 'custom' && e.label) group = newGroup();
      else if (WRITE_TYPE[e.type]) params.push(v4 ? `TYPE=${WRITE_TYPE[e.type].toLowerCase()}` : `TYPE=${WRITE_TYPE[e.type]}${e.pref ? ',PREF' : ''}`);
      if (e.pref && (v4 || group || !WRITE_TYPE[e.type])) params.push(v4 ? 'PREF=1' : 'TYPE=PREF');
      const head = `${group ? `${group}.` : ''}${prop}${params.length ? `;${params.join(';')}` : ''}${extraParams}`;
      lines.push(`${head}:${value}`);
      if (group) lines.push(`${group}.X-ABLabel:${esc(e.label)}`);
    };
    for (const e of c.phones || []) {
      const uri = /^\+?[0-9][0-9.-]*$/.test(e.value);
      if (v4) typed('TEL', e, uri ? `tel:${e.value}` : esc(e.value), uri ? ';VALUE=uri' : ';VALUE=text');
      else typed('TEL', e, esc(e.value));
    }
    for (const e of c.emails || []) typed('EMAIL', e, e.value);
    for (const e of c.addresses || []) {
      typed('ADR', e, [e.po_box, e.extended, e.street, e.city, e.region, e.postal, e.country].map(esc).join(';'));
    }
    for (const e of c.urls || []) typed('URL', e, e.value);
    for (const e of c.ims || []) lines.push(`IMPP:${IM_SERVICES.includes(e.service) ? e.service : 'other'}:${e.value}`);
    for (const e of c.dates || []) {
      const noYear = /^--(\d{2})-(\d{2})$/.exec(e.value);
      const value = noYear && !v4 ? `--${noYear[1]}${noYear[2]}` : e.value;
      if (e.type === 'birthday') lines.push(`BDAY:${value}`);
      else if (e.type === 'anniversary') lines.push(`ANNIVERSARY:${value}`);
      else if (e.label) { const g = newGroup(); lines.push(`${g}.X-ABDATE:${value}`, `${g}.X-ABLabel:${esc(e.label)}`); }
      else lines.push(`X-ABDATE:${value}`);
    }
    if (c.note) lines.push(`NOTE:${esc(c.note)}`);
    if ((c.labels || []).length) lines.push(`CATEGORIES:${c.labels.map(esc).join(',')}`);
    for (const e of extra) {
      if (e.n === 'ORG') continue;
      const params = Object.keys(e.p || {}).filter((k) => !FORBIDDEN.has(k)).map((k) => {
        const vals = (e.p[k] || []).map((v) => paramText(String(v)));
        return `${k.toUpperCase()}=${vals.join(',')}`;
      });
      const head = `${e.g ? `${e.g}.` : ''}${e.n}${params.length ? `;${params.join(';')}` : ''}`;
      lines.push(`${head}:${String(e.v).replace(/\r\n?|\n/g, '\\n')}`);
    }
    const rev = revFrom(c.updated_at);
    if (rev) lines.push(`REV:${rev}`);
    lines.push('END:VCARD');
    return lines.map(fold).join('\r\n');
  }

  // contacts: model objects. -> one string, CRLF, one card per contact.
  function write(contacts, { version = '3.0', photos = true } = {}) {
    return `${contacts.map((c) => writeCard(c, version === '4.0' ? '4.0' : '3.0', photos)).join('\r\n')}\r\n`;
  }

  return { LIMITS, ENCODINGS, decodeBytes, parse, write, looksLikeVcard, sniffImage, fold, builtFormattedName };
})();

if (typeof window !== 'undefined') window.NotesContactsVcard = NotesContactsVcard;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsVcard;
