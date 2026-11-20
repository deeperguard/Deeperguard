// Contacts import flow (docs/CONTACTS_SPEC.md section 7): choose files, parse in the browser, preview with
// counts, import, result summary, undo. Other formats plug into the same preview and summary through
// registerFormat(). vCard, LDIF, jCard and CSV are told apart by their content, never by the file name; a CSV
// that is not a named dialect goes through the mapping step (spec 6.3.2) first. Files are read with File.arrayBuffer() and parsed here; nothing is uploaded and nothing
// decrypted is stored outside the vault.
const NotesContactsImport = (() => {
  const LIMITS = { fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, contacts: 10000, listed: 50 };
  const NOT_CONTACTS = 'This is not a contact file. Export your contacts as vCard (.vcf) and choose that file.';
  const UNSUPPORTED = 'This is not a contact file in a supported format. Supported formats: vCard (.vcf), CSV, LDIF and jCard (JSON). Export your contacts in one of these and choose that file.';
  const SAMPLE_ROWS = 3;
  const formats = [];
  // The CSV, LDIF and jCard readers are separate scripts; under node (tests) they are required on first use.
  const lib = {
    get csv() { return typeof NotesContactsCsv !== 'undefined' ? NotesContactsCsv : require('./contacts-csv.js'); },
    get ldif() { return typeof NotesContactsLdif !== 'undefined' ? NotesContactsLdif : require('./contacts-ldif.js'); },
    get jcard() { return typeof NotesContactsJcard !== 'undefined' ? NotesContactsJcard : require('./contacts-jcard.js'); },
  };

  // A format is { id, label, sniff(text) -> bool, parse(text, { encoding }) -> { contacts, skipped, warnings, stats },
  // describe(stats) -> string }. parse() may return `needsMapping: { rows }` instead of contacts: the dialog then asks
  // the user how the columns map before the contacts exist. Contacts are plain objects in the shape NotesContacts.buildContact takes; an
  // optional `photoSource: { mime, bytes }` is re-encoded to the stored JPEG when the import runs.
  function registerFormat(format) {
    if (!format || !format.id || typeof format.sniff !== 'function' || typeof format.parse !== 'function') throw new Error('Invalid import format');
    const at = formats.findIndex((f) => f.id === format.id);
    if (at >= 0) formats[at] = format; else formats.push(format);
  }

  function mb(n) { return `${Math.round(n / (1024 * 1024))} MiB`; }

  // files: File-like objects { name, size, arrayBuffer() }. Never throws for a single bad file.
  async function readFiles(files, { encoding = '', decode } = {}) {
    const dec = decode || NotesContactsVcard.decodeBytes;
    const out = { files: [], contacts: [], problems: [], overLimit: 0, pending: [] };
    let total = 0;
    for (const file of files) {
      const name = String(file.name || 'file');
      const entry = { name, ok: false, reason: '', label: '', found: 0, photos: 0, skipped: [], warnings: [], droppedExtra: 0 };
      out.files.push(entry);
      const size = Number(file.size) || 0;
      if (size === 0) { entry.reason = 'this file is empty.'; continue; }
      if (size > LIMITS.fileBytes) { entry.reason = `this file is larger than ${mb(LIMITS.fileBytes)}. A file that big is almost always photos: export your contacts without photos.`; continue; }
      total += size;
      if (total > LIMITS.totalBytes) { entry.reason = `the files together are larger than ${mb(LIMITS.totalBytes)}. Import fewer files at a time.`; continue; }
      let bytes;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (err) { entry.reason = 'this file could not be read.'; continue; }
      const { text, encoding: used } = dec(bytes, encoding);
      if (text.slice(0, 4096).includes('\u0000') || !text.trim()) { entry.reason = text.trim() ? NOT_CONTACTS : 'this file is empty.'; continue; }
      const format = formats.find((f) => f.sniff(text));
      if (!format) { entry.reason = UNSUPPORTED; continue; }
      let parsed;
      try { parsed = format.parse(text, { encoding: used }); } catch (err) { entry.reason = 'this file could not be read as ' + format.label + '.'; continue; }
      if (parsed.needsMapping) {
        entry.encoding = used;
        entry.label = format.describe ? format.describe(parsed.stats || {}, used) : format.label;
        entry.warnings = parsed.warnings || [];
        entry.ok = true;
        out.pending.push({ entry, name, format, rows: parsed.needsMapping.rows, stats: parsed.stats || {} });
        continue;
      }
      entry.encoding = used;
      entry.label = format.describe ? format.describe(parsed.stats || {}, used) : format.label;
      entry.skipped = parsed.skipped || [];
      entry.warnings = parsed.warnings || [];
      entry.photos = (parsed.stats && parsed.stats.photos) || 0;
      entry.droppedExtra = (parsed.stats && parsed.stats.droppedExtra) || 0;
      entry.found = parsed.contacts.length + entry.skipped.length;
      entry.ok = true;
      if (!parsed.contacts.length) entry.reason = entry.skipped.length ? 'no contact in this file could be imported.' : 'this file holds no contacts.';
      for (const c of parsed.contacts) {
        if (out.contacts.length >= LIMITS.contacts) { out.overLimit += 1; continue; }
        out.contacts.push({ ...c, sourceFile: name, sourceFormat: format.id, sourceStats: parsed.stats || {} });
      }
    }
    collectProblems(out);
    return out;
  }

  function collectProblems(out) {
    out.problems = [];
    for (const f of out.files) {
      if (f.reason) out.problems.push(`${f.name}: ${f.reason}`);
      for (const s of f.skipped) out.problems.push(`${f.name}: ${s.reason}`);
      for (const w of f.warnings) out.problems.push(`${f.name}: ${w}`);
    }
    if (out.overLimit) out.problems.push(`Too many contacts: ${LIMITS.contacts.toLocaleString('en')} is the most per import, ${out.overLimit} were left out. Import the rest in a second run.`);
  }

  // The user confirmed the column mapping of a pending CSV: its contacts join the others (same limits as above).
  function finishMapping(out, pending, targets) {
    const mapped = lib.csv.mapGeneric(pending.rows, targets);
    const entry = pending.entry;
    entry.warnings = [...entry.warnings, ...mapped.warnings];
    entry.found = mapped.contacts.length;
    if (!mapped.contacts.length) entry.reason = 'no contact in this file could be imported.';
    for (const c of mapped.contacts) {
      if (out.contacts.length >= LIMITS.contacts) { out.overLimit += 1; continue; }
      out.contacts.push({ ...c, sourceFile: entry.name, sourceFormat: pending.format.id, sourceStats: pending.stats });
    }
    out.pending = out.pending.filter((p) => p !== pending);
    collectProblems(out);
  }

  const plural = (n, one, many) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

  function previewSummary(state, existingCount, fileCount = 0) {
    const n = state.contacts.length;
    const skipped = state.files.reduce((a, f) => a + f.skipped.length, 0);
    const photos = state.contacts.filter((c) => c.photoSource).length;
    const refused = state.files.filter((f) => !f.ok).length;
    const parts = [`Found ${plural(n, 'contact', 'contacts')} in ${plural(state.files.length, 'file', 'files')}`];
    if (existingCount) parts.push(`${existingCount.toLocaleString('en')} look like contacts you already have`);
    if (fileCount) parts.push(`${fileCount.toLocaleString('en')} occur more than once in the file`);
    if (skipped) parts.push(`${skipped.toLocaleString('en')} skipped`);
    if (refused) parts.push(`${plural(refused, 'file', 'files')} not read`);
    parts.push(`${state.problems.length.toLocaleString('en')} ${state.problems.length === 1 ? 'problem' : 'problems'} found`);
    if (photos) parts.push(`${photos.toLocaleString('en')} with a photo`);
    return `${parts.join('. ')}.`;
  }

  // Re-encode the photo of each contact in `list` (3.4); returns the number kept and a list of problems.
  async function attachPhotos(list) {
    let stored = 0;
    const problems = [];
    for (const c of list) {
      if (!c.photoSource) continue;
      try {
        const res = await NotesContacts.encodePhoto(new Blob([c.photoSource.bytes], { type: c.photoSource.mime }));
        if (res.photo) { c.photo = res.photo; stored += 1; } else problems.push(`${c.sourceFile}: card ${c.cardIndex}: ${res.error.toLowerCase()}, contact kept without photo`);
      } catch (err) {
        problems.push(`${c.sourceFile}: card ${c.cardIndex}: the photo could not be read, contact kept without photo`);
      }
    }
    return { stored, problems };
  }

  function displayOf(c) {
    const n = c.name || {};
    return n.formatted || [n.given, n.family].filter(Boolean).join(' ') || (c.org && c.org.name) || (c.emails[0] && c.emails[0].value) || (c.phones[0] && c.phones[0].value) || 'No name';
  }

  // --- dialog controller -------------------------------------------------------------------------------
  const el = (id) => document.getElementById(id);
  let ui = null;
  let state = null;
  let matches = []; // per parsed contact: null or a duplicate match (NotesContacts.matchIncoming)
  let existingList = []; // the vault's contacts the matches point at (names for the preview only)
  let choiceAll = null; // 'skip' | 'merge' | 'both' once the user picked one for all duplicates
  let choiceEach = new Map(); // parsed contact index -> choice set on that contact
  let selected = new Set();
  let busy = false;
  let undoRecord = null;
  let hooks = null;
  let currentFiles = [];
  let mapping = null; // { pending, targets }: the CSV whose columns the user is mapping (held in memory only)

  function setText(id, value) { const e = el(id); if (e) e.textContent = value; }
  function show(id, on) { const e = el(id); if (e) e.hidden = !on; }
  function fill(id, items) {
    const list = el(id);
    list.replaceChildren();
    for (const t of items) { const li = document.createElement('li'); li.textContent = t; list.append(li); }
    list.hidden = items.length === 0;
  }
  function showError(message) { setText('contacts-import-error', message || ''); show('contacts-import-error', !!message); }

  function resetView() {
    state = null;
    currentFiles = [];
    matches = [];
    existingList = [];
    choiceAll = null;
    choiceEach = new Map();
    selected = new Set();
    showError('');
    show('contacts-import-preview', false);
    show('contacts-import-result', false);
    show('contacts-import-run', false);
    show('contacts-import-undo', false);
    el('contacts-import-file').value = '';
    el('contacts-import-run').disabled = false;
    clearMapping();
  }

  function clearMapping() {
    mapping = null;
    show('contacts-import-mapping', false);
    el('contacts-import-map-body').replaceChildren();
    setText('contacts-import-map-error', '');
    show('contacts-import-map-error', false);
  }

  function dropUndo() { undoRecord = null; }

  function close() {
    if (busy) return;
    resetView();
    if (!el('contacts-import-dialog')) return;
    el('contacts-import-dialog').hidden = true;
    el('contacts-import-backdrop').hidden = true;
    document.body.classList.remove('scan-dialog-open');
  }

  // Lock or sign-out: forget every parsed contact and the undo record, close the dialog.
  function reset() {
    busy = false;
    dropUndo();
    close();
  }

  const REASON = { email: 'same email address', phone: 'same phone number', name: 'same name only', uid: 'same contact imported before' };
  const CHOICES = [['skip', 'Skip'], ['merge', 'Merge'], ['both', 'Keep both']];

  // What happens to parsed contact i: a contact without a match is added; a duplicate follows its own choice, else
  // the one for all, else Skip (Keep both when only the name matches).
  function actionFor(i) {
    const m = matches[i];
    if (!m) return 'new';
    return choiceEach.get(i) || choiceAll || (m.kind === 'possible' ? 'both' : 'skip');
  }

  function importableIndexes() {
    const out = [];
    state.contacts.forEach((c, i) => { if (selected.has(i) && actionFor(i) !== 'skip') out.push(i); });
    return out;
  }

  function updateRunButton() {
    const n = importableIndexes().length;
    const run = el('contacts-import-run');
    run.hidden = false;
    run.disabled = n === 0;
    run.textContent = n ? `Import ${plural(n, 'contact', 'contacts')}` : 'Nothing to import';
  }

  function matchText(i) {
    const m = matches[i];
    const why = m.kind === 'possible' ? REASON.name : m.reasons.map((r) => REASON[r] || r).join(' and ');
    let other;
    if (m.target.id !== undefined) {
      const found = existingList.find((c) => c.uuid === m.target.id);
      other = `${found ? displayOf(found) : 'a contact'} (in your vault)`;
    } else other = `${displayOf(state.contacts[m.target.index])} (earlier in this file)`;
    return `${displayOf(state.contacts[i])}: ${why} as ${other}`;
  }

  function renderDuplicates() {
    const dupIdx = [];
    matches.forEach((m, i) => { if (m && selected.has(i)) dupIdx.push(i); });
    show('contacts-import-dups', matches.some((m) => m));
    const all = choiceAll || 'skip';
    for (const [value] of CHOICES) el(`contacts-import-dup-all-${value}`).checked = value === all;
    const list = el('contacts-import-dup-list');
    list.replaceChildren();
    dupIdx.slice(0, LIMITS.listed).forEach((i) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const text = document.createElement('span');
      text.textContent = `${matchText(i)} `;
      const select = document.createElement('select');
      select.setAttribute('aria-label', `What to do with ${displayOf(state.contacts[i])}`);
      for (const [value, name] of CHOICES) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = name;
        select.append(o);
      }
      select.value = actionFor(i);
      select.addEventListener('change', () => { choiceEach.set(i, select.value); updateRunButton(); });
      label.append(text, select);
      li.append(label);
      list.append(li);
    });
    setText('contacts-import-dup-note', dupIdx.length > LIMITS.listed ? `Showing the first ${LIMITS.listed} of ${dupIdx.length.toLocaleString('en')} duplicates. The others follow the choice above.` : '');
  }

  function renderPreview() {
    setText('contacts-import-summary', previewSummary(state, matches.filter((m) => m && m.existing).length, matches.filter((m) => m && !m.existing).length));
    fill('contacts-import-files', state.files.map((f) => (f.ok ? `${f.name}: ${f.label}, ${plural(f.found, 'entry', 'entries')}` : `${f.name}: not read`)));
    fill('contacts-import-problems', state.problems);
    const list = el('contacts-import-list');
    list.replaceChildren();
    state.contacts.slice(0, LIMITS.listed).forEach((c, i) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(i);
      box.addEventListener('change', () => { if (box.checked) selected.add(i); else selected.delete(i); renderPreview(); });
      const name = document.createElement('span');
      name.textContent = ` ${displayOf(c)}${matches[i] ? (matches[i].existing ? ' (already in your vault)' : ' (twice in this file)') : ''}`;
      label.append(box, name);
      li.append(label);
      list.append(li);
    });
    setText('contacts-import-list-note', state.contacts.length > LIMITS.listed ? `Showing the first ${LIMITS.listed} of ${state.contacts.length.toLocaleString('en')}. The others are imported too.` : '');
    renderDuplicates();
    show('contacts-import-preview', true);
    show('contacts-import-encoding-row', state.files.some((f) => f.ok));
    updateRunButton();
  }

  function truncate(v) { return v.length > 80 ? `${v.slice(0, 80)}…` : v; }

  // Spec 6.3.2: each column with its header, the first sample values and a select of target fields. Everything
  // from the file goes in through textContent.
  function showMapping() {
    const pending = state.pending[0];
    const headers = pending.rows[0];
    const targets = headers.map((h) => lib.csv.suggestTarget(h));
    mapping = { pending, targets };
    show('contacts-import-preview', false);
    show('contacts-import-run', false);
    setText('contacts-import-map-intro', `${pending.entry.name}: this CSV is not from a program we know. Choose what each column holds. Columns set to "Keep as other field" are saved on the contact as they are.`);
    const body = el('contacts-import-map-body');
    body.replaceChildren();
    headers.forEach((h, i) => {
      const tr = document.createElement('tr');
      const head = document.createElement('th');
      head.scope = 'row';
      head.dataset.label = 'Column';
      head.textContent = h || `(column ${i + 1})`;
      const samples = document.createElement('td');
      samples.dataset.label = 'Examples';
      pending.rows.slice(1).map((row) => String(row[i] === undefined ? '' : row[i])).filter((v) => v.trim()).slice(0, SAMPLE_ROWS).forEach((v) => {
        const d = document.createElement('div');
        d.className = 'contacts-map-sample';
        d.textContent = truncate(v);
        samples.append(d);
      });
      const pick = document.createElement('td');
      pick.dataset.label = 'Field';
      const label = document.createElement('label');
      label.className = 'sr-only';
      label.htmlFor = `contacts-import-map-${i}`;
      label.textContent = `Field for column ${h || i + 1}`;
      const select = document.createElement('select');
      select.id = `contacts-import-map-${i}`;
      for (const [value, text] of lib.csv.TARGETS) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        select.append(o);
      }
      select.value = targets[i];
      select.addEventListener('change', () => { targets[i] = select.value; checkMapping(); });
      pick.append(label, select);
      tr.append(head, samples, pick);
      body.append(tr);
    });
    checkMapping();
    show('contacts-import-mapping', true);
    const first = el('contacts-import-map-0');
    if (first) first.focus();
  }

  function checkMapping() {
    const problem = lib.csv.checkMapping(mapping.targets);
    setText('contacts-import-map-error', problem);
    show('contacts-import-map-error', !!problem);
    el('contacts-import-map-confirm').disabled = !!problem;
  }

  function confirmMapping() {
    if (!mapping || lib.csv.checkMapping(mapping.targets)) return;
    finishMapping(state, mapping.pending, mapping.targets);
    mapping = null;
    show('contacts-import-mapping', false);
    el('contacts-import-map-body').replaceChildren();
    if (state.pending.length) showMapping(); else enterPreview();
  }

  function enterPreview() {
    existingList = hooks.listContacts();
    matches = NotesContacts.matchIncoming(state.contacts, existingList);
    choiceAll = null;
    choiceEach = new Map();
    selected = new Set(state.contacts.map((c, i) => i));
    renderPreview();
    if (!state.contacts.length) showError(state.problems[0] || 'No contacts were found.');
  }

  async function load(files) {
    if (busy || !files.length) return;
    currentFiles = files;
    showError('');
    show('contacts-import-result', false);
    clearMapping();
    busy = true;
    setText('contacts-import-status', 'Reading files…');
    try {
      state = await readFiles(files, { encoding: el('contacts-import-encoding').value });
    } finally {
      busy = false;
      setText('contacts-import-status', '');
    }
    if (state.pending.length) showMapping(); else enterPreview();
  }

  async function run() {
    if (busy || !state) return;
    if (!hooks.isUnlocked()) { showError('Vault locked. Nothing was imported.'); return; }
    const plan = importableIndexes();
    if (!plan.length) return;
    const chosen = plan.map((i) => state.contacts[i]);
    const place = new Map(plan.map((i, pos) => [i, pos]));
    const merges = new Map();
    plan.forEach((i, pos) => {
      const m = matches[i];
      if (!m || actionFor(i) !== 'merge') return;
      if (m.target.id !== undefined) merges.set(pos, { id: m.target.id });
      else if (place.has(m.target.index)) merges.set(pos, { index: place.get(m.target.index) });
    });
    busy = true;
    el('contacts-import-dialog').setAttribute('aria-busy', 'true');
    el('contacts-import-run').disabled = true;
    const summaryState = state;
    const skippedDuplicates = state.contacts.filter((c, i) => selected.has(i) && actionFor(i) === 'skip').length;
    let result;
    let photoProblems = [];
    let photosStored = 0;
    try {
      const photos = await attachPhotos(chosen);
      photoProblems = photos.problems;
      photosStored = photos.stored;
      const batch = `b-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
      result = await hooks.importContacts(chosen, {
        batch,
        merges,
        onProgress: (done, total) => setText('contacts-import-status', `Importing ${done} of ${total}`),
      });
    } catch (err) {
      busy = false;
      el('contacts-import-dialog').removeAttribute('aria-busy');
      setText('contacts-import-status', '');
      showError(hooks.isUnlocked() ? 'The import failed. Nothing more was written.' : 'Vault locked. Nothing was imported.');
      return;
    }
    busy = false;
    el('contacts-import-dialog').removeAttribute('aria-busy');
    setText('contacts-import-status', '');
    undoRecord = result.created.length || result.merged.length ? result : null;
    const lines = [
      `Imported ${plural(result.created.length, 'new contact', 'new contacts')}`
      + (result.mergedCount ? `, ${result.mergedCount.toLocaleString('en')} merged into other contacts` : '')
      + (skippedDuplicates ? `, ${skippedDuplicates.toLocaleString('en')} skipped as duplicates` : '')
      + `, ${(summaryState.files.reduce((a, f) => a + f.skipped.length, 0) + result.failed.length).toLocaleString('en')} not imported`
      + (photosStored ? `, ${photosStored.toLocaleString('en')} photos stored` : '') + '.',
    ];
    if (result.stopped) lines.push(`Stopped after ${result.created.length} contacts (vault locked).`);
    const dropped = Object.keys(result.dropped).length;
    if (dropped) lines.push('Some fields did not fit and were left out.');
    setText('contacts-import-result-summary', lines.join(' '));
    fill('contacts-import-result-problems', [...summaryState.problems, ...photoProblems, ...result.failed.map((f) => `Contact ${f.index + 1}: ${f.reason}`)]);
    show('contacts-import-preview', false);
    show('contacts-import-run', false);
    show('contacts-import-result', true);
    show('contacts-import-undo', !!undoRecord);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    setText('contacts-import-offline', offline ? 'Saved on this device; sync will upload them when you are online.' : '');
    hooks.done(result, undoRecord ? () => undo() : null);
  }

  function undo() {
    if (!undoRecord || !hooks.isUnlocked()) return;
    const record = undoRecord;
    undoRecord = null;
    const { removed, restored, kept } = hooks.restoreContacts(record);
    show('contacts-import-undo', false);
    const msg = `Import undone: ${plural(removed, 'contact', 'contacts')} removed${restored ? `, ${plural(restored, 'merge', 'merges')} undone` : ''}${kept ? `, ${plural(kept, 'contact was', 'contacts were')} edited since and kept` : ''}.`;
    setText('contacts-import-result-summary', msg);
    hooks.undone(msg);
  }

  // hooks: { isUnlocked, listContacts, importContacts, restoreContacts, done(result, undoFn), undone(message) }
  function open(h) {
    hooks = h;
    if (!hooks.isUnlocked()) return false;
    resetView();
    el('contacts-import-dialog').hidden = false;
    el('contacts-import-backdrop').hidden = false;
    document.body.classList.add('scan-dialog-open');
    return true;
  }

  function init() {
    if (ui || !el('contacts-import-dialog')) return;
    ui = true;
    const input = el('contacts-import-file');
    el('contacts-import-pick').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { const files = Array.from(input.files || []); input.value = ''; load(files); });
    el('contacts-import-close').addEventListener('click', close);
    el('contacts-import-backdrop').addEventListener('click', close);
    el('contacts-import-run').addEventListener('click', run);
    el('contacts-import-map-confirm').addEventListener('click', confirmMapping);
    el('contacts-import-map-cancel').addEventListener('click', resetView);
    el('contacts-import-undo').addEventListener('click', undo);
    for (const [value] of CHOICES) {
      el(`contacts-import-dup-all-${value}`).addEventListener('change', () => { choiceAll = value; choiceEach = new Map(); if (state) renderPreview(); });
    }
    el('contacts-import-dialog').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
    const encSelect = el('contacts-import-encoding');
    for (const label of ['', ...NotesContactsVcard.ENCODINGS]) {
      try { if (label) new TextDecoder(label); } catch (err) { continue; }
      const o = document.createElement('option');
      o.value = label;
      o.textContent = label || 'Detect automatically';
      encSelect.append(o);
    }
    encSelect.addEventListener('change', () => { if (currentFiles.length) load(currentFiles); });
    const dlg = el('contacts-import-dialog');
    dlg.addEventListener('dragover', (event) => { event.preventDefault(); dlg.classList.add('dragging'); });
    dlg.addEventListener('dragleave', () => dlg.classList.remove('dragging'));
    dlg.addEventListener('drop', (event) => {
      event.preventDefault();
      dlg.classList.remove('dragging');
      load(Array.from((event.dataTransfer && event.dataTransfer.files) || []));
    });
  }

  registerFormat({
    id: 'vcard',
    label: 'vCard',
    sniff: (text) => NotesContactsVcard.looksLikeVcard(text),
    parse: (text, ctx) => NotesContactsVcard.parse(text, { fileCharset: ctx && ctx.encoding }),
    describe: (stats, enc) => {
      const flavour = stats.flavour ? `${stats.flavour[0].toUpperCase()}${stats.flavour.slice(1)}` : '';
      return `vCard ${(stats.versions || []).join(' and ') || '3.0'}${flavour ? `, ${flavour}` : ''}, ${enc}`;
    },
  });

  // --- content sniffing: the first bytes decide, never the file name -----------------------------------
  function firstLine(text) {
    for (const line of text.slice(0, 4096).replace(/^﻿/, '').split(/\r\n?|\n/)) {
      if (line.trim() && line[0] !== '#') return line;
    }
    return '';
  }

  registerFormat({
    id: 'ldif',
    label: 'LDIF',
    sniff: (text) => /^(dn:|version: *1 *$)/i.test(firstLine(text)),
    parse: (text) => lib.ldif.parse(text),
    describe: (stats, enc) => `LDIF, ${enc}`,
  });

  registerFormat({
    id: 'jcard',
    label: 'jCard',
    sniff: (text) => /^\s*\[\s*(\[\s*)?"vcard"/.test(text.slice(0, 4096).replace(/^﻿/, '')),
    parse: (text) => lib.jcard.parse(text),
    describe: (stats, enc) => `jCard, ${enc}`,
  });

  // Last: anything with a header of two or more columns and a record under it. JSON and markup never is.
  registerFormat({
    id: 'csv',
    label: 'CSV',
    sniff: (text) => {
      if (/^\s*[[{<]/.test(text.slice(0, 64))) return false;
      const { rows } = lib.csv.readCsv(text.slice(0, 64 * 1024));
      return rows.length >= 2 && rows[0].length >= 2;
    },
    parse: (text) => {
      const { rows, warnings } = lib.csv.readCsv(lib.csv.cleanText(text));
      const dialect = rows.length > 1 ? lib.csv.detectDialect(rows[0]) : null;
      const result = { contacts: [], skipped: [], warnings: [...warnings], stats: { dialect } };
      if (rows.length < 2) return result;
      if (!dialect) return { ...result, needsMapping: { rows } };
      const mapped = lib.csv.mapRows(rows, dialect);
      result.contacts = mapped.contacts;
      result.warnings.push(...mapped.warnings);
      return result;
    },
    describe: (stats, enc) => `CSV, ${stats.dialect || 'columns mapped by you'}, ${enc}`,
  });

  return { LIMITS, registerFormat, readFiles, finishMapping, previewSummary, attachPhotos, init, open, close, reset, dropUndo };
})();

if (typeof window !== 'undefined') window.NotesContactsImport = NotesContactsImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsImport;
