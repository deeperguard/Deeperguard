// GFM pipe tables in the Markdown source: find, parse, edit and write back
// (docs/design/rich-editor.md, 1.3 and milestone 3).
//
// Cell text in the editor is the cell's inline Markdown with only the table-level escape removed:
// GFM (and markdown-it) drop the one backslash in front of every "|" in a cell before the cell is
// parsed as inline Markdown. So unescapeCell strips exactly that backslash and escapeCell adds it
// back in front of every "|"; every other backslash (\*, \_, \\, ...) is left as it is. The two are
// exact inverses, so an edited cell keeps its meaning.
//
// Round-trip: a table that was not changed is written back as its original text, byte for byte.
// After a change only the changed lines are rewritten, unless the table was column-aligned (then the
// whole table is re-aligned) or columns changed (then every line changes anyway).
(() => {
  const DELIM_CELL_RE = /^:?-+:?$/;
  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
  // Lines that start another block end a table (blank lines are checked separately).
  const BLOCK_START_RE = /^ {0,3}(?:>|#{1,6}(?:\s|$)|`{3,}|~{3,}|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|(?:[-*_][ \t]*){3,}$)/;
  const ALIGNS = ['', 'left', 'center', 'right'];

  function unescapeCell(raw) {
    return String(raw ?? '').replace(/\\\|/g, '|');
  }

  function escapeCell(text) {
    return String(text ?? '').replace(/[\r\n]+/g, ' ').trim().replace(/\|/g, '\\|');
  }

  // Split one table line into trimmed raw cells, like markdown-it: a "|" right after a "\" does not
  // split; one leading and one trailing (unescaped) "|" are optional.
  function splitRow(line) {
    let text = String(line ?? '').trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
    const cells = [];
    let current = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '|' && text[i - 1] !== '\\') {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function indentOf(line) {
    return /^[ \t]*/.exec(line)[0];
  }

  function shallow(line) {
    const indent = indentOf(line);
    return !indent.includes('\t') && indent.length <= 3;
  }

  function isDelimiterLine(line) {
    const text = String(line ?? '').trim();
    if (!text || !/^[|:-]/.test(text) || !shallow(line)) return false;
    return splitRow(text).every((cell) => DELIM_CELL_RE.test(cell));
  }

  function alignOf(cell) {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  // Every top-level pipe table in `source` as { start, end } offsets (end excludes the line break).
  // Tables inside fenced code blocks are skipped.
  function findTables(source) {
    const text = String(source ?? '');
    const lines = [];
    let pos = 0;
    text.split('\n').forEach((raw) => {
      const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      lines.push({ text: body, start: pos, end: pos + body.length });
      pos += raw.length + 1;
    });
    const found = [];
    let fence = null;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].text;
      const fenceMatch = FENCE_RE.exec(line);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length
          && !line.trim().slice(fenceMatch[1].length).trim()) fence = null;
        i += 1;
        continue;
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        i += 1;
        continue;
      }
      const next = lines[i + 1];
      if (next && line.includes('|') && shallow(line) && isDelimiterLine(next.text)
        && splitRow(line).length === splitRow(next.text).length) {
        let last = i + 1;
        while (last + 1 < lines.length) {
          const row = lines[last + 1].text;
          if (!row.trim() || BLOCK_START_RE.test(row)) break;
          last += 1;
        }
        found.push({ start: lines[i].start, end: lines[last].end });
        i = last + 1;
        continue;
      }
      i += 1;
    }
    return found;
  }

  function tableAt(source, offset) {
    return findTables(source).find((t) => offset >= t.start && offset <= t.end) || null;
  }

  // Table text (as found by findTables) -> editable model. Cells hold editor text (unescaped).
  function parseTable(text) {
    const source = String(text ?? '');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/);
    const header = splitRow(lines[0]).map(unescapeCell);
    const cols = header.length;
    const aligns = splitRow(lines[1]).map(alignOf);
    const rows = lines.slice(2).map((raw) => {
      const cells = splitRow(raw).map(unescapeCell).slice(0, cols);
      while (cells.length < cols) cells.push('');
      return { cells, raw, dirty: false };
    });
    // Column-aligned: every line has its "|" at the same places and some cell is padded with spaces.
    const pipes = (line) => [...line.matchAll(/(?<!\\)\|/g)].map((hit) => hit.index).join(',');
    const pretty = lines.every((l) => pipes(l) === pipes(lines[0])) && lines.some((l) => /\S {2,}\|/.test(l));
    return {
      source,
      eol,
      indent: indentOf(lines[0]),
      pretty,
      header: { cells: header, raw: lines[0], dirty: false },
      aligns,
      delimRaw: lines[1],
      delimDirty: false,
      columnsChanged: false,
      rowsChanged: false,
      rows,
    };
  }

  function changed(model) {
    return model.columnsChanged || model.delimDirty || model.rowsChanged
      || model.header.dirty || model.rows.some((r) => r.dirty);
  }

  function minWidth(align) {
    if (align === 'center') return 5;
    return align ? 4 : 3;
  }

  // width 0: compact table, so the usual "---" / ":---" / ":---:" / "---:".
  function delimCell(align, width) {
    const dashes = Math.max(3, width - (align === 'center' ? 2 : align ? 1 : 0));
    if (align === 'center') return `:${'-'.repeat(dashes)}:`;
    if (align === 'left') return `:${'-'.repeat(dashes)}`;
    if (align === 'right') return `${'-'.repeat(dashes)}:`;
    return '-'.repeat(dashes);
  }

  function serializeTable(model) {
    if (!changed(model)) return model.source;
    const all = [model.header, ...model.rows];
    const escaped = all.map((row) => row.cells.map(escapeCell));
    const realign = model.pretty;
    const widths = model.aligns.map((align, c) => (
      realign ? Math.max(minWidth(align), ...escaped.map((cells) => cells[c].length)) : 0
    ));
    const line = (cells) => `${model.indent}|${cells.map((cell, c) => (
      cell || widths[c] ? ` ${cell.padEnd(widths[c])} ` : ' '
    )).join('|')}|`;
    const regenerateAll = realign || model.columnsChanged;
    const out = [];
    out.push(regenerateAll || model.header.dirty ? line(escaped[0]) : model.header.raw);
    out.push(regenerateAll || model.delimDirty
      ? line(model.aligns.map((align, c) => delimCell(align, widths[c])))
      : model.delimRaw);
    model.rows.forEach((row, idx) => {
      out.push(regenerateAll || row.dirty ? line(escaped[idx + 1]) : row.raw);
    });
    return out.join(model.eol);
  }

  function columnCount(model) {
    return model.header.cells.length;
  }

  // row 0 is the header, rows 1..n are the body rows.
  function rowAt(model, row) {
    return row === 0 ? model.header : model.rows[row - 1];
  }

  function setCell(model, row, col, text) {
    const target = rowAt(model, row);
    if (!target || col < 0 || col >= columnCount(model)) return false;
    const value = String(text ?? '').replace(/[\r\n]+/g, ' ');
    if (target.cells[col] === value) return false;
    target.cells[col] = value;
    target.dirty = true;
    return true;
  }

  // Inserts an empty body row so that it becomes body row `at` (0-based, 0 = first body row).
  function insertRow(model, at) {
    const index = Math.max(0, Math.min(model.rows.length, at));
    model.rows.splice(index, 0, { cells: new Array(columnCount(model)).fill(''), raw: '', dirty: true });
    model.rowsChanged = true;
    return index;
  }

  function deleteRow(model, at) {
    if (at < 0 || at >= model.rows.length) return false;
    model.rows.splice(at, 1);
    model.rowsChanged = true;
    return true;
  }

  function insertColumn(model, at) {
    const index = Math.max(0, Math.min(columnCount(model), at));
    [model.header, ...model.rows].forEach((row) => row.cells.splice(index, 0, ''));
    model.aligns.splice(index, 0, '');
    model.columnsChanged = true;
    return index;
  }

  // A table keeps at least one column.
  function deleteColumn(model, at) {
    if (columnCount(model) <= 1 || at < 0 || at >= columnCount(model)) return false;
    [model.header, ...model.rows].forEach((row) => row.cells.splice(at, 1));
    model.aligns.splice(at, 1);
    model.columnsChanged = true;
    return true;
  }

  function setAlign(model, col, align) {
    if (!ALIGNS.includes(align) || col < 0 || col >= columnCount(model)) return false;
    if (model.aligns[col] === align) return false;
    model.aligns[col] = align;
    model.delimDirty = true;
    return true;
  }

  function newTableMarkdown(cols = 2, bodyRows = 2) {
    const header = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
    const line = (cells) => `| ${cells.join(' | ')} |`;
    const lines = [line(header), line(header.map(() => '---'))];
    for (let r = 0; r < bodyRows; r += 1) lines.push(`|${' |'.repeat(cols)}`);
    return lines.join('\n');
  }

  // Inserts a new table at `offset`, separated from surrounding text by blank lines.
  // Returns the new source and the range of the inserted table.
  function insertNewTable(source, offset, cols, bodyRows) {
    const text = String(source ?? '');
    const at = Math.max(0, Math.min(text.length, offset));
    const before = text.slice(0, at);
    const after = text.slice(at);
    const table = newTableMarkdown(cols, bodyRows);
    let lead = '';
    if (before && !before.endsWith('\n\n')) lead = before.endsWith('\n') ? '\n' : '\n\n';
    let trail = '\n';
    if (after.startsWith('\n\n')) trail = '';
    else if (after.startsWith('\n')) trail = '\n';
    else if (after) trail = '\n\n';
    const start = before.length + lead.length;
    return { source: `${before}${lead}${table}${trail}${after}`, start, end: start + table.length };
  }

  // --- Keyboard-accessible grid in the edit view -------------------------------------------------
  // Everything is built with DOM APIs and input values; cell text is never parsed as HTML here.
  function createController({ container, getSource, setSource, beforeChange, onClose }) {
    let state = null; // { model, start, end, noteId, row, col }
    let editingCell = null;

    function cellInputs() {
      return [...container.querySelectorAll('input[data-row]')];
    }

    function focusCell(row, col) {
      const input = container.querySelector(`input[data-row="${row}"][data-col="${col}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    }

    function write() {
      const source = getSource();
      const next = serializeTable(state.model);
      const current = source.slice(state.start, state.end);
      if (current === next) return;
      setSource(`${source.slice(0, state.start)}${next}${source.slice(state.end)}`);
      state.end = state.start + next.length;
    }

    // The note text changed outside the editor: stop instead of writing over it.
    function stale() {
      const source = getSource();
      return source.slice(state.start, state.end) !== serializeTable(state.model);
    }

    function button(label, action, extra = {}) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost sm';
      btn.dataset.tableAction = action;
      btn.textContent = label;
      if (extra.ariaLabel) btn.setAttribute('aria-label', extra.ariaLabel);
      if (extra.title) btn.title = extra.title;
      return btn;
    }

    function syncButtons() {
      const { model, row, col } = state;
      const align = model.aligns[col] || '';
      container.querySelectorAll('[data-table-action^="align-"]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.tableAction === `align-${align || 'none'}`));
      });
      const delRow = container.querySelector('[data-table-action="delete-row"]');
      if (delRow) delRow.disabled = row === 0;
      const rowAbove = container.querySelector('[data-table-action="row-above"]');
      if (rowAbove) rowAbove.disabled = row === 0;
      const delCol = container.querySelector('[data-table-action="delete-column"]');
      if (delCol) delCol.disabled = columnCount(model) <= 1;
      const status = container.querySelector('.table-editor-pos');
      if (status) status.textContent = row === 0 ? `Header, column ${col + 1}` : `Row ${row}, column ${col + 1}`;
    }

    function render() {
      const { model } = state;
      container.replaceChildren();
      const bar = document.createElement('div');
      bar.className = 'table-editor-bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Table');
      bar.append(
        button('+ Row above', 'row-above'),
        button('+ Row below', 'row-below'),
        button('− Row', 'delete-row', { ariaLabel: 'Delete row' }),
        button('+ Column left', 'column-left'),
        button('+ Column right', 'column-right'),
        button('− Column', 'delete-column', { ariaLabel: 'Delete column' }),
      );
      const aligns = document.createElement('span');
      aligns.className = 'table-editor-aligns';
      aligns.setAttribute('role', 'group');
      aligns.setAttribute('aria-label', 'Column alignment');
      aligns.append(
        button('Default', 'align-none', { ariaLabel: 'No alignment' }),
        button('Left', 'align-left', { ariaLabel: 'Align left' }),
        button('Center', 'align-center', { ariaLabel: 'Align center' }),
        button('Right', 'align-right', { ariaLabel: 'Align right' }),
      );
      bar.append(aligns, button('Done', 'done', { title: 'Close the table editor (Esc)' }));
      const pos = document.createElement('span');
      pos.className = 'table-editor-pos muted';
      pos.setAttribute('aria-live', 'polite');
      const wrap = document.createElement('div');
      wrap.className = 'table-editor-scroll';
      const table = document.createElement('table');
      table.className = 'table-editor-grid';
      const thead = document.createElement('thead');
      const tbody = document.createElement('tbody');
      [model.header, ...model.rows].forEach((row, r) => {
        const tr = document.createElement('tr');
        row.cells.forEach((value, c) => {
          const cell = document.createElement(r === 0 ? 'th' : 'td');
          if (r === 0) cell.scope = 'col';
          const align = model.aligns[c];
          if (align) cell.dataset.align = align;
          const input = document.createElement('input');
          input.type = 'text';
          input.value = value;
          input.dataset.row = String(r);
          input.dataset.col = String(c);
          input.autocomplete = 'off';
          input.spellcheck = true;
          input.dir = 'auto';
          input.setAttribute('aria-label', r === 0 ? `Header, column ${c + 1}` : `Row ${r}, column ${c + 1}`);
          cell.append(input);
          tr.append(cell);
        });
        (r === 0 ? thead : tbody).append(tr);
      });
      table.append(thead, tbody);
      wrap.append(table);
      container.append(bar, pos, wrap);
      syncButtons();
    }

    function structural(fn, focus) {
      if (stale()) {
        close();
        return;
      }
      beforeChange?.();
      fn();
      write();
      render();
      focusCell(focus().row, focus().col);
    }

    function run(action) {
      if (!state) return;
      const { model } = state;
      const { row, col } = state;
      if (action === 'done') {
        close({ focusSource: true });
        return;
      }
      if (action === 'row-above' || action === 'row-below') {
        const at = action === 'row-above' ? Math.max(0, row - 1) : row;
        structural(() => insertRow(model, at), () => ({ row: at + 1, col }));
      } else if (action === 'delete-row') {
        if (row === 0) return;
        structural(() => deleteRow(model, row - 1), () => ({ row: Math.min(row, model.rows.length), col }));
      } else if (action === 'column-left' || action === 'column-right') {
        const at = action === 'column-left' ? col : col + 1;
        structural(() => insertColumn(model, at), () => ({ row, col: at }));
      } else if (action === 'delete-column') {
        if (columnCount(model) <= 1) return;
        structural(() => deleteColumn(model, col), () => ({ row, col: Math.min(col, columnCount(model) - 1) }));
      } else if (action.startsWith('align-')) {
        const align = action === 'align-none' ? '' : action.slice('align-'.length);
        structural(() => setAlign(model, col, align), () => ({ row, col }));
      }
    }

    function onClick(event) {
      const btn = event.target.closest('[data-table-action]');
      if (btn && !btn.disabled) run(btn.dataset.tableAction);
    }

    function onFocusIn(event) {
      const input = event.target.closest('input[data-row]');
      if (!input || !state) return;
      state.row = Number(input.dataset.row);
      state.col = Number(input.dataset.col);
      syncButtons();
    }

    function onInput(event) {
      const input = event.target.closest('input[data-row]');
      if (!input || !state) return;
      if (stale()) {
        close();
        return;
      }
      if (editingCell !== input) {
        beforeChange?.();
        editingCell = input;
      }
      if (setCell(state.model, Number(input.dataset.row), Number(input.dataset.col), input.value)) write();
    }

    function onKeyDown(event) {
      if (!state) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close({ focusSource: true });
        return;
      }
      const input = event.target.closest('input[data-row]');
      if (!input) return;
      const inputs = cellInputs();
      const index = inputs.indexOf(input);
      const cols = columnCount(state.model);
      let target = null;
      if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        // Past the first/last cell the browser's own Tab order takes over (no keyboard trap).
        target = inputs[index + (event.shiftKey ? -1 : 1)] || null;
      } else if (event.key === 'ArrowDown' || (event.key === 'Enter' && !event.shiftKey)) {
        target = inputs[index + cols] || null;
      } else if (event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey)) {
        target = inputs[index - cols] || null;
      }
      if (event.key === 'Enter') event.preventDefault();
      if (!target) return;
      event.preventDefault();
      editingCell = null;
      target.focus();
      target.select();
    }

    container.addEventListener('click', onClick);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('input', onInput);
    container.addEventListener('keydown', onKeyDown);

    function openRange(range, noteId, focus) {
      const source = getSource();
      state = {
        model: parseTable(source.slice(range.start, range.end)),
        start: range.start,
        end: range.end,
        noteId,
        row: 0,
        col: 0,
      };
      editingCell = null;
      render();
      container.hidden = false;
      focusCell(focus?.row ?? 0, focus?.col ?? 0);
    }

    // Opens the table under `offset`; returns false when there is none.
    function openAt(offset, noteId) {
      const range = tableAt(getSource(), offset);
      if (!range) return false;
      openRange(range, noteId);
      return true;
    }

    // Inserts a new table at `offset` (one undo step) and opens it with the first header cell focused.
    function insertAt(offset, noteId) {
      beforeChange?.();
      const inserted = insertNewTable(getSource(), offset);
      setSource(inserted.source);
      openRange(inserted, noteId);
    }

    function close({ focusSource = false } = {}) {
      if (!state) return;
      const end = state.end;
      state = null;
      editingCell = null;
      container.hidden = true;
      container.replaceChildren();
      onClose?.({ focusSource, offset: end });
    }

    return {
      openAt,
      insertAt,
      close,
      isOpen: () => !!state,
      noteId: () => state?.noteId ?? null,
    };
  }

  const api = {
    unescapeCell,
    escapeCell,
    splitRow,
    findTables,
    tableAt,
    parseTable,
    serializeTable,
    setCell,
    insertRow,
    deleteRow,
    insertColumn,
    deleteColumn,
    setAlign,
    newTableMarkdown,
    insertNewTable,
    createController,
  };
  if (typeof window !== 'undefined') window.NotesTableEditor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
