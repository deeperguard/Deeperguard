// Mermaid diagrams in the note view (docs/design/rich-editor.md, 1.7 and 4.4).
// A ```mermaid block is rendered inside <iframe sandbox="allow-scripts"> (no allow-same-origin: opaque
// origin, so no access to the app DOM, cookies, localStorage or IndexedDB) that loads
// /static/mermaid-sandbox.html with its own CSP and no network. The parent sends only the diagram text and
// accepts only a height or an error text back, after checking event.source and the message format.
// The iframe (and with it the 2.5 MB Mermaid bundle) is created only when a note has a mermaid block.
const NotesMermaid = (() => {
  const SANDBOX_URL = '/static/mermaid-sandbox.html';
  // Keep equal to MAX_SOURCE in mermaid-sandbox.js: the sandbox rejects longer sources.
  const MAX_SOURCE = 20000;
  const MAX_LABEL = 300;
  const MAX_HEIGHT = 4000;
  const TIMEOUT_MS = 10000;
  const ERROR_TEXT = 'Dit diagram kan niet worden getoond. De bron staat hieronder.';
  const ARIA_PREFIX = 'Mermaid-diagram. Bron: ';
  let counter = 0;
  let queue = Promise.resolve();
  // The render in flight: the figure it belongs to and a function that ends it early.
  let figureInFlight = null;
  let cancelRender = null;

  function theme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // Resolves { height }, { error } or { cancelled }; on time-out or cancel the caller removes (destroys) the iframe.
  function renderInSandbox(iframe, source, id) {
    return new Promise((resolve) => {
      let timer = null;
      const done = (result) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        cancelRender = null;
        resolve(result);
      };
      cancelRender = () => done({ cancelled: true });
      function onMessage(event) {
        if (event.source !== iframe.contentWindow) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'dg-mermaid-ready') {
          iframe.contentWindow.postMessage({ type: 'dg-mermaid-render', id, source, theme: theme() }, '*');
          return;
        }
        if (data.type !== 'dg-mermaid-result' || data.id !== id) return;
        if (typeof data.error === 'string') {
          done({ error: true });
        } else if (Number.isFinite(data.height) && data.height > 0) {
          done({ height: Math.min(Math.ceil(data.height), MAX_HEIGHT) });
        } else {
          done({ error: true });
        }
      }
      window.addEventListener('message', onMessage);
      timer = setTimeout(() => done({ error: true }), TIMEOUT_MS);
      iframe.src = SANDBOX_URL;
    });
  }

  function fail(figure, pre) {
    const note = document.createElement('p');
    note.className = 'md-mermaid-error';
    note.setAttribute('role', 'alert');
    note.textContent = ERROR_TEXT;
    figure.textContent = '';
    figure.classList.add('is-error');
    figure.append(note, pre);
  }

  async function mount(figure, pre, source) {
    if (!figure.isConnected) return;
    counter += 1;
    const id = `m${counter}`;
    const box = document.createElement('div');
    box.className = 'md-mermaid-box';
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `${ARIA_PREFIX}${source.length > MAX_LABEL ? `${source.slice(0, MAX_LABEL)}…` : source}`);
    const iframe = document.createElement('iframe');
    iframe.className = 'md-mermaid-frame';
    iframe.title = 'Mermaid-diagram';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('scrolling', 'no');
    box.appendChild(iframe);
    const details = document.createElement('details');
    details.className = 'md-mermaid-source';
    const summary = document.createElement('summary');
    summary.textContent = 'Bron van het diagram';
    details.append(summary, pre);
    figure.textContent = '';
    figure.append(box, details);
    figureInFlight = figure;
    const result = await renderInSandbox(iframe, source, id);
    if (result.cancelled) {
      iframe.remove();
    } else if (result.error) {
      iframe.remove();
      fail(figure, pre);
    } else {
      iframe.style.height = `${result.height}px`;
      figure.classList.add('is-rendered');
    }
  }

  // Replaces every ```mermaid block under root by a diagram figure. Returns the number of blocks found.
  function decorate(root) {
    if (!root?.querySelectorAll || typeof document === 'undefined') return 0;
    // A new preview replaced the figure of the render in flight: end that render now instead of at the time-out.
    if (cancelRender && !figureInFlight?.isConnected) cancelRender();
    let found = 0;
    root.querySelectorAll('pre.code-preview > code.language-mermaid').forEach((code) => {
      const pre = code.parentElement;
      found += 1;
      const source = (code.textContent || '').replace(/\n$/, '');
      const figure = document.createElement('figure');
      figure.className = 'md-mermaid';
      pre.replaceWith(figure);
      if (!source.trim() || source.length > MAX_SOURCE) {
        fail(figure, pre);
        return;
      }
      const loading = document.createElement('p');
      loading.className = 'md-mermaid-loading';
      loading.textContent = 'Diagram laden…';
      figure.append(loading);
      // One render at a time (design 4.3).
      queue = queue.then(() => mount(figure, pre, source)).catch(() => fail(figure, pre));
    });
    return found;
  }

  return { decorate, SANDBOX_URL, MAX_SOURCE };
})();

if (typeof window !== 'undefined') window.NotesMermaid = NotesMermaid;
