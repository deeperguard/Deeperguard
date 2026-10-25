/**
 * Share-by-link / Secure Send: stage note attachments (0 / 1 / zip-many) client-side.
 * Packaging only — ciphertext format unchanged (single optional file in sealed payload).
 */
const NotesSecureSendNoteAttachments = (() => {
  'use strict';

  const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

  function attachmentFilename(att) {
    const c = att && att.content;
    const name = String(c?.filename || c?.original_filename || 'attachment').trim();
    return name || 'attachment';
  }

  function disambiguateZipName(name, usedLower) {
    const baseName = String(name || 'file').trim() || 'file';
    if (!usedLower.has(baseName.toLowerCase())) return baseName;
    const dot = baseName.lastIndexOf('.');
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot) : '';
    let n = 2;
    while (usedLower.has(`${stem} (${n})${ext}`.toLowerCase())) n += 1;
    return `${stem} (${n})${ext}`;
  }

  function zipBasename(noteTitle) {
    const raw = String(noteTitle || '').trim() || 'note';
    const safe = raw.replace(/[^\w.\- ()[\]]+/g, '_').replace(/_+/g, '_').slice(0, 100);
    return `${safe || 'note'}-attachments.zip`;
  }

  function byteLength(bytes) {
    if (!bytes) return 0;
    return bytes.byteLength != null ? bytes.byteLength : bytes.length;
  }

  function normalizeStagedEntry(entry) {
    const name = String(entry?.name || 'file').trim() || 'file';
    const raw = entry?.bytes;
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
    const mime = String(entry?.mime || 'application/octet-stream').trim() || 'application/octet-stream';
    return { name, bytes, mime };
  }

  /**
   * @param {Array<{name: string, bytes: Uint8Array, mime?: string}>} entries
   * @param {object} opts
   * @param {string} [opts.noteTitle]
   * @param {number} [opts.maxFileBytes]
   * @param {function} [opts.zipStored]
   * @param {function} [opts.fileFromBytes]
   */
  function stageSecureSendEntries(entries, opts) {
    const maxBytes = Number.isFinite(opts?.maxFileBytes) ? opts.maxFileBytes : DEFAULT_MAX_BYTES;
    const zipStored = opts?.zipStored
      || (typeof NotesSnImport !== 'undefined' && NotesSnImport.zipStored);
    const fileFromBytes = opts?.fileFromBytes
      || (typeof NotesPreview !== 'undefined' && NotesPreview.fileFromBytes);
    if (typeof fileFromBytes !== 'function') {
      throw new Error('Secure Send file helper is unavailable.');
    }
    const staged = (entries || []).map(normalizeStagedEntry).filter((e) => e.bytes);
    const count = staged.length;
    if (count === 0) {
      return { file: null, includedNames: [], zipNote: '', entries: [] };
    }

    if (count === 1) {
      const { name, bytes, mime } = staged[0];
      if (byteLength(bytes) > maxBytes) {
        throw new Error('This attachment is over the 50 MB Secure Send limit.');
      }
      const file = fileFromBytes(bytes, name, mime);
      return { file, includedNames: [name], zipNote: '', entries: staged };
    }

    if (typeof zipStored !== 'function') {
      throw new Error('Could not zip attachments in this browser.');
    }

    const used = new Set();
    const zipEntries = [];
    const includedNames = [];
    for (const row of staged) {
      const name = disambiguateZipName(row.name, used);
      used.add(name.toLowerCase());
      includedNames.push(name);
      zipEntries.push({ name, bytes: row.bytes });
    }
    const zipBytes = zipStored(zipEntries);
    if (byteLength(zipBytes) > maxBytes) {
      throw new Error(
        `These ${count} files exceed the 50 MB Secure Send limit when zipped. `
        + 'Remove or shrink files before sharing.',
      );
    }
    const file = fileFromBytes(zipBytes, zipBasename(opts?.noteTitle), 'application/zip');
    return {
      file,
      includedNames,
      zipNote: 'Sent as one zip file in the link.',
      entries: staged,
    };
  }

  /**
   * @param {object} opts
   * @param {Array} opts.attachments note attachment records (non-deleted)
   * @param {function} opts.loadBytes async (att) => Uint8Array
   * @param {string} [opts.noteTitle]
   * @param {number} [opts.maxFileBytes]
   * @param {function} [opts.zipStored]
   * @param {function} [opts.fileFromBytes]
   */
  async function stageSecureSendNoteAttachments(opts) {
    const loadBytes = opts?.loadBytes;
    if (typeof loadBytes !== 'function') {
      throw new Error('Missing attachment loader.');
    }
    const atts = (opts?.attachments || []).filter((a) => a && !a.deleted);
    const entries = [];
    for (const att of atts) {
      const bytes = await loadBytes(att);
      entries.push({
        name: attachmentFilename(att),
        bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        mime: att.content?.mime,
      });
    }
    return stageSecureSendEntries(entries, opts);
  }

  return {
    stageSecureSendNoteAttachments,
    stageSecureSendEntries,
    attachmentFilename,
    disambiguateZipName,
    zipBasename,
    DEFAULT_MAX_BYTES,
  };
})();

if (typeof window !== 'undefined') window.NotesSecureSendNoteAttachments = NotesSecureSendNoteAttachments;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesSecureSendNoteAttachments;
