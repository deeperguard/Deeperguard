// Runs INSIDE the sandboxed iframe (sandbox="allow-scripts", no allow-same-origin, own strict CSP, no
// network). It only accepts {type, id, source, theme} from its parent and only answers with a height
// or an error text; it never sends markup back (docs/design/rich-editor.md, 4.4).
(() => {
  // Keep equal to MAX_SOURCE in mermaid-view.js (the parent does not send longer sources).
  const MAX_SOURCE = 20000;
  const out = document.getElementById('out');
  let busy = false;

  function reply(message) {
    window.parent.postMessage(message, '*');
  }

  function valid(data) {
    return !!data && typeof data === 'object'
      && data.type === 'dg-mermaid-render'
      && typeof data.id === 'string' && /^[a-z0-9-]{1,40}$/.test(data.id)
      && typeof data.source === 'string' && data.source.length > 0 && data.source.length <= MAX_SOURCE
      && (data.theme === 'light' || data.theme === 'dark');
  }

  // Mermaid directives (%%{init: ...}%%) are dropped so the source cannot change the configuration.
  function cleanSource(source) {
    return source.replace(/%%\{[\s\S]*?\}%%/g, '');
  }

  async function render(data) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: data.theme === 'dark' ? 'dark' : 'default',
      flowchart: { htmlLabels: false },
      maxTextSize: MAX_SOURCE,
    });
    const { svg } = await mermaid.render(`dg-${data.id}`, cleanSource(data.source));
    out.innerHTML = svg;
    const el = out.querySelector('svg');
    const height = Math.ceil(Math.max(el ? el.getBoundingClientRect().height : 0, 1));
    reply({ type: 'dg-mermaid-result', id: data.id, height });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !valid(event.data) || busy) return;
    const data = event.data;
    busy = true;
    render(data)
      .catch((err) => {
        out.textContent = '';
        reply({ type: 'dg-mermaid-result', id: data.id, error: String((err && err.message) || err).slice(0, 300) });
      })
      .finally(() => { busy = false; });
  });

  reply({ type: 'dg-mermaid-ready' });
})();
