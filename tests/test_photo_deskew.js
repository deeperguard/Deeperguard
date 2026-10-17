const assert = require('assert');
const { preparePhoto, rotateGray, toGrayImage } = require('../app/static/js/photo-ocr-preprocess.js');

function ruledPage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(245);
  for (let y = 40; y < height - 40; y += 36) {
    for (let row = 0; row < 4; row += 1) {
      const yy = y + row;
      if (yy >= height) continue;
      for (let x = 36; x < width - 36; x += 1) {
        const gap = Math.floor((x - 36) / 28) % 2 === 1;
        if (gap) continue;
        const p = (yy * width + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = 20;
        data[p + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

const page = ruledPage(640, 880);
const gray = toGrayImage(page);
const skewed = rotateGray(gray.gray, gray.width, gray.height, 8);
const rgba = new Uint8ClampedArray(skewed.width * skewed.height * 4);
for (let i = 0, p = 0; i < skewed.gray.length; i += 1, p += 4) {
  rgba[p] = rgba[p + 1] = rgba[p + 2] = skewed.gray[i];
  rgba[p + 3] = 255;
}
const prepared = preparePhoto({ width: skewed.width, height: skewed.height, data: rgba }, { maxPixels: 2000000 });
const correction = prepared.angle;
assert.ok(
  Math.abs(correction + 8) <= 1.25,
  `expected deskew near -8 degrees, got ${correction}`,
);
assert.ok(prepared.width >= 640, `upscale should keep the page readable, width ${prepared.width}`);
console.log(`deskew ${correction}`);
