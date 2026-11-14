/* Registry for object URLs that point at decrypted content, so lock/logout can revoke them all. */
(function (root) {
  'use strict';
  const live = new Set();
  const NotesBlobUrls = {
    create(blob) {
      const url = URL.createObjectURL(blob);
      live.add(url);
      return url;
    },
    revoke(url) {
      if (!url) return;
      live.delete(url);
      try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ }
    },
    revokeAll() {
      for (const url of [...live]) NotesBlobUrls.revoke(url);
      // Detach anything in the DOM still pointing at a blob: URL so it cannot be re-fetched.
      try {
        const doc = root.document;
        if (doc && doc.querySelectorAll) {
          doc.querySelectorAll('img[src^="blob:"],video[src^="blob:"],audio[src^="blob:"],iframe[src^="blob:"]')
            .forEach((el) => { el.removeAttribute('src'); });
        }
      } catch (err) { /* ignore */ }
    },
    count() { return live.size; },
  };
  root.NotesBlobUrls = NotesBlobUrls;
})(typeof window !== 'undefined' ? window : globalThis);
