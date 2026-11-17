const NotesLinkOverlay = (() => {
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  function overlayHrefKind(href) {
    const value = String(href || '').trim();
    if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return 'web';
    if (/^#/.test(value) && !/^#[a-z][a-z0-9+.-]*:/i.test(value)) return 'doc';
    return '';
  }

  function globalModule(name) {
    if (typeof globalThis !== 'undefined' && globalThis[name]) return globalThis[name];
    return typeof window !== 'undefined' ? window[name] : undefined;
  }

  /**
   * `noteLookup(uuid)` returns {title, trashed} for a note in the vault, or
   * null; it decides whether a [Title](dg-note:<uuid>) link is drawn as dead.
   */
  function renderHtml(text, { noteLookup } = {}) {
    const src = String(text || '');
    const superscript = globalModule('NotesSuperscript');
    const noteLinks = globalModule('NotesLinks');
    const notes = noteLinks?.findLinks ? noteLinks.findLinks(src) : [];
    const web = superscript?.collectLinkRanges ? superscript.collectLinkRanges(src) : [];
    const ranges = notes.concat(web.filter((r) => !notes.some((n) => r.start < n.end && r.end > n.start)))
      .sort((a, b) => a.start - b.start);
    if (!ranges.length) return escapeHtml(src);
    let html = '';
    let cursor = 0;
    ranges.forEach((range) => {
      html += escapeHtml(src.slice(cursor, range.start));
      const chunk = src.slice(range.start, range.end);
      const kind = range.uuid ? 'note' : overlayHrefKind(range.href);
      if (kind === 'note') {
        const state = noteLinks.resolve(range.uuid, noteLookup).state;
        const dead = state === 'ok' ? '' : ` note-link-dead" data-dead="${state}`;
        html += `<a class="edit-link note-link${dead}" href="#note/${range.uuid}" data-dg-note="${range.uuid}">${escapeHtml(chunk)}</a>`;
      } else if (!kind) {
        html += escapeHtml(chunk);
      } else {
        const href = escapeAttr(range.href);
        html += kind === 'doc'
          ? `<a class="edit-link in-doc-link" href="${href}">${escapeHtml(chunk)}</a>`
          : `<a class="edit-link" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(chunk)}</a>`;
      }
      cursor = range.end;
    });
    html += escapeHtml(src.slice(cursor));
    return html;
  }

  const api = { renderHtml };
  if (typeof window !== 'undefined') window.NotesLinkOverlay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
