const NotesSpreadsheet = (() => {
  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function safeParseJson(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('{')) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof RangeError) return null;
      return null;
    }
  }

  function isPayload(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('{')) return false;
    if (typeof NotesSearch !== 'undefined' && NotesSearch.looksLikeSpreadsheetPayload) {
      return NotesSearch.looksLikeSpreadsheetPayload(raw);
    }
    const data = safeParseJson(raw);
    return !!(data && (data.activeSheet || (Array.isArray(data.sheets) && data.sheets.length)));
  }

  function cellValue(cell) {
    if (cell == null) return '';
    if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
      return String(cell);
    }
    if (typeof cell === 'object') {
      if (cell.value != null) return String(cell.value);
      if (cell.v != null) return String(cell.v);
      if (cell.text != null) return String(cell.text);
    }
    return '';
  }

  function normalizeRow(row) {
    if (Array.isArray(row)) return row.map(cellValue);
    if (!row || typeof row !== 'object') return [];
    const cells = Array.isArray(row.cells) ? row.cells : [];
    if (!cells.length) return [];
    const sorted = [...cells].sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
    const max = sorted.reduce((m, c) => Math.max(m, Number(c?.index) || 0), sorted.length - 1);
    const out = new Array(max + 1).fill('');
    sorted.forEach((cell, i) => {
      const at = Number.isFinite(Number(cell?.index)) ? Number(cell.index) : i;
      out[at] = cellValue(cell);
    });
    return out;
  }

  function sheetMatrix(sheet) {
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    return rows.map(normalizeRow).filter((row) => row.some((cell) => String(cell).trim()));
  }

  function pickSheet(data) {
    if (!data || typeof data !== 'object') return { name: '', matrix: [] };
    const sheets = Array.isArray(data.sheets) ? data.sheets : [];
    const active = data.activeSheet || sheets[0]?.name || '';
    const sheet = sheets.find((s) => s.name === active) || sheets[0] || { rows: [] };
    return { name: sheet.name || active || 'Sheet', matrix: sheetMatrix(sheet) };
  }

  function renderGrid(data, { maxRows = 80, maxCols = 24 } = {}) {
    const { name, matrix } = pickSheet(data);
    if (!matrix.length) {
      return `<p class="muted spreadsheet-empty">No rows in this spreadsheet.</p>`;
    }
    const cols = Math.min(
      maxCols,
      matrix.reduce((m, row) => Math.max(m, row.length), 0),
    );
    const rows = matrix.slice(0, maxRows);
    const head = rows[0] || [];
    const body = rows.slice(1);
    const th = head.slice(0, cols).map((cell) => `<th>${escapeHtml(cell)}</th>`).join('');
    const tr = body.map((row) => {
      const cells = row.slice(0, cols).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    const more = matrix.length > maxRows
      ? `<p class="muted spreadsheet-more">${matrix.length - maxRows} more row${matrix.length - maxRows === 1 ? '' : 's'} not shown.</p>`
      : '';
    return `<div class="spreadsheet-preview" data-sheet="${escapeHtml(name)}">
      <div class="spreadsheet-preview-head"><strong>${escapeHtml(name)}</strong></div>
      <div class="spreadsheet-scroll"><table class="spreadsheet-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>
      ${more}
    </div>`;
  }

  function prettyJson(text) {
    const data = safeParseJson(text);
    if (!data) {
      const raw = String(text || '').trim();
      return `<pre class="spreadsheet-json-fallback">${escapeHtml(raw.slice(0, 120000))}</pre>`;
    }
    let formatted = '';
    try {
      formatted = JSON.stringify(data, null, 2);
    } catch (_) {
      formatted = String(text || '');
    }
    if (formatted.length > 120000) {
      formatted = `${formatted.slice(0, 120000)}\n…`;
    }
    return `<pre class="spreadsheet-json">${escapeHtml(formatted)}</pre>`;
  }

  function renderPreview(text, { source = false, query = '' } = {}) {
    const raw = String(text || '').trim();
    if (!raw) return '<p class="muted">Empty spreadsheet.</p>';
    const data = safeParseJson(raw);
    if (!data) {
      return `<div class="spreadsheet-preview spreadsheet-preview-fallback">${prettyJson(raw)}</div>`;
    }
    const grid = renderGrid(data);
    const sourceBlock = source
      ? `<details class="spreadsheet-source" open><summary>Source JSON</summary>${prettyJson(raw)}</details>`
      : `<details class="spreadsheet-source"><summary>View source</summary>${prettyJson(raw)}</details>`;
    return `<div class="spreadsheet-wrap">${grid}${sourceBlock}</div>`;
  }

  return {
    isPayload,
    safeParseJson,
    renderPreview,
    renderGrid,
    prettyJson,
    pickSheet,
  };
})();

if (typeof window !== 'undefined') window.NotesSpreadsheet = NotesSpreadsheet;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesSpreadsheet;
