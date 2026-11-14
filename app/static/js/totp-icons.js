// 2FA account icons (docs/2FA_IMPORT_SPEC.md, section 6). Icons come only from the vendored
// sprite on our own origin; there is no favicon, logo API or other third-party lookup.
// Unknown issuers get a letter avatar generated here as inline SVG text.
const NotesTotpIcons = (() => {
  const BRANDS = (typeof NotesTotpBrands !== 'undefined') ? NotesTotpBrands : require('./totp-brands.js');
  const SPRITE = '/static/icons/brands/brands.svg';
  // Hand-kept aliases on top of brands.json (normalised form -> slug).
  const EXTRA_ALIASES = {
    googleworkspace: 'google', googlecloud: 'google', youtube: 'google',
    twitter: 'x', xcorp: 'x', fb: 'facebook',
    github: 'github', githubcom: 'github', msa: 'microsoft', xbox: 'microsoft',
    aws: 'amazonwebservices', amazonaws: 'amazonwebservices',
  };
  // 12 fixed avatar colours from the app palette (all pass AA with white or black text).
  const AVATAR_COLORS = [
    '#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#CA8A04',
    '#16A34A', '#0D9488', '#0891B2', '#4F46E5', '#9333EA', '#475569',
  ];
  const SUFFIXES = /\s+(inc|llc|ltd|limited|gmbh|bv|b\.v|corp|corporation|co|plc|sa|ag|ab)\.?$/;
  const TLDS = /\.(com|net|org|io|co|app|dev|me|de|nl|uk|eu|fr)$/;
  const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);

  function normalize(value) {
    let s = String(value == null ? '' : value).normalize('NFKC').toLowerCase().trim();
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (let i = 0; i < 3; i += 1) {
      const next = s.replace(SUFFIXES, '').replace(TLDS, '').replace(/[\s,.]+$/, '');
      if (next === s) break;
      s = next;
    }
    return s.replace(/[^a-z0-9]/g, '');
  }

  // accounts.example.co.uk -> example
  function registrableLabel(host) {
    const parts = String(host || '').toLowerCase().trim().replace(/\.$/, '').split('.').filter(Boolean);
    if (parts.length < 2 || parts.some((p) => !/^[a-z0-9-]+$/.test(p))) return '';
    let i = parts.length - 2;
    if (parts.length >= 3 && SECOND_LEVEL.has(parts[i]) && parts[parts.length - 1].length === 2) i -= 1;
    return normalize(parts[i]);
  }

  let index = null;
  function buildIndex() {
    const map = new Map();
    const add = (key, slug) => { const k = normalize(key); if (k && !map.has(k)) map.set(k, slug); };
    Object.keys(BRANDS).forEach((slug) => add(slug, slug));
    Object.entries(BRANDS).forEach(([slug, b]) => add(b.title, slug));
    Object.entries(BRANDS).forEach(([slug, b]) => (b.aliases || []).forEach((a) => add(a, slug)));
    Object.entries(EXTRA_ALIASES).forEach(([a, slug]) => { if (BRANDS[slug]) add(a, slug); });
    return map;
  }

  function lookup(key) {
    if (!key) return null;
    index = index || buildIndex();
    return index.get(key) || null;
  }

  // Automatic match: exact issuer, then host's registrable label. No fuzzy matching.
  function match(entry) {
    const e = entry || {};
    return lookup(normalize(e.issuer)) || lookup(registrableLabel(e.host)) || null;
  }

  // What to show: { kind: 'brand', slug } or { kind: 'letter' }.
  function resolve(entry) {
    const chosen = entry && entry.icon_id;
    if (chosen === 'letter') return { kind: 'letter' };
    if (chosen && BRANDS[chosen]) return { kind: 'brand', slug: chosen };
    const slug = match(entry);
    return slug ? { kind: 'brand', slug } : { kind: 'letter' };
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function luminance(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  // White or black, whichever has the higher WCAG contrast on bg.
  function textOn(hex) {
    const l = luminance(hex);
    return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.05) ? '#FFFFFF' : '#000000';
  }

  function letterFor(entry) {
    const e = entry || {};
    const src = String(e.issuer || e.account || e.label || '').trim();
    const first = Array.from(src)[0] || '?';
    return first.toLocaleUpperCase();
  }

  function letterColor(entry) {
    const e = entry || {};
    const key = normalize(e.issuer) || normalize(e.account || e.label) || '?';
    return AVATAR_COLORS[hash(key) % AVATAR_COLORS.length];
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeHex(hex) {
    return /^[0-9A-Fa-f]{6}$/.test(String(hex)) ? `#${hex}` : '#475569';
  }

  function brandHtml(slug) {
    const b = BRANDS[slug];
    const bg = safeHex(b.hex);
    return `<span class="totp-icon totp-icon--brand" style="--totp-icon-bg:${bg};--totp-icon-fg:${textOn(bg)}" title="${esc(b.title)}">`
      + `<svg class="totp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="${SPRITE}#si-${esc(slug)}"></use></svg></span>`;
  }

  function letterHtml(entry) {
    const bg = letterColor(entry);
    return `<span class="totp-icon totp-icon--letter" style="--totp-icon-bg:${bg};--totp-icon-fg:${textOn(bg)}">`
      + `<span class="totp-icon-letter">${esc(letterFor(entry))}</span></span>`;
  }

  function iconHtml(entry) {
    const r = resolve(entry);
    return r.kind === 'brand' ? brandHtml(r.slug) : letterHtml(entry);
  }

  // Picker search over the vendored set: title, slug and aliases, case/space-insensitive.
  function search(query, limit = 60) {
    const q = normalize(query);
    const all = Object.entries(BRANDS)
      .map(([slug, b]) => ({ slug, title: b.title, keys: [slug, normalize(b.title), ...(b.aliases || []).map(normalize)] }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const hits = q ? all.filter((x) => x.keys.some((k) => k.includes(q))) : all;
    return hits.slice(0, limit).map(({ slug, title }) => ({ slug, title }));
  }

  function isValidIconId(id) {
    return id === null || id === 'letter' || (typeof id === 'string' && Object.prototype.hasOwnProperty.call(BRANDS, id));
  }

  return {
    SPRITE, AVATAR_COLORS, normalize, registrableLabel, match, resolve, textOn,
    letterFor, letterColor, brandHtml, letterHtml, iconHtml, search, isValidIconId,
  };
})();

if (typeof window !== 'undefined') window.NotesTotpIcons = NotesTotpIcons;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesTotpIcons;
