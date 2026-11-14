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

  // --- Rich (Markdown) view: URL allowlist + DOMPurify allowlist (docs/design/rich-editor.md 4.1) ---
  // Invisible, control, bidi and whitespace characters: an href containing any of them is refused
  // instead of guessed at (e.g. "java\u200bscript:").
  const URL_INVISIBLE_RE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/;

  function percentDecoded(value) {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }

  function safeRichHref(url) {
    const href = String(url ?? '');
    if (!href || URL_INVISIBLE_RE.test(href) || /["'<>`\\]/.test(href)) return '';
    // Also refuse percent-encoded control/bidi/zero-width characters (an encoded space is fine).
    if (URL_INVISIBLE_RE.test(percentDecoded(href).replace(/ /g, ''))) return '';
    if (href.startsWith('#')) return href.length > 1 && !href.includes(':') ? href : '';
    if (/^https?:\/\/[^/?#]/i.test(href) || /^mailto:[^/]/i.test(href)) return href;
    return '';
  }

  function safeRichImageSrc(url) {
    const src = String(url ?? '');
    if (!src || URL_INVISIBLE_RE.test(src) || /["'<>`\\]/.test(src)) return '';
    if (/^blob:https?:\/\/[^\s]+$/i.test(src)) return src;
    if (/^data:image\/(?:png|jpeg|gif|webp)(?:;base64)?,[A-Za-z0-9+/=%._-]*$/i.test(src)) return src;
    return '';
  }

  const RICH_ALLOWED_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'span',
    'div', 'mark', 'button', 'input',
  ];
  const RICH_ALLOWED_ATTR = [
    'href', 'src', 'title', 'alt', 'class', 'id', 'colspan', 'rowspan', 'start', 'type', 'checked',
    'disabled', 'rel', 'target', 'role', 'aria-label', 'aria-checked', 'data-checked', 'data-lang',
    'data-dg-note', 'data-dead',
  ];
  const RICH_SANITIZE_CONFIG = {
    ALLOWED_TAGS: RICH_ALLOWED_TAGS,
    ALLOWED_ATTR: RICH_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|blob:|data:image\/(?:png|jpeg|gif|webp)[;,])/i,
    KEEP_CONTENT: true,
  };

  function richAfterAttributes(node) {
    const name = node.nodeName;
    if (name === 'A') {
      const href = node.hasAttribute('href') ? safeRichHref(node.getAttribute('href')) : '';
      if (!href) node.removeAttribute('href');
      if (href && !href.startsWith('#')) {
        node.setAttribute('rel', 'noopener noreferrer');
        node.setAttribute('target', '_blank');
      } else {
        node.removeAttribute('rel');
        node.removeAttribute('target');
      }
    } else if (node.hasAttribute?.('target') || node.hasAttribute?.('rel')) {
      node.removeAttribute('target');
      node.removeAttribute('rel');
    }
    if (name === 'IMG' && !safeRichImageSrc(node.getAttribute('src'))) node.removeAttribute('src');
    if (name !== 'IMG' && node.hasAttribute?.('src')) node.removeAttribute('src');
    if (name === 'BUTTON') node.setAttribute('type', 'button');
    if (name === 'INPUT') {
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    } else if (node.hasAttribute?.('type') && name !== 'BUTTON') {
      node.removeAttribute('type');
    }
  }

  const purifiers = new WeakMap();
  function richPurifier(win) {
    const host = win || (typeof window !== 'undefined' ? window : null);
    if (!host || !host.document) return null;
    if (purifiers.has(host)) return purifiers.get(host);
    let factory = host.DOMPurify;
    if (!factory && typeof require === 'function') {
      try { factory = require('./vendor/dompurify/purify.min.js'); } catch (_) { factory = null; }
    }
    let purifier = null;
    if (typeof factory === 'function') {
      purifier = factory(host);
      if (purifier && purifier.isSupported) purifier.addHook('afterSanitizeAttributes', richAfterAttributes);
      else purifier = null;
    }
    purifiers.set(host, purifier);
    return purifier;
  }

  // Last step before rich HTML enters the DOM. Returns null when no DOM sanitizer is available
  // (e.g. a stripped-down test harness); callers then keep their escape-only fallback.
  function sanitizeRichHtml(html, win) {
    const purifier = richPurifier(win);
    if (!purifier) return null;
    return purifier.sanitize(String(html ?? ''), RICH_SANITIZE_CONFIG);
  }

  const api = {
    escapeHtml,
    escapeAttr,
    safeColor,
    clearUnchangedDirty,
    safeRichHref,
    safeRichImageSrc,
    sanitizeRichHtml,
    RICH_ALLOWED_TAGS,
    RICH_ALLOWED_ATTR,
  };
  if (typeof window !== 'undefined') window.NotesSanitize = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
