/** Concatenate bodies of all @media (<predicate>) { ... } blocks in app.css. */
function concatCssMediaBlocks(css, predicate) {
  const marker = `@media (${predicate})`;
  const chunks = [];
  let start = 0;
  for (;;) {
    const idx = css.indexOf(marker, start);
    if (idx < 0) break;
    const brace = css.indexOf('{', idx);
    if (brace < 0) break;
    let depth = 1;
    let i = brace + 1;
    while (i < css.length && depth) {
      const ch = css[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    chunks.push(css.slice(brace + 1, i - 1));
    start = i;
  }
  return chunks.join('\n');
}

function cssPhoneBlock(css) {
  return concatCssMediaBlocks(css, 'max-width: 999px');
}

function cssDesktopBlock(css) {
  return concatCssMediaBlocks(css, 'min-width: 1000px');
}

module.exports = { concatCssMediaBlocks, cssPhoneBlock, cssDesktopBlock };
