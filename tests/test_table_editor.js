// GFM table editor (app/static/js/table-editor.js): round-trip, escaping, row/column operations and
// cell content safety. The keyboard grid in a real Chromium DOM: tests/test_table_editor_browser.py.
const assert = require('assert');
const TE = require('../app/static/js/table-editor.js');
const { render, renderLegacy, renderRichUnsafe } = require('../app/static/js/markdown.js');
const markdownit = require('../app/static/js/vendor/markdown-it/markdown-it.min.js');

const md = markdownit({ html: false });

// Rendered text of every body cell / header cell, via markdown-it (the engine of the real view).
function cellTexts(source) {
  const tokens = md.parse(source, {});
  const out = [];
  let inCell = false;
  for (const t of tokens) {
    if (t.type === 'th_open' || t.type === 'td_open') inCell = true;
    else if (t.type === 'th_close' || t.type === 'td_close') inCell = false;
    else if (inCell && t.type === 'inline') {
      out.push(t.children.map((c) => (c.type === 'text' || c.type === 'code_inline' ? c.content : '')).join(''));
    }
  }
  return out;
}

function editTable(source, edit) {
  const [range] = TE.findTables(source);
  assert.ok(range, `no table in ${JSON.stringify(source)}`);
  const model = TE.parseTable(source.slice(range.start, range.end));
  edit(model);
  return source.slice(0, range.start) + TE.serializeTable(model) + source.slice(range.end);
}

// --- Round-trip: opening and saving without a change keeps every byte ------------------------
const corpus = [
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '| Name  | Qty |\n| :---- | --: |\n| Apple |   3 |\n| Pear  |  12 |',
  'a | b\n--|--\n1|2',
  '|a|b|\n|:-:|-|\n|x\\|y|z|',
  '  | indented | t |\n  | --- | --- |\n  | 1 | 2 |   ',
  '| crlf | t |\r\n| --- | --- |\r\n| 1 | 2 |',
  '| \\\\| | \\* | \\_x\\_ | `a\\|b` |\n| - | - | - | - |\n| \\[x\\] | **b** | <b>x</b> | ü 🚀 |',
  '| only header |\n| --- |',
  '| short | row |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |',
];
for (const table of corpus) {
  const doc = `# Title\n\nText before.\n\n${table}\n\nText after.\n`;
  const ranges = TE.findTables(doc);
  assert.strictEqual(ranges.length, 1, `one table found in ${JSON.stringify(table)}`);
  assert.strictEqual(doc.slice(ranges[0].start, ranges[0].end), table.replace(/\r$/, ''));
  assert.strictEqual(editTable(doc, () => {}), doc, `unchanged round-trip ${JSON.stringify(table)}`);
  // Setting a cell to the value it already has is not a change either.
  assert.strictEqual(editTable(doc, (m) => TE.setCell(m, 1, 0, m.rows[0]?.cells[0] ?? '')), doc);
}

// The editor finds the same tables and rows as the renderer, and none inside code fences.
const mixed = [
  '| a | b |\n|---|---|\n| 1 | 2 |\nloose row\n\npara',
  '```\n| no | table |\n|---|---|\n```\n\n| yes |\n|---|\n| 1 |\n# heading',
  '~~~md\n| no |\n|---|\n~~~\n| t |\n|---|\n- list',
  '| x |\n| --- |\n> quote',
  '    | code | block |\n    |---|---|',
].join('\n\n');
const mdTables = md.parse(mixed, {}).filter((t) => t.type === 'table_open').map((t) => t.map);
const found = TE.findTables(mixed);
assert.strictEqual(found.length, mdTables.length);
found.forEach((range, i) => {
  const firstLine = mixed.slice(0, range.start).split('\n').length - 1;
  const lastLine = mixed.slice(0, range.end).split('\n').length;
  assert.deepStrictEqual([firstLine, lastLine], mdTables[i], `table ${i} covers the same lines`);
});
assert.strictEqual(TE.tableAt(mixed, 0).start, 0);
assert.strictEqual(TE.tableAt(mixed, mixed.indexOf('para')), null);
assert.strictEqual(TE.tableAt(mixed, mixed.indexOf('| no | table |')), null, 'not inside a fence');

// --- Edits change only what was edited ---------------------------------------------------------
const compact = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
assert.strictEqual(
  editTable(compact, (m) => TE.setCell(m, 2, 1, 'four')),
  '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | four |',
);
const aligned = '| Name  | Qty |\n| :---- | --: |\n| Apple |   3 |';
assert.strictEqual(
  editTable(aligned, (m) => TE.setCell(m, 1, 0, 'Watermelon')),
  '| Name       | Qty  |\n| :--------- | ---: |\n| Watermelon | 3    |',
  'a column-aligned table stays aligned',
);
assert.strictEqual(
  editTable('| a | b |\r\n|---|---|\r\n| 1 | 2 |', (m) => TE.setCell(m, 1, 0, 'x')),
  '| a | b |\r\n|---|---|\r\n| x | 2 |',
  'CRLF line ends are kept',
);
assert.strictEqual(
  editTable('  | a |\n  |---|\n  | 1 |', (m) => TE.insertRow(m, 1)),
  '  | a |\n  |---|\n  | 1 |\n  | |',
  'indentation is kept on new lines',
);

// --- Escaping: | and \ in cells ----------------------------------------------------------------
assert.strictEqual(TE.escapeCell('a|b'), 'a\\|b');
assert.strictEqual(TE.escapeCell('a\\b'), 'a\\b', 'a lone backslash is not doubled');
assert.strictEqual(TE.escapeCell('\\*'), '\\*', 'a Markdown escape is not doubled');
assert.strictEqual(TE.escapeCell('line\nbreak'), 'line break');
for (const raw of ['a\\|b', '\\\\|', '\\*', '\\_', '\\\\', 'x\\', '`a\\|b`', '\\\\\\|']) {
  assert.strictEqual(TE.escapeCell(TE.unescapeCell(raw)), raw, `cell source ${raw} survives`);
}
for (const text of ['a|b', '\\|', '\\', '||', 'x\\', '\\\\|']) {
  assert.strictEqual(TE.unescapeCell(TE.escapeCell(text)), text, `editor text ${text} survives`);
}

// A typed | ends up as a literal | in the view, in the same cell.
const piped = editTable('| a | b |\n|---|---|\n| 1 | 2 |', (m) => TE.setCell(m, 1, 0, 'x | y'));
assert.strictEqual(piped, '| a | b |\n|---|---|\n| x \\| y | 2 |');
assert.deepStrictEqual(cellTexts(piped), ['a', 'b', 'x | y', '2']);
// A typed \ stays one backslash and shows as one.
const slashed = editTable('| a |\n|---|\n| 1 |', (m) => TE.setCell(m, 1, 0, 'C:\\dir\\'));
assert.strictEqual(slashed, '| a |\n|---|\n| C:\\dir\\ |');
assert.deepStrictEqual(cellTexts(slashed), ['a', 'C:\\dir\\']);

// Cells holding Markdown escapes keep their meaning when the cell itself is edited ...
const escapes = '| e | f | g | h |\n|---|---|---|---|\n| \\* | \\_ | \\\\| | \\[x\\] |';
const before = cellTexts(escapes);
assert.deepStrictEqual(before, ['e', 'f', 'g', 'h', '*', '_', '|', '[x]']);
const typed = editTable(escapes, (m) => {
  // One keystroke at the end of each cell.
  m.rows[0].cells.forEach((text, c) => TE.setCell(m, 1, c, `${text}!`));
});
assert.strictEqual(typed, '| e | f | g | h |\n|---|---|---|---|\n| \\*! | \\_! | \\\\|! | \\[x\\]! |');
assert.deepStrictEqual(cellTexts(typed), ['e', 'f', 'g', 'h', '*!', '_!', '|!', '[x]!']);
// ... when another cell of the same row is edited (the row is rewritten) ...
const otherCell = editTable(`${escapes}\n| 1 | 2 | 3 | 4 |`, (m) => TE.setCell(m, 1, 0, '\\*'));
assert.deepStrictEqual(cellTexts(otherCell).slice(4, 8), before.slice(4, 8));
// ... and when a column is added (every line is rewritten).
const widened = editTable(escapes, (m) => TE.insertColumn(m, 4));
assert.deepStrictEqual(cellTexts(widened), ['e', 'f', 'g', 'h', '', '*', '_', '|', '[x]', '']);
// Same in the rendered view.
assert.match(renderRichUnsafe(typed), /<td>\*!<\/td>\s*<td>_!<\/td>\s*<td>\|!<\/td>/);

// --- Row and column operations ----------------------------------------------------------------
let m = TE.parseTable('| a | b |\n|---|---|\n| 1 | 2 |');
assert.strictEqual(TE.insertRow(m, 0), 0);
TE.setCell(m, 1, 0, 'new');
assert.strictEqual(TE.serializeTable(m), '| a | b |\n|---|---|\n| new | |\n| 1 | 2 |');
assert.strictEqual(TE.deleteRow(m, 0), true);
assert.strictEqual(TE.serializeTable(m), '| a | b |\n|---|---|\n| 1 | 2 |');
assert.strictEqual(TE.deleteRow(m, 0), true);
assert.strictEqual(TE.deleteRow(m, 0), false, 'deleting a missing row twice does nothing');
assert.strictEqual(TE.serializeTable(m), '| a | b |\n|---|---|', 'a header-only table is valid GFM');
assert.strictEqual(cellTexts(TE.serializeTable(m)).join(','), 'a,b');

m = TE.parseTable('| a | b |\n|---|---|\n| 1 | 2 |');
TE.insertColumn(m, 1);
TE.setCell(m, 0, 1, 'mid');
assert.strictEqual(TE.serializeTable(m), '| a | mid | b |\n| --- | --- | --- |\n| 1 | | 2 |');
assert.strictEqual(TE.deleteColumn(m, 0), true);
assert.strictEqual(TE.deleteColumn(m, 0), true);
assert.strictEqual(TE.deleteColumn(m, 0), false, 'the last column stays');
assert.strictEqual(TE.serializeTable(m), '| b |\n| --- |\n| 2 |');

m = TE.parseTable('| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |');
assert.strictEqual(TE.setAlign(m, 1, 'left'), true);
assert.strictEqual(TE.setAlign(m, 2, 'center'), true);
assert.strictEqual(TE.setAlign(m, 3, 'right'), true);
assert.strictEqual(TE.setAlign(m, 3, 'right'), false, 'same alignment twice is no change');
assert.strictEqual(TE.setAlign(m, 0, 'justify'), false);
const alignedOut = TE.serializeTable(m);
assert.strictEqual(alignedOut, '| a | b | c | d |\n| --- | :--- | :---: | ---: |\n| 1 | 2 | 3 | 4 |');
assert.match(renderRichUnsafe(alignedOut), /<th class="md-align-left" scope="col">b<\/th>/);
assert.match(renderRichUnsafe(alignedOut), /<td class="md-align-right">4<\/td>/);
TE.setAlign(m, 1, '');
assert.strictEqual(TE.serializeTable(m).split('\n')[1], '| --- | --- | :---: | ---: |');

// --- Cells past the header's column count stay in the source -------------------------------------
m = TE.parseTable('| a | b |\n|---|---|\n| 1 | 2 | extra \\| x |\n| 3 | 4 | |');
TE.setCell(m, 1, 0, 'one');
assert.strictEqual(TE.serializeTable(m), '| a | b |\n|---|---|\n| one | 2 | extra \\| x |\n| 3 | 4 | |');
m = TE.parseTable('| a | b |\n|---|---|\n| 1 | 2 | extra |');
TE.insertColumn(m, 0);
TE.setCell(m, 1, 1, 'x');
assert.strictEqual(TE.serializeTable(m), '| | a | b |\n| --- | --- | --- |\n| | x | 2 | extra |');
m = TE.parseTable('| a | b |\n|---|---|\n| 1 | 2 | extra |');
TE.deleteRow(m, 0);
TE.insertRow(m, 0);
assert.strictEqual(TE.serializeTable(m), '| a | b |\n|---|---|\n| | |');

// --- Inserting a new table ---------------------------------------------------------------------
assert.strictEqual(TE.newTableMarkdown(2, 1), '| Column 1 | Column 2 |\n| --- | --- |\n| | |');
let ins = TE.insertNewTable('', 0);
assert.strictEqual(ins.source, '| Column 1 | Column 2 |\n| --- | --- |\n| | |\n| | |\n');
assert.deepStrictEqual(TE.findTables(ins.source), [{ start: ins.start, end: ins.end }]);
ins = TE.insertNewTable('Intro text\nmore', 10);
assert.strictEqual(ins.source.slice(0, 12), 'Intro text\n\n');
assert.ok(ins.source.endsWith('| | |\n\nmore'), JSON.stringify(ins.source));
assert.deepStrictEqual(TE.findTables(ins.source), [{ start: ins.start, end: ins.end }]);
assert.strictEqual(cellTexts(ins.source).join(','), 'Column 1,Column 2,,,,');

// --- Cell content with HTML or script is never live markup -------------------------------------
const hostile = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[click](javascript:alert(1))',
  '<iframe src="javascript:alert(1)"></iframe>',
];
const hostileTable = editTable('| h |\n|---|\n| c |', (t) => {
  TE.setCell(t, 0, 0, hostile.join(' '));
  TE.setCell(t, 1, 0, hostile.join(' '));
});
assert.deepStrictEqual(cellTexts(hostileTable)[0], cellTexts(hostileTable)[1]);
// Plain Node has no DOM, so render() falls back to renderLegacy and DOMPurify does not run here.
// This block only checks the escaped output of markdown-it and of the fallback. DOMPurify on the
// table view is checked in real Chromium by tests/test_table_editor_browser.py.
for (const html of [render(hostileTable), renderRichUnsafe(hostileTable), renderLegacy(hostileTable)]) {
  assert.match(html, /<table>/);
  // Only the table's own elements are markup; the hostile text is all escaped character data.
  const tags = [...html.matchAll(/<([a-z][a-z0-9]*)([^>]*)>/gi)];
  for (const [, name, attrs] of tags) {
    assert.ok(['div', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(name.toLowerCase()), `unexpected <${name}>`);
    assert.doesNotMatch(attrs, /\bon\w+=|src=|href=/i, `unexpected attributes on <${name}>`);
  }
  assert.doesNotMatch(html, /<a\s|href="javascript:/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;iframe/);
}

console.log('test_table_editor ok');
