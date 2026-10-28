/**
 * On-device photo preprocess for document OCR.
 * Pure pixel math (no network, no canvas) so the browser path and the
 * fixture bench share one implementation.
 *
 * Pipeline: cap resolution, grayscale, orientation/deskew, crop to the page,
 * upscale small text, denoise, contrast, adaptive threshold. A second call
 * with pass "strong" is the one allowed retry (tighter binarization).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.NotesPhotoPreprocess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const OCR_MIN_SHORT_SIDE = 2000;
  const OCR_MAX_UPSCALE = 3;

  function clampByte(value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return value | 0;
  }

  function toGrayImage(image) {
    const width = image.width | 0;
    const height = image.height | 0;
    const src = image.data;
    const gray = new Uint8Array(width * height);
    if (src.length === gray.length) {
      gray.set(src);
      return { width, height, gray };
    }
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
    }
    return { width, height, gray };
  }

  function grayToRgba(gray, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      const v = gray[i];
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
    return { width, height, data };
  }

  function integral(gray, width, height, squares) {
    const stride = width + 1;
    const ii = new Float64Array(stride * (height + 1));
    for (let y = 1; y <= height; y += 1) {
      let row = 0;
      const srcRow = (y - 1) * width;
      const dstRow = y * stride;
      const prev = (y - 1) * stride;
      for (let x = 1; x <= width; x += 1) {
        const value = gray[srcRow + x - 1];
        row += squares ? value * value : value;
        ii[dstRow + x] = ii[prev + x] + row;
      }
    }
    return ii;
  }

  function rectSum(ii, width, x0, y0, x1, y1) {
    const stride = width + 1;
    return ii[y1 * stride + x1] - ii[y0 * stride + x1] - ii[y1 * stride + x0] + ii[y0 * stride + x0];
  }

  function unsharpGray(source, blur, amount) {
    const out = new Uint8Array(source.length);
    const gain = Number(amount) || 0;
    for (let i = 0; i < source.length; i += 1) {
      out[i] = clampByte(source[i] + gain * (source[i] - blur[i]));
    }
    return out;
  }

  function boxBlur(gray, width, height, radius) {
    const ii = integral(gray, width, height, false);
    const out = new Uint8Array(width * height);
    const r = Math.max(1, radius | 0);
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height, y + r + 1);
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(width, x + r + 1);
        const area = (x1 - x0) * (y1 - y0);
        out[row + x] = (rectSum(ii, width, x0, y0, x1, y1) / area) | 0;
      }
    }
    return out;
  }

  function downsampleGray(gray, width, height, maxEdge) {
    const long = Math.max(width, height);
    if (long <= maxEdge) return { gray, width, height };
    const scale = maxEdge / long;
    const nw = Math.max(1, Math.round(width * scale));
    const nh = Math.max(1, Math.round(height * scale));
    const out = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y += 1) {
      const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / nh));
      for (let x = 0; x < nw; x += 1) {
        const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / nw));
        out[y * nw + x] = gray[sy * width + sx];
      }
    }
    return { gray: out, width: nw, height: nh };
  }

  function scaleGray(gray, width, height, scale) {
    if (Math.abs(scale - 1) < 0.01) return { gray, width, height };
    const nw = Math.max(1, Math.round(width * scale));
    const nh = Math.max(1, Math.round(height * scale));
    const out = new Uint8Array(nw * nh);
    const maxX = width - 1;
    const maxY = height - 1;
    for (let y = 0; y < nh; y += 1) {
      const sy = (y + 0.5) * height / nh - 0.5;
      const y0 = Math.max(0, Math.floor(sy));
      const y1 = Math.min(maxY, y0 + 1);
      const fy = sy - y0;
      const row = y * nw;
      for (let x = 0; x < nw; x += 1) {
        const sx = (x + 0.5) * width / nw - 0.5;
        const x0 = Math.max(0, Math.floor(sx));
        const x1 = Math.min(maxX, x0 + 1);
        const fx = sx - x0;
        const v00 = gray[y0 * width + x0];
        const v10 = gray[y0 * width + x1];
        const v01 = gray[y1 * width + x0];
        const v11 = gray[y1 * width + x1];
        const top = v00 + (v10 - v00) * fx;
        const bot = v01 + (v11 - v01) * fx;
        out[row + x] = clampByte(top + (bot - top) * fy);
      }
    }
    return { gray: out, width: nw, height: nh };
  }

  function rotationSize(width, height, degrees) {
    const rad = degrees * Math.PI / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    return {
      rad,
      width: Math.max(1, Math.round(width * c + height * s)),
      height: Math.max(1, Math.round(width * s + height * c)),
    };
  }

  function rotateGray(gray, width, height, degrees) {
    if (Math.abs(degrees) < 0.05) return { gray, width, height };
    const size = rotationSize(width, height, degrees);
    const out = new Uint8Array(size.width * size.height);
    out.fill(255);
    const cos = Math.cos(size.rad);
    const sin = Math.sin(size.rad);
    const cx = width / 2;
    const cy = height / 2;
    const ncx = size.width / 2;
    const ncy = size.height / 2;
    const maxX = width - 1;
    const maxY = height - 1;
    for (let y = 0; y < size.height; y += 1) {
      const dy = y - ncy;
      const row = y * size.width;
      for (let x = 0; x < size.width; x += 1) {
        const dx = x - ncx;
        const sx = dx * cos + dy * sin + cx;
        const sy = -dx * sin + dy * cos + cy;
        if (sx < 0 || sy < 0 || sx > maxX || sy > maxY) continue;
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(maxX, x0 + 1);
        const y1 = Math.min(maxY, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const v00 = gray[y0 * width + x0];
        const v10 = gray[y0 * width + x1];
        const v01 = gray[y1 * width + x0];
        const v11 = gray[y1 * width + x1];
        const top = v00 + (v10 - v00) * fx;
        const bot = v01 + (v11 - v01) * fx;
        out[row + x] = clampByte(top + (bot - top) * fy);
      }
    }
    return { gray: out, width: size.width, height: size.height };
  }

  function rotateGrayNearest(gray, width, height, degrees) {
    if (Math.abs(degrees) < 0.05) return { gray, width, height };
    const size = rotationSize(width, height, degrees);
    const out = new Uint8Array(size.width * size.height);
    out.fill(255);
    const cos = Math.cos(size.rad);
    const sin = Math.sin(size.rad);
    const cx = width / 2;
    const cy = height / 2;
    const ncx = size.width / 2;
    const ncy = size.height / 2;
    for (let y = 0; y < size.height; y += 1) {
      const dy = y - ncy;
      const row = y * size.width;
      for (let x = 0; x < size.width; x += 1) {
        const dx = x - ncx;
        const sx = Math.round(dx * cos + dy * sin + cx);
        const sy = Math.round(-dx * sin + dy * cos + cy);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        out[row + x] = gray[sy * width + sx];
      }
    }
    return { gray: out, width: size.width, height: size.height };
  }


  function otsuThreshold(gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];
    let sumBackground = 0;
    let weightBackground = 0;
    let best = 0;
    let threshold = 127;
    for (let i = 0; i < 256; i += 1) {
      weightBackground += hist[i];
      if (!weightBackground) continue;
      const weightForeground = total - weightBackground;
      if (!weightForeground) break;
      sumBackground += i * hist[i];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sum - sumBackground) / weightForeground;
      const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (between > best) {
        best = between;
        threshold = i;
      }
    }
    return threshold;
  }

  function binaryInk(gray) {
    let low = 255;
    let high = 0;
    for (let i = 0; i < gray.length; i += 1) {
      const value = gray[i];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    // A 2% autocontrast clip erases sparse strokes. Stretch only when the
    // photo is a narrow gray band.
    const stretched = high - low > 48 ? gray : autocontrast(gray, 0.005);
    const threshold = otsuThreshold(stretched);
    const ink = new Uint8Array(stretched.length);
    for (let i = 0; i < stretched.length; i += 1) ink[i] = stretched[i] < threshold ? 1 : 0;
    return ink;
  }

  function lineScore(ink, width, height) {
    let mean = 0;
    const rows = new Float64Array(height);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      const off = y * width;
      for (let x = 0; x < width; x += 1) sum += ink[off + x];
      rows[y] = sum / width;
      mean += rows[y];
    }
    mean /= Math.max(1, height);
    let variance = 0;
    for (let y = 0; y < height; y += 1) {
      const delta = rows[y] - mean;
      variance += delta * delta;
    }
    return variance / Math.max(1, height);
  }

  function pushAngles(into, from, to, step) {
    for (let angle = from; angle <= to + 1e-6; angle += step) {
      into.push(Math.round(angle * 100) / 100);
    }
  }

  function scorePreparedAngle(gray, width, height, degrees) {
    const rotated = rotateGrayNearest(gray, width, height, degrees);
    const ink = binaryInk(rotated.gray);
    return lineScore(ink, rotated.width, rotated.height);
  }

  function searchSkew(gray, width, height, angles) {
    let angle = 0;
    let score = -1;
    for (let i = 0; i < angles.length; i += 1) {
      const candidate = angles[i];
      const value = scorePreparedAngle(gray, width, height, candidate);
      if (value > score) {
        score = value;
        angle = candidate;
      }
    }
    return { angle, score };
  }

  function whitenLargeDark(gray, width, height) {
    const stretched = autocontrast(gray, 0.02);
    const threshold = otsuThreshold(stretched);
    const dark = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i += 1) dark[i] = stretched[i] < threshold ? 1 : 0;
    const seen = new Uint8Array(gray.length);
    const stack = [];
    const component = [];
    const limit = Math.max(80, Math.round(width * height * 0.012));
    const out = new Uint8Array(gray);
    for (let i = 0; i < dark.length; i += 1) {
      if (!dark[i] || seen[i]) continue;
      stack.length = 0;
      component.length = 0;
      stack.push(i);
      seen[i] = 1;
      let touchesBorder = false;
      while (stack.length) {
        const p = stack.pop();
        component.push(p);
        const x = p % width;
        const y = (p / width) | 0;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
        if (x > 0 && dark[p - 1] && !seen[p - 1]) {
          seen[p - 1] = 1;
          stack.push(p - 1);
        }
        if (x + 1 < width && dark[p + 1] && !seen[p + 1]) {
          seen[p + 1] = 1;
          stack.push(p + 1);
        }
        if (y > 0 && dark[p - width] && !seen[p - width]) {
          seen[p - width] = 1;
          stack.push(p - width);
        }
        if (y + 1 < height && dark[p + width] && !seen[p + width]) {
          seen[p + width] = 1;
          stack.push(p + width);
        }
      }
      if (touchesBorder && component.length >= limit) {
        for (let n = 0; n < component.length; n += 1) out[component[n]] = 245;
      }
    }
    return out;
  }

  function detectSkew(gray, width, height) {
    const small = downsampleGray(gray, width, height, 640);
    const base = small.gray;
    const fine = [];
    const turned = [];
    pushAngles(fine, -12, 12, 1);
    pushAngles(turned, 80, 100, 2);
    pushAngles(turned, -100, -80, 2);
    const zero = scorePreparedAngle(base, small.width, small.height, 0);
    const upright = searchSkew(base, small.width, small.height, fine);
    const quarter = searchSkew(base, small.width, small.height, turned);
    // A sideways page has to beat both "leave it" and the best small tilt.
    // A few degrees of skew only has to beat the unrotated score.
    const useQuarter = quarter.score > upright.score * 1.8 && quarter.score > zero * 2;
    const chosen = useQuarter ? quarter : upright;
    let angle = chosen.angle;
    let score = chosen.score;
    for (let delta = -0.75; delta <= 0.751; delta += 0.25) {
      const candidate = Math.round((chosen.angle + delta) * 100) / 100;
      const value = scorePreparedAngle(base, small.width, small.height, candidate);
      if (value > score) {
        score = value;
        angle = candidate;
      }
    }
    const needed = Math.abs(angle) >= 45 ? 2 : 1.22;
    if (Math.abs(angle) < 0.35 || !(score > zero * needed)) return 0;
    return angle;
  }


  function findPageCrop(gray, width, height) {
    const step = Math.max(1, Math.ceil(Math.max(width, height) / 220));
    const sw = Math.floor(width / step);
    const sh = Math.floor(height / step);
    if (sw < 12 || sh < 12) return null;
    const small = new Uint8Array(sw * sh);
    const sample = Math.max(1, Math.floor(step / 2));
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        let sum = 0;
        let count = 0;
        const yEnd = Math.min(height, (y + 1) * step);
        const xEnd = Math.min(width, (x + 1) * step);
        for (let yy = y * step; yy < yEnd; yy += sample) {
          for (let xx = x * step; xx < xEnd; xx += sample) {
            sum += gray[yy * width + xx];
            count += 1;
          }
        }
        small[y * sw + x] = count ? (sum / count) | 0 : 255;
      }
    }
    const margin = Math.max(2, Math.floor(Math.min(sw, sh) * 0.08));
    const mean = (x0, y0, x1, y1) => {
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += small[y * sw + x];
          count += 1;
        }
      }
      return sum / Math.max(1, count);
    };
    const corners = (
      mean(0, 0, margin, margin)
      + mean(sw - margin, 0, sw, margin)
      + mean(0, sh - margin, margin, sh)
      + mean(sw - margin, sh - margin, sw, sh)
    ) / 4;
    const center = mean(Math.floor(sw * 0.3), Math.floor(sh * 0.3), Math.floor(sw * 0.7), Math.floor(sh * 0.7));
    if (center < corners + 18) return null;
    const threshold = corners + (center - corners) * 0.45;
    const mask = new Uint8Array(sw * sh);
    for (let i = 0; i < mask.length; i += 1) mask[i] = small[i] >= threshold ? 1 : 0;
    const seen = new Uint8Array(sw * sh);
    const stack = [];
    let best = null;
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i] || seen[i]) continue;
      stack.length = 0;
      stack.push(i);
      seen[i] = 1;
      let count = 0;
      let minX = sw;
      let minY = sh;
      let maxX = 0;
      let maxY = 0;
      while (stack.length) {
        const p = stack.pop();
        const x = p % sw;
        const y = (p / sw) | 0;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (x > 0 && mask[p - 1] && !seen[p - 1]) {
          seen[p - 1] = 1;
          stack.push(p - 1);
        }
        if (x + 1 < sw && mask[p + 1] && !seen[p + 1]) {
          seen[p + 1] = 1;
          stack.push(p + 1);
        }
        if (y > 0 && mask[p - sw] && !seen[p - sw]) {
          seen[p - sw] = 1;
          stack.push(p - sw);
        }
        if (y + 1 < sh && mask[p + sw] && !seen[p + sw]) {
          seen[p + sw] = 1;
          stack.push(p + sw);
        }
      }
      if (!best || count > best.count) best = { count, minX, minY, maxX, maxY };
    }
    if (!best) return null;
    const bw = best.maxX - best.minX + 1;
    const bh = best.maxY - best.minY + 1;
    if (bw * bh > sw * sh * 0.94) return null;
    if (bw < sw * 0.22 || bh < sh * 0.22) return null;
    const padX = Math.round(bw * 0.03);
    const padY = Math.round(bh * 0.03);
    const x = Math.max(0, (best.minX - padX) * step);
    const y = Math.max(0, (best.minY - padY) * step);
    const x2 = Math.min(width, (best.maxX + 1 + padX) * step);
    const y2 = Math.min(height, (best.maxY + 1 + padY) * step);
    if (x2 - x < 8 || y2 - y < 8) return null;
    return { x, y, width: x2 - x, height: y2 - y };
  }

  function cropGray(gray, width, crop) {
    const out = new Uint8Array(crop.width * crop.height);
    for (let y = 0; y < crop.height; y += 1) {
      const src = (crop.y + y) * width + crop.x;
      out.set(gray.subarray(src, src + crop.width), y * crop.width);
    }
    return out;
  }

  function autocontrast(gray, cutoff) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
    const skip = Math.floor(gray.length * cutoff);
    let low = 0;
    let high = 255;
    let seen = 0;
    for (let i = 0; i < 256; i += 1) {
      seen += hist[i];
      if (seen > skip) {
        low = i;
        break;
      }
    }
    seen = 0;
    for (let i = 255; i >= 0; i -= 1) {
      seen += hist[i];
      if (seen > skip) {
        high = i;
        break;
      }
    }
    if (high <= low + 8) return gray;
    const out = new Uint8Array(gray.length);
    const scale = 255 / (high - low);
    for (let i = 0; i < gray.length; i += 1) out[i] = clampByte((gray[i] - low) * scale);
    return out;
  }

  function sauvola(gray, width, height, k, windowSize) {
    const ii = integral(gray, width, height, false);
    const ii2 = integral(gray, width, height, true);
    let win = windowSize | 0;
    if (win % 2 === 0) win += 1;
    const radius = Math.max(1, (win - 1) >> 1);
    const out = new Uint8Array(gray.length);
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height, y + radius + 1);
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width, x + radius + 1);
        const area = (x1 - x0) * (y1 - y0);
        const sum = rectSum(ii, width, x0, y0, x1, y1);
        const sumSq = rectSum(ii2, width, x0, y0, x1, y1);
        const mean = sum / area;
        const variance = Math.max(0, sumSq / area - mean * mean);
        const threshold = mean * (1 + k * (Math.sqrt(variance) / 128 - 1));
        out[row + x] = gray[row + x] < threshold ? 0 : 255;
      }
    }
    return out;
  }

  function removeSpecks(binary, width, height, maxArea) {
    const seen = new Uint8Array(binary.length);
    const stack = [];
    const component = [];
    for (let i = 0; i < binary.length; i += 1) {
      if (binary[i] !== 0 || seen[i]) continue;
      stack.length = 0;
      component.length = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        component.push(p);
        const x = p % width;
        const y = (p / width) | 0;
        if (x > 0 && binary[p - 1] === 0 && !seen[p - 1]) {
          seen[p - 1] = 1;
          stack.push(p - 1);
        }
        if (x + 1 < width && binary[p + 1] === 0 && !seen[p + 1]) {
          seen[p + 1] = 1;
          stack.push(p + 1);
        }
        if (y > 0 && binary[p - width] === 0 && !seen[p - width]) {
          seen[p - width] = 1;
          stack.push(p - width);
        }
        if (y + 1 < height && binary[p + width] === 0 && !seen[p + width]) {
          seen[p + width] = 1;
          stack.push(p + width);
        }
      }
      if (component.length <= maxArea) {
        for (let n = 0; n < component.length; n += 1) binary[component[n]] = 255;
      }
    }
    return binary;
  }

  function windowFor(width, height, strong) {
    let win = Math.round(Math.min(width, height) / (strong ? 48 : 28));
    if (win % 2 === 0) win += 1;
    return Math.max(15, Math.min(win, strong ? 41 : 61));
  }

  function renderPass(gray, width, height, pass) {
    if (pass === 'gray') return grayToRgba(gray, width, height);
    const strong = pass === 'strong';
    let source = gray;
    if (strong) {
      source = new Uint8Array(gray.length);
      for (let i = 0; i < gray.length; i += 1) {
        const lifted = 255 * ((gray[i] / 255) ** 0.8);
        source[i] = clampByte(lifted);
      }
      source = autocontrast(source, 0.002);
    }
    const binary = sauvola(source, width, height, strong ? 0.06 : 0.22, windowFor(width, height, strong));
    removeSpecks(binary, width, height, strong ? 2 : 3);
    return grayToRgba(binary, width, height);
  }

  /**
   * Deskew, crop, and upscale a photo. `gray` is the page before binarization
   * so the recognition retry can threshold again without a second deskew.
   */
  function preparePhoto(image, options = {}) {
    const maxPixels = Math.max(200000, Number(options.maxPixels) || 3500000);
    const srcWidth = image.width | 0;
    const srcHeight = image.height | 0;
    let { gray, width, height } = toGrayImage(image);
    let preScale = 1;
    const workingCap = Math.min(5000000, Math.max(maxPixels, Math.round(maxPixels * 1.35)));
    if (width * height > workingCap) {
      preScale = Math.sqrt(workingCap / (width * height));
      const scaled = scaleGray(gray, width, height, preScale);
      gray = scaled.gray;
      width = scaled.width;
      height = scaled.height;
    }
    // Crop the bright page before measuring skew. On a phone photo the
    // text is a small part of the frame; scoring the whole frame lets the
    // table and the page edge outvote the lines.
    const early = findPageCrop(gray, width, height);
    const earlyBox = early || { x: 0, y: 0, width, height };
    const framed = early ? cropGray(gray, width, earlyBox) : gray;
    // Dark corner triangles left by an axis-aligned crop vote for a bogus
    // quarter turn. Strip those blobs before measuring the text angle.
    const forAngle = whitenLargeDark(framed, earlyBox.width, earlyBox.height);
    const angle = detectSkew(forAngle, earlyBox.width, earlyBox.height);
    const rotated = rotateGray(framed, earlyBox.width, earlyBox.height, angle);
    const again = findPageCrop(rotated.gray, rotated.width, rotated.height);
    const cropBox = again || { x: 0, y: 0, width: rotated.width, height: rotated.height };
    let page = again ? cropGray(rotated.gray, rotated.width, cropBox) : rotated.gray;
    let pageW = cropBox.width;
    let pageH = cropBox.height;
    const short = Math.min(pageW, pageH);
    let outScale = 1;
    if (short > 0 && short < OCR_MIN_SHORT_SIDE) {
      outScale = Math.min(OCR_MAX_UPSCALE, OCR_MIN_SHORT_SIDE / short);
    }
    if (pageW * outScale * pageH * outScale > maxPixels) {
      outScale = Math.sqrt(maxPixels / (pageW * pageH));
    }
    if (outScale < 0.999 || outScale > 1.001) {
      const scaled = scaleGray(page, pageW, pageH, outScale);
      page = scaled.gray;
      pageW = scaled.width;
      pageH = scaled.height;
    } else {
      outScale = 1;
    }
    const denoised = boxBlur(page, pageW, pageH, 1);
    const sourceGray = options.sharpen === false ? denoised : unsharpGray(page, denoised, 0.9);
    const contrasted = autocontrast(sourceGray, 0.01);
    const geometry = {
      srcWidth,
      srcHeight,
      outWidth: pageW,
      outHeight: pageH,
      angle,
      cropped: Boolean(early || again),
      toOriginal(px, py) {
        const x = px / outScale + cropBox.x;
        const y = py / outScale + cropBox.y;
        const rad = angle * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const dx = x - rotated.width / 2;
        const dy = y - rotated.height / 2;
        const framedX = dx * cos + dy * sin + earlyBox.width / 2;
        const framedY = -dx * sin + dy * cos + earlyBox.height / 2;
        return [(framedX + earlyBox.x) / preScale, (framedY + earlyBox.y) / preScale];
      },
    };
    return {
      width: pageW,
      height: pageH,
      gray: contrasted,
      angle,
      cropped: Boolean(early || again),
      geometry,
    };
  }

  function renderPhotoPass(prepared, pass) {
    const mode = pass === 'strong' || pass === 'gray' ? pass : 'primary';
    return renderPass(prepared.gray, prepared.width, prepared.height, mode);
  }


  return {
    OCR_MIN_SHORT_SIDE,
    preparePhoto,
    renderPhotoPass,
    detectSkew,
    toGrayImage,
    rotateGray,
    unsharpGray,
    boxBlur,
  };
});
