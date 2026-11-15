// 2FA account icons (docs/2FA_IMPORT_SPEC.md section 6). Icons come only from the vendored
// sprite under /static/icons/brands/ (same origin). Nothing is ever fetched from another host.
const NotesTotpIcons = (() => {
  const SPRITE_URL = '/static/icons/brands/brands.svg';
  const JSON_URL = '/static/icons/brands/brands.json';
  const LETTER = 'letter';
  const AVATAR_COLORS = [
    '#b3261e', '#c2410c', '#a16207', '#4d7c0f', '#15803d', '#0f766e',
    '#0e7490', '#1d4ed8', '#4338ca', '#7e22ce', '#a21caf', '#be185d',
  ];
  // Small hand-kept alias table (normalised name -> slug).
  const ALIASES = {
    googleworkspace: 'google', gsuite: 'google', googleaccount: 'google',
    twitter: 'x', fb: 'facebook', ig: 'instagram', stackexchange: 'stackoverflow',
    bookingcom: 'bookingdotcom', tor: 'torproject', onepassword: '1password',
    epic: 'epicgames', epicgamesstore: 'epicgames', riot: 'riotgames', protonme: 'proton',
  };

  // Registrable-domain handling: a few common two-level public suffixes.
  const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
  const SUFFIX_WORDS = /\s+(inc|llc|ltd|gmbh|corp|corporation|limited|bv|ag|co)\.?$/;

  let brands = null; // slug -> { title, hex, aliases }
  let index = null;  // normalised name -> slug

  function fold(value) {
    return String(value == null ? '' : value).normalize('NFKC').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Spec 6.3 step 1: NFKC, lower case, strip accents, drop company suffixes and ".com", keep [a-z0-9].
  function normalizeIssuer(value) {
    let s = fold(value).trim();
    for (let i = 0; i < 3; i += 1) {
      const before = s;
      s = s.replace(/\.(com|net|org|io)$/, '').replace(SUFFIX_WORDS, '').trim();
      if (s === before) break;
    }
    return s.replace(/[^a-z0-9]/g, '');
  }

  function buildIndex(map) {
    const idx = new Map();
    const put = (name, slug) => { const k = normalizeIssuer(name); if (k && !idx.has(k)) idx.set(k, slug); };
    for (const [slug, b] of Object.entries(map || {})) {
      idx.set(slug, slug);
      put(b.title, slug);
      for (const a of b.aliases || []) put(a, slug);
    }
    for (const [name, slug] of Object.entries(ALIASES)) if (map && map[slug]) idx.set(name, slug);
    return idx;
  }

  function setBrands(map) {
    brands = map && typeof map === 'object' ? map : null;
    index = brands ? buildIndex(brands) : null;
  }

  // "accounts.example.co.uk" -> "example"; "login.github.com" -> "github".
  function domainLabel(host) {
    const labels = fold(host).trim().replace(/\.$/, '').split('.').filter(Boolean);
    if (labels.length < 2) return '';
    let i = labels.length - 2;
    if (labels.length >= 3 && SECOND_LEVEL.has(labels[i]) && labels[labels.length - 1].length === 2) i -= 1;
    return labels[i].replace(/[^a-z0-9]/g, '');
  }

  // Slug for an issuer (and optional bound host), or null. No fuzzy matching.
  function matchIssuer(issuer, host) {
    if (!index) return null;
    const key = normalizeIssuer(issuer);
    if (key && index.has(key)) return index.get(key);
    if (host) {
      const dom = domainLabel(host);
      if (dom && index.has(dom)) return index.get(dom);
    }
    return null;
  }

  // icon_id: null = automatic, 'letter' = force avatar, else a slug that must exist in the set.
  function resolve(entry) {
    const e = entry || {};
    const id = e.icon_id == null ? null : String(e.icon_id);
    if (id === LETTER) return { kind: 'letter' };
    if (id && brands && Object.prototype.hasOwnProperty.call(brands, id)) return { kind: 'brand', slug: id };
    if (id === null || !brands) {
      const slug = matchIssuer(e.issuer, e.host);
      if (slug) return { kind: 'brand', slug };
    }
    return { kind: 'letter' };
  }

  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
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
  function contrast(a, b) {
    const la = luminance(a); const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function firstGrapheme(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
      return it.done ? '' : it.value.segment;
    }
    return Array.from(s)[0] || '';
  }

  function avatarSpec(entry) {
    const e = entry || {};
    const letter = (firstGrapheme(e.issuer) || firstGrapheme(e.label || e.account) || '?').toLocaleUpperCase();
    const seed = normalizeIssuer(e.issuer) || normalizeIssuer(e.label || e.account) || letter;
    const bg = AVATAR_COLORS[hash32(seed) % AVATAR_COLORS.length];
    const fg = contrast(bg, '#ffffff') >= contrast(bg, '#000000') ? '#ffffff' : '#000000';
    return { letter, bg, fg };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Inline markup for one icon tile. 24x24 viewBox, vector, so it stays sharp on retina.
  function iconHtml(entry, { size = 40 } = {}) {
    const r = resolve(entry);
    if (r.kind === 'brand') {
      let hex = brands[r.slug].hex || '000000';
      if (luminance(hex) > 0.8) hex = '1f2937';
      return `<span class="totp-icon totp-icon--brand" style="width:${size}px;height:${size}px;color:#${esc(hex)}" aria-hidden="true">`
        + `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.6)}" height="${Math.round(size * 0.6)}" fill="currentColor" focusable="false"><use href="${SPRITE_URL}#si-${esc(r.slug)}"></use></svg></span>`;
    }
    const a = avatarSpec(entry);
    return `<span class="totp-icon totp-icon--letter" style="width:${size}px;height:${size}px;background:${a.bg};color:${a.fg}" aria-hidden="true">`
      + `<svg viewBox="0 0 24 24" width="${size}" height="${size}" focusable="false"><text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="600" fill="currentColor">${esc(a.letter)}</text></svg></span>`;
  }

  // Picker: slugs whose title/slug/aliases contain every search term.
  function search(query) {
    if (!brands) return [];
    const terms = fold(query).split(/\s+/).filter(Boolean);
    return Object.keys(brands).filter((slug) => {
      const b = brands[slug];
      const hay = fold([slug, b.title, ...(b.aliases || [])].join(' '));
      return terms.every((t) => hay.includes(t));
    }).sort((x, y) => fold(brands[x].title).localeCompare(fold(brands[y].title)));
  }

  let loading = null;
  // Lazy same-origin load of brands.json; resolves true when the set is ready.
  function load() {
    if (brands) return Promise.resolve(true);
    if (!loading) {
      loading = fetch(JSON_URL, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { setBrands(j); return !!brands; })
        .catch(() => false); // a failed load is not retried until reload (the list re-renders often)
    }
    return loading;
  }

  return {
    LETTER, SPRITE_URL, JSON_URL, AVATAR_COLORS,
    normalizeIssuer, domainLabel, matchIssuer, resolve, avatarSpec, iconHtml, search, setBrands, load,
    title: (slug) => (brands && brands[slug] ? brands[slug].title : ''),
    ready: () => !!brands,
  };
})();

if (typeof window !== 'undefined') window.NotesTotpIcons = NotesTotpIcons;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesTotpIcons;
