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

  const api = { revisionRows, revisionTimestamp, shouldFlushOnOpen };
  if (typeof window !== 'undefined') window.NotesHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
