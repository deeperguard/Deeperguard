// CSV byte decoding, RFC 4180 reader and named-dialect mapping for contacts (docs/CONTACTS_SPEC.md sections 6.0, 6.2, 6.3.1 and 7.8).
// Pure functions of bytes/text to plain arrays: no DOM, no network, no store. Written here on purpose (no library).
// Everything read from a file is data: values are never interpreted as HTML and never as formulas.
const NotesContactsCsv = (() => {
  const LIMITS = { columns: 500, recordChars: 1024 * 1024, detectRecords: 20, detectChars: 256 * 1024 };
  const DELIMITERS = [',', ';', '\t', '|'];

  // --- 6.0 reading the bytes ---------------------------------------------------------------------
  function decoderFor(label, fatal = false) {
    try { return new TextDecoder(label, { fatal }); } catch (err) { return null; }
  }

  // Removes NUL, other C0 controls except tab/CR/LF, and lone surrogates.
  function cleanText(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '')
      .replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
  }

  // Returns { text, encoding }.
  function decodeBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let start = 0;
    let label = '';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { start = 3; label = 'utf-8'; }
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) { start = 2; label = 'utf-16le'; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { start = 2; label = 'utf-16be'; }
    const body = bytes.subarray(start);
    if (label) return { text: cleanText(decoderFor(label).decode(body)), encoding: label };
    if (body.length >= 4) {
      let odd = 0;
      let even = 0;
      const n = Math.min(body.length, 200) & ~1;
      for (let i = 0; i < n; i += 2) { if (body[i] === 0) even += 1; if (body[i + 1] === 0) odd += 1; }
      if (odd === n / 2 && even === 0) return { text: cleanText(decoderFor('utf-16le').decode(body)), encoding: 'utf-16le' };
      if (even === n / 2 && odd === 0) return { text: cleanText(decoderFor('utf-16be').decode(body)), encoding: 'utf-16be' };
    }
    try { return { text: cleanText(decoderFor('utf-8', true).decode(body)), encoding: 'utf-8' }; } catch (err) { /* not UTF-8 */ }
    return { text: cleanText(decoderFor('windows-1252').decode(body)), encoding: 'windows-1252' };
  }

  // --- 6.3.1 the scanner -------------------------------------------------------------------------
  // One index-based pass. Returns { records, warnings }. Stops after `maxRecords` records (skipped ones count).
  // A record over a limit is reported and dropped; the scan carries on to the next record boundary.
  function scan(text, delim, maxRecords) {
    const n = text.length;
    const delimCode = delim.charCodeAt(0);
    const records = [];
    const warnings = [];
    let fields = [];
    let parts = [];
    let recNo = 0; // records seen so far (non-empty lines)
    let recStart = 0;
    let segStart = 0; // start of the current unquoted segment
    let inQuotes = false;
    let fieldQuoted = false;
    let recQuoted = false;
    let skipping = false;
    let overColumns = false;
    let i = 0;

    const endField = () => {
      if (!inQuotes) parts.push(text.slice(segStart, i));
      if (!skipping) {
        const value = parts.length === 1 ? parts[0] : parts.join('');
        fields.push(fieldQuoted ? value.replace(/\r\n?/g, '\n') : value);
        if (fields.length > LIMITS.columns) {
          warnings.push('record ' + (recNo + 1) + ' has more than ' + LIMITS.columns + ' columns and was skipped');
          skipping = true;
          overColumns = true;
          fields = [];
        }
      }
      parts = [];
      fieldQuoted = false;
    };
    const endRecord = () => {
      endField();
      const empty = fields.length === 1 && fields[0] === '' && !recQuoted;
      if (!empty) {
        recNo += 1;
        if (!skipping) records.push(fields);
      }
      fields = [];
      skipping = false;
      recQuoted = false;
    };

    while (i < n) {
      const before = i;
      if (inQuotes) {
        const q = text.indexOf('"', i);
        if (q < 0) {
          if (!skipping) parts.push(text.slice(i));
          i = n;
        } else if (text.charCodeAt(q + 1) === 34) {
          if (!skipping) parts.push(text.slice(i, q + 1));
          i = q + 2;
        } else {
          if (!skipping) parts.push(text.slice(i, q));
          i = q + 1;
          inQuotes = false;
          segStart = i;
        }
      } else {
        const c = text.charCodeAt(i);
        if (c === 10 || c === 13) {
          endRecord();
          i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
          segStart = i;
          recStart = i;
          if (recNo >= maxRecords) break;
        } else if (c === delimCode) {
          endField();
          i += 1;
          segStart = i;
        } else if (c === 34 && !fieldQuoted && parts.length === 0 && i === segStart) {
          inQuotes = true;
          fieldQuoted = true;
          recQuoted = true;
          i += 1;
        } else {
          i += 1;
        }
      }
      if (!skipping && i - recStart > LIMITS.recordChars) {
        warnings.push('record ' + (recNo + 1) + ' is longer than 1 MiB and was skipped');
        skipping = true;
        fields = [];
        parts = [];
      }
      if (i <= before) throw new Error('CSV scanner did not advance');
    }
    if (inQuotes && !skipping) warnings.push('unterminated quote in record ' + (recNo + 1));
    if (n > recStart && recNo < maxRecords) { inQuotes = false; segStart = n; endRecord(); }
    return { records, warnings, overColumns };
  }

  // Scores each candidate on the first records only: a delimiter whose records all have the same column
  // count (more than one) wins; then more columns; then more records agreeing with the first.
  function detectDelimiter(text) {
    const window = text.length > LIMITS.detectChars ? text.slice(0, LIMITS.detectChars) : text;
    let best = ',';
    let bestKey = [-1, 0, 0];
    for (const d of DELIMITERS) {
      const { records, overColumns } = scan(window, d, LIMITS.detectRecords);
      if (!records.length && !overColumns) continue;
      // A first record with too many columns still shows that this delimiter splits the file.
      const cols = records.length ? records[0].length : LIMITS.columns + 1;
      const matches = records.filter((r) => r.length === cols).length;
      const tier = cols > 1 ? (matches === records.length ? 2 : 1) : 0;
      const key = [tier, cols, matches];
      let better = false;
      for (let k = 0; k < 3; k += 1) {
        if (key[k] !== bestKey[k]) { better = key[k] > bestKey[k]; break; }
      }
      if (better) { best = d; bestKey = key; }
    }
    return best;
  }

  function uniqueHeaders(row) {
    const seen = new Set();
    return row.map((cell) => {
      const base = cell.trim();
      let name = base;
      for (let k = 2; seen.has(name.toLowerCase()); k += 1) name = base + ' (' + k + ')';
      seen.add(name.toLowerCase());
      return name;
    });
  }

  // text -> { rows, delimiter, warnings }. rows[0] is the header (trimmed, unique); shorter rows are padded with ''
  // to the header width, longer rows keep their surplus cells (the mapping step decides what to do with them).
  // opts.delimiter overrides detection.
  const FORMULA_QUOTED = /^'[=+\-@\t\r]/;
  function readCsv(text, opts = {}) {
    const warnings = [];
    let body = String(text);
    let delimiter = DELIMITERS.includes(opts.delimiter) ? opts.delimiter : '';
    const sep = /^sep=([^\r\n"])(?:\r\n?|\n)/i.exec(body.slice(0, 16));
    if (sep) {
      body = body.slice(sep[0].length);
      if (!delimiter) delimiter = sep[1];
    }
    if (!delimiter) delimiter = detectDelimiter(body);
    const scanned = scan(body, delimiter, Infinity);
    warnings.push(...scanned.warnings);
    const rows = scanned.records;
    if (!rows.length) return { rows, delimiter, warnings };
    rows[0] = uniqueHeaders(rows[0]);
    // 6.3.1: a leading ' our own export put before = + - @ TAB CR (8.4) is removed; every other cell stays as typed.
    for (let r = 1; r < rows.length; r += 1) {
      rows[r] = rows[r].map((value) => (FORMULA_QUOTED.test(value) ? value.slice(1) : value));
    }
    const width = rows[0].length;
    let padded = 0;
    let wide = 0;
    for (let r = 1; r < rows.length; r += 1) {
      if (rows[r].length < width) { padded += 1; while (rows[r].length < width) rows[r].push(''); }
      else if (rows[r].length > width) wide += 1;
    }
    if (padded) warnings.push(padded + ' record(s) had fewer columns than the header and were padded');
    if (wide) warnings.push(wide + ' record(s) had more columns than the header');
    return { rows, delimiter, warnings };
  }

  // --- 6.2 named dialects --------------------------------------------------------------------------
  // Outlook writes localised headers. Only the translations the spec names are known (nl); a header in another
  // language is not recognised and goes to the mapping step.
  const OUTLOOK_ALIASES = { voornaam: 'first name', achternaam: 'last name', 'e-mailadres': 'e-mail address' };
  const DIALECTS = ['google', 'google-old', 'outlook', 'outlook-com', 'thunderbird', 'yahoo'];
  const MULTI = ' ::: ';
  const MAX_EXTRA_VALUE = 4096;
  const MAX_EXTRA_BYTES = 32 * 1024;
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const TYPE_WORDS = { home: 'home', work: 'work', business: 'work', mobile: 'mobile', cell: 'mobile', main: 'main', fax: 'fax', pager: 'pager', other: 'other' };
  const DAY_FIRST = 'dmy';
  const MONTH_FIRST = 'mdy';

  const lower = (h) => String(h).replace(/^﻿/, '').trim().toLowerCase();
  const outlookKey = (h) => OUTLOOK_ALIASES[lower(h)] || lower(h);

  // headers -> dialect name or null. Case-insensitive, trimmed (and a stray BOM ignored).
  // outlook and outlook-com share one column set in the spec; the sample of outlook.com has no Business Phone,
  // so a file with Business Phone is called outlook and one without it outlook-com. Both map the same way.
  function detectDialect(headers) {
    if (!Array.isArray(headers)) return null;
    const plain = new Set(headers.map(lower));
    const has = (...names) => names.every((n) => plain.has(n));
    if (has('first name', 'organization name', 'e-mail 1 - value')) return 'google';
    if (has('given name', 'family name', 'group membership')) return 'google-old';
    if (has('primary email', 'display name')) return 'thunderbird';
    if (has('first', 'last', 'email', 'messenger id')) return 'yahoo';
    const out = new Set(headers.map(outlookKey));
    if (out.has('first name') && out.has('e-mail address')) return out.has('business phone') ? 'outlook' : 'outlook-com';
    return null;
  }

  const split = (value, sep = MULTI) => String(value).split(sep).map((s) => s.trim()).filter(Boolean);

  function typed(label) {
    let s = String(label).trim();
    let pref = false;
    if (s.startsWith('* ')) { pref = true; s = s.slice(2).trim(); }
    const type = TYPE_WORDS[s.toLowerCase()];
    if (type) return { type, label: '', pref };
    return s ? { type: 'custom', label: s, pref } : { type: 'other', label: '', pref };
  }

  const daysIn = (y, m) => {
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  };
  function ymd(y, m, d) {
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
    return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  const LOCALE_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;

  // { iso } ('' when the cell holds no date) or { bad: true }. `order` decides a local date such as 2/3/1970.
  function parseDate(raw, order) {
    const v = String(raw).trim().slice(0, 40);
    if (!v) return { iso: '' };
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v);
    if (m) { const iso = ymd(m[1], m[2], m[3]); return iso ? { iso } : { bad: true }; }
    m = /^--(\d{2})-?(\d{2})$/.exec(v);
    if (m) return ymd(2000, m[1], m[2]) ? { iso: '--' + m[1] + '-' + m[2] } : { bad: true };
    m = LOCALE_DATE.exec(v);
    if (!m) return { bad: true };
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 && b === 0) return { iso: '' }; // Outlook's "no date" is 0/0/00
    if (m[3].length !== 4) return { bad: true };
    const iso = order === MONTH_FIRST ? ymd(m[3], a, b) : ymd(m[3], b, a);
    return iso ? { iso } : { bad: true };
  }

  // 6.2-3: the order is decided per file. A first number above 12 means day first, a second one above 12 month first.
  function dateEvidence(values) {
    let day = false;
    let month = false;
    let sample = '';
    for (const raw of values) {
      const m = LOCALE_DATE.exec(String(raw).trim());
      if (!m) continue;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 0 && b === 0) continue;
      if (a > 12 && b <= 12) day = true;
      else if (b > 12 && a <= 12) month = true;
      else if (a <= 12 && b <= 12 && a !== b && !sample) sample = String(raw).trim();
    }
    return { day, month, sample };
  }

  function ensureModel() {
    if (typeof NotesContacts !== 'undefined') return NotesContacts;
    if (typeof module !== 'undefined' && module.exports) return require('./contacts.js');
    throw new Error('contacts.js must be loaded before mapRows');
  }

  // A cursor over one row: take() reads a column by header (case-insensitive) and marks it as mapped.
  function makeCursor(index, cells, used, ctx) {
    const take = (name) => {
      const i = index[name.toLowerCase()];
      if (i === undefined) return '';
      used.add(i);
      return String(cells[i] === undefined ? '' : cells[i]).trim();
    };
    const first = (...names) => names.map(take).find(Boolean) || '';
    const add = (list, type, value) => { if (value) list.push({ type, value, label: '', pref: false }); };
    const date = (raw, type, label = '') => {
      const res = parseDate(raw, ctx.order);
      if (res.bad) ctx.badDates += 1;
      else if (res.iso) ctx.c.dates.push({ type, label, value: res.iso });
    };
    const address = (type, parts, label = '') => {
      const a = { street: '', extended: '', po_box: '', city: '', region: '', postal: '', country: '', ...parts };
      if (Object.values(a).some(Boolean)) ctx.c.addresses.push({ type, label, pref: false, ...a });
    };
    const im = (service, value) => { if (value) ctx.c.ims.push({ service, label: '', value }); };
    return { take, first, add, date, address, im, c: ctx.c };
  }

  // Google: "X n - Label|Type" with "X n - Value"; a value cell may hold several values separated by ' ::: '.
  function labelled(r, kind, n, list) {
    const t = split(r.first(kind + ' ' + n + ' - Label', kind + ' ' + n + ' - Type'));
    split(r.take(kind + ' ' + n + ' - Value')).forEach((v, j) => {
      const x = typed(t[j] !== undefined ? t[j] : (t[0] || ''));
      list.push({ type: x.type, value: v, label: x.label, pref: x.pref });
    });
  }

  function mapGoogle(r, ctx) {
    const c = r.c;
    Object.assign(c.name, {
      formatted: r.take('Name'),
      given: r.first('First Name', 'Given Name'),
      additional: r.first('Middle Name', 'Additional Name'),
      family: r.first('Last Name', 'Family Name'),
      prefix: r.take('Name Prefix'),
      suffix: r.take('Name Suffix'),
      phonetic_given: r.take('Phonetic First Name'),
      phonetic_family: r.take('Phonetic Last Name'),
    });
    c.nickname = r.take('Nickname');
    c.org = { name: r.take('Organization Name'), unit: r.take('Organization Department') };
    c.title = r.take('Organization Title');
    c.note = r.take('Notes');
    r.date(r.take('Birthday'), 'birthday');
    for (const col of ['Labels', 'Group Membership']) {
      for (const g of split(r.take(col))) c.labels.push(g.replace(/^\* /, ''));
    }
    c.labels = c.labels.filter((g) => g.toLowerCase() !== 'mycontacts');
    for (const n of ctx.nums['e-mail'] || []) labelled(r, 'E-mail', n, c.emails);
    for (const n of ctx.nums.phone || []) labelled(r, 'Phone', n, c.phones);
    for (const n of ctx.nums.website || []) labelled(r, 'Website', n, c.urls);
    for (const n of ctx.nums.address || []) {
      const p = 'Address ' + n + ' - ';
      const x = typed(r.first(p + 'Label', p + 'Type'));
      const parts = { street: r.take(p + 'Street'), city: r.take(p + 'City'), po_box: r.take(p + 'PO Box'), region: r.take(p + 'Region'), postal: r.take(p + 'Postal Code'), country: r.take(p + 'Country'), extended: r.take(p + 'Extended Address') };
      const formatted = r.take(p + 'Formatted');
      if (!Object.values(parts).some(Boolean)) parts.street = formatted;
      r.address(x.type, parts, x.label);
    }
    for (const n of ctx.nums.event || []) {
      const label = r.take('Event ' + n + ' - Label');
      const anniversary = label.toLowerCase() === 'anniversary';
      r.date(r.take('Event ' + n + ' - Value'), anniversary ? 'anniversary' : 'other', anniversary ? '' : label);
    }
    const org = (ctx.nums.organization || [])[0];
    if (org !== undefined) {
      const p = 'Organization ' + org + ' - ';
      c.org = { name: c.org.name || r.take(p + 'Name'), unit: c.org.unit || r.take(p + 'Department') };
      c.title = c.title || r.take(p + 'Title');
    }
  }

  function mapOutlook(r) {
    const c = r.c;
    Object.assign(c.name, { prefix: r.take('Title'), given: r.take('First Name'), additional: r.take('Middle Name'), family: r.take('Last Name'), suffix: r.take('Suffix') });
    c.nickname = r.take('Nickname');
    for (const h of ['E-mail Address', 'E-mail 2 Address', 'E-mail 3 Address']) r.add(c.emails, 'other', r.take(h));
    const phones = [['Home Phone', 'home'], ['Home Phone 2', 'home'], ['Business Phone', 'work'], ['Business Phone 2', 'work'], ['Mobile Phone', 'mobile'],
      ['Primary Phone', 'main'], ['Business Fax', 'fax'], ['Home Fax', 'fax'], ['Other Fax', 'fax'], ['Pager', 'pager'], ['Car Phone', 'other'],
      ['Other Phone', 'other'], ['Company Main Phone', 'main']];
    for (const [h, type] of phones) r.add(c.phones, type, r.take(h));
    c.org = { name: r.take('Company'), unit: r.take('Department') };
    c.title = r.take('Job Title');
    for (const [p, type] of [['Business', 'work'], ['Home', 'home'], ['Other', 'other']]) {
      const street = [r.take(p + ' Street'), r.take(p + ' Street 2'), r.take(p + ' Street 3')].filter(Boolean).join('\n');
      r.address(type, { street, city: r.take(p + ' City'), region: r.take(p + ' State'), postal: r.take(p + ' Postal Code'), country: r.take(p + ' Country/Region') });
    }
    r.date(r.take('Birthday'), 'birthday');
    r.date(r.take('Anniversary'), 'anniversary');
    c.note = r.take('Notes');
    r.add(c.urls, 'other', r.take('Web Page'));
    c.labels = split(r.take('Categories'), ';');
    r.im('other', r.take('IMAddress'));
  }

  function mapThunderbird(r) {
    const c = r.c;
    Object.assign(c.name, { given: r.take('First Name'), family: r.take('Last Name'), formatted: r.take('Display Name') });
    c.nickname = r.take('Nickname');
    r.add(c.emails, 'other', r.take('Primary Email'));
    r.add(c.emails, 'other', r.take('Secondary Email'));
    r.im('aim', r.take('Screen Name'));
    for (const [h, type] of [['Work Phone', 'work'], ['Home Phone', 'home'], ['Fax Number', 'fax'], ['Pager Number', 'pager'], ['Mobile Number', 'mobile']]) r.add(c.phones, type, r.take(h));
    for (const [p, type] of [['Home', 'home'], ['Work', 'work']]) {
      const street = [r.take(p + ' Address'), r.take(p + ' Address 2')].filter(Boolean).join('\n');
      r.address(type, { street, city: r.take(p + ' City'), region: r.take(p + ' State'), postal: r.take(p + ' ZipCode'), country: r.take(p + ' Country') });
    }
    c.title = r.take('Job Title');
    c.org = { name: r.take('Organization'), unit: r.take('Department') };
    r.add(c.urls, 'work', r.take('Web Page 1'));
    r.add(c.urls, 'home', r.take('Web Page 2'));
    // Three separate columns; without a year the birthday is year-less ("--MM-DD").
    const year = r.take('Birth Year');
    const month = r.take('Birth Month');
    const day = r.take('Birth Day');
    if (month && day) {
      const withYear = /^\d{4}$/.test(year);
      const iso = ymd(withYear ? year : 2000, month, day);
      r.date(iso ? (withYear ? iso : '--' + iso.slice(5)) : 'invalid', 'birthday');
    } else if (year || month || day) {
      r.date('invalid', 'birthday');
    }
    c.note = r.take('Notes');
  }

  function mapYahoo(r) {
    const c = r.c;
    Object.assign(c.name, { given: r.take('First'), additional: r.take('Middle'), family: r.take('Last') });
    c.nickname = r.take('Nickname');
    for (const h of ['Email', 'Alternate Email 1', 'Alternate Email 2']) r.add(c.emails, 'other', r.take(h));
    for (const [h, type] of [['Home', 'home'], ['Work', 'work'], ['Pager', 'pager'], ['Fax', 'fax'], ['Mobile', 'mobile'], ['Other', 'other']]) r.add(c.phones, type, r.take(h));
    r.im('other', r.take('Messenger ID'));
    r.im('other', r.take('Yahoo ID'));
    r.add(c.urls, 'home', r.take('Personal Website'));
    r.add(c.urls, 'work', r.take('Business Website'));
    c.title = r.take('Title');
    c.org = { name: r.take('Company'), unit: '' };
    for (const [p, type] of [['Work', 'work'], ['Home', 'home']]) {
      r.address(type, { street: r.take(p + ' Address'), city: r.take(p + ' City'), region: r.take(p + ' State'), postal: r.take(p + ' ZIP'), country: r.take(p + ' Country') });
    }
    r.date(r.take('Birthday'), 'birthday');
    r.date(r.take('Anniversary'), 'anniversary');
    const category = r.take('Category');
    if (category) c.labels.push(category);
    c.note = r.take('Comments');
  }

  const MAPPERS = { google: mapGoogle, 'google-old': mapGoogle, outlook: mapOutlook, 'outlook-com': mapOutlook, thunderbird: mapThunderbird, yahoo: mapYahoo };
  const LOCALE_DATE_COLUMNS = { outlook: ['birthday', 'anniversary'], 'outlook-com': ['birthday', 'anniversary'], yahoo: ['birthday', 'anniversary'] };

  function hasData(c, extraCount) {
    return extraCount > 0 || Object.values(c.name).some(Boolean) || c.nickname || c.org.name || c.org.unit || c.title || c.note
      || c.labels.length || ['phones', 'emails', 'addresses', 'urls', 'ims', 'dates'].some((f) => c[f].length);
  }

  // rows (from readCsv) + dialect name -> { contacts, warnings, dateOrder, dateOrderAsk }. `contacts` are stored-shape
  // contact contents (NotesContacts.buildContact). opts.dateOrder ('dmy' or 'mdy') is used when the file does not
  // decide; `dateOrderAsk` then holds a sample date for the "day first or month first?" question (6.2-3).
  function mapRows(rows, dialect, opts = {}) {
    const custom = typeof dialect === 'function';
    const mapper = custom ? dialect : MAPPERS[dialect];
    const warnings = [];
    if (!mapper) return { contacts: [], warnings: ['Unknown CSV dialect'], dateOrder: null, dateOrderAsk: '' };
    if (!Array.isArray(rows) || rows.length < 2) return { contacts: [], warnings, dateOrder: null, dateOrderAsk: '' };
    const model = ensureModel();
    const headers = rows[0].map((h) => String(h));
    const keyOf = !custom && dialect.startsWith('outlook') ? outlookKey : lower;
    const index = Object.create(null);
    const nums = Object.create(null);
    headers.forEach((h, i) => {
      const key = keyOf(h);
      if (!(key in index)) index[key] = i;
      const m = /^(e-mail|phone|address|website|event|organization) (\d+) - /.exec(key);
      if (m) {
        if (!nums[m[1]]) nums[m[1]] = [];
        if (!nums[m[1]].includes(m[2])) nums[m[1]].push(m[2]);
      }
    });
    const dateCols = (opts.dateColumns || (custom ? [] : LOCALE_DATE_COLUMNS[dialect]) || []).map((n) => index[n]).filter((i) => i !== undefined);
    let order = opts.dateOrder === MONTH_FIRST ? MONTH_FIRST : DAY_FIRST;
    let dateOrder = null;
    let dateOrderAsk = '';
    if (dateCols.length) {
      const ev = dateEvidence(rows.slice(1).flatMap((row) => dateCols.map((i) => row[i] || '')));
      if (ev.day && ev.month) {
        warnings.push('Dates mix day-first and month-first; day-first was used and the others were not kept');
        dateOrder = DAY_FIRST;
        order = DAY_FIRST;
      } else if (ev.day || ev.month) {
        dateOrder = ev.month ? MONTH_FIRST : DAY_FIRST;
        order = dateOrder;
      } else if (ev.sample) {
        dateOrderAsk = ev.sample;
        dateOrder = order;
      }
    }

    const now = new Date().toISOString();
    const limits = model.LIMITS;
    const contacts = [];
    const tally = { empty: 0, headerless: 0, badDates: 0, tooLarge: 0, extraKept: 0, extraDropped: 0 };
    const overList = Object.create(null);
    let overLabels = 0;
    for (let ri = 1; ri < rows.length; ri += 1) {
      const cells = rows[ri];
      if (cells.length > headers.length) tally.headerless += cells.length - headers.length;
      const ctx = { order, nums, badDates: 0, c: { name: {}, org: { name: '', unit: '' }, phones: [], emails: [], addresses: [], urls: [], ims: [], dates: [], labels: [] } };
      const used = new Set();
      mapper(makeCursor(index, cells, used, ctx), ctx);
      tally.badDates += ctx.badDates;
      const c = ctx.c;

      // 2.4: every non-empty column nobody mapped, by its original header, on a null-prototype object.
      const csv = Object.create(null);
      let bytes = 0;
      for (let i = 0; i < headers.length; i += 1) {
        const value = String(cells[i] === undefined ? '' : cells[i]);
        if (used.has(i) || !value.trim()) continue;
        const key = headers[i] || '(column ' + (i + 1) + ')';
        const cost = key.length + Math.min(value.length, MAX_EXTRA_VALUE) + 6;
        if (FORBIDDEN_KEYS.has(key.toLowerCase()) || bytes + cost > MAX_EXTRA_BYTES) { tally.extraDropped += 1; continue; }
        csv[key] = value.slice(0, MAX_EXTRA_VALUE);
        bytes += cost;
        tally.extraKept += 1;
      }
      const extraCount = Object.keys(csv).length;
      if (!hasData(c, extraCount)) { tally.empty += 1; continue; }

      for (const f of model.LIST_FIELDS) {
        if (c[f].length > limits.listEntries) { overList[f] = (overList[f] || 0) + c[f].length - limits.listEntries; c[f].length = limits.listEntries; }
      }
      if (c.labels.length > limits.labels) { overLabels += c.labels.length - limits.labels; c.labels.length = limits.labels; }
      try {
        const { content } = model.buildContact(c, null, now);
        content.extra = { source: { format: 'csv', flavour: custom ? 'generic' : dialect } };
        if (extraCount) content.extra.csv = csv;
        contacts.push(content);
      } catch (err) {
        tally.tooLarge += 1;
      }
    }
    if (tally.empty) warnings.push(tally.empty + ' empty record(s) skipped');
    if (tally.tooLarge) warnings.push(tally.tooLarge + ' record(s) were too large and skipped');
    if (tally.badDates) warnings.push(tally.badDates + ' date(s) could not be read and were not kept');
    if (tally.headerless) warnings.push(tally.headerless + ' cell(s) beyond the header were not kept');
    if (tally.extraDropped) warnings.push('kept ' + tally.extraKept + ', dropped ' + tally.extraDropped + ' unmapped field(s)');
    for (const f of Object.keys(overList)) warnings.push(overList[f] + ' ' + f + ' entries over the limit of ' + limits.listEntries + ' per contact were not kept');
    if (overLabels) warnings.push(overLabels + ' labels over the limit of ' + limits.labels + ' per contact were not kept');
    if (dateOrderAsk) warnings.push('Dates look like ' + dateOrderAsk + ': read as ' + (order === MONTH_FIRST ? 'month' : 'day') + ' first; the file does not decide the order');
    return { contacts, warnings, dateOrder, dateOrderAsk };
  }

  // --- 6.3.2 the mapping step for a CSV that is not a named dialect --------------------------------
  const SYNONYMS = {
    given: ['first name', 'given name', 'first', 'given', 'voornaam', 'vorname', 'prenom', 'nombre', 'nome proprio', 'primo nome'],
    additional: ['middle name', 'additional name', 'tussenvoegsel', 'zweiter vorname', 'segundo nombre', 'secondo nome'],
    family: ['last name', 'family name', 'surname', 'last', 'achternaam', 'nachname', 'familienname', 'nom', 'nom de famille', 'apellido', 'apellidos', 'cognome', 'sobrenome'],
    prefix: ['name prefix', 'prefix', 'aanhef', 'anrede'],
    suffix: ['name suffix', 'suffix', 'achtervoegsel', 'namenszusatz'],
    formatted: ['name', 'full name', 'display name', 'naam', 'volledige naam', 'anzeigename', 'vollstandiger name', 'nom complet', 'nombre completo', 'nome completo', 'nome'],
    nickname: ['nickname', 'nick name', 'bijnaam', 'spitzname', 'surnom', 'apodo', 'soprannome', 'apelido'],
    org: ['company', 'organization', 'organisation', 'organization name', 'firma', 'bedrijf', 'organisatie', 'unternehmen', 'societe', 'entreprise', 'empresa', 'azienda'],
    unit: ['department', 'afdeling', 'abteilung', 'departement', 'departamento', 'reparto'],
    title: ['job title', 'title', 'position', 'functie', 'berufsbezeichnung', 'titre', 'puesto', 'cargo', 'posizione'],
    'phone:mobile': ['mobile', 'mobile phone', 'cell', 'cell phone', 'mobiel', 'mobiele telefoon', 'handy', 'mobil', 'portable', 'movil', 'cellulare', 'telemovel', 'celular', 'gsm'],
    'phone:home': ['home phone', 'telefoon thuis', 'telefon privat', 'tel prive', 'telefono casa', 'telefone residencial'],
    'phone:work': ['work phone', 'business phone', 'telefoon werk', 'telefon geschaftlich', 'tel pro', 'telefono trabajo', 'telefone comercial'],
    'phone:fax': ['fax'],
    'phone:main': ['phone', 'telephone', 'tel', 'phone number', 'telefoon', 'telefoonnummer', 'telefon', 'rufnummer', 'telefono', 'telefone'],
    'email:other': ['email', 'e mail', 'email address', 'e mail address', 'mail', 'e mail adres', 'emailadres', 'courriel', 'correo', 'correo electronico', 'posta elettronica'],
    url: ['website', 'web', 'url', 'homepage', 'webseite', 'site web', 'sitio web', 'sito web', 'pagina web'],
    im: ['messenger', 'im', 'skype', 'whatsapp'],
    street: ['street', 'street address', 'address', 'adres', 'straat', 'strasse', 'adresse', 'rue', 'calle', 'direccion', 'via', 'indirizzo', 'rua'],
    city: ['city', 'plaats', 'woonplaats', 'stad', 'ort', 'stadt', 'ville', 'ciudad', 'citta', 'cidade'],
    region: ['state', 'province', 'region', 'provincie', 'bundesland', 'estado', 'provincia'],
    postal: ['zip', 'zip code', 'postal code', 'postcode', 'postleitzahl', 'plz', 'code postal', 'codigo postal', 'cap', 'cep'],
    country: ['country', 'land', 'pays', 'pais', 'paese'],
    birthday: ['birthday', 'birth date', 'date of birth', 'geboortedatum', 'verjaardag', 'geburtstag', 'geburtsdatum', 'date de naissance', 'anniversaire', 'cumpleanos', 'fecha de nacimiento', 'compleanno', 'data di nascita', 'aniversario', 'data de nascimento'],
    anniversary: ['anniversary', 'trouwdatum', 'hochzeitstag'],
    note: ['note', 'notes', 'comments', 'comment', 'memo', 'notitie', 'notities', 'opmerking', 'opmerkingen', 'bemerkung', 'bemerkungen', 'notiz', 'remarque', 'nota', 'notas'],
    labels: ['label', 'labels', 'group', 'groups', 'category', 'categories', 'groep', 'groepen', 'categorie', 'gruppe', 'kategorie', 'groupe', 'categoria', 'grupo'],
    favourite: ['favorite', 'favourite', 'starred', 'favoriet', 'favorit', 'favori', 'favorito', 'preferito'],
  };
  const SYNONYM_TARGET = Object.create(null);
  for (const t of Object.keys(SYNONYMS)) for (const w of SYNONYMS[t]) SYNONYM_TARGET[w] = t;

  // [value, label] of every target a column can be mapped to. 'extra' keeps the column under extra.csv.
  const TARGETS = [
    ['extra', 'Keep as other field'], ['ignore', 'Ignore'],
    ['prefix', 'Name: prefix'], ['given', 'Name: given'], ['additional', 'Name: additional'], ['family', 'Name: family'], ['suffix', 'Name: suffix'],
    ['formatted', 'Name: full name'], ['nickname', 'Nickname'],
    ['org', 'Organisation'], ['unit', 'Department'], ['title', 'Job title'],
    ['phone:mobile', 'Phone: mobile'], ['phone:home', 'Phone: home'], ['phone:work', 'Phone: work'], ['phone:main', 'Phone: main'], ['phone:fax', 'Phone: fax'], ['phone:pager', 'Phone: pager'], ['phone:other', 'Phone: other'],
    ['email:home', 'Email: home'], ['email:work', 'Email: work'], ['email:other', 'Email: other'],
    ['street', 'Address: street'], ['extended', 'Address: extended'], ['city', 'Address: city'], ['region', 'Address: region'], ['postal', 'Address: postal code'], ['country', 'Address: country'],
    ['url', 'Website'], ['im', 'Messenger'],
    ['birthday', 'Date: birthday'], ['anniversary', 'Date: anniversary'], ['date', 'Date: other'],
    ['note', 'Note'], ['labels', 'Labels'], ['favourite', 'Favourite'],
  ];
  const REPEATABLE = (t) => t === 'extra' || t === 'ignore' || t === 'url' || t === 'im' || t === 'labels' || t.startsWith('phone:') || t.startsWith('email:');
  const NEEDS_ONE = (t) => ['given', 'family', 'formatted', 'additional', 'org'].includes(t) || t.startsWith('phone:') || t.startsWith('email:');

  function fold(header) {
    return String(header).replace(/^\ufeff/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // The suggested target for a header ('extra' when nothing in the synonym table matches).
  function suggestTarget(header) {
    return SYNONYM_TARGET[fold(header)] || 'extra';
  }

  // targets: one value of TARGETS per column. Returns '' when the mapping can be used, else the reason it cannot.
  function checkMapping(targets) {
    const seen = new Set();
    for (const t of targets) {
      if (!REPEATABLE(t)) {
        if (seen.has(t)) return 'Two columns are mapped to "' + (TARGETS.find((x) => x[0] === t) || [t, t])[1] + '". Choose it for one column only.';
        seen.add(t);
      }
    }
    if (!targets.some(NEEDS_ONE)) return 'Map at least one column to a name, organisation, email or phone.';
    return '';
  }

  const TRUE_WORDS = new Set(['1', 'true', 'yes', 'x', 'star']);
  const LABEL_SEPARATOR = /\s*(?: ::: |;|,)\s*/;

  // rows (from readCsv, header first) + targets (one per column) -> the result of mapRows.
  function mapGeneric(rows, targets, opts = {}) {
    if (checkMapping(targets)) return { contacts: [], warnings: [checkMapping(targets)], dateOrder: null, dateOrderAsk: '' };
    const headers = rows[0].map((h) => String(h));
    const mapper = (r, ctx) => {
      const c = ctx.c;
      const address = {};
      headers.forEach((h, i) => {
        const t = targets[i];
        if (t === undefined || t === 'extra') return;
        const v = r.take(h);
        if (!v || t === 'ignore') return;
        if (['prefix', 'given', 'additional', 'family', 'suffix', 'formatted'].includes(t)) { if (!c.name[t]) c.name[t] = v; }
        else if (t === 'nickname' || t === 'title' || t === 'note') { if (!c[t]) c[t] = v; }
        else if (t === 'org') c.org.name = c.org.name || v;
        else if (t === 'unit') c.org.unit = c.org.unit || v;
        else if (t.startsWith('phone:')) r.add(c.phones, t.slice(6), v);
        else if (t.startsWith('email:')) r.add(c.emails, t.slice(6), v);
        else if (t === 'url') r.add(c.urls, 'other', v);
        else if (t === 'im') r.im('other', v);
        else if (t === 'birthday' || t === 'anniversary') r.date(v, t);
        else if (t === 'date') r.date(v, 'other');
        else if (t === 'labels') { for (const l of v.split(LABEL_SEPARATOR)) if (l && !c.labels.includes(l)) c.labels.push(l); }
        else if (t === 'favourite') { if (TRUE_WORDS.has(v.toLowerCase())) c.favorite = true; }
        else address[t] = address[t] || v;
      });
      r.address('other', address);
      const n = c.name;
      if (n.formatted && !n.given && !n.family) {
        const comma = n.formatted.split(',');
        const words = n.formatted.split(/\s+/);
        if (comma.length === 2 && comma[0].trim() && comma[1].trim()) { n.family = comma[0].trim(); n.given = comma[1].trim(); }
        else if (words.length === 2) [n.given, n.family] = words;
      }
    };
    const dateColumns = headers.filter((h, i) => ['birthday', 'anniversary', 'date'].includes(targets[i])).map((h) => lower(h));
    return mapRows(rows, mapper, { ...opts, dateColumns });
  }

  // --- 8.3 / 8.4 the writer --------------------------------------------------------------------------
  // Google Contacts dialect, UTF-8 with BOM, CRLF. Lossy by design: `extra` and IM handles are not written.
  const FORMULA_START = /^[=+\-@\t\r]/;
  // 8.4: a text cell that a spreadsheet would run as a formula gets a leading ' (phone numbers starting with + too).
  const neutralise = (value) => (FORMULA_START.test(value) ? "'" + value : value);
  const quoteCell = (value) => (/[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value);
  const cell = (value) => quoteCell(neutralise(String(value === undefined || value === null ? '' : value)));
  const WRITE_GROUPS = [
    ['E-mail', 'emails', ['Label', 'Value']],
    ['Phone', 'phones', ['Label', 'Value']],
    ['Address', 'addresses', ['Label', 'Formatted', 'Street', 'City', 'PO Box', 'Region', 'Postal Code', 'Country', 'Extended Address']],
    ['Website', 'urls', ['Label', 'Value']],
    ['Event', 'events', ['Label', 'Value']],
  ];
  const FIXED_COLUMNS = ['Name', 'First Name', 'Middle Name', 'Last Name', 'Name Prefix', 'Name Suffix', 'Nickname', 'Phonetic First Name', 'Phonetic Last Name',
    'Organization Name', 'Organization Title', 'Organization Department', 'Birthday', 'Notes', 'Labels'];

  function typeLabel(entry) {
    const word = entry.type === 'custom' ? String(entry.label || '') : String(entry.type || '').replace(/^./, (ch) => ch.toUpperCase());
    return (entry.pref && word ? '* ' : '') + word;
  }

  function writeCsv(contacts) {
    const list = Array.isArray(contacts) ? contacts : [];
    const views = list.map((c) => {
      const dates = c.dates || [];
      const birthday = dates.find((d) => d.type === 'birthday');
      return {
        c,
        birthday,
        events: dates.filter((d) => d !== birthday).map((d) => ({ label: d.type === 'anniversary' ? 'Anniversary' : (d.label || 'Other'), value: d.value })),
      };
    });
    const entriesOf = (v, key) => (key === 'events' ? v.events : (v.c[key] || []));
    const counts = WRITE_GROUPS.map(([, key]) => Math.max(1, ...views.map((v) => entriesOf(v, key).length)));
    const header = [...FIXED_COLUMNS];
    WRITE_GROUPS.forEach(([name, , fields], gi) => {
      for (let n = 1; n <= counts[gi]; n += 1) for (const f of fields) header.push(name + ' ' + n + ' - ' + f);
    });
    const lines = [header.map(quoteCell).join(',')];
    for (const v of views) {
      const c = v.c;
      const name = c.name || {};
      const org = c.org || {};
      const row = [name.formatted, name.given, name.additional, name.family, name.prefix, name.suffix, c.nickname, name.phonetic_given, name.phonetic_family,
        org.name, c.title, org.unit, v.birthday ? v.birthday.value : '', c.note, (c.labels || []).join(MULTI)];
      WRITE_GROUPS.forEach(([, key, fields], gi) => {
        const entries = entriesOf(v, key);
        for (let n = 0; n < counts[gi]; n += 1) {
          const e = entries[n];
          if (!e) { for (let k = 0; k < fields.length; k += 1) row.push(''); continue; }
          if (key === 'events') row.push(e.label, e.value);
          else if (key === 'addresses') {
            const formatted = [e.street, [e.postal, e.city].filter(Boolean).join(' '), e.country].filter(Boolean).join('\n');
            row.push(typeLabel(e), formatted, e.street, e.city, e.po_box, e.region, e.postal, e.country, e.extended);
          } else row.push(typeLabel(e), e.value);
        }
      });
      lines.push(row.map(cell).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  return { write: writeCsv, LIMITS, DIALECTS, TARGETS, decodeBytes, cleanText, readCsv, detectDialect, mapRows, suggestTarget, checkMapping, mapGeneric };
})();

if (typeof window !== 'undefined') window.NotesContactsCsv = NotesContactsCsv;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsCsv;
