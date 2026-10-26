/**
 * User-facing copy for note conflict copies — both versions stay as separate notes.
 */
(function (global) {
  'use strict';

  const SUFFIX = ' (conflict copy)';

  function baseTitle(title) {
    const t = String(title || '').trim();
    return t || 'Note';
  }

  function titledCopyName(title) {
    return `${baseTitle(title)}${SUFFIX}`;
  }

  function toastMessage(title) {
    const copyName = titledCopyName(title);
    return `Sync kept both versions as separate notes — neither was discarded. `
      + `This note stayed as-is; open “${copyName}” for the other text.`;
  }

  function noteInfoHint() {
    return 'This is the other device’s text, saved as its own note. '
      + 'Your main note kept its version — nothing was merged or deleted.';
  }

  global.NotesConflictCopy = {
    SUFFIX,
    titledCopyName,
    toastMessage,
    noteInfoHint,
  };
})(typeof window !== 'undefined' ? window : globalThis);
