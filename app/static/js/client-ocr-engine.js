/**
 * Zero-knowledge OCR — documents are decrypted and processed only in the browser.
 * Tesseract.js (WASM), pdf.js, and canvas; nothing is sent to the server for OCR.
 */
const NotesClientOcr = (() => {
  const MAX_BYTES = 50 * 1024 * 1024;
  const MAX_SCAN_PAGES = 6;
  // Every page of a PDF is read. Highlight boxes stop at MAX_BOXES; text does not.
  const MAX_PDF_PAGES = Number.POSITIVE_INFINITY;
  const MAX_BOXES = 1500;
  const LIST_PREVIEW_PX = 224;
  const LIST_PREVIEW_QUALITY = 0.78;
  const MAX_LIST_PREVIEW_BYTES = 96 * 1024;
  const ASSET_VER = '1';
  const TESS_BASE = '/static/js/vendor/tesseract';
  const PDF_SRC = '/static/js/vendor/pdfjs/pdf.min.js?v=8';
  const PDF_WORKER = '/static/js/vendor/pdfjs/pdf.worker.min.js?v=8';
  const JSPDF_SRC = `/static/js/vendor/jspdf/jspdf.umd.min.js?v=${ASSET_VER}`;
  const HEIC_SRC = `/static/js/vendor/heic2any/heic2any.min.js?v=${ASSET_VER}`;

  let workerPromise = null;
  let workerRef = null;
  let pdfWorkerBlobUrl = '';

  // iOS and installed PWAs are killed (the app looks like it reloaded) when OCR
  // and a full-page preview both keep large canvases alive.
  function memoryConstrained() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let standalone = false;
    try {
      standalone = navigator.standalone === true
        || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
    } catch (err) {
      standalone = false;
    }
    return ios || standalone;
  }

  function maxOcrPixels() {
    return memoryConstrained() ? 1200000 : 3500000;
  }

  function releaseCanvas(canvas) {
    if (!canvas) return;
    try {
      canvas.width = 1;
      canvas.height = 1;
    } catch (err) {
      /* ignore */
    }
  }

  function yieldToUi() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function photoPreprocess() {
    if (typeof NotesPhotoPreprocess !== 'undefined' && NotesPhotoPreprocess?.preparePhoto) {
      return NotesPhotoPreprocess;
    }
    if (globalThis.NotesPhotoPreprocess?.preparePhoto) return globalThis.NotesPhotoPreprocess;
    return null;
  }

  function canvasToRgba(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: image.data };
  }

  function rgbaToCanvas(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    const data = image.data instanceof Uint8ClampedArray
      ? image.data
      : new Uint8ClampedArray(image.data);
    ctx.putImageData(new ImageData(data, image.width, image.height), 0, 0);
    return canvas;
  }

  function clean(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n')
      .trim();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round4(value) {
    return Math.round(value * 10000) / 10000;
  }

  function isHeic(file) {
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    return /\.hei[cf]$/.test(name) || type.includes('heic') || type.includes('heif');
  }

  function isJpegOrPng(file) {
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    return type === 'image/jpeg' || type === 'image/png'
      || /\.jpe?g$/.test(name) || /\.png$/.test(name);
  }

  function fileKind(file) {
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    if (type === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
    if (/\.docx$/.test(name) || type.includes('wordprocessingml')) return 'docx';
    if (/\.zip$/.test(name) || type === 'application/zip' || type === 'application/x-zip-compressed') return 'zip';
    if (type === 'application/json' || type.startsWith('text/') || /\.(txt|md|csv|json|log)$/i.test(name)) return 'text';
    if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|hei[cf])$/i.test(name)) return 'image';
    return 'other';
  }

  function looksLikeTextBytes(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!u8.length) return false;
    if (u8.length >= 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return false;
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

  function meaningfulWords(text) {
    return clean(text).split(/\s+/).filter((word) => word.length >= 3 && /[A-Za-z]{2}/.test(word));
  }

  function weakOcrResult(text, boxes) {
    const cleaned = clean(text);
    if (!cleaned) return true;
    const words = meaningfulWords(cleaned);
    const boxCount = Array.isArray(boxes) ? boxes.length : 0;
    if (cleaned.length < 32 && boxCount < 8) return true;
    if (words.length < 2) return true;
    return false;
  }

  function makeBox(text, left, top, width, height, pageW, pageH, page = 0) {
    const word = clean(text);
    if (!word || width <= 0 || height <= 0 || pageW <= 0 || pageH <= 0) return null;
    return {
      text: word.slice(0, 80),
      l: round4(clamp(left / pageW, 0, 1)),
      t: round4(clamp(top / pageH, 0, 1)),
      w: round4(clamp(width / pageW, 0.001, 1)),
      h: round4(clamp(height / pageH, 0.001, 1)),
      page: Number(page) || 0,
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new Error('OCR needs a browser'));
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

  async function resolvePdfWorkerSrc() {
    if (pdfWorkerBlobUrl) return pdfWorkerBlobUrl;
    if (typeof fetch !== 'function') return PDF_WORKER;
    const res = await fetch(PDF_WORKER, { cache: 'force-cache' });
    if (!res.ok) throw new Error('PDF worker is not cached. Open the app once online.');
    const raw = await res.blob();
    const blob = raw.type ? raw : new Blob([raw], { type: 'application/javascript' });
    pdfWorkerBlobUrl = URL.createObjectURL(blob);
    return pdfWorkerBlobUrl;
  }

  async function ensurePdf() {
    if (globalThis.pdfjsLib?.getDocument) {
      try {
        globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = await resolvePdfWorkerSrc();
      } catch (_) {
        globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
      }
      return globalThis.pdfjsLib;
    }
    await loadScript(PDF_SRC);
    const lib = globalThis.pdfjsLib;
    if (!lib?.getDocument) throw new Error('PDF engine failed to load.');
    try {
      lib.GlobalWorkerOptions.workerSrc = await resolvePdfWorkerSrc();
    } catch (_) {
      lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    }
    return lib;
  }

  async function ensureWorker() {
    if (workerRef) return workerRef;
    if (!workerPromise) workerPromise = createWorker();
    return workerPromise;
  }

  async function createWorker() {
    await loadScript(`${TESS_BASE}/tesseract.min.js`);
    const Tesseract = globalThis.Tesseract;
    if (!Tesseract?.createWorker) throw new Error('OCR engine failed to load. Open the app once online.');
    // Dutch + English traineddata is fetched here, when a scan starts,
    // not with the first page load.
    const worker = await Tesseract.createWorker('eng+nld', 1, {
      workerPath: `${TESS_BASE}/worker.min.js`,
      corePath: `${TESS_BASE}/tesseract-core.wasm.js`,
      langPath: `${TESS_BASE}/lang`,
      gzip: true,
      logger: () => {},
    });
    workerRef = worker;
    return worker;
  }

  async function loadHeic2Any() {
    if (globalThis.heic2any) return globalThis.heic2any;
    await loadScript(HEIC_SRC);
    if (!globalThis.heic2any) throw new Error('HEIC converter failed to load.');
    return globalThis.heic2any;
  }

  async function loadJsPdf() {
    if (globalThis.jspdf?.jsPDF) return globalThis.jspdf.jsPDF;
    await loadScript(JSPDF_SRC);
    if (!globalThis.jspdf?.jsPDF) throw new Error('PDF builder failed to load.');
    return globalThis.jspdf.jsPDF;
  }

  function canvasToJpegBytes(canvas, quality = LIST_PREVIEW_QUALITY) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Could not encode image.'));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      }, 'image/jpeg', quality);
    });
  }

  async function decodeImageFile(file) {
    const tryDecode = async (blob) => {
      if (typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, bitmap.width);
          canvas.height = Math.max(1, bitmap.height);
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          if (typeof bitmap.close === 'function') bitmap.close();
          return { canvas, width: canvas.width, height: canvas.height };
        } catch (err) {
          /* Fall through to Image(), which also honors EXIF orientation. */
        }
      }
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Could not read that image.'));
          img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, img.naturalWidth || img.width);
        canvas.height = Math.max(1, img.naturalHeight || img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return { canvas, width: canvas.width, height: canvas.height };
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    try {
      return await tryDecode(file);
    } catch (err) {
      if (!isHeic(file)) throw err;
      const heic2any = await loadHeic2Any();
      const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.88 });
      const blob = Array.isArray(converted) ? converted[0] : converted;
      return await tryDecode(blob);
    }
  }

  function remapBoxes(boxes, geometry) {
    if (!geometry?.toOriginal) return boxes;
    const pageW = geometry.outWidth;
    const pageH = geometry.outHeight;
    const mapped = [];
    for (const box of boxes || []) {
      const corners = [
        [box.l * pageW, box.t * pageH],
        [(box.l + box.w) * pageW, box.t * pageH],
        [box.l * pageW, (box.t + box.h) * pageH],
        [(box.l + box.w) * pageW, (box.t + box.h) * pageH],
      ];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of corners) {
        const point = geometry.toOriginal(x, y);
        if (point[0] < minX) minX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] > maxY) maxY = point[1];
      }
      const item = makeBox(
        box.text,
        minX,
        minY,
        maxX - minX,
        maxY - minY,
        geometry.srcWidth,
        geometry.srcHeight,
        box.page,
      );
      if (item) mapped.push(item);
    }
    return mapped;
  }

  function ocrPickScore(text, boxes) {
    const cleaned = clean(text);
    if (!cleaned) return 0;
    const words = meaningfulWords(cleaned);
    const letters = cleaned.replace(/[^A-Za-zÀ-ÿ]/g, '').length;
    const boxCount = Array.isArray(boxes) ? boxes.length : 0;
    return letters + words.length * 18 + Math.min(boxCount, 240) * 4;
  }

  function chooseBetterOcr(current, candidate) {
    const left = current || { text: '', boxes: [] };
    const right = candidate || { text: '', boxes: [] };
    const leftScore = ocrPickScore(left.text, left.boxes);
    const rightScore = ocrPickScore(right.text, right.boxes);
    if (rightScore > leftScore) return right;
    if (rightScore < leftScore) return left;
    return clean(right.text).length > clean(left.text).length ? right : left;
  }

  function wordsToBoxes(words, pageW, pageH, page = 0) {
    const boxes = [];
    for (const word of words || []) {
      const bbox = word.bbox || word;
      const left = Number(bbox.x0 ?? bbox.left ?? 0);
      const top = Number(bbox.y0 ?? bbox.top ?? 0);
      const right = Number(bbox.x1 ?? (left + (bbox.width || 0)));
      const bottom = Number(bbox.y1 ?? (top + (bbox.height || 0)));
      const item = makeBox(word.text, left, top, right - left, bottom - top, pageW, pageH, page);
      if (item) boxes.push(item);
      if (boxes.length >= MAX_BOXES) break;
    }
    return boxes;
  }

  // PSM 4: a single column of mixed-size text, which matches a photographed
  // page. PSM 6 is the uniform-block mode and fits screenshots better.
  const DOCUMENT_PSM = 4;

  function ocrPassPoor(result) {
    if (weakOcrResult(result?.text, result?.boxes)) return true;
    const confidence = Number(result?.confidence);
    return Number.isFinite(confidence) && confidence > 0 && confidence < 58;
  }

  async function recognizeCanvas(canvas, { page = 0, psm = DOCUMENT_PSM, geometry = null } = {}) {
    const worker = await ensureWorker();
    if (typeof worker.setParameters === 'function') {
      await worker.setParameters({
        tessedit_pageseg_mode: String(psm),
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
    }
    const result = await worker.recognize(canvas);
    const data = result?.data || {};
    const text = clean(data.text || '');
    const words = Array.isArray(data.words) ? data.words : [];
    const rawBoxes = wordsToBoxes(words, canvas.width, canvas.height, page);
    const boxes = remapBoxes(rawBoxes, geometry);
    const confidence = Number(data.confidence);
    return {
      text,
      boxes,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  }

  async function ocrImageCanvas(canvas, page = 0) {
    const prep = photoPreprocess();
    if (!prep) {
      const result = await recognizeCanvas(canvas, { page, psm: DOCUMENT_PSM });
      const quality = weakOcrResult(result.text, result.boxes) ? 'weak' : 'ok';
      return { text: result.text, boxes: result.boxes, method: 'tesseract', ocr_quality: quality };
    }
    const prepared = prep.preparePhoto(canvasToRgba(canvas), { maxPixels: maxOcrPixels() });
    const primary = rgbaToCanvas(prep.renderPhotoPass(prepared, 'primary'));
    let best;
    try {
      best = await recognizeCanvas(primary, { page, psm: DOCUMENT_PSM, geometry: prepared.geometry });
    } finally {
      releaseCanvas(primary);
    }
    // One retry, and only when the first pass is weak. The retry uses a
    // tighter binarization of the same deskewed page. It does not loop.
    if (ocrPassPoor(best)) {
      const retry = rgbaToCanvas(prep.renderPhotoPass(prepared, 'strong'));
      try {
        const second = await recognizeCanvas(retry, { page, psm: DOCUMENT_PSM, geometry: prepared.geometry });
        best = chooseBetterOcr(best, second);
      } finally {
        releaseCanvas(retry);
      }
    }
    // Clean JPEG/WebP scans (large type on a white page) survive a direct
    // pass better than photo binarization. Keep whichever read is stronger.
    if (ocrPassPoor(best)) {
      const direct = await recognizeCanvas(canvas, { page, psm: 6 });
      best = chooseBetterOcr(best, direct);
    }
    const quality = weakOcrResult(best.text, best.boxes) ? 'weak' : 'ok';
    return { text: best.text, boxes: best.boxes, method: 'tesseract', ocr_quality: quality };
  }

  async function extractTextFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let body = bytes;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      body = bytes.slice(3);
    }
    const text = clean(new TextDecoder('utf-8', { fatal: false }).decode(body));
    return { text, method: 'text', boxes: [], ocr_quality: 'ok' };
  }

  async function extractPdfDigital(doc) {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const parts = [];
    const boxes = [];
    const pdfjs = await ensurePdf();
    for (let pageNum = 1; pageNum <= pages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const pageText = [];
      for (const item of content.items) {
        const str = String(item.str || '');
        if (!str) continue;
        pageText.push(str);
        if (!item.transform) continue;
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const x = tx[4];
        const y = tx[5];
        const fontHeight = Math.hypot(tx[2], tx[3]) || 12;
        const width = (item.width || 0) * viewport.scale || fontHeight * str.length * 0.5;
        const top = viewport.height - y - fontHeight;
        const box = makeBox(str, x, top, width, fontHeight, viewport.width, viewport.height, pageNum - 1);
        if (box && boxes.length < MAX_BOXES) boxes.push(box);
      }
      if (pageText.length) parts.push(clean(pageText.join(' ')));
      if (typeof page.cleanup === 'function') page.cleanup();
      if (pageNum % 2 === 0) await yieldToUi();
    }
    return { text: clean(parts.join('\n\n')), boxes };
  }

  function rasterScaleFor(page) {
    const base = page.getViewport({ scale: 1 });
    // Scanned PDF pages are rendered above the on-screen preview so small
    // type survives the later photo preprocess. Digital text never comes here.
    let scale = memoryConstrained() ? 1.15 : 2;
    const raw = base.width * scale * base.height * scale;
    const cap = maxOcrPixels();
    if (raw > cap) scale *= Math.sqrt(cap / raw);
    return Math.max(0.35, scale);
  }

  async function rasterizePdfPage(page, scale = 1.5) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    return canvas;
  }

  async function extractPdfRaster(doc, startPage = 0) {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const texts = [];
    const boxes = [];
    for (let pageNum = startPage + 1; pageNum <= pages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const canvas = await rasterizePdfPage(page, rasterScaleFor(page));
      try {
        const result = await ocrImageCanvas(canvas, pageNum - 1);
        if (result.text) texts.push(result.text);
        if (boxes.length < MAX_BOXES) boxes.push(...result.boxes.slice(0, MAX_BOXES - boxes.length));
      } finally {
        releaseCanvas(canvas);
        if (typeof page.cleanup === 'function') page.cleanup();
      }
      await yieldToUi();
    }
    return { text: clean(texts.join('\n\n')), boxes: boxes.slice(0, MAX_BOXES), method: 'tesseract' };
  }

  function digitalPdfReady(digital) {
    const text = clean(digital.text);
    if (text.length < 40) return false;
    if (digital.boxes.length >= 5) return true;
    return meaningfulWords(text).length >= 3;
  }

  async function extractPdf(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdfjs = await ensurePdf();
    const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false }).promise;
    try {
      const digital = await extractPdfDigital(doc);
      if (digitalPdfReady(digital)) {
        return {
          text: digital.text,
          method: 'pdftext',
          boxes: digital.boxes.slice(0, MAX_BOXES),
          ocr_quality: 'ok',
        };
      }
      const raster = await extractPdfRaster(doc);
      const parts = [];
      if (digital.text) parts.push(digital.text);
      if (raster.text && (!digital.text || !digital.text.includes(raster.text))) parts.push(raster.text);
      const mergedBoxes = raster.boxes.length ? raster.boxes : digital.boxes;
      const text = clean(parts.join('\n\n')) || digital.text;
      const method = raster.boxes.length ? 'tesseract' : 'pdftext';
      return {
        text,
        method,
        boxes: mergedBoxes.slice(0, MAX_BOXES),
        ocr_quality: weakOcrResult(text, mergedBoxes) ? 'weak' : 'ok',
      };
    } finally {
      try { await doc.destroy(); } catch (err) { /* drop the pdf.js copy */ }
    }
  }

  function docxXmlToText(xml) {
    return clean(String(xml || '')
      .replace(/<w:tab[^/]*\/>/g, '\t')
      .replace(/<w:br[^/]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
  }

  async function extractDocx(file) {
    const unzip = globalThis.NotesSnImport?.unzip;
    if (typeof unzip !== 'function') throw new Error('Could not read this Word document on this device.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = await unzip(bytes);
    const doc = (entries || []).find((entry) => /word\/document\.xml$/i.test(entry.name || ''));
    if (!doc?.bytes?.length) throw new Error('This Word document has no text.');
    const xml = new TextDecoder().decode(doc.bytes);
    return { text: docxXmlToText(xml), method: 'text', boxes: [], ocr_quality: 'ok' };
  }

  async function extractJsonFile(file) {
    const raw = await file.text();
    let text = raw;
    try {
      const data = JSON.parse(raw);
      const parts = [];
      const walk = (node) => {
        if (node == null) return;
        if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
          const bit = String(node).trim();
          if (bit) parts.push(bit);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (typeof node === 'object') Object.values(node).forEach(walk);
      };
      walk(data);
      if (parts.length) text = parts.join('\n');
    } catch (err) {
      text = raw;
    }
    return { text: clean(text), method: 'text', boxes: [], ocr_quality: 'ok' };
  }

  async function extractImage(file) {
    const decoded = await decodeImageFile(file);
    // Photo OCR prepares its own working resolution. The list preview stays
    // at LIST_PREVIEW_PX and is not the image Tesseract reads.
    try {
      return await ocrImageCanvas(decoded.canvas, 0);
    } finally {
      releaseCanvas(decoded.canvas);
    }
  }

  async function fitPreviewJpeg(canvas) {
    const thumb = document.createElement('canvas');
    const scale = Math.min(1, LIST_PREVIEW_PX / Math.max(canvas.width, canvas.height, 1));
    thumb.width = Math.max(1, Math.round(canvas.width * scale));
    thumb.height = Math.max(1, Math.round(canvas.height * scale));
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    const bytes = await canvasToJpegBytes(thumb, LIST_PREVIEW_QUALITY);
    if (!bytes.length || bytes.length > MAX_LIST_PREVIEW_BYTES) return null;
    return bytes;
  }

  async function pdfFirstPageCanvas(bytes) {
    const pdfjs = await ensurePdf();
    const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false }).promise;
    try {
      const page = await doc.getPage(1);
      const canvas = await rasterizePdfPage(page, Math.min(96 / 72, rasterScaleFor(page)));
      if (typeof page.cleanup === 'function') page.cleanup();
      return canvas;
    } finally {
      try { await doc.destroy(); } catch (err) { /* drop the pdf.js copy */ }
    }
  }

  async function renderListPreview(file) {
    if (!file) return null;
    const kind = fileKind(file);
    if (kind === 'text') return null;
    if (kind === 'pdf') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const canvas = await pdfFirstPageCanvas(bytes);
      try {
        return await fitPreviewJpeg(canvas);
      } finally {
        releaseCanvas(canvas);
      }
    }
    if (kind === 'image') {
      const { canvas } = await decodeImageFile(file);
      try {
        return await fitPreviewJpeg(canvas);
      } finally {
        releaseCanvas(canvas);
      }
    }
    return null;
  }

  function needsPrepare(files) {
    const list = (files || []).filter(Boolean);
    if (!list.length) return false;
    if (list.length > 1) return true;
    return isHeic(list[0]) || !isJpegOrPng(list[0]);
  }

  async function canvasToJpegFile(canvas, name = 'scan.jpg') {
    const bytes = await canvasToJpegBytes(canvas, 0.88);
    return new File([bytes], name, { type: 'image/jpeg' });
  }

  async function imagesToPdfFile(canvases) {
    const jsPDF = await loadJsPdf();
    let doc = null;
    for (let i = 0; i < canvases.length; i += 1) {
      const canvas = canvases[i];
      const w = canvas.width;
      const h = canvas.height;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      if (!doc) doc = new jsPDF({ unit: 'px', format: [w, h], orientation: w >= h ? 'l' : 'p' });
      else doc.addPage([w, h], w >= h ? 'l' : 'p');
      doc.addImage(dataUrl, 'JPEG', 0, 0, w, h);
    }
    const blob = doc.output('blob');
    return new File([blob], 'scan.pdf', { type: 'application/pdf' });
  }

  async function prepareImages(files, { onStatus } = {}) {
    const list = (files || []).filter(Boolean);
    if (!list.length) throw new Error('Choose a photo first.');
    if (list.length > MAX_SCAN_PAGES) throw new Error(`Scan at most ${MAX_SCAN_PAGES} pages.`);
    let total = 0;
    for (const file of list) {
      total += Number(file.size || 0);
      if (total > MAX_BYTES * 2) throw new Error('Those photos are too large to combine.');
    }
    if (!needsPrepare(list)) return list[0];
    if (list.some(isHeic) && typeof onStatus === 'function') onStatus('Converting HEIC…');
    const canvases = [];
    for (const file of list) {
      const { canvas } = await decodeImageFile(file);
      canvases.push(canvas);
    }
    if (canvases.length === 1) return canvasToJpegFile(canvases[0]);
    if (typeof onStatus === 'function') onStatus('Combining pages…');
    return imagesToPdfFile(canvases);
  }

  async function extractFromFile(file, { onProgress, attId } = {}) {
    if (!file) throw new Error('Choose a file first.');
    const size = Number(file.size || 0);
    if (size > MAX_BYTES) throw new Error('File too large to process on this device.');
    const report = (progress) => {
      if (typeof onProgress === 'function') onProgress({ status: 'processing', progress });
    };
    report(0.05);
    let kind = fileKind(file);
    if (kind === 'zip') {
      throw new Error('Zip archives are not indexed.');
    }
    if (kind === 'other') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksLikeTextBytes(bytes)) kind = 'text';
    }
    report(0.15);
    let result;
    if (kind === 'docx') {
      result = await extractDocx(file);
    } else if (kind === 'text' && (/\.json$/i.test(file.name || '') || String(file.type || '').includes('json'))) {
      result = await extractJsonFile(file);
    } else if (kind === 'text') {
      result = await extractTextFile(file);
    } else if (kind === 'pdf') {
      result = await extractPdf(file);
    } else if (kind === 'image') {
      result = await extractImage(file);
    } else {
      throw new Error('Use an image, PDF, or text file.');
    }
    report(0.9);
    const preview_jpeg = await renderListPreview(file);
    report(1);
    return {
      text: result.text || '',
      method: result.method || 'client',
      boxes: Array.isArray(result.boxes) ? result.boxes : [],
      ocr_quality: result.ocr_quality || '',
      preview_jpeg,
      att_id: attId || '',
    };
  }

  return {
    MAX_SCAN_PAGES,
    MAX_BYTES,
    isHeic,
    needsPrepare,
    prepareImages,
    renderListPreview,
    extractFromFile,
    weakOcrResult,
    ocrPickScore,
    chooseBetterOcr,
    clean,
  };
})();

if (typeof window !== 'undefined') window.NotesClientOcr = NotesClientOcr;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesClientOcr;
