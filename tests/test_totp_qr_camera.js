const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Cam = require('../app/static/js/totp-qr-camera.js');

function fakeMedia(opts = {}) {
  const made = [];
  return {
    made,
    calls: [],
    async getUserMedia(constraints) {
      this.calls.push(constraints);
      if (opts.error) { const e = new Error('x'); e.name = opts.error; throw e; }
      const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }, { stopped: 0, stop() { this.stopped += 1; } }];
      const stream = { getTracks: () => tracks };
      made.push(tracks);
      return stream;
    },
  };
}

(async () => {
  // Stop after use stops every track.
  const m = fakeMedia();
  const cam = Cam.create(m);
  assert.equal(m.calls.length, 0, 'camera must not open before start()');
  await cam.start();
  assert.equal(m.calls[0].audio, false);
  assert.deepEqual(m.calls[0].video.facingMode, { ideal: 'environment' });
  assert.ok(cam.active());
  cam.stop();
  assert.ok(!cam.active());
  assert.ok(m.made[0].every((t) => t.stopped === 1), 'all tracks stopped on close');

  // Switching camera stops the old stream and asks for the other facing mode.
  await cam.start();
  await cam.flip();
  assert.ok(m.made[1].every((t) => t.stopped === 1), 'old tracks stopped on flip');
  assert.deepEqual(m.calls[2].video.facingMode, { ideal: 'user' });
  cam.stop();
  assert.ok(m.made[2].every((t) => t.stopped === 1));

  // Closing while the permission prompt is open stops the late stream.
  let release;
  const slow = fakeMedia();
  const orig = slow.getUserMedia.bind(slow);
  slow.getUserMedia = (c) => new Promise((r) => { release = () => r(orig(c)); });
  const cam2 = Cam.create(slow);
  const pending = cam2.start();
  cam2.stop();
  release();
  await assert.rejects(pending, (e) => e.cancelled === true);
  assert.ok(slow.made[0].every((t) => t.stopped === 1));
  assert.ok(!cam2.active());

  // Clear messages for denied permission and missing camera.
  await assert.rejects(Cam.create(fakeMedia({ error: 'NotAllowedError' })).start(), /denied.*image or paste/);
  await assert.rejects(Cam.create(fakeMedia({ error: 'NotFoundError' })).start(), /No camera.*image or paste/);
  await assert.rejects(Cam.create(undefined).start(), /No camera/);

  // Vendored decoder is pinned.
  const dir = path.join(__dirname, '../app/static/js/vendor');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'jsQR.js'))).digest('hex');
  assert.equal(sha, 'bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859');
  assert.match(fs.readFileSync(path.join(dir, 'jsQR.LICENSE'), 'utf8'), /Apache License/);

  // No camera or decoder code may reach for the network.
  const src = fs.readFileSync(path.join(__dirname, '../app/static/js/totp-qr-camera.js'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|https?:\/\//.test(src.replace(/\/\/.*$/gm, '')));
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
