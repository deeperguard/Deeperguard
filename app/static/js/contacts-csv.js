// CSV byte decoding and RFC 4180 reader for contacts (docs/CONTACTS_SPEC.md sections 6.0, 6.3.1 and 7.8).
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

  return { LIMITS, decodeBytes, cleanText, readCsv };
})();

if (typeof window !== 'undefined') window.NotesContactsCsv = NotesContactsCsv;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsCsv;
