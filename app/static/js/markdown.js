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

  function applyEmphasisOutsideTags(html, replacer) {
    const parts = String(html || '').split(/(<[^>]+>)/g);
    return parts.map((part) => (part.startsWith('<') ? part : replacer(part))).join('');
  }

  function applyUnderscoreEmphasis(html) {
    const codes = [];
    let out = String(html || '').replace(/`[^`\n]+`/g, (match) => {
      codes.push(match);
      return `@@UCODE${codes.length - 1}@@`;
    });
    // Emphasis must not rewrite inside HTML tags/attributes (L1).
    out = applyEmphasisOutsideTags(out, (text) => (
      text
        .replace(/(^|[^\w])__(?!_)([\s\S]+?)__(?!\w)/g, '$1<strong>$2</strong>')
        .replace(/(^|[^\w])_(?!_)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
    ));
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
    html = applyEmphasisOutsideTags(html, (text) => (
      text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    ));
    html = applyUnderscoreEmphasis(html);
    html = applyEmphasisOutsideTags(html, (text) => text.replace(/`([^`]+)`/g, '<code>$1</code>'));
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
    html = applyEmphasisOutsideTags(html, (text) => (
      text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    ));
    html = applyUnderscoreEmphasis(html);
    html = applyEmphasisOutsideTags(html, (text) => text.replace(/`([^`]+)`/g, '<code>$1</code>'));
    html = html.replace(/^\s*[-*] \[([ xX])\] (.*)$/gm, (_, checked, label) => {
      const on = checked !== ' ';
      return `<li class="task${on ? ' done' : ''}"><button type="button" class="task-toggle" data-checked="${on ? '1' : '0'}" aria-checked="${on}">${on ? '☑' : '☐'}</button> ${label}</li>`;
    });
    html = html.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li[\s\S]*?<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
    html = html.replace(/@@FENCE(\d+)@@/g, (_, i) => {
      const fence = fences[Number(i)] || { lang: '', code: '' };
      const safeLang = escapeAttr(fence.lang);
      const lang = fence.lang ? ` class="language-${safeLang}"` : '';
      const body = highlightFence(fence.code, fence.lang);
      return `<pre class="code-preview"${fence.lang ? ` data-lang="${safeLang}"` : ''}><code${lang}>${body}</code></pre>`;
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

  // --- Safe rich rendering (docs/design/rich-editor.md, milestone 1) -------------------------
  // markdown-it (vendored, html:false) turns Markdown into HTML; raw HTML in the note is shown as
  // text. Links/images go through a scheme allowlist here, and the caller always runs the
  // result through NotesSanitize.sanitizeRichHtml (DOMPurify) before it reaches the DOM.
  const RICH_MAX_CHARS = 500000;
  const RICH_MAX_LINES = 20000;

  function urlPolicy() {
    if (typeof window !== 'undefined' && window.NotesSanitize) return window.NotesSanitize;
    if (typeof require === 'function') {
      try { return require('./sanitize.js'); } catch (_) { /* browser */ }
    }
    return null;
  }

  function markdownItFactory() {
    if (typeof window !== 'undefined' && typeof window.markdownit === 'function') return window.markdownit;
    if (typeof require === 'function') {
      try { return require('./vendor/markdown-it/markdown-it.min.js'); } catch (_) { /* browser */ }
    }
    return null;
  }

  function taskLineIndexes(source) {
    const byLine = new Map();
    let seen = 0;
    String(source || '').split('\n').forEach((line, idx) => {
      if (TASK_RE.test(line)) {
        byLine.set(idx, seen);
        seen += 1;
      }
    });
    return byLine;
  }

  function richTaskRule(state) {
    const taskLines = taskLineIndexes(state.src);
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const item = tokens[i];
      if (item.type !== 'list_item_open' || !item.map || !taskLines.has(item.map[0])) continue;
      const inline = tokens[i + 2];
      if (!inline || inline.type !== 'inline' || !inline.children?.length) continue;
      const first = inline.children[0];
      const match = first.type === 'text' && /^\[([ xX])\]\s?/.exec(first.content);
      if (!match) continue;
      const on = match[1] !== ' ';
      first.content = first.content.slice(match[0].length);
      const toggle = new state.Token('dg_task_toggle', '', 0);
      toggle.meta = { on };
      inline.children.unshift(toggle);
      item.attrJoin('class', on ? 'task done' : 'task');
    }
  }

  let richEngine = null;
  function richMarkdown() {
    if (richEngine) return richEngine;
    const factory = markdownItFactory();
    const policy = urlPolicy();
    if (!factory || !policy) return null;
    const md = factory('default', {
      html: false,
      linkify: true,
      breaks: true,
      typographer: false,
      maxNesting: 50,
    });
    md.validateLink = (url) => !!(policy.safeRichHref(url) || policy.safeRichImageSrc(url));
    md.core.ruler.push('dg_tasks', richTaskRule);
    md.renderer.rules.dg_task_toggle = (tokens, idx) => {
      const on = !!tokens[idx].meta?.on;
      return `<button type="button" class="task-toggle" data-checked="${on ? '1' : '0'}" aria-checked="${on}">${on ? '☑' : '☐'}</button> `;
    };
    const defaultLinkOpen = md.renderer.rules.link_open
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const href = policy.safeRichHref(token.attrGet('href') || '');
      token.attrs = (token.attrs || []).filter(([name]) => name === 'title');
      if (href) {
        token.attrSet('href', href);
        if (!href.startsWith('#')) {
          token.attrSet('rel', 'noopener noreferrer');
          token.attrSet('target', '_blank');
        }
      }
      return defaultLinkOpen(tokens, idx, options, env, self);
    };
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const alt = self.renderInlineAsText(token.children || [], options, env);
      const rawSrc = token.attrGet('src') || '';
      const src = policy.safeRichImageSrc(rawSrc);
      if (src) {
        const title = token.attrGet('title');
        return `<img src="${md.utils.escapeHtml(src)}" alt="${md.utils.escapeHtml(alt)}"${title ? ` title="${md.utils.escapeHtml(title)}"` : ''}>`;
      }
      // Never fetch external images (no tracking pixels): show a plain link or the alt text.
      const href = policy.safeRichHref(rawSrc);
      const label = md.utils.escapeHtml(alt || rawSrc);
      if (href && !href.startsWith('#')) {
        return `<a href="${md.utils.escapeHtml(href)}" class="md-ext-image" rel="noopener noreferrer" target="_blank">${label}</a>`;
      }
      return label;
    };
    const alignCell = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const style = token.attrGet('style') || '';
      token.attrs = (token.attrs || []).filter(([name]) => name !== 'style');
      const align = /text-align:(left|center|right)/.exec(style);
      if (align) token.attrJoin('class', `md-align-${align[1]}`);
      return self.renderToken(tokens, idx, options);
    };
    md.renderer.rules.th_open = alignCell;
    md.renderer.rules.td_open = alignCell;
    md.renderer.rules.fence = (tokens, idx) => {
      const token = tokens[idx];
      const lang = String(token.info || '').trim().split(/\s+/)[0].toLowerCase();
      const safeLang = /^[a-z0-9+#-]{1,32}$/.test(lang) ? lang : '';
      return `<pre class="code-preview"${safeLang ? ` data-lang="${safeLang}"` : ''}><code${safeLang ? ` class="language-${safeLang}"` : ''}>${highlightFence(token.content, safeLang)}</code></pre>\n`;
    };
    md.renderer.rules.code_block = (tokens, idx) => (
      `<pre class="code-preview"><code>${highlightFence(tokens[idx].content, '')}</code></pre>\n`
    );
    const defaultTableOpen = md.renderer.rules.table_open
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    const defaultTableClose = md.renderer.rules.table_close
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.table_open = (...args) => `<div class="md-table-wrap">${defaultTableOpen(...args)}`;
    md.renderer.rules.table_close = (...args) => `${defaultTableClose(...args)}</div>`;
    richEngine = md;
    return md;
  }

  function plainTextHtml(md) {
    return `<p class="md-plain-fallback">${escapeHtml(md).replace(/\n/g, '<br>')}</p>`;
  }

  // Returns HTML that still MUST go through NotesSanitize.sanitizeRichHtml before the DOM.
  function renderRich(md) {
    const source = String(md || '');
    const engine = richMarkdown();
    if (!engine) return render(source);
    if (source.length > RICH_MAX_CHARS || source.split('\n', RICH_MAX_LINES + 1).length > RICH_MAX_LINES) {
      return plainTextHtml(source);
    }
    try {
      return engine.render(source);
    } catch (_) {
      return plainTextHtml(source);
    }
  }

  const api = { render, renderRich, toggleTaskAt };
  if (typeof window !== 'undefined') window.NotesMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
