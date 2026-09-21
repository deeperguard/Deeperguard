const assert = require('assert');

function emptyUploadSource() {
  return { handles: [], label: '', fromDevice: false, fromCamera: false };
}

function mergeUploadSource(target, { handles = [], label = '', fromDevice = false, fromCamera = false } = {}) {
  const out = target || emptyUploadSource();
  if (Array.isArray(handles) && handles.length) {
    out.handles = out.handles || [];
    handles.forEach((handle) => {
      if (handle && typeof handle.remove === 'function') out.handles.push(handle);
    });
  }
  if (label && !out.label) out.label = label;
  if (fromDevice) out.fromDevice = true;
  if (fromCamera) out.fromCamera = true;
  return out;
}

function sourceLabelFromFiles(files, fallback = 'document') {
  const list = (files || []).filter(Boolean);
  if (!list.length) return fallback;
  if (list.length === 1) return list[0].name || fallback;
  return `${list.length} files`;
}

function sourceRemovalFromPending(pending) {
  if (!pending?.sourceRemoval) return null;
  const sr = pending.sourceRemoval;
  const handles = (sr.handles || []).filter((h) => h && typeof h.remove === 'function');
  if (!sr.fromDevice && !handles.length) return null;
  return {
    handles,
    fromDevice: !!sr.fromDevice,
    fromCamera: !!sr.fromCamera,
    label: sr.label || pending.file?.name || sourceLabelFromFiles(pending.pages, 'document'),
  };
}

const removable = { remove: async () => {} };
const merged = mergeUploadSource(emptyUploadSource(), { handles: [removable], label: 'invoice.pdf', fromDevice: true });
assert.strictEqual(merged.handles.length, 1);
assert.strictEqual(merged.label, 'invoice.pdf');
assert.strictEqual(merged.fromDevice, true);

const iosPending = {
  pages: [{ name: 'photo.jpg' }],
  sourceRemoval: { fromDevice: true, fromCamera: true, label: 'photo.jpg', handles: [] },
};
assert.deepStrictEqual(sourceRemovalFromPending(iosPending), {
  handles: [],
  fromDevice: true,
  fromCamera: true,
  label: 'photo.jpg',
});

const pending = {
  file: { name: 'scan.pdf' },
  pages: [],
  sourceRemoval: { handles: [removable], label: '' },
};
assert.deepStrictEqual(sourceRemovalFromPending(pending), {
  handles: [removable],
  fromDevice: false,
  fromCamera: false,
  label: 'scan.pdf',
});
assert.strictEqual(sourceRemovalFromPending({ pages: [{ name: 'a.jpg' }] }), null);
assert.strictEqual(sourceLabelFromFiles([{ name: 'a.pdf' }, { name: 'b.pdf' }]), '2 files');

console.log('ok');
