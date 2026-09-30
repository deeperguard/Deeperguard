const NotesHistory = (() => {
  function revisionRows(note) {
    const list = note?.content?.revisions;
    if (!Array.isArray(list)) return [];
    return list.filter((rev) => rev && typeof rev === 'object');
  }

  function revisionTimestamp(rev) {
    const at = Date.parse(rev?.at);
    return Number.isFinite(at) ? at : 0;
  }

  // Version restore writes the store first. Flushing the still-open editor
  // would save the pre-restore text back over that version.
  function shouldFlushOnOpen(skipFlush) {
    return !skipFlush;
  }

  function revisionLabel(rev, note) {
    const snap = {
      content: {
        title: rev?.title || '',
        content: rev?.content || '',
        title_manual: false,
        locked: false,
      },
    };
    const derived = typeof NotesSearch !== 'undefined' && NotesSearch.effectiveNoteTitle
      ? NotesSearch.effectiveNoteTitle(snap)
      : '';
    if (derived) return derived;
    const stored = String(rev?.title || '').trim();
    if (stored && stored !== 'Untitled' && stored !== 'Title') return stored;
    const currentTitle = typeof NotesSearch !== 'undefined' && NotesSearch.effectiveNoteTitle && note
      ? NotesSearch.effectiveNoteTitle(note)
      : String(note?.content?.title || '').trim();
    if (stored && currentTitle && stored === currentTitle) return stored;
    return 'Untitled version';
  }

  const api = { revisionRows, revisionTimestamp, shouldFlushOnOpen, revisionLabel };
  if (typeof window !== 'undefined') window.NotesHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
