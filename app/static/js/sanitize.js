(() => {
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function safeColor(color, fallback = '#4f8cff') {
    const value = String(color || '').trim();
    if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)) return value;
    return fallback;
  }

  function clearUnchangedDirty(dirty, snapshots, currentUpdatedAt) {
    for (const [uuid, pushedAt] of snapshots) {
      if (currentUpdatedAt(uuid) === pushedAt) dirty.delete(uuid);
    }
    return dirty;
  }

  const api = { escapeHtml, escapeAttr, safeColor, clearUnchangedDirty };
  if (typeof window !== 'undefined') window.NotesSanitize = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
