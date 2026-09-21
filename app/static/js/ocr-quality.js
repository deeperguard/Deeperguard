(() => {
  function normalizeOcrWord(word) {
    return String(word || '').replace(/^[^\w]+|[^\w]+$/g, '');
  }

  function isImageAttachment(mime, filename) {
    const kind = String(mime || '').toLowerCase();
    const name = String(filename || '').toLowerCase();
    return kind.startsWith('image/')
      || /\.(png|jpe?g|webp|gif|bmp|hei[cf]|tif|tiff)$/i.test(name);
  }

  function isPdfAttachment(mime, filename) {
    const kind = String(mime || '').toLowerCase();
    const name = String(filename || '').toLowerCase();
    return kind === 'application/pdf' || /\.pdf$/i.test(name);
  }

  function ocrReadableWordCount(text) {
    const words = String(text || '').trim().split(/\s+/).map(normalizeOcrWord).filter(Boolean);
    return words.filter((word) => {
      if (word.length < 3) return false;
      const letters = word.replace(/[^A-Za-z]/g, '');
      if (letters.length < 3) return false;
      if (!/[aeiouAEIOU]/.test(letters) && letters.length < 5) return false;
      if (letters.length / word.length < 0.6) return false;
      return true;
    }).length;
  }

  function ocrLetterRatio(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return 0;
    return trimmed.replace(/[^A-Za-z]/g, '').length / trimmed.length;
  }

  function ocrResultWeak(text, boxes, mime, filename, qualityHint) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return true;

    const readableWords = ocrReadableWordCount(trimmed);
    if (readableWords < 2) return true;
    if (ocrLetterRatio(trimmed) < 0.3) return true;

    // Engine "weak" hints target noisy photo OCR; PDFs may still have usable text.
    if (qualityHint === 'weak' && isImageAttachment(mime, filename) && !isPdfAttachment(mime, filename)) {
      return true;
    }

    if (isImageAttachment(mime, filename) && !isPdfAttachment(mime, filename)) {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const noisy = tokens.filter((token) => /[^\w\s]/.test(token) || token.length <= 1).length;
      if (tokens.length >= 6 && noisy / tokens.length > 0.4) return true;
      if (trimmed.length < 48 && readableWords < 3) return true;
    }

    return false;
  }

  function normalizeOcrStorage(text, boxes, mime, filename, qualityHint, method = 'client') {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { text: '', method: 'none' };
    const resolved = method || 'client';
    if ((resolved === 'pdftext' || resolved === 'text') && !isImageAttachment(mime, filename)) {
      return { text: trimmed, method: resolved };
    }
    if (ocrResultWeak(trimmed, boxes, mime, filename, qualityHint)) {
      return { text: '', method: 'none' };
    }
    return { text: trimmed, method: resolved };
  }

  const api = {
    isImageAttachment,
    isPdfAttachment,
    ocrReadableWordCount,
    ocrLetterRatio,
    ocrResultWeak,
    normalizeOcrStorage,
  };
  if (typeof window !== 'undefined') window.NotesOcrQuality = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
