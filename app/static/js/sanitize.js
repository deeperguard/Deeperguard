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

  const DIR_VALUES = new Set(['auto', 'ltr', 'rtl']);
  // Quote-aware: a ">" inside a quoted attribute value does not end the tag.
  const TAG_RE = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  const ATTR_RE = /\s+([^\s"'<>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

  function attrValue(raw) {
    if (raw == null) return '';
    const v = String(raw);
    return /^["']/.test(v) ? v.slice(1, -1) : v;
  }

  // Preview HTML attribute filter: drops inline event handlers (on*) and
  // keeps at most one dir attribute, only with value auto|ltr|rtl.
  function sanitizePreviewAttrs(html) {
    return String(html || '').replace(TAG_RE, (full, name, attrs, selfClose) => {
      if (!attrs) return full;
      let out = '';
      let hasDir = false;
      let changed = false;
      attrs.replace(ATTR_RE, (attr, attrName, raw) => {
        const key = attrName.toLowerCase();
        if (key.startsWith('on')) {
          changed = true;
        } else if (key === 'dir') {
          const value = attrValue(raw).trim().toLowerCase();
          if (!hasDir && DIR_VALUES.has(value)) {
            hasDir = true;
            out += ` dir="${value}"`;
          }
          changed = true;
        } else {
          out += attr;
        }
        return '';
      });
      if (!changed) return full;
      return `<${name}${out}${selfClose ? ' /' : ''}>`;
    });
  }

  // --- Rich (Markdown) view: URL allowlist + DOMPurify allowlist (docs/design/rich-editor.md 4.1) ---
  // Invisible, control, bidi and whitespace characters: an href containing any of them is refused
  // instead of guessed at (e.g. a zero-width space inside "javascript:").
  const URL_INVISIBLE_RANGES = [
    [0x0, 0x20], [0x7f, 0xa0], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x180e, 0x180e],
    [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
  ];
  const URL_INVISIBLE_RE = new RegExp(`[${URL_INVISIBLE_RANGES.map(([from, to]) => (
    String.fromCharCode(from) + (to > from ? `-${String.fromCharCode(to)}` : '')
  )).join('')}]`);

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

  // Images only come from the user's own attachments (blob: object URLs) or inline raster
  // data: URIs. SVG, external http(s) and everything else is refused.
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
    'div', 'button',
  ];
  const RICH_ALLOWED_ATTR = [
    'href', 'src', 'title', 'alt', 'class', 'dir', 'colspan', 'rowspan', 'start', 'type', 'rel',
    'target', 'aria-checked', 'data-checked', 'data-lang',
  ];
  const RICH_SANITIZE_CONFIG = {
    ALLOWED_TAGS: RICH_ALLOWED_TAGS,
    ALLOWED_ATTR: RICH_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // Plain-value attributes: DOMPurify would otherwise test their value against the URL regexp.
    ADD_URI_SAFE_ATTR: ['data-checked', 'aria-checked', 'data-lang', 'colspan', 'rowspan', 'start'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|blob:|data:image\/(?:png|jpeg|gif|webp)[;,])/i,
    KEEP_CONTENT: true,
  };

  const BLOCK_DIR_AUTO = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TH', 'TD']);

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
    else if (node.hasAttribute?.('type')) node.removeAttribute('type');
    // Per-block text direction (RTL notes): a fixed value, never copied from input.
    if (BLOCK_DIR_AUTO.has(name)) node.setAttribute('dir', 'auto');
    else if (name === 'PRE' || name === 'CODE') node.setAttribute('dir', 'ltr');
    else if (node.hasAttribute?.('dir')) node.removeAttribute('dir');
    // Table alignment comes from a class the renderer sets (fixed list), never from input.
    if (node.hasAttribute?.('style')) node.removeAttribute('style');
    if (name === 'TH' || name === 'TD') {
      const align = /(?:^|\s)md-align-(left|center|right)(?:\s|$)/.exec(node.getAttribute('class') || '');
      if (align) node.setAttribute('style', `text-align:${align[1]}`);
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
  // (e.g. node without a DOM); callers then keep their escape-only fallback.
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
    sanitizePreviewAttrs,
    safeRichHref,
    safeRichImageSrc,
    sanitizeRichHtml,
    RICH_ALLOWED_TAGS,
    RICH_ALLOWED_ATTR,
  };
  if (typeof window !== 'undefined') window.NotesSanitize = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
