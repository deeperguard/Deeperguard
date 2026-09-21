const NotesPreview = (() => {
  const IS_IOS = typeof navigator !== 'undefined'
    && (/iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  // iOS Safari enforces a hard total canvas budget (~224MB). 24 pages at 3x DPR
  // plus pixel snapshots exceeded it and crash-looped the tab.
  const MAX_PDF_PAGES = IS_IOS ? 6 : 24;
  const MAX_PAGE_DPR = IS_IOS ? 1.25 : 3;
  const MAX_CANVAS_PIXELS = IS_IOS ? 1800000 : 9000000;
  const MAX_SNAPSHOT_PIXELS = IS_IOS ? 1200000 : 6000000;
  const PDF_SRC = '/static/js/vendor/pdfjs/pdf.min.js?v=8';
  const PDF_WORKER = '/static/js/vendor/pdfjs/pdf.worker.min.js?v=8';
  let workerBlobUrl = '';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new Error('PDF engine needs a browser'));
        return;
      }
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
  }

  function preferDisableWorker() {
    if (typeof window !== 'undefined' && typeof window.notesNetworkReachable === 'function') {
      return !window.notesNetworkReachable();
    }
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  async function resolveWorkerSrc() {
    if (workerBlobUrl) return workerBlobUrl;
    if (typeof fetch !== 'function') return PDF_WORKER;
    const res = await fetch(PDF_WORKER, { cache: 'force-cache' });
    if (!res.ok) throw new Error('PDF worker is not cached. Open the app once online.');
    const raw = await res.blob();
    const blob = raw.type ? raw : new Blob([raw], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
    return workerBlobUrl;
  }

  async function ensurePdf() {
    if (globalThis.pdfjsLib && globalThis.pdfjsLib.getDocument) {
      try {
        globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = await resolveWorkerSrc();
      } catch (err) {
        globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
      }
      return globalThis.pdfjsLib;
    }
    await loadScript(PDF_SRC);
    const lib = globalThis.pdfjsLib;
    if (!lib || !lib.getDocument) throw new Error('PDF engine failed to load. Open the app once online.');
    try {
      lib.GlobalWorkerOptions.workerSrc = await resolveWorkerSrc();
    } catch (err) {
      lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    }
    return lib;
  }

  function kindFromMeta(mime, filename) {
    const type = String(mime || '').toLowerCase();
    const name = String(filename || '');
    if (type.startsWith('text/') || /\.(txt|md|csv|json|log)$/i.test(name)) return 'text';
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
    if (/^image\/(png|jpe?g|webp|gif|bmp|svg\+xml)$/i.test(type) || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name)) {
      return 'image';
    }
    return 'other';
  }

  function asUint8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    return new Uint8Array(bytes || []);
  }

  function looksLikeTextBytes(bytes) {
    const u8 = asUint8(bytes);
    if (!u8.length) return false;
    if (u8.length >= 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return false;
    if (u8.length >= 2 && ((u8[0] === 0xFF && u8[1] === 0xFE) || (u8[0] === 0xFE && u8[1] === 0xFF))) return true;
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return true;
    const sample = Math.min(u8.length, 4096);
    let nulls = 0;
    let ctrl = 0;
    let printable = 0;
    for (let i = 0; i < sample; i += 1) {
      const b = u8[i];
      if (b === 0) nulls += 1;
      else if (b < 9 || (b > 13 && b < 32)) ctrl += 1;
      else printable += 1;
    }
    if (nulls > sample * 0.05) return false;
    return printable / sample > 0.85 && ctrl / sample < 0.05;
  }

  function decodeText(bytes) {
    const u8 = asUint8(bytes);
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(u8.slice(2));
    }
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(u8.slice(2));
    }
    const hasUtf8Bom = u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF;
    const body = hasUtf8Bom ? u8.slice(3) : u8;
    const utf8 = new TextDecoder('utf-8').decode(body);
    const bad = (utf8.match(/\uFFFD/g) || []).length;
    if (bad > Math.max(2, utf8.length * 0.02)) {
      try {
        return new TextDecoder('windows-1252').decode(body);
      } catch (_) {
        return new TextDecoder('iso-8859-1').decode(body);
      }
    }
    return utf8;
  }

  function resolveKind(mime, filename, bytes) {
    const kind = kindFromMeta(mime, filename);
    if (kind !== 'other') return kind;
    const name = String(filename || '');
    if (/\.(exe|dll|bin|zip|gz|tar|7z|html?|wasm|dmg|pkg|deb|rpm|msi|apk|pdf)$/i.test(name)) return 'other';
    if (asUint8(bytes).length < 8) return 'other';
    return looksLikeTextBytes(bytes) ? 'text' : 'other';
  }

  function escapeTextHtml(text) {
    if (typeof NotesSanitize !== 'undefined' && NotesSanitize.escapeHtml) {
      return NotesSanitize.escapeHtml(text);
    }
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderTextPreview(container, bytes, query) {
    if (!container) return;
    const pre = document.createElement('pre');
    const text = decodeText(bytes);
    const needle = String(query || '').trim();
    pre.innerHTML = needle && typeof NotesSearch !== 'undefined' && NotesSearch.highlightPlain
      ? NotesSearch.highlightPlain(text, needle)
      : escapeTextHtml(text);
    container.replaceChildren(pre);
  }

  function blobFor(bytes, mime) {
    return new Blob([asUint8(bytes)], { type: mime || 'application/octet-stream' });
  }

  function blobUrl(bytes, mime) {
    return URL.createObjectURL(blobFor(bytes, mime));
  }

  async function openPdf(bytes) {
    const lib = await ensurePdf();
    const data = asUint8(bytes).slice();
    const offline = preferDisableWorker();
    if (!offline) {
      try {
        return await lib.getDocument({ data, useWorkerFetch: false }).promise;
      } catch (err) {
        /* fall through to main-thread rendering */
      }
    }
    try {
      return await lib.getDocument({
        data: data.slice(),
        disableWorker: true,
        useWorkerFetch: false,
      }).promise;
    } catch (err) {
      throw new Error('PDF preview needs the local PDF engine. Open the app once online.');
    }
  }

  function findRanges(text, query) {
    if (typeof NotesSearch !== 'undefined' && NotesSearch.findMatches) {
      return NotesSearch.findMatches(text, query);
    }
    const source = String(text || '');
    const needle = String(query || '');
    if (!needle) return [];
    const hay = source.toLowerCase();
    const find = needle.toLowerCase();
    const out = [];
    let from = 0;
    while (from <= hay.length - find.length) {
      const at = hay.indexOf(find, from);
      if (at < 0) break;
      out.push({ start: at, end: at + needle.length });
      from = at + Math.max(needle.length, 1);
    }
    return out;
  }

  function itemString(item) {
    return String(item && item.str != null ? item.str : '');
  }

  function joinTextItems(items) {
    let text = '';
    const spans = [];
    let prevRight = null;
    let prevStr = '';
    (items || []).forEach((item, index) => {
      const str = itemString(item);
      const tm = item && item.transform ? item.transform : [];
      const x = Number(tm[4]) || 0;
      const width = Number(item && item.width) || 0;
      const fontH = Math.hypot(Number(tm[2]) || 0, Number(tm[3]) || 0) || Number(item && item.height) || 10;
      if (item && item.hasEOL && text && !/\n$/.test(text)) {
        text += '\n';
        prevRight = null;
      } else if (text && prevStr && !/\s$/.test(prevStr) && str && !/^\s/.test(str) && prevRight != null) {
        const gap = x - prevRight;
        if (gap > fontH * 0.2) text += ' ';
      }
      const start = text.length;
      text += str;
      spans.push({ index, start, end: text.length });
      prevStr = str;
      prevRight = x + width;
    });
    return { text, spans };
  }

  function addRangeHits(hits, spans, ranges) {
    spans.forEach((span) => {
      if (span.end <= span.start) return;
      if (ranges.some((range) => range.start < span.end && range.end > span.start)) hits.add(span.index);
    });
  }

  function matchTextItems(items, query) {
    const list = items || [];
    const hits = new Set();
    const spaced = joinTextItems(list);
    addRangeHits(hits, spaced.spans, findRanges(spaced.text, query));
    if (hits.size) return hits;
    let cursor = 0;
    const tightSpans = list.map((item, index) => {
      const start = cursor;
      cursor += itemString(item).length;
      return { index, start, end: cursor };
    });
    addRangeHits(hits, tightSpans, findRanges(list.map(itemString).join(''), query));
    if (hits.size) return hits;
    const collapsed = spaced.text.replace(/\s+/g, '');
    const collapsedNeedle = String(query || '').replace(/\s+/g, '');
    if (collapsedNeedle && findRanges(collapsed, collapsedNeedle).length) {
      addRangeHits(hits, spaced.spans, findRanges(spaced.text.replace(/\s+/g, ' '), query));
      if (!hits.size) {
        list.forEach((item, index) => {
          const word = itemString(item).replace(/\s+/g, '');
          if (word && (collapsedNeedle.includes(word) || word.toLowerCase().includes(collapsedNeedle.toLowerCase()))) {
            hits.add(index);
          }
        });
      }
    }
    return hits;
  }

  function matchOcrBoxes(boxes, query, page) {
    const list = (boxes || []).filter((box) => {
      if (page == null) return true;
      return (Number(box.page) || 0) === page;
    });
    if (!list.length) return [];
    const needle = String(query || '').trim();
    if (!needle) return [];
    const parts = [];
    const spans = [];
    list.forEach((box) => {
      const word = String(box.text || '');
      if (parts.length) parts.push(' ');
      const start = parts.join('').length;
      parts.push(word);
      spans.push({ box, start, end: start + word.length });
    });
    const ranges = findRanges(parts.join(''), needle);
    if (ranges.length) {
      return spans
        .filter((span) => ranges.some((range) => range.start < span.end && range.end > span.start))
        .map((span) => span.box);
    }
    const find = needle.toLowerCase();
    return list.filter((box) => {
      const word = String(box.text || '');
      const hay = word.toLowerCase();
      return hay.includes(find) || findRanges(word, needle).length > 0;
    });
  }

  function matchOcrBoxesLoose(boxes, query, page) {
    const list = (boxes || []).filter((box) => {
      if (page == null) return true;
      return (Number(box.page) || 0) === page;
    });
    const words = String(query || '').trim().toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    if (!words.length) return [];
    return list.filter((box) => {
      const hay = String(box.text || '').toLowerCase();
      return words.some((word) => hay.includes(word));
    });
  }

  function pickOcrHits(boxes, query, page) {
    const strict = matchOcrBoxes(boxes, query, page);
    if (strict.length) return strict;
    return matchOcrBoxesLoose(boxes, query, page);
  }

  const MIN_HIT_W = 0.008;
  const MIN_HIT_H = 0.012;
  const PDF_TEXT_ASCENT = 0.82;

  function hitWidthFraction(spanWidthFraction) {
    const spanW = Math.max(0, Number(spanWidthFraction) || 0);
    if (!spanW) return MIN_HIT_W;
    return Math.max(MIN_HIT_W, spanW * 0.985);
  }

  function multiplyMatrix(m1, m2) {
    const Util = globalThis.pdfjsLib?.Util;
    if (Util && typeof Util.transform === 'function') {
      return Util.transform(m1, m2);
    }
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  function itemBounds(viewport, item) {
    const tm = item.transform || [1, 0, 0, 1, 0, 0];
    const text = itemString(item);
    // pdf.js exposes both transform and convertToViewportPoint; the matrix path
    // misaligns when multiplied manually, so prefer the official conversion API.
    if (viewport && typeof viewport.convertToViewportPoint === 'function') {
      const fontHeight = Math.max(4, Math.hypot(tm[2], tm[3]) || Number(item.height) || 10);
      const scaleX = Math.hypot(tm[0], tm[1]) || 1;
      const rawWidth = Number(item.width) > 0
        ? item.width
        : Math.max(fontHeight, Math.max(text.length, 1) * 0.55);
      const x = tm[4] || 0;
      const y = tm[5] || 0;
      const [left, baselineY] = viewport.convertToViewportPoint(x, y);
      const [right] = viewport.convertToViewportPoint(x + rawWidth, y);
      const [, topY] = viewport.convertToViewportPoint(x, y + fontHeight);
      const top = Math.min(topY, baselineY);
      const bottom = Math.max(topY, baselineY);
      const width = Number(item.width) > 0
        ? Math.abs(right - left)
        : Math.max(4, rawWidth * scaleX);
      return {
        left: Math.min(left, right),
        top,
        width: Math.max(4, width),
        height: Math.max(4, (bottom - top) * PDF_TEXT_ASCENT),
      };
    }
    if (viewport?.transform) {
      const tx = multiplyMatrix(viewport.transform, tm);
      const fontHeight = Math.max(4, Math.hypot(tx[2], tx[3]) || Number(item.height) || 10);
      const scaleX = Math.hypot(tx[0], tx[1]) || 1;
      const ascent = fontHeight * PDF_TEXT_ASCENT;
      const width = Number(item.width) > 0
        ? item.width * scaleX
        : Math.max(fontHeight, scaleX * Math.max(text.length, 1) * 0.55);
      return {
        left: tx[4],
        top: tx[5] - ascent,
        width: Math.max(4, width),
        height: Math.max(4, ascent),
      };
    }
    const fontHeight = Math.max(4, Math.hypot(tm[2], tm[3]) || Number(item.height) || 10);
    const scaleX = Math.hypot(tm[0], tm[1]) || 1;
    const ascent = fontHeight * PDF_TEXT_ASCENT;
    const width = Number(item.width) > 0
      ? item.width * scaleX
      : Math.max(fontHeight, scaleX * Math.max(text.length, 1) * 0.55);
    return {
      left: tm[4] || 0,
      top: (tm[5] || 0) - ascent,
      width: Math.max(4, width),
      height: Math.max(4, ascent),
    };
  }

  function hitPct(value) {
    const n = Math.max(0, Number(value) || 0) * 100;
    return `${Math.round(n * 1000) / 1000}%`;
  }

  function appendHitSpan(layer, l, t, w, h) {
    const mark = document.createElement('span');
    mark.className = 'doc-search-hit';
    const left = Math.max(0, Number(l));
    const top = Math.max(0, Number(t));
    const rawW = Math.max(0, Number(w) || 0);
    const rawH = Math.max(0, Number(h) || 0);
    mark.style.left = hitPct(left);
    mark.style.top = hitPct(top);
    mark.style.width = hitPct(Math.max(MIN_HIT_W, rawW));
    mark.style.height = hitPct(Math.max(MIN_HIT_H, rawH));
    layer.appendChild(mark);
  }

  function pdfRectsLookValid(rects) {
    if (!Array.isArray(rects) || !rects.length) return false;
    return rects.every((rect) => {
      const l = Number(rect.l) || 0;
      const t = Number(rect.t) || 0;
      const w = Number(rect.w) || 0;
      const h = Number(rect.h) || 0;
      return l >= 0 && l <= 1 && t >= 0 && t <= 1 && w > 0 && h > 0 && l + w <= 1.02;
    });
  }

  function ensureHitLayer(wrap) {
    let layer = wrap.querySelector('.doc-text-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'doc-text-layer';
      wrap.appendChild(layer);
    }
    return layer;
  }

  function rectsForSpanRange(viewport, items, span, range, pageWidth, pageHeight) {
    const overlapStart = Math.max(range.start, span.start);
    const overlapEnd = Math.min(range.end, span.end);
    if (overlapEnd <= overlapStart) return [];
    const item = items[span.index];
    if (!item) return [];
    const width = pageWidth || 1;
    const height = pageHeight || 1;
    const text = itemString(item);
    const box = itemBounds(viewport, item);
    const spanLen = Math.max(1, span.end - span.start);
    const localStart = overlapStart - span.start;
    const localEnd = overlapEnd - span.start;
    const textLen = Math.max(1, text.length);
    const charStart = Math.min(textLen - 1, Math.floor((localStart / spanLen) * textLen));
    const charEnd = Math.max(charStart + 1, Math.ceil((localEnd / spanLen) * textLen));
    return [{
      l: (box.left + (box.width * charStart / textLen)) / width,
      t: box.top / height,
      w: hitWidthFraction((box.width * (charEnd - charStart) / textLen) / width),
      h: box.height / height,
    }];
  }

  function pdfTextHitRects(viewport, items, query, pageWidth, pageHeight) {
    const list = items || [];
    const needle = String(query || '').trim();
    if (!needle || !list.length) return [];
    const joined = joinTextItems(list);
    const ranges = findRanges(joined.text, needle);
    if (ranges.length) {
      const rects = [];
      ranges.forEach((range) => {
        joined.spans.forEach((span) => {
          rects.push(...rectsForSpanRange(viewport, list, span, range, pageWidth, pageHeight));
        });
      });
      if (rects.length) return rects;
    }
    const hits = matchTextItems(list, needle);
    if (!hits.size) return [];
    const width = pageWidth || 1;
    const height = pageHeight || 1;
    const rects = [];
    hits.forEach((index) => {
      const item = list[index];
      if (!item) return;
      const box = itemBounds(viewport, item);
      const text = itemString(item);
      const direct = findRanges(text, needle);
      if (text.length && direct.length) {
        direct.forEach((range) => {
          const start = Math.max(0, Math.min(text.length, range.start));
          const end = Math.max(start + 1, Math.min(text.length, range.end));
          rects.push({
            l: (box.left + (box.width * start / text.length)) / width,
            t: box.top / height,
            w: hitWidthFraction((box.width * (end - start) / text.length) / width),
            h: box.height / height,
          });
        });
      } else {
        rects.push({
          l: box.left / width,
          t: box.top / height,
          w: box.width / width,
          h: box.height / height,
        });
      }
    });
    return rects;
  }

  function ocrHitRects(boxes, query, page) {
    const list = (boxes || []).filter((box) => {
      if (page == null) return true;
      return (Number(box.page) || 0) === page;
    });
    const needle = String(query || '').trim();
    if (!list.length || !needle) return [];
    const parts = [];
    const spans = [];
    list.forEach((box) => {
      const word = String(box.text || '');
      if (parts.length) parts.push(' ');
      const start = parts.join('').length;
      parts.push(word);
      spans.push({ box, start, end: start + word.length });
    });
    const ranges = findRanges(parts.join(''), needle);
    if (!ranges.length) {
      return pickOcrHits(list, needle, null).map((box) => ({
        l: Number(box.l) || 0,
        t: Number(box.t) || 0,
        w: Number(box.w) || 0,
        h: Number(box.h) || 0,
      }));
    }
    const rects = [];
    ranges.forEach((range) => {
      spans.forEach((span) => {
        const overlapStart = Math.max(range.start, span.start);
        const overlapEnd = Math.min(range.end, span.end);
        if (overlapEnd <= overlapStart) return;
        const spanLen = Math.max(1, span.end - span.start);
        const box = span.box;
        const bw = Number(box.w) || 0;
        const bl = Number(box.l) || 0;
        const localStart = (overlapStart - span.start) / spanLen;
        const localEnd = (overlapEnd - span.start) / spanLen;
        rects.push({
          l: bl + bw * localStart,
          t: Number(box.t) || 0,
          w: Math.max(MIN_HIT_W, bw * (localEnd - localStart)),
          h: Number(box.h) || 0,
        });
      });
    });
    return rects;
  }

  function rememberPdfHits(wrap, rects) {
    if (!wrap) return;
    wrap._pdfHitRects = Array.isArray(rects) ? rects : [];
  }

  function paintRects(layer, rects) {
    (rects || []).forEach((rect) => appendHitSpan(layer, rect.l, rect.t, rect.w, rect.h));
    return (rects || []).length;
  }

  function paintOcrBoxesDom(layer, boxes, query, page) {
    const rects = ocrHitRects(boxes, query, page);
    rects.forEach((rect) => appendHitSpan(layer, rect.l, rect.t, rect.w, rect.h));
    return rects.length;
  }

  function boxesMatchQuery(boxes, query, page = null) {
    return pickOcrHits(boxes, query, page).length > 0;
  }

  function paintWrapSearchHits(wrap, boxes, query, page = 0) {
    if (!wrap || !String(query || '').trim()) return 0;
    const img = wrap.querySelector('img');
    const pageCanvas = wrap.querySelector('canvas.doc-page');
    const width = img?.naturalWidth || pageCanvas?.width || 0;
    const height = img?.naturalHeight || pageCanvas?.height || 0;
    const layoutWidth = img?.clientWidth || pageCanvas?.clientWidth || width;
    const layoutHeight = img?.clientHeight || pageCanvas?.clientHeight || height;
    if (layoutWidth && layoutHeight) sizeWrap(wrap, layoutWidth, layoutHeight);
    else if (width && height) sizeWrap(wrap, width, height);
    wrap.querySelector('.doc-hit-canvas')?.remove();
    const layer = ensureHitLayer(wrap);
    layer.replaceChildren();
    const pdfRects = pdfRectsLookValid(wrap._pdfHitRects) ? wrap._pdfHitRects : [];
    let painted = paintRects(layer, pdfRects);
    if (!painted) painted = paintOcrBoxesDom(layer, boxes, query, page);
    if (!painted) layer.remove();
    else markWrapHits(wrap, painted);
    return painted;
  }

  function repaintAllSearchHits(container, boxes, query) {
    if (!container || !String(query || '').trim()) return 0;
    let total = 0;
    container.querySelectorAll('.doc-page-wrap').forEach((wrap, index) => {
      total += paintWrapSearchHits(wrap, boxes, query, index);
    });
    return total;
  }

  function listSearchHits(container) {
    if (!container) return [];
    const root = container.querySelector?.('.doc-zoom-layer') || container;
    const painted = [...root.querySelectorAll('.doc-search-hit')];
    if (painted.length) return painted;
    const ocrMarks = [...root.querySelectorAll('.doc-ocr-hits mark.search-hit')];
    if (ocrMarks.length) return ocrMarks;
    return [...root.querySelectorAll('pre mark.search-hit')];
  }

  function countStoredSearchHits(container) {
    if (!container) return 0;
    const root = container.querySelector?.('.doc-zoom-layer') || container;
    const dom = listSearchHits(root).length;
    if (dom) return dom;
    let stored = 0;
    const wraps = new Set();
    if (root.classList?.contains('doc-page-wrap')) wraps.add(root);
    root.querySelectorAll('.doc-page-wrap').forEach((wrap) => wraps.add(wrap));
    wraps.forEach((wrap) => {
      stored += Array.isArray(wrap._pdfHitRects) ? wrap._pdfHitRects.length : 0;
    });
    return stored;
  }

  function markActiveSearchHit(container, index) {
    const hits = listSearchHits(container);
    hits.forEach((el, i) => {
      el.classList.toggle('doc-search-hit-current', i === index);
      el.classList.toggle('search-hit-current', i === index);
    });
    return hits[index] || hits[0] || null;
  }

  function hitSummary(container) {
    if (!container) return { count: 0, page: 0, pages: 0 };
    const wraps = [...container.querySelectorAll('.doc-page-wrap')];
    const marks = listSearchHits(container);
    let page = 0;
    const first = marks[0];
    if (first && wraps.length) {
      const wrap = first.closest('.doc-page-wrap');
      const idx = wrap ? wraps.indexOf(wrap) : -1;
      page = idx >= 0 ? idx + 1 : 0;
    } else {
      for (let i = 0; i < wraps.length; i += 1) {
        if (wraps[i].querySelector('.doc-search-hit')) {
          page = i + 1;
          break;
        }
      }
    }
    return { count: marks.length, page, pages: wraps.length };
  }

  function scrollableAncestors(el) {
    const out = [];
    let node = el?.parentElement;
    while (node && node !== document.body) {
      const style = globalThis.getComputedStyle ? getComputedStyle(node) : null;
      const overflowY = style ? style.overflowY : '';
      if ((overflowY === 'auto' || overflowY === 'scroll')
        && node.scrollHeight > node.clientHeight + 4) {
        out.push(node);
      }
      node = node.parentElement;
    }
    return out;
  }

  function centerWithin(scroller, target) {
    const hitRect = target.getBoundingClientRect();
    const viewRect = scroller.getBoundingClientRect();
    const delta = (hitRect.top - viewRect.top) - (scroller.clientHeight / 2 - hitRect.height / 2);
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }

  function hitIsOnScreen(container, index = 0) {
    const hits = listSearchHits(container);
    const hit = hits[index] || hits[0];
    if (!hit || typeof hit.getBoundingClientRect !== 'function') return false;
    const rect = hit.getBoundingClientRect();
    if (!(rect.height > 0 || rect.width > 0)) return false;
    const overlaps = (top, bottom) => rect.bottom > top + 4 && rect.top < bottom - 4;
    const scroller = scrollableAncestors(hit)[0];
    if (scroller && typeof scroller.getBoundingClientRect === 'function') {
      const view = scroller.getBoundingClientRect();
      if (overlaps(view.top, view.bottom)) return true;
    }
    const viewportH = globalThis.innerHeight || 0;
    if (!viewportH) return true;
    return overlaps(0, viewportH);
  }

  function hitNoteHost(stage) {
    if (!stage || typeof stage.closest !== 'function') return null;
    return stage.closest('.doc-inline') || stage.closest('.doc-viewer') || null;
  }

  function findStageScroller(container) {
    if (!container) return null;
    if (container.matches?.('.doc-stage, .doc-inline-stage')) return container;
    return container.querySelector?.('.doc-stage, .doc-inline-stage') || null;
  }

  function scrollTargetsForHit(hit, container) {
    const scrollers = scrollableAncestors(hit);
    const stage = findStageScroller(container);
    if (stage && !scrollers.includes(stage)) scrollers.push(stage);
    const host = hitNoteHost(container);
    if (host && host !== stage && !scrollers.includes(host)) {
      const style = globalThis.getComputedStyle ? getComputedStyle(host) : null;
      if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')
        && host.scrollHeight > host.clientHeight + 4) {
        scrollers.push(host);
      }
    }
    return scrollers;
  }

  function ensureVisibleInScroller(scroller, target, margin = 16) {
    if (!scroller || !target) return;
    const targetRect = target.getBoundingClientRect();
    const viewRect = scroller.getBoundingClientRect();
    if (!(targetRect.height > 0 || targetRect.width > 0)) return;
    if (targetRect.top < viewRect.top + margin) {
      scroller.scrollTop += targetRect.top - viewRect.top - margin;
    } else if (targetRect.bottom > viewRect.bottom - margin) {
      scroller.scrollTop += targetRect.bottom - viewRect.bottom + margin;
    }
  }

  function scrollHitIntoView(container, index = 0) {
    const hit = markActiveSearchHit(container, index);
    if (!hit) return false;
    const pageWrap = hit.closest('.doc-page-wrap');
    const scrollers = scrollTargetsForHit(hit, container);
    if (pageWrap) {
      scrollers.forEach((scroller) => ensureVisibleInScroller(scroller, pageWrap, 12));
    }
    scrollers.forEach((scroller) => centerWithin(scroller, hit));
    scrollers.forEach((scroller) => ensureVisibleInScroller(scroller, hit, 24));
    const rect = hit.getBoundingClientRect();
    const viewportH = globalThis.innerHeight || 0;
    if (viewportH && (rect.top < 0 || rect.bottom > viewportH)
      && typeof hit.scrollIntoView === 'function') {
      hit.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return true;
  }

  function scrollHitIntoViewSettled(container, index = 0) {
    if (!container?.isConnected) return false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      scrollHitIntoView(container, index);
      if (hitIsOnScreen(container, index)) return true;
    }
    return hitIsOnScreen(container, index);
  }

  async function scrollHitIntoViewAsync(container, index = 0) {
    if (!container) return false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!container.isConnected) return false;
      scrollHitIntoView(container, index);
      if (hitIsOnScreen(container, index)) return true;
      await new Promise((resolve) => setTimeout(resolve, attempt ? 80 : 0));
    }
    return hitIsOnScreen(container, index);
  }

  function scrollFirstHitIntoView(container) {
    return scrollHitIntoView(container, 0);
  }

  function collectHitRects(wrap, boxes, query, page) {
    const rects = [];
    (wrap && wrap._pdfHitRects ? wrap._pdfHitRects : []).forEach((rect) => {
      if (!rect) return;
      rects.push({
        l: Number(rect.l) || 0,
        t: Number(rect.t) || 0,
        w: Number(rect.w) || 0,
        h: Number(rect.h) || 0,
      });
    });
    ocrHitRects(boxes, query, page).forEach((rect) => {
      rects.push({
        l: Number(rect.l) || 0,
        t: Number(rect.t) || 0,
        w: Number(rect.w) || 0,
        h: Number(rect.h) || 0,
      });
    });
    return rects;
  }

  function drawHitRects(canvas, rects) {
    if (!canvas || typeof canvas.getContext !== 'function') return 0;
    const list = rects || [];
    if (!list.length) return 0;
    const ctx = canvas.getContext('2d');
    const width = canvas.width || 1;
    const height = canvas.height || 1;
    const minW = Math.max(12, width * MIN_HIT_W);
    const minH = Math.max(12, height * MIN_HIT_H);
    ctx.save();
    ctx.strokeStyle = 'rgba(225, 6, 0, 0.9)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    list.forEach((rect) => {
      const w = Math.max(minW, Number(rect.w) * width);
      const h = Math.max(minH, Number(rect.h) * height);
      const x = Math.max(0, Number(rect.l) * width);
      const y = Math.max(0, Number(rect.t) * height);
      const underlineY = y + h;
      ctx.beginPath();
      ctx.moveTo(x, underlineY);
      ctx.lineTo(x + w, underlineY);
      ctx.stroke();
    });
    ctx.restore();
    return list.length;
  }

  function snapshotPageCanvas(canvas) {
    if (!canvas || canvas._cleanPixels || canvas._noSnapshot) return;
    // A snapshot duplicates the full page pixels in JS memory — skip on big
    // canvases or iOS would OOM with a handful of PDF pages.
    if ((canvas.width * canvas.height) > MAX_SNAPSHOT_PIXELS) {
      canvas._noSnapshot = true;
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') {
      canvas._noSnapshot = true;
      return;
    }
    try {
      canvas._cleanPixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      canvas._noSnapshot = true;
    }
  }

  function restorePageCanvas(canvas) {
    if (!canvas || !canvas._cleanPixels) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.putImageData !== 'function') return false;
    try {
      ctx.putImageData(canvas._cleanPixels, 0, 0);
      return true;
    } catch (err) {
      return false;
    }
  }

  function inkPageCanvas(canvas, rects) {
    if (!canvas) return 0;
    if (!canvas._inked) snapshotPageCanvas(canvas);
    else if (!restorePageCanvas(canvas)) return 0;
    drawHitRects(canvas, rects);
    canvas._inked = true;
    return (rects || []).length;
  }

  function paintHitsOnCanvas(canvas, viewport, items, query) {
    if (!canvas || typeof canvas.getContext !== 'function') return 0;
    const hits = matchTextItems(items, query);
    if (!hits.size) return 0;
    const width = canvas.width || 1;
    const height = canvas.height || 1;
    const rects = [];
    hits.forEach((index) => {
      const item = items[index];
      if (!item) return;
      const box = itemBounds(viewport, item);
      rects.push({
        l: box.left / width,
        t: box.top / height,
        w: box.width / width,
        h: box.height / height,
      });
    });
    return drawHitRects(canvas, rects);
  }

  function paintOcrBoxesOnCanvas(canvas, boxes, query, page) {
    const hits = pickOcrHits(boxes, query, page);
    return drawHitRects(canvas, hits);
  }

  function markWrapHits(wrap, count) {
    if (!wrap || !count) return 0;
    wrap.dataset.docHits = String(count);
    return count;
  }

  function sizeWrap(wrap, width, height) {
    if (!wrap || !width || !height) return;
    wrap.style.aspectRatio = `${width} / ${height}`;
  }

  function ensureHitCanvas(wrap, width, height) {
    let overlay = wrap.querySelector('.doc-hit-canvas');
    if (!overlay) {
      overlay = document.createElement('canvas');
      overlay.className = 'doc-hit-canvas';
      wrap.appendChild(overlay);
    }
    if (width && height) {
      overlay.width = Math.max(1, Math.round(width));
      overlay.height = Math.max(1, Math.round(height));
      sizeWrap(wrap, width, height);
    }
    return overlay;
  }

  function overlayOcrHits(container, boxes, query, page = 0) {
    if (!container || !String(query || '').trim()) return 0;
    let wrap = container.matches?.('.doc-page-wrap')
      ? container
      : container.querySelector('.doc-page-wrap');
    if (!wrap) {
      const media = container.querySelector('img, canvas.doc-page, canvas');
      if (!media) return 0;
      wrap = document.createElement('div');
      wrap.className = 'doc-page-wrap';
      media.replaceWith(wrap);
      wrap.appendChild(media);
    }
    return paintWrapSearchHits(wrap, boxes, query, page);
  }

  function wrapMediaWithHits(media, boxes, query, page = 0) {
    const wrap = document.createElement('div');
    wrap.className = 'doc-page-wrap';
    wrap.appendChild(media);
    const paint = () => {
      if (!String(query || '').trim()) return;
      paintWrapSearchHits(wrap, boxes, query, page);
    };
    if (media.complete && (media.naturalWidth || media.width)) paint();
    else if (typeof media.addEventListener === 'function') {
      media.addEventListener('load', paint, { once: true });
    } else paint();
    return wrap;
  }

  async function renderPdfPage(doc, pageNum, maxWidth = 900, query = '', boxes = []) {
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(MAX_PAGE_DPR, Math.max(1, globalThis.devicePixelRatio || 1));
    const fitScale = Math.min(4, Math.max(0.2, (maxWidth || 900) / (base.width || 1)));
    let scale = fitScale * dpr;
    // Keep every page canvas under the platform pixel budget.
    const rawPixels = (base.width * scale) * (base.height * scale);
    if (rawPixels > MAX_CANVAS_PIXELS) {
      scale *= Math.sqrt(MAX_CANVAS_PIXELS / rawPixels);
    }
    const viewport = page.getViewport({ scale });
    const layoutWidth = Math.max(1, Math.ceil(base.width * fitScale));
    const layoutHeight = Math.max(1, Math.ceil(base.height * fitScale));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.className = 'doc-page';
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    const wrap = document.createElement('div');
    wrap.className = 'doc-page-wrap';
    sizeWrap(wrap, layoutWidth, layoutHeight);
    wrap.appendChild(canvas);
    const needle = String(query || '').trim();
    if (needle) {
      try {
        const content = await page.getTextContent();
        rememberPdfHits(
          wrap,
          pdfTextHitRects(viewport, content.items || [], needle, viewport.width, viewport.height),
        );
      } catch (err) {
        /* keep the page even if text extraction fails */
      }
      paintWrapSearchHits(wrap, boxes, needle, pageNum - 1);
    }
    return wrap;
  }

  function appendSearchExcerpt(container, text, query) {
    const source = String(text || '');
    const needle = String(query || '').trim();
    if (!container || !needle || !source) return false;
    let ranges = findRanges(source, needle);
    if (!ranges.length) {
      const words = needle.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
      for (const word of words) {
        ranges = findRanges(source, word);
        if (ranges.length) break;
      }
    }
    if (!ranges.length) return false;
    const start = Math.max(0, ranges[0].start - 90);
    const end = Math.min(source.length, ranges[0].end + 90);
    const snippet = `${start ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
    const existing = container.querySelector('.doc-ocr-hits');
    if (existing) existing.remove();
    const box = document.createElement('div');
    box.className = 'doc-ocr-hits';
    const html = (typeof NotesSearch !== 'undefined' && NotesSearch.highlightPlain)
      ? NotesSearch.highlightPlain(snippet, needle)
      : snippet;
    box.innerHTML = `<p class="doc-ocr-hits-label">Found in document</p><div class="doc-ocr-hits-body">${html}</div>`;
    container.appendChild(box);
    return true;
  }

  async function renderPdfDocument(bytes, container, { maxPages = MAX_PDF_PAGES, maxWidth, query, ocrText, ocrBoxes, showExcerpt = true } = {}) {
    const needle = String(query || '').trim();
    const host = container?.closest?.('.doc-zoom-host') || container;
    const target = container?.matches?.('.doc-zoom-layer')
      ? container
      : (container?.querySelector?.('.doc-zoom-layer') || container);
    if (!target) return { pages: 0, embeddedHits: 0, renderedWidth: 0 };
    target.replaceChildren();
    let doc;
    try {
      doc = await openPdf(bytes);
    } catch (err) {
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = err.message || 'Preview failed';
      target.appendChild(p);
      return { pages: 0, embeddedHits: 0, renderedWidth: 0 };
    }
    const pages = Math.min(doc.numPages, maxPages);
    const width = Math.max(240, maxWidth || target.clientWidth || container?.clientWidth || 900);
    let embeddedHits = 0;
    for (let i = 1; i <= pages; i += 1) {
      const page = await renderPdfPage(doc, i, width, needle, ocrBoxes);
      if (page.querySelector('.doc-search-hit')) embeddedHits += 1;
      target.appendChild(page);
    }
    if (doc.numPages > pages) {
      const more = document.createElement('p');
      more.className = 'muted';
      more.textContent = `Showing first ${pages} of ${doc.numPages} pages`;
      target.appendChild(more);
    }
    if (showExcerpt && needle && !target.querySelector('.doc-search-hit')) {
      appendSearchExcerpt(target, ocrText, needle);
    }
    if (host && typeof host === 'object') {
      host._pdfPaint = {
        bytes,
        query: needle,
        ocrText,
        ocrBoxes: Array.isArray(ocrBoxes) ? ocrBoxes : [],
        baseWidth: width,
        renderedWidth: width,
        showExcerpt: showExcerpt !== false,
      };
    }
    return { pages, embeddedHits, renderedWidth: width };
  }

  function rememberImagePaint(host, img) {
    if (!host || !img || !img.naturalWidth) return;
    const baseWidth = host.clientWidth || img.clientWidth || img.naturalWidth;
    host._imagePaint = {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      baseWidth,
      renderedWidth: Math.min(baseWidth, img.naturalWidth),
      upgrading: false,
    };
  }

  async function upgradeImageQuality(container, scale) {
    const host = container?.closest?.('.doc-zoom-host') || container;
    const state = host?._imagePaint;
    const img = host?.querySelector?.('img');
    if (!host || !img || state?.upgrading || scale < 1.25) return false;
    if (!state?.naturalWidth) rememberImagePaint(host, img);
    const paint = host._imagePaint;
    if (!paint?.naturalWidth) return false;
    const targetWidth = Math.min(
      paint.naturalWidth,
      Math.round(paint.baseWidth * Math.min(scale, 4)),
    );
    if (targetWidth <= (paint.renderedWidth || paint.baseWidth) * 1.2) return false;
    paint.upgrading = true;
    try {
      const canvas = document.createElement('canvas');
      const aspect = paint.naturalHeight / paint.naturalWidth;
      canvas.width = targetWidth;
      canvas.height = Math.max(1, Math.round(targetWidth * aspect));
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const mime = img.src.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
      const quality = mime === 'image/png' ? undefined : 0.92;
      img.src = canvas.toDataURL(mime, quality);
      paint.renderedWidth = targetWidth;
      const zoom = host._docZoom;
      if (img.decode) {
        img.decode().then(() => {
          if (zoom?.refresh) zoom.refresh();
        }).catch(() => {
          if (zoom?.refresh) zoom.refresh();
        });
      } else {
        img.addEventListener('load', () => {
          if (zoom?.refresh) zoom.refresh();
        }, { once: true });
      }
      return true;
    } finally {
      if (host._imagePaint) host._imagePaint.upgrading = false;
    }
  }

  async function upgradePdfQuality(container, scale) {
    const host = container?.closest?.('.doc-zoom-host') || container;
    const state = host?._pdfPaint;
    if (!host || !state || state.upgrading || scale < 1.25) return false;
    const targetWidth = Math.min(4096, Math.round(state.baseWidth * Math.min(scale, 4)));
    if (targetWidth <= state.renderedWidth * 1.2) return false;
    state.upgrading = true;
    try {
      const layer = host.querySelector('.doc-zoom-layer') || host;
      const scrollTop = host.scrollTop || 0;
      const scrollLeft = host.scrollLeft || 0;
      const zoom = host._docZoom;
      await renderPdfDocument(state.bytes, layer, {
        maxWidth: targetWidth,
        query: state.query,
        ocrText: state.ocrText,
        ocrBoxes: state.ocrBoxes,
        showExcerpt: state.showExcerpt,
      });
      host._pdfPaint.renderedWidth = targetWidth;
      if (zoom && typeof zoom.refresh === 'function') zoom.refresh();
      host.scrollTop = scrollTop;
      host.scrollLeft = scrollLeft;
      if (state.query) repaintAllSearchHits(layer, state.ocrBoxes, state.query);
      return true;
    } finally {
      if (host._pdfPaint) host._pdfPaint.upgrading = false;
    }
  }

  function mimeFromMeta(mime, filename) {
    const type = String(mime || '').toLowerCase();
    if (type && type !== 'application/octet-stream') return type;
    const name = String(filename || '');
    if (/\.pdf$/i.test(name)) return 'application/pdf';
    if (/\.png$/i.test(name)) return 'image/png';
    if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
    if (/\.webp$/i.test(name)) return 'image/webp';
    if (/\.gif$/i.test(name)) return 'image/gif';
    if (/\.txt$/i.test(name)) return 'text/plain';
    if (/\.md$/i.test(name)) return 'text/markdown';
    return type || 'application/octet-stream';
  }

  function fileFromBytes(bytes, filename, mime) {
    const name = filename || 'document';
    const type = mimeFromMeta(mime, name);
    const data = asUint8(bytes);
    if (typeof File === 'function') return new File([data], name, { type });
    return new Blob([data], { type });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function touchDist(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchMid(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function enablePinchZoom(viewport, { onScaleSettled, onPinch, onDoubleTap } = {}) {
    if (!viewport || typeof document === 'undefined') {
      return {
        reset() {},
        destroy() {},
        zoomIn: () => 1,
        zoomOut: () => 1,
        getScale: () => 1,
      };
    }
    if (viewport._docZoom && typeof viewport._docZoom.destroy === 'function') {
      viewport._docZoom.destroy();
    }
    let sizer = [...viewport.children].find((el) => el.classList && el.classList.contains('doc-zoom-sizer'));
    let layer = sizer && sizer.querySelector('.doc-zoom-layer');
    if (!sizer || !layer) {
      sizer = document.createElement('div');
      sizer.className = 'doc-zoom-sizer';
      layer = document.createElement('div');
      layer.className = 'doc-zoom-layer';
      while (viewport.firstChild) layer.appendChild(viewport.firstChild);
      sizer.appendChild(layer);
      viewport.appendChild(sizer);
    }
    viewport.classList.add('doc-zoom-host');
    let scale = 1;
    let startScale = 1;
    let startDist = 0;
    let lastTap = 0;
    let lastTouchTap = 0;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let lastPinchEnd = 0;
    let suppressClickUntil = 0;
    let pinchUsed = false;
    const listeners = [];

    function baseWidth() {
      const styles = globalThis.getComputedStyle ? getComputedStyle(viewport) : { paddingLeft: '0', paddingRight: '0' };
      const pad = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
      const measured = Math.max(120, viewport.clientWidth - pad);
      if (measured > 120) return measured;
      const inner = globalThis.innerWidth || 900;
      return Math.max(120, Math.min(900, inner - pad - 32));
    }

    function measureLayer() {
      const prevTransform = layer.style.transform;
      const prevWidth = layer.style.width;
      layer.style.transform = 'none';
      const width = Math.max(layer.scrollWidth, layer.offsetWidth, baseWidth());
      const height = Math.max(layer.scrollHeight, layer.offsetHeight, 1);
      layer.style.transform = prevTransform;
      layer.style.width = prevWidth;
      return { width, height };
    }

    function contentPoint(clientX, clientY) {
      const rect = viewport.getBoundingClientRect();
      return {
        x: (viewport.scrollLeft + clientX - rect.left) / scale,
        y: (viewport.scrollTop + clientY - rect.top) / scale,
      };
    }

    function clampScroll() {
      const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollLeft = clamp(viewport.scrollLeft, 0, maxLeft);
      viewport.scrollTop = clamp(viewport.scrollTop, 0, maxTop);
    }

    function scrollToPoint(point, clientX, clientY) {
      const rect = viewport.getBoundingClientRect();
      viewport.scrollLeft = point.x * scale - (clientX - rect.left);
      viewport.scrollTop = point.y * scale - (clientY - rect.top);
      clampScroll();
    }

    let settleTimer = null;

    function notifySettled() {
      if (typeof onScaleSettled !== 'function') return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        onScaleSettled(scale);
      }, 160);
    }

    function apply() {
      const width = baseWidth();
      layer.style.width = `${width}px`;
      layer.style.transform = `scale(${scale})`;
      layer.style.transformOrigin = '0 0';
      layer.style.setProperty?.('--doc-zoom', String(scale));
      if (!layer.style.setProperty) layer.style['--doc-zoom'] = String(scale);
      const { height } = measureLayer();
      sizer.style.width = `${width * scale}px`;
      sizer.style.height = `${Math.max(1, height) * scale}px`;
      viewport.classList.toggle('is-zoomed', scale > 1.02);
      clampScroll();
    }

    function reset() {
      scale = 1;
      apply();
      notifySettled();
    }

    function zoomBy(factor) {
      const rect = viewport.getBoundingClientRect();
      const clientX = rect.left + viewport.clientWidth / 2;
      const clientY = rect.top + viewport.clientHeight / 2;
      const point = contentPoint(clientX, clientY);
      scale = clamp(scale * factor, 1, 5);
      apply();
      scrollToPoint(point, clientX, clientY);
      notifySettled();
      return scale;
    }

    function on(el, type, fn, opts) {
      el.addEventListener(type, fn, opts);
      listeners.push([el, type, fn, opts]);
    }

    function toggleZoomAt(clientX, clientY) {
      const point = contentPoint(clientX, clientY);
      if (scale > 1.05) reset();
      else {
        scale = 2.2;
        apply();
        scrollToPoint(point, clientX, clientY);
      }
      notifySettled();
      if (typeof onDoubleTap === 'function') onDoubleTap();
    }

    function tryDoubleTapAt(clientX, clientY, now) {
      const dist = Math.hypot(clientX - lastTouchX, clientY - lastTouchY);
      if (now - lastTouchTap < 320 && dist < 48) {
        suppressClickUntil = now + 450;
        toggleZoomAt(clientX, clientY);
        lastTouchTap = 0;
        lastTap = now;
        return true;
      }
      lastTouchTap = now;
      lastTouchX = clientX;
      lastTouchY = clientY;
      return false;
    }

    on(viewport, 'touchstart', (event) => {
      if (event.touches.length === 2) {
        event.preventDefault();
        viewport.classList.add('is-pinching');
        startDist = touchDist(event.touches[0], event.touches[1]);
        startScale = scale;
      }
    }, { passive: false });

    on(viewport, 'touchmove', (event) => {
      if (event.touches.length !== 2 || !startDist) return;
      event.preventDefault();
      const mid = touchMid(event.touches[0], event.touches[1]);
      const point = contentPoint(mid.x, mid.y);
      const nextScale = clamp(startScale * (touchDist(event.touches[0], event.touches[1]) / startDist), 1, 5);
      if (nextScale > startScale * 1.08) pinchUsed = true;
      scale = nextScale;
      apply();
      scrollToPoint(point, mid.x, mid.y);
    }, { passive: false });

    on(viewport, 'touchend', (event) => {
      const wasPinching = startDist > 0;
      if (event.touches.length < 2) {
        startDist = 0;
        viewport.classList.remove('is-pinching');
      }
      if (!event.touches.length) {
        let doubleTapped = false;
        if (wasPinching) {
          lastPinchEnd = Date.now();
          if (pinchUsed && typeof onPinch === 'function') onPinch();
        } else {
          const touch = event.changedTouches?.[0];
          if (touch && tryDoubleTapAt(touch.clientX, touch.clientY, Date.now())) {
            event.preventDefault();
            doubleTapped = true;
          }
        }
        if (!doubleTapped) {
          if (scale <= 1.05) reset();
          else {
            apply();
            notifySettled();
          }
        }
      }
    }, { passive: false });

    on(viewport, 'click', (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        return;
      }
      if (Date.now() - lastPinchEnd < 400) {
        event.preventDefault();
        return;
      }
      const now = Date.now();
      if (now - lastTap < 280) {
        event.preventDefault();
        toggleZoomAt(event.clientX, event.clientY);
      }
      lastTap = now;
    });

    on(viewport, 'wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const point = contentPoint(event.clientX, event.clientY);
      scale = clamp(scale * (event.deltaY < 0 ? 1.12 : 0.9), 1, 5);
      if (scale <= 1.02) reset();
      else {
        apply();
        scrollToPoint(point, event.clientX, event.clientY);
      }
      notifySettled();
    }, { passive: false });

    function destroy() {
      clearTimeout(settleTimer);
      settleTimer = null;
      listeners.forEach(([el, type, fn, opts]) => el.removeEventListener(type, fn, opts));
      listeners.length = 0;
      reset();
      if (viewport._docZoom === api) delete viewport._docZoom;
    }

    const api = {
      reset,
      destroy,
      refresh: () => apply(),
      zoomIn: () => zoomBy(1.5),
      zoomOut: () => zoomBy(1 / 1.5),
      getScale: () => scale,
    };
    viewport._docZoom = api;
    apply();
    return api;
  }

  return {
    MAX_PDF_PAGES,
    kindFromMeta,
    resolveKind,
    looksLikeTextBytes,
    mimeFromMeta,
    decodeText,
    renderTextPreview,
    blobFor,
    blobUrl,
    fileFromBytes,
    ensurePdf,
    openPdf,
    renderPdfPage,
    renderPdfDocument,
    upgradePdfQuality,
    upgradeImageQuality,
    rememberImagePaint,
    enablePinchZoom,
    joinTextItems,
    matchTextItems,
    matchOcrBoxes,
    matchOcrBoxesLoose,
    pickOcrHits,
    boxesMatchQuery,
    paintWrapSearchHits,
    repaintAllSearchHits,
    rememberPdfHits,
    pdfTextHitRects,
    ocrHitRects,
    hitSummary,
    hitIsOnScreen,
    hitNoteHost,
    listSearchHits,
    countStoredSearchHits,
    scrollableAncestors,
    scrollHitIntoView,
    scrollHitIntoViewSettled,
    scrollHitIntoViewAsync,
    scrollFirstHitIntoView,
    paintOcrBoxesDom,
    paintOcrBoxesOnCanvas,
    overlayOcrHits,
    wrapMediaWithHits,
    appendSearchExcerpt,
  };
})();
if (typeof window !== 'undefined') window.NotesPreview = NotesPreview;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesPreview;
