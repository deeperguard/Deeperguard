/**
 * Quick capture (docs/REMINDERS_TASKS_SPEC.md sections 5 and 6).
 *
 * Pure helpers for the Ctrl/Cmd+Shift+K sheet and the Web Share Target:
 * - isCaptureShortcut: the one in-app shortcut (no clash with Ctrl+K search,
 *   Ctrl+N / Ctrl+Alt+N new note, j/k list navigation, agenda single keys).
 * - requestPendingShare: one-shot MessageChannel ask to the service worker,
 *   which deletes the share when it answers.
 * - shareToText / buildCapturePayload: shared content is untrusted text.
 *
 * Nothing here touches localStorage, sessionStorage, IndexedDB or Cache
 * Storage. The caller keeps pending text in a JS variable only and saves it
 * through the normal encrypted NotesStore path after an explicit Save.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotesQuickCapture = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const MAX_CHARS = 64 * 1024;
  const TITLE_MAX = 200;

  function isCaptureShortcut(ev) {
    if (!ev || ev.isComposing || ev.keyCode === 229) return false;
    if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey || ev.altKey) return false;
    const key = String(ev.key || '').toLowerCase();
    return key === 'k' || ev.code === 'KeyK';
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  /** Joins title, text and url into one editable text, without repeats. */
  function shareToText(share) {
    if (!share || typeof share !== 'object') return '';
    const title = str(share.title).trim();
    const text = str(share.text).trim();
    const url = str(share.url).trim();
    const parts = [];
    if (title && !text.startsWith(title)) parts.push(title);
    if (text) parts.push(text);
    if (url && !text.includes(url) && title !== url) parts.push(url);
    let out = parts.join('\n');
    if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
    return out;
  }

  /**
   * Content for a new encrypted item. A task without a date stays a checklist
   * line inside a note (spec section 2.2), so old clients keep reading it.
   */
  function buildCapturePayload(text, kind, base) {
    const clean = str(text).replace(/\r\n?/g, '\n').trim();
    if (!clean) return null;
    const lines = clean.split('\n');
    const first = lines[0].trim();
    const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
    const title = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
    const payload = { ...(base || {}) };
    payload.title = title;
    payload.title_manual = true;
    if (kind === 'task') {
      payload.content = `- [ ] ${first}${rest ? `\n\n${rest}` : ''}`;
    } else {
      payload.content = rest;
    }
    return payload;
  }

  /**
   * Asks the active service worker for the pending share. Resolves with
   * { title, text, url } or null; never rejects.
   */
  function requestPendingShare(sw, { timeoutMs = 4000 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || null);
      };
      setTimeout(() => done(null), timeoutMs);
      if (!sw || typeof MessageChannel === 'undefined') {
        done(null);
        return;
      }
      const ask = (worker) => {
        if (!worker || typeof worker.postMessage !== 'function') {
          done(null);
          return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          const share = event.data && event.data.share;
          done(share && typeof share === 'object' ? share : null);
          try { channel.port1.close(); } catch (err) { /* ignore */ }
        };
        try {
          worker.postMessage({ type: 'notes-share-take' }, [channel.port2]);
        } catch (err) {
          done(null);
        }
      };
      if (sw.controller) {
        ask(sw.controller);
        return;
      }
      Promise.resolve(sw.ready)
        .then((reg) => ask(reg && reg.active))
        .catch(() => done(null));
    });
  }

  return {
    MAX_CHARS,
    isCaptureShortcut,
    shareToText,
    buildCapturePayload,
    requestPendingShare,
  };
}));
