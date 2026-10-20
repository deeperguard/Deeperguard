const NotesVaultSyncProgress = (() => {
  const DOWNLOAD_BASE = 'Downloading…';

  function parseNotesReadyCount(message) {
    const s = String(message || '');
    const ready = s.match(/·\s*(\d+)\s+notes?\s+ready\b/i);
    if (ready) return Number(ready[1]);
    const plain = s.match(/·\s*(\d+)\s+notes?\b/i);
    return plain ? Number(plain[1]) : null;
  }

  function parseVaultSyncProgressMessage(message) {
    const s = String(message || '');
    const pctMatch = s.match(/(\d+)\s*%/);
    const countMatch = s.match(/\((\d+)\/(\d+)\)/)
      || s.match(/(?:Downloading[^0-9]*)?(\d+)\s*\/\s*(\d+)/i)
      || s.match(/(\d+)\s+of\s+(\d+)/i);
    const done = countMatch ? Number(countMatch[1]) : null;
    const total = countMatch ? Number(countMatch[2]) : null;
    let pct = pctMatch ? Number(pctMatch[1]) : null;
    if (pct == null && done != null && total > 0) {
      pct = Math.max(1, Math.min(99, Math.round((done / total) * 100)));
    }
    return {
      pct,
      done,
      total,
      notes: parseNotesReadyCount(s),
      isDownload: /Downloading/i.test(s),
    };
  }

  function formatVaultSyncDownloadProgress({ processed, total, notes, pct = null } = {}) {
    const done = Number(processed);
    const expected = Number(total);
    const noteCount = Number(notes);
    const hasItems = Number.isFinite(expected) && expected > 0 && Number.isFinite(done) && done >= 0;
    if (hasItems) {
      // Prefer live notes-ready when present; otherwise items processed.
      const shown = Number.isFinite(noteCount) && noteCount > 0
        ? Math.min(noteCount, expected)
        : done;
      return `Downloading ${shown} of ${expected} notes`;
    }
    if (pct != null && Number.isFinite(Number(pct))) {
      return `Downloading… ${Number(pct)}%`;
    }
    return DOWNLOAD_BASE;
  }

  function syncBannerProgressText(message, fallback) {
    const parsed = parseVaultSyncProgressMessage(message);
    if (parsed.done != null && parsed.total) {
      return formatVaultSyncDownloadProgress({
        processed: parsed.done,
        total: parsed.total,
        notes: parsed.notes,
      });
    }
    if (parsed.pct != null) {
      return formatVaultSyncDownloadProgress({ pct: parsed.pct, notes: parsed.notes });
    }
    const base = fallback || DOWNLOAD_BASE;
    if (/^Downloading notes/i.test(String(message || ''))) {
      return String(message).replace(/^Downloading notes/i, 'Downloading');
    }
    return message || base || 'Syncing…';
  }

  const api = {
    parseVaultSyncProgressMessage,
    parseNotesReadyCount,
    formatVaultSyncDownloadProgress,
    syncBannerProgressText,
  };
  if (typeof window !== 'undefined') window.NotesVaultSyncProgress = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
