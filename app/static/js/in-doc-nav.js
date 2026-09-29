const NotesInDocNav = (() => {
  function slugify(text) {
    return String(text || '')
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  }

  function isExternalHref(href) {
    const raw = String(href || '').trim();
    return /^https?:\/\//i.test(raw) || /^mailto:/i.test(raw);
  }

  function normalizeInDocHref(href) {
    const raw = String(href || '').trim();
    if (!raw || isExternalHref(raw)) return raw;
    if (raw.startsWith('#')) return raw;
    return `#${slugify(raw.replace(/^#/, ''))}`;
  }

  function headingIdForText(text, used) {
    const base = slugify(String(text || '').replace(/<[^>]+>/g, ''));
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    used.add(id);
    return id;
  }

  function annotateHeadingHtml(html) {
    const used = new Set();
    return String(html || '').replace(/<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/gi, (full, level, attrs, inner) => {
      if (/\bid\s*=/.test(attrs)) return full;
      const id = headingIdForText(inner, used);
      const safe = id.replace(/"/g, '');
      return `<h${level}${attrs} id="${safe}">${inner}</h${level}>`;
    });
  }

  function collectHeadingIndex(text) {
    const headings = [];
    const src = String(text || '');
    src.split('\n').forEach((line, lineIndex) => {
      const md = line.match(/^(#{1,3})\s+(.+)$/);
      if (md) {
        headings.push({ line: lineIndex, text: md[2].trim(), level: md[1].length });
        return;
      }
      const chapter = line.match(/^(chapter\s+[\dIVXLC]+[^:]*:\s*.+)$/i);
      if (chapter) headings.push({ line: lineIndex, text: chapter[1].trim(), level: 2 });
    });
    return headings;
  }

  function resolveHeadingTarget(bodyText, href) {
    const raw = String(href || '').trim();
    if (!raw || isExternalHref(raw)) return null;
    const headings = collectHeadingIndex(bodyText);
    const targetSlug = raw.startsWith('#') ? raw.slice(1) : slugify(raw);
    const label = raw.startsWith('#') ? '' : raw.trim();
    for (const h of headings) {
      const id = slugify(h.text);
      if (id === targetSlug || slugify(h.text) === targetSlug) {
        return { line: h.line, id, text: h.text };
      }
      if (label && h.text.toLowerCase() === label.toLowerCase()) {
        return { line: h.line, id, text: h.text };
      }
    }
    if (label) {
      const want = slugify(label);
      const hit = headings.find((h) => {
        const id = slugify(h.text);
        return id === want || id.includes(want) || want.includes(id)
          || h.text.toLowerCase().includes(label.toLowerCase());
      });
      if (hit) return { line: hit.line, id: slugify(hit.text), text: hit.text };
    }
    if (targetSlug) {
      const hit = headings.find((h) => slugify(h.text) === targetSlug || slugify(h.text).includes(targetSlug));
      if (hit) return { line: hit.line, id: slugify(hit.text), text: hit.text };
    }
    return { line: -1, id: targetSlug, text: '' };
  }

  const api = {
    slugify,
    isExternalHref,
    normalizeInDocHref,
    annotateHeadingHtml,
    collectHeadingIndex,
    resolveHeadingTarget,
  };
  if (typeof window !== 'undefined') window.NotesInDocNav = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
