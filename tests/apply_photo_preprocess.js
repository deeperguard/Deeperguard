#!/usr/bin/env node
/**
 * Read a raw RGBA photo (uint32 LE width, uint32 LE height, RGBA bytes),
 * run the on-device photo preprocess, and write a PNG.
 *
 *   node tests/apply_photo_preprocess.js input.rgba output.png primary|strong|gray|legacy
 *
 * legacy is the previous client preprocess: upscale when the short side is
 * under 1800, then grayscale, contrast 1.35, brightness 1.05. No deskew.
 */
const fs = require('fs');
const { preparePhoto, renderPhotoPass } = require('../app/static/js/photo-ocr-preprocess.js');

function readRgba(path) {
  const buf = fs.readFileSync(path);
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, width * height * 4);
  return { width, height, data: new Uint8ClampedArray(data) };
}

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value | 0;
}

function legacyEnhance(image) {
  const srcW = image.width;
  const srcH = image.height;
  let scale = 1;
  const minDim = Math.min(srcW, srcH);
  if (minDim < 1800) scale = Math.min(2.5, 1800 / Math.max(minDim, 1));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const maxX = srcW - 1;
  const maxY = srcH - 1;
  for (let y = 0; y < height; y += 1) {
    const sy = scale === 1 ? y : (y + 0.5) * srcH / height - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(maxY, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = scale === 1 ? x : (x + 0.5) * srcW / width - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(maxX, x0 + 1);
      const fx = sx - x0;
      const samples = [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy],
      ];
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [px, py, w] of samples) {
        const p = (py * srcW + px) * 4;
        r += image.data[p] * w;
        g += image.data[p + 1] * w;
        b += image.data[p + 2] * w;
      }
      let gray = (r * 77 + g * 150 + b * 29) / 256 / 255;
      gray = (gray - 0.5) * 1.35 + 0.5;
      gray *= 1.05;
      const v = clampByte(gray * 255);
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

function encodePpm(image) {
  const { width, height, data } = image;
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i < width * height; i += 1, o += 3) {
    const s = i * 4;
    rgb[o] = data[s];
    rgb[o + 1] = data[s + 1];
    rgb[o + 2] = data[s + 2];
  }
  return Buffer.concat([header, rgb]);
}

const [input, output, mode] = process.argv.slice(2);
if (!input || !output || !mode) {
  console.error('usage: apply_photo_preprocess.js input.rgba output.png primary|strong|gray|legacy');
  process.exit(2);
}
const image = readRgba(input);
let rendered;
let meta = {};
if (mode === 'legacy') {
  rendered = legacyEnhance(image);
} else {
  const prepared = preparePhoto(image, { maxPixels: 3500000 });
  rendered = renderPhotoPass(prepared, mode);
  meta = {
    angle: prepared.angle,
    cropped: prepared.cropped,
    width: prepared.width,
    height: prepared.height,
  };
}
fs.writeFileSync(output, encodePpm(rendered));
if (process.env.PHOTO_OCR_META === '1') process.stdout.write(`${JSON.stringify(meta)}\n`);
