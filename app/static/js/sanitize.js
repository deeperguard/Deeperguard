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

  const api = { escapeHtml, escapeAttr, safeColor, clearUnchangedDirty, sanitizePreviewAttrs };
  if (typeof window !== 'undefined') window.NotesSanitize = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
