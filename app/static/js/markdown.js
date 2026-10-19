(() => {
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\](.*)$/;

  function toggleTaskAt(md, index) {
    let seen = 0;
    return String(md || '')
      .split('\n')
      .map((line) => {
        const match = line.match(TASK_RE);
        if (!match) return line;
        if (seen !== index) {
          seen += 1;
          return line;
        }
        seen += 1;
        const next = match[2] === ' ' ? 'x' : ' ';
        return `${match[1]}[${next}]${match[3]}`;
      })
      .join('\n');
  }

  function highlightFence(code, lang) {
    const source = String(code || '').replace(/\n$/, '');
    if (typeof window !== 'undefined' && window.NotesMarkdownHighlight) {
      return window.NotesMarkdownHighlight(source, lang);
    }
    return escapeHtml(source);
  }

  function applyUnderscoreEmphasis(html) {
    const codes = [];
    let out = String(html || '').replace(/`[^`\n]+`/g, (match) => {
      codes.push(match);
      return `@@UCODE${codes.length - 1}@@`;
    });
    out = out.replace(/(^|[^\w])__(?!_)([\s\S]+?)__(?!\w)/g, '$1<strong>$2</strong>');
    out = out.replace(/(^|[^\w])_(?!_)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    return out.replace(/@@UCODE(\d+)@@/g, (_, i) => codes[Number(i)] || '');
  }

  function splitTableCells(line) {
    const raw = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    return raw.split('|').map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    const cells = splitTableCells(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isTableRowLine(line) {
    const value = String(line || '').trim();
    return value.includes('|') && !/^@@(?:FENCE|TABLE)\d+@@$/.test(value);
  }

  function extractTables(source) {
    const tables = [];
    const lines = String(source || '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (
        i + 1 < lines.length
        && isTableRowLine(lines[i])
        && isTableSeparator(lines[i + 1])
      ) {
        const header = splitTableCells(lines[i]);
        const seps = splitTableCells(lines[i + 1]);
        if (header.length && seps.length === header.length) {
          const aligns = seps.map((cell) => {
            const left = cell.startsWith(':');
            const right = cell.endsWith(':');
            if (left && right) return 'center';
            if (right) return 'right';
            if (left) return 'left';
            return '';
          });
          const rows = [];
          i += 2;
          while (i < lines.length && isTableRowLine(lines[i]) && !isTableSeparator(lines[i])) {
            const cells = splitTableCells(lines[i]);
            rows.push(header.map((_, idx) => cells[idx] || ''));
            i += 1;
          }
          tables.push({ header, aligns, rows });
          out.push(`@@TABLE${tables.length - 1}@@`);
          continue;
        }
      }
      out.push(lines[i]);
      i += 1;
    }
    return { text: out.join('\n'), tables };
  }

  function renderInlineCell(text) {
    let html = escapeHtml(text);
    html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (full, label, href) => {
      const raw = href.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      if (/^(https?:\/\/|mailto:)/i.test(raw)) {
        return `<a href="${escapeAttr(raw)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
      }
      const hash = safeHashHref(raw);
      if (hash) return `<a href="${escapeAttr(hash)}">${label}</a>`;
      return full;
    });
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
    html = applyUnderscoreEmphasis(html);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    return html;
  }

  function renderTable(table) {
    const alignAttr = (idx) => {
      const align = table.aligns[idx] || '';
      return align ? ` style="text-align:${align}"` : '';
    };
    const head = table.header.map((cell, idx) => (
      `<th${alignAttr(idx)}>${renderInlineCell(cell)}</th>`
    )).join('');
    const body = table.rows.map((row) => (
      `<tr>${row.map((cell, idx) => `<td${alignAttr(idx)}>${renderInlineCell(cell)}</td>`).join('')}</tr>`
    )).join('');
    return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function render(md) {
    const fences = [];
    let text = String(md || '').replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, info, code) => {
      fences.push({ lang: String(info || '').trim().split(/\s+/)[0] || '', code });
      return `@@FENCE${fences.length - 1}@@`;
    });
    const extracted = extractTables(text);
    text = extracted.text;
    const tables = extracted.tables;
    let html = escapeHtml(text);
    html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (full, label, href) => {
      const raw = href.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      if (/^(https?:\/\/|mailto:)/i.test(raw)) {
        return `<a href="${escapeAttr(raw)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
      }
      const hash = safeHashHref(raw);
      if (hash) return `<a href="${escapeAttr(hash)}">${label}</a>`;
      return full;
    });
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
    html = applyUnderscoreEmphasis(html);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^\s*[-*] \[([ xX])\] (.*)$/gm, (_, checked, label) => {
      const on = checked !== ' ';
      return `<li class="task${on ? ' done' : ''}"><button type="button" class="task-toggle" data-checked="${on ? '1' : '0'}" aria-checked="${on}">${on ? '☑' : '☐'}</button> ${label}</li>`;
    });
    html = html.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li[\s\S]*?<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
    html = html.replace(/@@FENCE(\d+)@@/g, (_, i) => {
      const fence = fences[Number(i)] || { lang: '', code: '' };
      const lang = fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : '';
      const body = highlightFence(fence.code, fence.lang);
      return `<pre class="code-preview"${fence.lang ? ` data-lang="${escapeHtml(fence.lang)}"` : ''}><code${lang}>${body}</code></pre>`;
    });
    html = html.replace(/@@TABLE(\d+)@@/g, (_, i) => renderTable(tables[Number(i)] || { header: [], aligns: [], rows: [] }));
    html = autolinkOutsideTags(html);
    return wrapMarkdownBlocks(html);
  }

  function safeHashHref(raw) {
    const href = String(raw || '').trim();
    if (!href.startsWith('#') || href.length < 2) return '';
    if (/[\s<>"']/.test(href) || href.includes(':')) return '';
    return href;
  }

  function safeAutolinkHref(raw) {
    const href = String(raw || '').replace(/&amp;/g, '&').trim();
    if (!/^(https?:\/\/|mailto:)/i.test(href)) return '';
    if (/[\s<>"]/.test(href)) return '';
    return href;
  }

  function autolinkAnchor(href) {
    const safe = safeAutolinkHref(href);
    if (!safe) return '';
    return `<a href="${escapeAttr(safe)}" rel="noopener noreferrer" target="_blank">${escapeHtml(safe)}</a>`;
  }

  function linkifyPlain(text) {
    const chunks = String(text || '').split(/(&lt;(?:https?:\/\/|mailto:)[^&\s]+&gt;)/gi);
    return chunks.map((chunk, index) => {
      if (index % 2 === 1) {
        const raw = chunk.slice(4, -4);
        return autolinkAnchor(raw) || chunk;
      }
      return chunk.replace(/(^|[\s(])((?:https?:\/\/|mailto:)[^\s<]+)/gi, (full, lead, url) => {
        const trimmed = url.replace(/[.,;:!?)]+$/, '');
        const anchor = autolinkAnchor(trimmed);
        if (!anchor) return full;
        return `${lead}${anchor}${url.slice(trimmed.length)}`;
      });
    }).join('');
  }

  function autolinkOutsideTags(html) {
    const parts = String(html || '').split(/(<[^>]+>)/g);
    let skip = 0;
    return parts.map((part) => {
      if (part.startsWith('<')) {
        const name = part.slice(1).trim();
        if (/^\/(code|pre|a)\b/i.test(name)) skip = Math.max(0, skip - 1);
        else if (/^(code|pre|a)\b/i.test(name) && !/\/\s*>$/.test(part)) skip += 1;
        return part;
      }
      if (skip) return part;
      return linkifyPlain(part);
    }).join('');
  }

  function wrapMarkdownBlocks(html) {
    const parts = [];
    const blockRe = /(<(?:h\d|ul|ol|pre|blockquote|div)\b[\s\S]*?<\/(?:h\d|ul|ol|pre|blockquote|div)>)/ig;
    // Keep blank-line runs so "a\n\n\nb" still has visible spacing in Preview.
    const chunks = String(html || '').split(/(\n{2,})/);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (!chunk) continue;
      if (/^\n+$/.test(chunk)) {
        // "\n\n" is a normal paragraph break; each extra newline is another
        // blank line the Preview should keep as <p><br></p>.
        const blankParas = Math.max(0, chunk.length - 2);
        for (let n = 0; n < blankParas; n += 1) parts.push('<p><br></p>');
        continue;
      }
      const trimmed = chunk.replace(/^\n+|\n+$/g, '');
      if (!trimmed) continue;
      trimmed.split(blockRe).forEach((piece) => {
        const bit = piece.trim();
        if (!bit) return;
        if (/^<(?:h\d|ul|ol|pre|blockquote|div)\b/i.test(bit)) parts.push(bit);
        else parts.push(`<p>${bit.replace(/\n/g, '<br>')}</p>`);
      });
    }
    return parts.join('');
  }

  const api = { render, toggleTaskAt };
  if (typeof window !== 'undefined') window.NotesMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
