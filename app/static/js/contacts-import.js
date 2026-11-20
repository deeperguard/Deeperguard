// Contacts import flow (docs/CONTACTS_SPEC.md section 7): choose files, parse in the browser, preview with
// counts, import, result summary, undo. Other formats plug into the same preview and summary through
// registerFormat(). Files are read with File.arrayBuffer() and parsed here; nothing is uploaded and nothing
// decrypted is stored outside the vault.
const NotesContactsImport = (() => {
  const LIMITS = { fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, contacts: 10000, listed: 50 };
  const NOT_CONTACTS = 'This is not a contact file. Export your contacts as vCard (.vcf) and choose that file.';
  const formats = [];

  // A format is { id, label, sniff(text) -> bool, parse(text, { encoding }) -> { contacts, skipped, warnings, stats },
  // describe(stats) -> string }. Contacts are plain objects in the shape NotesContacts.buildContact takes; an
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
    const out = { files: [], contacts: [], problems: [], overLimit: 0 };
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
      if (!format) { entry.reason = NOT_CONTACTS; continue; }
      let parsed;
      try { parsed = format.parse(text, { encoding: used }); } catch (err) { entry.reason = 'this file could not be read as ' + format.label + '.'; continue; }
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
    for (const f of out.files) {
      if (f.reason) out.problems.push(`${f.name}: ${f.reason}`);
      for (const s of f.skipped) out.problems.push(`${f.name}: ${s.reason}`);
      for (const w of f.warnings) out.problems.push(`${f.name}: ${w}`);
    }
    if (out.overLimit) out.problems.push(`Too many contacts: ${LIMITS.contacts.toLocaleString('en')} is the most per import, ${out.overLimit} were left out. Import the rest in a second run.`);
    return out;
  }

  const digits = (v) => String(v || '').replace(/\D/g, '');
  function phoneKeys(c) {
    const keys = new Set();
    for (const p of c.phones || []) {
      let d = digits(p.value).replace(/^00/, '');
      if (d.length < 6) continue;
      keys.add(d);
      keys.add(`~${d.slice(-9)}`);
    }
    return keys;
  }

  // Index of incoming contacts that match one already in the vault by email, phone or UID (7.4, 1 to 2 and 4).
  function findExisting(incoming, existing) {
    const emails = new Set();
    const phones = new Set();
    const uids = new Set();
    for (const e of existing) {
      for (const m of e.emails || []) emails.add(String(m.value).toLowerCase());
      for (const k of phoneKeys(e)) phones.add(k);
      if (e.uid) uids.add(e.uid);
    }
    const hits = new Set();
    incoming.forEach((c, i) => {
      if ((c.uid && uids.has(c.uid))
        || (c.emails || []).some((m) => emails.has(String(m.value).toLowerCase()))
        || [...phoneKeys(c)].some((k) => phones.has(k))) hits.add(i);
    });
    return hits;
  }

  const plural = (n, one, many) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

  function previewSummary(state, existingCount) {
    const n = state.contacts.length;
    const skipped = state.files.reduce((a, f) => a + f.skipped.length, 0);
    const photos = state.contacts.filter((c) => c.photoSource).length;
    const refused = state.files.filter((f) => !f.ok).length;
    const parts = [`Found ${plural(n, 'contact', 'contacts')} in ${plural(state.files.length, 'file', 'files')}`];
    if (existingCount) parts.push(`${existingCount.toLocaleString('en')} look like contacts you already have`);
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
  let existingHits = new Set();
  let selected = new Set();
  let busy = false;
  let undoRecord = null;
  let hooks = null;
  let currentFiles = [];

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
    existingHits = new Set();
    selected = new Set();
    showError('');
    show('contacts-import-preview', false);
    show('contacts-import-result', false);
    show('contacts-import-run', false);
    show('contacts-import-undo', false);
    el('contacts-import-file').value = '';
    el('contacts-import-run').disabled = false;
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

  function renderPreview() {
    const keepExisting = el('contacts-import-skip-existing').checked;
    const importable = state.contacts.filter((c, i) => selected.has(i) && !(keepExisting && existingHits.has(i)));
    setText('contacts-import-summary', previewSummary(state, existingHits.size));
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
      name.textContent = ` ${displayOf(c)}${existingHits.has(i) ? ' (already in your vault)' : ''}`;
      label.append(box, name);
      li.append(label);
      list.append(li);
    });
    setText('contacts-import-list-note', state.contacts.length > LIMITS.listed ? `Showing the first ${LIMITS.listed} of ${state.contacts.length.toLocaleString('en')}. The others are imported too.` : '');
    show('contacts-import-preview', true);
    show('contacts-import-encoding-row', state.files.some((f) => f.ok));
    const run = el('contacts-import-run');
    run.hidden = false;
    run.disabled = importable.length === 0;
    run.textContent = importable.length ? `Import ${plural(importable.length, 'contact', 'contacts')}` : 'Nothing to import';
    return importable;
  }

  async function load(files) {
    if (busy || !files.length) return;
    currentFiles = files;
    showError('');
    show('contacts-import-result', false);
    busy = true;
    setText('contacts-import-status', 'Reading files…');
    try {
      state = await readFiles(files, { encoding: el('contacts-import-encoding').value });
    } finally {
      busy = false;
      setText('contacts-import-status', '');
    }
    const existing = hooks.listContacts();
    existingHits = findExisting(state.contacts, existing);
    selected = new Set(state.contacts.map((c, i) => i));
    renderPreview();
    if (!state.contacts.length) showError(state.problems[0] || 'No contacts were found.');
  }

  async function run() {
    if (busy || !state) return;
    if (!hooks.isUnlocked()) { showError('Vault locked. Nothing was imported.'); return; }
    const keepExisting = el('contacts-import-skip-existing').checked;
    const chosen = state.contacts.filter((c, i) => selected.has(i) && !(keepExisting && existingHits.has(i)));
    if (!chosen.length) return;
    busy = true;
    el('contacts-import-dialog').setAttribute('aria-busy', 'true');
    el('contacts-import-run').disabled = true;
    const summaryState = state;
    const skippedExisting = state.contacts.filter((c, i) => selected.has(i) && keepExisting && existingHits.has(i)).length;
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
    undoRecord = result.created.length ? result : null;
    const lines = [
      `Imported ${plural(result.created.length, 'new contact', 'new contacts')}`
      + (skippedExisting ? `, ${skippedExisting.toLocaleString('en')} left out because you already have them` : '')
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
    const { removed, kept } = hooks.restoreContacts(record);
    show('contacts-import-undo', false);
    const msg = `Import undone: ${plural(removed, 'contact', 'contacts')} removed${kept ? `, ${plural(kept, 'contact was', 'contacts were')} edited since and kept` : ''}.`;
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
    el('contacts-import-undo').addEventListener('click', undo);
    el('contacts-import-skip-existing').addEventListener('change', () => { if (state) renderPreview(); });
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

  return { LIMITS, registerFormat, readFiles, findExisting, previewSummary, attachPhotos, init, open, close, reset, dropUndo };
})();

if (typeof window !== 'undefined') window.NotesContactsImport = NotesContactsImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsImport;
