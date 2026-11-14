// Camera stream control for the 2FA QR scanner (docs/2FA_IMPORT_SPEC.md, section 5.3).
// The camera is only opened by start(), which the UI calls after a click. stop() stops every
// track. Frames are only drawn for decoding in the caller and are never stored or sent.
const NotesTotpCamera = (() => {
  function explain(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera access was denied. Allow the camera in your browser settings, or choose an image or paste the QR code instead.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      return 'No camera was found. Choose an image or paste the QR code instead.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'The camera is in use by another app. Close it and try again, or choose an image instead.';
    }
    return 'The camera could not be started. Choose an image or paste the QR code instead.';
  }

  function create(mediaDevices) {
    let stream = null;
    let facing = 'environment';
    let token = 0;

    function stop() {
      token += 1;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
    }

    async function start() {
      stop();
      if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
        throw new Error(explain({ name: 'NotFoundError' }));
      }
      const mine = token;
      let s;
      try {
        s = await mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
      } catch (err) {
        throw new Error(explain(err));
      }
      if (mine !== token) { // closed while the permission prompt was open
        s.getTracks().forEach((track) => track.stop());
        const e = new Error('cancelled');
        e.cancelled = true;
        throw e;
      }
      stream = s;
      return s;
    }

    async function flip() {
      facing = facing === 'environment' ? 'user' : 'environment';
      return start();
    }

    return { start, stop, flip, active: () => !!stream };
  }

  const api = { create, explain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
