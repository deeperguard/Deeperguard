(() => {
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\](.*)$/;
  const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const ANGLE_LINK_RE = /<(https?:\/\/[^>\s]+)>/g;

  function safeHref(raw) {
    const href = String(raw || '').trim();
    if (/^#/.test(href)) return href;
    if (/^https?:\/\//i.test(href)) return href;
    if (/^mailto:/i.test(href)) return href;
    if (/^www\./i.test(href)) return `https://${href}`;
    if (href && !/[\s<>"']/.test(href)) {
      const nav = (typeof globalThis !== 'undefined' && globalThis.NotesInDocNav)
        || (typeof window !== 'undefined' && window.NotesInDocNav);
      const slug = nav?.slugify ? nav.slugify(href.replace(/^#/, '')) : href.toLowerCase().replace(/\s+/g, '-');
      return `#${slug}`;
    }
    return '';
  }

  function trimUrl(url) {
    return String(url || '').replace(/[.,;:!?)\\]"'\]>]+$/, '');
  }

  function findHttpUrls(text) {
    const urls = [];
    const src = String(text || '');
    const re = /https?:\/\//gi;
    let m = re.exec(src);
    while (m) {
      let end = m.index + m[0].length;
      while (end < src.length && !/[\s>]/.test(src[end])) end += 1;
      const raw = trimUrl(src.slice(m.index, end));
      if (raw.length > 8) {
        urls.push({ start: m.index, end: m.index + raw.length, url: raw });
      }
      re.lastIndex = m.index + Math.max(raw.length, 1);
      m = re.exec(src);
    }
    return urls;
  }

  function findWwwUrls(text) {
    const urls = [];
    const src = String(text || '');
    const re = /\bwww\.[^\s<>"']+/gi;
    let m = re.exec(src);
    while (m) {
      const raw = trimUrl(m[0]);
      urls.push({ start: m.index, end: m.index + raw.length, url: raw, www: true });
      m = re.exec(src);
    }
    return urls;
  }

  function parseMarkdownLink(text, fromIndex) {
    const start = text.indexOf('[', fromIndex);
    if (start === -1) return null;
    const mid = text.indexOf('](', start + 1);
    if (mid === -1) return null;
    const label = text.slice(start + 1, mid);
    const open = mid + 1;
    if (text[open] !== '(') return null;
    let depth = 1;
    let i = open + 1;
    const hrefStart = i;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    if (depth !== 0) return null;
    const href = text.slice(hrefStart, i - 1);
    return { start, end: i, label, href };
  }

  function stripMarkdownLinksToUrls(text) {
    let out = String(text || '');
    let guard = 0;
    while (guard < 200) {
      guard += 1;
      const link = parseMarkdownLink(out, 0);
      if (!link) break;
      const href = trimUrl(link.href);
      out = out.slice(0, link.start) + href + out.slice(link.end);
    }
    return out.replace(ANGLE_LINK_RE, '$1');
  }

  function repairBrokenLinks(text) {
    let out = String(text || '');
    out = out.replace(/\[https?:\/\/\[(www\.[^\]\s]+)\]\(https:\/\/\1\)/gi, 'https://$1');
    out = out.replace(/\[https?:\/\/\[(www\.[^\]\s]+)\]\(https:\/\/\1\)([^\]\s]*)/gi, 'https://$1$2');
    out = out.replace(/\)\]\(\s*(https?:\/\/[^\s]+)\s*\)/g, '$1');
    out = out.replace(/([\w=&._-]{8,})\]\(\s*(https?:\/\/[^\s]+)\s*\)/g, '$2');
    out = out.replace(/(?<!\])\(\s*(https?:\/\/[^()\s]+)\s*\)/g, '$1');
    out = out.split('\n').map((line) => {
      let row = line.trim();
      if (/^\[[^\]]+\]\(/.test(row) || /^<https?:\/\//.test(row)) return row;
      if (/https?:\/\//.test(row) && !/\]\(https?:\/\//.test(row)) {
        row = row.replace(/^\[+/, '');
        row = row.replace(/\]+$/, '');
        row = row.replace(/^\(+/, '');
        if (!/\(https?:\/\//.test(row)) row = row.replace(/\)+$/, '');
      }
      return row;
    }).join('\n');
    return out;
  }

  function findAngleLinks(text) {
    const out = [];
    const src = String(text || '');
    const re = /<(https?:\/\/[^>\s]+|mailto:[^>]+)>/gi;
    let m = re.exec(src);
    while (m) {
      out.push({ start: m.index, end: m.index + m[0].length, url: m[1] });
      m = re.exec(src);
    }
    return out;
  }

  function findMarkdownLinks(text) {
    const out = [];
    const src = String(text || '');
    let i = 0;
    while (i < src.length) {
      const link = parseMarkdownLink(src, i);
      if (!link) break;
      out.push({ start: link.start, end: link.end });
      i = link.end;
    }
    return out;
  }

  function splitProtectedSegments(text) {
    const src = String(text || '');
    const marks = [...findAngleLinks(src), ...findMarkdownLinks(src)]
      .sort((a, b) => a.start - b.start);
    const ranges = [];
    marks.forEach((item) => {
      const prev = ranges[ranges.length - 1];
      if (prev && item.start < prev.end) return;
      ranges.push(item);
    });
    if (!ranges.length) return [{ text: src, protected: false }];
    const segments = [];
    let cursor = 0;
    ranges.forEach((item) => {
      if (item.start > cursor) segments.push({ text: src.slice(cursor, item.start), protected: false });
      segments.push({ text: src.slice(item.start, item.end), protected: true });
      cursor = item.end;
    });
    if (cursor < src.length) segments.push({ text: src.slice(cursor), protected: false });
    return segments;
  }

  function collapseDoubleAngleLinks(text) {
    return String(text || '').replace(/<<((?:https?:\/\/|mailto:)[^>]+)>>/g, '<$1>');
  }

  function wrapAngleUrl(url) {
    return `<${url}>`;
  }

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function formatSuperscriptLink(label, href) {
    const url = safeHref(trimUrl(decodeEntities(href)));
    const text = String(label || '').trim() || url;
    if (!url) return text;
    if (!text || text === url || text === url.replace(/^https?:\/\//i, '')) return wrapAngleUrl(url);
    return `[${text}](${url})`;
  }

  function linkHrefFromMarks(marks) {
    for (const mark of marks || []) {
      const type = String(mark && mark.type || '').toLowerCase();
      const attrs = mark && mark.attrs && typeof mark.attrs === 'object' ? mark.attrs : {};
      const href = attrs.href || attrs.url || '';
      if ((type === 'link' || type === 'a') && href) return String(href).trim();
    }
    return '';
  }

  function superDocToMarkdown(raw) {
    let tree = raw;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text.startsWith('{') || !/"type"\s*:\s*"doc"/.test(text)) return '';
      try { tree = JSON.parse(text); } catch (err) { return ''; }
    }
    if (!tree || typeof tree !== 'object' || String(tree.type || '') !== 'doc') return '';
    const parts = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      const type = String(node.type || '');
      if (typeof node.text === 'string') {
        const href = linkHrefFromMarks(node.marks);
        parts.push(href ? formatSuperscriptLink(node.text, href) : node.text);
        return;
      }
      if (type === 'hardBreak' || type === 'break') {
        parts.push('\n');
        return;
      }
      const kids = Array.isArray(node.content) ? node.content : [];
      if (type === 'link') {
        const href = node.attrs && (node.attrs.href || node.attrs.url);
        const inner = [];
        const prev = parts.length;
        for (const child of kids) walk(child);
        const label = parts.splice(prev).join('');
        parts.push(formatSuperscriptLink(label, href));
        return;
      }
      for (const child of kids) walk(child);
      if (
        type === 'paragraph'
        || type === 'heading'
        || type === 'listItem'
        || type === 'blockquote'
        || type === 'codeBlock'
        || type === 'tableRow'
      ) {
        parts.push('\n');
      }
    };
    walk(tree);
    return parts.join('').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  }

  function htmlLinksToMarkdown(text) {
    return String(text || '').replace(
      /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
      (_, dquoted, squoted, bare, inner) => {
        const href = dquoted || squoted || bare || '';
        const label = decodeEntities(String(inner || '').replace(/<[^>]+>/g, '')).trim();
        return formatSuperscriptLink(label, href);
      },
    );
  }

  function prepareForSuperscript(text) {
    const src = String(text || '');
    return htmlLinksToMarkdown(superDocToMarkdown(src) || src);
  }

  function linkifySegment(text) {
    if (!text) return text;
    const parts = [];
    let cursor = 0;
    const urls = [
      ...findHttpUrls(text),
      ...findWwwUrls(text).filter((item) => !findHttpUrls(text).some((http) => (
        item.start >= http.start && item.start < http.end
      ))),
    ].sort((a, b) => a.start - b.start);
    urls.forEach((item) => {
      if (item.start < cursor) return;
      parts.push(text.slice(cursor, item.start));
      const href = item.www ? `https://${item.url}` : item.url;
      parts.push(wrapAngleUrl(href));
      cursor = item.end;
    });
    parts.push(text.slice(cursor));
    let out = parts.join('');
    return out.replace(EMAIL_RE, (email) => `<mailto:${email}>`);
  }

  function linkifyLineCore(line) {
    const src = String(line || '');
    if (!/\[[^\]]+\]\(|https?:\/\//.test(src)) {
      return linkifySegment(src);
    }
    let out = '';
    let cursor = 0;
    while (cursor < src.length) {
      const link = parseMarkdownLink(src, cursor);
      if (!link || link.start > cursor) {
        const nextBracket = src.indexOf('[', cursor);
        const nextHttp = src.slice(cursor).search(/https?:\/\//i);
        const nextHttpAbs = nextHttp >= 0 ? cursor + nextHttp : -1;
        const stop = [nextBracket, nextHttpAbs].filter((n) => n >= cursor).sort((a, b) => a - b)[0];
        const end = stop == null ? src.length : stop;
        if (end <= cursor) {
          if (nextHttpAbs === cursor) {
            const urls = findHttpUrls(src.slice(cursor));
            const first = urls[0];
            if (first && first.start === 0) {
              out += wrapAngleUrl(first.url);
              cursor += first.end;
              continue;
            }
          }
          if (nextBracket === cursor) {
            out += src[cursor];
            cursor += 1;
            continue;
          }
          out += linkifySegment(src.slice(cursor));
          break;
        }
        out += linkifySegment(src.slice(cursor, end));
        cursor = end;
        continue;
      }
      if (link.start > cursor) out += linkifySegment(src.slice(cursor, link.start));
      const href = trimUrl(link.href);
      const safe = safeHref(href);
      out += safe ? `[${link.label}](${href})` : linkifySegment(src.slice(link.start, link.end));
      cursor = link.end;
    }
    return out;
  }

  function linkifyLine(line) {
    return splitProtectedSegments(line).map((segment) => (
      segment.protected ? segment.text : linkifyLineCore(segment.text)
    )).join('');
  }

  function linkifyPlain(text) {
    return String(text || '')
      .split('\n')
      .map((line) => linkifyLine(line))
      .join('\n');
  }

  function normalizeContent(text) {
    return linkifyPlain(collapseDoubleAngleLinks(repairBrokenLinks(prepareForSuperscript(text))));
  }

  function convertFrom(text) {
    return repairBrokenLinks(stripMarkdownLinksToUrls(text));
  }

  function convertChecklistLines(text) {
    return String(text || '')
      .split('\n')
      .map((line) => {
        const match = line.match(TASK_RE);
        if (!match) return line;
        const mark = match[2] !== ' ' ? '☑' : '☐';
        const indent = match[1].replace(/[-*]\s*$/, '');
        return `${indent}- ${mark} ${match[3].trim()}`;
      })
      .join('\n');
  }

  function convertTo(text, fromEditor) {
    const from = String(fromEditor || 'plain').toLowerCase();
    if (from === 'code') {
      const body = String(text || '').replace(/\n$/, '');
      return body.includes('```') ? body : `\`\`\`\n${body}\n\`\`\``;
    }
    if (from === 'checklist' || from === 'super') return normalizeContent(convertChecklistLines(text));
    return normalizeContent(text);
  }

  function parseAngleLink(text, fromIndex) {
    const start = text.indexOf('<', fromIndex);
    if (start === -1) return null;
    const mail = text.slice(start).match(/^<mailto:([^>]+)>/);
    if (mail) {
      return { start, end: start + mail[0].length, href: `mailto:${mail[1]}`, label: mail[1] };
    }
    const http = text.slice(start).match(/^<(https?:\/\/[^>]+)>/);
    if (!http) return null;
    return { start, end: start + http[0].length, href: http[1], label: http[1] };
  }

  function nextInlineToken(text, cursor) {
    const md = parseMarkdownLink(text, cursor);
    const angle = parseAngleLink(text, cursor);
    const picks = [md, angle].filter(Boolean).sort((a, b) => a.start - b.start);
    return picks[0] || null;
  }

  function renderInlinePlainSegment(segment) {
    let out = '';
    let cursor = 0;
    const src = String(segment || '');
    while (cursor < src.length) {
      const token = nextInlineToken(src, cursor);
      if (!token || token.start > cursor) {
        const end = token ? token.start : src.length;
        const chunk = src.slice(cursor, end);
        let subCursor = 0;
        const urls = [
          ...findHttpUrls(chunk),
          ...findWwwUrls(chunk).map((item) => ({ start: item.start, end: item.end, href: `https://${item.url}` })),
        ].sort((a, b) => a.start - b.start);
        urls.forEach((item) => {
          if (item.start < subCursor) return;
          out += escapeHtml(chunk.slice(subCursor, item.start));
          const href = item.href || item.url;
          const safe = safeHref(trimUrl(href));
          const raw = chunk.slice(item.start, item.end);
          if (safe) {
            const attr = safe.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            if (safe.startsWith('#')) {
              out += `<a class="edit-link in-doc-link" href="${attr}">${escapeHtml(raw)}</a>`;
            } else {
              out += `<a href="${attr}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`;
            }
          } else {
            out += escapeHtml(raw);
          }
          subCursor = item.end;
        });
        out += escapeHtml(chunk.slice(subCursor));
        cursor = end;
        if (!token) break;
        continue;
      }
      const href = trimUrl(token.href);
      const safe = safeHref(href) || (href.startsWith('mailto:') ? href : '');
      if (!safe) {
        out += escapeHtml(src.slice(token.start, token.end));
      } else {
        const attr = safe.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        if (safe.startsWith('#')) {
          out += `<a class="edit-link in-doc-link" href="${attr}">${escapeHtml(token.label || safe)}</a>`;
        } else {
          out += `<a href="${attr}" target="_blank" rel="noopener noreferrer">${escapeHtml(token.label || safe)}</a>`;
        }
      }
      cursor = token.end;
    }
    return out;
  }

  function renderInline(text) {
    return renderInlinePlainSegment(text);
  }

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

  function renderEditMirror(text) {
    return String(text || '')
      .split('\n')
      .map((line) => renderInline(line))
      .join('<br>\n');
  }

  function collectLinkRanges(text) {
    const src = String(text || '');
    const ranges = [];
    const overlaps = (start, end) => ranges.some((r) => start < r.end && end > r.start);
    const addRange = (start, end, href) => {
      const raw = trimUrl(href);
      const safe = safeHref(raw) || (String(raw).startsWith('mailto:') ? raw : '');
      if (!safe || overlaps(start, end)) return;
      ranges.push({ start, end, href: safe });
    };
    let cursor = 0;
    while (cursor < src.length) {
      const token = nextInlineToken(src, cursor);
      if (!token || token.start > cursor) {
        if (!token) break;
        cursor = token.start;
        continue;
      }
      addRange(token.start, token.end, token.href);
      cursor = token.end;
    }
    let lineStart = 0;
    src.split('\n').forEach((line) => {
      findHttpUrls(line).forEach((item) => addRange(lineStart + item.start, lineStart + item.end, item.url));
      findWwwUrls(line).forEach((item) => addRange(lineStart + item.start, lineStart + item.end, `https://${item.url}`));
      lineStart += line.length + 1;
    });
    ranges.sort((a, b) => a.start - b.start);
    return ranges.filter((r, i, arr) => !i || r.start >= arr[i - 1].end);
  }

  function extractLinks(text) {
    const links = [];
    const seen = new Set();
    const add = (href, label) => {
      const raw = trimUrl(href);
      const safe = safeHref(raw) || (String(raw).startsWith('mailto:') ? raw : '');
      if (!safe || seen.has(safe)) return;
      seen.add(safe);
      const name = String(label || safe).trim() || safe;
      links.push({ href: safe, label: name });
    };
    const src = String(text || '');
    let cursor = 0;
    while (cursor < src.length) {
      const token = nextInlineToken(src, cursor);
      if (!token || token.start > cursor) {
        if (!token) break;
        cursor = token.start;
        continue;
      }
      add(token.href, token.label);
      cursor = token.end;
    }
    src.split('\n').forEach((line) => {
      findHttpUrls(line).forEach((item) => add(item.url, item.url));
      findWwwUrls(line).forEach((item) => add(`https://${item.url}`, item.url));
    });
    return links;
  }

  function render(md) {
    const source = normalizeContent(md);
    const fences = [];
    let text = String(source || '').replace(/```([\s\S]*?)```/g, (_, code) => {
      fences.push(code);
      return `@@FENCE${fences.length - 1}@@`;
    });
    let html = renderInline(text);
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\^\^(.+?)\^\^/g, '<sup>$1</sup>');
    html = html.replace(/\^([^^]+)\^/g, '<sup>$1</sup>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^\s*[-*] \[([ xX])\] (.*)$/gm, (_, checked, label) => {
      const on = checked !== ' ';
      return `<li class="task${on ? ' done' : ''}"><button type="button" class="task-toggle" data-checked="${on ? '1' : '0'}" aria-checked="${on}">${on ? '☑' : '☐'}</button> ${label}</li>`;
    });
    html = html.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
    html = html.replace(/(<li[\s\S]*?<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
    html = html.replace(/@@FENCE(\d+)@@/g, (_, i) => `<pre><code>${escapeHtml(fences[Number(i)])}</code></pre>`);
    const blocks = html.split(/\n\n+/);
    const paragraphs = blocks
      .map((block) => block.replace(/\n/g, '<br>').trim())
      .filter(Boolean)
      .map((block) => `<p>${block}</p>`);
    const joined = paragraphs.length ? paragraphs.join('') : '<p></p>';
    const nav = (typeof globalThis !== 'undefined' && globalThis.NotesInDocNav)
      || (typeof window !== 'undefined' && window.NotesInDocNav);
    return nav?.annotateHeadingHtml ? nav.annotateHeadingHtml(joined) : joined;
  }

  const api = {
    render,
    renderEditMirror,
    extractLinks,
    collectLinkRanges,
    convertTo,
    convertFrom,
    normalizeContent,
    linkifyPlain,
    superDocToMarkdown,
    htmlLinksToMarkdown,
    toggleTaskAt,
  };
  if (typeof window !== 'undefined') window.NotesSuperscript = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
