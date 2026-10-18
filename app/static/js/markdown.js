(() => {
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
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

  function render(md) {
    const fences = [];
    let text = String(md || '').replace(/```([\s\S]*?)```/g, (_, code) => {
      fences.push(code);
      return `@@FENCE${fences.length - 1}@@`;
    });
    let html = escapeHtml(text);
    html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (full, label, href) => {
      const raw = href.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      if (!/^(https?:\/\/|mailto:)/i.test(raw)) return full;
      return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`;
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
    html = html.replace(/@@FENCE(\d+)@@/g, (_, i) => `<pre><code>${escapeHtml(fences[Number(i)])}</code></pre>`);
    return wrapMarkdownBlocks(html);
  }

  function wrapMarkdownBlocks(html) {
    const parts = [];
    const blockRe = /(<(?:h\d|ul|ol|pre|blockquote)\b[\s\S]*?<\/(?:h\d|ul|ol|pre|blockquote)>)/ig;
    String(html || '').split(/\n\n+/).forEach((block) => {
      const trimmed = block.replace(/^\n+|\n+$/g, '').trim();
      if (!trimmed) return;
      trimmed.split(blockRe).forEach((chunk) => {
        const bit = chunk.trim();
        if (!bit) return;
        if (/^<(?:h\d|ul|ol|pre|blockquote)\b/i.test(bit)) parts.push(bit);
        else parts.push(`<p>${bit.replace(/\n/g, '<br>')}</p>`);
      });
    });
    return parts.join('');
  }

  const api = { render, toggleTaskAt };
  if (typeof window !== 'undefined') window.NotesMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
