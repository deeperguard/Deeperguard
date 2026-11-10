/** WCAG contrast helpers for Playwright (parse modern CSS colors). */
function parseCssColor(css) {
  const s = String(css || '').trim();
  if (!s) return null;
  let m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) {
    return {
      r: Math.round(Number(m[1])),
      g: Math.round(Number(m[2])),
      b: Math.round(Number(m[3])),
      a: m[4] !== undefined ? Number(m[4]) : 1,
    };
  }
  m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
  if (m) {
    return {
      r: Math.round(Number(m[1]) * 255),
      g: Math.round(Number(m[2]) * 255),
      b: Math.round(Number(m[3]) * 255),
      a: m[4] !== undefined ? Number(m[4]) : 1,
    };
  }
  return null;
}

function lin(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb) {
  if (!rgb) return null;
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

function compositeOver(fg, bg) {
  if (!fg || !bg) return fg || bg;
  const a = fg.a !== undefined ? fg.a : 1;
  if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  if (L1 === null || L2 === null) return null;
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function measureEditorContrast() {
  const banner = document.getElementById('agenda-edit-series-notice');
  const status = document.getElementById('agenda-edit-rrule-status');
  const sel = document.getElementById('agenda-edit-repeat');
  const dialog = document.getElementById('agenda-editor');
  const bSt = banner ? getComputedStyle(banner) : null;
  const sSt = status ? getComputedStyle(status) : null;
  const dSt = dialog ? getComputedStyle(dialog) : null;
  const bFgRaw = parseCssColor(bSt?.color);
  const bBgRaw = parseCssColor(bSt?.backgroundColor);
  const sFgRaw = parseCssColor(sSt?.color);
  const dBgRaw = parseCssColor(dSt?.backgroundColor);
  const bFg = bFgRaw && bBgRaw ? compositeOver(bFgRaw, bBgRaw) : bFgRaw;
  const sFg = sFgRaw && dBgRaw ? compositeOver(sFgRaw, dBgRaw) : sFgRaw;
  const sb = sel?.getBoundingClientRect();
  return {
    seriesContrast: contrastRatio(bFg, bBgRaw),
    seriesFgResolved: bFg,
    seriesBgResolved: bBgRaw,
    seriesColorRaw: bSt?.color,
    seriesBgRaw: bSt?.backgroundColor,
    helperContrast: contrastRatio(sFg, dBgRaw),
    helperFgResolved: sFg,
    dialogBgResolved: dBgRaw,
    helperColorRaw: sSt?.color,
    dialogBgRaw: dSt?.backgroundColor,
    patternSelectHeight: sb?.height,
  };
}

if (typeof module !== 'undefined') module.exports = { parseCssColor, contrastRatio, measureEditorContrast };
