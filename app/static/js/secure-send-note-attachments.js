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
    const maxBytes = Number.isFinite(opts?.maxFileBytes) ? opts.maxFileBytes : DEFAULT_MAX_BYTES;
    const zipStored = opts?.zipStored
      || (typeof NotesSnImport !== 'undefined' && NotesSnImport.zipStored);
    const fileFromBytes = opts?.fileFromBytes
      || (typeof NotesPreview !== 'undefined' && NotesPreview.fileFromBytes);
    if (typeof fileFromBytes !== 'function') {
      throw new Error('Secure Send file helper is unavailable.');
    }
    const loadBytes = opts?.loadBytes;
    if (typeof loadBytes !== 'function') {
      throw new Error('Missing attachment loader.');
    }
    const atts = (opts?.attachments || []).filter((a) => a && !a.deleted);
    const count = atts.length;
    if (count === 0) {
      return { file: null, includedNames: [], zipNote: '' };
    }

    if (count === 1) {
      const att = atts[0];
      const bytes = await loadBytes(att);
      if (byteLength(bytes) > maxBytes) {
        throw new Error('This attachment is over the 50 MB Secure Send limit.');
      }
      const name = attachmentFilename(att);
      const file = fileFromBytes(bytes, name, att.content?.mime);
      return { file, includedNames: [name], zipNote: '' };
    }

    if (typeof zipStored !== 'function') {
      throw new Error('Could not zip attachments in this browser.');
    }

    const used = new Set();
    const zipEntries = [];
    const includedNames = [];
    for (const att of atts) {
      const bytes = await loadBytes(att);
      const name = disambiguateZipName(attachmentFilename(att), used);
      used.add(name.toLowerCase());
      includedNames.push(name);
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      zipEntries.push({ name, bytes: data });
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
    };
  }

  return {
    stageSecureSendNoteAttachments,
    attachmentFilename,
    disambiguateZipName,
    zipBasename,
    DEFAULT_MAX_BYTES,
  };
})();

if (typeof window !== 'undefined') window.NotesSecureSendNoteAttachments = NotesSecureSendNoteAttachments;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesSecureSendNoteAttachments;
