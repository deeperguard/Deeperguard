/** iOS Safari / PWA tuning helpers — loaded before app.js */
const NotesIosTune = (() => {
  const IS_IOS = typeof navigator !== 'undefined'
    && (/iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

  function isIos() {
    return IS_IOS;
  }

  function isStandalone() {
    return typeof window !== 'undefined'
      && (window.matchMedia('(display-mode: standalone)').matches
        || navigator.standalone === true);
  }

  async function yieldMainThread() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function isTypingInField() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function memoryHeuristic({ notes = 0, attachments = 0, previewCache = 0, listThumbs = 0 } = {}) {
    const score = notes + attachments * 2 + previewCache * 3 + listThumbs;
    if (score > 280) return { level: 'high', score, label: 'High memory use — avoid opening many documents at once' };
    if (score > 140) return { level: 'warn', score, label: 'Moderate memory use' };
    return { level: 'ok', score, label: '' };
  }

  async function storageEstimateLine() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return '';
    try {
      const est = await navigator.storage.estimate();
      const used = Number(est.usage) || 0;
      const quota = Number(est.quota) || 0;
      if (!quota) return '';
      const usedMb = Math.round(used / (1024 * 1024));
      const quotaMb = Math.round(quota / (1024 * 1024));
      const pct = Math.round((used / quota) * 100);
      return `Storage ${usedMb}/${quotaMb} MB (${pct}%)`;
    } catch (err) {
      return '';
    }
  }

  async function warnStorageIfLow(threshold = 0.88) {
    if (!navigator.storage?.estimate) return false;
    try {
      const est = await navigator.storage.estimate();
      const used = Number(est.usage) || 0;
      const quota = Number(est.quota) || 0;
      if (!quota || used / quota < threshold) return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  function deviceReportExtras() {
    const lines = [];
    lines.push(`iOS: ${IS_IOS ? 'yes' : 'no'}`);
    lines.push(`Standalone PWA: ${isStandalone() ? 'yes' : 'no'}`);
    lines.push(`Viewport: ${globalThis.innerWidth || 0}×${globalThis.innerHeight || 0}`);
    if (typeof navigator !== 'undefined') {
      lines.push(`onLine: ${navigator.onLine}`);
      if (navigator.connection?.effectiveType) {
        lines.push(`Network type: ${navigator.connection.effectiveType}`);
      }
    }
    return lines.join('\n');
  }

  return {
    IS_IOS,
    isIos,
    isStandalone,
    yieldMainThread,
    isTypingInField,
    memoryHeuristic,
    storageEstimateLine,
    warnStorageIfLow,
    deviceReportExtras,
  };
})();
if (typeof window !== 'undefined') window.NotesIosTune = NotesIosTune;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesIosTune;
