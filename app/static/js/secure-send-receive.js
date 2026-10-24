/**
 * D2 receive page — Open burns a view; GET/HEAD of /receive never does.
 */
(function () {
  'use strict';

  const bootEl = document.getElementById('receive-boot');
  let boot = {};
  try {
    boot = JSON.parse(bootEl ? bootEl.textContent : '{}');
  } catch (err) {
    boot = {};
  }

  const sendId = String(boot.sendId || '');
  const linkStopped = String(boot.linkStopped || (window.NotesSecureSend && NotesSecureSend.LINK_STOPPED) || 'This link has stopped working.');
  const fragment = String(location.hash || '').replace(/^#/, '');

  const gate = document.getElementById('receive-gate');
  const result = document.getElementById('receive-result');
  const errEl = document.getElementById('receive-error');
  const passWrap = document.getElementById('receive-pass-wrap');
  const passInput = document.getElementById('receive-passphrase');
  const openBtn = document.getElementById('receive-open');
  const titleEl = document.getElementById('receive-title');
  const bodyEl = document.getElementById('receive-body');
  const fileRow = document.getElementById('receive-file-row');
  const downloadBtn = document.getElementById('receive-download');

  function showError(msg) {
    if (!errEl) return;
    errEl.hidden = false;
    errEl.textContent = msg;
  }

  function hideError() {
    if (!errEl) return;
    errEl.hidden = true;
    errEl.textContent = '';
  }

  // Passphrase UI comes only from the fragment (server never stores that flag).
  if (passWrap && window.NotesSecureSend && NotesSecureSend.fragmentNeedsPassphrase(fragment)) {
    passWrap.hidden = false;
  }

  if (!fragment) {
    showError('This link is missing its key. Ask the sender for the full link (including the part after #).');
    if (openBtn) openBtn.disabled = true;
  }

  let pendingFile = null;

  async function onOpen() {
    hideError();
    if (!window.NotesSecureSend || !sendId) {
      showError(linkStopped);
      return;
    }
    if (!fragment) {
      showError('This link is missing its key.');
      return;
    }
    const needsPass = NotesSecureSend.fragmentNeedsPassphrase(fragment);
    if (needsPass) {
      if (passWrap) passWrap.hidden = false;
      const pass = passInput ? String(passInput.value || '') : '';
      if (!pass) {
        showError('Enter the passphrase the sender shared separately. The link alone cannot open this.');
        return;
      }
    }
    openBtn.disabled = true;
    openBtn.textContent = 'Opening…';
    try {
      const body = {};
      NotesSecureSend.assertNoFragmentLeak(`/api/secure-send/${sendId}/open`, body);
      const res = await fetch(`/api/secure-send/${encodeURIComponent(sendId)}/open`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 404) {
        showError(linkStopped);
        openBtn.disabled = true;
        openBtn.textContent = 'Open';
        return;
      }
      if (!res.ok) {
        showError(res.status === 429 ? 'Too many attempts. Try again later.' : linkStopped);
        openBtn.disabled = false;
        openBtn.textContent = 'Open';
        return;
      }
      const data = await res.json();
      const passphrase = passInput ? passInput.value : '';
      let payload;
      try {
        payload = await NotesSecureSend.openPayload(data.ciphertext, fragment, passphrase);
      } catch (err) {
        if (err && err.code === 'passphrase_required') {
          if (passWrap) passWrap.hidden = false;
          showError('Enter the passphrase the sender shared separately.');
          openBtn.disabled = false;
          openBtn.textContent = 'Open';
          return;
        }
        showError('Could not decrypt. Check the passphrase, or the link may be wrong.');
        openBtn.disabled = false;
        openBtn.textContent = 'Open';
        return;
      }
      if (gate) gate.hidden = true;
      if (result) result.hidden = false;
      if (titleEl) titleEl.textContent = String(payload.title || '(untitled)');
      if (bodyEl) bodyEl.textContent = String(payload.body || '');
      if (payload.file && payload.file.data) {
        pendingFile = payload.file;
        if (fileRow) fileRow.hidden = false;
        if (downloadBtn) {
          downloadBtn.textContent = `Download ${payload.file.name || 'file'}`;
        }
      }
    } catch (err) {
      showError(linkStopped);
      openBtn.disabled = false;
      openBtn.textContent = 'Open';
    }
  }

  function onDownload() {
    if (!pendingFile || !window.NotesSecureSend) return;
    try {
      const bytes = NotesSecureSend.fromB64url(pendingFile.data);
      // MIME/name come from decrypted ciphertext only — never from the server.
      const blob = new Blob([bytes], {
        type: pendingFile.mime || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = NotesSecureSend.downloadNameFromPayload(pendingFile);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      showError('Could not prepare the download.');
    }
  }

  if (openBtn) openBtn.addEventListener('click', () => { onOpen(); });
  if (downloadBtn) downloadBtn.addEventListener('click', () => { onDownload(); });
})();
