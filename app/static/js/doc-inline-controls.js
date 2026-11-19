/* Zoom, fit-to-width, page navigation and full-screen controls for the inline
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

  /* Shared with the full preview's page bar: a typed or stepped page number
     becomes a whole page between 1 and total. */
  function clampPage(target, total) {
    return Math.min(total, Math.max(1, Math.round(Number(target)) || 1));
  }

  function isTextEntry(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
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
    const nav = doc.createElement('div');
    nav.className = 'doc-inline-pagenav';
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', 'Page navigation');
    nav.hidden = true;
    const prev = button(doc, 'doc-ctl-prev', 'Previous page', '‹');
    const next = button(doc, 'doc-ctl-next', 'Next page', '›');
    prev.classList.remove('doc-inline-ctl');
    next.classList.remove('doc-inline-ctl');
    const jump = doc.createElement('label');
    jump.className = 'doc-inline-jump';
    const lead = doc.createElement('span');
    lead.textContent = 'Page';
    jump.appendChild(lead);
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'doc-inline-page-input';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('pattern', '[0-9]*');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('enterkeyhint', 'go');
    jump.appendChild(input);
    const totalEl = doc.createElement('span');
    totalEl.className = 'doc-inline-page-total';
    const mid = doc.createElement('span');
    mid.textContent = 'of';
    jump.appendChild(mid);
    jump.appendChild(totalEl);
    [prev, jump, next].forEach((el) => nav.appendChild(el));
    const status = doc.createElement('span');
    status.className = 'sr-only doc-inline-page-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const fsBtn = button(doc, 'doc-ctl-fullscreen', 'Full screen', 'Full screen');
    const canFs = typeof card.requestFullscreen === 'function' && doc.fullscreenEnabled !== false;
    [out, level, zin, fit, pageEl, nav, status].forEach((el) => bar.appendChild(el));
    if (canFs) bar.appendChild(fsBtn);
    card.insertBefore ? card.insertBefore(bar, card.firstChild) : card.appendChild(bar);

    let zoom = 1;
    let destroyed = false;
    let page = 0;
    let editing = false;
    let hovering = false;
    let pinnedTop = null;
    let announceTimer = null;
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
    function scrollEl() {
      return isFullscreen() || !scroller ? card : scroller;
    }
    function wrapsNow() {
      return [...stage.querySelectorAll('.doc-page-wrap')];
    }
    function announce(delay) {
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        announceTimer = null;
        if (!destroyed && !nav.hidden) status.textContent = `Page ${page} of ${wrapsNow().length}`;
      }, delay);
    }
    function setPage(n, delay) {
      const changed = n !== page;
      page = n;
      update();
      if (changed) announce(delay);
    }
    /* Only scrollTop of the container that really scrolls changes, so zoom and
       the sideways position stay. The sticky bar covers the top edge. */
    function goToPage(target) {
      const wraps = wrapsNow();
      if (wraps.length < 2) return;
      const n = clampPage(target, wraps.length);
      const el = scrollEl();
      const barH = bar.getBoundingClientRect().height || 0;
      el.scrollTop += wraps[n - 1].getBoundingClientRect().top - el.getBoundingClientRect().top - barH;
      pinnedTop = el.scrollTop;
      setPage(n, 0);
    }
    function stepPage(delta) {
      goToPage((page || 1) + delta);
    }
    function commitInput(explicit) {
      editing = false;
      const raw = input.value.trim();
      const wanted = Number.parseInt(raw, 10);
      if (!Number.isFinite(wanted) || (!explicit && raw === String(page))) {
        input.value = String(page);
        return;
      }
      goToPage(wanted);
      // Announced even when the typed number is the current page.
      announce(0);
      input.value = String(page);
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
        // A jump to the last pages may not reach the top: keep the chosen page
        // until the user scrolls away from where the jump left the container.
        if (pinnedTop !== null && Math.abs(scrollEl().scrollTop - pinnedTop) < 2 && page >= 1 && page <= total) {
          // keep page
        } else {
          pinnedTop = null;
          const seen = pageFromScroll(pages, view());
          const moved = page > 0 && seen !== page;
          page = seen;
          if (moved) announce(400);
        }
        const n = page;
        pageEl.textContent = `${n} / ${total}`;
        pageEl.setAttribute('aria-label', `Page ${n} of ${total}`);
        pageEl.hidden = total > 1;
        nav.hidden = total < 2;
        totalEl.textContent = String(total);
        input.setAttribute('aria-label', `Page number, 1 to ${total}`);
        if (!editing) input.value = String(n);
        const focused = doc.activeElement;
        prev.disabled = n <= 1;
        next.disabled = n >= total;
        // A button that turns disabled under focus hands focus to the other one.
        if (focused === prev && prev.disabled) next.focus();
        else if (focused === next && next.disabled) prev.focus();
      } else {
        pageEl.textContent = '';
        pageEl.hidden = true;
        nav.hidden = true;
        page = 0;
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
      clearTimeout(announceTimer);
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
    on(prev, 'click', () => stepPage(-1));
    on(next, 'click', () => stepPage(1));
    on(input, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commitInput(true);
    });
    on(input, 'input', () => { editing = true; });
    on(input, 'change', () => commitInput(false));
    on(input, 'blur', () => {
      editing = false;
      if (page) input.value = String(page);
    });
    on(card, 'mouseenter', () => { hovering = true; });
    on(card, 'mouseleave', () => { hovering = false; });
    on(doc, 'keydown', (event) => {
      if (destroyed || nav.hidden || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTextEntry(event.target)) return;
      const overlay = doc.getElementById && doc.getElementById('doc-viewer');
      if (overlay && !overlay.hidden) return;
      const confirmDialog = doc.getElementById && doc.getElementById('confirm-dialog');
      if (confirmDialog && !confirmDialog.hidden) return;
      const inside = card.contains ? card.contains(doc.activeElement) : false;
      if (!(isFullscreen() || hovering || inside)) return;
      const total = wrapsNow().length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // Zoomed wider than the view: scroll sideways instead of turning the page.
        const sideways = [scrollEl(), stage.parentNode, scroller].find((el) => el && el.scrollWidth > el.clientWidth + 1);
        if (zoom > 1.02 && sideways) {
          event.preventDefault();
          sideways.scrollLeft += event.key === 'ArrowLeft' ? -80 : 80;
          return;
        }
      }
      const steps = { ArrowLeft: -1, PageUp: -1, ArrowRight: 1, PageDown: 1 };
      if (Object.prototype.hasOwnProperty.call(steps, event.key)) {
        event.preventDefault();
        stepPage(steps[event.key]);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        goToPage(event.key === 'Home' ? 1 : total);
      }
    });
    on(scroller, 'scroll', update);
    on(card, 'scroll', update);
    on(doc, 'fullscreenchange', update);
    let observer = null;
    if (typeof root.MutationObserver === 'function') {
      observer = new root.MutationObserver(update);
      observer.observe(stage, { childList: true });
    }
    const api = { goToPage, getPage: () => page, zoomIn: () => setZoom(zoom * STEP), zoomOut: () => setZoom(zoom / STEP), fit: () => setZoom(1), toggleFullscreen, update, destroy, getZoom: () => zoom, bar };
    if (scroller) scroller._docControls = api;
    setZoom(1);
    return api;
  }

  root.NotesDocControls = { attach, clampZoom, pageFromScroll, clampPage, MIN_ZOOM, MAX_ZOOM };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NotesDocControls;
})(typeof window !== 'undefined' ? window : globalThis);
