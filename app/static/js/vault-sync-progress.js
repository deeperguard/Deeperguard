const NotesVaultSyncProgress = (() => {
  function parseVaultSyncProgressMessage(message) {
    const s = String(message || '');
    const pctMatch = s.match(/(\d+)\s*%/);
    const countMatch = s.match(/\((\d+)\/(\d+)\)/);
    return {
      pct: pctMatch ? Number(pctMatch[1]) : null,
      done: countMatch ? Number(countMatch[1]) : null,
      total: countMatch ? Number(countMatch[2]) : null,
      isDownload: /Downloading/i.test(s),
    };
  }

  function syncBannerProgressText(message, fallback) {
    const parsed = parseVaultSyncProgressMessage(message);
    const base = fallback || 'Downloading notes…';
    if (parsed.done != null && parsed.total) {
      const pct = parsed.pct != null ? ` · ${parsed.pct}%` : '';
      return `${base} ${parsed.done} / ${parsed.total}${pct}`;
    }
    if (parsed.pct != null) return `${base} ${parsed.pct}%`;
    return message || base || 'Syncing…';
  }

  const api = { parseVaultSyncProgressMessage, syncBannerProgressText };
  if (typeof window !== 'undefined') window.NotesVaultSyncProgress = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
