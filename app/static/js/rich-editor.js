// Formatted ("live preview") Markdown editing on top of the vendored CodeMirror 6 bundle
// (docs/design/rich-editor.md, 1.6, 2.2, 2.3 and 5.4).
//
// The editor document IS the Markdown string: formatting is only decoration (styles and hidden
// markers) over the source, so opening, switching mode and closing never rewrite a byte, and syntax
// the editor does not know (HTML blocks, front matter, footnotes, ...) is plain text that stays as
// it is. Lines are separated by "\n" only, so "\r" of a CRLF note stays part of the text.
//
// Pasted HTML never enters the document as HTML: it goes through the vendored DOMPurify (via
// sanitize.js) and is then converted to Markdown by htmlToMarkdown, which only knows a fixed set of
// elements and drops everything else (scripts, styles, images and so tracking pixels, event
// attributes, javascript: links).
(() => {
  const MAX_CHARS = 500000;
  const MAX_LINES = 20000;
  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
  const QUOTE_RE = /^(\s{0,3}>\s?)+/;
  const HEADING_RE = /^(#{1,6})([ \t]+)/;
  const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  const HR_RE = /^ {0,3}([-*_])( ?\1){2,}\s*$/;

  function cm() {
    const lib = typeof window !== 'undefined' ? window.DGCodeMirror : globalThis.DGCodeMirror;
    return lib || null;
  }

  function available() {
    return !!cm();
  }

  // Notes above these limits stay in Source mode (design 4.3: no formatting layer for huge notes).
  function tooLarge(text) {
    const s = String(text || '');
    if (s.length > MAX_CHARS) return true;
    let lines = 1;
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) lines += 1;
    return lines > MAX_LINES;
  }

  // ---------------------------------------------------------------- HTML -> Markdown (paste)

  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
    'TABLE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'MAIN', 'ASIDE', 'NAV', 'DL', 'DT', 'DD',
    'THEAD', 'TBODY', 'TFOOT', 'TR']);
  // Elements whose content is never text for the note.
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH',
    'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'LINK', 'META', 'HEAD', 'FORM', 'SELECT', 'TEXTAREA', 'BUTTON']);

  function safeHref(url, safeRichHref) {
    const href = String(url || '').trim().replace(/ /g, '%20');
    const ok = safeRichHref ? safeRichHref(href) : '';
    return ok ? ok.replace(/\(/g, '%28').replace(/\)/g, '%29') : '';
  }

  function escapeText(text) {
    return text.replace(/[\\`*_[\]<>]/g, '\\$&');
  }

  function wrapMark(mark, inner) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
  }

  function fenceFor(code, ch = '`') {
    let longest = 0;
    for (const run of code.match(new RegExp(`${ch === '`' ? '`' : '~'}+`, 'g')) || []) longest = Math.max(longest, run.length);
    return ch.repeat(Math.max(3, longest + 1));
  }

  // Allowlist for pasted HTML (everything else is removed, its text kept, script/style content dropped).
  const PASTE_CONFIG = {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 's',
      'strike', 'del', 'u', 'code', 'kbd', 'samp', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody',
      'tfoot', 'tr', 'th', 'td', 'input', 'section', 'article', 'header', 'footer', 'figure', 'main', 'aside', 'nav',
      'dl', 'dt', 'dd'],
    ALLOWED_ATTR: ['href', 'colspan', 'rowspan', 'start', 'type', 'checked', 'class'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // Plain-value attributes: DOMPurify would otherwise test their value against the URL regexp.
    ADD_URI_SAFE_ATTR: ['type', 'checked', 'class', 'start', 'colspan', 'rowspan'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    KEEP_CONTENT: true,
  };

  function pasteSanitizer() {
    const lib = typeof window !== 'undefined' ? window.DOMPurify : null;
    const purify = lib && typeof lib.sanitize === 'function' ? lib : (typeof lib === 'function' ? lib(window) : null);
    return purify && purify.isSupported ? (html) => purify.sanitize(html, PASTE_CONFIG) : null;
  }

  function htmlToMarkdown(html, deps = {}) {
    const sanitize = deps.sanitize || pasteSanitizer();
    const safeRichHref = deps.safeRichHref || (typeof window !== 'undefined' && window.NotesSanitize?.safeRichHref);
    if (!sanitize) return null;
    const clean = sanitize(String(html ?? ''));
    if (typeof clean !== 'string') return null;
    const doc = new DOMParser().parseFromString(clean, 'text/html');

    function inline(node, inPre) {
      if (node.nodeType === 3) {
        const raw = node.nodeValue;
        return inPre ? raw : escapeText(raw.replace(/\s+/g, ' '));
      }
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toUpperCase();
      if (DROP_TAGS.has(tag)) return '';
      const kids = () => Array.from(node.childNodes).map((c) => inline(c, inPre)).join('');
      switch (tag) {
        case 'STRONG': case 'B': return wrapMark('**', kids());
        case 'EM': case 'I': return wrapMark('*', kids());
        case 'DEL': case 'S': case 'STRIKE': return wrapMark('~~', kids());
        case 'CODE': case 'KBD': case 'SAMP': {
          const code = node.textContent.replace(/\s+/g, ' ').trim();
          if (!code) return '';
          const fence = '`'.repeat(Math.max(1, ...((code.match(/`+/g) || []).map((r) => r.length + 1))));
          return /^`|`$/.test(code) ? `${fence} ${code} ${fence}` : `${fence}${code}${fence}`;
        }
        case 'A': {
          const inner = kids();
          const href = safeHref(node.getAttribute('href'), safeRichHref);
          return href && inner.trim() ? `[${inner.trim()}](${href})` : inner;
        }
        case 'BR': return '  \n';
        case 'INPUT': return '';
        default: return kids();
      }
    }

    // Block-level walk: returns an array of Markdown blocks.
    function blocks(parent, out) {
      let run = [];
      const flush = () => {
        const text = run.join('').replace(/ *\n */g, (m) => (m.includes('\n') ? '\n' : ' ')).replace(/^ +| +$/g, '');
        run = [];
        if (!text.trim()) return;
        out.push(text.split('\n').map((line) => line
          .replace(/^(\s*)(#{1,6}|[-+])(?=\s)/, '$1\\$2')
          .replace(/^(\s*)(\d+)([.)])(?=\s)/, '$1$2\\$3')).join('\n'));
      };
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType !== 1) { run.push(inline(node)); continue; }
        const tag = node.tagName.toUpperCase();
        if (DROP_TAGS.has(tag)) continue;
        if (!BLOCK_TAGS.has(tag)) { run.push(inline(node)); continue; }
        flush();
        block(node, tag, out);
      }
      flush();
      return out;
    }

    function block(node, tag, out) {
      if (/^H[1-6]$/.test(tag)) {
        const text = inline(node).replace(/\s*\n\s*/g, ' ').trim();
        if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      } else if (tag === 'UL' || tag === 'OL') {
        const items = [];
        let n = tag === 'OL' ? (parseInt(node.getAttribute('start'), 10) || 1) : 0;
        for (const li of Array.from(node.children)) {
          if (li.tagName.toUpperCase() !== 'LI') continue;
          const box = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
          const marker = (tag === 'OL' ? `${n}. ` : '- ') + (box ? (box.hasAttribute('checked') ? '[x] ' : '[ ] ') : '');
          n += 1;
          const parts = blocks(li, []);
          if (!parts.length) continue;
          const pad = ' '.repeat(tag === 'OL' ? String(n - 1).length + 2 : 2);
          items.push(`${marker}${parts.join('\n').split('\n').join(`\n${pad}`)}`);
        }
        if (items.length) out.push(items.join('\n'));
      } else if (tag === 'BLOCKQUOTE') {
        const inner = blocks(node, []).join('\n\n');
        if (inner) out.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      } else if (tag === 'PRE') {
        const codeEl = node.querySelector('code');
        const code = (codeEl || node).textContent.replace(/\n$/, '');
        const lang = /(?:^|\s)(?:language|lang)-([\w+#-]{1,30})(?:\s|$)/.exec(codeEl?.getAttribute('class') || '')?.[1] || '';
        const fence = fenceFor(code);
        out.push(`${fence}${lang}\n${code}\n${fence}`);
      } else if (tag === 'HR') {
        out.push('---');
      } else if (tag === 'TABLE') {
        const rows = Array.from(node.querySelectorAll('tr')).map((tr) => Array.from(tr.children)
          .filter((c) => /^(TD|TH)$/i.test(c.tagName))
          .map((c) => inline(c).replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|')));
        const width = Math.max(0, ...rows.map((r) => r.length));
        if (width && rows.length) {
          const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] || '').join(' | ')} |`;
          out.push([line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n'));
        }
      } else if (tag === 'LI' || tag === 'DT' || tag === 'DD' || tag === 'TR' || tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
        blocks(node, out);
      } else {
        blocks(node, out);
      }
    }

    return blocks(doc.body, []).join('\n\n').trim();
  }

  // ---------------------------------------------------------------- live-preview decorations

  // 0 = normal line, 1 = fence delimiter, 2 = inside a fenced block (one entry per line, 1-based).
  function fenceStates(doc) {
    const states = new Uint8Array(doc.lines + 1);
    let open = null;
    for (let i = 1; i <= doc.lines; i += 1) {
      const m = FENCE_RE.exec(doc.line(i).text);
      if (open) {
        if (m && m[1][0] === open[0] && m[1].length >= open.length && /^\s*$/.test(doc.line(i).text.slice(m[0].length))) {
          states[i] = 1;
          open = null;
        } else states[i] = 2;
      } else if (m) {
        states[i] = 1;
        open = m[1];
      }
    }
    return states;
  }

  // Inline spans of one line: [{ from, to, cls, marks: [[from, to], ...] }] (offsets inside the line).
  function inlineSpans(text) {
    const spans = [];
    let work = text;
    const mask = (from, to) => { work = work.slice(0, from) + '\u0000'.repeat(to - from) + work.slice(to); };
    let m;
    const codeRe = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
    while ((m = codeRe.exec(work))) {
      const n = m[1].length;
      spans.push({ from: m.index + n, to: m.index + m[0].length - n, cls: 'dg-c', marks: [[m.index, m.index + n], [m.index + m[0].length - n, m.index + m[0].length]] });
      mask(m.index, m.index + m[0].length);
    }
    const linkRe = /\[([^\]\n]+)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
    while ((m = linkRe.exec(work))) {
      const end = m.index + m[0].length;
      const textEnd = m.index + 1 + m[1].length;
      spans.push({ from: m.index + 1, to: textEnd, cls: 'dg-a', marks: [[m.index, m.index + 1], [textEnd, end]] });
      mask(textEnd, end);
    }
    const pairs = [
      [/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*|__(?=\S)([\s\S]+?)(?<=\S)__/g, 2, 'dg-b'],
      [/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, 2, 'dg-s'],
      [/(?<![*\w])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![*\w])|(?<![_\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![_\w])/g, 1, 'dg-i'],
    ];
    for (const [re, n, cls] of pairs) {
      while ((m = re.exec(work))) {
        const end = m.index + m[0].length;
        spans.push({ from: m.index + n, to: end - n, cls, marks: [[m.index, m.index + n], [end - n, end]] });
        mask(m.index, m.index + n);
        mask(end - n, end);
        re.lastIndex = m.index + n;
      }
    }
    return spans;
  }

  // Built on first use: the editor bundle is loaded deferred, after this file.
  let TaskWidget = null;
  function taskWidgetClass() {
    if (TaskWidget) return TaskWidget;
    TaskWidget = class extends cm().WidgetType {
    constructor(checked) { super(); this.checked = checked; }

    eq(other) { return other.checked === this.checked; }

    toDOM(view) {
      const el = document.createElement('span');
      el.className = `dg-task${this.checked ? ' dg-task-on' : ''}`;
      el.setAttribute('role', 'checkbox');
      el.setAttribute('aria-checked', this.checked ? 'true' : 'false');
      el.setAttribute('aria-label', 'Task');
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const pos = view.posAtDOM(el);
        const text = view.state.doc.sliceString(pos, pos + 3);
        if (!/^\[[ xX]\]$/.test(text)) return;
        view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.format' });
      });
      return el;
    }

    ignoreEvent() { return true; }
    };
    return TaskWidget;
  }

  function buildDecorations(view, fences) {
    const { Decoration } = cm();
    const { state } = view;
    const doc = state.doc;
    const out = [];
    const sel = state.selection.ranges;
    const hide = Decoration.replace({});
    const touched = (line) => sel.some((r) => r.from <= line.to && r.to >= line.from);
    let last = 0;
    for (const { from, to } of view.visibleRanges) {
      let line = doc.lineAt(from);
      for (;;) {
        if (line.number > last) {
          last = line.number;
          const active = touched(line);
          const raw = line.text;
          const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (text.length !== raw.length) out.push(hide.range(line.to - 1, line.to));
          const classes = [];
          const state2 = fences[line.number];
          const syntax = (a, b) => {
            if (a >= b) return;
            out.push((active ? Decoration.mark({ class: 'dg-syn' }) : hide).range(line.from + a, line.from + b));
          };
          if (state2 === 1) classes.push('dg-fence');
          else if (state2 === 2) classes.push('dg-code');
          else {
            let offset = 0;
            const h = HEADING_RE.exec(text);
            const q = QUOTE_RE.exec(text);
            const l = !h && LIST_RE.exec(text);
            if (h) {
              classes.push(`dg-h${h[1].length}`);
              syntax(0, h[0].length);
              offset = h[0].length;
            } else if (q) {
              classes.push('dg-quote');
              syntax(0, q[0].length);
              offset = q[0].length;
            } else if (l) {
              classes.push('dg-li');
              const markStart = l[1].length;
              out.push(Decoration.mark({ class: 'dg-li-mark' }).range(line.from + markStart, line.from + markStart + l[2].length));
              offset = l[0].length;
              if (l[4]) {
                const checked = /\[[xX]\]/.test(l[4]);
                const boxFrom = markStart + l[2].length + l[3].length;
                if (checked) classes.push('dg-done');
                if (!active) out.push(Decoration.replace({ widget: new (taskWidgetClass())(checked) }).range(line.from + boxFrom, line.from + boxFrom + 3));
              }
            } else if (HR_RE.test(text)) classes.push('dg-hr');
            else if (TABLE_ROW_RE.test(text) || (TABLE_SEP_RE.test(text) && text.includes('-') && text.includes('|'))) classes.push('dg-table');
            if (!classes.includes('dg-table') && !classes.includes('dg-hr')) {
              for (const span of inlineSpans(text.slice(offset))) {
                out.push(Decoration.mark({ class: span.cls }).range(line.from + offset + span.from, line.from + offset + span.to));
                for (const [a, b] of span.marks) syntax(offset + a, offset + b);
              }
            }
          }
          if (classes.length) out.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
        }
        if (line.to >= to || line.number >= doc.lines) break;
        line = doc.line(line.number + 1);
      }
    }
    return Decoration.set(out, true);
  }

  // ---------------------------------------------------------------- commands

  function userDispatch(view, spec) {
    view.dispatch(view.state.update(spec, { userEvent: 'input.format', scrollIntoView: true }));
    view.focus();
    return true;
  }

  function toggleInline(view, mark) {
    const { EditorSelection } = cm();
    const n = mark.length;
    const doc = view.state.doc;
    const spec = view.state.changeByRange((range) => {
      const { from, to } = range;
      const before = doc.sliceString(Math.max(0, from - n), from);
      const after = doc.sliceString(to, Math.min(doc.length, to + n));
      const single = n === 1;
      const extended = single && (doc.sliceString(Math.max(0, from - 2), Math.max(0, from - 1)) === mark
        || doc.sliceString(to + 1, to + 2) === mark);
      if (before === mark && after === mark && !extended) {
        return {
          changes: [{ from: from - n, to: from }, { from: to, to: to + n }],
          range: EditorSelection.range(from - n, to - n),
        };
      }
      if (from === to) {
        return { changes: { from, insert: mark + mark }, range: EditorSelection.cursor(from + n) };
      }
      const selected = doc.sliceString(from, to);
      if (selected.length >= 2 * n && selected.startsWith(mark) && selected.endsWith(mark)) {
        const inner = selected.slice(n, -n);
        return { changes: { from, to, insert: inner }, range: EditorSelection.range(from, from + inner.length) };
      }
      return {
        changes: [{ from, insert: mark }, { from: to, insert: mark }],
        range: EditorSelection.range(from + n, to + n),
      };
    });
    return userDispatch(view, spec);
  }

  function selectedLines(view) {
    const doc = view.state.doc;
    const seen = new Set();
    const lines = [];
    for (const r of view.state.selection.ranges) {
      const a = doc.lineAt(r.from).number;
      const b = doc.lineAt(r.to).number;
      for (let i = a; i <= b; i += 1) {
        if (!seen.has(i)) { seen.add(i); lines.push(doc.line(i)); }
      }
    }
    return lines;
  }

  function setHeading(view, level) {
    const changes = [];
    for (const line of selectedLines(view)) {
      const m = HEADING_RE.exec(line.text);
      const prefix = '#'.repeat(level) + ' ';
      if (m && m[1].length === level) changes.push({ from: line.from, to: line.from + m[0].length });
      else changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
    }
    return userDispatch(view, { changes });
  }

  function toggleLinePrefix(view, kind) {
    const lines = selectedLines(view).filter((l) => l.text.trim() || selectedLines(view).length === 1);
    const isKind = (text) => {
      if (kind === 'quote') return /^\s{0,3}>/.test(text);
      const m = LIST_RE.exec(text);
      if (!m) return false;
      if (kind === 'task') return !!m[4];
      if (kind === 'ol') return /\d/.test(m[2]) && !m[4];
      return /[-*+]/.test(m[2]) && !m[4];
    };
    const allOn = lines.length > 0 && lines.every((l) => isKind(l.text));
    const changes = [];
    lines.forEach((line, i) => {
      const quote = kind === 'quote';
      const m = quote ? QUOTE_RE.exec(line.text) : LIST_RE.exec(line.text);
      const indent = !quote && m ? m[1] : '';
      const oldLen = m ? m[0].length : 0;
      if (allOn) {
        changes.push({ from: line.from, to: line.from + oldLen, insert: indent });
        return;
      }
      const marker = { ul: '- ', ol: `${i + 1}. `, task: '- [ ] ', quote: '> ' }[kind];
      changes.push({ from: line.from, to: line.from + oldLen, insert: indent + marker });
    });
    return userDispatch(view, { changes });
  }

  function insertCodeBlock(view) {
    const { EditorSelection } = cm();
    const doc = view.state.doc;
    const range = view.state.selection.main;
    const first = doc.lineAt(range.from);
    const last = doc.lineAt(range.to);
    if (range.empty && !first.text.trim()) {
      return userDispatch(view, {
        changes: { from: first.from, to: first.to, insert: '```\n\n```' },
        selection: EditorSelection.cursor(first.from + 4),
      });
    }
    if (range.empty) {
      return userDispatch(view, {
        changes: { from: first.to, insert: '\n```\n\n```' },
        selection: EditorSelection.cursor(first.to + 5),
      });
    }
    return userDispatch(view, {
      changes: [{ from: first.from, insert: '```\n' }, { from: last.to, insert: '\n```' }],
      selection: EditorSelection.cursor(last.to + 4 + 4),
    });
  }

  function insertLink(view) {
    const { EditorSelection } = cm();
    const spec = view.state.changeByRange((range) => {
      const sel = view.state.doc.sliceString(range.from, range.to);
      if (/^https?:\/\/\S+$/i.test(sel)) {
        return {
          changes: { from: range.from, to: range.to, insert: `[link](${sel})` },
          range: EditorSelection.range(range.from + 1, range.from + 5),
        };
      }
      const label = sel || 'text';
      const url = 'https://';
      const start = range.from + label.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert: `[${label}](${url})` },
        range: EditorSelection.range(start, start + url.length),
      };
    });
    return userDispatch(view, spec);
  }

  function tableSkeleton() {
    const api = typeof window !== 'undefined' ? window.NotesTableEditor : null;
    return api?.newTableMarkdown ? api.newTableMarkdown(2, 2) : '| Column 1 | Column 2 |\n| --- | --- |\n| | |\n| | |';
  }

  function insertTable(view) {
    const { EditorSelection } = cm();
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const table = tableSkeleton();
    const lead = line.text.trim() ? '\n\n' : '';
    return userDispatch(view, {
      changes: { from: line.to, insert: `${lead}${table}\n` },
      selection: EditorSelection.cursor(line.to + lead.length + 2),
    });
  }

  // Enter in a list or quote: continue the markup; Enter on an empty item ends it.
  function continueMarkup(view) {
    const { EditorSelection } = cm();
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const line = view.state.doc.lineAt(range.head);
    if (range.head !== line.to || fenceStates(view.state.doc)[line.number]) return false;
    const text = line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text;
    const l = LIST_RE.exec(text);
    const q = !l && QUOTE_RE.exec(text);
    const m = l || q;
    if (!m) return false;
    if (text.slice(m[0].length).trim() === '') {
      return userDispatch(view, { changes: { from: line.from, to: line.from + text.length, insert: '' } });
    }
    let next;
    if (l) {
      const num = /^\d+/.exec(l[2]);
      const marker = num ? `${Number(num[0]) + 1}${l[2].slice(num[0].length)}` : l[2];
      next = `${l[1]}${marker}${l[3]}${l[4] ? '[ ] ' : ''}`;
    } else next = m[0];
    const insert = `\n${next}`;
    return userDispatch(view, { changes: { from: range.head, insert }, selection: EditorSelection.cursor(range.head + insert.length) });
  }

  const ACTIONS = {
    bold: (v) => toggleInline(v, '**'),
    italic: (v) => toggleInline(v, '*'),
    strike: (v) => toggleInline(v, '~~'),
    code: (v) => toggleInline(v, '`'),
    heading: (v) => setHeading(v, 2),
    h1: (v) => setHeading(v, 1),
    h2: (v) => setHeading(v, 2),
    h3: (v) => setHeading(v, 3),
    ul: (v) => toggleLinePrefix(v, 'ul'),
    ol: (v) => toggleLinePrefix(v, 'ol'),
    check: (v) => toggleLinePrefix(v, 'task'),
    quote: (v) => toggleLinePrefix(v, 'quote'),
    codeblock: insertCodeBlock,
    link: insertLink,
    table: insertTable,
  };

  // ---------------------------------------------------------------- editor

  function create(host, opts = {}) {
    const lib = cm();
    if (!lib) throw new Error('editor library not loaded');
    const {
      EditorState, EditorView, Compartment, Annotation, ViewPlugin, keymap, history, historyKeymap, defaultKeymap,
      undo, redo, undoDepth, redoDepth,
    } = lib;
    const external = Annotation.define();
    const editable = new Compartment();
    const attrs = new Compartment();

    const plugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.fences = fenceStates(view.state.doc);
        this.decorations = buildDecorations(view, this.fences);
      }

      update(u) {
        if (u.docChanged) this.fences = fenceStates(u.state.doc);
        if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = buildDecorations(u.view, this.fences);
      }
    }, { decorations: (v) => v.decorations });

    const run = (name) => (view) => ACTIONS[name](view);
    const keys = [
      { key: 'Mod-b', run: run('bold'), preventDefault: true },
      { key: 'Mod-i', run: run('italic'), preventDefault: true },
      { key: 'Mod-k', run: run('link'), preventDefault: true },
      { key: 'Mod-e', run: run('code'), preventDefault: true },
      { key: 'Mod-Shift-x', run: run('strike'), preventDefault: true },
      { key: 'Mod-Alt-1', run: run('h1'), preventDefault: true },
      { key: 'Mod-Alt-2', run: run('h2'), preventDefault: true },
      { key: 'Mod-Alt-3', run: run('h3'), preventDefault: true },
      { key: 'Mod-Shift-7', run: run('ol'), preventDefault: true },
      { key: 'Mod-Shift-8', run: run('ul'), preventDefault: true },
      { key: 'Mod-Shift-9', run: run('check'), preventDefault: true },
      { key: 'Mod-/', run: () => { opts.onToggleMode?.(); return true; }, preventDefault: true },
      { key: 'Enter', run: continueMarkup },
    ];

    const pasteHandler = EditorView.domEventHandlers({
      paste(event, view) {
        const data = event.clipboardData;
        const html = data?.getData('text/html');
        if (!html) return false;
        const md = htmlToMarkdown(html);
        const text = md === null || md === '' ? data.getData('text/plain') : md;
        if (!text) return false;
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
        return true;
      },
    });

    // Ctrl/Cmd+Shift+Z = redo. The keymap resolves a shifted letter to the plain binding (undo) when
    // there is nothing left to redo, so this is handled first and always consumes the key.
    const redoKey = EditorView.domEventHandlers({
      keydown(event, view) {
        if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return false;
        event.preventDefault();
        redo(view);
        return true;
      },
    });

    const extensions = [
          EditorState.lineSeparator.of('\n'),
          history(),
          redoKey,
          keymap.of([...keys, ...historyKeymap, ...defaultKeymap]),
          EditorView.lineWrapping,
          plugin,
          pasteHandler,
          editable.of([EditorState.readOnly.of(!!opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
          attrs.of(EditorView.contentAttributes.of({
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-label': opts.label || 'Note text, formatted',
            spellcheck: opts.spellcheck === false ? 'false' : 'true',
          })),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) opts.onChange?.(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) opts.onUpdate?.();
          }),
    ];
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: String(opts.doc ?? ''), extensions }) });

    const controller = {
      view,
      getValue: () => view.state.doc.toString(),
      // reset: a different note, so the undo history of the old one must not apply.
      setValue(text, { reset = false } = {}) {
        const next = String(text ?? '');
        if (reset) {
          view.setState(EditorState.create({ doc: next, extensions }));
          return;
        }
        const cur = view.state.doc.toString();
        if (cur === next) return;
        let start = 0;
        while (start < cur.length && start < next.length && cur[start] === next[start]) start += 1;
        let endCur = cur.length;
        let endNext = next.length;
        while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) { endCur -= 1; endNext -= 1; }
        view.dispatch({ changes: { from: start, to: endCur, insert: next.slice(start, endNext) }, annotations: external.of(true) });
      },
      focus: () => view.focus(),
      exec(action) {
        const fn = ACTIONS[action];
        return fn ? fn(view) : false;
      },
      undo: () => { undo(view); view.focus(); },
      redo: () => { redo(view); view.focus(); },
      canUndo: () => undoDepth(view.state) > 0,
      canRedo: () => redoDepth(view.state) > 0,
      setReadOnly(on) {
        view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(!!on), EditorView.editable.of(!on)]) });
      },
      setSpellcheck(on) {
        view.dispatch({ effects: attrs.reconfigure(EditorView.contentAttributes.of({
          role: 'textbox', 'aria-multiline': 'true', 'aria-label': opts.label || 'Note text, formatted', spellcheck: on ? 'true' : 'false',
        })) });
      },
      destroy: () => view.destroy(),
      external,
    };
    return controller;
  }

  // Roving tabindex + arrow keys for a toolbar (role="toolbar"): one Tab stop, arrows move inside.
  function attachToolbar(toolbar, label) {
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', label || 'Formatting');
    toolbar.setAttribute('aria-orientation', 'horizontal');
    const items = () => Array.from(toolbar.querySelectorAll('button')).filter((b) => !b.hidden && !b.disabled && b.closest('[hidden]') === null);
    function refresh(active) {
      const list = items();
      const current = active && list.includes(active) ? active : (list.find((b) => b.tabIndex === 0) || list[0]);
      toolbar.querySelectorAll('button').forEach((b) => { b.tabIndex = b === current ? 0 : -1; });
    }
    toolbar.addEventListener('focusin', (e) => { if (e.target.closest('button')) refresh(e.target.closest('button')); });
    toolbar.addEventListener('keydown', (e) => {
      const list = items();
      const at = list.indexOf(document.activeElement);
      if (at < 0) return;
      let to = -1;
      if (e.key === 'ArrowRight') to = (at + 1) % list.length;
      else if (e.key === 'ArrowLeft') to = (at - 1 + list.length) % list.length;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = list.length - 1;
      if (to < 0) return;
      e.preventDefault();
      refresh(list[to]);
      list[to].focus();
    });
    refresh();
    return { refresh };
  }

  const api = {
    available, create, attachToolbar, htmlToMarkdown, tooLarge, ACTIONS: Object.keys(ACTIONS), MAX_CHARS, MAX_LINES,
  };
  if (typeof window !== 'undefined') window.NotesRichEditor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
