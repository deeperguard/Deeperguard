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

  function renderHtml(text) {
    const src = String(text || '');
    const superscript = (typeof globalThis !== 'undefined' && globalThis.NotesSuperscript)
      || (typeof window !== 'undefined' && window.NotesSuperscript);
    const ranges = superscript?.collectLinkRanges ? superscript.collectLinkRanges(src) : [];
    if (!ranges.length) return escapeHtml(src);
    let html = '';
    let cursor = 0;
    ranges.forEach((range) => {
      html += escapeHtml(src.slice(cursor, range.start));
      const chunk = src.slice(range.start, range.end);
      const kind = overlayHrefKind(range.href);
      if (!kind) {
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
