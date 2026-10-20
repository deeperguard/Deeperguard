/**
 * Client-only encrypted backup helpers: save/share file (iCloud via Web Share),
 * optional Google Drive upload (drive.file), and optional Dropbox App-folder
 * upload (OAuth 2 PKCE). Tokens stay in the browser — never sent to our server.
 */
const NotesCloudBackup = (() => {
  // Dropbox PKCE popup callback: hand code/state to the opener and close so the
  // main tab (and unlocked vault) never navigates away.
  try {
    if (typeof window !== 'undefined' && window.opener && window.opener !== window) {
      const params = new URLSearchParams(window.location.search || '');
      const state = String(params.get('state') || '');
      if (state.startsWith('dg-dropbox:')) {
        window.opener.postMessage(
          { type: 'dg-dropbox-oauth', search: window.location.search },
          window.location.origin,
        );
        try { window.close(); } catch (err) { /* ignore */ }
      }
    }
  } catch (err) { /* ignore */ }

  const PREFS_KEY = 'deeperguard-cloud-backup';
  const DRIVE_FOLDER = 'Deeperguard Backups';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const DROPBOX_SCOPES = 'files.content.write files.content.read';
  const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
  const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const DROPBOX_API = 'https://api.dropboxapi.com/2';
  const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
  const DROPBOX_PKCE_VERIFIER_KEY = 'dg-dropbox-pkce-verifier';
  const DROPBOX_PKCE_STATE_KEY = 'dg-dropbox-pkce-state';
  const DROPBOX_PENDING_KEY = 'dg-dropbox-pending-action';

  let tokenClient = null;
  let accessToken = '';
  let tokenExpiresAt = 0;
  let gisLoading = null;
  let dropboxAccessToken = '';
  let dropboxTokenExpiresAt = 0;
  // Per-account OAuth app IDs from encrypted vault settings (not secrets).
  let userGoogleClientId = '';
  let userDropboxAppKey = '';
  let accountScopeId = '';

  function accountScope() {
    try {
      const fromStore = (typeof NotesStore !== 'undefined' && NotesStore.cachedAccount)
        ? String(NotesStore.cachedAccount()?.email || '').trim().toLowerCase()
        : '';
      if (fromStore) return fromStore;
      return String(accountScopeId || sessionStorage.getItem('notes_email') || '').trim().toLowerCase();
    } catch (err) {
      return String(accountScopeId || '').trim().toLowerCase();
    }
  }

  function prefsStorageKey() {
    const scope = accountScope();
    return scope ? `${PREFS_KEY}:${scope}` : PREFS_KEY;
  }

  function setAccountScope(email) {
    accountScopeId = String(email || '').trim().toLowerCase();
  }

  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem(prefsStorageKey()) || '{}') || {};
    } catch (err) {
      return {};
    }
  }

  function writePrefs(patch) {
    const next = { ...readPrefs(), ...patch };
    try {
      localStorage.setItem(prefsStorageKey(), JSON.stringify(next));
    } catch (err) { /* ignore */ }
    return next;
  }

  function isValidGoogleClientId(value) {
    const id = String(value || '').trim();
    return /^[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(id);
  }

  function isValidDropboxAppKey(value) {
    const key = String(value || '').trim();
    return /^[a-z0-9]{10,25}$/i.test(key);
  }

  function serverGoogleClientId() {
    const meta = document.querySelector('meta[name="google-oauth-client-id"]');
    const fromMeta = (meta && meta.getAttribute('content') || '').trim();
    if (fromMeta) return fromMeta;
    const root = document.getElementById('app');
    return String(root?.dataset?.googleOauthClientId || '').trim();
  }

  function serverDropboxAppKey() {
    const meta = document.querySelector('meta[name="dropbox-app-key"]');
    const fromMeta = (meta && meta.getAttribute('content') || '').trim();
    if (fromMeta) return fromMeta;
    const root = document.getElementById('app');
    return String(root?.dataset?.dropboxAppKey || '').trim();
  }

  function setUserProviderKeys({ googleClientId = undefined, dropboxAppKey = undefined } = {}) {
    if (googleClientId !== undefined) {
      const next = String(googleClientId || '').trim();
      if (next !== userGoogleClientId) {
        userGoogleClientId = next;
      }
    }
    if (dropboxAppKey !== undefined) {
      const next = String(dropboxAppKey || '').trim();
      if (next !== userDropboxAppKey) {
        userDropboxAppKey = next;
      }
    }
  }

  function userProviderKeys() {
    return {
      googleClientId: userGoogleClientId,
      dropboxAppKey: userDropboxAppKey,
    };
  }

  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key) || '';
    } catch (err) {
      return '';
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (err) { /* ignore */ }
  }

  function sessionClear(...keys) {
    try {
      keys.forEach((k) => sessionStorage.removeItem(k));
    } catch (err) { /* ignore */ }
  }

  function googleClientId() {
    // Resolution: user vault key → server env → none.
    if (userGoogleClientId) return userGoogleClientId;
    return serverGoogleClientId();
  }

  function googleKeySource() {
    if (userGoogleClientId) return 'user';
    if (serverGoogleClientId()) return 'server';
    return '';
  }

  function isGoogleConfigured() {
    return !!googleClientId();
  }

  function dropboxAppKey() {
    if (userDropboxAppKey) return userDropboxAppKey;
    return serverDropboxAppKey();
  }

  function dropboxKeySource() {
    if (userDropboxAppKey) return 'user';
    if (serverDropboxAppKey()) return 'server';
    return '';
  }

  function isDropboxConfigured() {
    return !!dropboxAppKey();
  }

  /** Exact redirect URI registered in the Dropbox App Console. */
  function dropboxRedirectUri() {
    const origin = (typeof location !== 'undefined' && location.origin) || '';
    return `${origin}/app`;
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

  function mapGoogleAuthError(err) {
    const type = String(err?.type || '').toLowerCase();
    const raw = String(err?.message || err?.type || err || '');
    if (type === 'popup_failed_to_open' || (/popup/i.test(raw) && /block|failed.?to.?open/i.test(raw))) {
      return 'Popup was blocked — allow popups for deeperguard.com.';
    }
    if (type === 'popup_closed' || /popup.*closed|window closed/i.test(raw)) {
      return 'Google sign-in didn’t complete. Check your Client ID and try again.';
    }
    if (/invalid|unknown.?client|not configured/i.test(raw)) {
      return 'Google sign-in didn’t complete. Check your Client ID and try again.';
    }
    return raw || 'Google sign-in didn’t complete. Check your Client ID and try again.';
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
            reject(new Error(mapGoogleAuthError({
              type: resp.error,
              message: resp.error_description || resp.error || 'Google auth failed',
            })));
            return;
          }
          accessToken = resp.access_token || '';
          const expiresIn = Number(resp.expires_in) || 3600;
          tokenExpiresAt = Date.now() + (expiresIn * 1000) - 15000;
          writePrefs({ driveConnected: true });
          refreshGoogleAccountLabel().catch(() => {});
          resolve(accessToken);
        },
        error_callback: (err) => {
          reject(new Error(mapGoogleAuthError(err)));
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

  async function refreshGoogleAccountLabel() {
    try {
      const token = accessToken || await ensureAccessToken();
      if (!token) return '';
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return '';
      const data = await res.json();
      const label = String(data?.user?.emailAddress || data?.user?.displayName || '').trim();
      if (label) writePrefs({ driveAccountLabel: label });
      return label;
    } catch (err) {
      return '';
    }
  }

  function disconnectGoogle() {
    const revoke = () => {
      accessToken = '';
      tokenExpiresAt = 0;
      writePrefs({
        driveConnected: false,
        driveFolderId: '',
        lastDriveFileId: '',
        driveAccountLabel: '',
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

  // --- Dropbox (OAuth 2 PKCE, App folder) ---

  function base64UrlEncode(bytes) {
    let binary = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
    const b64 = (typeof btoa === 'function' ? btoa(binary) : Buffer.from(arr).toString('base64'));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomVerifier() {
    const bytes = new Uint8Array(32);
    const cryptoObj = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto
      : (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (!cryptoObj?.getRandomValues) throw new Error('Secure random unavailable for Dropbox PKCE');
    cryptoObj.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  }

  async function sha256Base64Url(text) {
    const cryptoObj = (typeof crypto !== 'undefined' && crypto.subtle)
      ? crypto
      : (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (!cryptoObj?.subtle) throw new Error('Web Crypto unavailable for Dropbox PKCE');
    const data = new TextEncoder().encode(text);
    const digest = await cryptoObj.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(digest));
  }

  function rememberDropboxTokens(payload) {
    const expiresIn = Number(payload.expires_in) || 14400;
    dropboxAccessToken = payload.access_token || '';
    dropboxTokenExpiresAt = Date.now() + (expiresIn * 1000) - 30000;
    const patch = {
      dropboxConnected: true,
      dropboxAccessToken,
      dropboxTokenExpiresAt,
    };
    if (payload.refresh_token) patch.dropboxRefreshToken = payload.refresh_token;
    writePrefs(patch);
    return dropboxAccessToken;
  }

  function clearDropboxTokensLocal() {
    dropboxAccessToken = '';
    dropboxTokenExpiresAt = 0;
    writePrefs({
      dropboxConnected: false,
      dropboxAccessToken: '',
      dropboxRefreshToken: '',
      dropboxTokenExpiresAt: 0,
      lastDropboxFilePath: '',
      dropboxAccountLabel: '',
    });
  }

  async function refreshDropboxAccountLabel() {
    try {
      const token = dropboxAccessToken || await ensureDropboxToken({ interactive: false });
      if (!token) return '';
      const res = await fetch(`${DROPBOX_API}/users/get_current_account`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: 'null',
      });
      if (!res.ok) return '';
      const data = await res.json();
      const label = String(data?.email || data?.name?.display_name || '').trim();
      if (label) writePrefs({ dropboxAccountLabel: label });
      return label;
    } catch (err) {
      return '';
    }
  }

  function loadCachedDropboxToken() {
    const prefs = readPrefs();
    if (prefs.dropboxAccessToken) {
      dropboxAccessToken = prefs.dropboxAccessToken;
      dropboxTokenExpiresAt = Number(prefs.dropboxTokenExpiresAt) || 0;
    }
    return dropboxAccessToken;
  }

  async function refreshDropboxAccessToken() {
    const prefs = readPrefs();
    const refresh = prefs.dropboxRefreshToken || '';
    const key = dropboxAppKey();
    if (!refresh || !key) return '';
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: key,
    });
    const res = await fetch(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      clearDropboxTokensLocal();
      return '';
    }
    const payload = await res.json();
    if (!payload.access_token) {
      clearDropboxTokensLocal();
      return '';
    }
    return rememberDropboxTokens({ ...payload, refresh_token: refresh });
  }

  function openDropboxOAuthPopup(url) {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || typeof window.open !== 'function') {
        reject(new Error('Dropbox sign-in requires a browser window'));
        return;
      }
      const popup = window.open(
        url,
        'dg-dropbox-oauth',
        'width=640,height=720,menubar=no,toolbar=no,status=no,resizable=yes,scrollbars=yes',
      );
      if (!popup) {
        reject(new Error('Popup was blocked — allow popups for deeperguard.com.'));
        return;
      }
      let settled = false;
      let focusTimer = null;
      const openedAt = Date.now();
      // Do not poll popup.closed — COOP on Dropbox's authorize page logs red
      // "policy would block the window.closed call" console errors. Rely on
      // same-origin postMessage after redirect, opener focus + grace, and timeout.
      const DROPBOX_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
      const FOCUS_IGNORE_MS = 1500;
      const FOCUS_CANCEL_GRACE_MS = 900;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        window.removeEventListener('focus', onFocus);
        clearTimeout(hardTimeout);
        if (focusTimer) clearTimeout(focusTimer);
        // Never call popup.close() from the opener: while the popup is on
        // dropbox.com, COOP logs red "would block the window.close call" errors.
        // On success the /app redirect page postMessages then window.close()s itself.
        fn(value);
      };
      const cancelMsg = 'Dropbox sign-in didn’t complete. Check your App key and try again.';
      const onMessage = (event) => {
        try {
          if (event.origin !== window.location.origin) return;
          if (!event.data || event.data.type !== 'dg-dropbox-oauth') return;
          finish(resolve, String(event.data.search || ''));
        } catch (err) {
          finish(reject, err);
        }
      };
      const onFocus = () => {
        if (settled) return;
        if (Date.now() - openedAt < FOCUS_IGNORE_MS) return;
        if (focusTimer) clearTimeout(focusTimer);
        // User returned to this tab; give a late postMessage a moment, then cancel.
        focusTimer = setTimeout(() => {
          finish(reject, new Error(cancelMsg));
        }, FOCUS_CANCEL_GRACE_MS);
      };
      const hardTimeout = setTimeout(() => {
        finish(reject, new Error(cancelMsg));
      }, DROPBOX_OAUTH_TIMEOUT_MS);
      window.addEventListener('message', onMessage);
      window.addEventListener('focus', onFocus);
    });
  }

  async function beginDropboxOAuth({ pending = '' } = {}) {
    const key = dropboxAppKey();
    if (!key) throw new Error('Dropbox is not configured');
    if (!isValidDropboxAppKey(key)) {
      throw new Error('Dropbox App key should be 10–25 letters or digits');
    }
    const verifier = randomVerifier();
    const challenge = await sha256Base64Url(verifier);
    const state = `dg-dropbox:${randomVerifier()}`;
    sessionSet(DROPBOX_PKCE_VERIFIER_KEY, verifier);
    sessionSet(DROPBOX_PKCE_STATE_KEY, state);
    sessionSet(DROPBOX_PENDING_KEY, pending || '');
    const params = new URLSearchParams({
      client_id: key,
      response_type: 'code',
      token_access_type: 'offline',
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      redirect_uri: dropboxRedirectUri(),
      scope: DROPBOX_SCOPES,
    });
    const url = `${DROPBOX_AUTH_URL}?${params.toString()}`;
    // Popup keeps the vault tab in place (full-page redirect stranded users on
    // Dropbox authorize_error and re-locked the vault).
    const search = await openDropboxOAuthPopup(url);
    return consumeDropboxOAuthRedirect({ search });
  }

  function peekDropboxOAuthParams(search = '') {
    const q = new URLSearchParams(
      search
      || (typeof location !== 'undefined' ? location.search : '')
      || '',
    );
    const code = (q.get('code') || '').trim();
    const state = (q.get('state') || '').trim();
    const error = (q.get('error') || '').trim();
    if (!code && !error) return null;
    if (state && !state.startsWith('dg-dropbox:')) return null;
    return { code, state, error, errorDescription: (q.get('error_description') || '').trim() };
  }

  function stripDropboxOAuthParamsFromUrl() {
    try {
      if (typeof history === 'undefined' || typeof location === 'undefined') return;
      const url = new URL(location.href);
      ['code', 'state', 'error', 'error_description'].forEach((k) => url.searchParams.delete(k));
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch (err) { /* ignore */ }
  }

  async function consumeDropboxOAuthRedirect({ search } = {}) {
    const params = peekDropboxOAuthParams(search);
    if (!params) return null;
    const expectedState = sessionGet(DROPBOX_PKCE_STATE_KEY);
    const verifier = sessionGet(DROPBOX_PKCE_VERIFIER_KEY);
    const pending = sessionGet(DROPBOX_PENDING_KEY);
    sessionClear(DROPBOX_PKCE_STATE_KEY, DROPBOX_PKCE_VERIFIER_KEY, DROPBOX_PENDING_KEY);
    stripDropboxOAuthParamsFromUrl();
    if (params.error) {
      throw new Error(params.errorDescription || params.error || 'Dropbox auth failed');
    }
    if (!params.code) throw new Error('Dropbox auth missing code');
    if (!expectedState || params.state !== expectedState) {
      throw new Error('Dropbox auth state mismatch');
    }
    if (!verifier) throw new Error('Dropbox PKCE verifier missing');
    const key = dropboxAppKey();
    if (!key) throw new Error('Dropbox is not configured');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: key,
      redirect_uri: dropboxRedirectUri(),
      code_verifier: verifier,
    });
    const res = await fetch(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error_description || errBody.error || `Dropbox token HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (!payload.access_token) throw new Error('Dropbox token response missing access_token');
    rememberDropboxTokens(payload);
    refreshDropboxAccountLabel().catch(() => {});
    return { ok: true, pending: pending || '' };
  }

  async function ensureDropboxToken({ interactive = true } = {}) {
    if (!isDropboxConfigured()) throw new Error('Dropbox is not configured');
    loadCachedDropboxToken();
    if (dropboxAccessToken && Date.now() < dropboxTokenExpiresAt) return dropboxAccessToken;
    const refreshed = await refreshDropboxAccessToken();
    if (refreshed) return refreshed;
    if (!interactive) return '';
    await beginDropboxOAuth({ pending: '' });
    return dropboxAccessToken || loadCachedDropboxToken() || '';
  }

  async function dropboxRpc(path, bodyObj, { content = false } = {}) {
    const token = await ensureDropboxToken({ interactive: true });
    if (!token) throw new Error('Dropbox sign-in required');
    const url = `${content ? DROPBOX_CONTENT : DROPBOX_API}${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj == null ? null : bodyObj),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error_summary || errBody.error || `Dropbox HTTP ${res.status}`);
    }
    return res.json();
  }

  async function uploadDropboxBackupBlob(blob, { filename } = {}) {
    const name = filename || backupFilename();
    const path = `/${name}`;
    const token = await ensureDropboxToken({ interactive: true });
    if (!token) throw new Error('Dropbox sign-in required');
    const arg = JSON.stringify({
      path,
      mode: 'overwrite',
      autorename: false,
      mute: true,
      strict_conflict: false,
    });
    const res = await fetch(`${DROPBOX_CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': arg,
      },
      body: blob,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error_summary || errBody.error || `Dropbox upload failed (${res.status})`);
    }
    const file = await res.json();
    writePrefs({
      lastDropboxBackupAt: file.server_modified || file.client_modified || new Date().toISOString(),
      lastDropboxFilePath: file.path_display || file.path_lower || path,
      lastDropboxFileId: file.id || '',
    });
    return file;
  }

  async function listDropboxBackups({ limit = 10 } = {}) {
    const data = await dropboxRpc('/files/list_folder', {
      path: '',
      recursive: false,
      include_deleted: false,
      limit: Math.max(1, Math.min(100, limit * 3)),
    });
    const entries = (data.entries || [])
      .filter((e) => e['.tag'] === 'file' && /\.dgbackup$/i.test(e.name || ''))
      .sort((a, b) => String(b.server_modified || '').localeCompare(String(a.server_modified || '')))
      .slice(0, Math.max(1, Math.min(50, limit)));
    return entries;
  }

  async function downloadDropboxBackup(path) {
    const token = await ensureDropboxToken({ interactive: true });
    if (!token) throw new Error('Dropbox sign-in required');
    const res = await fetch(`${DROPBOX_CONTENT}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });
    if (!res.ok) throw new Error(`Dropbox download failed (${res.status})`);
    return res.text();
  }

  async function disconnectDropbox() {
    loadCachedDropboxToken();
    const token = dropboxAccessToken || readPrefs().dropboxAccessToken || '';
    try {
      if (token) {
        await fetch(`${DROPBOX_API}/auth/token/revoke`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch (err) {
      /* still clear local */
    }
    clearDropboxTokensLocal();
  }

  function shouldAutoBackupDropboxDaily() {
    return !!readPrefs().autoDailyDropbox;
  }

  function setAutoDailyDropbox(on) {
    return writePrefs({ autoDailyDropbox: !!on });
  }

  function dueForDailyDropboxBackup(now = Date.now()) {
    if (!shouldAutoBackupDropboxDaily()) return false;
    const last = Date.parse(readPrefs().lastDropboxBackupAt || '') || 0;
    return !last || (now - last) > 20 * 60 * 60 * 1000;
  }

  return {
    PREFS_KEY,
    DRIVE_FOLDER,
    DROPBOX_SCOPES,
    backupFilename,
    backupBlobFromObject,
    canShareFiles,
    saveBackupFile,
    triggerDownload,
    isValidGoogleClientId,
    isValidDropboxAppKey,
    setAccountScope,
    setUserProviderKeys,
    userProviderKeys,
    serverGoogleClientId,
    serverDropboxAppKey,
    googleKeySource,
    dropboxKeySource,
    isGoogleConfigured,
    googleClientId,
    requestAccessToken,
    ensureAccessToken,
    uploadBackupBlob,
    listDriveBackups,
    downloadDriveBackup,
    disconnectGoogle,
    refreshGoogleAccountLabel,
    readPrefs,
    writePrefs,
    shouldAutoBackupDaily,
    setAutoDailyDrive,
    dueForDailyDriveBackup,
    isDropboxConfigured,
    dropboxAppKey,
    dropboxRedirectUri,
    beginDropboxOAuth,
    peekDropboxOAuthParams,
    consumeDropboxOAuthRedirect,
    ensureDropboxToken,
    uploadDropboxBackupBlob,
    listDropboxBackups,
    downloadDropboxBackup,
    disconnectDropbox,
    refreshDropboxAccountLabel,
    shouldAutoBackupDropboxDaily,
    setAutoDailyDropbox,
    dueForDailyDropboxBackup,
  };
})();

if (typeof window !== 'undefined') window.NotesCloudBackup = NotesCloudBackup;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NotesCloudBackup;
}
