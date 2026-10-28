const assert = require('assert');
const { boxBlur, unsharpGray, toGrayImage } = require('../app/static/js/photo-ocr-preprocess.js');

const width = 40;
const height = 30;
const data = new Uint8ClampedArray(width * height * 4);
data.fill(200);
// Dark vertical stroke — blur softens it; unsharp should restore edge contrast.
for (let y = 5; y < 25; y += 1) {
  const p = (y * width + 20) * 4;
  data[p] = data[p + 1] = data[p + 2] = 30;
}
const gray = toGrayImage({ width, height, data }).gray;
const blurred = boxBlur(gray, width, height, 2);
const sharp = unsharpGray(gray, blurred, 1.2);
const center = 12 * width + 20;
assert.ok(sharp[center] < blurred[center], 'unsharp should darken ink relative to blur');
assert.ok(sharp[center] <= gray[center] + 5, 'unsharp should not invert the stroke');
console.log('ok');
