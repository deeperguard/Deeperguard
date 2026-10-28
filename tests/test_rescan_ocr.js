// Rescan with OCR is a menu action on an open note. It is hidden until the
// note has a PDF or photo, and a run replaces stored scan text in place.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'templates', 'app.html'), 'utf8');

const menu = html.slice(html.indexOf('editor-toolbar-menu-panel'), html.indexOf('id="btn-editor-settings"'));
const primary = html.slice(
  html.indexOf('editor-actions-group editor-actions-primary'),
  html.indexOf('editor-toolbar-menu-panel'),
);
assert.ok(menu.includes('id="btn-rescan-ocr"'), 'rescan sits in the open-note menu');
assert.ok(menu.includes('>Rescan with OCR<'), 'the menu label is Rescan with OCR');
assert.ok(!primary.includes('id="btn-rescan-ocr"'), 'the crowded toolbar does not get another icon');
const buttonTag = menu.slice(menu.indexOf('id="btn-rescan-ocr"') - 80, menu.indexOf('id="btn-rescan-ocr"') + 220);
assert.ok(buttonTag.includes('hidden'), 'the action starts hidden');
assert.ok(!buttonTag.includes('toolbar-desktop'), 'the labeled item stays available in the phone menu');
assert.ok(appJs.includes("getElementById('btn-rescan-ocr')"), 'the menu button is wired');

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not extract ${startMarker}`);
  return source.slice(start, end);
}

const rescanSource = slice(appJs, 'async function rescanOpenNoteOcr()', 'async function retryAttachmentOcr(');
assert.ok(rescanSource.includes('NotesOcr.extractFromFile'), 'rescan uses the on-device OCR pipeline');
assert.ok(!rescanSource.includes('addAttachment'), 'rescan must not create an attachment');
assert.ok(!rescanSource.includes('enqueueOcrJob'), 'rescan is one pass, not the retry queue');
assert.ok(!rescanSource.includes('fetch('), 'rescan must not upload the file');
assert.strictEqual(rescanSource.split('await NotesOcr.extractFromFile').length - 1, 1, 'each file is scanned once');

const items = new Map();
const toasts = [];
const extracts = [];
const refreshes = [];
let bytesGate = null;

function put(uuid, content, extra) {
  items.set(uuid, { uuid, content, ...extra });
}

const NotesStore = {
  listAttachments(noteId) {
    return [...items.values()].filter((item) => item.content.type === 'attachment' && item.content.note_id === noteId);
  },
  get(id) {
    return items.get(id) || null;
  },
  async getAttachmentBytes(id) {
    if (bytesGate) await bytesGate;
    const item = items.get(id);
    return item?._bytes || null;
  },
  setAttachmentOcr(uuid, text, method, boxes) {
    const item = items.get(uuid);
    assert.ok(item, 'ocr update targets an existing attachment');
    item.content = {
      ...item.content,
      ocr_text: String(text || ''),
      ocr_method: method || '',
      ocr_boxes: Array.isArray(boxes) ? boxes : [],
    };
    this.refreshNoteSearchText(item.content.note_id);
    return true;
  },
  async setAttachmentPreview() {
    throw new Error('preview should stay untouched in this test');
  },
  addAttachment() {
    throw new Error('rescan created an attachment');
  },
  refreshNoteSearchText(noteId) {
    const note = items.get(noteId);
    const ocr = this.listAttachments(noteId).map((item) => item.content.ocr_text).filter(Boolean).join('\n\n');
    note.content = { ...note.content, ocr_text: ocr };
    return true;
  },
};

const label = { textContent: 'Rescan with OCR' };
const button = {
  hidden: true,
  disabled: false,
  querySelector(sel) {
    return sel.includes('editor-menu-label') ? label : null;
  },
};

const NotesOcr = {
  async extractFromFile(file, onProgress) {
    extracts.push(file.name);
    if (file.name === 'broken.pdf') throw new Error('engine failed');
    if (typeof onProgress === 'function') onProgress({ status: 'processing', progress: 0.4 });
    return {
      text: `rescanned ${file.name}`,
      method: 'tesseract',
      boxes: [{ text: 'rescanned', page: 0 }],
      ocr_quality: 'ok',
    };
  },
  storeFile() {
    throw new Error('rescan uploaded a file');
  },
};

const sandbox = {
  NotesStore,
  NotesOcr,
  window: { NotesOcr },
  document: { getElementById: (id) => (id === 'btn-rescan-ocr' ? button : null) },
  File: class File {
    constructor(parts, name, opts) {
      this.parts = parts;
      this.name = name;
      this.type = opts.type;
      this.size = parts[0].length;
    }
  },
  toast(message, isError) {
    toasts.push({ message, isError: !!isError });
  },
  normalizeOcrStorage(text, boxes, mime, filename, quality, method) {
    return { text: String(text || ''), method: method || 'client', boxes };
  },
  scheduleOcrUiRefresh(ids) {
    refreshes.push(ids);
  },
  setEditorMenuLabel(btn, text) {
    const node = btn.querySelector('.editor-menu-label');
    if (node) node.textContent = text;
  },
  console,
  Date,
};
sandbox.globalThis = sandbox;

const code = [
  'let currentId = null;',
  'let rescanOcrBusy = false;',
  'const rescanOcrIds = new Set();',
  'const unlockedNotes = new Set();',
  'let ocrProgressToastAt = 0;',
  `function ocrProgressLabel(msg, prefix) {
    if (!msg || typeof msg.progress !== 'number') return prefix || 'Processing';
    const pct = Math.round(msg.progress * 100);
    const stage = String(msg.stage || '');
    if (stage === 'prepare') return 'Preparing photo ' + pct + '%';
    if (stage === 'recognize') return 'Reading text ' + pct + '%';
    if (prefix) return prefix + ' ' + pct + '%';
    return 'Processing ' + pct + '%';
  }`,
  slice(appJs, 'function attachmentIsPdfOrPhoto(item)', 'async function retryAttachmentOcr('),
  'this.api = { attachmentIsPdfOrPhoto, notePdfOrPhotoAttachments, syncRescanOcrButton, rescanOpenNoteOcr, setCurrent(id) { currentId = id; } };',
].join('\n');
vm.runInNewContext(code, sandbox, { filename: 'rescan-ocr.js' });
const api = sandbox.api;

const noteId = 'note-1';
put(noteId, { type: 'note', title: 'Plain', content: 'hello', ocr_text: '', locked: false });

api.setCurrent(noteId);
api.syncRescanOcrButton();
assert.strictEqual(button.hidden, true, 'no file: rescan stays hidden');

put('att-text', {
  type: 'attachment',
  note_id: noteId,
  filename: 'notes.txt',
  mime: 'text/plain',
  ocr_text: 'typed',
  file_enc: 'cipher-text',
  size: 5,
});
api.syncRescanOcrButton();
assert.strictEqual(button.hidden, true, 'a text file is not a PDF or photo');

put('att-pdf', {
  type: 'attachment',
  note_id: noteId,
  filename: 'invoice.pdf',
  mime: 'application/pdf',
  ocr_text: 'old pdf text',
  ocr_method: 'pdftext',
  file_enc: 'cipher-pdf',
  size: 1200,
}, { _bytes: new Uint8Array([1, 2, 3]) });
api.syncRescanOcrButton();
assert.strictEqual(button.hidden, false, 'a PDF shows Rescan with OCR');
assert.strictEqual(label.textContent, 'Rescan with OCR');

put('att-photo', {
  type: 'attachment',
  note_id: noteId,
  filename: 'scan.jpg',
  mime: 'image/jpeg',
  ocr_text: 'old photo text',
  ocr_method: 'tesseract',
  file_enc: 'cipher-photo',
  size: 800,
}, { _bytes: new Uint8Array([4, 5, 6, 7]) });
api.syncRescanOcrButton();
assert.strictEqual(button.hidden, false, 'a photo keeps the action visible');

const lockedId = 'note-locked';
put(lockedId, { type: 'note', title: 'Secret', content: '', ocr_text: '', locked: true });
put('att-locked', {
  type: 'attachment',
  note_id: lockedId,
  filename: 'secret.pdf',
  mime: 'application/pdf',
  ocr_text: 'hidden',
  file_enc: 'cipher-locked',
});
api.setCurrent(lockedId);
api.syncRescanOcrButton();
assert.strictEqual(button.hidden, true, 'a locked note hides rescan');

api.setCurrent(null);
api.syncRescanOcrButton();
assert.strictEqual(button.hidden, true, 'no open note hides rescan');

async function main() {
api.setCurrent(noteId);
const beforeIds = NotesStore.listAttachments(noteId).map((item) => item.uuid);
const beforeEnc = {
  pdf: NotesStore.get('att-pdf').content.file_enc,
  photo: NotesStore.get('att-photo').content.file_enc,
  text: NotesStore.get('att-text').content.file_enc,
};
await api.rescanOpenNoteOcr();
assert.deepStrictEqual(extracts, ['invoice.pdf', 'scan.jpg'], 'each PDF and photo is scanned once; text is skipped');
assert.deepStrictEqual(NotesStore.listAttachments(noteId).map((item) => item.uuid), beforeIds, 'rescan does not add an attachment');
assert.strictEqual(NotesStore.get('att-pdf').content.file_enc, beforeEnc.pdf);
assert.strictEqual(NotesStore.get('att-photo').content.file_enc, beforeEnc.photo);
assert.strictEqual(NotesStore.get('att-text').content.file_enc, beforeEnc.text);
assert.strictEqual(NotesStore.get('att-pdf').content.size, 1200);
assert.strictEqual(NotesStore.get('att-photo').content.size, 800);
assert.strictEqual(NotesStore.get('att-pdf').content.ocr_text, 'rescanned invoice.pdf');
assert.strictEqual(NotesStore.get('att-photo').content.ocr_text, 'rescanned scan.jpg');
assert.strictEqual(NotesStore.get('att-text').content.ocr_text, 'typed');
assert.strictEqual(
  NotesStore.get(noteId).content.ocr_text,
  'typed\n\nrescanned invoice.pdf\n\nrescanned scan.jpg',
);
assert.ok(toasts.some((item) => item.message.includes('Rescanning invoice.pdf')), 'progress names the file');
assert.ok(toasts.some((item) => item.message.includes('%')), 'progress reports percent');
assert.ok(refreshes.length > 0, 'the attachment row and scan line refresh');
assert.strictEqual(button.hidden, false);
assert.strictEqual(button.disabled, false);
assert.strictEqual(label.textContent, 'Rescan with OCR');

// A failure is reported once and does not start another pass or a new file.
extracts.length = 0;
toasts.length = 0;
put('att-bad', {
  type: 'attachment',
  note_id: noteId,
  filename: 'broken.pdf',
  mime: 'application/pdf',
  ocr_text: 'keep me',
  ocr_method: 'pdftext',
  file_enc: 'cipher-bad',
  size: 9,
}, { _bytes: new Uint8Array([9]) });
const countBeforeFail = NotesStore.listAttachments(noteId).length;
await api.rescanOpenNoteOcr();
assert.strictEqual(extracts.filter((name) => name === 'broken.pdf').length, 1);
assert.strictEqual(NotesStore.get('att-bad').content.ocr_text, 'keep me');
assert.strictEqual(NotesStore.get('att-bad').content.file_enc, 'cipher-bad');
assert.strictEqual(NotesStore.listAttachments(noteId).length, countBeforeFail);
assert.ok(toasts.some((item) => item.isError && item.message.includes('Could not rescan broken.pdf')));

// A second click during the pass does not scan again.
extracts.length = 0;
toasts.length = 0;
let release;
bytesGate = new Promise((resolve) => { release = resolve; });
const first = api.rescanOpenNoteOcr();
const second = api.rescanOpenNoteOcr();
await second;
assert.ok(toasts.some((item) => item.message === 'Rescan already running'));
release();
bytesGate = null;
await first;
const pdfScans = extracts.filter((name) => name === 'invoice.pdf').length;
assert.strictEqual(pdfScans, 1, 'the in-flight rescan is not started twice');

console.log('ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
