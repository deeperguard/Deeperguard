// Freehand drawings in notes (docs/DRAWING_SPEC.md).
// A drawing is a normal PNG attachment with an optional `drawing` metadata field.
// Bytes and metadata are encrypted by the existing attachment layer; nothing here
// talks to the network. Drawing content only goes into DOM nodes via properties.
(() => {
  const MAX_DRAWING_BYTES = 1024 * 1024;
  const MAX_DRAWING_DIM = 2048;
  const MAX_DRAWINGS_PER_NOTE = 10;
  const MAX_DRAWING_BYTES_PER_NOTE = 8 * 1024 * 1024;
  const MIN_PNG_BYTES = 67;
  const MIN_WIDTH = 400;
  const DEFAULT_W = 1200;
  const DEFAULT_H = 800;
  const SCALE_STEPS = [1, 0.75, 0.5];
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const TOO_BIG_MESSAGE = 'Tekening te groot';

  function validatePng(bytes, opts = {}) {
    const maxBytes = opts.maxBytes || MAX_DRAWING_BYTES;
    const maxDim = opts.maxDim || MAX_DRAWING_DIM;
    const fail = (reason) => ({ ok: false, width: 0, height: 0, reason });
    if (!bytes || typeof bytes.length !== 'number') return fail('not-bytes');
    if (bytes.length < MIN_PNG_BYTES) return fail('too-small');
    if (bytes.length > maxBytes) return fail('too-large');
    for (let i = 0; i < PNG_MAGIC.length; i += 1) {
      if (bytes[i] !== PNG_MAGIC[i]) return fail('bad-magic');
    }
    // IHDR chunk: length(4) "IHDR"(4) then width, height big-endian at 16..23.
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
      return fail('bad-ihdr');
    }
    const u32 = (o) => ((bytes[o] * 0x1000000) + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3]);
    const width = u32(16);
    const height = u32(20);
    if (!width || !height || width > maxDim || height > maxDim) return fail('bad-dimensions');
    if (opts.expectW && opts.expectH && (opts.expectW !== width || opts.expectH !== height)) {
      return fail('dimension-mismatch');
    }
    return { ok: true, width, height, reason: '' };
  }

  // Can this attachment content be treated as a drawing? The magic bytes (checked at
  // load) decide; the declared mime must at least say PNG.
  function isDrawingMeta(content) {
    const d = content && content.drawing;
    return !!(content && content.type === 'attachment' && d && typeof d === 'object'
      && content.mime === 'image/png');
  }

  function canEditDrawing(content) {
    return isDrawingMeta(content) && Number(content.drawing.v) === 1;
  }

  // Limits per note. `existing` is a list of { uuid, size } for drawings already on the note.
  function checkNoteLimits(existing, newBytes, replaceUuid) {
    const others = (existing || []).filter((d) => d.uuid !== replaceUuid);
    if (others.length + 1 > MAX_DRAWINGS_PER_NOTE) {
      return { ok: false, reason: `Maximaal ${MAX_DRAWINGS_PER_NOTE} tekeningen per notitie` };
    }
    const total = others.reduce((sum, d) => sum + (Number(d.size) || 0), 0) + newBytes;
    if (total > MAX_DRAWING_BYTES_PER_NOTE) {
      return { ok: false, reason: 'Tekeningen van deze notitie zijn samen te groot (max 8 MB)' };
    }
    return { ok: true, reason: '' };
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob || null), 'image/png');
      } catch (_) {
        resolve(null);
      }
    });
  }

  // Encode as PNG <= maxBytes: 100% -> 75% -> 50% of the size, never below 400 px wide.
  async function fitToLimits(canvas, maxBytes = MAX_DRAWING_BYTES) {
    let w0 = canvas.width;
    let h0 = canvas.height;
    if (w0 > MAX_DRAWING_DIM || h0 > MAX_DRAWING_DIM) {
      const k = MAX_DRAWING_DIM / Math.max(w0, h0);
      w0 = Math.floor(w0 * k);
      h0 = Math.floor(h0 * k);
    }
    for (const step of SCALE_STEPS) {
      const w = Math.round(w0 * step);
      const h = Math.round(h0 * step);
      if (step < 1 && w < MIN_WIDTH) break;
      let source = canvas;
      if (w !== canvas.width || h !== canvas.height) {
        source = document.createElement('canvas');
        source.width = w;
        source.height = h;
        const ctx = source.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(canvas, 0, 0, w, h);
      }
      const blob = await canvasToBlob(source);
      if (!blob) return { ok: false, reason: 'Tekening kon niet worden gemaakt' };
      if (blob.size <= maxBytes) return { ok: true, blob, width: w, height: h };
    }
    return { ok: false, reason: TOO_BIG_MESSAGE };
  }

  const PALETTE = ['#111111', '#c62828', '#1565c0', '#2e7d32'];
  const WIDTHS = [2, 5, 10];

  function createDrawingPad(container, { width = DEFAULT_W, height = DEFAULT_H, background = '#ffffff', label = 'Tekenvlak' } = {}) {
    const w = Math.min(MAX_DRAWING_DIM, Math.max(1, Math.round(width)));
    const h = Math.min(MAX_DRAWING_DIM, Math.max(1, Math.round(height)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.className = 'drawing-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label);
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const MAX_STEPS = 30;
    let undoStack = [];
    let redoStack = [];
    let tool = 'pen';
    let color = PALETTE[0];
    let lineWidth = WIDTHS[1];
    let drawing = false;
    let activeId = null;
    let last = null;
    let dirty = false;
    const onChange = { fn: null };

    const snapshot = () => ctx.getImageData(0, 0, w, h);
    const notify = () => { if (onChange.fn) onChange.fn(); };

    function point(ev) {
      const r = canvas.getBoundingClientRect();
      const sx = r.width ? w / r.width : 1;
      const sy = r.height ? h / r.height : 1;
      return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy, p: ev.pressure };
    }
    function widthFor(pt) {
      const base = tool === 'eraser' ? lineWidth * 3 : lineWidth;
      const pr = pt.p > 0 && pt.p < 1 ? 0.4 + pt.p * 0.9 : 1;
      return base * pr;
    }
    function segment(a, b) {
      ctx.strokeStyle = tool === 'eraser' ? background : color;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = widthFor(b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    function down(ev) {
      if (drawing) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      undoStack.push(snapshot());
      if (undoStack.length > MAX_STEPS) undoStack.shift();
      redoStack = [];
      drawing = true;
      activeId = ev.pointerId;
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic events */ }
      last = point(ev);
      segment(last, last);
      dirty = true;
      notify();
    }
    function move(ev) {
      if (!drawing || ev.pointerId !== activeId) return;
      ev.preventDefault();
      const events = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
      const list = events.length ? events : [ev];
      for (const e of list) {
        const pt = point(e);
        segment(last, pt);
        last = pt;
      }
    }
    function up(ev) {
      if (!drawing || ev.pointerId !== activeId) return;
      drawing = false;
      activeId = null;
      last = null;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    return {
      canvas,
      setTool(t) { tool = t === 'eraser' ? 'eraser' : 'pen'; },
      setColor(c) { if (PALETTE.includes(c)) color = c; },
      setWidth(n) { if (WIDTHS.includes(n)) lineWidth = n; },
      undo() {
        if (!undoStack.length) return false;
        redoStack.push(snapshot());
        ctx.putImageData(undoStack.pop(), 0, 0);
        dirty = true;
        notify();
        return true;
      },
      redo() {
        if (!redoStack.length) return false;
        undoStack.push(snapshot());
        ctx.putImageData(redoStack.pop(), 0, 0);
        dirty = true;
        notify();
        return true;
      },
      clear() {
        undoStack.push(snapshot());
        if (undoStack.length > MAX_STEPS) undoStack.shift();
        redoStack = [];
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
        dirty = true;
        notify();
      },
      // Draw an existing (validated) PNG as background; scaled to the canvas.
      async loadImage(blobUrl) {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('image'));
          img.src = blobUrl;
        });
        ctx.drawImage(img, 0, 0, w, h);
        dirty = false;
      },
      isDirty() { return dirty; },
      onChange(fn) { onChange.fn = fn; },
      async toPngBlob() { return fitToLimits(canvas); },
    };
  }

  function el(tag, props = {}, text) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Modal drawing dialog. Resolves { blob, width, height, alt } on save, null on cancel.
  // opts: { bytes? (validated PNG bytes to edit), width?, height?, alt?, returnFocus?, onError? }
  function showDrawingDialog(opts = {}) {
    return new Promise((resolve) => {
      const returnFocus = opts.returnFocus || document.activeElement;
      const titleId = 'drawing-dialog-title';
      const dialog = el('div', { class: 'scan-dialog drawing-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
      const head = el('header', { class: 'scan-dialog-head' });
      const title = el('h2', { id: titleId, tabindex: '-1' }, opts.bytes ? 'Tekening bewerken' : 'Tekening toevoegen');
      head.appendChild(title);
      const body = el('div', { class: 'scan-dialog-body drawing-body' });
      const bar = el('div', { class: 'drawing-toolbar', role: 'toolbar', 'aria-label': 'Tekengereedschap' });
      const stage = el('div', { class: 'drawing-stage' });
      const altLabel = el('label', { class: 'drawing-alt-label' }, 'Beschrijving (alt-tekst)');
      const altInput = el('input', { type: 'text', class: 'drawing-alt', maxlength: '300', autocomplete: 'off' });
      altInput.value = String(opts.alt || '');
      altLabel.appendChild(altInput);
      const status = el('p', { class: 'muted drawing-status', role: 'status', 'aria-live': 'polite' });
      body.append(bar, stage, altLabel, status);
      const foot = el('footer', { class: 'scan-dialog-foot' });
      const btn = (label, extra = {}) => el('button', { type: 'button', class: 'btn ghost sm', ...extra }, label);
      const pad = createDrawingPad(stage, { width: opts.width || DEFAULT_W, height: opts.height || DEFAULT_H, label: 'Tekenvlak' });
      const penBtn = btn('Pen', { 'aria-pressed': 'true' });
      const eraserBtn = btn('Gum', { 'aria-pressed': 'false' });
      const widthSel = el('select', { 'aria-label': 'Pendikte' });
      [['Dun', 2], ['Normaal', 5], ['Dik', 10]].forEach(([name, val]) => {
        const o = el('option', { value: String(val) }, name);
        if (val === 5) o.selected = true;
        widthSel.appendChild(o);
      });
      const colorSel = el('select', { 'aria-label': 'Kleur' });
      [['Zwart', PALETTE[0]], ['Rood', PALETTE[1]], ['Blauw', PALETTE[2]], ['Groen', PALETTE[3]]].forEach(([name, val]) => {
        colorSel.appendChild(el('option', { value: val }, name));
      });
      const undoBtn = btn('Ongedaan maken');
      const redoBtn = btn('Opnieuw');
      const clearBtn = btn('Wissen');
      bar.append(penBtn, eraserBtn, widthSel, colorSel, undoBtn, redoBtn, clearBtn);
      const cancelBtn = btn('Annuleren');
      const saveBtn = el('button', { type: 'button', class: 'btn sm' }, 'Opslaan');
      foot.append(cancelBtn, saveBtn);
      dialog.append(head, body, foot);

      let blobUrl = '';
      let finished = false;
      const setTool = (t) => {
        pad.setTool(t);
        penBtn.setAttribute('aria-pressed', String(t === 'pen'));
        eraserBtn.setAttribute('aria-pressed', String(t === 'eraser'));
      };
      penBtn.addEventListener('click', () => setTool('pen'));
      eraserBtn.addEventListener('click', () => setTool('eraser'));
      widthSel.addEventListener('change', () => pad.setWidth(Number(widthSel.value)));
      colorSel.addEventListener('change', () => { pad.setColor(colorSel.value); setTool('pen'); });
      undoBtn.addEventListener('click', () => pad.undo());
      redoBtn.addEventListener('click', () => pad.redo());
      clearBtn.addEventListener('click', () => {
        if (window.confirm('Hele tekening wissen?')) pad.clear();
      });

      function close(result) {
        if (finished) return;
        finished = true;
        document.removeEventListener('keydown', onKey, true);
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        dialog.remove();
        if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
        resolve(result);
      }
      function cancel() {
        if (pad.isDirty() && !window.confirm('Niet-opgeslagen wijzigingen weggooien?')) return;
        close(null);
      }
      cancelBtn.addEventListener('click', cancel);
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const fit = await pad.toPngBlob();
          if (!fit.ok) {
            status.textContent = fit.reason;
            if (typeof opts.onError === 'function') opts.onError(fit.reason);
            return;
          }
          close({ blob: fit.blob, width: fit.width, height: fit.height, alt: altInput.value.trim() });
        } finally {
          saveBtn.disabled = false;
        }
      });
      function onKey(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          cancel();
          return;
        }
        if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.target !== altInput) {
          const k = ev.key.toLowerCase();
          if (k === 'z') {
            ev.preventDefault();
            if (ev.shiftKey) pad.redo(); else pad.undo();
          } else if (k === 'y') {
            ev.preventDefault();
            pad.redo();
          }
          return;
        }
        if (ev.key === 'Tab') {
          const items = [...dialog.querySelectorAll('button, select, input')].filter((n) => !n.disabled);
          if (!items.length) return;
          const first = items[0];
          const lastEl = items[items.length - 1];
          if (ev.shiftKey && (document.activeElement === first || document.activeElement === title)) {
            ev.preventDefault();
            lastEl.focus();
          } else if (!ev.shiftKey && document.activeElement === lastEl) {
            ev.preventDefault();
            first.focus();
          }
        }
      }
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(dialog);
      dialog.hidden = false;
      title.focus();
      if (opts.bytes) {
        blobUrl = URL.createObjectURL(new Blob([opts.bytes], { type: 'image/png' }));
        pad.loadImage(blobUrl).catch(() => {
          status.textContent = 'Tekening kon niet worden geladen';
        });
      }
    });
  }

  const api = {
    MAX_DRAWING_BYTES, MAX_DRAWING_DIM, MAX_DRAWINGS_PER_NOTE, MAX_DRAWING_BYTES_PER_NOTE,
    MIN_PNG_BYTES, TOO_BIG_MESSAGE,
    validatePng, isDrawingMeta, canEditDrawing, checkNoteLimits, fitToLimits,
    createDrawingPad, showDrawingDialog,
  };
  if (typeof window !== 'undefined') window.NotesDrawing = api;
  if (typeof globalThis !== 'undefined') globalThis.NotesDrawing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
