/**
 * Client-only encrypted backup helpers: save/share file (iCloud via Web Share)
 * and optional Google Drive upload (drive.file). Tokens stay in the browser.
 */
const NotesCloudBackup = (() => {
  const PREFS_KEY = 'deeperguard-cloud-backup';
  const DRIVE_FOLDER = 'Deeperguard Backups';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';

  let tokenClient = null;
  let accessToken = '';
  let tokenExpiresAt = 0;
  let gisLoading = null;

  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
    } catch (err) {
      return {};
    }
  }

  function writePrefs(patch) {
    const next = { ...readPrefs(), ...patch };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (err) { /* ignore */ }
    return next;
  }

  function googleClientId() {
    const meta = document.querySelector('meta[name="google-oauth-client-id"]');
    const fromMeta = (meta && meta.getAttribute('content') || '').trim();
    if (fromMeta) return fromMeta;
    const root = document.getElementById('app');
    return String(root?.dataset?.googleOauthClientId || '').trim();
  }

  function isGoogleConfigured() {
    return !!googleClientId();
  }

  function backupFilename(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `deeperguard-backup-${y}-${m}-${d}.dgbackup`;
  }

  function backupBlobFromObject(backup) {
    const text = typeof backup === 'string' ? backup : JSON.stringify(backup, null, 2);
    return new Blob([text], { type: 'application/json' });
  }

  function canShareFiles(file) {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
      if (typeof navigator.canShare !== 'function') return false;
      return navigator.canShare({ files: [file] });
    } catch (err) {
      return false;
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || backupFilename();
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return { method: 'download', filename: a.download };
  }

  async function saveBackupFile(blob, { filename } = {}) {
    const name = filename || backupFilename();
    const file = blob instanceof File
      ? blob
      : new File([blob], name, { type: blob.type || 'application/json' });
    if (canShareFiles(file)) {
      try {
        await navigator.share({
          files: [file],
          title: 'Deeperguard encrypted backup',
          text: 'Save to Files → iCloud Drive on iPhone.',
        });
        writePrefs({ lastLocalBackupAt: new Date().toISOString(), lastLocalMethod: 'share' });
        return { method: 'share', filename: name };
      } catch (err) {
        if (err && (err.name === 'AbortError' || /cancel/i.test(String(err.message || '')))) {
          return { method: 'share-cancelled', filename: name };
        }
        // Fall through to download.
      }
    }
    const result = triggerDownload(blob instanceof Blob ? blob : file, name);
    writePrefs({ lastLocalBackupAt: new Date().toISOString(), lastLocalMethod: 'download' });
    return result;
  }

  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Google sign-in failed to load')));
        return;
      }
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      // Match page CSP nonce so accounts.google.com GIS can load.
      const nonceEl = document.querySelector('script[nonce]');
      const nonce = nonceEl && (nonceEl.nonce || nonceEl.getAttribute('nonce'));
      if (nonce) s.setAttribute('nonce', nonce);
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Google sign-in failed to load'));
      document.head.appendChild(s);
    });
    return gisLoading;
  }

  function requestAccessToken({ prompt = '' } = {}) {
    const clientId = googleClientId();
    if (!clientId) return Promise.reject(new Error('Google Drive is not configured'));
    return loadGis().then(() => new Promise((resolve, reject) => {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(resp.error_description || resp.error || 'Google auth failed'));
            return;
          }
          accessToken = resp.access_token || '';
          const expiresIn = Number(resp.expires_in) || 3600;
          tokenExpiresAt = Date.now() + (expiresIn * 1000) - 15000;
          writePrefs({ driveConnected: true });
          resolve(accessToken);
        },
        error_callback: (err) => {
          reject(new Error(err?.message || 'Google auth cancelled'));
        },
      });
      tokenClient.requestAccessToken({ prompt });
    }));
  }

  async function ensureAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
    return requestAccessToken({ prompt: '' });
  }

  async function driveFetch(path, options = {}) {
    const token = await ensureAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    };
    const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
      ...options,
      headers,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Google Drive HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res;
  }

  async function ensureBackupFolder() {
    const prefs = readPrefs();
    if (prefs.driveFolderId) {
      try {
        await driveFetch(`/files/${encodeURIComponent(prefs.driveFolderId)}?fields=id,name,trashed`);
        return prefs.driveFolderId;
      } catch (err) {
        /* recreate */
      }
    }
    const q = encodeURIComponent(
      `name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );
    const listed = await driveFetch(`/files?q=${q}&spaces=drive&fields=files(id,name)`);
    const existing = (listed.files || [])[0];
    if (existing?.id) {
      writePrefs({ driveFolderId: existing.id });
      return existing.id;
    }
    const created = await driveFetch('/files?fields=id,name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_FOLDER,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    writePrefs({ driveFolderId: created.id });
    return created.id;
  }

  async function uploadBackupBlob(blob, { filename } = {}) {
    const name = filename || backupFilename();
    const folderId = await ensureBackupFolder();
    const token = await ensureAccessToken();
    const metadata = {
      name,
      parents: [folderId],
      mimeType: 'application/json',
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob, name);
    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,modifiedTime,size',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Upload failed (${res.status})`);
    }
    const file = await res.json();
    writePrefs({
      lastDriveBackupAt: file.modifiedTime || file.createdTime || new Date().toISOString(),
      lastDriveFileId: file.id,
      lastDriveFileName: file.name,
    });
    return file;
  }

  async function listDriveBackups({ limit = 10 } = {}) {
    const folderId = await ensureBackupFolder();
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const data = await driveFetch(
      `/files?q=${q}&orderBy=modifiedTime desc&pageSize=${Math.max(1, Math.min(50, limit))}`
      + '&fields=files(id,name,modifiedTime,createdTime,size)',
    );
    return data.files || [];
  }

  async function downloadDriveBackup(fileId) {
    const token = await ensureAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return res.text();
  }

  function disconnectGoogle() {
    const revoke = () => {
      accessToken = '';
      tokenExpiresAt = 0;
      writePrefs({
        driveConnected: false,
        driveFolderId: '',
        lastDriveFileId: '',
      });
    };
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      return new Promise((resolve) => {
        window.google.accounts.oauth2.revoke(accessToken, () => {
          revoke();
          resolve();
        });
      });
    }
    revoke();
    return Promise.resolve();
  }

  function shouldAutoBackupDaily() {
    return !!readPrefs().autoDailyDrive;
  }

  function setAutoDailyDrive(on) {
    return writePrefs({ autoDailyDrive: !!on });
  }

  function dueForDailyDriveBackup(now = Date.now()) {
    if (!shouldAutoBackupDaily()) return false;
    const last = Date.parse(readPrefs().lastDriveBackupAt || '') || 0;
    return !last || (now - last) > 20 * 60 * 60 * 1000;
  }

  return {
    PREFS_KEY,
    DRIVE_FOLDER,
    backupFilename,
    backupBlobFromObject,
    canShareFiles,
    saveBackupFile,
    triggerDownload,
    isGoogleConfigured,
    googleClientId,
    requestAccessToken,
    ensureAccessToken,
    uploadBackupBlob,
    listDriveBackups,
    downloadDriveBackup,
    disconnectGoogle,
    readPrefs,
    writePrefs,
    shouldAutoBackupDaily,
    setAutoDailyDrive,
    dueForDailyDriveBackup,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NotesCloudBackup;
}
