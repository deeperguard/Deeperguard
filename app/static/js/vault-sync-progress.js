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
    const countMatch = s.match(/\((\d+)\/(\d+)\)/) || s.match(/(?:Downloading[^0-9]*)?(\d+)\s*\/\s*(\d+)/i);
    return {
      pct: pctMatch ? Number(pctMatch[1]) : null,
      done: countMatch ? Number(countMatch[1]) : null,
      total: countMatch ? Number(countMatch[2]) : null,
      notes: parseNotesReadyCount(s),
      isDownload: /Downloading/i.test(s),
    };
  }

  function formatVaultSyncDownloadProgress({ processed, total, notes, pct = null } = {}) {
    const done = Number(processed);
    const expected = Number(total);
    const noteCount = Number(notes);
    const hasItems = Number.isFinite(expected) && expected > 0 && Number.isFinite(done) && done >= 0;
    let text = DOWNLOAD_BASE;
    if (hasItems) {
      text += ` ${done} / ${expected} items`;
    } else if (pct != null && Number.isFinite(Number(pct))) {
      text += ` ${Number(pct)}%`;
    }
    if (Number.isFinite(noteCount) && noteCount > 0) {
      text += ` · ${noteCount} note${noteCount === 1 ? '' : 's'} ready`;
    }
    return text;
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
