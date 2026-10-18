(() => {
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'have', 'has',
    'are', 'was', 'were', 'been', 'will', 'would', 'could', 'should', 'into',
    'about', 'after', 'before', 'over', 'under', 'than', 'then', 'them', 'they',
    'their', 'there', 'here', 'what', 'when', 'where', 'which', 'while', 'who',
    'you', 'but', 'not', 'all', 'any', 'can', 'our', 'out', 'also', 'more',
    'some', 'such', 'only', 'other', 'just', 'like', 'page', 'document', 'scan',
    'image', 'file', 'pdf', 'jpeg', 'jpg', 'png',
  ]);

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{3,}/g) || [];
  }

  function frequencies(tokens) {
    const freq = new Map();
    for (const token of tokens) {
      if (STOP.has(token) || /^\d+$/.test(token)) continue;
      freq.set(token, (freq.get(token) || 0) + 1);
    }
    return freq;
  }

  function titleCase(word) {
    return String(word || '').replace(/\w+/g, (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
  }

  function inventTitle(freq, filename) {
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked.length) return titleCase(ranked[0][0]);
    const stem = String(filename || '')
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim();
    const cleaned = tokenize(stem).filter((w) => !STOP.has(w) && w.length >= 4)[0];
    if (!cleaned || cleaned.length < 4) return '';
    return titleCase(cleaned);
  }

  function hasWord(hay, word) {
    const token = String(word || '').toLowerCase();
    if (token.length < 4) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(hay);
  }

  function scoreTag(title, text, freq) {
    const hay = String(text || '').toLowerCase();
    const name = String(title || '').trim().toLowerCase();
    if (!name || name.length < 4) return 0;
    let score = 0;
    if (hasWord(hay, name)) score += 8;
    for (const word of name.split(/[^a-z0-9]+/).filter(Boolean)) {
      if (STOP.has(word) || word.length < 4) continue;
      score += (freq.get(word) || 0) * 3;
      if (hasWord(hay, word)) score += 1;
    }
    return score;
  }

  function suggest(text, tags, { filename = '' } = {}) {
    const freq = frequencies(tokenize(text));
    let best = null;
    for (const tag of tags || []) {
      const title = tag.content?.title || '';
      const score = scoreTag(title, text, freq);
      if (score > 0 && (!best || score > best.score)) {
        best = { existing: true, tagId: tag.uuid, title, score };
      }
    }
    if (best && best.score >= 2) return best;
    const title = inventTitle(freq, filename);
    if (!title || title.length < 4) return null;
    return {
      existing: false,
      tagId: null,
      title,
      score: 1,
    };
  }

  const api = { suggest, tokenize, inventTitle };
  if (typeof window !== 'undefined') window.NotesTagSuggest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
