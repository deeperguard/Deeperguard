const NotesOcr = (() => {
  const MAX_SCAN_PAGES = NotesClientOcr.MAX_SCAN_PAGES;

  async function probeHealth() {
    if (typeof fetch !== 'function') return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch('/api/health', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      if (typeof window !== 'undefined' && typeof window.notesMarkNetworkReachable === 'function') {
        window.notesMarkNetworkReachable();
      }
      return true;
    } catch (err) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function serverReachable() {
    if (typeof window !== 'undefined' && typeof window.notesNetworkReachable === 'function' && window.notesNetworkReachable()) {
      return true;
    }
    return probeHealth();
  }

  function decodePreviewB64(value) {
    const b64 = String(value || '').trim();
    if (!b64) return null;
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    } catch (err) {
      return null;
    }
  }

  async function extractFromFile(file, onProgress, attId) {
    return NotesClientOcr.extractFromFile(file, { onProgress, attId });
  }

  async function fetchListPreview(file, attId) {
    const preview_jpeg = await NotesClientOcr.renderListPreview(file);
    return {
      preview_jpeg,
      att_id: attId || '',
    };
  }

  async function fetchIndex() {
    return {
      ok: true,
      ephemeral: true,
      client: true,
      items: [],
      count: 0,
      index_version: 0,
    };
  }

  async function deleteOcrData() {
    return { ok: true, client: true };
  }

  async function storeFile() {
    return { ok: true, client: true };
  }

  async function reindexAll() {
    return {
      ok: true,
      ephemeral: true,
      client: true,
      items: [],
      count: 0,
      errors: 0,
      index_version: 0,
    };
  }

  async function prepareImages(files, { onStatus } = {}) {
    return NotesClientOcr.prepareImages(files, { onStatus });
  }

  return {
    extractFromFile,
    fetchListPreview,
    decodePreviewB64,
    fetchIndex,
    deleteOcrData,
    storeFile,
    reindexAll,
    prepareImages,
    serverReachable,
    isHeic: NotesClientOcr.isHeic,
    needsPrepare: NotesClientOcr.needsPrepare,
    MAX_SCAN_PAGES,
  };
})();
if (typeof window !== 'undefined') window.NotesOcr = NotesOcr;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesOcr;
