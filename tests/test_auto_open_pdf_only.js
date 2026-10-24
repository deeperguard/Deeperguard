/**
 * Auto-open PDF-only notes: prefs, settings copy, initialEditorMode hook,
 * session Set suppress after dismiss-to-edit, mobile Close → btn-preview.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

// Pref default ON (opt-out) and synced with other global settings.
assert.ok(appJs.includes('autoOpenPdfOnly: true'), 'default autoOpenPdfOnly must be true');
assert.ok(appJs.includes("'autoPreview', 'autoOpenPdfOnly'"), 'autoOpenPdfOnly in GLOBAL_PREF_KEYS');
assert.ok(appJs.includes('autoPreview: false'), 'autoPreview default stays off');

// Settings UI: new toggle + on-device hint; existing autoPreview label unchanged.
assert.ok(html.includes('id="pref-auto-open-pdf-only"'));
assert.ok(html.includes('Auto-open PDF-only notes'));
assert.ok(html.includes('pref-auto-open-pdf-only') && html.includes('type="checkbox" checked'));
assert.ok(html.includes('Open notes in preview (documents &amp; markdown)'));
assert.ok(html.includes('id="pref-auto-preview"'));
assert.ok(
  html.includes("When a note has no text and one PDF, open the PDF preview instead of a blank editor. Preview runs in your browser — the file isn't sent to our servers."),
  'settings hint must match Marketing copy',
);

// Decision helpers + initialEditorMode hook (before generic autoPreview docs path).
assert.ok(appJs.includes('function shouldAutoOpenPdfOnlyNote'));
assert.ok(appJs.includes('function noteBodyIsBlank'));
assert.ok(appJs.includes('function noteSinglePdfAttachment'));
assert.ok(appJs.includes('function pdfAttachmentReadyForAutoOpen'));
assert.ok(appJs.includes('pdfOnlyAutoOpenSuppressedIds = new Set()'));
assert.ok(appJs.includes('pdfOnlyAutoOpenSuppressedIds.has(noteId)'));
assert.ok(appJs.includes('pdfOnlyAutoOpenSuppressedIds.add(currentId)'));
assert.ok(appJs.includes("if (shouldAutoOpenPdfOnlyNote(noteId)) return 'preview'"));
// Must NOT clear suppression when leaving a note (desktop reopen bug).
assert.ok(!appJs.includes('pdfOnlyAutoOpenSuppressedId === previousId'));
assert.ok(!/\bpdfOnlyAutoOpenSuppressedId\b/.test(appJs), 'old single-id suppress var must be gone');

const initialMode = appJs.slice(
  appJs.indexOf('function initialEditorMode(noteId)'),
  appJs.indexOf('function initialEditorMode(noteId)') + 900,
);
assert.ok(
  initialMode.indexOf('shouldAutoOpenPdfOnlyNote')
    < initialMode.indexOf('prefs.autoPreview'),
  'PDF-only auto-open must run before document autoPreview branch',
);
assert.ok(initialMode.includes('noteSpreadsheetSource'), 'spreadsheet preview path kept');

// Ready / heavy / opt-out gates.
assert.ok(appJs.includes('prefs.autoOpenPdfOnly === false'));
assert.ok(appJs.includes('heavyPreviewDeferred(att.uuid)'));
assert.ok(appJs.includes('file_enc_stored') && appJs.includes('lightVaultEnabled'));

// Settings bind + paint.
assert.ok(appJs.includes("getElementById('pref-auto-open-pdf-only')"));
assert.ok(appJs.includes('prefs.autoOpenPdfOnly = !!e.target.checked'));
assert.ok(appJs.includes('prefs.autoOpenPdfOnly !== false'));

// Mobile Close on doc toolbar → existing btn-preview (session dismiss path).
assert.ok(html.includes('id="btn-mobile-doc-close"'));
assert.ok(html.includes('aria-label="Close"'));
const closeBtnMatch = html.match(/<button[^>]*id="btn-mobile-doc-close"[^>]*>/);
assert.ok(closeBtnMatch, 'Close button markup present');
assert.ok(!/\btoolbar-secondary\b/.test(closeBtnMatch[0]), 'Close must not use toolbar-secondary (phone hides that class)');
assert.ok(/\beditor-mobile-doc-action\b/.test(closeBtnMatch[0]), 'Close keeps editor-mobile-doc-action');
assert.ok(appJs.includes("getElementById('btn-mobile-doc-close')"));
assert.ok(appJs.includes("getElementById('btn-preview')?.click()"));
assert.ok(appJs.includes('closeBtn.hidden = !show') || appJs.includes('closeBtn.hidden = !show;'));
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
assert.ok(
  css.includes('body.editor-mobile-doc-preview .editor-actions-mobile-bar [data-editor-proxy="btn-pin"]'),
  'hide Pin in mobile doc-preview so Close fits one row',
);

// Behavioral unit: same decision rules as shouldAutoOpenPdfOnlyNote + Set suppress.
function noteBodyIsBlank(note) {
  return !String(note?.content?.content || '').trim();
}
function noteSinglePdfAttachment(atts) {
  if (atts.length !== 1) return null;
  const att = atts[0];
  return att.kind === 'pdf' ? att : null;
}
function pdfAttachmentReadyForAutoOpen(att, lightVault) {
  if (!att?.content) return false;
  if (att.content.file_enc || att.content.data_b64) return true;
  if (att.content.file_enc_stored && lightVault) return false;
  return !lightVault;
}
function shouldAutoOpen({
  pref = true,
  suppressedIds = new Set(),
  noteId = 'n1',
  body = '',
  atts = [{ kind: 'pdf', uuid: 'a1', content: { file_enc: {} } }],
  heavy = false,
  lightVault = false,
} = {}) {
  if (pref === false) return false;
  if (!noteId || suppressedIds.has(noteId)) return false;
  if (!noteBodyIsBlank({ content: { content: body } })) return false;
  const att = noteSinglePdfAttachment(atts);
  if (!att) return false;
  if (heavy) return false;
  if (!pdfAttachmentReadyForAutoOpen(att, lightVault)) return false;
  return true;
}

assert.strictEqual(shouldAutoOpen(), true, 'empty body + one ready PDF → open');
assert.strictEqual(shouldAutoOpen({ body: '   \n\t  ' }), true, 'whitespace-only body → open');
assert.strictEqual(shouldAutoOpen({ body: 'hello' }), false, 'text body → no');
assert.strictEqual(shouldAutoOpen({ pref: false }), false, 'pref off → no');
assert.strictEqual(shouldAutoOpen({ atts: [] }), false, 'zero attachments → no');
assert.strictEqual(
  shouldAutoOpen({ atts: [{ kind: 'pdf', uuid: 'a', content: { file_enc: {} } }, { kind: 'image', uuid: 'b', content: {} }] }),
  false,
  'two attachments → no',
);
assert.strictEqual(
  shouldAutoOpen({ atts: [{ kind: 'image', uuid: 'a', content: { file_enc: {} } }] }),
  false,
  'single non-PDF → no',
);
assert.strictEqual(shouldAutoOpen({ heavy: true }), false, 'heavyPreviewDeferred → no');
assert.strictEqual(
  shouldAutoOpen({
    atts: [{ kind: 'pdf', uuid: 'a', content: { file_enc_stored: true } }],
    lightVault: true,
  }),
  false,
  'light-vault still downloading → no',
);
assert.strictEqual(
  shouldAutoOpen({
    atts: [{ kind: 'pdf', uuid: 'a', content: { data_b64: 'x' } }],
    lightVault: true,
  }),
  true,
  'in-memory bytes → open even with light vault',
);

// Session Set: dismiss sticks across leave/reopen; other notes unaffected.
const sessionSuppressed = new Set();
assert.strictEqual(shouldAutoOpen({ noteId: 'pdf-a', suppressedIds: sessionSuppressed }), true);
sessionSuppressed.add('pdf-a'); // dismiss → edit
assert.strictEqual(
  shouldAutoOpen({ noteId: 'pdf-a', suppressedIds: sessionSuppressed }),
  false,
  'dismissed note stays suppressed after leave/reopen in same session',
);
assert.strictEqual(
  shouldAutoOpen({ noteId: 'pdf-b', suppressedIds: sessionSuppressed }),
  true,
  'other PDF-only notes still auto-open',
);

// autoPreview default / meaning unchanged for multi-doc notes (separate path).
assert.ok(appJs.includes('noteHasVisualDocs(noteId) || noteHasDocs(noteId)'));
assert.ok(appJs.includes("return prefs.autoPreview ? 'preview' : 'edit'"));

console.log('test_auto_open_pdf_only ok');
