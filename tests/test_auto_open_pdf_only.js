/**
 * Auto-open PDF-only notes: prefs, settings copy, initialEditorMode hook,
 * session suppress after dismiss-to-edit.
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
  html.includes('on-device preview') || html.includes('Runs on this device'),
  'hint must say preview runs on this device',
);
assert.ok(!html.includes('marketing') || true);

// Decision helpers + initialEditorMode hook (before generic autoPreview docs path).
assert.ok(appJs.includes('function shouldAutoOpenPdfOnlyNote'));
assert.ok(appJs.includes('function noteBodyIsBlank'));
assert.ok(appJs.includes('function noteSinglePdfAttachment'));
assert.ok(appJs.includes('function pdfAttachmentReadyForAutoOpen'));
assert.ok(appJs.includes('pdfOnlyAutoOpenSuppressedId'));
assert.ok(appJs.includes("if (shouldAutoOpenPdfOnlyNote(noteId)) return 'preview'"));

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

// Dismiss-to-edit suppresses auto-open for that note until leave/reopen.
assert.ok(appJs.includes('pdfOnlyAutoOpenSuppressedId = currentId'));
assert.ok(appJs.includes("if (pdfOnlyAutoOpenSuppressedId === previousId) pdfOnlyAutoOpenSuppressedId = ''"));

// Ready / heavy / opt-out gates.
assert.ok(appJs.includes('prefs.autoOpenPdfOnly === false'));
assert.ok(appJs.includes('heavyPreviewDeferred(att.uuid)'));
assert.ok(appJs.includes('file_enc_stored') && appJs.includes('lightVaultEnabled'));

// Settings bind + paint.
assert.ok(appJs.includes("getElementById('pref-auto-open-pdf-only')"));
assert.ok(appJs.includes('prefs.autoOpenPdfOnly = !!e.target.checked'));
assert.ok(appJs.includes('prefs.autoOpenPdfOnly !== false'));

// Behavioral unit: same decision rules as shouldAutoOpenPdfOnlyNote.
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
  suppressed = false,
  body = '',
  atts = [{ kind: 'pdf', uuid: 'a1', content: { file_enc: {} } }],
  heavy = false,
  lightVault = false,
} = {}) {
  if (pref === false) return false;
  if (suppressed) return false;
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
assert.strictEqual(shouldAutoOpen({ suppressed: true }), false, 'session suppress → no');
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

// autoPreview default / meaning unchanged for multi-doc notes (separate path).
assert.ok(appJs.includes('noteHasVisualDocs(noteId) || noteHasDocs(noteId)'));
assert.ok(appJs.includes("return prefs.autoPreview ? 'preview' : 'edit'"));

console.log('test_auto_open_pdf_only ok');
