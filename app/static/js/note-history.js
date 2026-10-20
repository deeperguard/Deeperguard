const NotesHistory = (() => {
  function revisionTimestamp(rev) {
    const at = Date.parse(rev?.at);
    return Number.isFinite(at) ? at : 0;
  }

  function revisionRows(note) {
    const list = note?.content?.revisions;
    if (!Array.isArray(list)) return [];
    return list
      .filter((rev) => rev && typeof rev === 'object')
      .slice()
      .sort((a, b) => revisionTimestamp(b) - revisionTimestamp(a));
  }

  // Version restore writes the store first. Flushing the still-open editor
  // would save the pre-restore text back over that version.
  function shouldFlushOnOpen(skipFlush) {
    return !skipFlush;
  }

  function revisionLabel(rev) {
    // Always label a version with the title it had then — never the live note title.
    const stored = String(rev?.title || '').trim();
    if (stored && stored !== 'Untitled' && stored !== 'Title') return stored;
    const snap = {
      content: {
        title: rev?.title || '',
        content: rev?.content || '',
        title_manual: false,
        locked: false,
      },
    };
    const derived = typeof NotesSearch !== 'undefined' && NotesSearch.effectiveNoteTitle
      ? String(NotesSearch.effectiveNoteTitle(snap) || '').trim()
      : '';
    if (derived && derived !== 'Untitled' && derived !== 'Title') return derived;
    const at = revisionTimestamp(rev);
    if (at) {
      return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
    return 'Untitled version';
  }

  const api = { revisionRows, revisionTimestamp, shouldFlushOnOpen, revisionLabel };
  if (typeof window !== 'undefined') window.NotesHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
