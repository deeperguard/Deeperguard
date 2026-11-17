// Runs the real note list row renderers from app.js (renderNoteRow,
// renderFileRow, buildNoteListSectionsHtml, listTimeLabel, lock badge and meta
// line helpers) with synthetic data and prints the produced HTML as JSON.
// Used by tests/test_note_list_grid.py.
const fs = require('fs');
const path = require('path');

// NOTE_GRID_JS_ROOT lets the PR screenshot script render an older app.js.
const jsRoot = process.env.NOTE_GRID_JS_ROOT || path.join(__dirname, '..', 'app', 'static', 'js');
const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
global.window = global;
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
global.NotesSearch = require(path.join(jsRoot, 'search.js'));

function slice(startMarker, endMarker) {
  const start = appJs.indexOf(startMarker);
  const end = appJs.indexOf(endMarker, start + 1);
  if (start < 0 || end <= start) throw new Error(`app.js markers: ${startMarker} … ${endMarker}`);
  return appJs.slice(start, end);
}

const src = [
  slice('function parseTimestampMs(value)', '/** Last user-visible edit time'),
  slice('function attachmentThumbLabel(kind)', 'function thumbPaintRoot(stage)'),
  slice('function relativeTime(isoOrMs)', 'function refreshRelativeTimes()'),
  slice('function noteListDensity()', 'function noteSpreadsheetSource'),
  slice('function kindIconSvg(name)', 'function isTwoFaListNote(note)'),
  slice('function kindIconHtml(kind, badgeLabel)', 'function paintListThumbFallback'),
  slice('function noteListPreview(note,', 'function noteSectionKey'),
  slice('function noteReminderAt(note)', 'function noteReminderChipHtml(note)'),
  slice('function noteTagChipsHtml(note,', 'function virtualListWindow('),
  slice('function renderSectionRows(', 'function renderNotesNow()'),
  slice('function escapeHtml(text)', 'function safeColor(color)'),
].join('\n');

const factory = new Function('scope', `
  const { NotesStore, NotesSearch, NotesPreview, prefs } = scope;
  const ui = { noteList: { scrollTop: 0, clientHeight: 640 } };
  const unlockedNotes = new Set();
  let currentFilter = 'all';
  const NOTE_SORT_ORDER = ['updated', 'created', 'title'];
  const activeListNoteId = () => '';
  const isTwoFaListNote = () => false;
  const noteIndexingBadge = () => '';
  const noteWarnChipHtml = () => '';
  const noteReminderChipHtml = () => '';
  const tagMap = () => scope.tags;
  const folderMap = () => new Map();
  const safeColor = (c) => c || '#888';
  const attachmentKindName = (c) => c.filename || '';
  const noteEditedAtMs = (n) => parseTimestampMs(n.content.updated_at);
  const noteListSectionMs = (n) => noteEditedAtMs(n);
  ${src}
  return { renderNoteRow, renderFileRow, buildNoteListSectionsHtml, listTimeLabel };
`);

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const tags = new Map([['t1', { uuid: 't1', content: { title: 'work', color: '#3b82f6' } }]]);
const pdfAtt = { uuid: 'a1', content: { filename: 'invoice-12345.pdf', mime: 'application/pdf' } };
const notes = {
  plain: { uuid: 'n-plain', content: { title: 'Plain synthetic note', content: 'Body text', updated_at: iso(now - 3 * 3600 * 1000), tags: ['t1'] } },
  pdf: { uuid: 'n-pdf', content: { title: 'Synthetic invoice', content: '', updated_at: iso(now - 2 * DAY) } },
  locked: { uuid: 'n-locked', content: { title: 'Locked synthetic note', content: 'secret', locked: true, updated_at: iso(now - 40 * DAY) } },
  readonly: { uuid: 'n-ro', content: { title: 'Read-only synthetic note', content: 'fixed', prevent_edit: true, updated_at: iso(now - 400 * DAY) } },
};
const scope = {
  tags,
  prefs: { sort: 'updated', compactList: false, hidePreviews: false },
  NotesStore: {
    listAttachments: (id) => (id === 'n-pdf' ? [pdfAtt] : []),
    get: (id) => Object.values(notes).find((n) => n.uuid === id),
    listTags: () => [...tags.values()],
  },
  NotesSearch: global.NotesSearch,
  NotesPreview: { kindFromMeta: (mime) => (/pdf/.test(mime || '') ? 'pdf' : 'file') },
};

function renderAll() {
  const api = factory(scope);
  return {
    rows: {
      plain: api.renderNoteRow(notes.plain, ''),
      pdf: api.renderNoteRow(notes.pdf, ''),
      locked: api.renderNoteRow(notes.locked, ''),
      readonly: api.renderNoteRow(notes.readonly, ''),
      file: api.renderFileRow({ att: pdfAtt, note: notes.pdf }, ''),
    },
    sections: api.buildNoteListSectionsHtml([
      { label: 'Today', items: [notes.plain] },
      { label: 'Yesterday', items: [] },
      { label: 'Older', items: [notes.locked] },
      { label: 'Files', files: true, items: [] },
    ], ''),
    dates: [0.5, 30, 300, 3 * 3600, 2 * 86400, 6.5 * 86400, 8 * 86400, 40 * 86400, 400 * 86400]
      .map((sec) => ({ ageSec: sec, ms: now - sec * 1000, label: api.listTimeLabel(now - sec * 1000) })),
  };
}

const comfortable = renderAll();
scope.prefs.compactList = true;
const compact = renderAll();
process.stdout.write(JSON.stringify({ now, comfortable, compact }));
