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

  function render(md) {
    const fences = [];
    let text = String(md || '').replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, info, code) => {
      fences.push({ lang: String(info || '').trim().split(/\s+/)[0] || '', code });
      return `@@FENCE${fences.length - 1}@@`;
    });
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
    const blockRe = /(<(?:h\d|ul|ol|pre|blockquote)\b[\s\S]*?<\/(?:h\d|ul|ol|pre|blockquote)>)/ig;
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
        if (/^<(?:h\d|ul|ol|pre|blockquote)\b/i.test(bit)) parts.push(bit);
        else parts.push(`<p>${bit.replace(/\n/g, '<br>')}</p>`);
      });
    }
    return parts.join('');
  }

  const api = { render, toggleTaskAt };
  if (typeof window !== 'undefined') window.NotesMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
