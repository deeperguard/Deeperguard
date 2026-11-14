// Voice memo recorder (phase 1, docs/VOICE_MEMO_SPEC.md). Audio chunks stay in
// memory only; storage goes through NotesStore.addAttachment, which encrypts.
const NotesVoiceMemo = (() => {
  const MAX_SECONDS = 45 * 60;
  const WARN_SECONDS = 40 * 60;
  const MAX_BYTES = 40 * 1024 * 1024;
  const WARN_BYTES = 35 * 1024 * 1024;
  const FORMATS = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'm4a' },
  ];

  function pickFormat(MR) {
    if (!MR || typeof MR.isTypeSupported !== 'function') return null;
    return FORMATS.find((f) => MR.isTypeSupported(f.mime)) || null;
  }

  function supportError(env) {
    const nav = env.navigator;
    if (!nav?.mediaDevices?.getUserMedia) return 'Dit apparaat of deze browser heeft geen microfoon-ondersteuning.';
    if (!env.MediaRecorder) return 'Deze browser kan geen audio opnemen (MediaRecorder ontbreekt).';
    if (!pickFormat(env.MediaRecorder)) return 'Deze browser ondersteunt geen bruikbaar opnameformaat.';
    return '';
  }

  function errorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Toegang tot de microfoon is geweigerd. Sta de microfoon toe in je browser om op te nemen.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Er is geen microfoon gevonden.';
    if (name === 'NotReadableError') return 'De microfoon is in gebruik door een andere app.';
    return (err && err.message) || 'Opnemen is mislukt.';
  }

  function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // env: { navigator, MediaRecorder, setInterval, clearInterval, now }
  // hooks: { onTick(sec), onWarn(), onState('recording'|'idle'), onError(msg), onSave(file) }
  function createRecorder(env, hooks = {}) {
    let recorder = null;
    let stream = null;
    let chunks = [];
    let bytes = 0;
    let seconds = 0;
    let timer = null;
    let warned = false;
    let discard = false;
    let fmt = null;
    let starting = false;

    function releaseStream() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (timer != null) env.clearInterval(timer);
      timer = null;
    }

    function finish() {
      const parts = chunks;
      const type = (recorder && recorder.mimeType) || fmt.mime;
      const keep = !discard && parts.length;
      chunks = [];
      bytes = 0;
      recorder = null;
      releaseStream();
      hooks.onState && hooks.onState('idle');
      if (keep) {
        const blob = new Blob(parts, { type });
        const file = new File([blob], `spraakmemo-${stamp(new Date(env.now()))}.${fmt.ext}`, {
          type: type.split(';')[0],
        });
        hooks.onSave && hooks.onSave(file);
      }
    }

    function warnOnce() {
      if (warned) return;
      warned = true;
      hooks.onWarn && hooks.onWarn();
    }

    function stop() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }

    function cancel() {
      discard = true;
      chunks = [];
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else releaseStream();
    }

    async function start() {
      if (recorder || starting) return false;
      const problem = supportError(env);
      if (problem) {
        hooks.onError && hooks.onError(problem);
        return false;
      }
      starting = true;
      fmt = pickFormat(env.MediaRecorder);
      try {
        stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new env.MediaRecorder(stream, { mimeType: fmt.mime, audioBitsPerSecond: 32000 });
      } catch (err) {
        releaseStream();
        recorder = null;
        starting = false;
        hooks.onError && hooks.onError(errorMessage(err));
        return false;
      }
      starting = false;
      chunks = [];
      bytes = 0;
      seconds = 0;
      warned = false;
      discard = false;
      recorder.ondataavailable = (ev) => {
        if (!ev.data || !ev.data.size) return;
        chunks.push(ev.data);
        bytes += ev.data.size;
        if (bytes >= WARN_BYTES) warnOnce();
        if (bytes >= MAX_BYTES) stop();
      };
      recorder.onstop = finish;
      recorder.onerror = (ev) => {
        discard = true;
        hooks.onError && hooks.onError(errorMessage(ev && ev.error));
        stop();
        if (recorder && recorder.state === 'inactive') finish();
      };
      recorder.start(1000);
      hooks.onState && hooks.onState('recording');
      timer = env.setInterval(() => {
        seconds += 1;
        hooks.onTick && hooks.onTick(seconds);
        if (seconds >= WARN_SECONDS) warnOnce();
        if (seconds >= MAX_SECONDS) stop();
      }, 1000);
      return true;
    }

    return { start, stop, cancel, isRecording: () => !!recorder };
  }

  const api = { createRecorder, pickFormat, supportError, errorMessage, MAX_SECONDS, WARN_SECONDS, MAX_BYTES, WARN_BYTES };
  return api;
})();
if (typeof window !== 'undefined') window.NotesVoiceMemo = NotesVoiceMemo;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesVoiceMemo;
