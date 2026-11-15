/* Zoom, fit-to-width, page indicator and full-screen controls for the inline
   document viewer (#doc-inline). Same renderer as before: pages stay canvases
   at width 100% of the stage, so zoom is a CSS width on the stage and "fit
   width" is zoom 1. No library, nothing loaded from outside. */
(function (root) {
  'use strict';
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 3;
  const STEP = 1.25;

  function clampZoom(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(n * 100) / 100));
  }

  /* pages: [{ top, bottom }] in viewport coordinates; view: { top, height }.
     The current page is the last one whose top edge passed the upper third. */
  function pageFromScroll(pages, view) {
    if (!pages || !pages.length) return 0;
    const probe = (view?.top || 0) + (view?.height || 0) / 3;
    let current = 1;
    for (let i = 0; i < pages.length; i += 1) {
      if (pages[i].top <= probe) current = i + 1;
      else break;
    }
    return current;
  }

  function button(doc, cls, label, text) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `btn ghost sm doc-inline-ctl ${cls}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.textContent = text;
    return btn;
  }

  function attach({ card, stage, scroller, doc = root.document } = {}) {
    if (!card || !stage || !doc) return null;
    if (scroller && scroller._docControls) scroller._docControls.destroy();
    const bar = doc.createElement('div');
    bar.className = 'doc-inline-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Document viewer controls');
    const out = button(doc, 'doc-ctl-zoom-out', 'Zoom out', '−');
    const level = doc.createElement('span');
    level.className = 'doc-inline-zoom-level';
    const zin = button(doc, 'doc-ctl-zoom-in', 'Zoom in', '+');
    const fit = button(doc, 'doc-ctl-fit', 'Fit to width', 'Fit width');
    const pageEl = doc.createElement('span');
    pageEl.className = 'doc-inline-page';
    pageEl.setAttribute('role', 'status');
    pageEl.setAttribute('aria-live', 'polite');
    pageEl.title = 'Page';
    const fsBtn = button(doc, 'doc-ctl-fullscreen', 'Full screen', 'Full screen');
    const canFs = typeof card.requestFullscreen === 'function' && doc.fullscreenEnabled !== false;
    [out, level, zin, fit, pageEl].forEach((el) => bar.appendChild(el));
    if (canFs) bar.appendChild(fsBtn);
    card.insertBefore ? card.insertBefore(bar, card.firstChild) : card.appendChild(bar);

    let zoom = 1;
    let destroyed = false;
    const listeners = [];
    function on(target, type, fn) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(type, fn, type === 'scroll' ? { passive: true } : undefined);
      listeners.push([target, type, fn]);
    }
    function isFullscreen() {
      return doc.fullscreenElement === card;
    }
    function view() {
      const el = isFullscreen() || !scroller ? card : scroller;
      const rect = el.getBoundingClientRect();
      return { top: rect.top, height: rect.height || el.clientHeight || 0 };
    }
    function update() {
      if (destroyed) return;
      if (card.isConnected === false) { destroy(); return; }
      const wraps = [...stage.querySelectorAll('.doc-page-wrap')];
      const total = wraps.length;
      if (total) {
        const pages = wraps.map((w) => {
          const r = w.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        });
        const n = pageFromScroll(pages, view());
        pageEl.textContent = `${n} / ${total}`;
        pageEl.setAttribute('aria-label', `Page ${n} of ${total}`);
        pageEl.hidden = false;
      } else {
        pageEl.textContent = '';
        pageEl.hidden = true;
      }
      level.textContent = `${Math.round(zoom * 100)}%`;
      out.disabled = zoom <= MIN_ZOOM;
      zin.disabled = zoom >= MAX_ZOOM;
      const full = isFullscreen();
      fsBtn.setAttribute('aria-pressed', full ? 'true' : 'false');
      const label = full ? 'Exit full screen' : 'Full screen';
      fsBtn.title = label;
      fsBtn.setAttribute('aria-label', label);
      fsBtn.textContent = label;
    }
    function setZoom(next) {
      zoom = clampZoom(next);
      stage.style.setProperty
        ? stage.style.setProperty('--doc-inline-zoom', String(zoom))
        : (stage.style['--doc-inline-zoom'] = String(zoom));
      stage.style.width = `${Math.round(zoom * 100)}%`;
      card.dataset.zoom = String(zoom);
      update();
      return zoom;
    }
    function toggleFullscreen() {
      if (isFullscreen()) {
        return Promise.resolve(doc.exitFullscreen && doc.exitFullscreen());
      }
      return Promise.resolve(card.requestFullscreen()).catch(() => {});
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.forEach(([t, type, fn]) => t.removeEventListener && t.removeEventListener(type, fn));
      if (observer) observer.disconnect();
      if (isFullscreen() && doc.exitFullscreen) {
        try { Promise.resolve(doc.exitFullscreen()).catch(() => {}); } catch (err) { /* ignore */ }
      }
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      if (scroller && scroller._docControls === api) scroller._docControls = null;
    }

    on(out, 'click', () => setZoom(zoom / STEP));
    on(zin, 'click', () => setZoom(zoom * STEP));
    on(fit, 'click', () => {
      setZoom(1);
      if (scroller) scroller.scrollLeft = 0;
      if (stage.parentNode) stage.parentNode.scrollLeft = 0;
    });
    on(fsBtn, 'click', () => { toggleFullscreen(); });
    on(scroller, 'scroll', update);
    on(card, 'scroll', update);
    on(doc, 'fullscreenchange', update);
    let observer = null;
    if (typeof root.MutationObserver === 'function') {
      observer = new root.MutationObserver(update);
      observer.observe(stage, { childList: true });
    }
    const api = { zoomIn: () => setZoom(zoom * STEP), zoomOut: () => setZoom(zoom / STEP), fit: () => setZoom(1), toggleFullscreen, update, destroy, getZoom: () => zoom, bar };
    if (scroller) scroller._docControls = api;
    setZoom(1);
    return api;
  }

  root.NotesDocControls = { attach, clampZoom, pageFromScroll, MIN_ZOOM, MAX_ZOOM };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NotesDocControls;
})(typeof window !== 'undefined' ? window : globalThis);
