(() => {
  const root = document.getElementById('app');
  if (!root) return;

  const skipLogin = root.dataset.skipLogin === '1';
  const IS_IOS = (window.NotesIosTune && NotesIosTune.IS_IOS)
    || /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_DESKTOP = !IS_IOS;
  function iosTune() {
    return window.NotesIosTune || null;
  }
  function scheduleIdleHeavyWork(fn) {
    const run = () => {
      try { fn(); } catch (err) { console.warn('idle work failed', err); }
    };
    if (IS_IOS && typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 4000 });
    } else {
      setTimeout(run, IS_IOS ? 1200 : 400);
    }
  }
  function runPostUnlockHeavyWork() {
    scheduleIdleHeavyWork(() => {
      if (!NotesStore.isUnlocked()) return;
      refreshAllNoteSearchIndexes();
      resumePendingOcr().catch(() => {});
      resumePendingListPreviews().catch(() => {});
      iosTune()?.warnStorageIfLow?.().then((low) => {
        if (low) toast('Storage almost full — delete old attachments or clear browser data', true);
      }).catch(() => {});
    });
  }
  function teardownForBackground() {
    shrinkPreviewCacheForBackground();
    if (!IS_IOS) return;
    clearListThumbCache();
    if (typeof NotesCrypto !== 'undefined' && typeof NotesCrypto.terminateWorker === 'function') {
      NotesCrypto.terminateWorker();
    }
  }
  function attachmentKind(att) {
    if (!att?.content) return 'other';
    return NotesPreview.kindFromMeta(att.content.mime, att.content.filename);
  }
  function iosDeferPdfPreview(att, { forList = false } = {}) {
    // Only skip PDF canvas work in the note list overview — that path OOM-killed Safari.
    // Inline previews when a note is open use the smaller iOS page budget instead.
    return IS_IOS && forList && attachmentKind(att) === 'pdf';
  }
  function paintIosPdfPlaceholder(stage, filename, { compact = false, state } = {}) {
    if (!stage) return;
    stage.classList.add('ios-pdf-deferred');
    const attId = stage.dataset.thumbId || stage.dataset.lazyThumb || '';
    const resolved = state || (attId ? iosPdfPlaceholderState(attId) : 'idle');
    stage.classList.toggle('ios-pdf-loading', resolved === 'loading');
    let label;
    if (compact) {
      if (resolved === 'loading') label = '…';
      else if (resolved === 'offline') label = 'Wi‑Fi';
      else label = 'PDF';
    } else {
      label = resolved === 'loading'
        ? 'Loading PDF preview…'
        : resolved === 'offline'
          ? 'PDF · connect to Wi‑Fi for thumbnail'
          : 'Tap Preview to open PDF';
    }
    if (stage.matches('button')) {
      stage.innerHTML = `<span class="ios-pdf-label">${escapeHtml(label)}</span>`;
      stage.removeAttribute('data-lazy-thumb');
      return;
    }
    stage.innerHTML = `<span class="ios-pdf-label${compact ? ' compact' : ''}">${escapeHtml(label)}</span>`;
    stage.removeAttribute('data-lazy-thumb');
  }

  function iosPdfPlaceholderState(attId) {
    if (listPreviewBackfill.has(attId)) return 'loading';
    if (!networkReachable) return 'offline';
    return 'idle';
  }

  function refreshIosPdfPlaceholders(attId) {
    const nodes = attId
      ? ui.noteList?.querySelectorAll(`.note-list-thumb.ios-pdf-deferred[data-thumb-id="${attId}"]`)
      : ui.noteList?.querySelectorAll('.note-list-thumb.ios-pdf-deferred[data-thumb-id]');
    (nodes || []).forEach((stage) => {
      const id = stage.dataset.thumbId;
      if (!id) return;
      const att = NotesStore.get(id);
      paintIosPdfPlaceholder(stage, att?.content?.filename, { compact: true });
    });
  }
  const ui = {
    shell: document.getElementById('notes-shell') || root,
    csrf: root.dataset.csrf,
    noteList: document.getElementById('note-list'),
    tagList: document.getElementById('tag-list'),
    search: document.getElementById('search'),
    filters: document.getElementById('filters'),
    editor: document.getElementById('editor'),
    empty: document.getElementById('empty-state'),
    title: document.getElementById('note-title'),
    body: document.getElementById('note-body'),
    preview: document.getElementById('preview'),
    saveStatus: document.getElementById('save-status'),
    tagBar: document.getElementById('tag-bar'),
    settings: document.getElementById('settings-panel'),
    settingsBackdrop: document.getElementById('settings-backdrop'),
    accountEmail: document.getElementById('account-email'),
    attachmentList: document.getElementById('attachment-list'),
    attachmentInput: document.getElementById('attachment-input'),
    docInline: document.getElementById('doc-inline'),
    docViewer: document.getElementById('doc-viewer'),
    docBackdrop: document.getElementById('doc-backdrop'),
    docStage: document.getElementById('doc-stage'),
    docTitle: document.getElementById('doc-title'),
    historyList: document.getElementById('history-list'),
    noteMeta: document.getElementById('note-meta'),
    editorType: document.getElementById('note-editor-type'),
    checklist: document.getElementById('checklist'),
  };

  const prefs = {
    theme: 'light',
    fontSize: 16,
    monospace: false,
    spellcheck: true,
    hidePreviews: false,
    compactList: false,
    sort: 'updated',
    autoPreview: false,
    autoLockMin: 0,
    lockOnUnfocus: '1min',
    rememberDevice: false,
    lightVault: false,
    aiChat: null,
    tagsCollapsed: true,
    viewsCollapsed: false,
    searchFilters: {
      titlesOnly: false,
      includeArchived: false,
      includeTrashed: false,
      includeProtected: false,
      tagIds: [],
    },
  };
  let savedPrefs = {};
  try {
    if (!localStorage.getItem('deeperguard-prefs') && localStorage.getItem('homelab-notes-prefs')) {
      localStorage.setItem('deeperguard-prefs', localStorage.getItem('homelab-notes-prefs'));
    }
    savedPrefs = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}') || {};
  } catch (e) {
    savedPrefs = {};
  }
  Object.assign(prefs, savedPrefs);
  if (window.NotesStore?.setLightVault) NotesStore.setLightVault(!!prefs.lightVault);
  prefs.lockOnUnfocus = (window.NotesVaultLock && NotesVaultLock.defaultLockOnUnfocus)
    ? NotesVaultLock.defaultLockOnUnfocus(savedPrefs)
    : (prefs.lockOnUnfocus === 'immediate' || prefs.lockOnUnfocus === '1min' ? prefs.lockOnUnfocus : '1min');
  if (!Object.prototype.hasOwnProperty.call(savedPrefs, 'lockOnUnfocus')) {
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore quota */ }
  }
  // One-time denser phone list chrome (collapse tags; more note rows visible).
  if (prefs.listChromeDense !== 2) {
    prefs.listChromeDense = 2;
    prefs.tagsCollapsed = true;
    try {
      localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
    } catch (e) {
      /* ignore quota */
    }
  }
  // One-time Standard Notes list chrome (light rows, previews, Modified dates).
  if (prefs.snListStyle !== 1) {
    prefs.snListStyle = 1;
    prefs.theme = 'light';
    try {
      localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
    } catch (e) {
      /* ignore quota */
    }
  }
  if (!prefs.searchFilters || typeof prefs.searchFilters !== 'object') {
    prefs.searchFilters = {
      titlesOnly: false,
      includeArchived: false,
      includeTrashed: false,
      includeProtected: false,
      tagIds: [],
    };
  } else {
    prefs.searchFilters = NotesSearch.defaultSearchOptions(prefs.searchFilters);
  }

  // Preferences that follow the account: stored as one encrypted vault item and
  // synced like notes, so "hide previews" on the phone also applies on the Mac.
  const GLOBAL_PREF_KEYS = [
    'theme', 'fontSize', 'monospace', 'spellcheck', 'hidePreviews', 'compactList',
    'sort', 'autoPreview', 'autoLockMin', 'lockOnUnfocus', 'aiChat',
  ];
  // Vault-only prefs never touch localStorage (they hold secrets such as API keys).
  const VAULT_ONLY_PREF_KEYS = ['aiChat'];
  // Device-only prefs (storage/offline behaviour differs per device).
  const DEVICE_PREF_KEYS = ['rememberDevice', 'lightVault', 'tagsCollapsed', 'viewsCollapsed', 'searchFilters'];
  let globalPrefsAppliedAt = 0;

  function localPrefsJson() {
    const copy = { ...prefs };
    VAULT_ONLY_PREF_KEYS.forEach((key) => delete copy[key]);
    return JSON.stringify(copy);
  }

  function pickGlobalPrefs(source) {
    const out = {};
    for (const key of GLOBAL_PREF_KEYS) {
      if (source && source[key] !== undefined) out[key] = source[key];
    }
    return out;
  }

  function pushGlobalPrefs() {
    if (!window.NotesStore?.isUnlocked?.() || typeof NotesStore.saveGlobalSettings !== 'function') return false;
    // A fresh device must see the account's settings once before it may overwrite them.
    if (!NotesStore.getGlobalSettings() && !unlockDidSync) return false;
    try {
      const saved = NotesStore.saveGlobalSettings(pickGlobalPrefs(prefs));
      if (saved) globalPrefsAppliedAt = Date.now() / 1000;
      return saved;
    } catch (err) {
      return false;
    }
  }

  function pullGlobalPrefs({ render = true } = {}) {
    if (typeof NotesStore?.getGlobalSettings !== 'function') return false;
    const remote = NotesStore.getGlobalSettings();
    if (!remote || !remote.prefs) return false;
    if (remote.updatedAt <= globalPrefsAppliedAt) return false;
    globalPrefsAppliedAt = remote.updatedAt;
    const incoming = pickGlobalPrefs(remote.prefs);
    const changed = Object.keys(incoming).some((key) => JSON.stringify(prefs[key]) !== JSON.stringify(incoming[key]));
    if (!changed) return false;
    Object.assign(prefs, incoming);
    if (!(prefs.lockOnUnfocus === 'immediate' || prefs.lockOnUnfocus === '1min' || prefs.lockOnUnfocus === 'never')) {
      prefs.lockOnUnfocus = '1min';
    }
    try { localStorage.setItem('deeperguard-prefs', localPrefsJson()); } catch (err) { /* ignore quota */ }
    applyPrefs();
    if (render) {
      renderNotes();
      if (!ui.settings?.hidden) initSettings().catch(() => {});
      if (currentId) applyEditorMode();
    }
    return true;
  }

  const NOTE_SORT_ORDER = ['updated', 'created', 'title'];

  function sortModeLabel(mode) {
    if (mode === 'created') return 'Sorted by date created';
    if (mode === 'title') return 'Sorted by title';
    return 'Sorted by last updated';
  }

  function syncSortControls() {
    const mode = NOTE_SORT_ORDER.includes(prefs.sort) ? prefs.sort : 'updated';
    if (prefs.sort !== mode) prefs.sort = mode;
    ['sort-select', 'sort-select-sidebar'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value !== mode) el.value = mode;
    });
    const cycleBtn = document.getElementById('btn-list-sort');
    if (cycleBtn) {
      cycleBtn.title = `Sort: ${sortModeLabel(mode).replace(/^Sorted by /, '')} (tap to change)`;
      cycleBtn.classList.toggle('is-custom-sorted', mode !== 'updated');
    }
  }

  function setNoteSort(mode, { toast: showToast = false } = {}) {
    const next = NOTE_SORT_ORDER.includes(mode) ? mode : 'updated';
    if (prefs.sort === next) {
      syncSortControls();
      return;
    }
    prefs.sort = next;
    savePrefs();
    if (showToast) toast(sortModeLabel(next));
  }

  function savePrefs() {
    try { localStorage.setItem('deeperguard-prefs', localPrefsJson()); } catch (err) { /* ignore quota */ }
    applyPrefs();
    renderNotes();
    pushGlobalPrefs();
  }

  function resolvedTheme() {
    if (prefs.theme === 'system') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return prefs.theme === 'light' ? 'light' : 'dark';
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.setAttribute('data-theme', theme);
    document.body.dataset.theme = theme;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', theme === 'light' ? '#ffffff' : '#0f1419');
  }

  function applyTagSection() {
    const section = document.getElementById('tag-section');
    if (!section) return;
    // Keep tags open while a tag filter is active; otherwise honor collapsed pref.
    if (currentTag) {
      section.open = true;
      return;
    }
    if (isDesktopLayout()) {
      section.open = true;
      return;
    }
    section.open = !prefs.tagsCollapsed;
  }

  function applyFilterSection() {
    const section = document.getElementById('filter-section');
    if (!section) return;
    if (!isDesktopLayout()) {
      section.open = true;
      return;
    }
    section.open = !prefs.viewsCollapsed;
  }

  function applyNoteTypographyVars() {
    const px = Number(prefs.fontSize) || 16;
    document.documentElement.style.setProperty('--note-body-size', `${px}px`);
    document.documentElement.style.setProperty('--note-title-size', `${px}px`);
  }

  function applyPrefs() {
    applyTheme();
    applyNoteTypographyVars();
    ui.body.style.fontSize = `${prefs.fontSize}px`;
    ui.body.classList.toggle('mono', !!prefs.monospace);
    document.getElementById('note-body-highlights')?.classList.toggle('mono', !!prefs.monospace);
    document.getElementById('note-body-wrap')?.classList.toggle('mono', !!prefs.monospace);
    ui.body.spellcheck = !!prefs.spellcheck;
    ui.noteList.classList.toggle('compact', !!prefs.compactList);
    ui.noteList.classList.toggle('hide-previews', !!prefs.hidePreviews);
    applyTagSection();
    applyFilterSection();
    bumpIdle();
  }
  applyTheme();
  if (window.matchMedia) {
    const scheme = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => {
      if (prefs.theme === 'system') applyTheme();
    };
    if (scheme.addEventListener) scheme.addEventListener('change', onScheme);
    else if (scheme.addListener) scheme.addListener(onScheme);
  }

  const appVersion = document.getElementById('app-version');
  const notesBuild = document.querySelector('meta[name="notes-build"]')?.content || '';
  if (appVersion && notesBuild) appVersion.textContent = `v${notesBuild}`;

  function cachedAccountPlan() {
    try {
      return NotesStore.cachedAccount() || {};
    } catch (err) {
      return {};
    }
  }

  function planHas(feature, account = cachedAccountPlan()) {
    const feats = account.plan_features;
    if (feats && Object.prototype.hasOwnProperty.call(feats, feature)) return !!feats[feature];
    return String(account.plan || 'pro').toLowerCase() === 'pro';
  }

  function formatPlanBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function updatePlanBadge(badge, account) {
    if (!badge) return;
    const plan = String(account?.plan || 'pro').toLowerCase();
    const label = account?.plan_label || (plan === 'pro' ? 'Pro' : 'Basic');
    badge.textContent = label;
    badge.hidden = false;
    badge.classList.toggle('plan-badge-pro', plan === 'pro');
    badge.classList.toggle('plan-badge-basic', plan !== 'pro');
    const pricing = account?.plan_pricing || {};
    const priceHint = pricing.billing_active && pricing.price_eur_month > 0
      ? `€${pricing.price_eur_month.toFixed(2)}/month`
      : (pricing.billing_note || 'Free during public beta');
    badge.title = `${label} plan · ${priceHint}`;
  }

  function renderPlanSettings(account) {
    updatePlanBadge(document.getElementById('list-plan-badge'), account);
    const badge = document.getElementById('account-plan-badge');
    const price = document.getElementById('account-plan-price');
    const tagline = document.getElementById('account-plan-tagline');
    const storage = document.getElementById('account-plan-storage');
    const compareBody = document.getElementById('plan-compare-body');
    const pricingNote = document.getElementById('plan-pricing-note');
    if (!badge || !price) {
      applyPlanGates(account);
      return;
    }
    const plan = String(account.plan || 'pro').toLowerCase();
    const label = account.plan_label || (plan === 'pro' ? 'Pro' : 'Basic');
    updatePlanBadge(badge, account);
    const pricing = account.plan_pricing || {};
    if (pricing.billing_active) {
      price.textContent = pricing.price_eur_month > 0
        ? `€${pricing.price_eur_month.toFixed(2)}/month`
        : 'Included';
    } else {
      price.textContent = pricing.billing_note || 'Free during public beta';
    }
    if (tagline) tagline.textContent = account.plan_tagline || '';
    if (storage) {
      const used = Number(account.storage_used_bytes) || 0;
      const quota = account.storage_quota_effective;
      const quotaText = quota ? formatPlanBytes(quota) : 'Unlimited';
      storage.textContent = `Encrypted storage: ${formatPlanBytes(used)} used of ${quotaText}`;
    }
    if (compareBody && account.plan_catalog) {
      const rows = [];
      Object.entries(account.plan_catalog).forEach(([key, meta]) => {
        const suggested = meta.suggested_price_eur_month;
        rows.push(`<div class="plan-compare-card${key === plan ? ' is-current' : ''}">
          <h4>${escapeHtml(meta.label)}</h4>
          <p class="plan-compare-price"><span class="plan-compare-free">€0 now</span> · suggested €${suggested.toFixed(2)}/mo</p>
          <p class="muted">${escapeHtml(String(meta.storage_quota_mb))} MB storage</p>
          <ul>${(meta.features || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
        </div>`);
      });
      compareBody.innerHTML = rows.join('');
    }
    if (pricingNote && account.plan_catalog) {
      const basic = account.plan_catalog.basic;
      const pro = account.plan_catalog.pro;
      if (basic && pro) {
        pricingNote.textContent = `Suggested pricing when billing launches: Basic €${basic.suggested_price_eur_month.toFixed(2)}/month (€${basic.suggested_price_eur_year.toFixed(0)}/year), Pro €${pro.suggested_price_eur_month.toFixed(2)}/month (€${pro.suggested_price_eur_year.toFixed(0)}/year). Both plans are free during the public beta.`;
      }
    }
    applyPlanGates(account);
  }

  function renderPlanUi(account) {
    if (!account || typeof account !== 'object') return;
    renderPlanSettings(account);
    const adminBtn = document.getElementById('btn-open-admin');
    if (adminBtn) adminBtn.hidden = !account.is_admin;
  }

  function heroGuideDismissed() {
    try {
      return localStorage.getItem('notes_hero_guide_dismissed') === '1';
    } catch (err) {
      return false;
    }
  }

  function closeHeroGuide() {
    const backdrop = document.getElementById('hero-guide-backdrop');
    const dialog = document.getElementById('hero-guide-dialog');
    if (backdrop) backdrop.hidden = true;
    if (dialog) dialog.hidden = true;
    try {
      localStorage.setItem('notes_hero_guide_dismissed', '1');
    } catch (err) {
      /* ignore */
    }
  }

  function showHeroGuide() {
    const backdrop = document.getElementById('hero-guide-backdrop');
    const dialog = document.getElementById('hero-guide-dialog');
    if (!backdrop || !dialog || heroGuideDismissed()) return;
    backdrop.hidden = false;
    dialog.hidden = false;
    document.getElementById('hero-guide-close')?.focus();
  }

  function showHeroGuideIfNeeded() {
    if (!vaultReady || heroGuideDismissed()) return;
    setTimeout(() => showHeroGuide(), 400);
  }

  async function offerDocumentSearch(text) {
    // Disabled: this popup window should not show after upload and indexing.
    return;
  }

  function noteIndexingBadge(noteId) {
    const atts = NotesStore.listAttachments(noteId);
    if (!atts.length) return '';
    const pending = atts.some((att) => attachmentOcrBusy(att));
    if (!pending) return '';
    return '<span class="note-indexing"><span class="note-indexing-spinner" aria-hidden="true"></span>Indexing…</span>';
  }

  function applyPlanGates(account) {
    document.querySelectorAll('[data-plan-feature]').forEach((el) => {
      const feature = el.dataset.planFeature;
      const allowed = planHas(feature, account);
      el.classList.toggle('plan-locked', !allowed);
      let lock = el.querySelector('.plan-pro-lock');
      if (!allowed) {
        if (!lock) {
          lock = document.createElement('p');
          lock.className = 'settings-hint plan-pro-lock';
          lock.textContent = 'Included with Pro. You are on Basic — contact support to upgrade when billing launches.';
          el.prepend(lock);
        }
        el.querySelectorAll('input, button, select, textarea').forEach((input) => {
          if (input.id === 'btn-disable-totp' && account.totp_enabled) return;
          input.disabled = true;
        });
      } else if (lock) {
        lock.remove();
        el.querySelectorAll('input, button, select, textarea').forEach((input) => {
          input.disabled = false;
        });
      }
    });
    const tab2fa = document.getElementById('app-tab-2fa');
    const locked = !planHas('vault_authenticator', account);
    if (tab2fa) tab2fa.classList.toggle('plan-locked-tab', locked);
  }

  const TAG_COLORS = ['#4f8cff', '#7c5cff', '#2ec4b6', '#ff9f1c', '#e71d36', '#8b98a5', '#f4d35e', '#ee964b'];

  let currentId = null;
  let listSelectionId = null;
  let currentFilter = 'all';
  let filterBeforeFiles = 'all';
  let currentTag = null;
  let previewOn = true;
  let editorMode = 'preview';
  const ocrQueue = [];
  const ocrQueued = new Set();
  const ocrInFlight = new Map();
  const ocrDeferred = new Map();
  const ocrWaitingServer = new Set();
  const serverOcrKnown = new Set();
  const serverOcrInFlight = new Map();
  let ocrBusy = false;
  let ocrUiTimer = null;
  let ocrProgressToastAt = 0;
  let ocrDeferToastAt = 0;
  let ocrRetryTimer = null;
  let saveDebounce = null;
  let toastTimer = null;
  let tagPressTimer = null;
  let idleTimer = null;
  let unfocusTimer = null;
  let unfocusLocking = false;
  let unfocusClearTimer = null;
  // Max time "Lock vault" waits for the pending push before locking anyway.
  const LOCK_FLUSH_WAIT_MS = 2500;
  // Lightweight "anything new on the server?" poll while the app is open.
  const CHANGE_POLL_MS = 25000;
  const BACKGROUND_CHANGE_POLL_MS = 45000;
  // Do not auto-lock for unfocus while a download/push is still running.
  const UNFOCUS_LOCK_SYNC_WAIT_MS = 3 * 60 * 1000;
  let changePollTimer = null;
  let changePollBackground = false;
  let unfocusLockDeadline = 0;
  let notesPickerDepth = 0;
  let findMatches = [];
  let findIndex = 0;
  let findCaseSensitive = false;
  let vaultNeedsReload = false;
  let ingestBusy = false;
  const unlockedNotes = new Set();

  let ocrUiWatchTimer = 0;

  function ocrActiveNoteIds() {
    const ids = new Set();
    const track = (attId) => {
      const noteId = NotesStore.get(attId)?.content?.note_id;
      if (noteId) ids.add(noteId);
    };
    ocrQueued.forEach(track);
    ocrInFlight.forEach((_, attId) => track(attId));
    ocrWaitingServer.forEach(track);
    return [...ids];
  }

  function attachmentOcrBusy(att) {
    const attId = att?.uuid;
    if (!attId) return false;
    if (ocrWaitingServer.has(attId) || ocrInFlight.has(attId) || ocrQueued.has(attId)) return true;
    return !att.content?.ocr_method;
  }

  function attachmentOcrSpinnerHtml() {
    return '<span class="attachment-ocr-spinner" role="status" aria-label="Reading text"><span class="attachment-ocr-spinner-icon" aria-hidden="true"></span></span>';
  }

  function startOcrUiWatch() {
    if (ocrUiWatchTimer) return;
    const tick = () => {
      const active = ocrQueued.size + ocrInFlight.size + ocrWaitingServer.size;
      if (!active) {
        ocrUiWatchTimer = 0;
        lastNotesRenderKey = '';
        scheduleOcrUiRefresh();
        return;
      }
      lastNotesRenderKey = '';
      scheduleOcrUiRefresh(ocrActiveNoteIds());
      ocrUiWatchTimer = window.setTimeout(tick, 700);
    };
    tick();
  }

  function scheduleOcrUiRefresh(noteIds = null) {
    clearTimeout(ocrUiTimer);
    ocrUiTimer = setTimeout(() => {
      ocrUiTimer = null;
      const targets = noteIds?.length ? noteIds : ocrActiveNoteIds();
      const listUpdated = targets.length ? updateNoteRows(targets) : false;
      if (!listUpdated) renderNotes();
      const attachmentNoteId = currentId;
      if (attachmentNoteId && (!targets.length || targets.includes(attachmentNoteId))) {
        invalidateInlinePreview();
        renderAttachments(attachmentNoteId);
        if (currentSearchQuery() || editorMode === 'ocr') applyEditorMode();
        updateNoteMeta(NotesStore.get(attachmentNoteId));
      }
      refreshSettingsDiagnostics().catch(() => {});
    }, 150);
  }

  function updateNoteRows(noteIds) {
    const query = ui.search.value.trim();
    const scrollTop = ui.noteList?.scrollTop || 0;
    let updated = 0;
    for (const noteId of noteIds) {
      const note = NotesStore.get(noteId);
      if (!note || note.deleted) continue;
      const row = ui.noteList.querySelector(`.note-row[data-id="${CSS.escape(noteId)}"]`);
      if (!row) continue;
      const html = renderNoteRow(note, query);
      const wrap = document.createElement('div');
      wrap.innerHTML = html.trim();
      const next = wrap.firstElementChild;
      if (!next) continue;
      row.replaceWith(next);
      updated += 1;
      next.querySelectorAll('.note-list-thumb[data-thumb-id]').forEach((el) => {
        observeThumb(el.dataset.noteId, el.dataset.thumbId, el, { forList: true });
      });
    }
    if (updated) {
      markActiveNoteRow();
      if (ui.noteList) ui.noteList.scrollTop = scrollTop;
    }
    return updated > 0;
  }

  function parseTimestampMs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1000;
    }
    const text = String(value).trim();
    if (!text) return 0;
    // Pure numeric strings are unix seconds/ms — not Date.parse's quirky paths.
    if (/^\d+(\.\d+)?$/.test(text)) {
      const num = Number(text);
      if (!Number.isFinite(num) || num <= 0) return 0;
      return num > 1e12 ? num : num * 1000;
    }
    const at = Date.parse(text);
    return Number.isFinite(at) && at > 0 ? at : 0;
  }

  /** Last user-visible edit time for a note (ms). Prefers content.updated_at. */
  function noteEditedAtMs(note) {
    if (!note) return 0;
    if (typeof NotesSearch?.updatedStamp === 'function') return NotesSearch.updatedStamp(note);
    return Math.max(
      parseTimestampMs(note.content?.updated_at),
      parseTimestampMs(note.content?.created_at),
      parseTimestampMs(note.updated_at),
    );
  }

  function noteCreatedAtMs(note) {
    if (!note) return 0;
    if (typeof NotesSearch?.createdStamp === 'function') return NotesSearch.createdStamp(note);
    return parseTimestampMs(note.content?.created_at) || noteEditedAtMs(note);
  }

  function noteListSectionMs(note, sort) {
    return sort === 'created' ? noteCreatedAtMs(note) : noteEditedAtMs(note);
  }

  function relativeTime(isoOrMs) {
    const at = typeof isoOrMs === 'number' ? isoOrMs : parseTimestampMs(isoOrMs);
    if (!Number.isFinite(at) || at <= 0) return '';
    const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 45) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
    return new Date(at).toLocaleDateString();
  }

  function formatModified(isoOrMs) {
    const at = typeof isoOrMs === 'number' ? isoOrMs : parseTimestampMs(isoOrMs);
    if (!Number.isFinite(at) || at <= 0) return '';
    const formatted = new Date(at).toLocaleString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `Modified ${formatted}`;
  }

  function formatDateTime(isoOrMs) {
    const at = typeof isoOrMs === 'number' ? isoOrMs : parseTimestampMs(isoOrMs);
    if (!Number.isFinite(at) || at <= 0) return '—';
    return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  const NOTE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function toDatetimeLocalValue(isoOrMs) {
    const at = typeof isoOrMs === 'number' ? isoOrMs : parseTimestampMs(isoOrMs);
    if (!Number.isFinite(at) || at <= 0) return '';
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function warnAtFromInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }

  function noteIdFromUrl() {
    try {
      const id = new URLSearchParams(location.search).get('note') || '';
      return NOTE_UUID_RE.test(id) ? id : '';
    } catch (err) {
      return '';
    }
  }

  const DEEP_LINK_KEY = 'notes_deeplink_id';

  function consumeNoteDeepLink() {
    const id = noteIdFromUrl();
    if (!id) return '';
    try {
      const url = new URL(location.href);
      url.searchParams.delete('note');
      const next = `${url.pathname}${url.search}${url.hash}`;
      history.replaceState({}, '', next);
    } catch (err) {
      /* keep the query string */
    }
    try { sessionStorage.setItem(DEEP_LINK_KEY, id); } catch (err) { /* ignore */ }
    return id;
  }

  function pendingDeepLinkId() {
    try {
      const id = sessionStorage.getItem(DEEP_LINK_KEY) || '';
      return NOTE_UUID_RE.test(id) ? id : '';
    } catch (err) {
      return '';
    }
  }

  function clearPendingDeepLink() {
    try { sessionStorage.removeItem(DEEP_LINK_KEY); } catch (err) { /* ignore */ }
  }

  // "/app" is a public, cacheable PWA shell, so the login bounce happens here in
  // the client. Carry the email deep link along so the login page can return
  // to /app?note=<uuid> afterwards.
  function loginUrlWithDeepLink() {
    const id = noteIdFromUrl() || pendingDeepLinkId();
    return id ? `/login?note=${encodeURIComponent(id)}` : '/login';
  }

  /**
   * Open the note from an email link once the vault has it. Called after
   * hydrate, after unlock reload, and after each sync so a locked vault or a
   * note not yet downloaded still ends up open. `final` reports "not found"
   * when the server has been consulted and the note still is not there.
   */
  function openPendingDeepLink({ final = false } = {}) {
    const id = pendingDeepLinkId();
    if (!id) return false;
    if (!NotesStore.isUnlocked?.()) return false;
    const note = NotesStore.get(id);
    if (note && !note.deleted && note.content?.type === 'note') {
      clearPendingDeepLink();
      rememberOpen(id);
      openNote(id);
      return true;
    }
    if (final) {
      clearPendingDeepLink();
      toast('That note is no longer in your vault', true);
    }
    return false;
  }

  function openRememberedNote() {
    if (openPendingDeepLink()) return true;
    try {
      const reopenId = sessionStorage.getItem('notes_open_id');
      if (reopenId && NotesStore.get(reopenId)) {
        openNote(reopenId);
        return true;
      }
    } catch (err) {
      /* stay on the list */
    }
    return false;
  }

  const EDITOR_LABELS = {
    plain: 'Plain text',
    markdown: 'Markdown',
    superscript: 'Superscript',
    code: 'Code',
    checklist: 'Checklist',
    super: 'Super checklist',
  };

  function isRichTextEditor(type) {
    return type === 'markdown' || type === 'superscript';
  }

  function noteUsesRenderedBody(type) {
    return type === 'plain' || type === 'markdown' || type === 'superscript';
  }

  function renderNoteBodyPreview(text, editor) {
    if (window.NotesSuperscript && (editor === 'superscript' || editor === 'markdown' || editor === 'plain')) {
      return NotesSuperscript.render(text);
    }
    return NotesMarkdown.render(text);
  }

  function openExternalLink(href) {
    const url = String(href || '').trim();
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return false;
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) return true;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  function bindPreviewExternalLinks() {
    if (!ui.preview || ui.preview._externalLinksBound) return;
    ui.preview._externalLinksBound = true;
    ui.preview.addEventListener('click', (event) => {
      const link = event.target?.closest?.('a[href]');
      if (link && ui.preview.contains(link)) {
        const href = link.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
          event.preventDefault();
          event.stopPropagation();
          openExternalLink(href);
        }
        return;
      }
      if (noteEditingLocked()) {
        event.preventDefault();
        return;
      }
      if (!ui.preview.hidden && !noteHasDocs(currentId)) {
        editorMode = 'edit';
        applyEditorMode();
        ui.body?.focus();
      }
    });
  }

  const noteUndoStacks = new Map();
  const noteRedoStacks = new Map();
  const NOTE_UNDO_MAX = 120;

  function captureEditorSnapshot() {
    const body = ui.body || {};
    return {
      title: ui.title?.value ?? '',
      body: body.value ?? '',
      selStart: typeof body.selectionStart === 'number' ? body.selectionStart : 0,
      selEnd: typeof body.selectionEnd === 'number' ? body.selectionEnd : 0,
    };
  }

  function snapshotsEqual(a, b) {
    return a && b && a.title === b.title && a.body === b.body;
  }

  function resetNoteUndoStack(noteId) {
    if (!noteId) return;
    noteUndoStacks.set(noteId, []);
    noteRedoStacks.set(noteId, []);
    syncUndoButtons();
  }

  function pushUndoSnapshot() {
    if (!currentId || noteEditingLocked()) return;
    const snap = captureEditorSnapshot();
    let stack = noteUndoStacks.get(currentId);
    if (!stack) {
      stack = [];
      noteUndoStacks.set(currentId, stack);
    }
    const last = stack[stack.length - 1];
    if (last && snapshotsEqual(last, snap)) return;
    stack.push(snap);
    if (stack.length > NOTE_UNDO_MAX) stack.shift();
    noteRedoStacks.set(currentId, []);
    syncUndoButtons();
  }

  function applyEditorSnapshot(snap) {
    if (!snap) return;
    if (ui.title) ui.title.value = snap.title;
    if (ui.body) ui.body.value = snap.body;
    scheduleSave();
    const note = currentId ? NotesStore.get(currentId) : null;
    const type = note?.content?.editor || ui.editorType?.value || 'plain';
    syncEditLinkOverlay();
    if (isChecklistEditor(type)) {
      renderChecklist(note ? { ...note, content: { ...note.content, content: snap.body } } : { content: { content: snap.body, editor: type } });
    }
    if (ui.body && typeof ui.body.setSelectionRange === 'function') {
      try {
        const len = ui.body.value.length;
        const start = Math.max(0, Math.min(snap.selStart, len));
        const end = Math.max(start, Math.min(snap.selEnd, len));
        ui.body.setSelectionRange(start, end);
      } catch (err) {
        /* ignore */
      }
    }
    syncUndoButtons();
  }

  function undoEdit() {
    if (!currentId || noteEditingLocked()) return;
    const stack = noteUndoStacks.get(currentId) || [];
    if (!stack.length) return;
    const prev = stack.pop();
    noteUndoStacks.set(currentId, stack);
    const redo = noteRedoStacks.get(currentId) || [];
    redo.push(captureEditorSnapshot());
    noteRedoStacks.set(currentId, redo);
    applyEditorSnapshot(prev);
  }

  function redoEdit() {
    if (!currentId || noteEditingLocked()) return;
    const redo = noteRedoStacks.get(currentId) || [];
    if (!redo.length) return;
    const next = redo.pop();
    noteRedoStacks.set(currentId, redo);
    const stack = noteUndoStacks.get(currentId) || [];
    stack.push(captureEditorSnapshot());
    noteUndoStacks.set(currentId, stack);
    applyEditorSnapshot(next);
  }

  function syncUndoButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    const stack = currentId ? (noteUndoStacks.get(currentId) || []) : [];
    const redo = currentId ? (noteRedoStacks.get(currentId) || []) : [];
    const locked = noteEditingLocked();
    if (undoBtn) undoBtn.disabled = locked || !stack.length;
    if (redoBtn) redoBtn.disabled = locked || !redo.length;
  }

  function handleEditorUndoShortcut(event) {
    if (noteEditingLocked()) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undoEdit();
      return;
    }
    if (key === 'z' && event.shiftKey) {
      event.preventDefault();
      redoEdit();
      return;
    }
    if (key === 'y') {
      event.preventDefault();
      redoEdit();
    }
  }

  function editLinkOverlayActive() {
    if (!ui.body || ui.body.hidden || noteEditingLocked()) return false;
    return editorMode === 'edit';
  }

  function syncEditLinkScroll() {
    const layer = document.getElementById('note-body-links');
    if (!layer || !ui.body) return;
    layer.scrollTop = ui.body.scrollTop;
    layer.scrollLeft = ui.body.scrollLeft;
  }

  function syncChecklistLinkOverlays(root) {
    if (!root || !window.NotesLinkOverlay?.renderHtml) return;
    root.querySelectorAll('.check-text-wrap').forEach((wrap) => {
      const input = wrap.querySelector('.check-text');
      const layer = wrap.querySelector('.check-text-links');
      if (!input || !layer) return;
      layer.innerHTML = NotesLinkOverlay.renderHtml(input.value);
    });
  }

  function syncEditLinkOverlay() {
    const wrap = document.getElementById('note-body-wrap');
    const layer = document.getElementById('note-body-links');
    const note = currentId ? NotesStore.get(currentId) : null;
    const type = note?.content?.editor || ui.editorType?.value || 'plain';
    const checklistOn = isChecklistEditor(type);
    if (checklistOn && ui.checklist) syncChecklistLinkOverlays(ui.checklist);
    if (!wrap || !layer || !ui.body) return;
    const active = editLinkOverlayActive() && !checklistOn && window.NotesLinkOverlay?.renderHtml;
    wrap.classList.toggle('edit-links-active', active);
    if (!active) {
      layer.innerHTML = '';
      return;
    }
    layer.innerHTML = NotesLinkOverlay.renderHtml(ui.body.value);
    syncEditLinkScroll();
  }

  function bindEditLinkOverlays() {
    if (document.body._editLinksBound) return;
    document.body._editLinksBound = true;
    document.body.addEventListener('click', (event) => {
      const anchor = event.target?.closest?.('a.edit-link[href]');
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      openExternalLink(anchor.getAttribute('href') || '');
    });
  }

  function togglePreviewTaskAt(text, editor, index) {
    if (editor === 'superscript' && window.NotesSuperscript) return NotesSuperscript.toggleTaskAt(text, index);
    return NotesMarkdown.toggleTaskAt(text, index);
  }

  let devicePasswordCache = '';

  async function refreshDevicePasswordCache() {
    if (!prefs.rememberDevice) {
      devicePasswordCache = '';
      return '';
    }
    if (typeof NotesVaultSecrets !== 'undefined') {
      devicePasswordCache = await NotesVaultSecrets.loadDevicePassword();
    }
    return devicePasswordCache;
  }

  function savedDevicePassword() {
    return devicePasswordCache || '';
  }

  async function persistDevicePassword(password) {
    devicePasswordCache = String(password || '');
    if (typeof NotesVaultSecrets !== 'undefined') {
      await NotesVaultSecrets.saveDevicePassword(password);
      return;
    }
    try {
      if (!prefs.rememberDevice || !password) {
        localStorage.removeItem('notes_device_password');
        return;
      }
      localStorage.setItem('notes_device_password', password);
    } catch (e) {
      /* ignore quota */
    }
  }

  function savedUnlockPassword() {
    const vault = (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getVaultPassword()) || '';
    if (skipLogin) {
      return vault
        || localStorage.getItem('notes_test_password')
        || savedDevicePassword()
        || '';
    }
    return vault || savedDevicePassword() || '';
  }

  function markOfflineUnlockVerified() {
    try {
      localStorage.setItem('notes_offline_unlock_verified', String(Date.now()));
      localStorage.setItem('notes_pending_device_report', '1');
    } catch (err) {
      /* ignore quota */
    }
    updateOfflineSetupBanner();
  }

  function pendingDeviceReportUpload() {
    try {
      return localStorage.getItem('notes_pending_device_report') === '1';
    } catch (err) {
      return false;
    }
  }

  function clearPendingDeviceReportUpload() {
    try {
      localStorage.removeItem('notes_pending_device_report');
    } catch (err) {
      /* ignore quota */
    }
  }

  async function uploadPendingDeviceReport({ quiet = false } = {}) {
    if (!pendingDeviceReportUpload() || !NotesStore.isUnlocked()) return false;
    const text = await buildDiagnosticsText().catch(() => '');
    const uploaded = await uploadDeviceReport(text);
    if (uploaded) {
      clearPendingDeviceReportUpload();
      refreshSettingsDiagnostics().catch(() => {});
      if (!quiet) toast('Checklist sent to server');
    }
    return uploaded;
  }

  function offlineUnlockVerified() {
    try {
      return !!localStorage.getItem('notes_offline_unlock_verified');
    } catch (err) {
      return false;
    }
  }

  function markPwaStandaloneVerified() {
    try {
      localStorage.setItem('notes_pwa_standalone_verified', String(Date.now()));
    } catch (err) {
      /* ignore quota */
    }
  }

  function pwaStandaloneVerified() {
    try {
      return !!localStorage.getItem('notes_pwa_standalone_verified');
    } catch (err) {
      return false;
    }
  }

  function pinchZoomVerified() {
    try {
      return !!localStorage.getItem('notes_pinch_verified');
    } catch (err) {
      return false;
    }
  }

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches
      || (typeof navigator !== 'undefined' && navigator.standalone === true);
  }

  function offlineSetupNeeded() {
    if (prefs.rememberDevice || offlineUnlockVerified()) return false;
    if (!isStandalonePwa() && !pwaStandaloneVerified()) return false;
    try {
      return localStorage.getItem('notes_offline_setup_dismissed') !== '1';
    } catch (err) {
      return true;
    }
  }

  function updateOfflineSetupBanner() {
    const el = document.getElementById('offline-setup-banner');
    if (!el) return;
    el.hidden = !offlineSetupNeeded() || !vaultReady;
    el.classList.toggle('ios-remember-callout', IS_IOS && isStandalonePwa());
  }

  function updateNetworkStatusBanner() {
    const el = document.getElementById('network-status-banner');
    const text = document.getElementById('network-status-text');
    if (!el || !text) return;
    if (!vaultReady || document.body.classList.contains('locked')) {
      el.hidden = true;
      return;
    }
    if (networkReachable) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    text.innerHTML = `<strong>Offline</strong> — ${escapeHtml(OFFLINE_LAN_HINT)}`;
  }

  function updateUnlockUpdateHint({ stale, locked, serverBuild, build, dismissed }) {
    const hint = document.getElementById('unlock-update-hint');
    if (!hint) return;
    const show = !!(stale && locked && serverBuild && build && dismissed !== serverBuild);
    if (!show) {
      hint.hidden = true;
      return;
    }
    hint.innerHTML = `<strong>Update available</strong> — you're on <strong>v${escapeHtml(build)}</strong>, server has <strong>v${escapeHtml(serverBuild)}</strong>. After unlock, use the banner at the top or Settings → Refresh app cache.`;
    hint.hidden = false;
  }

  function updateAppUpdateBanner(serverBuild) {
    const el = document.getElementById('app-update-banner');
    const side = document.getElementById('sidebar-update');
    const build = document.querySelector('meta[name="notes-build"]')?.content || notesBuild || '';
    const stale = !!(serverBuild && build && serverBuild !== build);
    let dismissed = '';
    try {
      dismissed = sessionStorage.getItem('notes_update_dismissed_build') || '';
    } catch (err) {
      dismissed = '';
    }
    const VL = window.NotesVaultLock;
    const locked = VL?.vaultIsLocked ? VL.vaultIsLocked(document.body) : document.body.classList.contains('locked');
    const ui = VL?.lockedUpdateUi
      ? VL.lockedUpdateUi({ locked, stale, dismissed, serverBuild })
      : { persistPending: stale && !!serverBuild, revealBanner: stale && !locked && dismissed !== serverBuild, markStale: stale && !locked };
    if (ui.persistPending) {
      try {
        sessionStorage.setItem('notes_pending_update_build', String(serverBuild));
      } catch (err) {
        /* ignore */
      }
    }
    updateAppVersionBadge(ui.markStale ? serverBuild : '');
    document.body.classList.toggle('update-available', !!ui.markStale);
    updateUnlockUpdateHint({ stale, locked, serverBuild, build, dismissed });
    // Top banner only — sidebar strip stays hidden (no double notification).
    if (side) side.hidden = true;
    if (ui.revealBanner && el) {
      const label = document.getElementById('app-update-banner-text');
      if (label) {
        label.innerHTML = `<strong>Update available</strong> — you're on <strong>v${escapeHtml(build)}</strong>, server has <strong>v${escapeHtml(serverBuild)}</strong>. Tap Update now on Wi‑Fi.`;
      }
      el.hidden = false;
      return;
    }
    if (el) el.hidden = true;
  }

  function showAppUpdateModal() {
    /* removed — banner only */
  }

  function maybePromptAppUpdate() {
    /* removed — banner only */
  }

  function flushPendingUpdatePrompt() {
    fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.build) {
          applyServerBuildStatus(String(data.build));
          return;
        }
        let pending = '';
        try {
          pending = sessionStorage.getItem('notes_pending_update_build') || '';
        } catch (err) {
          pending = '';
        }
        if (pending) applyServerBuildStatus(pending);
      })
      .catch(() => {
        let pending = '';
        try {
          pending = sessionStorage.getItem('notes_pending_update_build') || '';
        } catch (err) {
          pending = '';
        }
        if (pending) applyServerBuildStatus(pending);
      });
  }

  function updateAppVersionBadge(serverBuild) {
    const el = document.getElementById('app-version');
    if (!el) return;
    const VL = window.NotesVaultLock;
    if (VL?.vaultIsLocked?.(document.body)) {
      el.classList.remove('stale');
      el.removeAttribute('title');
      return;
    }
    const build = document.querySelector('meta[name="notes-build"]')?.content || notesBuild || '';
    const stale = serverBuild && build && serverBuild !== build;
    el.classList.toggle('stale', !!stale);
    if (stale) {
      el.textContent = `v${build} → v${serverBuild}`;
      el.title = 'Update available — use the banner above or Settings → Refresh app cache';
    } else {
      el.textContent = build ? `v${build}` : el.textContent;
      el.removeAttribute('title');
    }
  }

  function applyServerBuildStatus(serverBuild) {
    const build = serverBuild ? String(serverBuild) : '';
    updateAppUpdateBanner(build);
    if (build && typeof preseedLatestShell === 'function') {
      preseedLatestShell(build).catch(() => {});
    }
    return build;
  }

  function openOfflineSecuritySettings() {
    openSettings();
    initSettings().catch(() => {});
    const row = document.getElementById('pref-remember-device')?.closest('.settings-row');
    if (row) {
      row.classList.add('settings-highlight');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => row.classList.remove('settings-highlight'), 4000);
    }
  }

  function enableRememberDevice({ auto = false } = {}) {
    prefs.rememberDevice = true;
    persistDevicePassword((typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getVaultPassword()) || '');
    savePrefs();
    const rememberDevice = document.getElementById('pref-remember-device');
    if (rememberDevice) rememberDevice.checked = true;
    refreshSettingsDiagnostics().catch(() => {});
    updateOfflineSetupBanner();
    try {
      localStorage.removeItem('notes_remember_device_declined');
    } catch (err) {
      /* ignore quota */
    }
    toast(auto
      ? 'Remember password enabled — you can unlock offline on this device (vault still locks on restart)'
      : 'Password remembered — unlock still required each time you open Notes');
    try {
      localStorage.setItem('notes_pending_device_report', '1');
    } catch (err) {
      /* ignore quota */
    }
    uploadPendingDeviceReport({ quiet: true }).catch(() => {});
  }

  function rememberDeviceDeclined() {
    try {
      return localStorage.getItem('notes_remember_device_declined') === '1';
    } catch (err) {
      return false;
    }
  }

  function maybeAutoEnableRememberDevice() {
    if (!vaultReady || prefs.rememberDevice || rememberDeviceDeclined()) return;
    if (!isStandalonePwa() && !pwaStandaloneVerified()) return;
    enableRememberDevice({ auto: true });
  }

  function offlineSetupModalNeeded() {
    if (prefs.rememberDevice || offlineUnlockVerified()) return false;
    if (!isStandalonePwa() && !pwaStandaloneVerified()) return false;
    try {
      return localStorage.getItem('notes_offline_setup_modal_dismissed') !== '1';
    } catch (err) {
      return true;
    }
  }

  async function maybePromptOfflineSetup() {
    if (!vaultReady || !offlineSetupModalNeeded()) return;
    // Desktop browsers: skip the blocking dialog — banner in Settings is enough.
    const coarse = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
    if (!isStandalonePwa() && !coarse) {
      try {
        localStorage.setItem('notes_offline_setup_modal_dismissed', '1');
      } catch (err) {
        /* ignore */
      }
      return;
    }
    try {
      if (sessionStorage.getItem('notes_offline_setup_modal_shown') === '1') return;
      sessionStorage.setItem('notes_offline_setup_modal_shown', '1');
    } catch (err) {
      return;
    }
    const enable = await confirmAction(
      'Turn on Remember password so you can unlock without Wi‑Fi after force-quit. The vault still starts locked. Only enable on a phone you trust.',
      { title: 'Offline unlock', confirmLabel: 'Enable Remember password' },
    );
    if (enable) {
      enableRememberDevice();
      return;
    }
    try {
      localStorage.setItem('notes_offline_setup_modal_dismissed', '1');
    } catch (err) {
      /* ignore quota */
    }
  }

  async function serverUnreachableNow() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (typeof window.notesNetworkReachable === 'function' && !window.notesNetworkReachable()) return true;
    // Probe /api/health — iOS may keep navigator.onLine=true with Wi‑Fi off, which made
    // NotesOcr.serverReachable() optimistically return true and skip offline unlock marking.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch('/api/health', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      return !res.ok;
    } catch (err) {
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  let sessionExpiredAlertShown = false;

  function markJustUnlocked() {
    try {
      sessionStorage.setItem('notes_unlock_at', String(Date.now()));
    } catch (err) { /* ignore */ }
  }

  function recentlyUnlocked() {
    try {
      const t = Number(sessionStorage.getItem('notes_unlock_at') || 0);
      return t > 0 && (Date.now() - t) < 20000;
    } catch (err) {
      return false;
    }
  }

  function isTotpRequiredError(err) {
    if (!err || err.status !== 403) return false;
    return /2fa required/i.test(String(err.message || ''));
  }

  function redirectToTotpIfNeeded() {
    let next = '/totp';
    try {
      const note = new URLSearchParams(location.search).get('note') || '';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(note)) {
        next = `/totp?note=${encodeURIComponent(note)}`;
      }
    } catch (err) { /* ignore */ }
    location.assign(next);
  }

  function isUnlockScreenVisible() {
    return !NotesStore.isUnlocked()
      && unlockScreen
      && !unlockScreen.hidden;
  }

  function showUnlockSessionHint() {
    NotesStore.emitSync('pending', 'Sign in to sync');
    const hint = document.getElementById('unlock-session-hint');
    if (hint) hint.hidden = false;
  }

  function hideUnlockSessionHint() {
    const hint = document.getElementById('unlock-session-hint');
    if (hint) hint.hidden = true;
  }

  function showSessionExpiredAlert() {
    if (sessionExpiredAlertShown) return;
    if (recentlyUnlocked()) {
      NotesStore.emitSync('pending', 'Sign in to sync');
      return;
    }
    if (isUnlockScreenVisible()) {
      showUnlockSessionHint();
      return;
    }
    sessionExpiredAlertShown = true;
    confirmAction(
      'Your encrypted notes are safe. Your account session expired, so synchronization is paused. Sign in again to resume syncing.',
      {
        title: 'Sign in required',
        confirmLabel: 'Sign in',
        cancelLabel: 'Not now',
      },
    ).then((signIn) => {
      if (signIn) location.assign('/login?reason=session-expired');
    });
  }

  async function trySilentSessionRepair(cached) {
    if (!cached?.email || typeof NotesVaultSecrets === 'undefined') return false;
    const candidates = [];
    const accountPass = NotesVaultSecrets.getAccountPassword();
    const vaultPass = NotesVaultSecrets.getVaultPassword();
    if (accountPass) candidates.push(accountPass);
    if (vaultPass && vaultPass !== accountPass) candidates.push(vaultPass);
    for (const pass of candidates) {
      try {
        const relogin = await repairUnlockWithPassword(cached.email, pass);
        if (relogin.ok) {
          sessionExpiredAlertShown = false;
          if (relogin.totpRequired) return 'totp';
          return true;
        }
      } catch (reloginErr) {
        /* try next password */
      }
    }
    return false;
  }

  async function ensureServerSession(options = {}) {
    const prompt = options.prompt !== false;
    if (!NotesStore.isUnlocked()) return false;
    let authenticationExpired = false;
    let totpPending = false;
    if (NotesStore.csrf()) {
      try {
        await NotesStore.loadAccount();
        sessionExpiredAlertShown = false;
        return true;
      } catch (err) {
        if (isSessionRevokedError(err)) {
          await wipeAfterRemoteSignOut();
          return false;
        }
        if (isTotpRequiredError(err)) totpPending = true;
        else if (err && ![401, 403, 404].includes(err.status)) throw err;
        else authenticationExpired = true;
        NotesStore.setCsrf('');
      }
    }
    try {
      const data = await NotesStore.api('/api/account/unlock', {
        method: 'POST',
        body: JSON.stringify({}),
        timeoutMs: 4000,
      });
      NotesStore.cacheAccount({
        email: data.email,
        kdf_salt: data.kdf_salt,
        vault_kdf_version: data.vault_kdf_version,
        csrf: data.csrf,
      });
      sessionExpiredAlertShown = false;
      return true;
    } catch (err) {
      if (isSessionRevokedError(err)) {
        await wipeAfterRemoteSignOut();
        return false;
      }
      if (isTotpRequiredError(err)) totpPending = true;
      else if (authenticationExpired || (err && [401, 403, 404].includes(err.status))) {
        const cached = NotesStore.cachedAccount();
        const repaired = await trySilentSessionRepair(cached);
        if (repaired === true) return true;
        if (repaired === 'totp') totpPending = true;
      }
      if (totpPending) {
        NotesStore.emitSync('pending', 'Enter authenticator code to sync');
        if (prompt && !recentlyUnlocked()) redirectToTotpIfNeeded();
        return false;
      }
      if (authenticationExpired || (err && [401, 403, 404].includes(err.status))) {
        NotesStore.emitSync('pending', 'Sign in to sync');
        if (prompt) showSessionExpiredAlert();
      }
      return false;
    }
  }

  window.notesEnsureServerSession = ensureServerSession;

  function isChecklistEditor(type) {
    return type === 'checklist' || type === 'super';
  }

  const FILTER_TITLES = {
    all: 'Notes',
    pinned: 'Starred',
    untagged: 'Untagged',
    documents: 'Files',
    archived: 'Archived',
    trash: 'Trash',
  };

  function kindIconSvg(name) {
    if (name === 'totp') {
      return `<svg class="note-kind-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4.4l2.8 1.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (name === 'checklist') {
      return `<svg class="note-kind-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 12.2l2.6 2.6L16.2 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    return `<svg class="note-kind-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 3.8h6.8L18.5 8v12.2h-11z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14.2 3.8V8h4.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  }

  function isTwoFaListNote(note) {
    if (!note) return false;
    if (note.content?.type === 'totp') return true;
    if (window.NotesTotp?.isTwoFaNote) {
      try {
        return NotesTotp.isTwoFaNote(note, { tags: NotesStore.listTags() });
      } catch (err) {
        /* ignore */
      }
    }
    return /(?:^|[^A-Za-z0-9])2\s*fa\b/i.test(String(note.content?.title || ''));
  }

  function kindIconHtml(kind) {
    const tone = kind.tone || 'note';
    const inner = kind.svg || escapeHtml(kind.icon || '');
    return `<span class="note-kind-icon note-kind-icon--${escapeAttr(tone)}" aria-hidden="true">${inner}</span>`;
  }

  function listThumbPlaceholderHtml(kind) {
    const tone = kind.tone || 'note';
    const inner = kind.svg || escapeHtml(kind.icon || '');
    return `<span class="note-kind-icon note-kind-icon--${escapeAttr(tone)} note-list-thumb-fallback" aria-hidden="true">${inner}</span>`;
  }

  function listThumbHtml(att, noteId, kind) {
    return `<div class="note-list-thumb" data-thumb-id="${escapeAttr(att.uuid)}" data-note-id="${escapeAttr(noteId)}" aria-hidden="true">${listThumbPlaceholderHtml(kind)}</div>`;
  }

  function paintListThumbFallback(stage, kind) {
    if (!stage) return;
    stage.classList.remove('ios-pdf-deferred', 'ios-pdf-loading');
    const meta = kind && (kind.svg || kind.icon) ? kind : { icon: '📄', tone: 'note', svg: kindIconSvg('note') };
    stage.innerHTML = listThumbPlaceholderHtml(meta);
  }

  function listThumbKindMeta(note, att) {
    if (note) return noteKindMeta(note);
    const name = att?.content?.filename || att?.content?.original_filename || '';
    const fileKind = NotesPreview.kindFromMeta(att?.content?.mime, name);
    if (fileKind === 'image') return { icon: '🖼', label: 'Photo', tone: 'note' };
    return { icon: '📄', label: 'Document', tone: 'note', svg: kindIconSvg('note') };
  }

  function attachListThumbErrorHandler(img, stage, noteId, attId) {
    img.onerror = () => {
      // Only revoke URLs this cache owns; makeListThumbUrl can hand back the
      // full-size previewCache URL, which the inline viewer still needs.
      if (listThumbCache.get(attId) === img.src) {
        try { URL.revokeObjectURL(img.src); } catch (err) { /* ignore */ }
        listThumbCache.delete(attId);
      }
      const note = NotesStore.get(noteId);
      const att = NotesStore.get(attId);
      paintListThumbFallback(stage, listThumbKindMeta(note, att));
    };
  }

  function noteListPreview(note, fallbackSnippet, query) {
    if (isTwoFaListNote(note) && window.NotesTotp?.parseText) {
      const count = NotesTotp.parseText(note.content.content || '').length;
      const label = count === 1 ? 'TokenVault Entry' : 'TokenVault Entries';
      return `<p class="note-preview"><strong>${count}</strong> ${escapeHtml(label)}</p>`;
    }
    const editor = note.content.editor || 'plain';
    if ((editor === 'checklist' || editor === 'super') && window.NotesChecklist?.parse) {
      const items = NotesChecklist.parse(note.content.content || '', { nested: editor === 'super' })
        .filter((row) => String(row.text || '').trim());
      const done = items.filter((row) => row.done).length;
      const open = items.filter((row) => !row.done);
      const pct = items.length ? Math.round((done / items.length) * 100) : 0;
      const bullets = open.slice(0, 2).map((row) => `• ${row.text}`).join('\n');
      const more = Math.max(0, open.length - 2);
      return `<p class="note-preview"><strong>${done}/${items.length}</strong> tasks completed</p>
        <span class="note-progress" aria-hidden="true"><span style="width:${pct}%"></span></span>
        ${bullets ? `<p class="note-preview-bullets">${escapeHtml(bullets)}</p>` : ''}
        ${more ? `<p class="note-preview-more">And ${more} other open task${more === 1 ? '' : 's'}.</p>` : ''}`;
    }
    if (!fallbackSnippet) return '';
    const snippetHtml = query
      ? NotesSearch.highlightPlain(String(fallbackSnippet).slice(0, 120), query)
      : escapeHtml(String(fallbackSnippet).slice(0, 120));
    return `<p class="note-preview">${snippetHtml}</p>`;
  }

  function noteKindMeta(note) {
    if (isTwoFaListNote(note)) return { icon: '⏱', label: '2FA', tone: 'totp', svg: kindIconSvg('totp') };
    const atts = NotesStore.listAttachments(note.uuid);
    if (atts.length) {
      const first = atts[0]?.content || {};
      const kind = NotesPreview.kindFromMeta(first.mime, first.filename);
      if (kind === 'pdf') return { icon: '📄', label: 'Document', tone: 'note', svg: kindIconSvg('note') };
      if (kind === 'image') return { icon: '🖼', label: 'Photo', tone: 'note' };
      if (kind === 'text') return { icon: '📃', label: 'Text file', tone: 'note', svg: kindIconSvg('note') };
      return { icon: '📎', label: 'Attachment', tone: 'note' };
    }
    const editor = note.content.editor || 'plain';
    if (editor === 'checklist' || editor === 'super') return { icon: '☑', label: 'Checklist', tone: 'checklist', svg: kindIconSvg('checklist') };
    if (editor === 'superscript') return { icon: 'x²', label: 'Superscript', tone: 'note', svg: kindIconSvg('note') };
    if (editor === 'markdown') return { icon: '⌘', label: 'Markdown', tone: 'note', svg: kindIconSvg('note') };
    if (editor === 'code') return { icon: '{ }', label: 'Code', tone: 'note', svg: kindIconSvg('note') };
    return { icon: '📝', label: 'Note', tone: 'note', svg: kindIconSvg('note') };
  }

  function noteSectionKey(isoOrMs) {
    const at = typeof isoOrMs === 'number' ? isoOrMs : parseTimestampMs(isoOrMs);
    if (!Number.isFinite(at) || at <= 0) return 'Older';
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startYesterday = startToday - 86400000;
    const startWeek = startToday - 6 * 86400000;
    if (at >= startToday) return 'Today';
    if (at >= startYesterday) return 'Yesterday';
    if (at >= startWeek) return 'This week';
    return 'Older';
  }

  function initialEditorMode(noteId) {
    const note = NotesStore.get(noteId);
    if (!note) return 'edit';
    if (noteHasDocs(noteId)) {
      if (currentSearchQuery()) return 'preview';
      const body = String(note.content.content || '').trim();
      if (!body) return 'preview';
      return prefs.autoPreview ? 'preview' : 'edit';
    }
    const type = note.content.editor || 'plain';
    if (isChecklistEditor(type)) return 'edit';
    if (note.content.prevent_edit) return 'preview';
    return 'edit';
  }

  let renderNotesFrame = 0;
  let lastNotesRenderKey = '';
  let networkReachable = typeof navigator === 'undefined' || navigator.onLine !== false;
  let networkProbeTimer = null;

  const thumbObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const attId = el.dataset.lazyThumb;
        const noteId = el.dataset.noteId;
        if (attId && noteId) hydrateThumb(noteId, attId, el, { forList: el.dataset.listThumb === '1' });
        thumbObserver.unobserve(el);
      });
    }, { rootMargin: '120px' })
    : null;

  function observeThumb(noteId, attId, stage, { forList = false } = {}) {
    if (!stage) return;
    const att = NotesStore.get(attId);
    if (iosDeferPdfPreview(att, { forList }) && !att?.content?.preview_enc) {
      paintIosPdfPlaceholder(stage, att?.content?.filename, { compact: true });
      queueListPreviewBackfill(attId);
      return;
    }
    if (!thumbObserver) {
      hydrateThumb(noteId, attId, stage, { forList });
      return;
    }
    stage.dataset.lazyThumb = attId;
    stage.dataset.noteId = noteId;
    if (forList) stage.dataset.listThumb = '1';
    thumbObserver.observe(stage);
  }

  function attachDocZoom(stage, kind) {
    stage._docZoomKind = kind;
    NotesPreview.enablePinchZoom(stage, {
      onPinch: () => {
        try {
          localStorage.setItem('notes_pinch_verified', String(Date.now()));
        } catch (err) {
          /* ignore quota */
        }
      },
      onScaleSettled: () => {
        updateDocZoomLabel();
        maybeUpgradePreviewQuality();
      },
      onDoubleTap: () => {
        clearTimeout(docChromeTapTimer);
        docChromeTapTimer = null;
      },
    });
    updateDocZoomLabel();
  }

  function maybeUpgradePreviewQuality() {
    const stage = ui.docStage;
    if (!stage?._docZoom) return;
    const kind = stage._docZoomKind;
    // PDF uses CSS transform zoom only — re-rendering on pinch blanks the canvas on iOS WebKit.
    if (kind === 'pdf') return;
    const scale = stage._docZoom.getScale();
    if (scale < 1.25) return;
    const work = kind === 'pdf'
      ? NotesPreview.upgradePdfQuality(stage, scale)
      : kind === 'image'
        ? NotesPreview.upgradeImageQuality(stage, scale)
        : Promise.resolve(false);
    Promise.resolve(work).then(() => stage._docZoom?.refresh?.()).catch(() => {});
  }

  function readingTime(text) {
    const words = String(text || '').trim() ? String(text).trim().split(/\s+/).length : 0;
    const minutes = Math.max(1, Math.round(words / 220));
    return { words, minutes };
  }

  function noteReadableText(note) {
    const body = String(note?.content?.content || '').trim();
    if (body) return body;
    return NotesStore.listAttachments(note?.uuid || '')
      .map((item) => String(item.content?.ocr_text || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  function bumpIdle() {
    clearTimeout(idleTimer);
    let minutes = Number(prefs.autoLockMin) || 0;
    if (!minutes || !NotesStore.isUnlocked()) return;
    idleTimer = setTimeout(() => {
      if (unlockInFlight || (unlockScreen && !unlockScreen.hidden)) {
        bumpIdle();
        return;
      }
      if (IS_IOS && iosTune()?.isTypingInField?.()) {
        bumpIdle();
        return;
      }
      lockVault('Locked after idle.');
    }, minutes * 60 * 1000);
  }

  function unfocusSyncBlocksLock() {
    return !!(syncInFlight || vaultPullActive || unlockInFlight);
  }

  function lockVaultAfterUnfocus(message) {
    if (unfocusLocking || !NotesStore.isUnlocked()) return;
    if (unfocusSyncBlocksLock()) {
      if (!unfocusLockDeadline) unfocusLockDeadline = Date.now() + UNFOCUS_LOCK_SYNC_WAIT_MS;
      if (Date.now() < unfocusLockDeadline) {
        clearTimeout(unfocusTimer);
        unfocusTimer = setTimeout(() => lockVaultAfterUnfocus(message), 2000);
        return;
      }
    }
    unfocusLockDeadline = 0;
    unfocusLocking = true;
    markTypedUnlockRequired();
    Promise.resolve(lockVault(message)).finally(() => {
      unfocusLocking = false;
    });
  }

  function scheduleUnfocusLock(message, delayMs) {
    clearTimeout(unfocusTimer);
    unfocusTimer = setTimeout(() => {
      if (isTransientUnfocus()) return;
      if (document.visibilityState !== 'hidden' || !NotesStore.isUnlocked()) return;
      lockVaultAfterUnfocus(message);
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function syncWhileVaultLocked({ quiet = true, force = false } = {}) {
    if (NotesStore.isUnlocked()) {
      return syncNow({ quiet, force: force || true }).catch(() => false);
    }
    if (!NotesStore.csrf()) {
      const ok = await ensureServerSession({ prompt: false }).catch(() => false);
      if (!ok) {
        NotesStore.emitSync('pending', 'Sign in to sync');
        return false;
      }
    }
    try {
      return await NotesStore.syncWhileLocked({ quiet });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        NotesStore.emitSync('pending', 'Sign in to sync');
      } else if (NotesStore.isProbablyOffline?.(err)) {
        NotesStore.emitSync('offline', 'Offline');
      } else if (!quiet) {
        NotesStore.emitSync('error', err?.message || 'Sync failed');
      }
      return false;
    }
  }

  function runBackgroundSync() {
    if (NotesStore.isUnlocked()) {
      syncNow({ quiet: true, force: true }).catch(() => {});
      return;
    }
    syncWhileVaultLocked({ quiet: true, force: true }).catch(() => {});
  }

  function kickBackgroundSync() {
    if (NotesStore.isUnlocked() && isVaultReadyForSync()) {
      syncNow({ quiet: true, force: true }).catch(() => {});
      return;
    }
    if (NotesStore.isUnlocked()) {
      syncNow({ quiet: true, force: true }).catch(() => {});
      return;
    }
    syncWhileVaultLocked({ quiet: true, force: true }).catch(() => {});
  }

  function beginNotesPicker() {
    notesPickerDepth += 1;
  }

  function endNotesPicker() {
    notesPickerDepth = Math.max(0, notesPickerDepth - 1);
  }

  let pickerCancelTimer = null;

  function watchPickerCancel(input) {
    if (!input || !IS_IOS) return;
    clearTimeout(pickerCancelTimer);
    pickerCancelTimer = setTimeout(() => {
      if (notesPickerDepth > 0 && (!input.files || !input.files.length)) {
        endNotesPicker();
      }
    }, 1500);
  }

  function scrollFocusedFieldIntoView() {
    if (!IS_IOS) return;
    const el = document.activeElement;
    if (!el || !el.matches?.('input, textarea, select')) return;
    if (!el.closest('.editor, .sidebar, #scan-dialog, .settings-panel, #unlock-form')) return;
    setTimeout(() => {
      try {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (err) {
        /* ignore */
      }
    }, 120);
  }

  function pullSyncAtTop() {
    const list = ui.noteList;
    const listPane = list?.closest('.list-pane');
    return (list?.scrollTop || 0) <= 4 && (listPane?.scrollTop || 0) <= 4;
  }

  function triggerPullSync() {
    const neverSynced = !(Number(NotesStore.state.lastSync) || 0);
    const empty = NotesStore.listNotes().length === 0;
    const full = empty || neverSynced;
    syncNow({ quiet: false, full, force: full }).catch(() => {});
  }

  function initPullToSync() {
    if (!IS_IOS || window.__pullSyncInit) return;
    window.__pullSyncInit = true;
    const list = ui.noteList;
    const listPane = list?.closest('.list-pane');
    const editorPane = document.getElementById('editor-pane');
    const empty = ui.empty;
    const targets = [list, listPane, empty, editorPane, document.getElementById('sidebar')].filter(Boolean);
    if (!targets.length) return;

    let startY = 0;
    let pulling = false;
    let indicator = document.getElementById('pull-sync-indicator');
    if (!indicator && list?.parentElement) {
      indicator = document.createElement('div');
      indicator.id = 'pull-sync-indicator';
      indicator.className = 'pull-sync-indicator';
      indicator.hidden = true;
      indicator.textContent = 'Pull to sync';
      list.parentElement.insertBefore(indicator, list);
    }

    const pullBlocked = () => !!currentId || ui.shell?.classList.contains('editor-open');

    const onTouchStart = (event) => {
      if (pullBlocked()) return;
      const fromMain = event.currentTarget === empty || event.currentTarget === editorPane;
      if (!fromMain && !pullSyncAtTop()) return;
      startY = event.touches[0].clientY;
      pulling = true;
      indicator?.classList.toggle('pull-sync-indicator-main', fromMain);
    };

    const onTouchMove = (event) => {
      if (!pulling || !indicator) return;
      const dy = event.touches[0].clientY - startY;
      if (dy < 8) {
        indicator.hidden = true;
        return;
      }
      indicator.hidden = false;
      const offset = Math.min(80, dy);
      indicator.textContent = offset >= 72 ? 'Release to sync' : 'Pull to sync';
      if (indicator.classList.contains('pull-sync-indicator-main')) {
        indicator.style.removeProperty('--pull-offset');
      } else {
        indicator.style.setProperty('--pull-offset', `${offset}px`);
      }
    };

    const endPull = () => {
      if (!pulling || !indicator) return;
      const offset = Number.parseFloat(indicator.style.getPropertyValue('--pull-offset') || '0');
      pulling = false;
      indicator.hidden = true;
      indicator.classList.remove('pull-sync-indicator-main');
      indicator.style.removeProperty('--pull-offset');
      if (offset >= 72) triggerPullSync();
    };

    for (const target of targets) {
      if (target._pullSyncBound) continue;
      target._pullSyncBound = true;
      target.addEventListener('touchstart', onTouchStart, { passive: true });
    }
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', endPull, { passive: true });
    document.addEventListener('touchcancel', endPull, { passive: true });
  }

  function initEditorEdgeSwipeBack() {
    const pane = document.getElementById('editor-pane');
    if (!pane || pane._edgeSwipeBound) return;
    pane._edgeSwipeBound = true;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    pane.addEventListener('touchstart', (event) => {
      if (!IS_IOS || !currentId || ui.editor?.hidden) return;
      const touch = event.touches[0];
      if (touch.clientX > 28) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    }, { passive: true });
    pane.addEventListener('touchmove', (event) => {
      if (!tracking) return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx) + 14) tracking = false;
      if (dx > 84 && Math.abs(dy) < 48) {
        tracking = false;
        closeEditor();
      }
    }, { passive: true });
    pane.addEventListener('touchend', () => { tracking = false; }, { passive: true });
  }

  function handleLaunchAction() {
    let action = '';
    try {
      action = new URLSearchParams(location.search).get('action') || '';
    } catch (err) {
      action = '';
    }
    if (!action || !vaultReady) return;
    if (action === 'new') {
      createNote();
      return;
    }
    if (action === 'search') {
      ui.search?.focus();
      scrollFocusedFieldIntoView();
    }
  }

  function isTransientUnfocus() {
    const VL = window.NotesVaultLock;
    const scanEl = document.getElementById('scan-dialog');
    const scanOpen = document.body.classList.contains('scan-dialog-open')
      || !!(scanEl && !scanEl.hidden);
    const updating = document.body.classList.contains('app-updating');
    if (VL?.isTransientUnfocus) {
      return VL.isTransientUnfocus({
        scanOpen,
        pickerOpen: notesPickerDepth > 0,
        updating,
      });
    }
    return scanOpen || notesPickerDepth > 0 || updating;
  }

  function readUnfocusedAt() {
    try {
      const VL = window.NotesVaultLock;
      const sessionVal = sessionStorage.getItem(VL?.UNFOCUS_AT_KEY || 'notes_unfocused_at');
      const localVal = localStorage.getItem(VL?.UNFOCUS_AT_KEY || 'notes_unfocused_at');
      if (VL?.readHiddenAt) return VL.readHiddenAt(sessionVal, localVal);
      return Math.max(Number(sessionVal || 0), Number(localVal || 0)) || 0;
    } catch (err) {
      return 0;
    }
  }

  function markUnfocusedAt(ts = Date.now()) {
    const key = window.NotesVaultLock?.UNFOCUS_AT_KEY || 'notes_unfocused_at';
    const v = String(ts);
    try { sessionStorage.setItem(key, v); } catch (err) { /* ignore */ }
    try { localStorage.setItem(key, v); } catch (err) { /* ignore */ }
  }

  function clearUnfocusedAt() {
    const key = window.NotesVaultLock?.UNFOCUS_AT_KEY || 'notes_unfocused_at';
    try { sessionStorage.removeItem(key); } catch (err) { /* ignore */ }
    try { localStorage.removeItem(key); } catch (err) { /* ignore */ }
  }

  function onAppBackground() {
    if (!NotesStore.isUnlocked()) return;
    if (isTransientUnfocus()) return;
    const mode = lockOnUnfocusMode();
    if (mode === 'never') return;
    if (!readUnfocusedAt()) markUnfocusedAt();
    clearTimeout(unfocusTimer);
    unfocusTimer = null;
    if (mode === 'immediate') {
      lockVaultAfterUnfocus('Vault locked.');
      return;
    }
    const wait = Math.max(0, (window.NotesVaultLock?.UNFOCUS_MS || 60000) - (Date.now() - readUnfocusedAt()));
    scheduleUnfocusLock('Locked after 1 minute away.', wait);
    kickBackgroundSync();
  }

  function settleUnfocusLockOnForeground() {
    clearTimeout(unfocusTimer);
    unfocusTimer = null;
    unfocusLockDeadline = 0;
    if (isTransientUnfocus()) return;
    const hiddenAt = readUnfocusedAt();
    const VL = window.NotesVaultLock;
    const shouldLock = VL?.shouldLockOnReturn
      ? VL.shouldLockOnReturn({
        mode: lockOnUnfocusMode(),
        hiddenAt,
        now: Date.now(),
        unlocked: NotesStore.isUnlocked(),
      })
      : (lockOnUnfocusMode() === '1min' && NotesStore.isUnlocked() && hiddenAt && Date.now() - hiddenAt >= 60000);
    if (shouldLock) {
      lockVaultAfterUnfocus('Locked after 1 minute away.');
      clearUnfocusedAt();
      return;
    }
    clearTimeout(unfocusClearTimer);
    const clearAfter = VL?.VISIBLE_CLEAR_MS || 2000;
    unfocusClearTimer = setTimeout(() => {
      if (document.visibilityState === 'visible' && !isTransientUnfocus()) clearUnfocusedAt();
    }, clearAfter);
  }

  async function lockVault(message, { skipSync = false } = {}) {
    if (unlockInFlight) {
      setTimeout(() => {
        lockVault(message, { skipSync }).catch(() => {});
      }, 400);
      return;
    }
    const updating = window.NotesVaultLock?.isAppUpdating
      ? NotesVaultLock.isAppUpdating(document.body, window.__notesUpdateInFlight)
      : !!(document.body.classList.contains('app-updating') || window.__notesUpdateInFlight);
    if (window.NotesVaultLock?.mayLockVault && !NotesVaultLock.mayLockVault({ updating })) return;
    // Show the locked state right away; the push below must not hold the UI hostage.
    syncVaultLockUi(false);
    if (!skipSync) {
      flushSave();
      try {
        // Unsynced items are persisted in IndexedDB and pushed after the next
        // unlock, so a slow/suspended network (iOS background) may not delay the lock.
        await Promise.race([
          NotesStore.flush(),
          new Promise((resolve) => setTimeout(resolve, LOCK_FLUSH_WAIT_MS)),
        ]);
      } catch (e) {
        /* still lock */
      }
    } else {
      NotesStore.abandonLocalForPasswordRotation?.();
    }
    clearTimeout(idleTimer);
    clearTimeout(unfocusTimer);
    unfocusTimer = null;
    // Keep polling while locked so ciphertext push/pull continues in the background.
    scheduleChangePoll({ background: true });
    // Tear down editor/list chrome before locking so unlock never flashes a ghost note.
    hideFindBar();
    hideTagSuggest();
    closeDocPreview();
    ui.shell.classList.remove('editor-open');
    currentId = null;
    listSelectionId = null;
    if (ui.editor) ui.editor.hidden = true;
    lastNotesRenderKey = '';
    if (ui.noteList) ui.noteList.replaceChildren();
    unlockedNotes.clear();
    clearListThumbCache();
    clearPreviewCache();
    if (typeof NotesAiChat !== 'undefined') NotesAiChat.reset();
    prefs.aiChat = null;
    globalPrefsAppliedAt = 0;
    NotesStore.lock();
    sessionExpiredAlertShown = false;
    try { sessionStorage.removeItem('notes_totp_resync'); } catch (err) { /* ignore */ }
    syncWhileVaultLocked({ quiet: true }).catch(() => {});
    vaultReady = false;
    vaultHydrated = false;
    unlockDidSync = false;
    unlockInFlight = null;
    endVaultPull();
    markVaultShellLocked();
    syncVaultLockUi(false);
    deferredOpenNoteId = null;
    // Do not set vaultNeedsReload — that forces a full server download on the
    // next unlock. IndexedDB still has the notes after a normal lock.
    rememberOpen(null);
    hideScanDialog();
    hideTotpAddDialog();
    closeSettings(true);
    stopTotpClock();
    const cached = NotesStore.cachedAccount?.() || {};
    showUnlock(cached.email || undefined);
    if (message) {
      if (unlockError) {
        unlockError.textContent = message;
        unlockError.hidden = false;
      }
      toast(message, true);
    }
  }

  function rememberOpen(id) {
    if (id) sessionStorage.setItem('notes_open_id', id);
    else sessionStorage.removeItem('notes_open_id');
  }

  function toast(message, isError = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    const locked = document.body.classList.contains('locked') || isUnlockScreenVisible();
    const VL = window.NotesVaultLock;
    const allow = VL?.shouldShowLockScreenToast
      ? VL.shouldShowLockScreenToast({ locked, isError, message })
      : (!locked || !!isError);
    if (!allow) {
      if (!isError || VL?.isBackgroundSyncToast?.(message)) {
        el.hidden = true;
        el.textContent = '';
      }
      return;
    }
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  const totpUi = {
    pane: document.getElementById('totp-pane'),
    list: document.getElementById('totp-list'),
    empty: document.getElementById('totp-empty'),
    search: document.getElementById('totp-search'),
    meta: document.getElementById('totp-source-meta'),
    add: document.getElementById('btn-totp-add'),
    dialog: document.getElementById('totp-add-dialog'),
    backdrop: document.getElementById('totp-add-backdrop'),
    issuer: document.getElementById('totp-add-issuer'),
    account: document.getElementById('totp-add-account'),
    secret: document.getElementById('totp-add-secret'),
    error: document.getElementById('totp-add-error'),
    video: document.getElementById('totp-qr-video'),
    canvas: document.getElementById('totp-qr-canvas'),
    qrStatus: document.getElementById('totp-qr-status'),
    qrInput: document.getElementById('totp-qr-input'),
  };
  let appTab = 'notes';
  let totpEntries = [];
  let totpClock = 0;
  let totpQrTimer = 0;
  let totpQrStream = null;

  function normalizeAppTab(name) {
    if (name === '2fa' || name === 'files') return name;
    return 'notes';
  }

  function currentAppTab() {
    return normalizeAppTab(appTab);
  }

  function syncAppTabButtons(tab) {
    document.querySelectorAll('.app-tab').forEach((btn) => {
      const on = btn.dataset.appTab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function setAppTab(name, { persist = true } = {}) {
    const next = normalizeAppTab(name);
    if (next === '2fa' && !planHas('vault_authenticator')) {
      toast('Vault authenticator is included with Pro', true);
      return;
    }
    appTab = next;
    root.dataset.appTab = appTab;
    syncAppTabButtons(appTab);
    if (ui.shell) ui.shell.hidden = appTab === '2fa';
    if (totpUi.pane) totpUi.pane.hidden = appTab !== '2fa';
    if (persist) {
      try { sessionStorage.setItem('notes_app_tab', appTab); } catch (err) { /* ignore */ }
    }
    if (appTab === '2fa') {
      refreshTotpVault({ migrate: true });
      startTotpClock();
    } else {
      stopTotpClock();
      if (appTab === 'files') {
        if (currentFilter !== 'documents') setFilter('documents');
        renderTags();
        renderNotes();
      } else if (currentFilter === 'documents') {
        const VL = window.NotesVaultLock;
        setFilter(VL?.filterAfterLeavingFiles
          ? VL.filterAfterLeavingFiles(filterBeforeFiles)
          : (filterBeforeFiles && filterBeforeFiles !== 'documents' ? filterBeforeFiles : 'all'));
        renderTags();
        renderNotes();
      }
    }
    updateFab();
  }

  function updateFab() {
    const fab = document.getElementById('fab-add');
    if (!fab) return;
    const on2fa = currentAppTab() === '2fa';
    fab.setAttribute('aria-label', on2fa ? 'Add 2FA account' : 'New note');
    fab.title = on2fa ? 'Add account' : 'New note';
  }

  function restoreAppTab() {
    let saved = 'notes';
    try { saved = sessionStorage.getItem('notes_app_tab') || 'notes'; } catch (err) { saved = 'notes'; }
    setAppTab(normalizeAppTab(saved), { persist: false });
  }

  let totpParseError = '';

  function totpAccountFromItem(item) {
    const content = item && item.content ? item.content : {};
    return {
      id: item.uuid,
      issuer: content.issuer || '',
      account: content.account || content.issuer || 'Account',
      secret: content.secret || '',
      digits: Number(content.digits || 6) || 6,
      period: Number(content.period || 30) || 30,
      algorithm: String(content.algorithm || 'SHA1').toUpperCase().replace('-', ''),
    };
  }

  function migrateTotpFromNotes() {
    if (!window.NotesTotp || !NotesStore.isUnlocked?.() || !NotesStore.listTotpAccounts) return { added: 0, deleted: 0 };
    const existing = NotesStore.listTotpAccounts().map((item) => item.content);
    const plan = NotesTotp.migrateFromNotes(NotesStore.listNotes(), existing, { tags: NotesStore.listTags() });
    let added = 0;
    for (const entry of plan.toAdd || []) {
      const result = NotesStore.addTotpAccount(entry);
      if (result && result.created) added += 1;
    }
    let deleted = 0;
    for (const id of plan.noteIds || []) {
      if (id === currentId) closeEditor();
      NotesStore.remove(id);
      deleted += 1;
    }
    if (deleted) {
      renderNotes();
      renderTags();
      renderVaultStats();
      updateEmptyStateVisibility();
    }
    return { added, deleted };
  }

  let totpResyncInFlight = null;

  async function ensureTotpAccountsFromServer() {
    if (totpResyncInFlight) return totpResyncInFlight;
    if (!NotesStore.isUnlocked?.() || !isVaultReadyForSync()) return null;
    if ((NotesStore.countTotpItems?.() || 0) > 0) return null;
    let resynced = false;
    try { resynced = sessionStorage.getItem('notes_totp_resync') === '1'; } catch (err) { /* ignore */ }
    if (resynced) return null;
    totpResyncInFlight = (async () => {
      try { sessionStorage.setItem('notes_totp_resync', '1'); } catch (err) { /* ignore */ }
      try {
        await syncNow({ full: true, quiet: true, force: true });
      } catch (err) {
        console.warn('2FA full vault resync failed', err);
      }
    })().finally(() => {
      totpResyncInFlight = null;
    });
    return totpResyncInFlight;
  }

  function refreshTotpVault({ migrate = false } = {}) {
    totpParseError = '';
    if (!window.NotesTotp || !NotesStore.isUnlocked?.()) {
      totpEntries = [];
      if (currentAppTab() === '2fa') renderTotpList();
      return;
    }
    try {
      if (migrate) {
        const migrated = migrateTotpFromNotes();
        if (migrated.added || migrated.deleted) {
          const bits = [];
          if (migrated.added) bits.push(`moved ${migrated.added} account${migrated.added === 1 ? '' : 's'} into 2FA`);
          if (migrated.deleted) bits.push('removed the 2FA note');
          if (bits.length) toast(bits.join(' and '));
        }
        const cleaned = NotesStore.dedupeTotpAccounts?.();
        if (cleaned && cleaned.removed) {
          toast(`Removed ${cleaned.removed} duplicate account${cleaned.removed === 1 ? '' : 's'}`);
        }
      }
      totpEntries = (NotesStore.listTotpAccounts?.() || []).map(totpAccountFromItem);
      if (!totpEntries.length && NotesStore.listNotes().length > 0) {
        ensureTotpAccountsFromServer().then(() => refreshTotpVault({ migrate: true }));
      } else if (totpEntries.length) {
        try { sessionStorage.removeItem('notes_totp_resync'); } catch (err) { /* ignore */ }
      }
    } catch (err) {
      console.warn('2FA tab failed to read accounts', err);
      totpParseError = err && err.message ? String(err.message) : 'parse failed';
      totpEntries = [];
    }
    if (totpUi.meta) {
      if (totpParseError) totpUi.meta.textContent = 'Could not read authenticator accounts';
      else if (!totpEntries.length) totpUi.meta.textContent = 'Add an account with a QR code or secret';
      else totpUi.meta.textContent = `${totpEntries.length} account${totpEntries.length === 1 ? '' : 's'} in the vault`;
    }
    if (currentAppTab() === '2fa') renderTotpList();
  }

  function totpEmptyCopy() {
    if (totpParseError) return 'The 2FA tab hit an error while reading accounts.';
    if (totpEntries.length) return 'No matching accounts.';
    return 'No authenticator accounts yet.\nTap + to scan a QR code or enter a secret.';
  }

  function filteredTotpEntries() {
    const q = String(totpUi.search?.value || '').trim().toLowerCase();
    if (!q) return totpEntries;
    return totpEntries.filter((item) => `${item.issuer} ${item.account}`.toLowerCase().includes(q));
  }

  function totpRingSvg(progress, ending) {
    const r = 8;
    const c = 2 * Math.PI * r;
    const dash = Math.max(0, Math.min(c, c * progress));
    return `<svg class="totp-ring${ending ? ' is-ending' : ''}" viewBox="0 0 22 22" aria-hidden="true">
      <circle class="totp-ring-track" cx="11" cy="11" r="${r}"></circle>
      <circle class="totp-ring-value" cx="11" cy="11" r="${r}" stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"></circle>
    </svg>`;
  }

  async function renderTotpList() {
    if (!totpUi.list) return;
    const rows = filteredTotpEntries();
    if (!rows.length) {
      totpUi.list.replaceChildren();
      if (totpUi.empty) {
        totpUi.empty.hidden = false;
        totpUi.empty.textContent = totpEmptyCopy();
      }
      return;
    }
    if (totpUi.empty) totpUi.empty.hidden = true;
    const now = Date.now();
    const codes = await Promise.all(rows.map(async (item) => {
      try {
        return await NotesTotp.generate({ ...item, now });
      } catch (err) {
        return { code: '------', remaining: 0, period: item.period || 30, progress: 0 };
      }
    }));
    totpUi.list.innerHTML = rows.map((item, i) => {
      const totp = codes[i];
      const label = item.issuer && item.account && item.issuer !== item.account
        ? item.account
        : (item.account || item.issuer || 'Account');
      const issuer = item.issuer && item.issuer !== label ? item.issuer : '';
      const pretty = `${totp.code.slice(0, 3)} ${totp.code.slice(3)}`;
      const remaining = Math.max(0, Math.round(Number(totp.remaining) || 0));
      return `<div class="totp-item" data-totp-id="${escapeAttr(item.id)}">
        <button type="button" class="totp-item-main" data-totp-copy>
          <span class="note-kind-icon note-kind-icon--totp" aria-hidden="true">${kindIconSvg('totp')}</span>
          <span class="totp-item-body">
            <span class="note-title-row"><strong>${escapeHtml(label)}</strong></span>
            ${issuer ? `<span class="note-preview">${escapeHtml(issuer)}</span>` : ''}
            <span class="note-modified">Expires in ${remaining}s</span>
          </span>
          <span class="totp-item-code">
            <span class="totp-code">${escapeHtml(pretty)}</span>
            ${totpRingSvg(totp.progress, totp.remaining <= 5)}
          </span>
        </button>
        <button type="button" class="totp-item-remove" data-totp-remove aria-label="Remove ${escapeAttr(label)}">×</button>
      </div>`;
    }).join('');
  }

  function startTotpClock() {
    stopTotpClock();
    totpClock = window.setInterval(() => {
      if (currentAppTab() === '2fa') renderTotpList();
    }, 500);
    renderTotpList();
  }

  function stopTotpClock() {
    if (totpClock) {
      clearInterval(totpClock);
      totpClock = 0;
    }
  }

  async function copyTotpEntry(id) {
    const item = totpEntries.find((entry) => entry.id === id);
    if (!item) return;
    try {
      const totp = await NotesTotp.generate(item);
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(totp.code);
      else {
        const helper = document.createElement('textarea');
        helper.value = totp.code;
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      toast('Copied code');
    } catch (err) {
      toast('Could not copy code', true);
    }
  }

  async function removeTotpEntry(id) {
    const item = totpEntries.find((entry) => entry.id === id);
    if (!item) return;
    const label = item.issuer && item.account && item.issuer !== item.account
      ? `${item.account} (${item.issuer})`
      : (item.account || item.issuer || 'this account');
    if (!(await confirmAction(`Remove ${label} from 2FA? This does not change the service itself.`, {
      title: 'Remove account',
      confirmLabel: 'Remove',
      danger: true,
    }))) return;
    NotesStore.removeTotpAccount(id);
    toast('Removed account');
    refreshTotpVault();
  }

  function setTotpAddError(message) {
    if (!totpUi.error) return;
    totpUi.error.hidden = !message;
    totpUi.error.textContent = message || 'Enter a valid authenticator secret.';
  }

  function stopTotpQrScan() {
    if (totpQrTimer) {
      clearTimeout(totpQrTimer);
      totpQrTimer = 0;
    }
    if (totpQrStream) {
      totpQrStream.getTracks().forEach((track) => track.stop());
      totpQrStream = null;
    }
    if (totpUi.video) {
      totpUi.video.pause();
      totpUi.video.srcObject = null;
      totpUi.video.hidden = true;
    }
    if (totpUi.qrStatus) totpUi.qrStatus.hidden = true;
  }

  function hideTotpAddDialog() {
    stopTotpQrScan();
    if (totpUi.dialog) totpUi.dialog.hidden = true;
    if (totpUi.backdrop) totpUi.backdrop.hidden = true;
    document.body.classList.remove('scan-dialog-open');
    if (totpUi.issuer) totpUi.issuer.value = '';
    if (totpUi.account) totpUi.account.value = '';
    if (totpUi.secret) totpUi.secret.value = '';
    setTotpAddError('');
  }

  function showTotpAddDialog() {
    closeSettings(true);
    hideScanDialog();
    if (totpUi.issuer) totpUi.issuer.value = '';
    if (totpUi.account) totpUi.account.value = '';
    if (totpUi.secret) totpUi.secret.value = '';
    setTotpAddError('');
    if (totpUi.backdrop) totpUi.backdrop.hidden = false;
    if (totpUi.dialog) totpUi.dialog.hidden = false;
    document.body.classList.add('scan-dialog-open');
    totpUi.issuer?.focus();
  }

  function applyTotpQrPayload(raw) {
    const text = String(raw || '').trim();
    if (!text) return false;
    const entry = NotesTotp.entryFromFields({
      issuer: totpUi.issuer?.value || '',
      account: totpUi.account?.value || '',
      secret: text,
    });
    if (!entry) {
      setTotpAddError('That QR code is not a TOTP authenticator code.');
      return false;
    }
    if (totpUi.issuer && entry.issuer) totpUi.issuer.value = entry.issuer;
    if (totpUi.account && entry.account) totpUi.account.value = entry.account;
    if (totpUi.secret) totpUi.secret.value = entry.secret;
    setTotpAddError('');
    if (totpUi.qrStatus) {
      totpUi.qrStatus.hidden = false;
      totpUi.qrStatus.textContent = 'QR scanned — add to save.';
    }
    stopTotpQrScan();
    saveTotpAddDialog().catch((err) => setTotpAddError(err.message || 'Could not add account'));
    return true;
  }

  async function decodeQrFromSource(source) {
    if (globalThis.BarcodeDetector) {
      try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const codes = await detector.detect(source);
        const value = codes && codes[0] && codes[0].rawValue;
        if (value) return value;
      } catch (err) { /* try jsQR */ }
    }
    if (typeof jsQR !== 'function' || !totpUi.canvas) return '';
    const canvas = totpUi.canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '';
    let width = 0;
    let height = 0;
    if (source.videoWidth) {
      width = source.videoWidth;
      height = source.videoHeight;
    } else if (source.width) {
      width = source.width;
      height = source.height;
    }
    if (!width || !height) return '';
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(source, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const result = jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' });
    return result && result.data ? result.data : '';
  }

  async function tickTotpQrScan() {
    if (!totpUi.video || totpUi.video.hidden || totpUi.video.readyState < 2) {
      totpQrTimer = window.setTimeout(() => tickTotpQrScan().catch(() => {}), 250);
      return;
    }
    try {
      const value = await decodeQrFromSource(totpUi.video);
      if (value && applyTotpQrPayload(value)) return;
    } catch (err) { /* keep scanning */ }
    totpQrTimer = window.setTimeout(() => tickTotpQrScan().catch(() => {}), 250);
  }

  async function startTotpQrScan() {
    stopTotpQrScan();
    setTotpAddError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      totpUi.qrInput?.click();
      return;
    }
    try {
      totpQrStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (!totpUi.video) throw new Error('Missing camera preview');
      totpUi.video.srcObject = totpQrStream;
      totpUi.video.hidden = false;
      await totpUi.video.play();
      if (totpUi.qrStatus) {
        totpUi.qrStatus.hidden = false;
        totpUi.qrStatus.textContent = 'Point the camera at the QR code.';
      }
      tickTotpQrScan().catch(() => {});
    } catch (err) {
      totpUi.qrInput?.click();
    }
  }

  async function importTotpQrFile(file) {
    if (!file) return;
    try {
      let source = file;
      if (typeof createImageBitmap === 'function') {
        source = await createImageBitmap(file);
      } else {
        source = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('Could not read that photo'));
          image.src = URL.createObjectURL(file);
        });
      }
      const value = await decodeQrFromSource(source);
      if (source.close) source.close();
      if (!applyTotpQrPayload(value)) {
        if (!value) setTotpAddError('No QR code found in that photo.');
      }
    } catch (err) {
      setTotpAddError(err.message || 'Could not read that photo.');
    }
  }

  async function saveTotpAddDialog() {
    const entry = NotesTotp.entryFromFields({
      issuer: totpUi.issuer?.value || '',
      account: totpUi.account?.value || '',
      secret: totpUi.secret?.value || '',
    });
    if (!entry) {
      setTotpAddError('Enter a valid authenticator secret or otpauth URL.');
      totpUi.secret?.focus();
      return;
    }
    try {
      await NotesTotp.generate(entry);
    } catch (err) {
      setTotpAddError('That secret could not generate a code.');
      return;
    }
    const result = NotesStore.addTotpAccount(entry);
    hideTotpAddDialog();
    refreshTotpVault();
    toast(result.created ? 'Added account' : 'That account is already in 2FA');
  }

  function isDuplicateUploadError(message) {
    return /^Already (attached|saved)/.test(String(message || ''));
  }

  function showAlertDialog(message, { title = 'Notice', okLabel = 'OK' } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById('confirm-backdrop');
      const dialog = document.getElementById('confirm-dialog');
      const titleEl = document.getElementById('confirm-title');
      const messageEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');
      if (!backdrop || !dialog || !titleEl || !messageEl || !okBtn || !cancelBtn) {
        window.alert(String(message || title));
        resolve(true);
        return;
      }
      titleEl.textContent = title;
      messageEl.textContent = message;
      okBtn.textContent = okLabel;
      okBtn.classList.remove('danger');
      cancelBtn.hidden = true;
      backdrop.hidden = false;
      dialog.hidden = false;
      const cleanup = () => {
        backdrop.hidden = true;
        dialog.hidden = true;
        cancelBtn.hidden = false;
        okBtn.removeEventListener('click', onOk);
        backdrop.removeEventListener('click', onOk);
        document.removeEventListener('keydown', onKey);
        resolve(true);
      };
      const onOk = () => cleanup();
      const onKey = (event) => {
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault();
          onOk();
        }
      };
      okBtn.addEventListener('click', onOk);
      backdrop.addEventListener('click', onOk);
      document.addEventListener('keydown', onKey);
      okBtn.focus();
    });
  }

  function showDuplicateDialog(duplicate, file, targetNoteId, messageOverride) {
    const info = duplicate
      ? NotesStore.describeDuplicateAttachment(duplicate, file, targetNoteId)
      : {
        message: String(messageOverride || 'This file is already saved.'),
        noteId: null,
        trashed: false,
        archived: false,
      };
    if (!info.noteId) {
      return showAlertDialog(info.message, { title: 'Duplicate file', okLabel: 'OK' });
    }
    return confirmAction(info.message, {
      title: 'Duplicate file',
      confirmLabel: 'Open note',
      cancelLabel: 'OK',
    }).then((open) => {
      if (!open) return false;
      if (info.trashed) setFilter('trash');
      else if (info.archived) setFilter('archived');
      else setFilter('all');
      renderNotes();
      openNote(info.noteId);
      return true;
    });
  }

  function formatStorageBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function closeAccountInfoDialog() {
    const backdrop = document.getElementById('account-info-backdrop');
    const dialog = document.getElementById('account-info-dialog');
    if (backdrop) backdrop.hidden = true;
    if (dialog) dialog.hidden = true;
  }

  function setAccountInfoRow(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function applyAccountInfoData(account) {
    if (!account) return;
    const plan = String(account.plan || 'pro').toLowerCase();
    const label = account.plan_label || (plan === 'pro' ? 'Pro' : 'Basic');
    setAccountInfoRow('account-info-email', account.email || '—');
    setAccountInfoRow('account-info-plan', label);
    const used = Number(account.storage_used_bytes) || 0;
    const quota = account.storage_quota_effective;
    const quotaText = quota ? formatPlanBytes(quota) : 'Unlimited';
    setAccountInfoRow('account-info-storage', `${formatPlanBytes(used)} of ${quotaText}`);
    setAccountInfoRow('account-info-2fa', account.totp_enabled ? 'Enabled' : 'Off');
    setAccountInfoRow('account-info-passkeys', account.webauthn_enabled ? 'Registered' : 'None');
    if (NotesStore.isUnlocked()) {
      const notes = NotesStore.listNotes().filter((n) => !n.content.trashed && !n.content.archived);
      setAccountInfoRow('account-info-notes', String(notes.length));
      setAccountInfoRow('account-info-attachments', String(NotesStore.listAttachments().length));
      setAccountInfoRow('account-info-tags', String(NotesStore.listTags().length));
    } else {
      setAccountInfoRow('account-info-notes', 'Unlock the vault');
      setAccountInfoRow('account-info-attachments', '—');
      setAccountInfoRow('account-info-tags', '—');
    }
  }

  async function showAccountInfo() {
    const backdrop = document.getElementById('account-info-backdrop');
    const dialog = document.getElementById('account-info-dialog');
    const errEl = document.getElementById('account-info-error');
    if (!backdrop || !dialog) return;
    closeSettings(true);
    if (errEl) errEl.hidden = true;
    const cached = NotesStore.cachedAccount?.();
    if (cached?.email) applyAccountInfoData(cached);
    else {
      setAccountInfoRow('account-info-email', 'Loading…');
      setAccountInfoRow('account-info-plan', 'Loading…');
      setAccountInfoRow('account-info-storage', 'Loading…');
      setAccountInfoRow('account-info-notes', '—');
      setAccountInfoRow('account-info-attachments', '—');
      setAccountInfoRow('account-info-tags', '—');
      setAccountInfoRow('account-info-2fa', '—');
      setAccountInfoRow('account-info-passkeys', '—');
    }
    backdrop.hidden = false;
    dialog.hidden = false;
    document.getElementById('account-info-close')?.focus();
    try {
      const account = await NotesStore.loadAccount();
      applyAccountInfoData(account);
      renderPlanUi(account);
    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = NotesStore.isProbablyOffline?.(err)
          ? 'Could not reach the notes server. Join home Wi‑Fi or WireGuard.'
          : (err.message || 'Could not load account info');
      }
    }
  }

  function confirmAction(message, {
    title = 'Confirm',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById('confirm-backdrop');
      const dialog = document.getElementById('confirm-dialog');
      const titleEl = document.getElementById('confirm-title');
      const messageEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');
      if (!backdrop || !dialog || !titleEl || !messageEl || !okBtn || !cancelBtn) {
        resolve(window.confirm(String(message || title)));
        return;
      }
      cancelBtn.hidden = false;
      titleEl.textContent = title;
      messageEl.textContent = message;
      okBtn.textContent = confirmLabel;
      cancelBtn.textContent = cancelLabel;
      okBtn.classList.toggle('danger', !!danger);
      backdrop.hidden = false;
      dialog.hidden = false;
      const cleanup = (value) => {
        backdrop.hidden = true;
        dialog.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
      cancelBtn.focus();
    });
  }

  NotesStore.setCsrf(ui.csrf || NotesStore.csrf());
  window.notesNetworkReachable = () => networkReachable;
  NotesStore.setSaveStatusCallback((text, isError) => {
    ui.saveStatus.textContent = text;
    ui.saveStatus.classList.toggle('error', !!isError);
  });
  function isPhoneShell() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 860px)').matches;
  }

  function formatSyncTime(unixSeconds) {
    const at = new Date(Number(unixSeconds) * 1000);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= 0) return '';
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (isPhoneShell()) {
      const today = new Date();
      if (at.toDateString() === today.toDateString()) return time;
    }
    const date = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${date} · ${time}`;
  }

  function displaySyncPhase(phase) {
    const last = Number(NotesStore.state.lastSync) || 0;
    if ((phase === 'idle' || !phase) && last > 0) return 'ok';
    return phase || 'idle';
  }

  function refreshSyncMeta({ state, message } = {}) {
    const meta = document.getElementById('sync-meta');
    if (!meta) return;
    const when = formatSyncTime(NotesStore.state.lastSync);
    const rawPhase = state || document.getElementById('sync-indicator')?.dataset.state || 'idle';
    const phase = displaySyncPhase(rawPhase);
    const barWrap = document.getElementById('sync-progress');
    const bar = document.getElementById('sync-progress-bar');
    const pctMatch = String(message || '').match(/(\d+)\s*%/);
    const pct = pctMatch ? Math.max(0, Math.min(100, Number(pctMatch[1]))) : (phase === 'syncing' ? 1 : 0);
    const syncBtn = document.getElementById('btn-sync-now');
    if (barWrap && bar) {
      const showBar = phase === 'syncing';
      barWrap.hidden = !showBar;
      if (showBar) {
        bar.style.width = `${Math.max(2, pct)}%`;
        barWrap.setAttribute('aria-valuenow', String(pct));
      } else {
        bar.style.width = '0%';
      }
    }
    if (syncBtn) {
      syncBtn.dataset.state = phase;
      syncBtn.setAttribute('data-state', phase);
      const showSyncing = phase === 'syncing' && isVaultReadyForSync();
      syncBtn.classList.toggle('is-syncing', showSyncing);
      if (phase === 'syncing') {
        syncBtn.textContent = showSyncing
          ? (pctMatch ? `Sync ${pct}%` : 'Syncing…')
          : 'Sync';
      } else if (phase === 'ok' && when) {
        syncBtn.textContent = 'Synced';
      } else if (phase === 'offline') {
        syncBtn.textContent = 'Offline';
      } else {
        syncBtn.textContent = 'Sync';
      }
    }
    if (phase === 'syncing') {
      if (!isVaultReadyForSync()) return;
      meta.textContent = isPhoneShell() && pctMatch
        ? `${pct}%`
        : (message || (pctMatch ? `Downloading… ${pct}%` : 'Syncing…'));
      if (/Downloading/i.test(String(message || ''))) {
        const countMatch = String(message || '').match(/\((\d+)\/(\d+)\)/);
        beginVaultPull(countMatch ? Number(countMatch[2]) || 0 : vaultPullExpected);
      }
      if (loginProgressActive && pctMatch) {
        const syncPct = 84 + Math.round((pct / 100) * 15);
        setLoginProgressTarget('sync', pct, 100, syncPct);
      } else if (loginProgressActive) {
        setLoginProgressTarget('sync', 0, 1);
      }
      if (/page|Downloading|%/i.test(String(message || ''))) {
        try {
          scheduleVaultPullRender();
          updateEmptyStateVisibility();
        } catch (err) {
          /* UI may not be ready during early boot */
        }
      }
      return;
    }
    if (phase === 'offline') {
      meta.textContent = when ? `Offline · last ${when}` : 'Offline';
      return;
    }
    if (phase === 'error') {
      endVaultPull();
      meta.textContent = when ? `Sync failed · last ${when}` : (message || 'Sync failed');
      return;
    }
    if (phase === 'pending') {
      meta.textContent = when ? `Waiting · last ${when}` : 'Waiting to sync';
      return;
    }
    if (phase === 'ok') endVaultPull();
    meta.textContent = when ? `Synced ${when}` : 'Not synced yet';
  }

  function setSyncIndicator({ state, message } = {}) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    const phase = displaySyncPhase(state || 'idle');
    el.dataset.state = phase;
    document.body.classList.toggle('is-offline', phase === 'offline');
    const when = formatSyncTime(NotesStore.state.lastSync);
    const labels = {
      idle: 'Tap to sync',
      syncing: message || 'Syncing…',
      ok: when ? `Synced ${when} — tap to refresh` : 'Synced — tap to refresh',
      pending: 'Waiting to sync',
      offline: 'Offline — changes stay on this phone',
      error: message || 'Sync failed',
    };
    el.title = labels[phase] || message || 'Sync';
    el.setAttribute('aria-label', el.title);
    refreshSyncMeta({ state: phase, message });
  }
  NotesStore.setSyncStatusCallback(setSyncIndicator);
  NotesStore.emitSync('idle');
  let vaultPullActive = false;
  let vaultPullExpected = 0;
  let vaultPullRenderTimer = 0;
  let deferredOpenNoteId = null;

  function isEditorOpen() {
    return !!(currentId && ui.editor && !ui.editor.hidden);
  }

  function deferOpenNoteHeavyWork(noteId) {
    if (!noteId) return;
    deferredOpenNoteId = noteId;
  }

  function runDeferredOpenNoteHeavyWork() {
    const id = deferredOpenNoteId;
    deferredOpenNoteId = null;
    if (!id || currentId !== id || !NotesStore.get(id)) return;
    const note = NotesStore.get(id);
    if (note?.content?.locked && !unlockedNotes.has(id)) return;
    renderAttachments(id);
    if (isEditorOpen()) applyEditorMode();
    pullNoteOcrFromServer(id).catch(() => {});
  }

  function updateVaultPullHead() {
    const listHead = document.getElementById('note-list-head');
    const listTitle = document.getElementById('note-list-title');
    const listCount = document.getElementById('note-list-count');
    const live = NotesStore.listNotes().filter((n) => !n.content?.trashed).length;
    if (listHead) listHead.hidden = false;
    if (listTitle) listTitle.textContent = 'Notes';
    if (listCount) {
      listCount.textContent = vaultPullExpected > live
        ? `${live} of ${vaultPullExpected} notes…`
        : `${live} note${live === 1 ? '' : 's'}`;
    }
  }

  function beginVaultPull(expectedTotal = 0) {
    if (!NotesStore.isUnlocked()) return;
    revealAppShell();
    vaultPullActive = true;
    vaultPullExpected = Math.max(vaultPullExpected, Number(expectedTotal) || 0);
    document.body.classList.add('vault-pulling');
    if (ui.empty) ui.empty.hidden = true;
    lastNotesRenderKey = '';
    scheduleVaultPullRender(true);
  }

  function endVaultPull() {
    if (!vaultPullActive) return;
    vaultPullActive = false;
    vaultPullExpected = 0;
    document.body.classList.remove('vault-pulling');
    clearTimeout(vaultPullRenderTimer);
    vaultPullRenderTimer = 0;
    lastNotesRenderKey = '';
    runDeferredOpenNoteHeavyWork();
    renderNotes();
    updateEmptyStateVisibility();
    renderVaultStats();
    if (currentId) {
      const activeNote = NotesStore.get(currentId);
      if (activeNote && activeNote.content?.locked && !unlockedNotes.has(currentId)) {
        const gate = document.getElementById('note-lock-gate');
        if (gate && gate.hidden) {
          openNote(currentId);
        }
      }
    }
  }

  function scheduleVaultPullRender(force = false) {
    if (!vaultPullActive || !NotesStore.isUnlocked()) return;
    const editorOpen = isEditorOpen();
    const tick = () => {
      updateVaultPullHead();
      updateEmptyStateVisibility();
      if (editorOpen) {
        markActiveNoteRow();
        return;
      }
      lastNotesRenderKey = '';
      renderNotesNow();
    };
    if (force) {
      clearTimeout(vaultPullRenderTimer);
      vaultPullRenderTimer = 0;
      tick();
      return;
    }
    if (vaultPullRenderTimer) return;
    vaultPullRenderTimer = setTimeout(() => {
      vaultPullRenderTimer = 0;
      if (!vaultPullActive) return;
      tick();
    }, 150);
  }

  NotesStore.setVaultPullCallbacks({
    begin: (expectedTotal) => beginVaultPull(expectedTotal),
    page: () => scheduleVaultPullRender(true),
    end: () => endVaultPull(),
  });
  NotesStore.setNoteIngestedCallback((uuid, meta) => {
    // Throttled list paint during vault pull — never call renderNotes() per note on iOS.
    scheduleVaultPullRender();
    if (!uuid || vaultPullActive || !meta?.protectionMerged) return;
    const note = NotesStore.get(uuid);
    if (!note) return;
    if (note.content?.locked) unlockedNotes.delete(uuid);
    if (currentId === uuid) {
      if (note.content?.locked && !unlockedNotes.has(uuid)) {
        openNote(uuid);
      } else {
        updateActionButtons(note);
        updateNoteInfoPanel(note);
        setEditorChrome(!!note.content?.locked && !unlockedNotes.has(uuid));
      }
    }
    lastNotesRenderKey = '';
    renderNotes();
  });

  const unlockScreen = document.getElementById('unlock-screen');
  const appShell = document.getElementById('app');
  const unlockForm = document.getElementById('unlock-form');
  const unlockError = document.getElementById('unlock-error');
  const unlockSubmit = document.getElementById('unlock-submit');
  const unlockPassword = document.getElementById('unlock-password');
  let unlockResolver = null;
  let unlockInFlight = null;
  let loginProgressActive = false;
  let deferredUnlockSync = null;
  let unlockGateOpen = false;

  function isVaultReadyForSync() {
    return unlockGateOpen
      && NotesStore.isUnlocked()
      && document.body.classList.contains('unlocked')
      && (!unlockScreen || unlockScreen.hidden);
  }

  function markVaultShellUnlocked() {
    unlockGateOpen = true;
  }

  function markVaultShellLocked() {
    unlockGateOpen = false;
    endVaultPull();
  }
  const loginProgress = {
    displayed: 0,
    target: 0,
    phase: 'kdf',
    raf: 0,
    creep: 0,
  };

  const UNLOCK_PHASE_WEIGHT = {
    kdf: { start: 0, size: 18, label: 'Deriving vault key' },
    decrypt: { start: 18, size: 52, label: 'Opening notes' },
    attachments: { start: 70, size: 14, label: 'Loading attachments' },
    sync: { start: 84, size: 16, label: 'Syncing' },
    done: { start: 100, size: 0, label: 'Ready' },
  };

  function unlockProgressPct(phase, done, total) {
    const spec = UNLOCK_PHASE_WEIGHT[phase] || UNLOCK_PHASE_WEIGHT.decrypt;
    if (phase === 'done') return 100;
    const inner = total > 0 ? Math.min(1, done / total) : (done > 0 ? 1 : 0);
    return Math.min(99, Math.round(spec.start + inner * spec.size));
  }

  function unlockProgressLabel(phase) {
    return (UNLOCK_PHASE_WEIGHT[phase] || UNLOCK_PHASE_WEIGHT.decrypt).label;
  }

  function phaseCeiling(phase) {
    const spec = UNLOCK_PHASE_WEIGHT[phase] || UNLOCK_PHASE_WEIGHT.decrypt;
    return spec.start + spec.size - 1;
  }

  async function yieldToPaint() {
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function renderLoginProgressFrame() {
    const pct = loginProgress.displayed;
    const text = `${unlockProgressLabel(loginProgress.phase)}… ${pct}%`;
    const overlay = document.getElementById('login-progress-overlay');
    const overlayStatus = document.getElementById('login-progress-status');
    const overlayBar = document.getElementById('login-progress-bar');
    const overlayTrack = overlay?.querySelector('.login-progress-track');
    if (overlay) overlay.hidden = false;
    if (overlayStatus) overlayStatus.textContent = text;
    if (overlayBar) overlayBar.style.width = `${Math.max(2, pct)}%`;
    if (overlayTrack) overlayTrack.setAttribute('aria-valuenow', String(pct));
    const pairs = [
      ['unlock-status', 'unlock-progress-bar', 'unlock-progress'],
      ['app-login-status', 'app-login-progress-bar', 'app-login-progress'],
    ];
    for (const [statusId, barId, wrapId] of pairs) {
      const statusEl = document.getElementById(statusId);
      const barEl = document.getElementById(barId);
      const wrapEl = document.getElementById(wrapId);
      if (statusEl) {
        statusEl.textContent = text;
        statusEl.hidden = false;
      }
      if (barEl) barEl.style.width = `${Math.max(2, pct)}%`;
      if (wrapEl) {
        wrapEl.hidden = false;
        wrapEl.setAttribute('aria-valuenow', String(pct));
      }
    }
    if (unlockSubmit && loginProgressActive) {
      unlockSubmit.textContent = `${pct}%`;
      unlockSubmit.disabled = true;
    }
  }

  function ensureLoginProgressAnimation() {
    if (loginProgress.raf) return;
    const step = () => {
      if (!loginProgressActive) {
        loginProgress.raf = 0;
        return;
      }
      if (loginProgress.displayed < loginProgress.target) {
        const gap = loginProgress.target - loginProgress.displayed;
        const inc = gap > 24 ? Math.ceil(gap / 5) : Math.max(1, Math.ceil(gap / 2));
        loginProgress.displayed = Math.min(loginProgress.target, loginProgress.displayed + inc);
        renderLoginProgressFrame();
      }
      loginProgress.raf = requestAnimationFrame(step);
    };
    loginProgress.raf = requestAnimationFrame(step);
  }

  function stopLoginCreep() {
    if (loginProgress.creep) {
      clearInterval(loginProgress.creep);
      loginProgress.creep = 0;
    }
  }

  function startLoginCreep(phase, ceiling) {
    stopLoginCreep();
    const cap = ceiling ?? phaseCeiling(phase);
    loginProgress.creep = window.setInterval(() => {
      if (!loginProgressActive) return;
      if (loginProgress.displayed >= cap) return;
      if (loginProgress.target <= loginProgress.displayed) {
        loginProgress.target = Math.min(cap, loginProgress.displayed + 1);
        ensureLoginProgressAnimation();
      }
    }, 100);
  }

  function setLoginProgressTarget(phase, done, total, pctOverride) {
    if (!loginProgressActive) return;
    loginProgress.phase = phase || loginProgress.phase;
    const next = pctOverride ?? unlockProgressPct(phase, done, total);
    loginProgress.target = Math.max(loginProgress.target, next);
    ensureLoginProgressAnimation();
  }

  function paintLoginProgress(phase, done, total, pctOverride) {
    setLoginProgressTarget(phase, done, total, pctOverride);
    renderLoginProgressFrame();
  }

  function beginLoginProgress() {
    loginProgressActive = true;
    loginProgress.displayed = 0;
    loginProgress.target = 0;
    loginProgress.phase = 'kdf';
    const overlay = document.getElementById('login-progress-overlay');
    if (overlay) overlay.setAttribute('aria-busy', 'true');
    renderLoginProgressFrame();
    startLoginCreep('kdf', phaseCeiling('kdf'));
    setLoginProgressTarget('kdf', 0, 3);
  }

  async function animateLoginProgressTo(pct, ms = 350) {
    const start = loginProgress.displayed;
    const startAt = performance.now();
    return new Promise((resolve) => {
      const tick = (now) => {
        const t = Math.min(1, (now - startAt) / ms);
        loginProgress.displayed = Math.round(start + (pct - start) * t);
        loginProgress.target = Math.max(loginProgress.target, loginProgress.displayed);
        renderLoginProgressFrame();
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  function dismissLoginProgress() {
    stopLoginCreep();
    if (loginProgress.raf) {
      cancelAnimationFrame(loginProgress.raf);
      loginProgress.raf = 0;
    }
    loginProgressActive = false;
    const overlay = document.getElementById('login-progress-overlay');
    if (overlay) {
      overlay.hidden = true;
      overlay.setAttribute('aria-busy', 'false');
    }
    for (const id of ['unlock-progress', 'unlock-status', 'app-login-progress']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    if (unlockSubmit) {
      unlockSubmit.disabled = false;
      unlockSubmit.textContent = 'Unlock';
    }
  }

  async function completeLoginProgress() {
    if (!loginProgressActive) return;
    loginProgress.phase = 'done';
    loginProgress.target = 100;
    loginProgress.displayed = 100;
    renderLoginProgressFrame();
    dismissLoginProgress();
  }

  function resetLoginProgress() {
    dismissLoginProgress();
  }

  unlockSubmit.disabled = false;
  unlockSubmit.textContent = 'Unlock';
  NotesStore.setUnlockProgressCallback(({ done, total, phase }) => {
    if (!loginProgressActive) return;
    paintLoginProgress(phase || 'decrypt', done, total);
  });
  if (skipLogin) {
    const logoutBtn = document.getElementById('btn-logout');
    const unlockOut = document.getElementById('unlock-signout');
    if (logoutBtn) logoutBtn.hidden = true;
    if (unlockOut) unlockOut.hidden = true;
  }

  let bootUnlockPending = false;
  let suppressUnlockScreen = false;

  function requireUnlockAfterUpdate() {
    try {
      return sessionStorage.getItem('notes_require_unlock_after_update') === '1'
        || localStorage.getItem('notes_require_unlock_after_update') === '1';
    } catch (err) {
      return false;
    }
  }

  function markUnlockAfterUpdate() {
    try { sessionStorage.setItem('notes_require_unlock_after_update', '1'); } catch (err) { /* ignore */ }
    try { localStorage.setItem('notes_require_unlock_after_update', '1'); } catch (err) { /* ignore */ }
  }

  function clearUnlockAfterUpdate() {
    try { sessionStorage.removeItem('notes_require_unlock_after_update'); } catch (err) { /* ignore */ }
    try { localStorage.removeItem('notes_require_unlock_after_update'); } catch (err) { /* ignore */ }
  }

  function markTypedUnlockRequired() {
    try { sessionStorage.setItem('notes_require_typed_unlock', '1'); } catch (err) { /* ignore */ }
    try { localStorage.setItem('notes_require_typed_unlock', '1'); } catch (err) { /* ignore */ }
  }

  function clearTypedUnlockRequired() {
    try { sessionStorage.removeItem('notes_require_typed_unlock'); } catch (err) { /* ignore */ }
    try { localStorage.removeItem('notes_require_typed_unlock'); } catch (err) { /* ignore */ }
  }

  function requireTypedUnlock() {
    try {
      if (sessionStorage.getItem('notes_require_typed_unlock') === '1') return true;
      if (localStorage.getItem('notes_require_typed_unlock') === '1') return true;
    } catch (err) {
      /* ignore */
    }
    return requireUnlockAfterUpdate();
  }

  function lockOnUnfocusMode() {
    const VL = window.NotesVaultLock;
    if (VL?.normalizeMode) return VL.normalizeMode(prefs.lockOnUnfocus);
    const v = String(prefs.lockOnUnfocus || 'never');
    if (v === 'immediate' || v === '1min') return v;
    return 'never';
  }

  function canAutoUnlockFromStorage() {
    const cached = NotesStore.cachedAccount();
    const salt = cached.kdf_salt
      || localStorage.getItem('notes_kdf_salt')
      || sessionStorage.getItem('notes_kdf_salt')
      || '';
    // Salt alone is enough to stay on the unlock screen offline (user must type password).
    // Remembered password is optional and never auto-unlocks on app start.
    return !!salt;
  }

  function markRememberedShell(on) {
    if (on) document.documentElement.setAttribute('data-notes-boot', 'app');
    else document.documentElement.removeAttribute('data-notes-boot');
  }

  async function refreshUnlockEmail() {
    const el = document.getElementById('unlock-email');
    if (!el) return;
    try {
      const account = await NotesStore.loadAccount();
      if (account.email) {
        el.textContent = account.email;
        NotesStore.cacheAccount(account);
        return;
      }
    } catch (err) {
      /* offline — use cache */
    }
    const cached = NotesStore.cachedAccount();
    if (cached.email) {
      el.textContent = cached.email;
      return;
    }
    try {
        const saved = localStorage.getItem('notes_email');
      if (saved) el.textContent = saved;
    } catch (err) {
      /* ignore */
    }
  }

  function syncVaultLockUi(unlocked = NotesStore.isUnlocked()) {
    const title = unlocked ? 'Lock vault' : 'Vault locked';
    const label = unlocked ? 'Vault unlocked' : 'Vault locked';
    ['btn-lock-nav', 'btn-lock-head'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.toggle('vault-lock-btn', true);
      btn.classList.toggle('is-unlocked', !!unlocked);
      btn.classList.toggle('is-locked', !unlocked);
      btn.title = title;
      btn.setAttribute('aria-label', label);
      btn.querySelector('.lock-closed')?.toggleAttribute('hidden', !!unlocked);
      btn.querySelector('.lock-open')?.toggleAttribute('hidden', !unlocked);
    });
  }

  function showUnlock(email) {
    if (NotesStore.isUnlocked()) return;
    if (suppressUnlockScreen) return;
    syncVaultLockUi(false);
    markVaultShellLocked();
    markRememberedShell(false);
    document.body.classList.add('locked');
    document.body.classList.remove('unlocked');
    unlockScreen.hidden = false;
    appShell.hidden = true;
    const updateBanner = document.getElementById('app-update-banner');
    if (updateBanner) updateBanner.hidden = true;
    const updating = window.NotesVaultLock?.isAppUpdating
      ? NotesVaultLock.isAppUpdating(document.body, window.__notesUpdateInFlight)
      : !!(document.body.classList.contains('app-updating') || window.__notesUpdateInFlight);
    const hideProgress = window.NotesVaultLock?.hideProgressWhenLocking
      ? NotesVaultLock.hideProgressWhenLocking({ updating })
      : !updating;
    const updateProgress = document.getElementById('app-update-progress');
    if (updateProgress && hideProgress) updateProgress.hidden = true;
    closeSettings(true);
    updateSecureContextHint();
    refreshUnlockEmail().catch(() => {});
    if (email) document.getElementById('unlock-email').textContent = email;
    const firstHint = document.getElementById('unlock-first-hint');
    if (firstHint) {
      let justRegistered = false;
      try { justRegistered = sessionStorage.getItem('notes_just_registered') === '1'; } catch (err) { /* ignore */ }
      firstHint.hidden = !justRegistered;
    }
    const recovery = document.getElementById('unlock-recovery-hint');
    if (recovery) recovery.hidden = !vaultSyncError;
    hideUnlockSessionHint();
    unlockSubmit.disabled = false;
    unlockSubmit.textContent = 'Unlock';
    const toastEl = document.getElementById('toast');
    if (toastEl && (window.NotesVaultLock?.isBackgroundSyncToast?.(toastEl.textContent) || !toastEl.classList.contains('error'))) {
      toastEl.hidden = true;
      toastEl.textContent = '';
    }
    unlockPassword.focus();
  }

  function updateSecureContextHint() {
    const hint = document.getElementById('unlock-secure-hint');
    if (!hint) return;
    if (window.isSecureContext) {
      hint.hidden = true;
      return;
    }
    hint.hidden = false;
  }

  function consumeUnlockGates() {
    clearUnlockAfterUpdate();
    clearTypedUnlockRequired();
    clearUnfocusedAt();
  }

  function showApp() {
    markRememberedShell(true);
    document.body.classList.add('unlocked');
    document.body.classList.remove('locked');
    unlockScreen.hidden = true;
    appShell.hidden = false;
    markVaultShellUnlocked();
    endVaultPull();
    syncVaultLockUi(true);
    scheduleChangePoll();
    closeSettings(true);
    restoreAppTab();
    dismissLoginProgress();
    try { sessionStorage.removeItem('notes_just_registered'); } catch (err) { /* ignore */ }
    try {
      if (history.state?.notesView !== 'editor') {
        history.replaceState({ notesView: 'list' }, '', location.href);
      }
    } catch (err) {
      /* ignore */
    }
  }

  let vaultHydrated = false;
  let unlockDidSync = false;
  let unlockRevealInFlight = null;
  let unlockPrimaryRevealed = false;

  async function paintUnlockUi() {
    refreshSyncMeta();
    if (typeof NotesStore.mergeDuplicateTags === 'function') {
      try {
        NotesStore.mergeDuplicateTags();
      } catch (err) {
        console.warn('duplicate tag merge failed', err);
      }
    }
    pullGlobalPrefs({ render: false });
    renderTags();
    renderNotes();
    applyPrefs();
    updateEmptyStateVisibility();
    renderVaultStats();
    refreshTotpVault({ migrate: false });
    renderPlanUi(NotesStore.cachedAccount());
    vaultHydrated = true;
    // Stay on the note list overview after unlock/hydrate — do not auto-open last note.
    // Email deep links are the exception: open that note as soon as it is decrypted.
    if (!currentId) openPendingDeepLink();
  }

  function revealAppShell() {
    if (!document.body.classList.contains('unlocked')) {
      consumeUnlockGates();
      showApp();
      updateOfflineSetupBanner();
    }
    dismissLoginProgress();
    vaultReady = true;
    showHeroGuideIfNeeded();
  }

  async function revealPrimaryUnlock() {
    if (unlockPrimaryRevealed) return;
    const count = NotesStore.listNotes().length + NotesStore.listTags().length;
    if (count === 0) return;
    unlockPrimaryRevealed = true;
    stopLoginCreep();
    setLoginProgressTarget('decrypt', 1, 1);
    await yieldToPaint();
    await paintUnlockUi();
    revealAppShell();
  }

  async function hydrateVaultUi({ loadLocal = true } = {}) {
    if (loadLocal) {
      try {
        await NotesStore.loadLocal();
      } catch (err) {
        console.warn('local vault load failed', err);
        if (err?.code === 'LOCAL_DECRYPT_FAILED' || err?.code === 'DECRYPT_FAILED' || err?.code === 'DECRYPT_PARTIAL') {
          handleVaultDecryptFailure(err, { relock: false });
        }
      }
    }
    refreshSyncMeta();
    if (typeof NotesStore.mergeDuplicateTags === 'function') {
      try {
        NotesStore.mergeDuplicateTags();
      } catch (err) {
        console.warn('duplicate tag merge failed', err);
      }
    }
    renderTags();
    renderNotes();
    applyPrefs();
    updateEmptyStateVisibility();
    renderVaultStats();
    refreshTotpVault({ migrate: false });
    renderPlanUi(NotesStore.cachedAccount());
    vaultHydrated = true;
    // Stay on the note list overview after unlock/hydrate — do not auto-open last note.
    // Email deep links are the exception: open that note as soon as it is decrypted.
    if (!currentId) openPendingDeepLink();
  }

  function schedulePostUnlockSync(needsReload) {
    if (deferredUnlockSync) return deferredUnlockSync;
    deferredUnlockSync = runPostUnlockSync({ needsReload }).finally(() => {
      deferredUnlockSync = null;
    });
    return deferredUnlockSync;
  }

  async function runPostUnlockSync({ needsReload }) {
    if (typeof NotesStore.finishLoadLocal === 'function') {
      await NotesStore.finishLoadLocal();
    }
    const localNoteCount = NotesStore.listNotes().length;
    const localCipher = typeof NotesStore.localCipherCount === 'function'
      ? await NotesStore.localCipherCount().catch(() => 0)
      : 0;
    const full = !!(needsReload || (localNoteCount === 0 && localCipher === 0));
    revealAppShell();
    if (!isVaultReadyForSync()) return;
    renderTags();
    renderNotes();
    updateEmptyStateVisibility();
    refreshSyncMeta();
    if (full) beginVaultPull(0);
    try {
      await syncNow({ full, quiet: false, force: true });
      unlockDidSync = true;
      refreshSyncMeta();
      renderTags();
      renderNotes();
      updateEmptyStateVisibility();
      renderVaultStats();
      refreshTotpVault({ migrate: true });
    } catch (err) {
      if (err?.code === 'VAULT_LOCKED') return;
      console.warn('unlock sync failed', err);
      if (err?.code === 'DECRYPT_FAILED' || err?.code === 'DECRYPT_PARTIAL') {
        handleVaultDecryptFailure(err, { relock: NotesStore.listNotes().length === 0 });
      } else if (!NotesStore.isProbablyOffline?.(err)) NotesStore.emitSync('error', err.message || 'Sync failed');
      throw err;
    }
  }

  async function finishUnlocked({ skipReveal = false, deferSync = false } = {}) {
    const needsReload = vaultNeedsReload;
    vaultNeedsReload = false;

    if (unlockRevealInFlight) {
      await unlockRevealInFlight;
      if (unlockResolver) {
        const done = unlockResolver;
        unlockResolver = null;
        done(true);
      }
      return;
    }

    unlockRevealInFlight = (async () => {
      try {
        if (skipReveal || unlockPrimaryRevealed) {
          if (!unlockPrimaryRevealed) {
            await hydrateVaultUi({ loadLocal: !NotesStore.state.localReady });
            revealAppShell();
          } else {
            await paintUnlockUi();
          }
        } else {
          await hydrateVaultUi({ loadLocal: !NotesStore.state.localReady });
          revealAppShell();
        }
        setTimeout(() => flushPendingUpdatePrompt(), 1200);
        markJustUnlocked();
        await ensureServerSession({ prompt: false }).catch(() => false);
        schedulePostUnlockSync(needsReload);
      } catch (err) {
        revealAppShell();
        setTimeout(() => flushPendingUpdatePrompt(), 1200);
        if (!NotesStore.isUnlocked() || unlockErrorShouldRelock(err)) throw err;
        console.warn('post-unlock UI hydrate issue', err);
      } finally {
        unlockRevealInFlight = null;
      }
    })();

    const reveal = unlockRevealInFlight;
    if (unlockResolver) {
      const done = unlockResolver;
      unlockResolver = null;
      await reveal.finally(() => done(true));
      return;
    }
    await reveal;
  }

  let vaultSyncError = '';

  function clearSavedUnlockSecrets() {
    try {
      localStorage.removeItem('notes_device_password');
      localStorage.removeItem('notes_test_password');
    } catch (err) {
      /* ignore quota */
    }
  }

  function unlockErrorShouldRelock(err) {
    return err?.status === 401
      || err?.code === 'LOCAL_DECRYPT_FAILED'
      || err?.code === 'DECRYPT_FAILED'
      || /wrong (vault )?password|unreadable/i.test(String(err?.message || ''));
  }

  function repairUnlockShellState() {
    const unlocked = NotesStore.isUnlocked();
    if (unlocked && !isVaultReadyForSync()) {
      // Vault crypto is open but the shell still shows the lock screen — reveal the app.
      showApp();
    }
    return unlocked;
  }

  function abortUnlockAttempt(err) {
    resetLoginProgress();
    const shellOpen = document.body.classList.contains('unlocked')
      && (!unlockScreen || unlockScreen.hidden);
    if (NotesStore.isUnlocked() && unlockErrorShouldRelock(err)) {
      clearSavedUnlockSecrets();
      NotesStore.lock();
      lockVault(err?.message || 'Could not unlock vault.');
      throw err;
    }
    if (!shellOpen && !NotesStore.isUnlocked()) {
      markVaultShellLocked();
      const msg = err?.status === 401
        ? (err.message || 'Wrong password.')
        : (err.message || 'Could not unlock.');
      if (unlockError && msg) {
        unlockError.textContent = msg;
        unlockError.hidden = false;
      }
    } else if (NotesStore.isUnlocked()) {
      repairUnlockShellState();
    }
    throw err;
  }

  function handleVaultDecryptFailure(err, { relock = true } = {}) {
    const skipped = Number(err?.decryptSkipped) || 0;
    const opened = Number(err?.opened) || NotesStore.listNotes().length;
    if (err?.code === 'DECRYPT_PARTIAL') {
      vaultSyncError = err.message || (
        `Only ${opened} item(s) unlocked here. ${skipped} need the vault password from your phone.`
      );
    } else {
      vaultSyncError = err?.message || 'Could not decrypt your notes.';
    }
    renderNotes();
    refreshEmptyStateCopy();
    updateEmptyStateVisibility();
    const hasLocalNotes = NotesStore.listNotes().length > 0;
    // Relock when nothing decrypted — including DECRYPT_PARTIAL with zero opens —
    // so a wrong password cannot leave an empty "unlocked" shell.
    if (relock && !hasLocalNotes && opened <= 0) {
      clearSavedUnlockSecrets();
      const msg = err?.code === 'DECRYPT_PARTIAL'
        ? 'Could not decrypt your notes with this password. Try the vault password from your phone, or Settings → Refresh app cache and unlock again.'
        : 'Wrong vault password. Unlock with the same password you use on your phone.';
      lockVault(msg);
      return;
    }
    toast(vaultSyncError, true);
  }

  function refreshEmptyStateCopy() {
    const title = document.getElementById('empty-state-title');
    const message = document.getElementById('empty-state-message');
    const newBtn = document.getElementById('btn-empty-new');
    const scanBtn = document.getElementById('btn-empty-scan');
    const syncBtn = document.getElementById('btn-empty-sync');
    const dismissBtn = document.getElementById('btn-empty-dismiss');
    const relockBtn = document.getElementById('btn-empty-relock');
    if (!title || !message) return;
    const syncing = document.getElementById('sync-indicator')?.dataset?.state === 'syncing';
    if (syncing && NotesStore.listNotes().length === 0 && !vaultSyncError) {
      title.textContent = 'Downloading your notes';
      message.textContent = 'Notes appear in the list as they arrive. Sync continues in the background — check the progress at the top.';
      if (newBtn) newBtn.hidden = false;
      if (scanBtn) scanBtn.hidden = true;
      if (syncBtn) syncBtn.hidden = true;
      if (dismissBtn) dismissBtn.hidden = false;
      if (relockBtn) relockBtn.hidden = true;
      return;
    }
    if (vaultSyncError) {
      title.textContent = 'Vault password mismatch';
      message.textContent = vaultSyncError;
      if (newBtn) newBtn.hidden = NotesStore.listNotes().length > 0;
      if (scanBtn) scanBtn.hidden = true;
      if (syncBtn) {
        syncBtn.hidden = false;
        syncBtn.textContent = 'Sync notes';
      }
      if (dismissBtn) {
        dismissBtn.hidden = false;
        dismissBtn.textContent = NotesStore.listNotes().length > 0 ? 'Continue with partial vault' : 'Dismiss';
      }
      if (relockBtn) {
        relockBtn.hidden = false;
        relockBtn.textContent = 'Try phone vault password';
      }
      return;
    }
    title.textContent = 'Scan, search, find';
    message.textContent = 'Scan a receipt or document — we read the text on your device so you can search it later. Or sync notes from your phone.';
    if (newBtn) newBtn.hidden = false;
    if (scanBtn) scanBtn.hidden = false;
    if (syncBtn) {
      syncBtn.hidden = false;
      syncBtn.textContent = 'Sync notes';
    }
    if (dismissBtn) dismissBtn.hidden = false;
    if (relockBtn) relockBtn.hidden = true;
  }

  function emptyStateDismissed() {
    try {
      return localStorage.getItem('notes_empty_state_dismissed') === '1'
        || sessionStorage.getItem('notes_empty_state_dismissed') === '1';
    } catch (err) {
      return false;
    }
  }

  function dismissEmptyState() {
    try {
      localStorage.setItem('notes_empty_state_dismissed', '1');
      sessionStorage.setItem('notes_empty_state_dismissed', '1');
    } catch (err) {
      /* ignore quota */
    }
    clearVaultSyncError();
    if (ui.empty) ui.empty.hidden = true;
    updateEmptyStateVisibility();
  }

  function updateEmptyStateVisibility() {
    if (!ui.empty) return;
    if (vaultPullActive) {
      ui.empty.hidden = true;
      return;
    }
    if (currentId) {
      ui.empty.hidden = true;
      return;
    }
    // If notes already synced in, never trap the user behind the error card.
    if (NotesStore.listNotes().length > 0 && !vaultSyncError) {
      ui.empty.hidden = true;
      return;
    }
    if (vaultSyncError) {
      ui.empty.hidden = false;
      refreshEmptyStateCopy();
      return;
    }
    // Once notes are on this device, hide the welcome card so desktop sync
    // is not covered by a create/dismiss dialog.
    if (NotesStore.listNotes().length > 0 || emptyStateDismissed()) {
      ui.empty.hidden = true;
      return;
    }
    ui.empty.hidden = false;
    refreshEmptyStateCopy();
  }

  async function reloadVault() {
    vaultNeedsReload = false;
    await hydrateVaultUi({ loadLocal: true });
    try {
      await NotesStore.sync();
      unlockDidSync = true;
      refreshSyncMeta();
      renderTags();
      renderNotes();
      updateEmptyStateVisibility();
      renderVaultStats();
      if (!currentId) openPendingDeepLink({ final: true });
    } catch (err) {
      console.warn('reload after unlock failed', err);
      if (err?.code === 'DECRYPT_FAILED' || err?.code === 'DECRYPT_PARTIAL') handleVaultDecryptFailure(err);
    }
    if (!document.body.classList.contains('unlocked')) showApp();
    vaultReady = true;
  }

  async function bootstrapServerSession(cached) {
    const data = await NotesStore.api('/api/account/unlock', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 20000,
    });
    NotesStore.cacheAccount({
      email: data.email,
      kdf_salt: data.kdf_salt,
      vault_kdf_version: data.vault_kdf_version,
      csrf: data.csrf,
    });
    if (data.password_changed_at) NotesStore.ackPasswordChanged(data.password_changed_at);
    return data;
  }

  async function checkRemoteVaultPasswordChange(account) {
    if (!account || !NotesStore.remotePasswordChanged?.(account)) return false;
    if (NotesStore.passwordChangeInFlight?.()) return false;

    await NotesStore.prepareForRemotePasswordRotation?.();
    vaultNeedsReload = true;
    if (typeof NotesVaultSecrets !== 'undefined') {
      NotesVaultSecrets.clearSecrets();
      NotesVaultSecrets.clearDevicePassword();
    }
    const msg = 'Vault password was changed on another device. Unlock with your new password — you stay signed in on this browser.';
    vaultSyncError = msg;
    refreshEmptyStateCopy();
    updateEmptyStateVisibility();
    if (NotesStore.isUnlocked()) {
      await lockVault(msg, { skipSync: true });
      return true;
    }
    showUnlock(account.email || NotesStore.cachedAccount().email);
    return true;
  }

  async function serverSessionLooksValid() {
    try {
      await NotesStore.loadAccount();
      return true;
    } catch (err) {
      return false;
    }
  }

  async function checkVaultPasswordOnline(email, password) {
    const clean = String(password || '').trim();
    if (!clean) return { ok: false, wrongPassword: true };
    if (await NotesStore.verifyVaultPassword(clean)) {
      return { ok: true, via: 'local' };
    }
    // Vault key is already derived — a failed IndexedDB decrypt is not a login-password mismatch.
    if (NotesStore.isUnlocked()) {
      return { ok: true, via: 'unlocked' };
    }
    const normalized = String(email || '').trim().toLowerCase();
    if (window.NotesSrpAuth?.verifyVault && normalized) {
      try {
        await NotesSrpAuth.verifyVault(normalized, clean);
        return { ok: true, via: 'server' };
      } catch (err) {
        if (err?.status === 410) {
          return { ok: false, wrongPassword: false, strictZk: true };
        }
        if (err?.status === 401) return { ok: false, wrongPassword: true };
        if (err?.status === 400) return { ok: false, emptyVault: true };
        if (err?.status === 429) return { ok: false, rateLimited: true };
        return { ok: false, offline: true };
      }
    }
    return { ok: false, wrongPassword: true };
  }

  async function repairUnlockWithPassword(email, password, { verifyOnly = false } = {}) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized || !password) return { ok: false };
    if (verifyOnly) return await checkVaultPasswordOnline(normalized, password);

    if (window.NotesSrpAuth?.vaultRecovery) {
      try {
        const data = await NotesSrpAuth.vaultRecovery(normalized, password);
        NotesStore.cacheAccount(data);
        if (data.password_changed_at) NotesStore.ackPasswordChanged(data.password_changed_at);
        return { ok: true, via: 'vault', totpRequired: !!data.totp_required };
      } catch (err) {
        if (err?.status === 401) {
          return { ok: false, wrongPassword: true };
        }
        if (err?.status === 429) return { ok: false, rateLimited: true };
      }
    }
    if (window.NotesSrpAuth?.passwordSignIn) {
      try {
        const data = await NotesSrpAuth.passwordSignIn(normalized, password);
        NotesStore.cacheAccount(data);
        if (data.password_changed_at) NotesStore.ackPasswordChanged(data.password_changed_at);
        const via = data.login_repaired ? 'login' : 'srp';
        return { ok: true, via, totpRequired: !!data.totp_required };
      } catch (err) {
        if (err?.status === 429) return { ok: false, rateLimited: true };
        if (err?.status === 401 || err?.repairExhausted || /invalid credentials/i.test(String(err?.message || ''))) {
          return { ok: false, wrongPassword: true };
        }
      }
    }
    return { ok: false, offline: true };
  }

  /** Refresh HTTP session + CSRF after vault unlock (idle lock clears in-memory login secrets). */
  async function establishServerSessionAfterVaultUnlock(password) {
    const clean = String(password || '').trim();
    const cached = NotesStore.cachedAccount();
    if (clean && typeof NotesVaultSecrets !== 'undefined') {
      NotesVaultSecrets.setAccountPassword(clean);
    }
    if (await ensureServerSession({ prompt: false })) return true;
    if (!clean || !cached?.email) return false;
    try {
      const repaired = await repairUnlockWithPassword(cached.email, clean);
      if (repaired.ok) {
        sessionExpiredAlertShown = false;
        if (repaired.totpRequired) {
          redirectToTotpIfNeeded();
          return false;
        }
        return true;
      }
    } catch (err) {
      /* fall through */
    }
    NotesStore.emitSync('pending', 'Sign in to sync');
    return false;
  }

  async function clearUnreadableLocalCache() {
    if (!NotesStore.clearUnreadableLocal) return;
    try {
      await NotesStore.clearUnreadableLocal({ resetSync: true });
    } catch (err) {
      console.warn('clear unreadable local failed', err);
    }
  }

  function clearVaultSyncError() {
    if (!vaultSyncError) return;
    vaultSyncError = '';
    refreshEmptyStateCopy();
    updateEmptyStateVisibility();
  }

  function consumeSyncAfterLogin() {
    try {
      const pending = sessionStorage.getItem('notes_sync_after_login') === '1';
      if (pending) sessionStorage.removeItem('notes_sync_after_login');
      return pending;
    } catch (err) {
      return false;
    }
  }

  async function verifyAndUnlock(password) {
    if (NotesStore.isUnlocked()) {
      await ensureServerSession().catch(() => false);
      await finishUnlocked();
      return;
    }
    if (unlockInFlight) return unlockInFlight;
    unlockPrimaryRevealed = false;
    beginLoginProgress();
    unlockInFlight = (async () => {
      const clean = String(password || '').trim();
      if (!clean) throw new Error('Enter your password');
      const cached = NotesStore.cachedAccount();
      const salt = cached.kdf_salt;
        if (salt) {
        await NotesStore.unlock(clean, salt);
        stopLoginCreep();
        startLoginCreep('decrypt', phaseCeiling('decrypt'));
        setLoginProgressTarget('decrypt', 0, 1);
        await yieldToPaint();
        const serverCheck = (async () => {
          if (await serverUnreachableNow()) return { offline: true };
          try {
            await bootstrapServerSession(cached);
            return { ok: true };
          } catch (err) {
            return { err };
          }
        })();
        const loadVaultLocal = async () => {
          try {
            const result = await NotesStore.loadLocal({ onPrimaryReady: revealPrimaryUnlock });
            return {
              ...result,
              localAllFailed: !!(result.failed && !result.opened),
            };
          } catch (err) {
            return { opened: 0, failed: 1, cipherOpened: 0, localAllFailed: true };
          }
        };
        let [loadResult, serverResult] = await Promise.all([loadVaultLocal(), serverCheck]);
        let opened = loadResult;
        let localAllFailed = loadResult.localAllFailed;
        let vaultRepairedOnline = false;
        let hadStaleLocalCipher = false;
        if (localAllFailed) {
          hadStaleLocalCipher = true;
          unlockPrimaryRevealed = false;
          const altVersion = NotesStore.state.kdfVersion >= 2 ? 1 : 2;
          try {
            await NotesStore.unlock(clean, salt, { kdfVersion: altVersion });
            loadResult = await loadVaultLocal();
            opened = loadResult;
            localAllFailed = loadResult.localAllFailed;
          } catch (retryErr) {
            opened = { opened: 0, failed: 1, cipherOpened: 0 };
            localAllFailed = true;
          }
        }
        if (localAllFailed) {
          let sessionValid = !!serverResult.ok || await serverSessionLooksValid();
          if (!sessionValid) {
            const repaired = await repairUnlockWithPassword(cached.email, clean);
            if (repaired.wrongPassword) {
              clearSavedUnlockSecrets();
              NotesStore.lock();
              const wrong = new Error('Wrong password.');
              wrong.status = 401;
              throw wrong;
            }
            if (repaired.rateLimited) {
              NotesStore.lock();
              throw new Error('Too many unlock attempts. Wait a few minutes and try again.');
            }
            if (!repaired.ok) {
              NotesStore.lock();
              throw new Error('Could not reach the notes server. Connect to home Wi‑Fi or WireGuard and try again.');
            }
            vaultRepairedOnline = true;
            sessionValid = true;
            serverResult = { ok: true };
            const nextSalt = NotesStore.cachedAccount().kdf_salt || salt;
            await NotesStore.unlock(clean, nextSalt);
          } else {
            const verified = await repairUnlockWithPassword(cached.email, clean, { verifyOnly: true });
            if (verified.wrongPassword && !NotesStore.isUnlocked()) {
              clearSavedUnlockSecrets();
              NotesStore.lock();
              const wrong = new Error(
                'Wrong vault password. Use the same password that unlocks Notes on your phone.',
              );
              wrong.status = 401;
              throw wrong;
            }
            if (verified.rateLimited) {
              NotesStore.lock();
              throw new Error('Too many unlock attempts. Wait a few minutes and try again.');
            }
            if (!verified.ok && !NotesStore.isUnlocked()) {
              NotesStore.lock();
              if (verified.emptyVault) {
                throw new Error('No encrypted notes on the server yet. Create a note on your phone, sync, then unlock here.');
              }
              throw new Error('Could not reach the notes server. Connect to home Wi‑Fi or WireGuard and try again.');
            }
            vaultRepairedOnline = true;
          }
          if (sessionValid) {
            await clearUnreadableLocalCache();
            opened = { opened: 0, failed: 0, cipherOpened: 0 };
            localAllFailed = false;
          }
        }
        const hasLocalVault = (opened.cipherOpened || 0) > 0 || opened.opened > 0;
        const emptyLocal = opened.opened === 0;
        vaultSyncError = '';
        let passwordProven = hasLocalVault || vaultRepairedOnline;
        if (serverResult.offline) {
          if (emptyLocal && !hasLocalVault) {
            NotesStore.lock();
            throw new Error('Connect once online while signed in to unlock an empty device with the vault password.');
          }
          markOfflineUnlockVerified();
        } else if (serverResult.ok) {
          try {
            if (typeof NotesVaultSecrets !== 'undefined') {
              NotesVaultSecrets.setAccountPassword(clean);
            }
          } catch (err) {
            /* ignore */
          }
        } else {
          const err = serverResult.err || new Error('Could not verify password');
          if (err.status === 401 && (await serverSessionLooksValid())) {
            // Already signed in with the login password. Unlock password may
            // be the older phone vault password — allow crypto unlock + sync.
            // Do not persist to device until sync decrypts at least one item.
            vaultSyncError = '';
          } else if (err.status === 401) {
            // Server session expired. Attempt to re-authenticate with the entered password.
            const relogin = await repairUnlockWithPassword(cached.email, clean);
            if (relogin.ok) {
              serverResult = { ok: true };
              vaultSyncError = '';
              passwordProven = true;
              try {
                if (typeof NotesVaultSecrets !== 'undefined') {
                  NotesVaultSecrets.setAccountPassword(clean);
                }
              } catch (e) {
                /* ignore */
              }
            } else if (relogin.wrongPassword) {
              if (hasLocalVault || opened.cipherOpened > 0) {
                vaultSyncError = 'Vault unlocked on this device. Sign in with your account password to sync.';
                passwordProven = true;
                serverResult = { ok: true };
                NotesStore.emitSync('pending', 'Sign in to sync');
              } else {
                NotesStore.lock();
                const wrong = new Error(
                  'Could not refresh your sign-in session with this password. Sign out, sign in with your account password, then unlock with your vault password (they can differ).',
                );
                wrong.status = 401;
                throw wrong;
              }
            } else if (!hasLocalVault) {
              NotesStore.lock();
              throw err;
            } else {
              vaultSyncError = 'Unlocked on this device. Sign in again or open Settings → Change vault password if sync stays stuck.';
              passwordProven = true;
            }
          } else if (!hasLocalVault) {
            NotesStore.lock();
            throw err;
          } else {
            vaultSyncError = 'Unlocked on this device. Sign in again or open Settings → Change vault password if sync stays stuck.';
            passwordProven = true;
          }
        }
        if (skipLogin) {
          try {
            localStorage.setItem('notes_test_password', clean);
          } catch (e) {
            /* ignore quota */
          }
        }
        if (!unlockPrimaryRevealed) {
          stopLoginCreep();
          setLoginProgressTarget('decrypt', 1, 1);
          await yieldToPaint();
        }
        const canProveViaSync = !hasLocalVault
          && !hadStaleLocalCipher
          && (serverResult.ok || serverResult.err?.status === 401);
        if (!passwordProven) {
          const openedNow = NotesStore.listNotes().length + NotesStore.listTags().length;
          if (openedNow > 0 || unlockDidSync) {
            passwordProven = true;
          } else if (canProveViaSync) {
            // Fresh device with an empty cache — sync will fetch ciphertext to decrypt.
            passwordProven = true;
          } else {
            const repaired = await repairUnlockWithPassword(cached.email, clean);
            if (repaired.ok) {
              passwordProven = true;
              vaultRepairedOnline = true;
              serverResult = { ok: true };
              await clearUnreadableLocalCache();
            } else if (repaired.wrongPassword) {
              clearSavedUnlockSecrets();
              NotesStore.lock();
              const wrong = new Error(
                'Wrong vault password. Use the same password that unlocks Notes on your phone.',
              );
              wrong.status = 401;
              throw wrong;
            } else if (repaired.rateLimited) {
              NotesStore.lock();
              throw new Error('Too many unlock attempts. Wait a few minutes and try again.');
            } else {
              NotesStore.lock();
              throw new Error('Could not reach the notes server. Connect to home Wi‑Fi or WireGuard and try again.');
            }
          }
        }
        await establishServerSessionAfterVaultUnlock(clean);
        await finishUnlocked({ skipReveal: unlockPrimaryRevealed });
        if (passwordProven) persistDevicePassword(clean);
        return;
      }
      const data = await bootstrapServerSession(cached);
      if (typeof NotesVaultSecrets !== 'undefined') {
        NotesVaultSecrets.setAccountPassword(clean);
      }
      await NotesStore.unlock(clean, data.kdf_salt);
      stopLoginCreep();
      startLoginCreep('decrypt', phaseCeiling('decrypt'));
      setLoginProgressTarget('decrypt', 0, 1);
      await yieldToPaint();
      persistDevicePassword(clean);
      if (skipLogin) {
        try {
          localStorage.setItem('notes_test_password', clean);
        } catch (e) {
          /* ignore quota */
        }
      }
      await establishServerSessionAfterVaultUnlock(clean);
      await finishUnlocked();
    })();
    try {
      await unlockInFlight;
    } catch (err) {
      abortUnlockAttempt(err);
    } finally {
      unlockInFlight = null;
    }
  }

  async function submitUnlockForm() {
    unlockError.hidden = true;
    unlockSubmit.disabled = true;
    unlockSubmit.textContent = 'Unlocking…';
    try {
      await verifyAndUnlock(unlockPassword.value);
      repairUnlockShellState();
      if (NotesStore.isUnlocked() && !isVaultReadyForSync()) showApp();
    } catch (err) {
      unlockError.textContent =
        err.status === 401
          ? (err.message || 'Wrong password.')
          : err.message || 'Could not unlock.';
      unlockError.hidden = false;
      const recovery = document.getElementById('unlock-recovery-hint');
      if (recovery) recovery.hidden = false;
      unlockSubmit.disabled = false;
      unlockSubmit.textContent = 'Unlock';
    }
  }

  unlockForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopPropagation();
    submitUnlockForm().catch(() => {});
  });

  const SIGN_OUT_WARNING = (
    'All notes, attachments, and vault data on this device will be deleted. '
    + 'Your encrypted data stays on the DeeperGuard server and will download again when you sign back in.'
  );

  async function clearLocalVaultAndLeave(next = '/login') {
    try {
      NotesStore.lock();
    } catch (err) {
      /* ignore */
    }
    clearSavedUnlockSecrets();
    rememberOpen(null);
    try {
      if (typeof NotesStore.clearDeviceData === 'function') {
        await NotesStore.clearDeviceData();
      }
    } catch (err) {
      /* ignore */
    }
    try {
      localStorage.removeItem('notes_email');
    } catch (err) {
      /* ignore */
    }
    try {
      sessionStorage.clear();
    } catch (err) {
      /* ignore */
    }
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (err) {
      /* ignore */
    }
    location.replace(next);
  }

  async function signOutCompletely() {
    try {
      await NotesStore.flush();
    } catch (err) {
      /* still leave */
    }
    try {
      await NotesStore.api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch (err) {
      /* still leave */
    }
    await clearLocalVaultAndLeave('/login');
  }

  let remoteWipeStarted = false;
  let remoteWipePromise = null;
  let remoteRevokeTimer = 0;

  function isSessionRevokedError(err) {
    return !!(err && (err.code === 'session_revoked' || err.message === 'session revoked'));
  }

  async function wipeAfterRemoteSignOut() {
    if (remoteWipeStarted && remoteWipePromise) return remoteWipePromise;
    remoteWipeStarted = true;
    try { NotesStore.setCsrf(''); } catch (err) { /* ignore */ }
    if (typeof NotesVaultSecrets !== 'undefined') {
      try { NotesVaultSecrets.clearSecrets(); } catch (err) { /* ignore */ }
      try { NotesVaultSecrets.clearDevicePassword(); } catch (err) { /* ignore */ }
    }
    remoteWipePromise = clearLocalVaultAndLeave('/login?reason=signed-out');
    return remoteWipePromise;
  }

  async function checkRemoteRevocation() {
    if (remoteWipeStarted) return;
    try {
      await NotesStore.api('/api/account', { timeoutMs: 4000 });
    } catch (err) {
      if (isSessionRevokedError(err)) await wipeAfterRemoteSignOut();
    }
  }

  function startRemoteRevokeWatch() {
    if (remoteRevokeTimer) return;
    checkRemoteRevocation().catch(() => {});
    remoteRevokeTimer = window.setInterval(() => {
      checkRemoteRevocation().catch(() => {});
    }, 10000);
  }

  async function requestSignOut() {
    const ok = await confirmAction(SIGN_OUT_WARNING, {
      title: 'Sign out?',
      confirmLabel: 'Sign out',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    await signOutCompletely();
  }

  document.getElementById('unlock-signout').addEventListener('click', () => {
    requestSignOut().catch(() => location.replace('/login'));
  });

  document.getElementById('unlock-clear-saved')?.addEventListener('click', () => {
    clearSavedUnlockSecrets();
    try {
      localStorage.removeItem('notes_offline_unlock_verified');
    } catch (err) {
      /* ignore */
    }
    NotesStore.lock();
    unlockPassword.value = '';
    unlockError.hidden = false;
    unlockError.textContent = 'Saved password cleared. Enter your vault password below.';
    refreshUnlockEmail().catch(() => {});
    unlockPassword.focus();
  });

  async function ensureUnlocked() {
    // Vault password stays in memory only; same-tab refetch uses boot unlock flag.
    bootUnlockPending = true;
    let bootSuppress = false;
    try {
      let allowBootUnlock = false;
      try {
        allowBootUnlock = sessionStorage.getItem('notes_allow_boot_unlock') === '1';
        if (allowBootUnlock) sessionStorage.removeItem('notes_allow_boot_unlock');
        if (!allowBootUnlock) sessionStorage.removeItem('notes_user_requested_update');
      } catch (err) {
        allowBootUnlock = false;
      }
      // Update / leave-app lock must stay on the vault lock screen — remembered
      // password / skip-login must not auto-unlock across a version refresh.
      const hiddenAt = readUnfocusedAt();
      const forceLockAfterUpdate = window.NotesVaultLock?.shouldShowLockScreenOnBoot
        ? NotesVaultLock.shouldShowLockScreenOnBoot({
          requireUpdate: requireUnlockAfterUpdate(),
          requireTyped: requireTypedUnlock(),
          lockMode: lockOnUnfocusMode(),
          unfocusedAt: hiddenAt,
          now: Date.now(),
        })
        : requireTypedUnlock();
      if (forceLockAfterUpdate) {
        allowBootUnlock = false;
        markTypedUnlockRequired();
      }
      if (allowBootUnlock && typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.consumeBootPassword) {
        await NotesVaultSecrets.consumeBootPassword();
      }
      try { sessionStorage.removeItem('notes_boot_password_ready'); } catch (err) { /* ignore */ }
      await refreshDevicePasswordCache();
      let sessionPassword = '';
      try {
        sessionPassword = forceLockAfterUpdate ? '' : ((typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getVaultPassword()) || '');
      } catch (err) {
        sessionPassword = '';
      }
      const cached = NotesStore.cachedAccount();
      const bootSalt = cached.kdf_salt
        || localStorage.getItem('notes_kdf_salt')
        || sessionStorage.getItem('notes_kdf_salt')
        || '';
      const savedPassword = forceLockAfterUpdate ? '' : savedUnlockPassword();
      const autoUnlockPassword = sessionPassword || savedPassword;
      const mayAutoUnlock = !forceLockAfterUpdate && !!(autoUnlockPassword && bootSalt);
      if (mayAutoUnlock) {
        bootSuppress = true;
        suppressUnlockScreen = true;
        markRememberedShell(true);
      } else {
        markRememberedShell(false);
        NotesStore.lock();
      }
      if (NotesStore.isUnlocked()) {
        showApp();
        return true;
      }
      if (!skipLogin) {
        try {
          const remoteAccount = await NotesStore.loadAccount();
          if (await checkRemoteVaultPasswordChange(remoteAccount)) {
            bootSuppress = false;
            suppressUnlockScreen = false;
            markRememberedShell(false);
            return new Promise((resolve) => {
              unlockResolver = resolve;
            });
          }
        } catch (err) {
          if (!NotesStore.isProbablyOffline(err) && err?.status !== 401 && err?.status !== 403) {
            /* keep booting offline */
          }
        }
      }
      if (mayAutoUnlock && autoUnlockPassword && bootSalt) {
        try {
          await verifyAndUnlock(autoUnlockPassword);
          return true;
        } catch (err) {
          if (skipLogin) {
            try {
              localStorage.removeItem('notes_test_password');
            } catch (e) {
              /* ignore */
            }
          }
        }
      }
      let account = cached;
      try {
        account = await NotesStore.loadAccount();
        if (await checkRemoteVaultPasswordChange(account)) {
          bootSuppress = false;
          suppressUnlockScreen = false;
          markRememberedShell(false);
          return new Promise((resolve) => {
            unlockResolver = resolve;
          });
        }
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          account = NotesStore.cachedAccount();
          if (NotesStore.isUnlocked()) {
            showApp();
            return true;
          }
          if (await ensureServerSession({ prompt: false }).catch(() => false)) {
            try {
              account = await NotesStore.loadAccount();
            } catch (loadErr) {
              account = NotesStore.cachedAccount();
            }
          } else if (!skipLogin && !canAutoUnlockFromStorage()) {
            location.replace(loginUrlWithDeepLink());
            return false;
          }
        } else if (!NotesStore.isProbablyOffline(err) && err.status && err.status !== 0 && err.status !== 404) {
          throw err;
        } else {
          account = NotesStore.cachedAccount();
        }
      }
      if (NotesStore.isUnlocked()) {
        showApp();
        return true;
      }
      const savedSalt = (account && account.kdf_salt) || NotesStore.cachedAccount().kdf_salt;
      // Ensure no stale session password remains while the lock screen is up.
      try {
        if (typeof NotesVaultSecrets !== 'undefined') {
          NotesVaultSecrets.clearSecrets();
        }
        sessionStorage.removeItem('notes_unlocked');
      } catch (err) {
        /* ignore */
      }
      if (!savedSalt) {
        showUnlock(account && account.email);
        unlockError.hidden = false;
        unlockError.textContent = 'Connect once over HTTPS on the LAN or WireGuard to unlock offline.';
        return new Promise((resolve) => {
          unlockResolver = resolve;
        });
      }
      showUnlock(account && account.email);
      return new Promise((resolve) => {
        unlockResolver = resolve;
      });
    } finally {
      bootUnlockPending = false;
      if (bootSuppress) suppressUnlockScreen = false;
    }
  }

  function tagMap() {
    const tags = NotesStore.listTags();
    const key = tags.map((t) => `${t.uuid}:${t.content?.updated_at || ''}:${t.content?.title || ''}`).join('|');
    if (tagMap._cache && tagMap._cache.key === key) return tagMap._cache.map;
    const map = new Map(tags.map((t) => [t.uuid, t]));
    tagMap._cache = { key, map };
    return map;
  }

  function invalidateTagMap() {
    tagMap._cache = null;
  }

  function renderTagColorBar() {
    const bar = document.getElementById('tag-color-bar');
    if (!bar) return;
    if (!currentTag) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    const tag = NotesStore.get(currentTag);
    if (!tag) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    bar.hidden = false;
    bar.innerHTML = `
      <span class="tag-color-label">Color</span>
      <div class="tag-colors">
        ${TAG_COLORS.map((color) => {
          const on = (tag.content.color || '#4f8cff') === color ? 'active' : '';
          return `<button type="button" class="tag-color ${on}" data-tag-color="${color}" style="background:${color}" aria-label="Set tag color"></button>`;
        }).join('')}
      </div>
      <button type="button" class="btn ghost sm" data-tag-rename="${escapeAttr(currentTag)}">Rename</button>
    `;
    bar.querySelectorAll('[data-tag-color]').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        NotesStore.setTagColor(currentTag, swatch.dataset.tagColor);
        invalidateTagMap();
        renderTags();
        if (currentId) renderTagBar(NotesStore.get(currentId));
      });
    });
    bar.querySelector('[data-tag-rename]')?.addEventListener('click', () => beginRenameTag(currentTag));
  }

  function bindTagLongPress(btn, uuid) {
    const clear = () => {
      if (tagPressTimer) {
        clearTimeout(tagPressTimer);
        tagPressTimer = null;
      }
    };
    const start = () => {
      clear();
      tagPressTimer = setTimeout(() => {
        tagPressTimer = null;
        beginRenameTag(uuid);
      }, 520);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', clear);
    btn.addEventListener('pointerleave', clear);
    btn.addEventListener('pointercancel', clear);
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      beginRenameTag(uuid);
    });
  }

  function renderTags() {
    const tags = NotesStore.listTags();
    ui.tagList.innerHTML = tags
      .map((t) => {
        const count = NotesStore.noteCountForTag(t.uuid);
        const active = currentTag === t.uuid ? 'active' : '';
        const color = safeColor(t.content.color);
        return `<div class="tag-row" data-tag-row="${escapeAttr(t.uuid)}">
          <div class="tag-chip-wrap ${active}" style="--tag-color:${color}">
            <button type="button" class="tag-chip ${active}" data-tag="${escapeAttr(t.uuid)}">
              <span class="tag-dot"></span>
              <span class="tag-name"># ${escapeHtml(t.content.title)}</span>
              <span class="tag-count">${count}</span>
            </button>
            <button type="button" class="tag-remove" data-tag-remove="${escapeAttr(t.uuid)}" aria-label="Delete tag ${escapeAttr(t.content.title)}">×</button>
          </div>
        </div>`;
      })
      .join('');
    ui.tagList.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentTag = currentTag === btn.dataset.tag ? null : btn.dataset.tag;
        if (currentTag && (currentFilter === 'untagged' || currentFilter === 'trash')) {
          setFilter('all');
        }
        applyTagSection();
        renderTags();
        renderNotes();
      });
      bindTagLongPress(btn, btn.dataset.tag);
    });
    ui.tagList.querySelectorAll('[data-tag-remove]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteCurrentTag(btn.dataset.tagRemove);
      });
    });
    renderTagColorBar();
    renderSearchFilterTags();
  }

  function hideTagComposer() {
    const composer = document.getElementById('tag-composer');
    const input = document.getElementById('tag-name-input');
    if (composer) composer.hidden = true;
    if (input) input.value = '';
  }

  function isNoteProtected(note) {
    const c = note?.content || note;
    if (!c) return false;
    if (typeof NotesSearch !== 'undefined' && typeof NotesSearch.noteIsProtected === 'function') {
      return NotesSearch.noteIsProtected(c);
    }
    return !!(c.locked || c.prevent_edit);
  }

  function trashedNotes() {
    return NotesStore.listNotes().filter((n) => n.content.trashed);
  }

  function updateTrashToolbar(count = null) {
    const bar = document.getElementById('trash-toolbar');
    const meta = document.getElementById('trash-toolbar-meta');
    const btn = document.getElementById('btn-empty-trash-list');
    if (!bar || !meta || !btn) return;
    const show = currentFilter === 'trash';
    bar.hidden = !show;
    if (!show) return;
    const total = typeof count === 'number' ? count : trashedNotes().length;
    meta.textContent = total
      ? `${total} note${total === 1 ? '' : 's'} in trash`
      : 'Trash is empty';
    btn.disabled = total === 0;
  }

  async function emptyTrash() {
    const total = trashedNotes().length;
    if (!total) {
      toast('Trash is already empty');
      return;
    }
    if (!(await confirmAction(`Permanently delete ${total} note${total === 1 ? '' : 's'} in trash?`, {
      title: 'Empty trash',
      confirmLabel: 'Empty trash',
      danger: true,
    }))) return;
    let protectedCount = 0;
    for (const note of trashedNotes()) {
      if (isNoteProtected(note)) {
        protectedCount += 1;
        continue;
      }
      cancelNoteReminder(note.uuid);
      NotesStore.remove(note.uuid);
    }
    if (currentId && !NotesStore.get(currentId)) closeEditor();
    renderNotes();
    if (protectedCount > 0) {
      toast('Protected notes were not deleted', true);
    } else {
      toast('Trash emptied');
    }
  }

  function setFilter(name) {
    if (name === 'documents' && currentFilter !== 'documents') {
      filterBeforeFiles = currentFilter || 'all';
    }
    currentFilter = name;
    if (ui.filters) {
      ui.filters.querySelectorAll('.filter').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.filter === name);
      });
    }
    const select = document.getElementById('filter-select');
    if (select && select.value !== name) select.value = name;
    if (name === 'untagged' || name === 'trash' || name === 'archived') {
      currentTag = null;
      applyTagSection();
    }
    updateTrashToolbar();
    if (appTab !== '2fa') {
      const nextTab = name === 'documents' ? 'files' : 'notes';
      if (appTab !== nextTab) {
        appTab = nextTab;
        root.dataset.appTab = appTab;
        try { sessionStorage.setItem('notes_app_tab', appTab); } catch (err) { /* ignore */ }
        syncAppTabButtons(appTab);
      }
    }
  }

  function beginRenameTag(uuid) {
    const bar = document.getElementById('tag-color-bar');
    if (bar) bar.hidden = true;
    const row = ui.tagList.querySelector(`[data-tag-row="${uuid}"]`);
    const tag = NotesStore.get(uuid);
    if (!row || !tag) return;
    const input = document.createElement('input');
    input.className = 'tag-rename-input';
    input.value = tag.content.title || '';
    input.maxLength = 80;
    input.setAttribute('aria-label', 'Rename tag');
    row.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (title && title !== tag.content.title) {
        NotesStore.renameTag(uuid, title);
        invalidateTagMap();
      }
      renderTags();
      renderNotes();
      if (currentId) renderTagBar(NotesStore.get(currentId));
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        done = true;
        renderTags();
      }
    });
    input.addEventListener('blur', commit);
  }

  function deleteCurrentTag(uuid) {
    const tag = NotesStore.get(uuid);
    if (!tag) return;
    const title = tag.content.title || 'this tag';
    const count = NotesStore.noteCountForTag(uuid);
    const detail = count ? ` It will be removed from ${count} note${count === 1 ? '' : 's'}.` : '';
    confirmAction(`Delete “${title}”?${detail}`, {
      title: 'Delete tag',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      NotesStore.deleteTag(uuid);
      invalidateTagMap();
      if (currentTag === uuid) currentTag = null;
      renderTags();
      renderNotes();
      if (currentId) renderTagBar(NotesStore.get(currentId));
      toast('Tag deleted');
    });
  }

  function searchFilterOptions() {
    return NotesSearch.defaultSearchOptions(prefs.searchFilters || {});
  }

  function persistSearchFilters() {
    try {
      localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
    } catch (e) {
      /* ignore quota */
    }
    updateSearchFilterBadge();
  }

  function updateSearchFilterBadge() {
    const badge = document.getElementById('search-filter-badge');
    const toggle = document.getElementById('search-filter-toggle');
    if (!badge || !toggle) return;
    const count = NotesSearch.countActiveSearchFilters(searchFilterOptions());
    badge.hidden = count < 1;
    badge.textContent = String(count);
    toggle.classList.toggle('active', count > 0);
  }

  function syncSearchFilterControls() {
    const opts = searchFilterOptions();
    const titlesOnly = document.getElementById('search-titles-only');
    const includeProtected = document.getElementById('search-include-protected');
    const includeArchived = document.getElementById('search-include-archived');
    const includeTrashed = document.getElementById('search-include-trashed');
    if (titlesOnly) titlesOnly.checked = opts.titlesOnly;
    if (includeProtected) includeProtected.checked = opts.includeProtected;
    if (includeArchived) includeArchived.checked = opts.includeArchived;
    if (includeTrashed) includeTrashed.checked = opts.includeTrashed;
    renderSearchFilterTags();
    updateSearchFilterBadge();
  }

  function renderSearchFilterTags() {
    const host = document.getElementById('search-filter-tags');
    if (!host) return;
    const tags = NotesStore.listTags();
    const selected = new Set(searchFilterOptions().tagIds);
    if (!tags.length) {
      host.innerHTML = '<p class="search-filter-empty muted">No tags yet — create one below.</p>';
      return;
    }
    host.innerHTML = tags.map((tag) => {
      const active = selected.has(tag.uuid) ? 'active' : '';
      const color = safeColor(tag.content.color);
      const title = escapeHtml(tag.content.title || 'Tag');
      return `<button type="button" class="search-filter-tag ${active}" data-search-filter-tag="${escapeAttr(tag.uuid)}" style="--tag-color:${color}">
        <span class="tag-dot"></span>
        <span>${title}</span>
      </button>`;
    }).join('');
    host.querySelectorAll('[data-search-filter-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.searchFilterTag;
        const next = new Set(searchFilterOptions().tagIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        prefs.searchFilters.tagIds = [...next];
        persistSearchFilters();
        syncSearchFilterControls();
        renderNotes();
        if (currentId) applyEditorMode();
      });
    });
  }

  function readSearchFilterPanel() {
    prefs.searchFilters = NotesSearch.defaultSearchOptions({
      titlesOnly: !!document.getElementById('search-titles-only')?.checked,
      includeProtected: !!document.getElementById('search-include-protected')?.checked,
      includeArchived: !!document.getElementById('search-include-archived')?.checked,
      includeTrashed: !!document.getElementById('search-include-trashed')?.checked,
      tagIds: searchFilterOptions().tagIds,
    });
    persistSearchFilters();
  }

  function clearSearchFilters() {
    prefs.searchFilters = NotesSearch.defaultSearchOptions({});
    persistSearchFilters();
    syncSearchFilterControls();
    renderNotes();
    if (currentId) applyEditorMode();
  }

  function setSearchFilterPanelOpen(open) {
    const panel = document.getElementById('search-filter-panel');
    const backdrop = document.getElementById('search-filter-backdrop');
    const toggle = document.getElementById('search-filter-toggle');
    if (!panel || !toggle) return;
    panel.hidden = !open;
    if (backdrop) backdrop.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      syncSearchFilterControls();
      document.getElementById('search-titles-only')?.focus();
    }
  }

  function notesRenderKey(notes, query) {
    const sf = searchFilterOptions();
    const sfKey = `${sf.titlesOnly ? 1 : 0}:${sf.includeArchived ? 1 : 0}:${sf.includeTrashed ? 1 : 0}:${sf.includeProtected ? 1 : 0}:${sf.tagIds.join(',')}`;
    const ids = notes.map((n) => `${n.uuid}:${n.content.updated_at || ''}:${(n.content.ocr_text || '').length}:${n.content.title || ''}:${n.content.pinned ? 1 : 0}:${n.content.starred ? 1 : 0}:${n.content.warn_at || ''}:${n.content.locked ? 1 : 0}:${n.content.prevent_edit ? 1 : 0}`).join('|');
    return `${currentFilter}:${currentTag || ''}:${query}:${sfKey}:${prefs.sort}:${activeListNoteId()}:${ids}`;
  }

  function activeListNoteId() {
    return currentId || listSelectionId || '';
  }

  function markActiveNoteRow() {
    const selected = activeListNoteId();
    ui.noteList.querySelectorAll('.note-row').forEach((row) => {
      const on = row.dataset.id === selected;
      row.classList.toggle('active', on);
      row.querySelector('.note-item')?.classList.toggle('active', on);
    });
  }

  async function probeNetwork({ syncOnRecovery = false } = {}) {
    // iOS LAN-only Wi‑Fi may report navigator.onLine=false while homelab is reachable.
    // Cellular without WireGuard cannot reach 192.168.x — expect failures there.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch('/api/health', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('health failed');
      const data = await res.json().catch(() => ({}));
      if (data.build) applyServerBuildStatus(data.build);
      const wasOffline = !networkReachable;
      networkReachable = true;
      updateNetworkStatusBanner();
      if (wasOffline) {
        NotesStore.emitSync('idle', '');
        if (syncOnRecovery && vaultReady) {
          syncNow({ quiet: true });
          resumePendingOcr().catch(() => {});
          listPreviewBackfillFailed.clear();
          resumePendingListPreviews().catch(() => {});
          uploadPendingDeviceReport({ quiet: true }).catch(() => {});
        }
        if (ocrDeferred.size) scheduleDeferredOcrRetry();
      }
      return true;
    } catch (err) {
      if (networkReachable) {
        networkReachable = false;
        NotesStore.emitSync('offline', 'Offline');
      }
      updateNetworkStatusBanner();
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function markNetworkReachable() {
    const wasOffline = !networkReachable;
    networkReachable = true;
    if (wasOffline) NotesStore.emitSync('idle', '');
    updateNetworkStatusBanner();
  }
  window.notesMarkNetworkReachable = markNetworkReachable;

  const OFFLINE_LAN_HINT = 'Can\'t reach the notes server. Join home Wi‑Fi or WireGuard, then try again.';

  function scheduleNetworkProbe() {
    clearTimeout(networkProbeTimer);
    networkProbeTimer = setTimeout(() => {
      probeNetwork({ syncOnRecovery: true }).catch(() => {});
    }, 30000);
  }

  function listStoredFiles({ query = '', tagId = null } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const files = [];
    for (const att of NotesStore.listAttachments()) {
      const note = NotesStore.get(att.content.note_id);
      if (!note || note.deleted || note.content?.trashed || note.content?.archived) continue;
      if (tagId && !(note.content.tags || []).includes(tagId)) continue;
      const name = String(att.content.filename || att.content.original_filename || '');
      const mime = String(att.content.mime || '');
      const title = String(note.content.title || '');
      const ocr = String(att.content.ocr_text || note.content.ocr_text || '');
      if (q && ![name, mime, title, ocr].some((part) => part.toLowerCase().includes(q))) continue;
      files.push({ att, note });
    }
    const sort = NOTE_SORT_ORDER.includes(prefs.sort) ? prefs.sort : 'updated';
    files.sort((a, b) => {
      if (sort === 'title') {
        const na = String(a.att.content.filename || a.att.content.original_filename || a.note.content.title || '');
        const nb = String(b.att.content.filename || b.att.content.original_filename || b.note.content.title || '');
        return na.localeCompare(nb);
      }
      const fileMs = (file, useCreated) => {
        if (useCreated) return noteCreatedAtMs(file.note);
        const raw = Number(file.att.updated_at);
        if (Number.isFinite(raw) && raw > 0) return raw < 1e12 ? raw * 1000 : raw;
        return noteEditedAtMs(file.note);
      };
      const useCreated = sort === 'created';
      return fileMs(b, useCreated) - fileMs(a, useCreated);
    });
    return files;
  }

  function noteWarnChipHtml(note) {
    const warnMs = parseTimestampMs(note?.content?.warn_at);
    // Only upcoming warnings get a chip; once the email has gone out the clock disappears.
    if (!Number.isFinite(warnMs) || warnMs <= Date.now()) return '';
    const when = formatDateTime(warnMs);
    const short = formatWarnChipTime(warnMs);
    return `<span class="note-tag note-tag-warn" title="Time warning ${escapeAttr(when)}" aria-label="Time warning ${escapeAttr(when)}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.8v3.4l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="note-tag-warn-text">${escapeHtml(short)}</span></span>`;
  }

  /** Compact chip label, always date + time: "6 Sep 14:30", or "6 Sep 2027 14:30" in another year. */
  function formatWarnChipTime(ms) {
    const d = new Date(ms);
    const now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const dateOpts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== now.getFullYear()) dateOpts.year = 'numeric';
    return `${d.toLocaleDateString(undefined, dateOpts)} ${time}`;
  }

  function noteTagChipsHtml(note, { max = 3 } = {}) {
    const assigned = (note?.content?.tags || [])
      .map((id) => tagMap().get(id))
      .filter(Boolean);
    const warn = noteWarnChipHtml(note);
    if (!assigned.length && !warn) return '';
    const shown = assigned.slice(0, max);
    const extra = assigned.length - shown.length;
    const chips = shown
      .map((t) => `<span class="note-tag" style="--tag-color:${safeColor(t.content.color)}"># ${escapeHtml(t.content.title)}</span>`)
      .join('') + (extra > 0 ? `<span class="note-tag more">+${extra}</span>` : '');
    return `<div class="note-item-tags">${warn}${chips}</div>`;
  }

  function noteRowDeleteLabel(note) {
    return note?.content?.trashed ? 'Delete' : 'Trash';
  }

  function noteRowSwipeDeleteHtml(note) {
    const label = noteRowDeleteLabel(note);
    const id = escapeAttr(note.uuid);
    return `<button type="button" class="note-swipe-delete" data-id="${id}" aria-label="${label} note">${label}</button>`;
  }

  function noteRowDeleteBtnHtml(note) {
    const label = noteRowDeleteLabel(note);
    const id = escapeAttr(note.uuid);
    return `<button type="button" class="note-row-delete" data-id="${id}" aria-label="${label} note" title="${label}">×</button>`;
  }

  function noteLockBadgeHtml(note) {
    if (!note?.content) return '';
    if (note.content.locked) {
      return '<span class="note-lock-badge note-lock-badge-vault" title="Protected note" aria-label="Protected note">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>'
        + '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
        + '</svg>'
        + '<span class="note-lock-text">Protected</span>'
        + '</span>';
    }
    if (note.content.prevent_edit) {
      return '<span class="note-lock-badge note-lock-badge-edit" title="Editing locked" aria-label="Editing locked">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>'
        + '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
        + '</svg>'
        + '<span class="note-lock-text">Read only</span>'
        + '</span>';
    }
    return '';
  }

  function renderFileRow(file, query) {
    const { att, note } = file;
    const isProtected = !!note.content?.locked;
    const isLocked = isProtected && !unlockedNotes.has(note.uuid);
    const lockBadgeHtml = noteLockBadgeHtml(note);
    const active = note.uuid === activeListNoteId() ? 'active' : '';
    const protectedClass = isProtected ? 'is-protected' : '';
    const name = att.content.filename || att.content.original_filename || 'Untitled file';
    const kind = NotesPreview.kindFromMeta(att.content.mime, name);
    const showThumb = !isLocked && (kind === 'image' || kind === 'pdf') && !prefs.hidePreviews;
    const noteTitle = note.content.title || 'Untitled';
    const kindLabel = kind === 'pdf' ? 'PDF' : kind === 'image' ? 'Image' : (att.content.mime || 'File');
    const snippet = isLocked ? '' : (noteTitle && noteTitle !== name ? noteTitle : kindLabel);
    const titleHtml = query ? NotesSearch.highlightPlain(name, query) : escapeHtml(name);
    const snippetHtml = isLocked
      ? '<span class="note-preview-locked"><svg class="preview-lock-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Protected document</span>'
      : (query ? NotesSearch.highlightPlain(snippet, query) : escapeHtml(snippet));
    const editedMs = Number(att.updated_at) > 0 ? Number(att.updated_at) * (Number(att.updated_at) < 1e12 ? 1000 : 1) : noteEditedAtMs(note);
    const modified = formatModified(editedMs);
    const icon = kind === 'image'
      ? { icon: '🖼', tone: 'note' }
      : { icon: '📄', tone: 'note', svg: kindIconSvg('note') };
    return `<div class="note-row ${active} ${protectedClass}" data-id="${escapeAttr(note.uuid)}">
      ${noteRowSwipeDeleteHtml(note)}
      ${noteRowDeleteBtnHtml(note)}
      <button type="button" class="note-item ${active}" data-id="${escapeAttr(note.uuid)}">
        ${showThumb
    ? listThumbHtml(att, note.uuid, icon)
    : kindIconHtml(icon)}
        <span class="note-item-body">
          <span class="note-title-row">
            ${lockBadgeHtml}
            <h3>${titleHtml}</h3>
          </span>
          ${prefs.hidePreviews ? '' : `<p class="note-preview">${snippetHtml}</p>`}
          ${noteTagChipsHtml(note)}
          <span class="note-modified">${escapeHtml(modified || relativeTime(editedMs))}</span>
        </span>
      </button>
    </div>`;
  }

  function renderNoteRow(n, query) {
    const isProtected = !!n.content?.locked;
    const isLocked = isProtected && !unlockedNotes.has(n.uuid);
    const lockBadgeHtml = noteLockBadgeHtml(n);
    const active = n.uuid === activeListNoteId() ? 'active' : '';
    const protectedClass = isProtected ? 'is-protected' : '';
    const atts = isLocked ? [] : NotesStore.listAttachments(n.uuid);
    const match = query && !isLocked ? NotesSearch.describeMatch(n, query, tagMap()) : null;
    const ocr = isLocked ? '' : String(n.content.ocr_text || '').trim();
    const body = isLocked ? '' : String(n.content.content || '').trim();
    const bodyLine = body && body !== ocr
      ? body.split('\n').find((line) => line.trim()) || ''
      : '';
    const snippet = match?.snippet
      || bodyLine
      || ocr.slice(0, 90)
      || n.content.attachment_names
      || atts[0]?.content?.filename
      || '';
    const displayTitle = n.content.title || 'Untitled';
    const displaySnippet = String(snippet).slice(0, 120);
    const titleHtml = query
      ? NotesSearch.highlightPlain(displayTitle, query)
      : escapeHtml(displayTitle);
    const tags = isLocked ? '' : noteTagChipsHtml(n);
    const editedMs = noteEditedAtMs(n);
    const modified = formatModified(editedMs);
    const kind = noteKindMeta(n);
    const firstAtt = atts[0];
    const thumbKind = firstAtt
      ? NotesPreview.kindFromMeta(firstAtt.content.mime, firstAtt.content.filename)
      : null;
    const showListThumb = !isLocked
      && firstAtt
      && (thumbKind === 'image' || thumbKind === 'pdf')
      && !prefs.hidePreviews;
    const previewHtml = prefs.hidePreviews
      ? ''
      : (isLocked
        ? '<p class="note-preview note-preview-locked"><svg class="preview-lock-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Protected note</p>'
        : noteListPreview(n, displaySnippet, query));
    const pinHtml = (n.content.pinned || n.content.starred)
      ? `<span class="note-pin" title="Pinned" aria-hidden="true"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.1 1.6l5.3 5.3-1.9 1-2.3 2.3v3.4L7.7 11l-2.6 2.6-2.1-2.1 2.6-2.6L2.8 6l3.4.1 2.3-2.3z"/></svg></span>`
      : '';
    const where = match
      ? `<span class="note-modified note-match-label">${escapeHtml(match.label)}</span>`
      : `<span class="note-modified">${escapeHtml(modified || relativeTime(editedMs))}</span>`;
    return `<div class="note-row ${active} ${protectedClass}" data-id="${escapeAttr(n.uuid)}">
      ${noteRowSwipeDeleteHtml(n)}
      ${noteRowDeleteBtnHtml(n)}
      <button type="button" class="note-item ${active}" data-id="${escapeAttr(n.uuid)}">
        ${showListThumb
    ? listThumbHtml(firstAtt, n.uuid, kind)
    : kindIconHtml(kind)}
        <span class="note-item-body">
          <span class="note-title-row">
            ${pinHtml}
            ${lockBadgeHtml}
            <h3>${titleHtml}</h3>${noteIndexingBadge(n.uuid)}
          </span>
          ${previewHtml}
          ${tags}
          ${where}
        </span>
      </button>
    </div>`;
  }

  const NOTE_LIST_VIRTUAL_THRESHOLD = 120;
  const NOTE_ROW_ESTIMATE = 76;

  // Real rows are taller than the initial guess once tags/"Modified" lines show,
  // so the estimate is re-measured from rendered rows after every paint.
  let noteRowEstimate = NOTE_ROW_ESTIMATE;
  let lastVirtualWindow = null;
  let virtualSettleDepth = 0;

  function virtualListWindow(total, scrollTop, viewHeight, rowHeight = noteRowEstimate) {
    const virtualThreshold = vaultPullActive ? Number.POSITIVE_INFINITY : NOTE_LIST_VIRTUAL_THRESHOLD;
    if (total <= virtualThreshold) {
      return { total, start: 0, end: total, padTop: 0, padBottom: 0 };
    }
    const visible = Math.ceil((viewHeight || 640) / rowHeight) + 20;
    let start = Math.max(0, Math.floor(scrollTop / rowHeight) - 10);
    // Always render a full window at the tail so a deep scrollTop can never
    // land the viewport inside an empty spacer.
    start = Math.min(start, Math.max(0, total - visible));
    const end = Math.min(total, start + visible);
    return {
      total,
      start,
      end,
      padTop: start * rowHeight,
      padBottom: Math.max(0, (total - end) * rowHeight),
    };
  }

  function measureNoteRowHeight() {
    const rows = ui.noteList.querySelectorAll('.note-section .note-row');
    if (rows.length < 4) return;
    const first = rows[0].getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    const measured = (last.bottom - first.top) / rows.length;
    if (measured > 24 && measured < 400 && Math.abs(measured - noteRowEstimate) > 4) {
      noteRowEstimate = Math.round(measured);
    }
  }

  // After a virtual paint, make sure at least one row is inside the viewport.
  // If the viewport sits in a spacer (estimate drift, clamped scrollTop), paint again.
  function settleVirtualList() {
    const list = ui.noteList;
    if (!list.querySelector('[data-virtual="1"]')) return;
    measureNoteRowHeight();
    const rows = list.querySelectorAll('.note-row');
    const listRect = list.getBoundingClientRect();
    const firstTop = rows.length ? rows[0].getBoundingClientRect().top - listRect.top : Infinity;
    const lastBottom = rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom - listRect.top : -Infinity;
    const blank = !rows.length || firstTop > list.clientHeight || lastBottom < 0;
    if (!blank || virtualSettleDepth >= 2) return;
    virtualSettleDepth += 1;
    try {
      lastNotesRenderKey = '';
      renderNotesNow();
    } finally {
      virtualSettleDepth -= 1;
    }
  }

  function virtualWindowStale() {
    if (!lastVirtualWindow || !ui.noteList.querySelector('[data-virtual="1"]')) return false;
    const next = virtualListWindow(lastVirtualWindow.total, ui.noteList.scrollTop || 0, ui.noteList.clientHeight);
    return Math.abs(next.start - lastVirtualWindow.start) >= 5 || next.end !== lastVirtualWindow.end;
  }

  function renderSectionRows(section, sliceStart, sliceEnd, query) {
    const slice = section.items.slice(sliceStart, sliceEnd);
    return section.files
      ? slice.map((file) => renderFileRow(file, query)).join('')
      : slice.map((n) => renderNoteRow(n, query)).join('');
  }

  function buildNoteListSectionsHtml(sections, query) {
    const total = sections.reduce((count, section) => count + section.items.length, 0);
    const scrollTop = ui.noteList.scrollTop || 0;
    const viewHeight = ui.noteList.clientHeight || 640;
    const virtualThreshold = vaultPullActive ? Number.POSITIVE_INFINITY : NOTE_LIST_VIRTUAL_THRESHOLD;
    if (total <= virtualThreshold) {
      lastVirtualWindow = null;
      return sections.map((section) => {
        const heading = section.label
          ? `<h3 class="note-section-label">${escapeHtml(section.label)}</h3>`
          : '';
        const rows = renderSectionRows(section, 0, section.items.length, query);
        return `${heading}<div class="note-section" data-virtual="0">${rows}</div>`;
      }).join('');
    }
    const win = virtualListWindow(total, scrollTop, viewHeight);
    lastVirtualWindow = win;
    const parts = [];
    if (win.padTop) {
      parts.push(`<div class="note-list-spacer" style="height:${win.padTop}px" aria-hidden="true"></div>`);
    }
    let globalIdx = 0;
    for (const section of sections) {
      const sectionStart = globalIdx;
      const sectionEnd = globalIdx + section.items.length;
      globalIdx = sectionEnd;
      const visStart = Math.max(win.start, sectionStart);
      const visEnd = Math.min(win.end, sectionEnd);
      if (visStart >= visEnd) continue;
      const heading = section.label
        ? `<h3 class="note-section-label">${escapeHtml(section.label)}</h3>`
        : '';
      const rows = renderSectionRows(section, visStart - sectionStart, visEnd - sectionStart, query);
      parts.push(`${heading}<div class="note-section" data-virtual="1">${rows}</div>`);
    }
    if (win.padBottom) {
      parts.push(`<div class="note-list-spacer" style="height:${win.padBottom}px" aria-hidden="true"></div>`);
    }
    return parts.join('');
  }

  function renderNotesNow() {
    if (vaultPullActive && isEditorOpen()) {
      updateVaultPullHead();
      markActiveNoteRow();
      return;
    }
    const query = ui.search.value.trim();
    const searchOptions = searchFilterOptions();
    const listingFiles = currentFilter === 'documents';
    const notes = listingFiles ? [] : NotesSearch.filterNotes(NotesStore.listNotes(), {
      query: ui.search.value,
      filter: currentFilter,
      tagId: currentTag,
      tagMap: tagMap(),
      sort: prefs.sort,
      searchOptions,
    });
    const files = listingFiles ? listStoredFiles({ query, tagId: currentTag }) : [];
    const listed = listingFiles ? files : notes;
    const listedCount = listed.length;
    const meta = document.getElementById('search-meta');
    const listHead = document.getElementById('note-list-head');
    const listTitle = document.getElementById('note-list-title');
    const listCount = document.getElementById('note-list-count');
    const context = NotesSearch.searchContextActive(query, searchOptions);
    if (query || context) {
      meta.hidden = false;
      const parts = [];
      if (query) {
        parts.push(`${listedCount} match${listedCount === 1 ? '' : 'es'}`);
        if (searchOptions.titlesOnly) parts.push('titles only');
      } else if (context) {
        parts.push(`${listedCount} ${listingFiles ? 'file' : 'note'}${listedCount === 1 ? '' : 's'}`);
      }
      if (searchOptions.tagIds.length) parts.push(`${searchOptions.tagIds.length} tag filter${searchOptions.tagIds.length === 1 ? '' : 's'}`);
      meta.textContent = listedCount
        ? `${parts.join(' · ')}${query && !searchOptions.titlesOnly && !listingFiles ? ' in notes and scanned documents' : ''}`
        : (query ? (listingFiles ? 'No files match that search' : 'No notes match that search') : 'No notes match these filters');
    } else {
      meta.hidden = true;
    }
    if (listHead && listTitle && listCount) {
      const tag = currentTag ? tagMap().get(currentTag) : null;
      listHead.hidden = false;
      listTitle.textContent = tag ? tag.content.title || 'Tag' : (FILTER_TITLES[currentFilter] || 'Notes');
      listCount.textContent = listedCount
        ? `${listedCount}`
        : '0';
      listCount.title = listedCount ? `${listedCount} item${listedCount === 1 ? '' : 's'}` : 'No items';
    }
    updateTrashToolbar(currentFilter === 'trash' ? notes.length : undefined);
    const renderKey = listingFiles
      ? notesRenderKey(files.map((file) => ({
        uuid: file.att.uuid,
        content: {
          updated_at: file.att.updated_at,
          title: file.att.content.filename || '',
          ocr_text: '',
          pinned: false,
          starred: false,
        },
      })), query)
      : notesRenderKey(notes, query);
    if (renderKey === lastNotesRenderKey && ui.noteList.querySelector('.note-row') && !vaultPullActive
      && !virtualWindowStale()) {
      markActiveNoteRow();
      renderVaultStats();
      return;
    }
    lastNotesRenderKey = renderKey;
    const scrollTop = ui.noteList.scrollTop;
    if (!listedCount) {
      if (vaultPullActive) {
        const live = NotesStore.listNotes().filter((n) => !n.content?.trashed).length;
        if (!live) {
          const totalHint = vaultPullExpected ? ` of ${vaultPullExpected}` : '';
          ui.noteList.innerHTML = `<div class="note-list-empty">
              <p class="note-list-empty-title">Downloading notes…</p>
              <p class="muted">0${totalHint} received — your list fills as notes decrypt.</p>
            </div>`;
          updateVaultPullHead();
          renderVaultStats();
          return;
        }
      }
      ui.noteList.innerHTML = query
        ? `<div class="note-list-empty"><p class="note-list-empty-title">No matches</p><p class="muted">${listingFiles ? 'Try a filename or the note the file is attached to.' : 'Try another word, a tag name, or text from a scanned document.'}</p></div>`
        : currentFilter === 'trash'
          ? '<div class="note-list-empty"><p class="note-list-empty-title">Trash is empty</p><p class="muted">Notes you delete appear here until you empty trash.</p></div>'
        : currentFilter === 'documents'
          ? `<div class="note-list-empty">
              <p class="note-list-empty-title">No files yet</p>
              <p class="muted">Scan a document or add a file to a note. Text is read on your device so you can search it.</p>
              <div class="note-list-empty-actions">
                <button type="button" class="btn primary sm" data-empty-scan>Scan document</button>
              </div>
            </div>`
        : vaultSyncError
          ? `<div class="note-list-empty">
              <p class="note-list-empty-title">Could not load notes</p>
              <p class="muted">${escapeHtml(vaultSyncError)}</p>
              <div class="note-list-empty-actions">
                <button type="button" class="btn primary sm" data-relock-unlock>Try another password</button>
              </div>
            </div>`
          : `<div class="note-list-empty">
              <p class="note-list-empty-title">No notes here yet</p>
              <p class="muted">Create a note or scan a document, or pull down to sync from your other devices.</p>
              <div class="note-list-empty-actions">
                <button type="button" class="btn primary sm" data-empty-sync>Sync notes</button>
                <button type="button" class="btn sm" data-empty-new>New note</button>
                <button type="button" class="btn sm" data-empty-scan>Scan document</button>
              </div>
            </div>`;
      ui.noteList.querySelector('[data-relock-unlock]')?.addEventListener('click', () => {
        lockVault('Enter the vault password from your phone.');
      });
      ui.noteList.querySelector('[data-empty-sync]')?.addEventListener('click', () => triggerPullSync());
      ui.noteList.querySelector('[data-empty-new]')?.addEventListener('click', () => createNote());
      ui.noteList.querySelector('[data-empty-scan]')?.addEventListener('click', pickScanFile);
      renderVaultStats();
      return;
    }
    const sortMode = NOTE_SORT_ORDER.includes(prefs.sort) ? prefs.sort : 'updated';
    const useDateSections = !query && (NotesSearch.listUsesDateSections?.(sortMode) ?? sortMode === 'updated');
    const sections = [];
    if (listingFiles) {
      if (!useDateSections) {
        sections.push({ label: '', items: files, files: true });
      } else {
        const grouped = new Map();
        files.forEach((file) => {
          let at;
          if (sortMode === 'created') {
            at = noteCreatedAtMs(file.note);
          } else {
            const raw = Number(file.att.updated_at);
            at = Number.isFinite(raw) && raw > 0
              ? (raw < 1e12 ? raw * 1000 : raw)
              : noteEditedAtMs(file.note);
          }
          const key = noteSectionKey(at);
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(file);
        });
        ['Today', 'Yesterday', 'This week', 'Older'].forEach((label) => {
          const items = grouped.get(label);
          if (items?.length) sections.push({ label, items, files: true });
        });
      }
    } else if (!useDateSections) {
      sections.push({ label: '', items: notes });
    } else {
      // Date buckets would otherwise scatter pinned notes by last-updated /
      // created day. Always keep them in a Pinned block at the top, including
      // tag filters and sort-by-created. Skip only when the view is already
      // the starred/pinned filter (every row would be in that block).
      const hoistPinned = currentFilter !== 'pinned';
      const splitPinned = typeof NotesSearch.partitionPinnedNotes === 'function'
        ? NotesSearch.partitionPinnedNotes
        : (list) => ({
          pinned: list.filter((n) => n.content.pinned || n.content.starred),
          rest: list.filter((n) => !n.content.pinned && !n.content.starred),
        });
      const { pinned, rest } = hoistPinned
        ? splitPinned(notes)
        : { pinned: [], rest: notes };
      if (pinned.length) sections.push({ label: 'Pinned', items: pinned });
      const grouped = new Map();
      rest.forEach((note) => {
        const key = noteSectionKey(noteListSectionMs(note, sortMode));
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(note);
      });
      ['Today', 'Yesterday', 'This week', 'Older'].forEach((label) => {
        const items = grouped.get(label);
        if (items?.length) sections.push({ label, items });
      });
    }
    ui.noteList.innerHTML = buildNoteListSectionsHtml(sections, query);
    markActiveNoteRow();
    if (!ui.noteList._virtualScrollBound) {
      ui.noteList._virtualScrollBound = true;
      ui.noteList.addEventListener('scroll', () => {
        // Only repaint when the scroll position left the rendered window.
        if (!virtualWindowStale()) return;
        renderNotes();
      }, { passive: true });
    }
    ui.noteList.scrollTop = scrollTop;
    settleVirtualList();
    if (!vaultPullActive || !isEditorOpen()) {
      ui.noteList.querySelectorAll('.note-list-thumb[data-thumb-id]').forEach((el) => {
        observeThumb(el.dataset.noteId, el.dataset.thumbId, el, { forList: true });
      });
    }
    renderVaultStats();
  }

  function renderNotes() {
    if (renderNotesFrame) cancelAnimationFrame(renderNotesFrame);
    renderNotesFrame = requestAnimationFrame(() => {
      renderNotesFrame = 0;
      renderNotesNow();
    });
  }

  function findTagByTitle(title) {
    const needle = String(title || '').trim().toLowerCase();
    if (!needle) return null;
    return NotesStore.listTags().find(
      (tag) => (tag.content.title || '').trim().toLowerCase() === needle,
    ) || null;
  }

  function assignTagToCurrent(tagId) {
    if (!currentId || !tagId) return false;
    const note = NotesStore.get(currentId);
    if (!note) return false;
    const tags = new Set(note.content.tags || []);
    if (tags.has(tagId)) return true;
    tags.add(tagId);
    NotesStore.upsert(currentId, { ...note.content, tags: [...tags] });
    return true;
  }

  let tagBarCommitLock = false;
  let tagBarExpanded = false;
  let tagBarNoteId = null;
  let tagBarShowAll = false;

  function isMobileLayout() {
    return window.matchMedia && window.matchMedia('(max-width: 860px)').matches;
  }

  function isDesktopLayout() {
    return window.matchMedia && window.matchMedia('(min-width: 861px)').matches;
  }

  function defaultTagBarExpanded() {
    return false;
  }

  function defaultTagBarShowAll() {
    return isMobileLayout();
  }

  function tagBarSummaryText(note) {
    if (!note) return 'None';
    const selected = note.content.tags || [];
    const tags = NotesStore.listTags().filter((t) => selected.includes(t.uuid));
    if (!tags.length) return 'None';
    if (tags.length <= 2) return tags.map((t) => t.content.title).join(', ');
    return `${tags.slice(0, 2).map((t) => t.content.title).join(', ')} +${tags.length - 2}`;
  }

  function syncTagBarShell(note) {
    const shell = document.getElementById('tag-bar-shell');
    const toggle = document.getElementById('tag-bar-toggle');
    const summary = document.getElementById('tag-bar-toggle-summary');
    if (!shell || !toggle) return;
    if (summary) summary.textContent = tagBarSummaryText(note);
    const collapsed = !tagBarExpanded;
    shell.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function commitTagBarInput() {
    if (tagBarCommitLock) return;
    const tagInput = document.getElementById('tag-bar-input');
    if (!tagInput) return;
    const name = String(tagInput.value || '').trim();
    if (!name) return;
    if (!currentId) {
      toast('Open a note first', true);
      return;
    }
    tagBarCommitLock = true;
    try {
      const existing = findTagByTitle(name);
      if (existing) {
        assignTagToCurrent(existing.uuid);
        tagInput.value = '';
        renderTags();
        renderNotes();
        renderTagBar(NotesStore.get(currentId));
        toast('Tag added');
        return;
      }
      createTag(name, { assignToCurrent: true });
      tagInput.value = '';
    } finally {
      setTimeout(() => {
        tagBarCommitLock = false;
      }, 120);
    }
  }

  function renderTagBar(note) {
    if (!note) return;
    const existingInput = document.getElementById('tag-bar-input');
    const draft = existingInput && document.activeElement === existingInput
      ? existingInput.value
      : '';
    const tags = NotesStore.listTags();
    const selected = new Set(note.content.tags || []);
    const compact = !tagBarShowAll;
    const visibleTags = compact
      ? tags.filter((t) => selected.has(t.uuid))
      : tags;
    const showAllBtn = `<button type="button" class="btn ghost sm tag-bar-show-all" id="tag-bar-show-all" aria-expanded="${tagBarShowAll ? 'true' : 'false'}">${tagBarShowAll ? 'Show assigned only' : 'Browse all tags'}</button>`;
    ui.tagBar.innerHTML = visibleTags
      .map((t) => {
        const on = selected.has(t.uuid) ? 'active' : '';
        const color = t.content.color || '#4f8cff';
        return `<button type="button" class="tag-chip ${on}" data-toggle-tag="${escapeAttr(t.uuid)}" aria-pressed="${on ? 'true' : 'false'}" style="--tag-color:${safeColor(color)}">
          <span class="tag-dot"></span>${escapeHtml(t.content.title)}
        </button>`;
      })
      .join('') + showAllBtn + `<form class="tag-bar-form" id="tag-bar-form">
        <input id="tag-bar-input" class="tag-bar-input" type="text" maxlength="80" placeholder="+ tag" autocomplete="off" enterkeyhint="done" autocapitalize="words">
        <button type="submit" class="tag-bar-add" id="tag-bar-add" aria-label="Add tag" title="Add tag">+</button>
      </form>`;
    ui.tagBar.querySelectorAll('[data-toggle-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const latest = NotesStore.get(currentId);
        if (!latest) return;
        const id = btn.dataset.toggleTag;
        const set = new Set(latest.content.tags || []);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        NotesStore.upsert(currentId, { ...latest.content, tags: [...set] });
        renderTagBar(NotesStore.get(currentId));
        renderNotes();
        renderTags();
      });
    });
    document.getElementById('tag-bar-show-all')?.addEventListener('click', () => {
      tagBarShowAll = !tagBarShowAll;
      renderTagBar(NotesStore.get(currentId));
    });
    const tagForm = document.getElementById('tag-bar-form');
    const tagInput = document.getElementById('tag-bar-input');
    if (draft && tagInput) tagInput.value = draft;
    if (tagForm) {
      tagForm.addEventListener('submit', (event) => {
        event.preventDefault();
        commitTagBarInput();
      });
    }
    if (tagInput) {
      tagInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          tagInput.value = '';
          tagInput.blur();
          return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commitTagBarInput();
      });
      tagInput.addEventListener('keyup', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commitTagBarInput();
      });
      tagInput.addEventListener('blur', () => {
        const value = String(tagInput.value || '').trim();
        if (!value) return;
        setTimeout(() => {
          if (tagBarCommitLock) return;
          const live = document.getElementById('tag-bar-input');
          if (!live || String(live.value || '').trim() !== value) return;
          commitTagBarInput();
        }, 150);
      });
    }
    syncTagBarShell(note);
  }

  function renderAttachments(noteId) {
    const note = NotesStore.get(noteId);
    const gated = !!note?.content?.locked && !unlockedNotes.has(noteId);
    if (gated) {
      if (ui.attachmentList) ui.attachmentList.innerHTML = '';
      if (ui.attachments) ui.attachments.hidden = true;
      if (ui.docInline) {
        ui.docInline.hidden = true;
        ui.docInline.innerHTML = '';
      }
      return;
    }
    const items = NotesStore.listAttachments(noteId);
    const attLabel = document.querySelector('.attachments .section-label');
    if (attLabel) {
      if (items.length > 1) {
        attLabel.innerHTML = `<button type="button" class="section-label-btn" id="attachment-gallery-open" aria-label="Open attachment gallery">${items.length} items</button>`;
      } else {
        attLabel.textContent = 'Attachments';
      }
    }
    const pending = (note?.content?.sn_pending_files || []).filter((item) => {
      return !(note.content.attachments || []).includes(item.uuid);
    });
    const pendingHtml = pending.map((item) => {
      const sizeKb = item.size ? ` · ${Math.round(item.size / 1024)} KB` : '';
      return `<div class="attachment-item is-pending" data-pending-file="${escapeAttr(item.uuid)}">
        <div class="attachment-thumb muted" aria-hidden="true">+</div>
        <div class="attachment-main">
          <strong>${escapeHtml(item.name || 'Attachment')}</strong>
          <span class="muted">Missing from Standard Notes import${sizeKb}. Add the original file.</span>
        </div>
        <div class="attachment-item-actions">
          <button type="button" class="btn ghost sm" data-pending-add="${escapeAttr(item.uuid)}">Add file</button>
        </div>
      </div>`;
    }).join('');
    ui.attachmentList.innerHTML = items
      .map((a) => {
        const sizeKb = Math.round((a.content.size || 0) / 1024);
        const { html: status } = attachmentOcrStatus(a);
        const busy = attachmentOcrBusy(a);
        const spinner = busy ? attachmentOcrSpinnerHtml() : '';
        const retryBtn = attachmentOcrRetryable(a)
          ? `<button type="button" class="btn ghost sm ocr-retry" data-retry-ocr="${escapeAttr(a.uuid)}">Retry OCR</button>`
          : '';
        return `<div class="attachment-item${busy ? ' is-ocr-busy' : ''}" data-att="${escapeAttr(a.uuid)}">
          <button type="button" class="attachment-thumb" data-preview="${escapeAttr(a.uuid)}" aria-label="Preview ${escapeAttr(a.content.filename || 'document')}">Open</button>
          <div class="attachment-main">
            <strong class="attachment-filename">${escapeHtml(a.content.filename)}</strong>${spinner}
            <span class="muted"> (${sizeKb} KB)</span>
            ${status}
          </div>
          <div class="attachment-item-actions">
            ${retryBtn}
            <button type="button" class="btn ghost sm" data-preview="${escapeAttr(a.uuid)}">Preview</button>
            <button type="button" class="btn ghost sm" data-share="${escapeAttr(a.uuid)}">Share</button>
            <button type="button" class="btn ghost sm" data-dl="${escapeAttr(a.uuid)}">Download</button>
            <button type="button" class="btn ghost sm" data-rm="${escapeAttr(a.uuid)}">Remove</button>
          </div>
        </div>`;
      })
      .join('') + pendingHtml;
    ui.attachmentList.querySelectorAll('[data-preview]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const open = activeFindNeedle()
          ? openDocPreviewFromSearch(btn.dataset.preview, { noteId })
          : openDocPreview(btn.dataset.preview, { noteId });
        open.catch((err) => toast(err.message || 'Preview failed', true));
      });
    });
    document.getElementById('attachment-gallery-open')?.addEventListener('click', () => {
      openDocGalleryAt(noteId, 0);
    });
    ui.attachmentList.querySelectorAll('[data-share]').forEach((btn) => {
      btn.addEventListener('click', () => {
        shareAttachment(btn.dataset.share).catch((err) => toast(err.message || 'Share failed', true));
      });
    });
    ui.attachmentList.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        downloadAttachment(btn.dataset.dl).catch((err) => toast(err.message || 'Download failed', true));
      });
    });
    ui.attachmentList.querySelectorAll('[data-rm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        forgetPreview(btn.dataset.rm);
        purgeServerOcr(btn.dataset.rm);
        NotesStore.remove(btn.dataset.rm);
        const note = NotesStore.get(noteId);
        if (note) {
          note.content.attachments = (note.content.attachments || []).filter((id) => id !== btn.dataset.rm);
          NotesStore.upsert(noteId, { ...note.content });
        }
        NotesStore.refreshNoteSearchText(noteId);
        renderAttachments(noteId);
        renderNotes();
      });
    });
    ui.attachmentList.querySelectorAll('[data-retry-ocr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        retryAttachmentOcr(btn.dataset.retryOcr).catch((err) => toast(err.message || 'OCR retry failed', true));
      });
    });
    ui.attachmentList.querySelectorAll('[data-pending-add]').forEach((btn) => {
      btn.addEventListener('click', () => ui.attachmentInput?.click());
    });
    if (vaultPullActive) {
      if (ui.docInline) {
        ui.docInline.hidden = true;
        ui.docInline.innerHTML = '';
      }
      return;
    }
    items.forEach((a) => {
      observeThumb(
        noteId,
        a.uuid,
        ui.attachmentList.querySelector(`[data-att="${a.uuid}"] .attachment-thumb`),
      );
    });
    renderDocInline(noteId);
  }

  function ocrSnippet(text, max = 48, meta = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    const quality = window.NotesOcrQuality;
    if (quality?.ocrResultWeak?.(trimmed, meta.boxes, meta.mime, meta.filename, meta.qualityHint)) return '';
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  }

  function isImageAttachment(mime, filename) {
    return window.NotesOcrQuality?.isImageAttachment?.(mime, filename)
      ?? (String(mime || '').toLowerCase().startsWith('image/')
        || /\.(png|jpe?g|webp|gif|bmp|hei[cf]|tif|tiff)$/i.test(String(filename || '')));
  }

  function ocrResultWeak(text, boxes, mime, filename, qualityHint) {
    return window.NotesOcrQuality?.ocrResultWeak?.(text, boxes, mime, filename, qualityHint) ?? false;
  }

  function normalizeOcrStorage(text, boxes, mime, filename, qualityHint, method = 'client') {
    return window.NotesOcrQuality?.normalizeOcrStorage?.(text, boxes, mime, filename, qualityHint, method)
      ?? { text: String(text || '').trim(), method: method || 'client' };
  }

  function ocrFinishToast(text, boxes, file, { refresh = false, qualityHint = '' } = {}) {
    const weak = ocrResultWeak(text, boxes, file?.type, file?.name, qualityHint);
    if (weak) {
      return {
        message: 'Could not read much text from this photo — try Scan document, better lighting, or tap Retry OCR',
        warn: true,
      };
    }
    const snippet = ocrSnippet(text);
    if (refresh) {
      return { message: snippet ? `Indexed · ${snippet}` : 'Server found no text', warn: !snippet };
    }
    return {
      message: snippet ? `Searchable · ${snippet}` : 'OCR finished — no text found',
      warn: !snippet,
    };
  }

  function noteSearchStale(noteId) {
    const note = NotesStore.get(noteId);
    if (!note) return false;
    const atts = NotesStore.listAttachments(noteId);
    const expectedOcr = atts.map((item) => item.content.ocr_text).filter(Boolean).join('\n\n');
    const expectedNames = atts.map((item) => {
      const parts = [item.content.filename, item.content.original_filename].filter(Boolean);
      return [...new Set(parts.map((part) => String(part).trim()).filter(Boolean))].join(' ');
    }).filter(Boolean).join(' ');
    return String(note.content.ocr_text || '') !== expectedOcr
      || String(note.content.attachment_names || '') !== expectedNames;
  }

  function refreshAllNoteSearchIndexes() {
    let updated = 0;
    NotesStore.listNotes().forEach((note) => {
      if (NotesStore.refreshNoteSearchText(note.uuid)) updated += 1;
    });
    if (updated) scheduleOcrUiRefresh();
    return updated;
  }

  function countStaleNoteSearchIndexes() {
    return NotesStore.listNotes().filter((note) => noteSearchStale(note.uuid)).length;
  }

  async function repairDocumentSearch() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    toast('Repairing search index…');
    const staleBefore = countStaleNoteSearchIndexes();
    const repaired = refreshAllNoteSearchIndexes();
    await ensureServerSession().catch(() => {});
    try {
      await resumePendingOcr();
    } catch (err) {
      console.warn('OCR resume during search repair failed', err);
    }
    if (currentId) await pullNoteOcrFromServer(currentId).catch(() => {});
    const staleAfter = countStaleNoteSearchIndexes();
    refreshSettingsDiagnostics().catch(() => {});
    if (repaired || staleBefore > staleAfter) {
      toast(`Search index repaired — ${Math.max(repaired, staleBefore - staleAfter)} note${Math.max(repaired, staleBefore - staleAfter) === 1 ? '' : 's'} updated`);
    } else {
      toast('Search index already up to date');
    }
  }

  function attachmentOcrRetryable(att) {
    if (!canOcrAttachment(att)) return false;
    const attId = att?.uuid;
    if (attId && (ocrWaitingServer.has(attId) || ocrInFlight.has(attId) || ocrQueued.has(attId))) {
      return false;
    }
    const method = att?.content?.ocr_method || '';
    return !!method;
  }

  function attachmentOcrStatus(att) {
    const attId = att?.uuid;
    if (attId && ocrWaitingServer.has(attId)) {
      return {
        html: '<p class="ocr-text">Waiting to read text…</p>',
        retry: false,
      };
    }
    if (attId && (ocrInFlight.has(attId) || ocrQueued.has(attId))) {
      return {
        html: '<p class="ocr-text">Reading text on this device…</p>',
        retry: false,
      };
    }
    const method = att?.content?.ocr_method || '';
    if (!method) {
      return {
        html: '<p class="ocr-text">Reading text on this device…</p>',
        retry: false,
      };
    }
    if (method === 'failed') {
      return {
        html: '<p class="ocr-text ocr-failed">Could not read text. Tap Retry OCR to try again.</p>',
        retry: true,
      };
    }
    if (method === 'none') {
      return {
        html: '<p class="ocr-text">No text found in this document</p>',
        retry: true,
      };
    }
    const text = String(att.content?.ocr_text || '').trim();
    const boxes = Array.isArray(att.content?.ocr_boxes) ? att.content.ocr_boxes : [];
    if (text && ocrResultWeak(text, boxes, att.content?.mime, att.content?.filename)) {
      const noteId = att.content?.note_id;
      queueMicrotask(() => {
        const live = NotesStore.get(attId);
        if (!live || String(live.content?.ocr_text || '').trim() !== text) return;
        NotesStore.setAttachmentOcr(attId, '', 'none', boxes);
        if (noteId) NotesStore.refreshNoteSearchText(noteId);
        scheduleOcrUiRefresh(noteId ? [noteId] : undefined);
      });
      return {
        html: '<p class="ocr-text">No text found in this document</p>',
        retry: true,
      };
    }
    if (text) {
      const snippet = text.length > 72 ? `${text.slice(0, 72)}…` : text;
      return {
        html: `<p class="ocr-text ocr-ready">Searchable · ${escapeHtml(snippet)}</p>`,
        retry: false,
      };
    }
    return {
      html: '<p class="ocr-text">No text found in this document</p>',
      retry: true,
    };
  }

  function isTransientOcrError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    if (err?.name === 'AbortError') return true;
    if (/no text|empty file|too large|invalid|choose a file|required|not found|image, pdf, or text/i.test(msg)) return false;
    return /timed out|memory|abort|engine failed|not cached|wasm|worker/i.test(msg);
  }

  function scheduleDeferredOcrRetry() {
    if (ocrRetryTimer) return;
    ocrRetryTimer = setTimeout(async () => {
      ocrRetryTimer = null;
      if (!ocrDeferred.size) return;
      const jobs = [...ocrDeferred.values()];
      ocrDeferred.clear();
      ocrWaitingServer.clear();
      jobs.forEach((job) => enqueueOcrJob({ ...job, force: false }));
      scheduleOcrUiRefresh();
    }, 2000);
  }

  function deferOcrJob(job) {
    ocrDeferred.set(job.attId, job);
    ocrWaitingServer.add(job.attId);
    scheduleOcrUiRefresh();
    if (!ocrDeferToastAt || Date.now() - ocrDeferToastAt > 8000) {
      ocrDeferToastAt = Date.now();
      toast('Document saved — OCR will retry shortly');
    }
    scheduleDeferredOcrRetry();
  }

  async function retryAttachmentOcr(attId) {
    const att = NotesStore.get(attId);
    if (!att || att.content?.type !== 'attachment') return;
    ocrDeferred.delete(attId);
    ocrWaitingServer.delete(attId);
    let file;
    try {
      const bytes = await NotesStore.getAttachmentBytes(attId);
      if (!bytes) throw new Error('Encrypted file is unavailable on this device');
      file = new File([bytes], att.content.filename || 'document', {
        type: att.content.mime || 'application/octet-stream',
      });
    } catch (err) {
      toast(err.message || 'Could not read that file', true);
      return;
    }
    NotesStore.setAttachmentOcr(attId, '', '', []);
    enqueueOcrJob({
      attId,
      noteId: att.content.note_id,
      file,
      force: true,
    });
    toast('Retrying OCR on this device…');
    refreshSettingsDiagnostics().catch(() => {});
  }

  const previewCache = new Map();
  // iOS Safari kills heavy tabs (silent reload mid-browse). Keep blob memory tiny there.
  const PREVIEW_CACHE_MAX = IS_IOS ? 2 : 12;
  let previewingId = null;
  let docGallery = null;

  function attachmentIdsForNote(noteId) {
    return NotesStore.listAttachments(noteId).map((a) => a.uuid);
  }

  function updateDocGalleryNav() {
    const nav = document.getElementById('doc-gallery-nav');
    const countBtn = document.getElementById('doc-gallery-count');
    refreshDocGalleryIds();
    const total = docGallery?.ids?.length || 0;
    if (nav) nav.hidden = total <= 1;
    if (countBtn && docGallery && total > 1) {
      countBtn.textContent = `${docGallery.index + 1} / ${total}`;
    }
  }

  function refreshDocGalleryIds() {
    if (!docGallery?.noteId) return false;
    const ids = attachmentIdsForNote(docGallery.noteId);
    if (!ids.length) {
      docGallery = null;
      return false;
    }
    const currentId = docGallery.ids[docGallery.index] || previewingId;
    docGallery.ids = ids;
    const nextIndex = ids.indexOf(currentId);
    docGallery.index = nextIndex >= 0 ? nextIndex : Math.min(docGallery.index, ids.length - 1);
    return true;
  }

  async function jumpDocGallery(delta = 1) {
    if (!docGallery || !refreshDocGalleryIds() || docGallery.ids.length <= 1) return;
    docGallery.index = (docGallery.index + delta + docGallery.ids.length) % docGallery.ids.length;
    const id = docGallery.ids[docGallery.index];
    await openDocPreview(id, { noteId: docGallery.noteId, keepGallery: true });
    updateDocGalleryNav();
  }

  function openDocGalleryAt(noteId, index = 0) {
    const ids = attachmentIdsForNote(noteId);
    if (!ids.length) return;
    const safeIndex = Math.max(0, Math.min(index, ids.length - 1));
    openDocPreview(ids[safeIndex], { noteId, galleryIndex: safeIndex })
      .catch((err) => toast(err.message || 'Preview failed', true));
  }

  function shrinkPreviewCacheForBackground() {
    // Free every cached blob except the one on screen so iOS keeps the tab alive.
    for (const id of [...previewCache.keys()]) {
      if (id !== previewingId) forgetPreview(id);
    }
  }

  function trimPreviewCache() {
    while (previewCache.size > PREVIEW_CACHE_MAX) {
      const oldest = previewCache.keys().next().value;
      if (oldest === undefined) break;
      forgetPreview(oldest);
    }
  }

  function touchPreviewCache(id, entry) {
    previewCache.delete(id);
    previewCache.set(id, entry);
    trimPreviewCache();
  }

  function forgetPreview(id) {
    const entry = previewCache.get(id);
    if (entry && typeof entry.then !== 'function' && entry.url) URL.revokeObjectURL(entry.url);
    previewCache.delete(id);
    if (previewingId === id) closeDocPreview();
  }

  function clearPreviewCache() {
    for (const id of [...previewCache.keys()]) forgetPreview(id);
  }

  async function cachedPreview(id) {
    if (previewCache.has(id)) {
      const cached = previewCache.get(id);
      if (typeof cached.then !== 'function') touchPreviewCache(id, cached);
      return cached;
    }
    const pending = (async () => {
      const item = NotesStore.get(id);
      if (!item) throw new Error('File not found');
      const bytes = await NotesStore.getAttachmentBytes(id);
      return {
        url: NotesPreview.blobUrl(bytes, item.content.mime),
        kind: NotesPreview.resolveKind(item.content.mime, item.content.filename, bytes),
        bytes,
        mime: item.content.mime,
        filename: item.content.filename || 'attachment',
      };
    })();
    previewCache.set(id, pending);
    trimPreviewCache();
    try {
      const entry = await pending;
      touchPreviewCache(id, entry);
      return entry;
    } catch (err) {
      previewCache.delete(id);
      throw err;
    }
  }

  // Tiny downscaled list thumbnails. Painting the full-resolution photo into a
  // 56px row made iOS decode every 12MP image in RAM on the overview — the tab
  // got OOM-killed exactly when going back to "All notes".
  const listThumbCache = new Map(); // attId -> small blob URL
  const LIST_THUMB_PX = 112;
  let thumbQueue = Promise.resolve();
  const listPreviewBackfill = new Set();
  const listPreviewBackfillFailed = new Set();
  let listPreviewBackfillQueue = Promise.resolve();

  function queueListPreviewBackfill(attId, { force = false } = {}) {
    if (!attId || listPreviewBackfill.has(attId)) return;
    if (!force && listPreviewBackfillFailed.has(attId)) return;
    const att = NotesStore.get(attId);
    if (!att || att.content?.preview_enc) return;
    if (attachmentKind(att) !== 'pdf') return;
    listPreviewBackfillQueue = listPreviewBackfillQueue
      .then(() => fetchAndStoreListPreview(attId))
      .catch(() => {});
  }

  async function fetchAndStoreListPreview(attId) {
    if (listPreviewBackfill.has(attId)) return;
    listPreviewBackfill.add(attId);
    listPreviewBackfillFailed.delete(attId);
    refreshIosPdfPlaceholders(attId);
    try {
      const att = NotesStore.get(attId);
      if (!att || att.content?.preview_enc) return;
      const bytes = await NotesStore.getAttachmentBytes(attId);
      if (!bytes?.length) return;
      const file = NotesPreview.fileFromBytes(
        bytes,
        att.content.filename || 'document',
        att.content.mime,
      );
      const data = await NotesOcr.fetchListPreview(file, attId);
      if (data.preview_jpeg?.length) {
        const ok = await NotesStore.setAttachmentPreview(attId, data.preview_jpeg);
        if (ok) {
          lastNotesRenderKey = '';
          renderNotes();
        }
      }
    } catch (err) {
      console.warn('list preview backfill failed', attId, err);
      listPreviewBackfillFailed.add(attId);
      refreshIosPdfPlaceholders(attId);
    } finally {
      listPreviewBackfill.delete(attId);
      refreshIosPdfPlaceholders(attId);
    }
  }

  async function resumePendingListPreviews() {
    if (!IS_IOS || !NotesStore.isUnlocked()) return;
    const missing = NotesStore.listAttachments().filter((att) => (
      attachmentKind(att) === 'pdf' && !att.content?.preview_enc
    ));
    missing.slice(0, 24).forEach((att) => queueListPreviewBackfill(att.uuid, { force: true }));
  }

  async function paintListThumbFromPreviewEnc(id, stage) {
    const bytes = await NotesStore.getAttachmentPreviewBytes(id);
    if (!bytes?.length) return false;
    let url = listThumbCache.get(id);
    if (!url) {
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      listThumbCache.set(id, url);
    }
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = url;
    const noteId = stage.dataset.noteId || '';
    attachListThumbErrorHandler(img, stage, noteId, id);
    stage.replaceChildren(img);
    return true;
  }

  function clearListThumbCache() {
    for (const url of listThumbCache.values()) {
      try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ }
    }
    listThumbCache.clear();
  }

  async function makeListThumbUrl(id, entry) {
    if (listThumbCache.has(id)) return listThumbCache.get(id);
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = entry.url;
    });
    const side = Math.max(img.naturalWidth, img.naturalHeight) || 1;
    const scale = Math.min(1, LIST_THUMB_PX / side);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    img.src = '';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
    const url = blob ? URL.createObjectURL(blob) : entry.url;
    listThumbCache.set(id, url);
    return url;
  }

  async function hydrateThumb(noteId, id, stage, { forList = false } = {}) {
    if (!stage) return;
    // One decode at a time — parallel full-res decodes were the OOM burst.
    const job = thumbQueue.then(() => hydrateThumbNow(noteId, id, stage, { forList }));
    thumbQueue = job.catch(() => {});
    return job;
  }

  async function hydrateThumbNow(noteId, id, stage, { forList = false } = {}) {
    try {
      if (forList && listThumbCache.has(id)) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = listThumbCache.get(id);
        attachListThumbErrorHandler(img, stage, noteId, id);
        stage.replaceChildren(img);
        return;
      }
      if (forList && await paintListThumbFromPreviewEnc(id, stage)) {
        return;
      }
      if (forList && NotesStore.lightVaultEnabled?.() && !(await NotesStore.hasLocalAttachmentBytes(id))) {
        // Light vault: never download a file just to draw a list thumbnail.
        paintListThumbFallback(stage, listThumbKindMeta(NotesStore.get(noteId), NotesStore.get(id)));
        return;
      }
      const entry = await cachedPreview(id);
      if (!forList && currentId !== noteId) return;
      if (entry.kind === 'image') {
        const img = document.createElement('img');
        img.alt = entry.filename;
        if (forList) {
          img.src = await makeListThumbUrl(id, entry);
          attachListThumbErrorHandler(img, stage, noteId, id);
          stage.replaceChildren(img);
          // Drop the full-size bytes + blob URL right away on the overview.
          if (previewingId !== id) forgetPreview(id);
        } else {
          img.src = entry.url;
          stage.replaceChildren(img);
        }
        return;
      }
      if (entry.kind === 'pdf') {
        if (IS_IOS && forList) {
          paintIosPdfPlaceholder(stage, entry.filename, { compact: true });
          queueListPreviewBackfill(id);
          if (previewingId !== id) forgetPreview(id);
          return;
        }
        const doc = await NotesPreview.openPdf(entry.bytes);
        const width = forList ? 56 : 240;
        stage.replaceChildren(await NotesPreview.renderPdfPage(doc, 1, width));
        if (forList && previewingId !== id) forgetPreview(id);
        return;
      }
      if (entry.kind === 'text') {
        clearDocStageLoading(stage);
        NotesPreview.renderTextPreview(stage, entry.bytes, query);
        if (forList && previewingId !== id) forgetPreview(id);
        return;
      }
      stage.textContent = 'File';
    } catch (err) {
      if (forList) {
        const att = NotesStore.get(id);
        const note = NotesStore.get(noteId);
        if (IS_IOS && attachmentKind(att) === 'pdf') {
          paintIosPdfPlaceholder(stage, att?.content?.filename, { compact: true });
          queueListPreviewBackfill(id, { force: true });
          return;
        }
        paintListThumbFallback(stage, listThumbKindMeta(note, att));
        return;
      }
      stage.textContent = 'Preview';
    }
  }

  async function hydrateInlineDoc(noteId, id, stage) {
    if (!stage) return;
    showDocStageLoading(stage);
    try {
      const entry = await cachedPreview(id);
      if (currentId !== noteId) return;
      const query = activeFindNeedle();
      if (entry.kind === 'image') {
        await paintDocumentSearch(id, stage, entry, query);
        return;
      }
      if (entry.kind === 'pdf') {
        await paintDocumentSearch(id, stage, entry, query);
        return;
      }
      if (entry.kind === 'text') {
        clearDocStageLoading(stage);
        NotesPreview.renderTextPreview(stage, entry.bytes, query);
        return;
      }
      clearDocStageLoading(stage);
      stage.innerHTML = '<p class="muted">This file type cannot be previewed. Download it instead.</p>';
    } catch (err) {
      clearDocStageLoading(stage);
      const msg = String(err.message || '');
      const friendly = /ghash tag|decrypt|Missing encryption key/i.test(msg)
        ? 'This document could not be decrypted — use Settings → Security → Repair documents.'
        : (/not on this device yet|missing encrypted data/i.test(msg)
          ? msg
          : (msg || 'Preview unavailable offline'));
      stage.innerHTML = `<p class="error">${escapeHtml(friendly)}</p>`;
    }
  }

  function currentSearchQuery() {
    return (ui.search && ui.search.value ? ui.search.value : '').trim();
  }

  function activeFindNeedle() {
    const findQ = currentFindQuery();
    if (findBarOpen() && findQ) return findQ;
    const sidebarQ = currentSearchQuery();
    if (sidebarQ) return sidebarQ;
    return findQ;
  }

  function attachmentSearchText(id) {
    const item = NotesStore.get(id);
    const note = currentId ? NotesStore.get(currentId) : null;
    const chunks = [];
    if (item?.content?.ocr_text) chunks.push(String(item.content.ocr_text));
    if (note?.content?.ocr_text) chunks.push(String(note.content.ocr_text));
    return [...new Set(chunks.filter(Boolean))].join('\n\n');
  }

  function attachmentSearchBoxes(id) {
    const item = NotesStore.get(id);
    return Array.isArray(item?.content?.ocr_boxes) ? item.content.ocr_boxes : [];
  }

  function attachmentOcrSettled(item) {
    const method = item?.content?.ocr_method || '';
    if (!method) return false;
    const current = Number(NotesStore.OCR_INDEX || 0);
    if (!current || Number(item.content.ocr_index) !== current) return false;
    if (method === 'text' || method === 'failed') return true;
    return Array.isArray(item.content.ocr_boxes);
  }

  const boxFetch = new Set();
  let docPaintToken = 0;

  function docLoadingHtml() {
    return '<div class="doc-stage-loading" role="status" aria-live="polite"><span class="doc-stage-loading-spinner" aria-hidden="true"></span><span>Loading preview…</span></div>';
  }

  function showDocStageLoading(stage) {
    if (!stage) return;
    stage.classList.add('is-loading');
    stage.innerHTML = docLoadingHtml();
  }

  function clearDocStageLoading(stage) {
    stage?.classList.remove('is-loading');
  }

  function previewHasHits(stage) {
    return !!stage?.querySelector('.doc-search-hit, pre mark.search-hit');
  }

  function previewHasExcerpt(stage) {
    return !!stage?.querySelector('.doc-ocr-hits');
  }

  function ensureAttachmentOcr(attId, file, onProgress, { force = false } = {}) {
    const item = NotesStore.get(attId);
    if (!force && attachmentOcrSettled(item)) {
      return Promise.resolve({
        text: String(item.content.ocr_text || ''),
        method: item.content.ocr_method,
        boxes: attachmentSearchBoxes(attId),
      });
    }
    const pending = ocrInFlight.get(attId);
    if (pending) return pending;
    const work = (async () => {
      const ocr = await NotesOcr.extractFromFile(file, onProgress, attId);
      const live = NotesStore.get(attId);
      const oldText = String(live?.content?.ocr_text || '');
      const rawText = String(ocr.text || oldText || '').trim();
      const boxes = Array.isArray(ocr.boxes) ? ocr.boxes : [];
      const mime = file?.type || live?.content?.mime;
      const filename = file?.name || live?.content?.filename;
      const stored = normalizeOcrStorage(
        rawText,
        boxes,
        mime,
        filename,
        ocr.ocr_quality,
        ocr.method || live?.content?.ocr_method || 'client',
      );
      NotesStore.setAttachmentOcr(
        attId,
        stored.text,
        stored.method,
        boxes,
      );
      if (ocr.preview_jpeg?.length) {
        await NotesStore.setAttachmentPreview(attId, ocr.preview_jpeg);
      }
      const noteId = live?.content?.note_id || currentId;
      if (noteId) NotesStore.refreshNoteSearchText(noteId);
      if (noteId) scheduleOcrUiRefresh([noteId]);
      return { text: stored.text, method: stored.method, boxes };
    })();
    ocrInFlight.set(attId, work);
    work.finally(() => {
      if (ocrInFlight.get(attId) === work) ocrInFlight.delete(attId);
    });
    return work;
  }

  async function fetchSearchBoxes(attId, entry) {
    const item = NotesStore.get(attId);
    if (!item || !canOcrAttachment(item)) return [];
    if (attachmentOcrSettled(item)) return attachmentSearchBoxes(attId);
    let cached = attachmentSearchBoxes(attId);
    if (cached.length) return cached;
    if (boxFetch.has(attId) || ocrInFlight.has(attId) || ocrQueued.has(attId)) {
      for (let i = 0; i < 160; i += 1) {
        cached = attachmentSearchBoxes(attId);
        if (cached.length) return cached;
        if (ocrInFlight.has(attId)) {
          try { await ocrInFlight.get(attId); } catch (_) { /* apply below */ }
          return attachmentSearchBoxes(attId);
        }
        if (!boxFetch.has(attId) && !ocrQueued.has(attId)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      cached = attachmentSearchBoxes(attId);
      if (cached.length) return cached;
    }
    boxFetch.add(attId);
    toast('Finding that text on the page…');
    try {
      await NotesStore.loadAccount().catch(() => {});
      const file = NotesPreview.fileFromBytes(entry.bytes, entry.filename, entry.mime);
      const ocr = await ensureAttachmentOcr(attId, file);
      if (ocr.boxes.length) return ocr.boxes;
      if (ocr.text) return [];
      toast('Could not map that text onto the page', true);
      return [];
    } catch (err) {
      toast(err.message || 'Could not locate the text on the page', true);
      return [];
    } finally {
      boxFetch.delete(attId);
    }
  }

  async function resolveSearchBoxes(attId, stage, entry, needle, paintToken) {
    if (previewHasHits(stage)) return attachmentSearchBoxes(attId);
    const cached = attachmentSearchBoxes(attId);
    if (cached.length) return cached;
    const boxes = await fetchSearchBoxes(attId, entry);
    if (paintToken !== docPaintToken || !stage.isConnected) return boxes;
    return attachmentSearchBoxes(attId);
  }

  async function waitForStageLayout(stage) {
    if (!stage) return 900;
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (w > 120 && h > 120) return w;
    }
    return previewStageWidth(stage);
  }

  function previewStageWidth(stage) {
    const w = stage?.clientWidth || 0;
    if (w > 120) return w;
    const inner = window.innerWidth || 900;
    return Math.max(240, Math.min(900, inner - 32));
  }

  async function paintDocumentSearch(attId, stage, entry, query) {
    if (!stage || !entry) return;
    clearDocStageLoading(stage);
    const paintToken = ++docPaintToken;
    const needle = String(query || '').trim();
    const maxWidth = previewStageWidth(stage);

    if (entry.kind === 'pdf') {
      // Inline (in-note) previews on iPhone stay tiny; the full-screen viewer
      // may render more pages within the platform canvas budget.
      const inlineMaxPages = IS_IOS && stage.closest('#doc-inline') ? 3 : undefined;
      if (!needle) {
        await NotesPreview.renderPdfDocument(entry.bytes, stage, {
          maxWidth,
          query: '',
          showExcerpt: false,
          ...(inlineMaxPages ? { maxPages: inlineMaxPages } : {}),
        });
        return;
      }
      await ensureOpenedAttachmentIndexed(attId, entry);
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      let ocrText = attachmentSearchText(attId);
      let boxes = attachmentSearchBoxes(attId);
      await NotesPreview.renderPdfDocument(entry.bytes, stage, {
        maxWidth,
        query: needle,
        ocrText,
        ocrBoxes: boxes,
        showExcerpt: true,
        ...(inlineMaxPages ? { maxPages: inlineMaxPages } : {}),
      });
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      if (!attachmentSearchBoxes(attId).length) {
        boxes = await resolveSearchBoxes(attId, stage, entry, needle, paintToken);
        if (paintToken !== docPaintToken || !stage.isConnected) return;
        ocrText = attachmentSearchText(attId);
      }
      if (boxes.length) {
        NotesPreview.repaintAllSearchHits(stage, boxes, needle);
      }
      if (!previewHasHits(stage) && !previewHasExcerpt(stage)) {
        NotesPreview.appendSearchExcerpt(stage, ocrText, needle);
      }
      revealSearchHits(stage, needle);
      return;
    }
    if (entry.kind === 'image') {
      if (!needle) {
        const img = document.createElement('img');
        img.src = entry.url;
        img.alt = entry.filename;
        stage.replaceChildren(img);
        return;
      }
      await ensureOpenedAttachmentIndexed(attId, entry);
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      let ocrText = attachmentSearchText(attId);
      let boxes = attachmentSearchBoxes(attId);
      const img = document.createElement('img');
      img.src = entry.url;
      img.alt = entry.filename;
      if (typeof img.decode === 'function') {
        try { await img.decode(); } catch (_) { /* paint after load instead */ }
      }
      stage.replaceChildren(NotesPreview.wrapMediaWithHits(img, boxes, needle));
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      boxes = await resolveSearchBoxes(attId, stage, entry, needle, paintToken);
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      ocrText = attachmentSearchText(attId);
      NotesPreview.repaintAllSearchHits(stage, boxes, needle);
      if (!previewHasExcerpt(stage)) NotesPreview.appendSearchExcerpt(stage, ocrText, needle);
      revealSearchHits(stage, needle);
      return;
    }
    if (entry.kind === 'text') {
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      NotesPreview.renderTextPreview(stage, entry.bytes, needle);
      if (needle) revealSearchHits(stage, needle);
    }
  }

  function showHitNote(stage, text, { index = 0, count = 0 } = {}) {
    const host = NotesPreview.hitNoteHost(stage);
    if (!host) return;
    host.querySelectorAll('.doc-hit-note').forEach((el) => el.remove());
    if (!text) return;
    const note = document.createElement('div');
    note.className = 'doc-hit-note';
    const label = document.createElement('span');
    label.className = 'doc-hit-note-label';
    label.textContent = text;
    note.appendChild(label);
    if (count > 1) {
      const actions = document.createElement('span');
      actions.className = 'doc-hit-note-actions';
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'btn ghost sm';
      prev.dataset.docHitNav = 'prev';
      prev.setAttribute('aria-label', 'Previous match');
      prev.textContent = '↑';
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'btn ghost sm';
      next.dataset.docHitNav = 'next';
      next.setAttribute('aria-label', 'Next match');
      next.textContent = '↓';
      const counter = document.createElement('button');
      counter.type = 'button';
      counter.className = 'btn ghost sm doc-hit-note-count muted';
      counter.dataset.docHitCount = '1';
      counter.textContent = `${index + 1}/${count}`;
      if (host?.closest?.('#doc-inline') && stage?.dataset?.stage) {
        label.dataset.docPreviewOpen = stage.dataset.stage;
        label.title = 'Open full preview';
        counter.dataset.docPreviewOpen = stage.dataset.stage;
        counter.title = 'Open full preview';
        counter.setAttribute('aria-label', 'Open full preview');
      }
      actions.append(prev, counter, next);
      note.appendChild(actions);
    }
    const head = host.querySelector('.doc-viewer-head');
    if (head && head.parentElement === host) {
      head.insertAdjacentElement('afterend', note);
      return;
    }
    const card = host.querySelector('.doc-inline-card');
    if (card) host.insertBefore(note, card);
    else host.insertBefore(note, host.firstChild);
  }

  function activeDocSearchStage() {
    if (ui.docViewer && !ui.docViewer.hidden && ui.docStage) return ui.docStage;
    if (ui.docInline && !ui.docInline.hidden) {
      return ui.docInline.querySelector('.doc-inline-stage');
    }
    return null;
  }

  let docSearchHitIndex = 0;
  let findPaintNeedle = '';
  let findPaintPromise = null;

  function updateDocHitNoteCount(stage, index, count) {
    const host = NotesPreview.hitNoteHost(stage);
    const counter = host?.querySelector('[data-doc-hit-count]');
    if (counter) counter.textContent = `${index + 1}/${count}`;
    const summary = NotesPreview.hitSummary(stage);
    const label = host?.querySelector('.doc-hit-note-label');
    if (label && summary.count) {
      const hit = NotesPreview.listSearchHits(stage)[index];
      let page = summary.page;
      if (hit) {
        const wraps = [...stage.querySelectorAll('.doc-page-wrap')];
        const wrap = hit.closest('.doc-page-wrap');
        const idx = wrap ? wraps.indexOf(wrap) : -1;
        if (idx >= 0) page = idx + 1;
      }
      const where = summary.pages > 1 && page ? ` on page ${page} of ${summary.pages}` : '';
      const many = summary.count === 1 ? '1 match' : `${summary.count} matches`;
      label.textContent = `${many}${where}`;
    }
  }

  function findBarInDocViewer() {
    const bar = document.getElementById('find-bar');
    const slot = document.getElementById('doc-viewer-find-slot');
    return !!(bar && slot?.contains(bar));
  }

  function ensureDocFindHits(stage, attId, needle) {
    const q = String(needle || '').trim();
    if (!stage || !q) return [];
    if (attId) {
      const boxes = attachmentSearchBoxes(attId);
      if (boxes.length) NotesPreview.repaintAllSearchHits(stage, boxes, q);
    }
    let hits = NotesPreview.listSearchHits(stage);
    if (!hits.length && attId) {
      const stored = NotesPreview.countStoredSearchHits(stage);
      if (stored && attId) {
        const boxes = attachmentSearchBoxes(attId);
        NotesPreview.repaintAllSearchHits(stage, boxes, q);
        hits = NotesPreview.listSearchHits(stage);
      }
    }
    if (!hits.length && attId && !previewHasExcerpt(stage)) {
      NotesPreview.appendSearchExcerpt(stage, attachmentSearchText(attId), q);
      hits = NotesPreview.listSearchHits(stage);
    }
    return hits;
  }

  function docFindSearchRoot(stage) {
    if (!stage) return null;
    return stage.querySelector('.doc-zoom-layer') || stage;
  }

  function resolveDocFindHits(stage, attId, needle) {
    const q = String(needle || '').trim();
    if (!stage || !q) return [];
    const root = docFindSearchRoot(stage);
    let hits = NotesPreview.listSearchHits(root);
    if (hits.length) return hits;
    if (NotesPreview.countStoredSearchHits(root) > 0) {
      ensureDocFindHits(stage, attId, q);
      hits = NotesPreview.listSearchHits(root);
      if (hits.length) return hits;
    }
    ensureDocFindHits(stage, attId, q);
    return NotesPreview.listSearchHits(root);
  }

  function syncDocFindCounter(stage, index = docSearchHitIndex) {
    const counter = document.getElementById('find-count');
    const status = document.getElementById('find-doc-status');
    const bar = document.getElementById('find-bar');
    if (!counter || !bar || bar.hidden) return;
    const needle = currentFindQuery();
    const liveStage = stage || activeDocSearchStage();
    const attId = liveStage?.dataset?.stage || previewingId;
    const hits = liveStage && needle
      ? resolveDocFindHits(liveStage, attId, needle)
      : (liveStage ? NotesPreview.listSearchHits(docFindSearchRoot(liveStage) || liveStage) : []);
    if (!hits.length) {
      counter.textContent = '0/0';
      counter.removeAttribute('aria-label');
      if (status && findBarInDocViewer() && needle) {
        status.textContent = 'No matches in this document';
        status.classList.add('is-empty');
        status.hidden = false;
      } else if (status) {
        status.hidden = true;
        status.textContent = '';
        status.classList.remove('is-empty');
      }
      return;
    }
    const idx = Math.max(0, Math.min(index, hits.length - 1));
    counter.textContent = `${idx + 1}/${hits.length}`;
    docSearchHitIndex = idx;
    findIndex = idx;
    findMatches = hits;
    const summary = liveStage ? NotesPreview.hitSummary(docFindSearchRoot(liveStage) || liveStage) : { count: hits.length, page: 0, pages: 0 };
    const hit = hits[idx];
    let page = summary.page;
    if (hit && liveStage) {
      const wraps = [...liveStage.querySelectorAll('.doc-page-wrap')];
      const wrap = hit.closest('.doc-page-wrap');
      const pageIdx = wrap ? wraps.indexOf(wrap) : -1;
      if (pageIdx >= 0) page = pageIdx + 1;
    }
    const where = summary.pages > 1 && page ? ` · p.${page}/${summary.pages}` : '';
    const many = hits.length === 1 ? '1 match' : `${hits.length} matches`;
    counter.setAttribute('aria-label', `${idx + 1} of ${hits.length} matches${where}`);
    if (status && findBarInDocViewer()) {
      status.textContent = `${many}${where}`;
      status.classList.remove('is-empty');
      status.hidden = false;
    } else if (status) {
      status.hidden = true;
      status.textContent = '';
      status.classList.remove('is-empty');
    }
  }

  function jumpDocSearchHit(delta = 1) {
    const stage = activeDocSearchStage();
    if (!stage) return;
    const root = docFindSearchRoot(stage) || stage;
    const hits = NotesPreview.listSearchHits(root);
    if (!hits.length) return;
    docSearchHitIndex = (docSearchHitIndex + delta) % hits.length;
    if (docSearchHitIndex < 0) docSearchHitIndex = hits.length - 1;
    findIndex = docSearchHitIndex;
    NotesPreview.scrollHitIntoViewSettled(root, docSearchHitIndex);
    updateDocHitNoteCount(stage, docSearchHitIndex, hits.length);
    syncDocFindCounter(stage, docSearchHitIndex);
  }

  function watchUserScroll(stage) {
    const hit = stage?.querySelector('.doc-search-hit') || stage;
    const scrollers = NotesPreview.scrollableAncestors
      ? NotesPreview.scrollableAncestors(hit)
      : [];
    const state = { cancelled: false };
    const targets = [...new Set([...scrollers, document])];
    const onUserScroll = (event) => {
      if (event.type === 'keydown') {
        const key = event.key || '';
        if (!/^(Arrow|Page|Home|End)/.test(key)) return;
      }
      state.cancelled = true;
    };
    const opts = { passive: true, capture: true };
    const names = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    names.forEach((name) => {
      targets.forEach((node) => node.addEventListener(name, onUserScroll, opts));
    });
    return {
      state,
      markProgrammatic() {},
      dispose() {
        names.forEach((name) => {
          targets.forEach((node) => node.removeEventListener(name, onUserScroll, opts));
        });
      },
    };
  }

  function revealSearchHits(stage, query) {
    if (!stage || !String(query || '').trim()) {
      showHitNote(stage, '');
      docSearchHitIndex = 0;
      return;
    }
    const summary = NotesPreview.hitSummary(stage);
    if (!summary.count) {
      showHitNote(stage, '');
      docSearchHitIndex = 0;
      return;
    }
    docSearchHitIndex = 0;
    findPaintNeedle = String(query || '').trim();
    const where = summary.pages > 1 ? ` on page ${summary.page} of ${summary.pages}` : '';
    const many = summary.count === 1 ? '1 match' : `${summary.count} matches`;
    showHitNote(stage, `${many}${where}`, { index: 0, count: summary.count });
    syncDocFindCounter(stage, 0);
    const root = docFindSearchRoot(stage) || stage;
    const watch = watchUserScroll(stage);
    let attempts = 0;
    const settle = () => {
      if (!stage.isConnected || watch.state.cancelled) {
        watch.dispose();
        return;
      }
      watch.markProgrammatic();
      NotesPreview.scrollHitIntoView(root, docSearchHitIndex);
      attempts += 1;
      if (attempts < 10 && !NotesPreview.hitIsOnScreen(root, docSearchHitIndex)) {
        setTimeout(settle, 80);
      } else {
        watch.dispose();
      }
    };
    settle();
  }

  async function repaintInlineSearch(noteId, attId, stage) {
    if (!stage || boxFetch.has(attId)) return;
    try {
      const entry = await cachedPreview(attId);
      if (currentId !== noteId || !stage.isConnected) return;
      await paintDocumentSearch(attId, stage, entry, activeFindNeedle());
    } catch (err) {
      if (stage.isConnected) {
        stage.innerHTML = `<p class="error">${escapeHtml(err.message || 'Preview unavailable offline')}</p>`;
      }
    }
  }

  let inlineNoteId = null;
  let inlineAttIds = '';
  let inlineSearch = '';

  function invalidateInlinePreview() {
    inlineAttIds = '';
  }

  function renderDocInline(noteId) {
    const items = NotesStore.listAttachments(noteId);
    if (!ui.docInline) return;
    if (!items.length) {
      ui.docInline.hidden = true;
      ui.docInline.innerHTML = '';
      inlineNoteId = null;
      inlineAttIds = '';
      inlineSearch = '';
      syncEditorDocPreviewLayout();
      return;
    }
    const query = activeFindNeedle();
    const show = editorMode === 'preview' || !!query;
    ui.docInline.hidden = !show;
    const ids = items.map((a) => a.uuid).join(',');
    const [first, ...rest] = items;
    const stage = ui.docInline.querySelector('.doc-inline-stage');
    const hydrated = stage && stage.querySelector('img, canvas, pre, .doc-page-wrap');
    if (inlineNoteId === noteId && inlineAttIds === ids && hydrated && inlineSearch !== query) {
      inlineSearch = query;
      if (show) repaintInlineSearch(noteId, first.uuid, stage);
      return;
    }
    if (inlineNoteId === noteId && inlineAttIds === ids && inlineSearch === query && hydrated) {
      if (query && stage && !previewHasHits(stage) && !previewHasExcerpt(stage)) {
        repaintInlineSearch(noteId, first.uuid, stage);
      }
      return;
    }
    inlineNoteId = noteId;
    inlineAttIds = ids;
    inlineSearch = query;
    const galleryIndex = Math.max(0, items.findIndex((a) => a.uuid === first.uuid));
    const countBtn = items.length > 1
      ? `<button type="button" class="doc-inline-count" data-doc-gallery-open data-note-id="${escapeAttr(noteId)}" data-index="${galleryIndex}" aria-label="Open item ${galleryIndex + 1} of ${items.length}">${galleryIndex + 1} / ${items.length}</button>`
      : '';
    const desktop = isDesktopLayout();
    const mainInner = `<div class="doc-inline-stage is-loading" data-stage="${escapeAttr(first.uuid)}">${docLoadingHtml()}</div>
          ${desktop ? '' : `<div class="doc-thumb-meta"><span>${escapeHtml(first.content.filename || 'Document')}</span></div>`}`;
    const toolbar = `<div class="doc-inline-tools">
          <button type="button" class="btn ghost sm doc-inline-expand" data-preview="${escapeAttr(first.uuid)}">Fullscreen</button>
          <button type="button" class="btn ghost sm doc-inline-share" data-share="${escapeAttr(first.uuid)}">Share</button>
        </div>`;
    const mainBlock = desktop
      ? `${toolbar}<div class="doc-inline-main doc-inline-main-scroll">${mainInner}</div>`
      : `${toolbar}<button type="button" class="doc-inline-main" data-preview="${escapeAttr(first.uuid)}" aria-label="Open ${escapeAttr(first.content.filename || 'document')}">
          ${mainInner}
        </button>`;
    ui.docInline.innerHTML = `<div class="doc-inline-card">
        ${countBtn}
        ${mainBlock}
      </div>${items.length > 1 ? `<div class="doc-inline-thumbs">${rest.map((a) => `<button type="button" class="doc-thumb" data-preview="${escapeAttr(a.uuid)}">
        <div class="doc-thumb-stage" data-stage="${escapeAttr(a.uuid)}"></div>
        <div class="doc-thumb-meta">${escapeHtml(a.content.filename || 'Document')}</div>
      </button>`).join('')}</div>` : ''}`;
    ui.docInline.querySelectorAll('[data-doc-gallery-open]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openDocGalleryAt(btn.dataset.noteId, Number(btn.dataset.index) || 0);
      });
    });
    ui.docInline.querySelectorAll('[data-preview]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const open = activeFindNeedle()
          ? openDocPreviewFromSearch(btn.dataset.preview, { noteId, hitIndex: docSearchHitIndex })
          : openDocPreview(btn.dataset.preview, { noteId });
        open.catch((err) => toast(err.message || 'Preview failed', true));
      });
    });
    ui.docInline.querySelectorAll('[data-share]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        shareAttachment(btn.dataset.share).catch((err) => toast(err.message || 'Share failed', true));
      });
    });
    if (!show) return;
    hydrateInlineDoc(noteId, first.uuid, ui.docInline.querySelector(`[data-stage="${first.uuid}"]`));
    rest.forEach((a) => {
      observeThumb(noteId, a.uuid, ui.docInline.querySelector(`[data-stage="${a.uuid}"]`));
    });
    syncEditorDocPreviewLayout();
  }

  function scheduleSearchHitRepaint(attId, stage, query) {
    finishDocPreviewFind(stage, query, docSearchHitIndex);
  }

  function finishDocPreviewFind(stage, query, hitIndex = docSearchHitIndex, attempt = 0) {
    const needle = String(query || '').trim();
    if (!needle || !stage) return;
    const settle = async () => {
      if (!stage.isConnected) return;
      const attId = stage.dataset?.stage || previewingId;
      const root = docFindSearchRoot(stage) || stage;
      let hits = resolveDocFindHits(stage, attId, needle);
      if (!hits.length && attempt < 4) {
        setTimeout(() => finishDocPreviewFind(stage, query, hitIndex, attempt + 1), attempt ? 120 : 0);
        return;
      }
      if (!hits.length) {
        showHitNote(stage, '');
        findPaintNeedle = needle;
        syncDocFindCounter(stage, 0);
        return;
      }
      const idx = Math.max(0, Math.min(hitIndex, hits.length - 1));
      docSearchHitIndex = idx;
      findIndex = idx;
      findMatches = hits;
      findPaintNeedle = needle;
      await NotesPreview.scrollHitIntoViewAsync(root, idx);
      const summary = NotesPreview.hitSummary(root);
      const hit = hits[idx];
      let page = summary.page;
      if (hit) {
        const wraps = [...root.querySelectorAll('.doc-page-wrap')];
        const wrap = hit.closest('.doc-page-wrap');
        const pageIdx = wrap ? wraps.indexOf(wrap) : -1;
        if (pageIdx >= 0) page = pageIdx + 1;
      }
      const where = summary.pages > 1 && page ? ` on page ${page} of ${summary.pages}` : '';
      const many = hits.length === 1 ? '1 match' : `${hits.length} matches`;
      const inDocViewer = stage.closest('#doc-stage');
      if (!(inDocViewer && findBarInDocViewer())) {
        showHitNote(stage, `${many}${where}`, { index: idx, count: hits.length });
      } else {
        showHitNote(stage, '');
      }
      syncDocFindCounter(stage, idx);
    };
    if (attempt === 0) requestAnimationFrame(() => { settle().catch(() => {}); });
    else settle().catch(() => {});
  }

  function openInlineDocFullscreen(attId, event) {
    if (!attId) return;
    if (noteProtectionBlocks(attId, currentId)) {
      toast('Unlock this note first — enter your vault password on the note screen', true);
      return;
    }
    const open = activeFindNeedle()
      ? openDocPreviewFromSearch(attId, { noteId: currentId, hitIndex: docSearchHitIndex })
      : openDocPreview(attId, { noteId: currentId });
    open.catch((err) => toast(err.message || 'Preview failed', true));
    event?.preventDefault?.();
    event?.stopPropagation?.();
  }

  function bindInlinePreviewGestures() {
    const host = ui.docInline;
    if (!host || host._previewGesturesBound) return;
    host._previewGesturesBound = true;
    let lastTouchTap = 0;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let suppressClickUntil = 0;

    host.addEventListener('dblclick', (event) => {
      const stage = event.target?.closest?.('.doc-inline-stage, .doc-thumb-stage');
      const attId = stage?.dataset?.stage;
      if (!attId) return;
      openInlineDocFullscreen(attId, event);
    });

    host.addEventListener('touchend', (event) => {
      const stage = event.target?.closest?.('.doc-inline-stage, .doc-thumb-stage');
      const attId = stage?.dataset?.stage;
      if (!attId || event.touches.length) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const now = Date.now();
      const dist = Math.hypot(touch.clientX - lastTouchX, touch.clientY - lastTouchY);
      if (now - lastTouchTap < 320 && dist < 48) {
        suppressClickUntil = now + 500;
        openInlineDocFullscreen(attId, event);
        lastTouchTap = 0;
        return;
      }
      lastTouchTap = now;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;
    }, { passive: false });

    host.addEventListener('click', (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  async function openDocPreviewFromSearch(attId, opts = {}) {
    const needle = activeFindNeedle();
    const hitIndex = typeof opts.hitIndex === 'number' ? opts.hitIndex : docSearchHitIndex;
    findPaintPromise = null;
    if (needle || findBarOpen()) showFindBar({ deferRunFind: true });
    if (needle) {
      const input = document.getElementById('find-input');
      if (input && !String(input.value || '').trim()) input.value = needle;
    }
    await openDocPreview(attId, {
      noteId: opts.noteId || currentId,
      keepGallery: opts.keepGallery,
      galleryIndex: opts.galleryIndex,
      preserveHitIndex: hitIndex,
    });
    syncDocFindCounter(ui.docStage, hitIndex);
    requestAnimationFrame(() => syncDocFindCounter(ui.docStage, hitIndex));
  }

  function attachmentParentNoteId(attId, noteId) {
    return noteId || NotesStore.get(attId)?.content?.note_id || currentId || null;
  }

  function noteProtectionBlocks(attId, noteId) {
    const parentId = attachmentParentNoteId(attId, noteId);
    if (!parentId) return false;
    const note = NotesStore.get(parentId);
    return !!(note?.content?.locked && !unlockedNotes.has(parentId));
  }

  let docChromeRevealTimer = null;
  let docChromeTapTimer = null;

  function setDocImmersive(on) {
    document.body.classList.toggle('doc-immersive', !!on);
    if (!on) {
      document.body.classList.remove('doc-chrome-reveal');
      clearTimeout(docChromeRevealTimer);
      clearTimeout(docChromeTapTimer);
      docChromeRevealTimer = null;
      docChromeTapTimer = null;
    }
    const closeBtn = document.getElementById('doc-immersive-close');
    if (closeBtn) closeBtn.hidden = !on;
    const shareBtn = document.getElementById('doc-immersive-share');
    if (shareBtn) shareBtn.hidden = !on;
  }

  function revealDocChromeTemporary(ms = 4000) {
    if (!document.body.classList.contains('doc-immersive')) return;
    document.body.classList.add('doc-chrome-reveal');
    clearTimeout(docChromeRevealTimer);
    if (!ms) return;
    docChromeRevealTimer = setTimeout(() => {
      document.body.classList.remove('doc-chrome-reveal');
      docChromeRevealTimer = null;
    }, ms);
  }

  function bindDocStageChromeReveal() {
    if (!ui.docStage || ui.docStage._chromeRevealBound) return;
    ui.docStage._chromeRevealBound = true;
    ui.docStage.addEventListener('click', (event) => {
      if (!document.body.classList.contains('doc-immersive')) return;
      if (event.target?.closest?.('.doc-viewer-head, button, a, input, textarea')) return;
      clearTimeout(docChromeTapTimer);
      docChromeTapTimer = setTimeout(() => {
        docChromeTapTimer = null;
        revealDocChromeTemporary();
      }, 320);
    });
  }

  async function openDocPreview(id, opts = {}) {
    const item = NotesStore.get(id);
    if (!item || !ui.docViewer) return;
    const noteId = opts.noteId || currentId;
    if (noteProtectionBlocks(id, noteId)) {
      toast('Unlock this note first — enter your vault password on the note screen', true);
      return;
    }
    if (noteId && !opts.keepGallery) {
      const ids = attachmentIdsForNote(noteId);
      const idx = typeof opts.galleryIndex === 'number'
        ? opts.galleryIndex
        : Math.max(0, ids.indexOf(id));
      if (ids.length > 1) docGallery = { noteId, ids, index: idx };
      else docGallery = null;
    } else if (docGallery && noteId && docGallery.noteId === noteId) {
      const idx = docGallery.ids.indexOf(id);
      if (idx >= 0) docGallery.index = idx;
    }
    previewingId = id;
    ui.docTitle.textContent = item.content.filename || 'Document';
    if (docGallery && refreshDocGalleryIds() && docGallery.ids.length > 1) {
      ui.docTitle.textContent = `${item.content.filename || 'Document'} (${docGallery.index + 1}/${docGallery.ids.length})`;
    }
    showDocStageLoading(ui.docStage);
    if (ui.docStage._docZoom) ui.docStage._docZoom.destroy();
    ui.docViewer.hidden = false;
    document.body.classList.add('doc-preview-open');
    setDocImmersive(!isDesktopLayout());
    bindDocStageChromeReveal();
    if (activeFindNeedle()) revealDocChromeTemporary(0);
    if (activeFindNeedle()) mountFindBarToDocViewer();
    else restoreFindBarToEditor();
    if (activeFindNeedle() && findBarOpen()) layoutFindBarOverDocViewer();
    updateDocGalleryNav();
    await waitForStageLayout(ui.docStage);
    try {
      const entry = await cachedPreview(id);
      if (previewingId !== id) return;
      const query = activeFindNeedle();
      const hitIndex = typeof opts.preserveHitIndex === 'number' ? opts.preserveHitIndex : docSearchHitIndex;
      if (entry.kind === 'image') {
        await paintDocumentSearch(id, ui.docStage, entry, query);
        attachDocZoom(ui.docStage, 'image');
        const host = ui.docStage.closest?.('.doc-zoom-host') || ui.docStage;
        const img = host.querySelector('img');
        if (img && NotesPreview.rememberImagePaint) NotesPreview.rememberImagePaint(host, img);
        if (query) finishDocPreviewFind(ui.docStage, query, hitIndex);
        return;
      }
      if (entry.kind === 'pdf') {
        if (previewingId !== id) return;
        await NotesPreview.ensurePdf();
        await paintDocumentSearch(id, ui.docStage, entry, query);
        attachDocZoom(ui.docStage, 'pdf');
        if (query) finishDocPreviewFind(ui.docStage, query, hitIndex);
        return;
      }
      if (entry.kind === 'text') {
        clearDocStageLoading(ui.docStage);
        NotesPreview.renderTextPreview(ui.docStage, entry.bytes, query);
        attachDocZoom(ui.docStage, 'text');
        if (query) finishDocPreviewFind(ui.docStage, query, hitIndex);
        return;
      }
      clearDocStageLoading(ui.docStage);
      ui.docStage.innerHTML = '<p class="muted">This file type cannot be previewed. Download it instead.</p>';
    } catch (err) {
      clearDocStageLoading(ui.docStage);
      ui.docStage.innerHTML = `<p class="error">${escapeHtml(err.message || 'Preview failed')}</p>`;
    }
  }

  function closeDocPreview() {
    previewingId = null;
    docGallery = null;
    restoreFindBarToEditor();
    if (!ui.docViewer) return;
    if (ui.docStage._docZoom) ui.docStage._docZoom.destroy();
    updateDocZoomLabel();
    setDocImmersive(false);
    document.body.classList.remove('doc-preview-open');
    if (ui.docViewer) ui.docViewer.style.paddingTop = '';
    ui.docViewer.hidden = true;
    ui.docBackdrop.hidden = true;
    ui.docStage.replaceChildren();
  }

  async function downloadAttachment(id) {
    if (noteProtectionBlocks(id)) {
      toast('Unlock this protected note first', true);
      return;
    }
    const item = NotesStore.get(id);
    if (!item) return;
    const bytes = await NotesStore.getAttachmentBytes(id);
    const blob = new Blob([bytes], { type: NotesPreview.mimeFromMeta(item.content.mime, item.content.filename) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.content.filename || 'attachment';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function shareAttachment(id) {
    if (noteProtectionBlocks(id)) {
      toast('Unlock this protected note first', true);
      return;
    }
    const item = NotesStore.get(id);
    if (!item) return;
    const bytes = await NotesStore.getAttachmentBytes(id);
    const file = NotesPreview.fileFromBytes(bytes, item.content.filename || 'document', item.content.mime);
    const payload = { files: [file], title: item.content.filename || 'Document' };
    if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(payload))) {
      try {
        await navigator.share(payload);
        return;
      } catch (err) {
        if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) return;
      }
    }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: item.content.filename || 'Document',
          text: item.content.filename || 'Document',
        });
        toast('This device cannot attach the file. Use Download, then add it in Mail.');
        return;
      } catch (err) {
        if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) return;
      }
    }
    await downloadAttachment(id);
    toast('Sharing is not available here. The file was downloaded instead.');
  }

  async function shareNote(noteId = currentId) {
    const id = noteId || currentId;
    if (!id) return;
    const note = NotesStore.get(id);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(id)) {
      toast('Unlock this protected note first', true);
      return;
    }
    const title = note.content.title || 'Untitled';
    const body = note.content.content || '';
    const text = `# ${title}\n\n${body}`.trim();
    const filename = `${(title || 'note').replace(/[^\w-]+/g, '-')}.md`;

    // Try web share API first
    if (typeof navigator.share === 'function') {
      try {
        let file = null;
        try {
          file = new File([text], filename, { type: 'text/markdown' });
        } catch (_) {}
        const payloadWithFile = file ? { files: [file], title, text } : null;
        if (payloadWithFile && (!navigator.canShare || navigator.canShare(payloadWithFile))) {
          await navigator.share(payloadWithFile);
          return;
        }
        if (!navigator.canShare || navigator.canShare({ title, text })) {
          await navigator.share({ title, text });
          return;
        }
      } catch (err) {
        if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) return;
      }
    }

    // Fallback: copy to clipboard or download markdown file
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Note copied to clipboard');
        return;
      }
    } catch (_) {}

    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast('Note exported');
  }

  function renderHistory(note) {
    if (!revisions.length) {
      ui.historyList.innerHTML = '<p class="muted">No previous versions yet.</p>';
      return;
    }
    ui.historyList.innerHTML = revisions
      .map((rev, idx) => {
        const when = new Date(rev.at).toLocaleString();
        return `<div class="history-item">
          <span><strong>${escapeHtml(rev.title || 'Untitled')}</strong><br><span class="muted">${when}</span></span>
          <button class="btn ghost sm" data-rev="${idx}">Restore</button>
        </div>`;
      })
      .join('');
    ui.historyList.querySelectorAll('[data-rev]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rev = revisions[Number(btn.dataset.rev)];
        if (!rev) return;
        const ok = await confirmAction(
          'Restore this version? Current text will be saved to history.',
          { title: 'Restore version', confirmLabel: 'Restore' },
        );
        if (!ok) return;
        NotesStore.restoreRevision(currentId, rev);
        openNote(currentId);
      });
    });
  }

  function noteHasDocs(noteId) {
    return NotesStore.listAttachments(noteId || currentId).length > 0;
  }

  function ocrMarkdown(noteId) {
    const atts = NotesStore.listAttachments(noteId || currentId);
    const parts = atts.map((item) => String(item.content.ocr_text || '').trim()).filter(Boolean);
    if (parts.length) return parts.join('\n\n');
    if (atts.some((item) => !item.content.ocr_method)) return '';
    return '';
  }

  function docSearchActive() {
    return !!currentId && noteHasDocs(currentId) && !!activeFindNeedle();
  }

  function syncEditorModeForSearch() {
    /* inline PDF search highlights use docSearchActive() — no mode switch needed */
  }

  function syncEditorBodyWrap() {
    const wrap = document.getElementById('note-body-wrap');
    if (!wrap) return;
    wrap.hidden = !!ui.body?.hidden;
  }

  function syncEditorDocPreviewLayout() {
    const active = !!currentId
      && noteHasDocs(currentId)
      && editorMode === 'preview'
      && !ui.docInline?.hidden;
    ui.editor?.classList.toggle('doc-preview-active', active);
    document.body.classList.toggle('editor-doc-preview', active && isDesktopLayout());
  }

  function applyEditorMode() {
    const ocrBtn = document.getElementById('btn-ocr-text');
    const previewBtn = document.getElementById('btn-preview');
    const toolbar = document.getElementById('md-toolbar');
    const hasDocs = noteHasDocs(currentId);
    if (ocrBtn) ocrBtn.hidden = !hasDocs;
    if (!currentId) {
      if (previewBtn) previewBtn.hidden = true;
      return;
    }
    const note = NotesStore.get(currentId);
    const gated = !!note?.content?.locked && !unlockedNotes.has(currentId);
    if (gated) return;
    if (hasDocs && editorMode === 'preview') {
      ui.body.hidden = true;
      ui.preview.hidden = true;
      if (toolbar) toolbar.hidden = true;
      if (ui.docInline) ui.docInline.hidden = false;
      if (previewBtn) previewBtn.textContent = 'Edit';
      if (ocrBtn) ocrBtn.textContent = 'OCR text';
      previewOn = false;
      if (!vaultPullActive) renderDocInline(currentId);
      syncEditorBodyWrap();
      if (previewBtn) previewBtn.hidden = false;
      if (note) syncTagBarShell(note);
      return;
    }
    if (hasDocs && editorMode === 'ocr') {
      ui.body.hidden = true;
      ui.preview.hidden = false;
      if (toolbar) toolbar.hidden = true;
      if (ui.docInline) ui.docInline.hidden = true;
      const text = ocrMarkdown(currentId);
      ui.preview.innerHTML = text
        ? NotesMarkdown.render(text)
        : '<p class="muted">OCR is still running, or no text was found. Stay on the document preview in the meantime.</p>';
      highlightPreview();
      if (previewBtn) previewBtn.textContent = 'Document';
      if (ocrBtn) ocrBtn.textContent = 'Edit';
      previewOn = false;
      syncEditorBodyWrap();
      syncEditorDocPreviewLayout();
      if (previewBtn) previewBtn.hidden = false;
      if (note) syncTagBarShell(note);
      return;
    }
    const type = note?.content?.editor || ui.editorType.value || 'plain';
    const checklistOn = isChecklistEditor(type);
    const editingLocked = !!note?.content?.prevent_edit;
    if (editingLocked) editorMode = 'preview';
    ui.editor?.classList.remove('rich-live-edit');
    previewOn = editingLocked || editorMode !== 'edit';
    ui.preview.hidden = !previewOn || checklistOn;
    ui.body.hidden = previewOn || checklistOn;
    if (previewOn && !checklistOn) refreshPreview();
    syncEditorBodyWrap();
    syncEditLinkOverlay();
    if (ui.checklist) ui.checklist.hidden = !checklistOn;
    if (toolbar) toolbar.hidden = previewOn || checklistOn || type === 'plain';
    if (toolbar) {
      toolbar.querySelectorAll('[data-md="sup"]').forEach((btn) => {
        btn.hidden = type !== 'superscript';
      });
    }
    if (ui.docInline) ui.docInline.hidden = true;
    if (previewBtn) {
      previewBtn.hidden = checklistOn || !hasDocs;
      if (hasDocs && editorMode === 'edit') previewBtn.textContent = 'Document';
      else if (hasDocs) previewBtn.textContent = 'Edit';
      previewBtn.disabled = false;
    }
    if (ocrBtn) ocrBtn.textContent = 'OCR text';
    if (checklistOn) renderChecklist(note);
    if (docSearchActive()) {
      ui.docInline.hidden = false;
      renderDocInline(currentId);
    }
    applyReadOnly(!!note?.content?.prevent_edit);
    syncEditorDocPreviewLayout();
    if (note) {
      syncClearCheckedButton(note);
      syncTagBarShell(note);
    }
  }

  function applyReadOnly(on) {
    const banner = document.getElementById('note-readonly-banner');
    if (banner) {
      banner.hidden = !on;
      banner.textContent = on
        ? 'Editing is disabled for this note. Tap the lock icon in the toolbar to allow changes.'
        : '';
    }
    ui.title.readOnly = !!on;
    ui.body.readOnly = !!on;
    ui.editorType.disabled = !!on;
    const toolbar = document.getElementById('md-toolbar');
    if (toolbar) {
      toolbar.querySelectorAll('button').forEach((btn) => {
        btn.disabled = !!on;
      });
    }
    if (ui.checklist) ui.checklist.classList.toggle('readonly', !!on);
    document.body.classList.toggle('note-readonly', !!on);
    if (on) editorMode = 'preview';
  }

  function noteEditingLocked() {
    const note = currentId ? NotesStore.get(currentId) : null;
    return !!note?.content?.prevent_edit;
  }

  function renderChecklist(note) {
    if (!ui.checklist || !window.NotesChecklist) return;
    const nested = (note.content.editor || '') === 'super';
    let rows = NotesChecklist.parse(note.content.content || ui.body.value, { nested });
    const commit = (next, opts) => {
      rows = next;
      writeChecklist(next, nested, opts);
    };
    const addItem = (afterId, initialText = '', { skipUndo = false } = {}) => {
      if (!skipUndo) pushUndoSnapshot();
      const at = afterId ? rows.findIndex((row) => row.id === afterId) : -1;
      const insertIndex = at >= 0 ? at + 1 : rows.length;
      const next = NotesChecklist.addRow(rows, afterId, { nested, text: initialText });
      const added = next[insertIndex];
      commit(next, { keepFocus: added?.id, focusIndex: insertIndex });
    };
    ui.checklist.innerHTML = rows.map((row) => `
      <div class="check-row" data-check-id="${escapeAttr(row.id)}" style="--indent:${row.indent || 0}">
        <button type="button" class="check-box" data-check-toggle="${escapeAttr(row.id)}" aria-checked="${row.done}">${row.done ? '☑' : '☐'}</button>
        <div class="check-text-wrap">
          <div class="check-text-links" aria-hidden="true"></div>
          <input class="check-text" data-check-text="${escapeAttr(row.id)}" value="${escapeAttr(row.text)}" placeholder="List item" ${note.content.prevent_edit ? 'readonly' : ''}>
        </div>
        ${nested ? `<button type="button" class="btn ghost sm check-indent" data-check-indent="${escapeAttr(row.id)}" aria-label="Indent">⇥</button>` : ''}
      </div>`).join('') + (note.content.prevent_edit ? '' : '<button type="button" class="btn ghost sm check-add" id="check-add">Add item</button>');
    ui.checklist.querySelectorAll('[data-check-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (note.content.prevent_edit) return;
        pushUndoSnapshot();
        commit(NotesChecklist.toggle(rows, btn.dataset.checkToggle));
      });
    });
    ui.checklist.querySelectorAll('[data-check-text]').forEach((input) => {
      input.addEventListener('beforeinput', () => {
        if (!note.content.prevent_edit) pushUndoSnapshot();
      });
      input.addEventListener('input', () => {
        if (note.content.prevent_edit) return;
        commit(NotesChecklist.setText(rows, input.dataset.checkText, input.value), { rerender: false });
        const layer = input.parentElement?.querySelector('.check-text-links');
        if (layer && window.NotesLinkOverlay?.renderHtml) {
          layer.innerHTML = NotesLinkOverlay.renderHtml(input.value);
        }
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || note.content.prevent_edit) return;
        event.preventDefault();
        const pos = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
        const currentVal = input.value;
        const head = currentVal.slice(0, pos);
        const tail = currentVal.slice(pos).trimStart();
        rows = NotesChecklist.setText(rows, input.dataset.checkText, head);
        addItem(input.dataset.checkText, tail, { skipUndo: true });
      });
    });
    ui.checklist.querySelectorAll('[data-check-indent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (note.content.prevent_edit) return;
        pushUndoSnapshot();
        commit(NotesChecklist.bumpIndent(rows, btn.dataset.checkIndent, 1));
      });
    });
    const add = document.getElementById('check-add');
    if (add) add.addEventListener('click', () => {
      addItem(rows[rows.length - 1]?.id);
    });
    syncClearCheckedButton(note);
    syncChecklistLinkOverlays(ui.checklist);
  }

  function syncClearCheckedButton(note) {
    const btn = document.getElementById('btn-clear-checked');
    if (!btn) return;
    if (!note) {
      btn.hidden = true;
      return;
    }
    const type = note.content?.editor || ui.editorType?.value || 'plain';
    if (!isChecklistEditor(type) || note.content?.prevent_edit) {
      btn.hidden = true;
      return;
    }
    const nested = type === 'super';
    const rows = window.NotesChecklist?.parse(note.content?.content || ui.body?.value || '', { nested }) || [];
    btn.hidden = !rows.some((row) => row.done);
  }

  function writeChecklist(rows, nested, { keepFocus, focusIndex, rerender = true } = {}) {
    const text = NotesChecklist.serialize(rows, { nested });
    ui.body.value = text;
    scheduleSave();
    const live = currentId ? NotesStore.get(currentId) : null;
    syncClearCheckedButton(live ? { content: { ...(live.content || {}), content: text, editor: nested ? 'super' : 'checklist' } } : null);
    if (!rerender) return;
    const note = NotesStore.get(currentId) || { content: { content: text, editor: nested ? 'super' : 'checklist' } };
    renderChecklist({ content: { ...(note.content || {}), content: text, editor: nested ? 'super' : 'checklist' } });
    if (typeof focusIndex === 'number') {
      const inputs = ui.checklist.querySelectorAll('.check-text');
      const target = inputs[focusIndex];
      if (target) {
        target.focus();
        if (typeof target.setSelectionRange === 'function') {
          target.setSelectionRange(0, 0);
        }
        return;
      }
    }
    if (keepFocus) {
      const el = ui.checklist.querySelector(`[data-check-text="${keepFocus}"]`);
      if (el) el.focus();
    }
  }

  function setEditorChrome(gated) {
    const gate = document.getElementById('note-lock-gate');
    const toolbar = document.getElementById('md-toolbar');
    const actions = document.querySelector('.editor-actions');
    const tagShell = document.getElementById('tag-bar-shell');
    gate.hidden = !gated;
    if (actions) actions.hidden = !!gated;
    if (tagShell) tagShell.hidden = !!gated;
    if (ui.editorType) ui.editorType.hidden = !!gated;
    ['btn-share', 'btn-note-info', 'btn-trash', 'btn-delete-forever', 'btn-clear-checked', 'btn-undo', 'btn-redo', 'btn-prevent-edit', 'btn-ai-chat', 'btn-star', 'btn-pin', 'btn-archive', 'btn-duplicate'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = !!gated;
    });
    if (gated) {
      toolbar.hidden = true;
      ui.body.hidden = true;
      ui.preview.hidden = true;
      if (ui.title) ui.title.readOnly = true;
      ui.body.value = '';
      closeNoteOptions();
      syncEditorBodyWrap();
      if (ui.docInline) {
        ui.docInline.hidden = true;
        ui.docInline.innerHTML = '';
      }
      const ocrBtn = document.getElementById('btn-ocr-text');
      if (ocrBtn) ocrBtn.hidden = true;
      hideFindBar();
      if (ui.attachmentList) ui.attachmentList.innerHTML = '';
      if (ui.attachments) ui.attachments.hidden = true;
      if (ui.historyList) ui.historyList.innerHTML = '';
      return;
    }
    const note = currentId ? NotesStore.get(currentId) : null;
    if (ui.title) ui.title.readOnly = !!note?.content?.prevent_edit;
    applyEditorMode();
  }

  function highlightPreview() {
    if (!ui.preview) return;
    const query = ui.search.value.trim();
    if (!query) return;
    NotesSearch.applyHighlights(ui.preview, query);
    const first = ui.preview.querySelector('mark.search-hit');
    if (first && typeof first.scrollIntoView === 'function') {
      first.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  function refreshPreview() {
    if (!previewOn) return;
    if (findBarOpen() && currentFindQuery()) {
      highlightFindPreview();
      return;
    }
    const editor = NotesStore.get(currentId)?.content?.editor || ui.editorType.value || 'plain';
    ui.preview.innerHTML = renderNoteBodyPreview(ui.body.value, editor);
    highlightPreview();
    bindPreviewTaskToggles();
  }

  function openNote(id, { skipGate = false } = {}) {
    const note = NotesStore.get(id);
    if (!note) return;
    if (currentId && currentId !== id) {
      unlockedNotes.delete(currentId);
    }
    const gated = !!note.content.locked && !unlockedNotes.has(id) && !skipGate;
    const alreadyEditing = !!currentId && ui.editor && !ui.editor.hidden;
    const syncing = vaultPullActive;
    flushSave();
    currentId = id;
    listSelectionId = id;
    rememberOpen(id);
    ui.empty.hidden = true;
    ui.editor.hidden = false;
    ui.shell.classList.add('editor-open');
    ui.title.value = note.content.title || '';
    let body = note.content.content || '';
    if (!gated && (note.content.editor || '') === 'superscript' && window.NotesSuperscript) {
      body = NotesSuperscript.normalizeContent(body);
      if (body !== (note.content.content || '')) {
        note.content.content = body;
        NotesStore.upsert(id, { ...note.content });
      }
    }
    ui.body.value = gated ? '' : body;
    resetNoteUndoStack(id);
    ui.editorType.value = note.content.editor || 'plain';
    editorMode = initialEditorMode(id);
    previewOn = editorMode !== 'edit';
    setEditorChrome(gated);
    if (gated) {
      document.getElementById('note-lock-error').hidden = true;
      document.getElementById('note-lock-password').value = '';
      document.getElementById('note-lock-password').focus();
    }
    if (tagBarNoteId !== id || !alreadyEditing) {
      tagBarNoteId = id;
      tagBarShowAll = defaultTagBarShowAll();
      tagBarExpanded = defaultTagBarExpanded();
    }
    if (!gated) {
      renderTagBar(note);
      renderAttachments(id);
      applyEditorMode();
      renderHistory(note);
      if (typeof NotesAiChat !== 'undefined') NotesAiChat.onNoteChanged(id);
    } else {
      if (ui.attachmentList) ui.attachmentList.innerHTML = '';
      if (ui.attachments) ui.attachments.hidden = true;
      if (ui.historyList) ui.historyList.innerHTML = '';
    }
    if (!gated && NotesStore.lightVaultEnabled?.() && note.content.attachments?.length) {
      // Light vault: opening a note downloads its files so they stay available offline.
      NotesStore.ensureNoteAttachmentsLocal(id).then((fetched) => {
        if (fetched && currentId === id) {
          renderAttachments(id);
          refreshLocalFilesSummary().catch(() => {});
        }
      }).catch(() => {});
    }
    if (syncing) {
      markActiveNoteRow();
      deferOpenNoteHeavyWork(id);
    } else {
      markActiveNoteRow();
      renderNotes();
      if (!gated) pullNoteOcrFromServer(id).catch(() => {});
    }
    updateActionButtons(note);
    updateNoteMeta(note);
    bindEditorKeyboardInset();
    try {
      const state = { notesView: 'editor', noteId: id };
      if (alreadyEditing || history.state?.notesView === 'editor') {
        history.replaceState(state, '', location.href);
      } else {
        history.pushState(state, '', location.href);
      }
    } catch (err) {
      /* ignore */
    }
  }

  function updateActionButtons(note) {
    const starBtn = document.getElementById('btn-star');
    const pinBtn = document.getElementById('btn-pin');
    if (pinBtn) {
      pinBtn.title = note.content.pinned ? 'Unpin' : 'Pin';
      pinBtn.setAttribute('aria-label', pinBtn.title);
      pinBtn.classList.toggle('active', !!note.content.pinned);
      const open = pinBtn.querySelector('.icon-pin-outline');
      const closed = pinBtn.querySelector('.icon-pin-filled');
      if (open && closed) {
        open.hidden = !!note.content.pinned;
        closed.hidden = !note.content.pinned;
      } else {
        pinBtn.textContent = note.content.pinned ? '★' : '☆';
      }
    }
    if (starBtn) {
      starBtn.title = note.content.starred ? 'Unstar' : 'Star';
      starBtn.setAttribute('aria-label', starBtn.title);
      starBtn.classList.toggle('active', !!note.content.starred);
      const open = starBtn.querySelector('.icon-star-outline');
      const closed = starBtn.querySelector('.icon-star-filled');
      if (open && closed) {
        open.hidden = !!note.content.starred;
        closed.hidden = !note.content.starred;
      } else {
        starBtn.textContent = note.content.starred ? '✦' : '✧';
      }
    }
    const archiveBtn = document.getElementById('btn-archive');
    if (archiveBtn) {
      archiveBtn.title = note.content.archived ? 'Unarchive' : 'Archive';
      archiveBtn.setAttribute('aria-label', archiveBtn.title);
      archiveBtn.classList.toggle('active', !!note.content.archived);
    }
    const preventBtn = document.getElementById('btn-prevent-edit');
    if (preventBtn) {
      const locked = !!note.content.prevent_edit;
      preventBtn.classList.toggle('is-locked', locked);
      preventBtn.classList.toggle('is-unlocked', !locked);
      preventBtn.classList.toggle('active', locked);
      preventBtn.title = locked ? 'Allow editing' : 'Lock editing';
      preventBtn.setAttribute('aria-label', preventBtn.title);
      preventBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
      preventBtn.querySelector('.edit-lock-open')?.toggleAttribute('hidden', locked);
      preventBtn.querySelector('.edit-lock-closed')?.toggleAttribute('hidden', !locked);
    }
    const trashBtn = document.getElementById('btn-trash');
    if (trashBtn) {
      trashBtn.title = note.content.trashed ? 'Restore' : 'Trash';
      trashBtn.setAttribute('aria-label', trashBtn.title);
      const trashIcon = trashBtn.querySelector('.icon-trash');
      const restoreIcon = trashBtn.querySelector('.icon-restore');
      if (trashIcon && restoreIcon) {
        trashIcon.hidden = !!note.content.trashed;
        restoreIcon.hidden = !note.content.trashed;
      } else {
        trashBtn.textContent = note.content.trashed ? '↩' : '🗑';
      }
    }
    document.getElementById('btn-delete-forever').hidden = !note.content.trashed;
    syncClearCheckedButton(note);
    if (note && note.content?.locked && !unlockedNotes.has(note.uuid)) {
      ['btn-share', 'btn-note-info', 'btn-trash', 'btn-delete-forever', 'btn-clear-checked', 'btn-undo', 'btn-redo', 'btn-prevent-edit', 'btn-ai-chat', 'btn-star', 'btn-pin', 'btn-archive', 'btn-duplicate'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
    }
    syncUndoButtons();
    syncNoteInfoActions(note);
  }

  function syncNoteInfoActions(note) {
    if (!note) return;
    const star = document.getElementById('note-info-star');
    const pin = document.getElementById('note-info-pin');
    const archive = document.getElementById('note-info-archive');
    const trash = document.getElementById('note-info-trash');
    if (star) {
      star.textContent = note.content.starred ? 'Unstar' : 'Star';
      star.classList.toggle('active', !!note.content.starred);
    }
    if (pin) {
      pin.textContent = note.content.pinned ? 'Unpin' : 'Pin';
      pin.classList.toggle('active', !!note.content.pinned);
    }
    if (archive) {
      archive.textContent = note.content.archived ? 'Unarchive' : 'Archive';
      archive.classList.toggle('active', !!note.content.archived);
    }
    if (trash) {
      trash.textContent = note.content.trashed ? 'Restore' : 'Move to trash';
      trash.classList.toggle('danger', !note.content.trashed);
    }
  }

  function updateNoteMeta(note) {
    if (note.content?.locked && !unlockedNotes.has(note.uuid)) {
      ui.noteMeta.textContent = 'Protected note';
      return;
    }
    const { words, minutes } = readingTime(noteReadableText(note));
    const updated = relativeTime(noteEditedAtMs(note));
    ui.noteMeta.textContent = `${words} words · ${minutes} min read · ${updated}`;
    const sheet = document.getElementById('note-options');
    if (sheet && !sheet.hidden && note.uuid === currentId) updateNoteInfoPanel(note);
  }

  function flushSave() {
    clearTimeout(saveDebounce);
    saveDebounce = null;
    if (ingestBusy || !currentId) return;
    const note = NotesStore.get(currentId);
    if (!note || note.deleted) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) return;
    const live = NotesStore.listAttachments(currentId).map((item) => item.uuid);
    const next = {
      ...note.content,
      prevent_edit: !!note.content.prevent_edit,
      attachments: [...new Set([...(note.content.attachments || []), ...live])],
    };
    if (!note.content.prevent_edit) {
      next.title = ui.title.value || 'Untitled';
      next.content = ui.body.value || '';
      next.editor = ui.editorType.value || 'plain';
    }
    if (NotesSearch.sameNoteContent(note.content, next)) {
      updateNoteMeta(note);
      return;
    }
    NotesStore.upsert(currentId, next, { recordRevision: true });
    updateNoteMeta(NotesStore.get(currentId));
  }

  function scheduleSave() {
    ui.saveStatus.textContent = 'Saving…';
    ui.saveStatus.classList.remove('error');
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(flushSave, 300);
  }

  function escapeHtml(text) {
    return NotesSanitize.escapeHtml(text);
  }

  function escapeAttr(text) {
    return NotesSanitize.escapeAttr(text);
  }

  function safeColor(color) {
    return NotesSanitize.safeColor(color);
  }

  function savedVaultPasswordForReveal() {
    return (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getVaultPassword()) || savedDevicePassword() || '';
  }

  function updateVaultPasswordReveal() {
    const btn = document.getElementById('btn-show-vault-password');
    const reveal = document.getElementById('vault-password-reveal');
    if (!btn || !reveal) return;
    const saved = savedVaultPasswordForReveal();
    btn.hidden = !saved;
    reveal.hidden = true;
    reveal.textContent = '';
  }

  function formatDeviceLogin(ts) {
    const value = Number(ts || 0) * 1000;
    if (!value) return 'Unknown';
    try {
      return new Date(value).toLocaleString();
    } catch (err) {
      return 'Unknown';
    }
  }

  function renderSignedInDevices(sessions) {
    const el = document.getElementById('signed-in-devices');
    if (!el) return;
    const rows = Array.isArray(sessions) ? sessions : [];
    const next = JSON.stringify(rows);
    if (next === lastSignedInDevicesJson && el.children.length) return;
    lastSignedInDevicesJson = next;
    if (!rows.length) {
      el.innerHTML = '<p class="settings-hint">No signed-in devices.</p>';
      return;
    }
    el.replaceChildren(...rows.map((item) => {
      const row = document.createElement('article');
      row.className = 'device-row';
      row.setAttribute('role', 'listitem');
      const head = document.createElement('div');
      head.className = 'device-row-head';
      const name = document.createElement('span');
      name.className = 'device-row-name';
      name.textContent = item.device || 'Unknown device';
      head.appendChild(name);
      if (item.current) {
        const badge = document.createElement('span');
        badge.className = 'device-current';
        badge.textContent = 'This device';
        head.appendChild(badge);
      }
      const meta = document.createElement('p');
      meta.className = 'device-meta';
      const parts = [
        `Last login ${formatDeviceLogin(item.last_login_at)}`,
        item.ip ? `IP ${item.ip}` : '',
        item.ip_location || '',
      ].filter(Boolean);
      meta.textContent = parts.join(' · ');
      row.appendChild(head);
      row.appendChild(meta);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = item.current ? 'btn danger sm' : 'btn ghost sm';
      btn.textContent = item.current ? 'Sign out this device' : 'Sign out';
      btn.addEventListener('click', () => {
        revokeSignedInDevice(item).catch((err) => toast(err.message || 'Could not sign out device', true));
      });
      row.appendChild(btn);
      return row;
    }));
  }

  let signedInDevicesTimer = 0;
  let lastSignedInDevicesJson = '';

  function stopSignedInDevicesRefresh() {
    if (signedInDevicesTimer) {
      window.clearInterval(signedInDevicesTimer);
      signedInDevicesTimer = 0;
    }
  }

  function startSignedInDevicesRefresh() {
    stopSignedInDevicesRefresh();
    loadSignedInDevices().catch(() => {});
    signedInDevicesTimer = window.setInterval(() => {
      if (!document.body.classList.contains('settings-open')) {
        stopSignedInDevicesRefresh();
        return;
      }
      loadSignedInDevices().catch(() => {});
    }, 10000);
  }

  async function loadSignedInDevices() {
    const el = document.getElementById('signed-in-devices');
    if (!el) return;
    try {
      const data = await NotesStore.api('/api/sessions');
      renderSignedInDevices(data.sessions || []);
    } catch (err) {
      lastSignedInDevicesJson = '';
      el.innerHTML = '<p class="settings-hint">Could not load signed-in devices.</p>';
    }
  }

  async function revokeSignedInDevice(item) {
    const current = !!item.current;
    const ok = await confirmAction(
      current
        ? SIGN_OUT_WARNING
        : `Sign out “${item.device || 'this device'}”? That device will lose access immediately and will delete its local vault copy when it next connects.`,
      {
        title: current ? 'Sign out?' : 'Sign out device?',
        confirmLabel: 'Sign out',
        cancelLabel: 'Cancel',
        danger: true,
      },
    );
    if (!ok) return;
    const data = await NotesStore.api(`/api/sessions/${item.id}`, { method: 'DELETE' });
    if (data.current) {
      await signOutCompletely();
      return;
    }
    toast('Device signed out');
    await loadSignedInDevices();
  }

  async function initSettings() {
    let account;
    try {
      account = await NotesStore.loadAccount();
    } catch (err) {
      account = NotesStore.cachedAccount();
    }
    ui.accountEmail.textContent = account.email || 'Offline on this device';
    renderPlanUi(account);
    refreshSettingsDiagnostics().catch(() => {});
    startSignedInDevicesRefresh();
    if (account.backup_email !== undefined || account.backup_enabled !== undefined) {
      document.getElementById('backup-email').value = account.backup_email || account.email || '';
      document.getElementById('backup-enabled').checked = !!account.backup_enabled;
    }
    if (account.pcloud_username !== undefined || account.pcloud_enabled !== undefined) {
      document.getElementById('pcloud-username').value = account.pcloud_username || '';
      document.getElementById('pcloud-remote-path').value = account.pcloud_remote_path || 'Deeperguard/backups';
      document.getElementById('pcloud-region').value = account.pcloud_region || 'eu';
      document.getElementById('pcloud-enabled').checked = !!account.pcloud_enabled;
      document.getElementById('pcloud-password').value = '';
      const tokenEl = document.getElementById('pcloud-rclone-token');
      if (tokenEl) tokenEl.value = '';
      const statusEl = document.getElementById('pcloud-status');
      const parts = [];
      if (account.pcloud_password_set) parts.push('Password saved on server');
      else parts.push('Password not set');
      if (account.pcloud_token_set) parts.push('OAuth token saved');
      if (account.pcloud_last_sync_at > 0) {
        const when = new Date(account.pcloud_last_sync_at * 1000).toLocaleString();
        const outcome = account.pcloud_last_sync_status === 'ok' ? 'OK' : 'Failed';
        parts.push(`Last sync: ${when} (${outcome})`);
        if (account.pcloud_last_sync_detail) parts.push(account.pcloud_last_sync_detail);
      }
      statusEl.textContent = parts.join(' · ');
    }
    if (account.totp_enabled !== undefined) {
      const totpEl = document.getElementById('totp-status');
      if (totpEl) {
        totpEl.hidden = false;
        totpEl.textContent = account.totp_enabled
          ? '2FA is enabled on this account.'
          : '2FA is not enabled.';
      }
      document.getElementById('btn-disable-totp').hidden = !account.totp_enabled;
      document.getElementById('btn-setup-totp').hidden = account.totp_enabled;
    } else {
      const totpEl = document.getElementById('totp-status');
      if (totpEl) totpEl.hidden = true;
      document.getElementById('btn-disable-totp').hidden = true;
      document.getElementById('btn-setup-totp').hidden = true;
    }
    const passkeyWrap = document.getElementById('passkey-settings');
    const passkeyList = document.getElementById('passkey-list');
    const addPasskeyBtn = document.getElementById('btn-add-passkey');
    if (passkeyWrap && passkeyList && window.NotesPasskeys) {
      passkeyWrap.hidden = false;
      const passkeyUrl = account.passkey_url || 'https://www.deeperguard.com/';
      passkeyWrap.dataset.passkeyUrl = passkeyUrl;
      NotesPasskeys.renderPasskeyList(passkeyList, passkeyUrl).catch(() => {});
      if (addPasskeyBtn) {
        const hostError = NotesWebAuthn?.passkeyHostError?.(passkeyUrl);
        addPasskeyBtn.hidden = false;
        if (hostError) {
          addPasskeyBtn.textContent = 'Open www.deeperguard.com';
          addPasskeyBtn.dataset.passkeyMode = 'open';
        } else {
          addPasskeyBtn.textContent = 'Add passkey';
          addPasskeyBtn.dataset.passkeyMode = 'register';
        }
      }
    }
    const totpDisablePw = document.getElementById('totp-disable-password-wrap');
    const totpDisableHint = document.getElementById('totp-disable-srp-hint');
    const srpAccount = String(account.auth_method || '') === 'srp';
    if (totpDisablePw) totpDisablePw.hidden = srpAccount;
    if (totpDisableHint) totpDisableHint.hidden = !srpAccount;
    syncSortControls();
    document.querySelectorAll('[data-theme-opt]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeOpt === prefs.theme);
    });
    document.getElementById('pref-compact').checked = !!prefs.compactList;
    document.getElementById('pref-hide-previews').checked = !!prefs.hidePreviews;
    document.getElementById('pref-font-size').value = String(prefs.fontSize);
    document.getElementById('pref-mono').checked = !!prefs.monospace;
    document.getElementById('pref-spellcheck').checked = !!prefs.spellcheck;
    document.getElementById('pref-auto-preview').checked = !!prefs.autoPreview;
    document.getElementById('pref-auto-lock').value = String(prefs.autoLockMin || 0);
    const lockUnfocus = document.getElementById('pref-lock-on-unfocus');
    if (lockUnfocus) lockUnfocus.value = lockOnUnfocusMode();
    const rememberDevice = document.getElementById('pref-remember-device');
    if (rememberDevice) rememberDevice.checked = !!prefs.rememberDevice;
    const lightVaultPref = document.getElementById('pref-light-vault');
    if (lightVaultPref) lightVaultPref.checked = !!prefs.lightVault;
    refreshLocalFilesSummary().catch(() => {});
    initAiChatSettings();
    const currentPw = document.getElementById('password-change-current');
    if (currentPw && NotesStore.isUnlocked() && !currentPw.value) {
      const sessionPw = savedVaultPasswordForReveal();
      if (sessionPw) currentPw.value = sessionPw;
    }
    updateVaultPasswordReveal();
    bindPasswordToggles(document.getElementById('attachment-repair'));
  }

  function ocrDiagnostics() {
    const atts = NotesStore.listAttachments();
    let pending = 0;
    let failed = 0;
    let searchable = 0;
    atts.forEach((att) => {
      const method = att.content?.ocr_method || '';
      const text = String(att.content?.ocr_text || '').trim();
      if (!method) pending += 1;
      else if (method === 'failed') failed += 1;
      else if (text) searchable += 1;
    });
    return { pending, failed, searchable, total: atts.length };
  }

  function previewDiagnostics() {
    if (!IS_IOS) return null;
    const pdfs = NotesStore.listAttachments().filter((att) => attachmentKind(att) === 'pdf');
    let cached = 0;
    let missing = 0;
    let loading = 0;
    pdfs.forEach((att) => {
      if (att.content?.preview_enc) cached += 1;
      else if (listPreviewBackfill.has(att.uuid)) loading += 1;
      else missing += 1;
    });
    return { cached, missing, loading, total: pdfs.length };
  }

  function previewDiagnosticsLine() {
    const stats = previewDiagnostics();
    if (!stats || !stats.total) return '';
    const parts = [`${stats.cached} PDF thumbnail${stats.cached === 1 ? '' : 's'} cached`];
    if (stats.loading) parts.push(`${stats.loading} generating`);
    if (stats.missing) parts.push(`${stats.missing} waiting for Wi‑Fi`);
    return parts.join(' · ');
  }

  let lastDiagnosticsText = '';
  let lastSelfTestResult = '';
  let lastNoteButtonsSelfTestResult = '';
  let lastAttachSelfTestResult = '';
  let lastPdfSelfTestResult = '';
  let lastUiRegressionSelfTestResult = '';
  let lastDeviceReportUploadResult = '';
  const SELFTEST_STORAGE_KEY = 'notes_device_selftest_v1';

  function loadPersistedSelfTestResults() {
    try {
      const raw = localStorage.getItem(SELFTEST_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data.photo === 'string') lastSelfTestResult = data.photo;
      if (typeof data.buttons === 'string') lastNoteButtonsSelfTestResult = data.buttons;
      if (typeof data.attach === 'string') lastAttachSelfTestResult = data.attach;
      if (typeof data.pdf === 'string') lastPdfSelfTestResult = data.pdf;
      if (typeof data.ui === 'string') lastUiRegressionSelfTestResult = data.ui;
      if (typeof data.upload === 'string') lastDeviceReportUploadResult = data.upload;
    } catch (err) {
      /* ignore corrupt cache */
    }
  }

  function persistSelfTestResults() {
    try {
      localStorage.setItem(SELFTEST_STORAGE_KEY, JSON.stringify({
        photo: lastSelfTestResult,
        buttons: lastNoteButtonsSelfTestResult,
        attach: lastAttachSelfTestResult,
        pdf: lastPdfSelfTestResult,
        ui: lastUiRegressionSelfTestResult,
        upload: lastDeviceReportUploadResult,
      }));
    } catch (err) {
      /* ignore quota */
    }
  }

  loadPersistedSelfTestResults();

  let photoSearchSelfTestRunning = false;
  let deviceTestsRunning = false;
  const SELF_TEST_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDMwMCAyMDBdL1BhcmVudCAyIDAgUi9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDEgMCAwIDEgNDAgMTIwIFRtIChQREZURVNUODg0MikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTA1IDAwMDAwIG4gCjAwMDAwMDAyMTcgMDAwMDAgbiAKMDAwMDAwMDMxNyAwMDAwMCBuIAp0cmFpbGVyPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzgwCiUlRU9GCg==';
  const SELF_TEST_PDF_TOKEN = 'PDFTEST8842';

  function restoreEditorContext(prevSearch, prevId) {
    if (ui.search && ui.search.value !== prevSearch) {
      ui.search.value = prevSearch;
      ui.search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (prevId && prevId !== currentId && NotesStore.get(prevId)) {
      openNote(prevId);
    } else if (!prevId && currentId) {
      closeEditor();
    }
  }

  async function duplicateNoteForTest(sourceId) {
    const note = NotesStore.get(sourceId);
    if (!note) throw new Error('note missing');
    const copyId = NotesStore.newUuid();
    const copy = {
      ...NotesStore.defaultNote(),
      ...note.content,
      locked: false,
      prevent_edit: false,
      attachments: [],
      title: `${note.content.title || 'Untitled'} copy`,
      created_at: new Date().toISOString(),
    };
    delete copy.ocr_text;
    NotesStore.upsert(copyId, copy);
    for (const attId of note.content.attachments || []) {
      const att = NotesStore.get(attId);
      if (!att) continue;
      const bytes = await NotesStore.getAttachmentBytes(attId);
      const name = att.content.filename || 'file';
      const file = new File([bytes], name, {
        type: att.content.mime || 'application/octet-stream',
      });
      const newId = await NotesStore.addAttachment(copyId, file, {
        displayName: att.content.display_name,
      });
      if (att.content.ocr_text || att.content.ocr_method) {
        NotesStore.setAttachmentOcr(
          newId,
          att.content.ocr_text || '',
          att.content.ocr_method || '',
          Array.isArray(att.content.ocr_boxes) ? att.content.ocr_boxes : [],
        );
      }
    }
    NotesStore.refreshNoteSearchText(copyId);
    return copyId;
  }

  async function createSelfTestImage(token) {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('Deeperguard OCR test', 36, 72);
    ctx.font = 'bold 48px monospace';
    ctx.fillText(token, 36, 160);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error('Could not create test image'));
      }, 'image/png');
    });
    return new File([blob], 'ocr-self-test.png', { type: 'image/png' });
  }

  function createSelfTestPdf() {
    const binary = atob(SELF_TEST_PDF_B64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], 'pdf-self-test.pdf', { type: 'application/pdf' });
  }

  async function waitForPdfPreviewHit(noteId, attId, token, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (currentId !== noteId) openNote(noteId);
      editorMode = 'preview';
      ui.search.value = token;
      ui.search.dispatchEvent(new Event('input', { bubbles: true }));
      applyEditorMode();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const stage = ui.docInline?.querySelector('.doc-inline-stage');
      if (stage && stage.querySelector('.doc-search-hit')) return stage;
      const att = NotesStore.get(attId);
      if (att?.content?.ocr_method === 'failed') throw new Error('PDF indexing failed');
      if (ocrInFlight.has(attId)) {
        try {
          await ocrInFlight.get(attId);
        } catch (err) {
          if (!isTransientOcrError(err)) throw err;
        }
        continue;
      }
    }
    throw new Error('PDF search highlight timed out');
  }

  async function waitForSelfTestOcr(attId, noteId, token, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const att = NotesStore.get(attId);
      if (att?.content?.ocr_method === 'failed') {
        throw new Error('OCR failed on test image');
      }
      NotesStore.refreshNoteSearchText(noteId);
      const noteText = String(NotesStore.get(noteId)?.content?.ocr_text || '');
      const attText = String(att?.content?.ocr_text || '');
      if (attText.includes(token) && noteText.includes(token)) {
        return { attText, noteText };
      }
      if (ocrInFlight.has(attId)) {
        try {
          await ocrInFlight.get(attId);
        } catch (err) {
          if (!isTransientOcrError(err)) throw err;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('OCR timed out — try Retry OCR on the attachment');
  }

  async function runPhotoSearchSelfTest() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return false;
    }
    if (photoSearchSelfTestRunning) {
      toast('Photo search test already running…');
      return false;
    }
    photoSearchSelfTestRunning = true;
    const token = `HNTEST${Math.floor(1000 + Math.random() * 9000)}`;
    const title = 'OCR self-test (safe to delete)';
    const prevSearch = ui.search?.value || '';
    const prevId = currentId;
    let noteId = '';
    try {
      toast('Creating test photo…');
      const file = await createSelfTestImage(token);
      noteId = createNote({ silent: true, title });
      if (!noteId) throw new Error('Could not create test note');
      toast('Uploading test photo…');
      const attId = await NotesStore.addAttachment(noteId, file, { displayName: 'ocr-self-test.png' });
      toast('Reading text on this device…');
      await ensureAttachmentOcr(attId, file, null, { force: true });
      await waitForSelfTestOcr(attId, noteId, token);
      if (noteSearchStale(noteId)) NotesStore.refreshNoteSearchText(noteId);
      ui.search.value = token;
      ui.search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const matches = NotesSearch.filterNotes(NotesStore.listNotes(), {
        query: token,
        filter: 'all',
        tagMap: tagMap(),
        sort: prefs.sort,
      });
      const found = matches.some((note) => note.uuid === noteId);
      if (found) {
        lastSelfTestResult = `Photo search self-test: PASS (${token})`;
        persistSelfTestResults();
        toast('Photo search self-test passed');
      } else {
        const stale = noteSearchStale(noteId);
        lastSelfTestResult = `Photo search self-test: FAIL — search missed token${stale ? ' (stale index)' : ''} (${token})`;
        persistSelfTestResults();
        toast('Photo search self-test failed — tap Repair search index', true);
      }
      renderNotes();
      refreshSettingsDiagnostics().catch(() => {});
      return found;
    } catch (err) {
      lastSelfTestResult = `Photo search self-test: FAIL — ${err.message || 'unknown error'}`;
      persistSelfTestResults();
      toast(lastSelfTestResult, true);
      refreshSettingsDiagnostics().catch(() => {});
      if (noteId && !NotesStore.listAttachments(noteId).length) {
        NotesStore.remove(noteId);
        if (currentId === noteId) closeEditor();
        renderNotes();
      }
      return false;
    } finally {
      restoreEditorContext(prevSearch, prevId);
      photoSearchSelfTestRunning = false;
    }
  }

  async function runNoteButtonsSelfTest() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return false;
    }
    const prevSearch = ui.search?.value || '';
    const prevId = currentId;
    const title = 'Button self-test (safe to delete)';
    let noteId = '';
    let copyId = '';
    try {
      toast('Testing note buttons…');
      noteId = createNote({ silent: true, title });
      if (!noteId) throw new Error('Could not create test note');
      const file = await createSelfTestImage('BTNTEST');
      await NotesStore.addAttachment(noteId, file, { displayName: 'btn-test.png' });
      openNote(noteId);
      const origAttIds = NotesStore.listAttachments(noteId).map((att) => att.uuid);
      if (!origAttIds.length) throw new Error('test attachment missing');

      const tagName = `TagBar${Date.now().toString(36).slice(-5)}`;
      const tagInput = document.getElementById('tag-bar-input');
      const tagAdd = document.getElementById('tag-bar-add');
      if (!tagInput || !tagAdd) throw new Error('tag bar input missing');
      tagInput.value = tagName;
      tagInput.focus();
      tagAdd.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const tagNeedle = tagName.trim().toLowerCase();
      const addedTag = NotesStore.listTags().find(
        (t) => (t.content.title || '').trim().toLowerCase() === tagNeedle,
      );
      if (!addedTag) throw new Error('tag bar add failed');
      if (!(NotesStore.get(noteId)?.content?.tags || []).includes(addedTag.uuid)) {
        throw new Error('tag bar did not assign to note');
      }

      let note = NotesStore.get(noteId);
      note.content.starred = true;
      NotesStore.upsert(noteId, { ...note.content });
      if (!NotesStore.get(noteId)?.content?.starred) throw new Error('star toggle failed');

      note = NotesStore.get(noteId);
      note.content.pinned = true;
      NotesStore.upsert(noteId, { ...note.content });
      if (!NotesStore.get(noteId)?.content?.pinned) throw new Error('pin toggle failed');

      note = NotesStore.get(noteId);
      note.content.locked = true;
      unlockedNotes.delete(noteId);
      NotesStore.upsert(noteId, { ...note.content });
      if (!NotesStore.get(noteId)?.content?.locked) throw new Error('protect toggle failed');
      trashNote(noteId);
      if (NotesStore.get(noteId)?.content?.trashed) throw new Error('protected note was trashed');
      unlockedNotes.add(noteId);
      note.content.locked = false;
      NotesStore.upsert(noteId, { ...note.content });

      copyId = await duplicateNoteForTest(noteId);
      const copyAttIds = NotesStore.listAttachments(copyId).map((att) => att.uuid);
      if (!copyAttIds.length) throw new Error('duplicate missing attachments');
      if (copyAttIds.some((id) => origAttIds.includes(id))) {
        throw new Error('duplicate shares attachment ids');
      }

      trashNote(noteId);
      if (!NotesStore.get(noteId)?.content?.trashed) throw new Error('trash failed');
      restoreNote(noteId);
      if (NotesStore.get(noteId)?.content?.trashed) throw new Error('restore failed');

      lastNoteButtonsSelfTestResult = 'Note buttons self-test: PASS (incl. tag bar)';
      persistSelfTestResults();
      toast('Note buttons self-test passed');
      refreshSettingsDiagnostics().catch(() => {});
      return true;
    } catch (err) {
      lastNoteButtonsSelfTestResult = `Note buttons self-test: FAIL — ${err.message || 'unknown error'}`;
      persistSelfTestResults();
      toast(lastNoteButtonsSelfTestResult, true);
      refreshSettingsDiagnostics().catch(() => {});
      return false;
    } finally {
      if (copyId && NotesStore.get(copyId)) NotesStore.remove(copyId);
      restoreEditorContext(prevSearch, prevId);
    }
  }

  async function runSingleFileAttachSelfTest() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return false;
    }
    const prevSearch = ui.search?.value || '';
    const prevId = currentId;
    const title = 'Attach self-test (safe to delete)';
    let noteId = '';
    try {
      toast('Testing single-file attach…');
      noteId = createNote({ silent: true, title });
      if (!noteId) throw new Error('Could not create test note');
      openNote(noteId);
      const before = NotesStore.listAttachments(noteId).length;
      const scanDialog = document.getElementById('scan-dialog');
      if (scanDialog && !scanDialog.hidden) throw new Error('scan dialog already open');
      const file = await createSelfTestImage('ATTACHTEST');
      await ingestDocument(file, {
        createIfNeeded: false,
        title,
        displayName: 'attach-test.png',
      });
      if (scanDialog && !scanDialog.hidden) throw new Error('scan dialog opened');
      const after = NotesStore.listAttachments(noteId).length;
      if (after <= before) throw new Error('attachment not added');
      lastAttachSelfTestResult = 'Single-file attach self-test: PASS';
      persistSelfTestResults();
      toast('Single-file attach self-test passed');
      refreshSettingsDiagnostics().catch(() => {});
      return true;
    } catch (err) {
      lastAttachSelfTestResult = `Single-file attach self-test: FAIL — ${err.message || 'unknown error'}`;
      persistSelfTestResults();
      toast(lastAttachSelfTestResult, true);
      refreshSettingsDiagnostics().catch(() => {});
      if (noteId && !NotesStore.listAttachments(noteId).length) {
        NotesStore.remove(noteId);
      }
      return false;
    } finally {
      restoreEditorContext(prevSearch, prevId);
    }
  }

  function simulatePinchZoom(viewport, { spreadStart = 80, spreadEnd = 200 } = {}) {
    if (!viewport || typeof Touch === 'undefined' || typeof TouchEvent === 'undefined') return false;
    const rect = viewport.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const makeTouch = (id, x, y) => new Touch({
      identifier: id,
      target: viewport,
      clientX: x,
      clientY: y,
      pageX: x + (window.scrollX || 0),
      pageY: y + (window.scrollY || 0),
      screenX: x,
      screenY: y,
      radiusX: 2,
      radiusY: 2,
      rotationAngle: 0,
      force: 1,
    });
    const pair = (spread) => [makeTouch(1, cx - spread / 2, cy), makeTouch(2, cx + spread / 2, cy)];
    const opts = (touches) => ({
      bubbles: true,
      cancelable: true,
      touches,
      targetTouches: touches,
      changedTouches: touches,
    });
    viewport.dispatchEvent(new TouchEvent('touchstart', opts(pair(spreadStart))));
    viewport.dispatchEvent(new TouchEvent('touchmove', opts(pair(spreadEnd))));
    viewport.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: pair(spreadEnd),
    }));
    return true;
  }

  async function runPdfPreviewSearchSelfTest() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return false;
    }
    const prevSearch = ui.search?.value || '';
    const prevId = currentId;
    const title = 'PDF self-test (safe to delete)';
    let noteId = '';
    let attId = '';
    try {
      toast('Testing PDF preview and search…');
      if (window.NotesPreview) await NotesPreview.ensurePdf().catch(() => {});
      const file = createSelfTestPdf();
      noteId = createNote({ silent: true, title });
      if (!noteId) throw new Error('Could not create test note');
      attId = await NotesStore.addAttachment(noteId, file, { displayName: 'pdf-self-test.pdf' });
      await ensureAttachmentOcr(attId, file, null, { force: true });
      await waitForSelfTestOcr(attId, noteId, SELF_TEST_PDF_TOKEN);
      await waitForPdfPreviewHit(noteId, attId, SELF_TEST_PDF_TOKEN);
      await openDocPreview(attId);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const scaleBefore = ui.docStage?._docZoom?.getScale?.() || 1;
      ui.docStage?._docZoom?.zoomIn?.();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const scaleAfter = ui.docStage?._docZoom?.getScale?.() || 1;
      if (scaleAfter <= scaleBefore) throw new Error('PDF zoom controls did not change scale');
      if (!ui.docStage?.querySelector('.doc-search-hit')) {
        throw new Error('PDF full-screen search highlight missing');
      }
      let pinchNote = '';
      if (simulatePinchZoom(ui.docStage)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const scalePinch = ui.docStage?._docZoom?.getScale?.() || 1;
        if (scalePinch > scaleAfter) pinchNote = ' + pinch';
        /* Synthetic TouchEvent is best-effort — iOS WebKit may ignore it; never fail the self-test. */
      }
      closeDocPreview();
      lastPdfSelfTestResult = `PDF preview/search self-test: PASS${pinchNote}`;
      persistSelfTestResults();
      toast('PDF preview/search self-test passed');
      refreshSettingsDiagnostics().catch(() => {});
      return true;
    } catch (err) {
      closeDocPreview();
      lastPdfSelfTestResult = `PDF preview/search self-test: FAIL — ${err.message || 'unknown error'}`;
      persistSelfTestResults();
      toast(lastPdfSelfTestResult, true);
      refreshSettingsDiagnostics().catch(() => {});
      return false;
    } finally {
      restoreEditorContext(prevSearch, prevId);
    }
  }

  function runUiRegressionSelfTest() {
    try {
      const closedRows = ui.noteList?.querySelectorAll('.note-row:not(.open)') || [];
      let checkedTrash = false;
      closedRows.forEach((row) => {
        if (checkedTrash) return;
        const del = row.querySelector('.note-swipe-delete');
        if (!del) return;
        checkedTrash = true;
        const vis = globalThis.getComputedStyle ? getComputedStyle(del).visibility : '';
        if (vis !== 'hidden') throw new Error('Trash button visible without swipe');
      });
      const markProbe = document.createElement('mark');
      markProbe.className = 'search-hit';
      markProbe.textContent = 'x';
      document.body.appendChild(markProbe);
      const markDeco = getComputedStyle(markProbe).textDecorationLine
        || getComputedStyle(markProbe).textDecoration
        || '';
      markProbe.remove();
      if (!String(markDeco).includes('underline')) {
        throw new Error('search hits should use red underline');
      }
      const docProbe = document.createElement('span');
      docProbe.className = 'doc-search-hit';
      docProbe.style.width = '24px';
      document.body.appendChild(docProbe);
      const docAfter = globalThis.getComputedStyle
        ? getComputedStyle(docProbe, '::after')
        : null;
      const docHeight = docAfter ? parseFloat(docAfter.height || '0') : 0;
      docProbe.remove();
      if (docHeight < 0.5) throw new Error('document search hits should use red underline');
      lastUiRegressionSelfTestResult = 'UI regression self-test: PASS (hidden Trash, search underlines)';
      persistSelfTestResults();
      return true;
    } catch (err) {
      lastUiRegressionSelfTestResult = `UI regression self-test: FAIL — ${err.message || 'unknown error'}`;
      persistSelfTestResults();
      return false;
    }
  }

  async function runAllDeviceTests() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return false;
    }
    if (deviceTestsRunning || photoSearchSelfTestRunning) {
      toast('Device tests already running…');
      return false;
    }
    deviceTestsRunning = true;
    try {
      closeSettings(true);
      toast('Running device tests…');
      const photo = await runPhotoSearchSelfTest();
      const pdf = await runPdfPreviewSearchSelfTest();
      const buttons = await runNoteButtonsSelfTest();
      const attach = await runSingleFileAttachSelfTest();
      const ui = runUiRegressionSelfTest();
      const ok = photo && pdf && buttons && attach && ui;
      const text = await buildDiagnosticsText().catch(() => '');
      const uploaded = text ? await uploadDeviceReport(text) : false;
      if (ok) {
        toast(
          uploaded
            ? 'All device tests passed — report sent to server'
            : 'All device tests passed — force-quit offline once, then Copy diagnostics',
        );
      } else {
        toast(
          uploaded
            ? 'Some device tests failed — report sent to server'
            : 'Some device tests failed — see checklist',
          true,
        );
      }
      refreshSettingsDiagnostics().catch(() => {});
      return ok;
    } finally {
      deviceTestsRunning = false;
    }
  }

  async function refreshSettingsDiagnostics() {
    const el = document.getElementById('privacy-status');
    if (!el) return;
    let serverLabel = 'Checking server…';
    let serverBuild = '';
    try {
      const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        serverBuild = String(data.build || '');
        serverLabel = 'Server reachable on LAN';
      }
    } catch (err) {
      /* fall through to OCR probe */
    }
    if (serverLabel === 'Checking server…') {
      if (window.NotesOcr && typeof NotesOcr.serverReachable === 'function') {
        serverLabel = (await NotesOcr.serverReachable())
          ? 'Server reachable on LAN'
          : 'Server unreachable — join home Wi‑Fi or WireGuard';
      } else if (!networkReachable) {
        serverLabel = 'Server unreachable — join home Wi‑Fi or WireGuard';
      } else {
        serverLabel = 'Server reachable on LAN';
      }
    }
    const sessionLabel = NotesStore.csrf()
      ? 'Session active — OCR allowed'
      : 'Session inactive — unlock online once, or enable Remember password';
    const ocr = ocrDiagnostics();
    const previewLine = previewDiagnosticsLine();
    const stale = countStaleNoteSearchIndexes();
    const queue = ocrQueued.size + ocrInFlight.size + ocrWaitingServer.size;
    let memoryLine = '';
    if (typeof performance !== 'undefined' && performance.memory) {
      const usedMb = Math.round(performance.memory.usedJSHeapSize / (1024 * 1024));
      memoryLine = `Memory ~${usedMb} MB JS heap · ${NotesStore.listNotes().length} notes in memory`;
    } else if (IS_IOS && iosTune()) {
      const mem = iosTune().memoryHeuristic({
        notes: NotesStore.listNotes().length,
        attachments: NotesStore.listAttachments().length,
        previewCache: previewCache.size,
        listThumbs: listThumbCache.size,
      });
      if (mem.label) memoryLine = mem.label;
    }
    const storageLine = iosTune() ? await iosTune().storageEstimateLine() : '';
    const build = document.querySelector('meta[name="notes-build"]')?.content || notesBuild || '';
    const buildStale = serverBuild && build && serverBuild !== build;
    let account;
    try {
      account = await NotesStore.loadAccount();
    } catch (err) {
      account = NotesStore.cachedAccount() || {};
    }
    const authMethod = String(account.auth_method || 'srp');
    const passkeys = account.webauthn_enabled ? ' · passkey on file' : '';
    const zkLine = authMethod === 'srp'
      ? `Zero-knowledge account login (SRP)${passkeys}`
      : 'Legacy login — sign out and sign in once to upgrade to SRP';
    const hostOk = account.passkey_host_ok !== false;
    const hostLine = hostOk
      ? 'Passkeys available on this hostname'
      : `Passkeys need ${(account.passkey_url || 'https://www.deeperguard.com/').replace(/^https?:\/\//, '')}`;
    const vaultLine = NotesStore.isUnlocked()
      ? 'Vault unlocked — notes encrypted on device before sync'
      : 'Vault locked';
    const lines = [
      buildStale
        ? `<strong class="ocr-stale">App v${escapeHtml(build)} · server v${escapeHtml(serverBuild)} — refresh app cache on Wi‑Fi</strong>`
        : `<strong>Deeperguard v${escapeHtml(build)}</strong>`,
      escapeHtml(zkLine),
      escapeHtml(vaultLine),
      escapeHtml(hostLine),
      escapeHtml(serverLabel),
    ];
    if (stale) {
      lines.push(`<span class="ocr-stale">${stale} note${stale === 1 ? '' : 's'} need search index repair (Advanced)</span>`);
    }
    el.innerHTML = lines.join('<br>');
    lastDiagnosticsText = lines.map((line) => line.replace(/<[^>]+>/g, '')).join('\n');
    updateAppUpdateBanner(serverBuild);
    const refreshBtn = document.getElementById('btn-refresh-app');
    if (refreshBtn) refreshBtn.classList.toggle('primary', !!buildStale);
  }

  function formatChecklistLineHtml(line) {
    const text = escapeHtml(line);
    if (/\bPASS\b/.test(line)) return `<span class="check-pass">${text}</span>`;
    if (/\bFAIL\b/.test(line) || /\bNOT READY\b/.test(line)) return `<span class="check-fail">${text}</span>`;
    if (/\bUNKNOWN\b/.test(line) || /\bREADY\b/.test(line) || /run (Test photo search|Run all device tests)/.test(line)) {
      return `<span class="check-warn">${text}</span>`;
    }
    return text;
  }

  async function refreshSettingsChecklist(serverOk, serverBuild) {
    const el = document.getElementById('settings-checklist');
    if (!el) return;
    const report = await buildIphoneChecklistReport({ serverOk, serverBuild }).catch(() => '');
    if (!report) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = report.split('\n').map((line) => formatChecklistLineHtml(line)).join('<br>');
  }

  function openNoteDiagnostics() {
    if (!currentId) return '';
    const note = NotesStore.get(currentId);
    if (!note) return '';
    const title = String(note.content.title || '').trim() || 'Untitled';
    const stale = noteSearchStale(currentId);
    const atts = NotesStore.listAttachments(currentId).filter(canOcrAttachment);
    const parts = atts.map((att) => {
      const method = att.content?.ocr_method || 'waiting';
      const chars = String(att.content?.ocr_text || '').trim().length;
      const name = att.content?.filename || 'document';
      let preview = '';
      if (IS_IOS && attachmentKind(att) === 'pdf') {
        if (att.content?.preview_enc) preview = ', list thumb cached';
        else if (listPreviewBackfill.has(att.uuid)) preview = ', list thumb loading';
        else preview = ', list thumb needs Wi‑Fi';
      }
      return `${name}: ${method}${chars ? ` (${chars} chars)` : ''}${preview}`;
    });
    const query = ui.search?.value?.trim() || '';
    const lines = [`Open note: ${title}`, stale ? 'Search index stale on this note — repair recommended' : 'Search index OK on this note'];
    if (parts.length) lines.push(`Attachments: ${parts.join('; ')}`);
    else lines.push('Attachments: none');
    if (query) lines.push(`Search query: ${query}`);
    return lines.join('\n');
  }

  async function buildIphoneChecklistReport({ serverOk: serverOkHint, serverBuild: serverBuildHint } = {}) {
    const build = document.querySelector('meta[name="notes-build"]')?.content || notesBuild || '?';
    let serverBuild = serverBuildHint || '';
    let serverOk = !!serverOkHint;
    if (!serverOkHint) {
      try {
        const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          serverOk = true;
          serverBuild = String(data.build || '');
        }
      } catch (err) {
        /* fall through */
      }
      if (!serverOk && typeof window.notesNetworkReachable === 'function') {
        serverOk = window.notesNetworkReachable();
      }
    }
    const https = location.protocol === 'https:';
    const buildMatch = !serverBuild || serverBuild === build;
    const remember = !!prefs.rememberDevice;
    const saltCached = !!(localStorage.getItem('notes_kdf_salt') || sessionStorage.getItem('notes_kdf_salt'));
    const standalone = isStandalonePwa();
    const secureContext = !!window.isSecureContext;
    const photoLine = lastSelfTestResult.includes(': PASS')
      ? 'PASS (Test photo search)'
      : lastSelfTestResult.includes(': FAIL')
        ? `FAIL (${lastSelfTestResult.replace(/^Photo search self-test: /, '')})`
        : 'run Run all device tests or Test photo search';
    const buttonsLine = lastNoteButtonsSelfTestResult.includes(': PASS')
      ? 'PASS (device test)'
      : lastNoteButtonsSelfTestResult.includes(': FAIL')
        ? `FAIL (${lastNoteButtonsSelfTestResult.replace(/^Note buttons self-test: /, '')})`
        : 'run Run all device tests';
    const uiLine = lastUiRegressionSelfTestResult.includes(': PASS')
      ? 'PASS (device test)'
      : lastUiRegressionSelfTestResult.includes(': FAIL')
        ? `FAIL (${lastUiRegressionSelfTestResult.replace(/^UI regression self-test: /, '')})`
        : 'run Run all device tests';
    const noteButtonsLine = buttonsLine.includes('PASS') && uiLine.includes('PASS')
      ? 'PASS (device test)'
      : buttonsLine.includes('FAIL') || uiLine.includes('FAIL')
        ? `FAIL (${[buttonsLine, uiLine].filter((line) => line.includes('FAIL')).join('; ')})`
        : 'run Run all device tests';
    const attachLine = lastAttachSelfTestResult.includes(': PASS')
      ? 'PASS (device test)'
      : lastAttachSelfTestResult.includes(': FAIL')
        ? `FAIL (${lastAttachSelfTestResult.replace(/^Single-file attach self-test: /, '')})`
        : 'run Run all device tests';
    const pdfLine = lastPdfSelfTestResult.includes(': PASS')
      ? (lastPdfSelfTestResult.includes('pinch') || pinchZoomVerified())
        ? 'PASS (PDF zoom buttons + pinch + search highlights)'
        : 'PASS (PDF zoom + search highlights — pinch a PDF on device to confirm)'
      : lastPdfSelfTestResult.includes(': FAIL')
        ? `FAIL (${lastPdfSelfTestResult.replace(/^PDF preview\/search self-test: /, '')})`
        : 'run Run all device tests';
    const offlineReady = remember && saltCached;
    const offlineVerified = offlineUnlockVerified();
    const offlineLine = offlineVerified
      ? 'PASS (offline unlock verified on this device)'
      : offlineReady
        ? 'READY (remember + salt cached — force-quit offline to confirm)'
        : 'NOT READY (unlock online once with Remember on)';
    return [
      'iPhone checklist (auto-detected where possible — fill remaining pass/fail):',
      `1. Wi‑Fi or WireGuard — ${serverOk ? 'PASS (server reachable)' : 'FAIL (server unreachable)'}`,
      `2. Safari HTTPS, sidebar v${build} — ${https && buildMatch ? 'PASS' : https && !buildMatch ? `FAIL (app v${build}, server v${serverBuild || '?'} — Settings → Refresh app cache)` : 'FAIL (open https://…)'}`,
      `3. CA cert trusted — ${https && secureContext && serverOk ? 'PASS (HTTPS secure context)' : 'UNKNOWN (install ca.crt if Safari warns)'}`,
      `4. Remember password enabled — ${remember ? 'PASS' : 'FAIL (Settings → Security)'}`,
      `5. Added to Home Screen — ${standalone || pwaStandaloneVerified() ? 'PASS (standalone PWA)' : 'UNKNOWN (use Share → Add to Home Screen)'}`,
      `6. Offline unlock after force-quit — ${offlineLine}`,
      `7. Photo OCR search — ${photoLine}`,
      `8. PDF pinch zoom + search highlights — ${pdfLine}`,
      `9. Star/pin/protect/trash/duplicate/tag bar/list UI — ${noteButtonsLine}`,
      `10. Single-file attach (no scan dialog) — ${attachLine}`,
      `11. PDF list thumbnails (not just “PDF” placeholder) — ${previewThumbLine()}`,
    ].join('\n');
  }

  function previewThumbLine() {
    const stats = previewDiagnostics();
    if (!stats || !stats.total) return 'N/A (no PDF notes)';
    if (stats.cached === stats.total) return 'PASS (all PDF list thumbnails cached)';
    if (stats.loading) return `READY (${stats.loading} generating…)`;
    if (stats.missing) return `UNKNOWN (${stats.missing} need Wi‑Fi — open All notes and wait)`;
    return 'UNKNOWN (open All notes on Wi‑Fi)';
  }

  function iphoneChecklistTemplate(build) {
    const v = build || notesBuild || '?';
    return [
      'iPhone checklist (reply pass/fail for each):',
      '1. Wi‑Fi or WireGuard — ',
      '2. Safari HTTPS, sidebar v' + v + ' — ',
      '3. CA cert trusted — ',
      '4. Remember password enabled — ',
      '5. Added to Home Screen — ',
      '6. Offline unlock after force-quit — ',
      '7. Photo scan → Searchable → search finds text (or Settings → Test photo search PASS) — ',
      '8. PDF pinch zoom + search highlights — ',
      '9. Star/pin/protect/trash/duplicate — ',
      '10. Single-file attach (no scan dialog) — ',
      '11. PDF list thumbnails (not just “PDF” placeholder) — ',
    ].join('\n');
  }

  async function buildDiagnosticsText() {
    await refreshSettingsDiagnostics().catch(() => {});
    const noteDiag = openNoteDiagnostics();
    const checklist = await buildIphoneChecklistReport().catch(() => iphoneChecklistTemplate(
      document.querySelector('meta[name="notes-build"]')?.content || notesBuild || '',
    ));
    const syncLog = NotesStore.formatSyncLog ? NotesStore.formatSyncLog() : '';
    const iosExtras = iosTune()?.deviceReportExtras?.() || '';
    return [
      lastDiagnosticsText || 'Deeperguard diagnostics unavailable',
      iosExtras,
      noteDiag,
      syncLog,
      checklist,
    ].filter(Boolean).join('\n\n');
  }

  async function resolveDeviceReportCsrf() {
    await ensureServerSession().catch(() => {});
    let csrf = NotesStore.csrf();
    if (csrf) return csrf;
    try {
      const account = await NotesStore.loadAccount();
      csrf = account && account.csrf;
      if (csrf) NotesStore.setCsrf(csrf);
    } catch (err) {
      /* still try below */
    }
    return csrf || '';
  }

  async function postDeviceReport(body, csrf) {
    const res = await fetch('/api/device-report', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  function deviceReportNeedsSessionRetry(res, data) {
    if (!res || res.ok) return false;
    if (res.status === 401 || res.status === 403) return true;
    return res.status === 400 && /csrf/i.test(String(data.error || ''));
  }

  async function uploadDeviceReport(report) {
    const text = String(report || '').trim();
    if (!text) {
      lastDeviceReportUploadResult = 'Device report: not sent (empty)';
      persistSelfTestResults();
      return false;
    }
    let csrf = await resolveDeviceReportCsrf();
    if (!csrf) {
      lastDeviceReportUploadResult = 'Device report: not sent — unlock online with Remember password, then Send checklist';
      persistSelfTestResults();
      return false;
    }
    const body = JSON.stringify({ report: text.slice(0, 32000) });
    try {
      let { res, data } = await postDeviceReport(body, csrf);
      if (deviceReportNeedsSessionRetry(res, data)) {
        NotesStore.setCsrf('');
        csrf = await resolveDeviceReportCsrf();
        if (csrf) ({ res, data } = await postDeviceReport(body, csrf));
      }
      if (!csrf && deviceReportNeedsSessionRetry(res, data)) {
        lastDeviceReportUploadResult = 'Device report: upload failed (session expired) — unlock online, then Send checklist';
        persistSelfTestResults();
        return false;
      }
      const ok = !!(res.ok && data.ok);
      lastDeviceReportUploadResult = ok
        ? 'Device report: sent to server'
        : `Device report: upload failed (${data.error || res.status || 'network'}) — stay on Wi‑Fi and tap Send checklist`;
      persistSelfTestResults();
      return ok;
    } catch (err) {
      lastDeviceReportUploadResult = 'Device report: upload failed (network) — join home Wi‑Fi and tap Send checklist';
      persistSelfTestResults();
      return false;
    }
  }

  let lastSyncDiagUploadAt = 0;

  async function uploadSyncDiagnostics({ force = false } = {}) {
    if (!NotesStore.formatSyncLog) return false;
    const now = Date.now();
    if (!force && now - lastSyncDiagUploadAt < 120000) return false;
    const log = NotesStore.formatSyncLog();
    if (!log || log.includes('(empty)')) return false;
    const last = NotesStore.syncLogEntries ? NotesStore.syncLogEntries().slice(-1)[0] : null;
    if (!force && last && last.kind === 'sync-done' && !last.items && last.quiet) return false;
    lastSyncDiagUploadAt = now;
    const build = document.querySelector('meta[name="notes-build"]')?.content || notesBuild || '';
    const text = [
      `Deeperguard v${build}`,
      `Device: ${navigator.userAgent || 'unknown'}`,
      `Local items: ${NotesStore.state.items.size} · dirty ${NotesStore.state.dirty.size} · lastSync ${NotesStore.state.lastSync || 0} · kdf ${NotesStore.state.kdfVersion || '?'}`,
      log,
    ].join('\n\n');
    return uploadDeviceReport(text);
  }

  async function sendChecklistToServer() {
    const btn = document.getElementById('btn-send-checklist');
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('disabled');
      btn.setAttribute('aria-disabled', 'false');
    }
    let text = '';
    try {
      text = await buildDiagnosticsText();
    } catch (err) {
      text = lastDiagnosticsText
        || document.getElementById('privacy-status')?.innerText
        || '';
      const checklist = document.getElementById('settings-checklist')?.innerText || '';
      if (checklist) text = `${text}\n\n${checklist}`.trim();
    }
    if (!String(text || '').trim()) {
      toast('Nothing to send yet — open Settings on Wi‑Fi first', true);
      return false;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Sending…';
    }
    try {
      const uploaded = await uploadDeviceReport(text);
      refreshSettingsDiagnostics().catch(() => {});
      if (uploaded) toast('Checklist sent to server');
      else toast(lastDeviceReportUploadResult || 'Checklist upload failed', true);
      return uploaded;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Send checklist to server';
        btn.classList.add('primary');
      }
    }
  }
  window.notesSendChecklist = (event) => {
    if (event) {
      try { event.preventDefault(); } catch (err) {}
      try { event.stopPropagation(); } catch (err) {}
    }
    return sendChecklistToServer().catch((err) => {
      toast(err.message || 'Upload failed', true);
      return false;
    });
  };

  async function copyDiagnostics() {
    const text = await buildDiagnosticsText();
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (err) {
      /* fallback below */
    }
    if (!copied) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        copied = true;
      } catch (err) {
        copied = false;
      } finally {
        area.remove();
      }
    }
    const uploaded = await uploadDeviceReport(text);
    refreshSettingsDiagnostics().catch(() => {});
    if (copied && uploaded) toast('Diagnostics copied and sent to server');
    else if (copied) toast('Diagnostics copied');
    else if (uploaded) toast('Diagnostics sent to server');
    else toast('Could not copy diagnostics', true);
  }

  function openSettings() {
    if (ui.settings) {
      ui.settings.hidden = false;
      ui.settings.removeAttribute('hidden');
    }
    if (ui.settingsBackdrop) {
      ui.settingsBackdrop.hidden = false;
      ui.settingsBackdrop.removeAttribute('hidden');
    }
    document.body.classList.add('settings-open');
    window.__notesSettingsOpenedAt = Date.now();
    const refreshBtn = document.getElementById('btn-refresh-app');
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute('disabled');
    }
    refreshSettingsDiagnostics().catch(() => {});
    startSignedInDevicesRefresh();
  }

  function closeSettings(force = false) {
    if (!force && Date.now() - (window.__notesSettingsOpenedAt || 0) < 500) return;
    if (ui.settings) ui.settings.hidden = true;
    if (ui.settingsBackdrop) ui.settingsBackdrop.hidden = true;
    document.body.classList.remove('settings-open');
    stopSignedInDevicesRefresh();
    lastSignedInDevicesJson = '';
  }

  function renderVaultStats() {
    const el = document.getElementById('vault-stats');
    if (!el || !vaultReady) return;
    const notes = NotesStore.listNotes().filter((n) => !n.content.trashed && !n.content.archived);
    const docs = NotesStore.listAttachments().filter((att) => {
      const parent = NotesStore.get(att.content.note_id);
      return parent && !parent.deleted && !parent.content?.trashed && !parent.content?.archived;
    }).length;
    const tags = NotesStore.listTags().length;
    const statsText = `${notes.length} note${notes.length === 1 ? '' : 's'} · ${docs} document${docs === 1 ? '' : 's'} · ${tags} tag${tags === 1 ? '' : 's'}`;
    el.textContent = statsText;
    el.title = statsText;
  }

  function updateNoteInfoPanel(note) {
    const created = document.getElementById('note-info-created');
    const updated = document.getElementById('note-info-updated');
    const words = document.getElementById('note-info-words');
    const attachments = document.getElementById('note-info-attachments');
    const editor = document.getElementById('note-info-editor');
    const tagsEl = document.getElementById('note-info-tags');
    const idText = document.getElementById('note-info-id-text');
    if (!created || !note) return;
    if (note.content?.locked && !unlockedNotes.has(note.uuid)) return;
    const { words: wordCount, minutes } = readingTime(noteReadableText(note));
    const attCount = NotesStore.listAttachments(note.uuid).length;
    const tagNames = (note.content.tags || [])
      .map((id) => tagMap().get(id))
      .filter(Boolean)
      .map((t) => t.content.title)
      .join(', ');
    created.textContent = formatDateTime(note.content.created_at);
    updated.textContent = formatDateTime(noteEditedAtMs(note));
    words.textContent = `${wordCount} · ${minutes} min read`;
    attachments.textContent = String(attCount);
    editor.textContent = EDITOR_LABELS[note.content.editor || 'plain'] || 'Plain text';
    tagsEl.textContent = tagNames || 'None';
    if (idText) idText.textContent = note.uuid;
    const isLocked = !!note.content.locked;
    const protectBtn = document.getElementById('note-info-protect');
    if (protectBtn) {
      protectBtn.setAttribute('aria-pressed', isLocked ? 'true' : 'false');
      protectBtn.classList.toggle('is-locked', isLocked);
      protectBtn.classList.toggle('is-unlocked', !isLocked);
      protectBtn.querySelector('.lock-closed')?.toggleAttribute('hidden', !isLocked);
      protectBtn.querySelector('.lock-open')?.toggleAttribute('hidden', isLocked);
      const protectText = document.getElementById('note-info-protect-text');
      if (protectText) {
        protectText.textContent = isLocked ? 'Remove note protection' : 'Protect note';
      } else {
        protectBtn.textContent = isLocked ? 'Remove note protection' : 'Protect note';
      }
    }
    const lockedEl = document.getElementById('note-info-locked');
    if (lockedEl) {
      if (isLocked) {
        lockedEl.innerHTML = '<span class="note-info-status is-locked">'
          + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
          + '</svg> Password locked</span>';
      } else {
        lockedEl.innerHTML = '<span class="note-info-status is-unlocked">'
          + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0"/>'
          + '</svg> Unlocked</span>';
      }
    }
    const warnInput = document.getElementById('note-warn-at');
    if (warnInput) {
      warnInput.value = toDatetimeLocalValue(note.content.warn_at);
      syncWarnFieldState(warnInput);
    }
    const warnHint = document.getElementById('note-warn-hint');
    if (warnHint) {
      const warnMs = parseTimestampMs(note.content.warn_at);
      if (!Number.isFinite(warnMs) || warnMs <= 0) {
        warnHint.textContent = 'Email a link to this note at the chosen time. The email never contains the title or contents.';
      } else if (warnMs <= Date.now()) {
        warnHint.textContent = `Emailed at ${formatDateTime(warnMs)}. Pick a new time to send again, or Clear.`;
      } else {
        warnHint.textContent = `Email a link at ${formatDateTime(warnMs)}. Sign in and unlock to open it.`;
      }
    }
    syncNoteInfoActions(note);
  }

  function syncWarnFieldState(input) {
    const field = document.getElementById('note-warn-field');
    if (!field) return;
    const empty = !(input?.value || '').trim();
    field.classList.toggle('is-empty', empty);
  }

  function noteReminderPayload(note, iso) {
    const when = iso || note?.content?.warn_at || '';
    const ms = parseTimestampMs(when);
    if (!note?.uuid || !Number.isFinite(ms) || ms <= 0) return null;
    // Zero-knowledge: the server only learns the note id and the time.
    return {
      item_uuid: note.uuid,
      warn_at: Math.floor(ms / 1000),
    };
  }

  // Server-side reminder rows must follow the note's lifecycle (trash, restore,
  // delete). Those calls can fail offline, so failures are queued and replayed
  // after the next successful sync instead of being silently dropped.
  const REMINDER_PENDING_KEY = 'notes_reminder_pending';

  function loadPendingReminderOps() {
    try {
      const raw = JSON.parse(localStorage.getItem(REMINDER_PENDING_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function savePendingReminderOps(ops) {
    try {
      if (Object.keys(ops).length) localStorage.setItem(REMINDER_PENDING_KEY, JSON.stringify(ops));
      else localStorage.removeItem(REMINDER_PENDING_KEY);
    } catch (err) { /* ignore quota */ }
  }

  function queueReminderOp(uuid, op) {
    if (!uuid) return;
    const ops = loadPendingReminderOps();
    ops[uuid] = op;
    savePendingReminderOps(ops);
  }

  function dropReminderOp(uuid) {
    const ops = loadPendingReminderOps();
    if (uuid in ops) {
      delete ops[uuid];
      savePendingReminderOps(ops);
    }
  }

  async function applyReminderOp(uuid, op) {
    if (op === 'cancel') {
      await NotesStore.api(`/api/reminders/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
      return;
    }
    const payload = noteReminderPayload(NotesStore.get(uuid));
    if (!payload) return;
    await NotesStore.api('/api/reminders', { method: 'POST', body: JSON.stringify(payload) });
  }

  function noteHasReminder(note) {
    const ms = parseTimestampMs(note?.content?.warn_at);
    return Number.isFinite(ms) && ms > 0;
  }

  function cancelNoteReminder(uuid, { note } = {}) {
    if (!uuid) return;
    const target = note || NotesStore.get(uuid);
    if (target && !noteHasReminder(target)) return;
    queueReminderOp(uuid, 'cancel');
    applyReminderOp(uuid, 'cancel')
      .then(() => dropReminderOp(uuid))
      .catch(() => toast('Time warning will be cancelled when you are back online', true));
  }

  function restoreNoteReminder(note) {
    if (!note?.uuid || !noteHasReminder(note)) return;
    queueReminderOp(note.uuid, 'restore');
    applyReminderOp(note.uuid, 'restore')
      .then(() => dropReminderOp(note.uuid))
      .catch(() => toast('Time warning will be re-armed when you are back online', true));
  }

  let reminderReconcileInFlight = null;

  function reconcileReminderSideEffects() {
    if (reminderReconcileInFlight) return reminderReconcileInFlight;
    const ops = loadPendingReminderOps();
    const entries = Object.entries(ops);
    if (!entries.length) return Promise.resolve();
    reminderReconcileInFlight = (async () => {
      for (const [uuid, op] of entries) {
        try {
          await applyReminderOp(uuid, op);
          dropReminderOp(uuid);
        } catch (err) {
          if (err?.status === 400 || err?.status === 404) dropReminderOp(uuid);
        }
      }
    })().finally(() => { reminderReconcileInFlight = null; });
    return reminderReconcileInFlight;
  }

  async function saveNoteWarning({ clear = false } = {}) {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    const input = document.getElementById('note-warn-at');
    const iso = clear ? '' : warnAtFromInput(input?.value || '');
    if (!clear && !iso) {
      toast('Choose a date and time');
      return;
    }
    try {
      if (iso) {
        await NotesStore.api('/api/reminders', {
          method: 'POST',
          body: JSON.stringify(noteReminderPayload(note, iso)),
        });
        dropReminderOp(note.uuid);
        const live = NotesStore.get(currentId);
        if (!live) return;
        live.content.warn_at = iso;
        NotesStore.upsert(currentId, { ...live.content });
        toast('Time warning saved');
      } else {
        await NotesStore.api(`/api/reminders/${encodeURIComponent(note.uuid)}`, { method: 'DELETE' });
        dropReminderOp(note.uuid);
        const live = NotesStore.get(currentId);
        if (!live) return;
        live.content.warn_at = '';
        NotesStore.upsert(currentId, { ...live.content });
        if (input) {
          input.value = '';
          syncWarnFieldState(input);
        }
        toast('Time warning cleared');
      }
    } catch (err) {
      toast(err.message || 'Could not save warning', true);
    }
    updateNoteInfoPanel(NotesStore.get(currentId));
    renderNotes();
  }

  function toggleNoteProtection() {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    note.content.locked = !note.content.locked;
    unlockedNotes.delete(currentId);
    NotesStore.upsert(currentId, { ...note.content });
    closeNoteOptions();
    updateActionButtons(NotesStore.get(currentId));
    updateNoteInfoPanel(NotesStore.get(currentId));
    renderNotes();
    toast(note.content.locked ? 'Note protected' : 'Protection removed');
    setEditorChrome(!!note.content.locked);
    if (note.content.locked) {
      const gate = document.getElementById('note-lock-gate');
      if (gate) {
        document.getElementById('note-lock-error').hidden = true;
        document.getElementById('note-lock-password').value = '';
        document.getElementById('note-lock-password').focus();
      }
    }
    NotesStore.flush().then(() => NotesStore.sync({ quiet: true })).catch(() => {});
  }

  function openNoteOptions() {
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    const sheet = document.getElementById('note-options');
    const backdrop = document.getElementById('note-options-backdrop');
    updateNoteInfoPanel(note);
    if (sheet) {
      sheet.hidden = false;
      const body = sheet.querySelector('.note-info');
      if (body) body.scrollTop = 0;
    }
    if (backdrop) backdrop.hidden = false;
  }

  function togglePreventEdit() {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    if (!note.content.prevent_edit) flushSave();
    note.content.prevent_edit = !note.content.prevent_edit;
    NotesStore.upsert(currentId, { ...note.content });
    editorMode = note.content.prevent_edit ? 'preview' : 'edit';
    applyReadOnly(note.content.prevent_edit);
    applyEditorMode();
    updateActionButtons(note);
    renderNotes();
    toast(note.content.prevent_edit ? 'Editing disabled' : 'Editing enabled');
    NotesStore.flush().then(() => NotesStore.sync({ quiet: true })).catch(() => {});
  }

  function closeNoteOptions() {
    const sheet = document.getElementById('note-options');
    const backdrop = document.getElementById('note-options-backdrop');
    if (sheet) sheet.hidden = true;
    if (backdrop) backdrop.hidden = true;
  }

  function hideTagSuggest() {
    pendingSuggest = null;
    const el = document.getElementById('tag-suggest');
    if (el) el.hidden = true;
  }

  let pendingSuggest = null;

  function showTagSuggest(text, filename, noteId) {
    const suggestion = NotesTagSuggest.suggest(text, NotesStore.listTags(), { filename });
    const note = NotesStore.get(noteId);
    if (!suggestion || !note) {
      hideTagSuggest();
      return;
    }
    if (suggestion.tagId && (note.content.tags || []).includes(suggestion.tagId)) {
      hideTagSuggest();
      return;
    }
    pendingSuggest = { ...suggestion, noteId };
    document.getElementById('tag-suggest-name').textContent = suggestion.existing
      ? suggestion.title
      : `${suggestion.title} (new)`;
    document.getElementById('tag-suggest').hidden = false;
  }

  function fileStem(name) {
    return String(name || 'Scanned document').replace(/\.[^.]+$/, '').trim() || 'Scanned document';
  }

  function namedDocument(name, original) {
    const ext = (String(original || '').match(/\.[^.]+$/) || [''])[0];
    const cleaned = String(name || '').trim();
    if (!cleaned) return original || 'document';
    if (ext && !cleaned.toLowerCase().endsWith(ext.toLowerCase())) return `${cleaned}${ext}`;
    return cleaned;
  }

  let pendingScan = null;
  const scanPageUrls = [];

  function isScanImage(file) {
    const mime = String(file?.type || '').toLowerCase();
    const name = String(file?.name || '').toLowerCase();
    return mime.startsWith('image/')
      || mime === 'image/heic'
      || mime === 'image/heif'
      || /\.(png|jpe?g|webp|gif|bmp|tif|tiff|hei[cf])$/.test(name);
  }

  function isScanDocument(file) {
    const mime = String(file?.type || '').toLowerCase();
    const name = String(file?.name || '').toLowerCase();
    if (mime === 'application/pdf' || mime.startsWith('text/')) return true;
    if (/\.(pdf|txt|md|csv)$/.test(name)) return true;
    if ((mime === '' || mime === 'application/octet-stream') && /\.(pdf|txt|md|csv)$/.test(name)) return true;
    return false;
  }

  function useNativeFileInput() {
    if (typeof window.showOpenFilePicker !== 'function') return true;
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
  }

  function setScanFeedback(message, { isError = false } = {}) {
    const label = document.getElementById('scan-file-label');
    if (label) {
      label.hidden = false;
      label.textContent = message;
      label.classList.toggle('scan-feedback-error', !!isError);
    }
    toast(message, isError);
  }

  function clearScanFeedback() {
    const label = document.getElementById('scan-file-label');
    if (label) label.classList.remove('scan-feedback-error');
  }

  async function snapshotPickedFile(file) {
    if (!file) return null;
    try {
      const bytes = await file.arrayBuffer();
      if (!bytes || !bytes.byteLength) throw new Error('empty file');
      return new File([bytes], file.name || 'document', {
        type: file.type || 'application/octet-stream',
        lastModified: file.lastModified,
      });
    } catch (err) {
      const msg = 'Could not read that file. Try choosing it again.';
      if (pendingScan && !document.getElementById('scan-dialog')?.hidden) setScanFeedback(msg, { isError: true });
      else toast(msg, true);
      return null;
    }
  }

  const DEVICE_PICK_TYPES = [{
    description: 'Documents and images',
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif'],
      'application/pdf': ['.pdf'],
      'text/plain': ['.txt', '.md', '.csv'],
    },
  }];
  const UPLOAD_PICKER_ID = 'deeperguard-upload';
  const UPLOAD_DIR_META_KEY = 'uploadPickerDir';

  async function loadUploadPickerStartIn() {
    if (typeof NotesIDB?.getMeta !== 'function') return undefined;
    try {
      const dir = await NotesIDB.getMeta(UPLOAD_DIR_META_KEY);
      return dir && typeof dir === 'object' ? dir : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function rememberUploadPickerDirectory(handles) {
    const list = Array.isArray(handles) ? handles : [];
    const fileHandle = list.find((h) => h && typeof h.getParent === 'function');
    if (!fileHandle || typeof NotesIDB?.putMeta !== 'function') return;
    try {
      const dir = await fileHandle.getParent();
      if (dir) await NotesIDB.putMeta(UPLOAD_DIR_META_KEY, dir);
    } catch (_) {
      /* picker still works without a remembered folder */
    }
  }

  async function openDeviceFilePicker({ multiple = false, startIn } = {}) {
    const options = {
      multiple,
      types: DEVICE_PICK_TYPES,
      id: UPLOAD_PICKER_ID,
    };
    if (startIn) options.startIn = startIn;
    return window.showOpenFilePicker(options);
  }

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

  function toFileArray(files) {
    if (!files) return [];
    if (Array.isArray(files)) return files.filter(Boolean);
    return Array.from(files).filter(Boolean);
  }

  function sourceLabelFromFiles(files, fallback = 'document') {
    const list = toFileArray(files);
    if (!list.length) return fallback;
    if (list.length === 1) return list[0].name || fallback;
    return `${list.length} files`;
  }

  async function pickDeviceFiles({ multiple = false } = {}) {
    if (typeof window.showOpenFilePicker !== 'function') return null;
    beginNotesPicker();
    const startIn = await loadUploadPickerStartIn();
    try {
      let handles;
      try {
        handles = await openDeviceFilePicker({ multiple, startIn });
      } catch (err) {
        if (startIn && err && err.name !== 'AbortError') {
          handles = await openDeviceFilePicker({ multiple });
        } else {
          throw err;
        }
      }
      const list = Array.isArray(handles) ? handles : [handles];
      await rememberUploadPickerDirectory(list);
      const files = await Promise.all(list.map((handle) => handle.getFile()));
      return { files, handles: list };
    } catch (err) {
      if (err && err.name === 'AbortError') return { files: [], handles: [] };
      return null;
    } finally {
      endNotesPicker();
    }
  }

  async function offerRemoveUploadedSource(source) {
    if (!source) return;
    const handles = (source.handles || []).filter((h) => h && typeof h.remove === 'function');
    const fromDevice = !!source.fromDevice;
    if (!fromDevice && !handles.length) return;
    const label = String(source.label || 'this file').trim() || 'this file';
    const manualOnly = fromDevice && !handles.length;
    const message = manualOnly
      ? (source.fromCamera
        ? `Remove the photo from your library? “${label}” is already saved in Deeperguard.`
        : `Remove the original from this device? “${label}” is already saved in Deeperguard.`)
      : `Remove “${label}” from this device? Your saved copy in Deeperguard stays.`;
    const ok = await confirmAction(message, {
      title: 'Remove from device?',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    if (handles.length) {
      let removed = 0;
      for (const handle of handles) {
        try {
          await handle.remove();
          removed += 1;
        } catch (_) { /* keep trying remaining handles */ }
      }
      if (removed === handles.length) {
        toast(removed === 1 ? 'Original removed from device' : `${removed} originals removed from device`);
      } else if (removed > 0) {
        toast(`Removed ${removed} of ${handles.length} originals`, true);
      } else {
        toast('Could not remove the original from this device', true);
      }
      return;
    }
    toast(
      source.fromCamera
        ? 'Open Photos and delete the original — iPhone browsers cannot remove it automatically.'
        : 'Open Photos or Files and delete the original — iPhone browsers cannot remove it automatically.',
    );
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

  function clearScanPageUrls() {
    scanPageUrls.splice(0).forEach((url) => {
      try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    });
  }

  let scanKeyboardInsetCleanup = null;

  function applyScanKeyboardInset() {
    const dialog = document.getElementById('scan-dialog');
    if (!dialog || dialog.hidden || !globalThis.visualViewport) return;
    const vv = globalThis.visualViewport;
    const gap = Math.max(0, (globalThis.innerHeight || 0) - vv.height - vv.offsetTop);
    dialog.style.setProperty('--scan-kb-offset', `${Math.round(gap)}px`);
  }

  function bindScanKeyboardInset() {
    if (scanKeyboardInsetCleanup) return;
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const onViewportChange = () => applyScanKeyboardInset();
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
    scanKeyboardInsetCleanup = () => {
      vv.removeEventListener('resize', onViewportChange);
      vv.removeEventListener('scroll', onViewportChange);
      scanKeyboardInsetCleanup = null;
    };
    applyScanKeyboardInset();
  }

  function unbindScanKeyboardInset() {
    if (scanKeyboardInsetCleanup) scanKeyboardInsetCleanup();
    const dialog = document.getElementById('scan-dialog');
    dialog?.style.removeProperty('--scan-kb-offset');
  }

  function hideScanDialog() {
    pendingScan = null;
    clearScanPageUrls();
    const dialog = document.getElementById('scan-dialog');
    const backdrop = document.getElementById('scan-backdrop');
    if (dialog) dialog.hidden = true;
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove('scan-dialog-open');
    unbindScanKeyboardInset();
    const err = document.getElementById('scan-name-error');
    if (err) err.hidden = true;
  }

  function showScanDialog() {
    // Settings panel sits at the same stacking level; close it so file pickers receive taps.
    closeSettings(true);
    hideTotpAddDialog();
    const dialog = document.getElementById('scan-dialog');
    const wasHidden = dialog.hidden;
    document.getElementById('scan-name-error').hidden = true;
    document.getElementById('scan-backdrop').hidden = false;
    dialog.hidden = false;
    document.body.classList.add('scan-dialog-open');
    bindScanKeyboardInset();
    renderScanPages();
    const name = document.getElementById('scan-name');
    if (!name.value) {
      const first = pendingScan?.pages?.[0] || pendingScan?.file;
      name.value = first ? fileStem(first.name) : '';
    }
    if (wasHidden && !('ontouchstart' in globalThis)) {
      name.focus();
      name.select();
    }
  }

  function renderScanPages() {
    const host = document.getElementById('scan-pages');
    const label = document.getElementById('scan-file-label');
    const empty = document.getElementById('scan-empty');
    const add = document.querySelector('.scan-add-actions');
    if (!host) return;
    clearScanPageUrls();
    const pages = pendingScan?.pages || [];
    const doc = pendingScan?.file;
    host.replaceChildren();
    if (doc) {
      host.hidden = true;
      if (empty) empty.hidden = true;
      if (label) {
        label.hidden = false;
        label.textContent = `File: ${doc.name || 'selected file'}`;
      }
      if (add) add.hidden = true;
      applyScanKeyboardInset();
      return;
    }
    if (add) add.hidden = false;
    host.hidden = !pages.length;
    if (empty) empty.hidden = pages.length > 0;
    pages.forEach((file, index) => {
      const card = document.createElement('div');
      card.className = 'scan-page';
      const img = document.createElement('img');
      const url = URL.createObjectURL(file);
      scanPageUrls.push(url);
      img.src = url;
      img.alt = `Page ${index + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'scan-page-remove';
      remove.setAttribute('aria-label', `Remove page ${index + 1}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => removeScanPage(index));
      card.appendChild(img);
      card.appendChild(remove);
      host.appendChild(card);
    });
    const limit = (window.NotesOcr && NotesOcr.MAX_SCAN_PAGES) || 6;
    if (label) {
      if (pages.length) {
        label.hidden = false;
        label.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} · ${limit} max`;
      } else {
        label.hidden = true;
        label.textContent = '';
      }
    }
    applyScanKeyboardInset();
  }

  function openScanComposer({ createIfNeeded = true } = {}) {
    pendingScan = { file: null, pages: [], createIfNeeded, sourceRemoval: emptyUploadSource() };
    document.getElementById('scan-name').value = '';
    clearScanFeedback();
    showScanDialog();
  }

  function openScanDialog(file, { createIfNeeded = false, sourceRemoval = null } = {}) {
    if (!file) {
      openScanComposer({ createIfNeeded });
      return;
    }
    const source = sourceRemoval || emptyUploadSource();
    if (isScanDocument(file)) {
      pendingScan = {
        file,
        pages: [],
        createIfNeeded,
        sourceRemoval: mergeUploadSource(source, { label: file.name }),
      };
    } else {
      pendingScan = {
        file: null,
        pages: [file],
        createIfNeeded,
        sourceRemoval: mergeUploadSource(source, { label: file.name }),
      };
    }
    showScanDialog();
  }

  function scanFileKey(file) {
    return `${String(file?.name || '')}|${Number(file?.size || 0)}|${String(file?.type || '')}`;
  }

  function addScanFile(file, { sourceRemoval = null } = {}) {
    if (!file) return false;
    if (!pendingScan) {
      pendingScan = { file: null, pages: [], createIfNeeded: true, sourceRemoval: emptyUploadSource() };
    }
    pendingScan.sourceRemoval = mergeUploadSource(
      pendingScan.sourceRemoval || emptyUploadSource(),
      sourceRemoval || { label: file.name },
    );
    const fileKey = scanFileKey(file);
    if (isScanDocument(file)) {
      if ((pendingScan.pages || []).length) {
        setScanFeedback('Finish the photo scan first, or cancel and choose the PDF.', { isError: true });
        return false;
      }
      if (pendingScan.fileKey && pendingScan.fileKey === fileKey) {
        setScanFeedback('That file is already in this scan', { isError: true });
        return false;
      }
      pendingScan.file = file;
      pendingScan.fileKey = fileKey;
      pendingScan.pages = [];
      pendingScan.pageKeys = [];
      clearScanFeedback();
      showScanDialog();
      return true;
    }
    if (!isScanImage(file)) {
      setScanFeedback('Use a photo, PDF, or text file.', { isError: true });
      return false;
    }
    if (pendingScan.file) {
      setScanFeedback('This scan is already a PDF. Cancel to start a photo scan.', { isError: true });
      return false;
    }
    const limit = (window.NotesOcr && NotesOcr.MAX_SCAN_PAGES) || 6;
    pendingScan.pages = pendingScan.pages || [];
    pendingScan.pageKeys = pendingScan.pageKeys || [];
    if (pendingScan.pageKeys.includes(fileKey)) {
      setScanFeedback('That page is already in this scan', { isError: true });
      return false;
    }
    if (pendingScan.pages.length >= limit) {
      setScanFeedback(`Scan at most ${limit} pages`, { isError: true });
      return false;
    }
    pendingScan.pages.push(file);
    pendingScan.pageKeys.push(fileKey);
    clearScanFeedback();
    showScanDialog();
    return true;
  }

  function removeScanPage(index) {
    if (!pendingScan?.pages) return;
    pendingScan.pages.splice(index, 1);
    pendingScan.pageKeys?.splice(index, 1);
    renderScanPages();
  }

  async function confirmScanDialog() {
    const name = document.getElementById('scan-name').value.trim();
    if (!name) {
      document.getElementById('scan-name-error').hidden = false;
      document.getElementById('scan-name').focus();
      return;
    }
    const pending = pendingScan;
    if (!pending) return;
    let file = pending.file;
    if (!file && pending.pages?.length) {
      try {
        toast(pending.pages.length > 1 ? 'Combining pages…' : 'Preparing photo…');
        file = await NotesOcr.prepareImages(pending.pages, {
          onStatus: (msg) => toast(msg),
        });
      } catch (err) {
        toast(err.message || 'Could not prepare that scan', true);
        return;
      }
    }
    if (!file) {
      toast('Take a photo or choose a file first', true);
      return;
    }
    hideScanDialog();
    const sourceRemoval = sourceRemovalFromPending(pending);
    await ingestDocument(file, {
      createIfNeeded: pending.createIfNeeded,
      title: name,
      displayName: namedDocument(name, file.name),
      sourceRemoval,
    });
  }

  async function ingestDocument(file, { createIfNeeded = false, title, displayName, sourceRemoval = null } = {}) {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const docName = String(title || '').trim();
    if (!docName) {
      openScanDialog(file, { createIfNeeded });
      return;
    }
    const maxBytes = NotesStore.maxAttachmentBytes || (50 * 1024 * 1024);
    if (file.size > maxBytes) {
      toast(`File too large (max ${maxBytes / 1024 / 1024} MB)`, true);
      return;
    }
    if (IS_IOS && file.size > 20 * 1024 * 1024) {
      toast(`Large file (${Math.round(file.size / (1024 * 1024))} MB) — upload may be slow on cellular`, true);
    }
    let localFile = file;
    try {
      const bytes = await file.arrayBuffer();
      if (!bytes || !bytes.byteLength) throw new Error('empty file');
      localFile = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
    } catch (err) {
      toast('Could not read that file. Try choosing it again.', true);
      return;
    }
    let storeFile = localFile;
    let sourceSha256 = '';
    const sourceBytes = new Uint8Array(await localFile.arrayBuffer());
    if (window.NotesOcr && isScanImage(localFile) && NotesOcr.needsPrepare([localFile])) {
      try {
        sourceSha256 = await NotesCrypto.hashBytes(sourceBytes);
        const prepMsg = NotesOcr.isHeic?.(localFile) ? 'Converting HEIC…' : 'Preparing photo…';
        toast(prepMsg);
        storeFile = await NotesOcr.prepareImages([localFile], {
          onStatus: (msg) => toast(msg),
        });
      } catch (err) {
        toast(err.message || 'Could not prepare that photo', true);
        return;
      }
    }
    let contentSha256 = '';
    try {
      contentSha256 = await NotesCrypto.hashBytes(new Uint8Array(await storeFile.arrayBuffer()));
    } catch (_) {
      contentSha256 = '';
    }
    const duplicate = await NotesStore.findDuplicateAttachment({
      contentSha256,
      sourceSha256,
    });
    if (duplicate) {
      const targetNoteId = (!createIfNeeded && currentId) ? currentId : null;
      await showDuplicateDialog(duplicate, storeFile, targetNoteId);
      return;
    }
    let created = false;
    let id = currentId;
    if (!id || createIfNeeded) {
      if (ui.search && ui.search.value) {
        ui.search.value = '';
        ui.search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (currentFilter !== 'all' && currentFilter !== 'documents' && currentFilter !== 'untagged') {
        setFilter('all');
      }
      id = createNote({ silent: true, title: docName });
      created = true;
      if (!id) {
        toast('Could not create note for this document', true);
        return;
      }
    } else {
      const note = NotesStore.get(id);
      if (note && (!note.content.title || note.content.title === 'Untitled')) {
        ui.title.value = docName;
        flushSave();
      }
    }
    toast('Saving document…');
    ingestBusy = true;
    let attId;
    try {
      attId = await NotesStore.addAttachment(id, storeFile, {
        displayName: displayName || namedDocument(docName, storeFile.name),
        sourceSha256,
      });
      editorMode = 'preview';
      if (currentId === id) {
        renderAttachments(id);
        applyEditorMode();
        updateNoteMeta(NotesStore.get(id));
      }
      renderNotes();
    } catch (err) {
      if (isDuplicateUploadError(err.message)) {
        await showDuplicateDialog(null, storeFile, id, err.message);
      } else {
        toast(err.message || 'Upload failed', true);
      }
      if (created && id && !NotesStore.listAttachments(id).length) {
        NotesStore.remove(id);
        if (currentId === id) closeEditor();
        else renderNotes();
      }
      return;
    } finally {
      ingestBusy = false;
    }
    enqueueOcrJob({ attId, noteId: id, file: storeFile, suggestTags: true });
    await offerRemoveUploadedSource(sourceRemoval);
    toast('Document saved — reading text in the background');
  }

  function canOcrAttachment(item) {
    const mime = item?.content?.mime || '';
    const name = item?.content?.filename || '';
    return mime.startsWith('text/')
      || mime.startsWith('image/')
      || mime === 'application/pdf'
      || /\.(txt|md|csv|pdf|png|jpe?g|webp|gif|bmp|hei[cf])$/i.test(name);
  }

  // Light vault: background OCR must not pull every file onto the device.
  async function skipOcrForLightVault(attId) {
    if (!NotesStore.lightVaultEnabled?.()) return false;
    return !(await NotesStore.hasLocalAttachmentBytes(attId));
  }

  async function refreshLocalFilesSummary() {
    const el = document.getElementById('local-files-summary');
    if (!el) return;
    if (!NotesStore.isUnlocked()) {
      el.textContent = '';
      return;
    }
    const atts = NotesStore.listAttachments();
    let local = 0;
    for (const att of atts) {
      if (await NotesStore.hasLocalAttachmentBytes(att.uuid)) local += 1;
    }
    const mode = prefs.lightVault ? 'Files download when you open their note.' : 'All files are kept on this device.';
    el.textContent = atts.length
      ? `${local} of ${atts.length} file${atts.length === 1 ? '' : 's'} stored on this device. ${mode}`
      : mode;
    const purgeBtn = document.getElementById('btn-purge-local-files');
    if (purgeBtn) purgeBtn.disabled = !local;
  }

  function enqueueOcrJob(job) {
    if (!job?.attId || ocrQueued.has(job.attId)) return;
    ocrQueued.add(job.attId);
    ocrQueue.push(job);
    lastNotesRenderKey = '';
    scheduleOcrUiRefresh(job.noteId ? [job.noteId] : null);
    startOcrUiWatch();
    runOcrQueue();
  }

  function attachmentNeedsBoxes(att) {
    return !attachmentOcrSettled(att);
  }

  function attachmentNeedsOcrRetry(att) {
    if (!att || !canOcrAttachment(att)) return false;
    const method = att.content?.ocr_method || '';
    if (!method || method === 'failed') return true;
    if (method === 'none') return false;
    const current = Number(NotesStore.OCR_INDEX || 0);
    if (current && Number(att.content.ocr_index) !== current) return true;
    const mime = att.content.mime || '';
    if (!String(att.content.ocr_text || '').trim() && !mime.startsWith('text/')) return true;
    return attachmentNeedsBoxes(att);
  }

  async function enqueueRetryOcrJobs({ quiet = false } = {}) {
    if (!NotesStore.isUnlocked()) return 0;
    const retry = NotesStore.listAttachments().filter(attachmentNeedsOcrRetry);
    if (!retry.length) return 0;
    let queued = 0;
    for (const att of retry) {
      if (ocrQueued.has(att.uuid)) continue;
      if (await skipOcrForLightVault(att.uuid)) continue;
      try {
        const bytes = await NotesStore.getAttachmentBytes(att.uuid);
        if (!bytes) continue;
        const name = att.content.filename || 'document';
        const file = new File([bytes], name, {
          type: att.content.mime || 'application/octet-stream',
        });
        enqueueOcrJob({
          attId: att.uuid,
          noteId: att.content.note_id,
          file,
          force: true,
        });
        queued += 1;
      } catch (err) {
        console.warn('OCR retry skipped', att.uuid, err);
      }
    }
    if (queued && !quiet) {
      toast(`Retrying OCR for ${queued} document${queued === 1 ? '' : 's'}…`);
    }
    return queued;
  }

  async function applyServerOcrItem(item) {
    const attId = item?.att_id;
    if (!attId || !item.method) return false;
    serverOcrKnown.add(attId);
    if (!NotesStore.get(attId)) return false;
    const live = NotesStore.get(attId);
    const stored = normalizeOcrStorage(
      item.text || '',
      Array.isArray(item.boxes) ? item.boxes : [],
      live?.content?.mime,
      live?.content?.filename,
      item.ocr_quality,
      item.method || 'client',
    );
    const changed = NotesStore.setAttachmentOcr(
      attId,
      stored.text,
      stored.method,
      Array.isArray(item.boxes) ? item.boxes : [],
    );
    let previewChanged = false;
    if (item.preview_jpeg_b64 && window.NotesOcr?.decodePreviewB64) {
      const jpeg = NotesOcr.decodePreviewB64(item.preview_jpeg_b64);
      if (jpeg?.length) previewChanged = await NotesStore.setAttachmentPreview(attId, jpeg);
    }
    const noteId = live?.content?.note_id;
    const searchUpdated = noteId ? NotesStore.refreshNoteSearchText(noteId) : false;
    if (searchUpdated && noteId) scheduleOcrUiRefresh([noteId]);
    return changed || searchUpdated || previewChanged;
  }

  async function purgeServerOcr(attId) {
    if (!attId || !window.NotesOcr?.deleteOcrData) return;
    try {
      await NotesOcr.deleteOcrData(attId);
    } catch (err) {
      console.warn('server OCR cleanup failed', attId, err);
    }
  }

  async function queueLocalOcrForAttachments(atts, { force = true } = {}) {
    let queued = 0;
    for (const att of atts || []) {
      if (!att?.uuid || ocrQueued.has(att.uuid) || !canOcrAttachment(att)) continue;
      if (await skipOcrForLightVault(att.uuid)) continue;
      try {
        const bytes = await NotesStore.getAttachmentBytes(att.uuid);
        if (!bytes) continue;
        const name = att.content.filename || 'document';
        const file = new File([bytes], name, {
          type: att.content.mime || 'application/octet-stream',
        });
        enqueueOcrJob({
          attId: att.uuid,
          noteId: att.content.note_id,
          file,
          force,
        });
        queued += 1;
      } catch (err) {
        console.warn('OCR queue skipped', att.uuid, err);
      }
    }
    return queued;
  }

  async function pullNoteOcrFromServer(noteId) {
    if (!noteId || !NotesStore.isUnlocked()) return 0;
    let updated = 0;
    if (noteSearchStale(noteId)) {
      if (NotesStore.refreshNoteSearchText(noteId)) updated += 1;
    }
    const atts = NotesStore.listAttachments(noteId).filter(canOcrAttachment);
    const needsServer = atts.filter((att) => {
      if (attachmentNeedsOcrRetry(att)) return true;
      const method = att.content?.ocr_method || '';
      return !method || method === 'failed';
    });
    if (!needsServer.length) {
      if (updated) scheduleOcrUiRefresh();
      return updated;
    }
    const queued = await queueLocalOcrForAttachments(needsServer, { force: true });
    if (queued) updated += queued;
    if (updated) scheduleOcrUiRefresh();
    return updated;
  }

  function applyServerOcrIndex(items) {
    let applied = 0;
    const work = (items || []).map((item) => applyServerOcrItem(item).then((ok) => {
      if (ok) applied += 1;
    }));
    return Promise.all(work).then(() => {
      if (applied) scheduleOcrUiRefresh();
      return applied;
    });
  }

  async function ensureOpenedAttachmentIndexed(attId, entry) {
    if (!attId || !entry) return true;
    const item = NotesStore.get(attId);
    if (item && attachmentOcrSettled(item)) {
      serverOcrKnown.add(attId);
      return true;
    }
    if (serverOcrKnown.has(attId)) return true;
    const pending = serverOcrInFlight.get(attId);
    if (pending) return pending;
    const work = (async () => {
      const name = entry.filename || 'document';
      try {
        toast(`Indexing ${name} on this device…`);
        const file = NotesPreview.fileFromBytes(entry.bytes, name, entry.mime);
        const result = await NotesOcr.extractFromFile(file, null, attId);
        await applyServerOcrItem({ ...result, att_id: attId });
        const finish = ocrFinishToast(result?.text, result?.boxes, file, { refresh: true, qualityHint: result?.ocr_quality });
        toast(finish.message, finish.warn);
        return true;
      } catch (err) {
        toast(`Could not index ${name}: ${err.message || 'OCR error'}`, true);
        return false;
      }
    })();
    serverOcrInFlight.set(attId, work);
    work.finally(() => {
      if (serverOcrInFlight.get(attId) === work) serverOcrInFlight.delete(attId);
    });
    return work;
  }

  async function resumePendingOcr() {
    if (!NotesStore.isUnlocked()) return 0;
    const queued = await enqueueRetryOcrJobs({ quiet: true });
    refreshAllNoteSearchIndexes();
    resumePendingListPreviews().catch(() => {});
    return queued;
  }

  async function reindexAllDocuments() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return 0;
    }
    toast('Reindexing documents on this device…');
    const atts = NotesStore.listAttachments().filter(canOcrAttachment);
    const queued = await queueLocalOcrForAttachments(atts, { force: true });
    refreshAllNoteSearchIndexes();
    resumePendingListPreviews().catch(() => {});
    toast(queued
      ? `Queued OCR for ${queued} document${queued === 1 ? '' : 's'}…`
      : 'No documents to reindex');
    return queued;
  }

  async function runOcrQueue() {
    if (ocrBusy) return;
    ocrBusy = true;
    while (ocrQueue.length) {
      const job = ocrQueue.shift();
      const existing = NotesStore.get(job.attId);
      const refresh = !!existing?.content?.ocr_method;
      if (!job.force && existing && existing.content.ocr_method && !attachmentNeedsBoxes(existing)) {
        ocrQueued.delete(job.attId);
        continue;
      }
      scheduleOcrUiRefresh(job.noteId ? [job.noteId] : null);
      try {
        const { text } = await ensureAttachmentOcr(job.attId, job.file, (msg) => {
          if (!refresh && msg && typeof msg.progress === 'number') {
            const now = Date.now();
            if (now - ocrProgressToastAt < 1200) return;
            ocrProgressToastAt = now;
            toast(`Processing ${Math.round(msg.progress * 100)}%`);
          }
        }, { force: !!job.force });
        ocrDeferred.delete(job.attId);
        ocrWaitingServer.delete(job.attId);
        NotesStore.refreshNoteSearchText(job.noteId);
        lastNotesRenderKey = '';
        // Only a freshly scanned document earns a tag suggestion — never OCR retries.
        if (currentId === job.noteId && job.suggestTags && !refresh) {
          showTagSuggest(text || job.file.name, job.file.name, job.noteId);
        }
        scheduleOcrUiRefresh();
        if (ui.search?.value?.trim() && job.noteId) repairSearchIndexesForQuery();
        const left = ocrQueue.length;
        const name = job.file?.name || 'document';
        if (job.seed) {
          if (left) toast(`Sent ${name} · ${left} left`);
          else {
            const finish = ocrFinishToast(text, NotesStore.get(job.attId)?.content?.ocr_boxes, job.file, { refresh: true });
            toast(finish.message, finish.warn);
          }
        } else if (!refresh) {
          const finish = ocrFinishToast(text, NotesStore.get(job.attId)?.content?.ocr_boxes, job.file);
          toast(finish.message, finish.warn);
        }
      } catch (err) {
        if (refresh) {
          console.warn('box refresh failed', err);
          const live = NotesStore.get(job.attId);
          if (live && !Array.isArray(live.content.ocr_boxes)) {
            NotesStore.setAttachmentOcr(
              job.attId,
              live.content.ocr_text || '',
              live.content.ocr_method,
              [],
            );
          }
        } else if (isTransientOcrError(err)) {
          console.warn('OCR deferred for retry', err);
          deferOcrJob(job);
        } else {
          ocrDeferred.delete(job.attId);
          ocrWaitingServer.delete(job.attId);
          toast(err.message || 'OCR failed', true);
          if (job.attId && NotesStore.get(job.attId)) {
            NotesStore.setAttachmentOcr(job.attId, '', 'failed', []);
          }
        }
      } finally {
        ocrQueued.delete(job.attId);
      }
      if (ocrQueue.length) {
        // Pause between OCR jobs to keep the UI responsive on slower devices.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    refreshAllNoteSearchIndexes();
    ocrBusy = false;
  }

  function createNote({ silent = false, title } = {}) {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    try {
      flushSave();
      const id = NotesStore.newUuid();
      const payload = NotesStore.defaultNote();
      if (title) payload.title = title;
      if (currentTag) payload.tags = [currentTag];
      NotesStore.upsert(id, payload);
      renderNotes();
      renderTags();
      openNote(id);
      if (!silent) {
        ui.title.focus();
        ui.title.select();
        toast('New note');
      }
      return id;
    } catch (err) {
      toast(err.message || String(err), true);
    }
  }

  function createTag(title, { assignToCurrent = false } = {}) {
    const name = String(title || '').trim();
    if (!name) return;
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    try {
      const existing = findTagByTitle(name);
      const id = existing?.uuid || NotesStore.newUuid();
      if (!existing) NotesStore.upsert(id, NotesStore.defaultTag(name));
      if (assignToCurrent && currentId) {
        assignTagToCurrent(id);
      } else if (!assignToCurrent) {
        setFilter('all');
        currentTag = id;
      }
      hideTagComposer();
      renderTags();
      renderNotes();
      if (currentId) renderTagBar(NotesStore.get(currentId));
      toast(existing ? 'Tag added' : 'Tag created');
    } catch (err) {
      toast(err.message || String(err), true);
    }
  }

  function layoutFindBarOverDocViewer() {
    const bar = document.getElementById('find-bar');
    const viewer = ui.docViewer;
    const slot = document.getElementById('doc-viewer-find-slot');
    if (!viewer) return;
    if (slot?.contains(bar)) {
      viewer.style.paddingTop = '';
      return;
    }
    if (!document.body.classList.contains('doc-preview-open') || !bar || bar.hidden) {
      viewer.style.paddingTop = '';
      return;
    }
    requestAnimationFrame(() => {
      if (!document.body.classList.contains('doc-preview-open') || bar.hidden) {
        viewer.style.paddingTop = '';
        return;
      }
      viewer.style.paddingTop = `${Math.ceil(bar.getBoundingClientRect().height)}px`;
    });
  }

  function mountFindBarToDocViewer() {
    const bar = document.getElementById('find-bar');
    const slot = document.getElementById('doc-viewer-find-slot');
    if (!bar || !slot || !activeFindNeedle()) return false;
    if (!findBarOpen()) showFindBar();
    slot.appendChild(bar);
    bar.hidden = false;
    syncFindBarChrome(true);
    layoutFindBarOverDocViewer();
    return true;
  }

  function restoreFindBarToEditor() {
    const bar = document.getElementById('find-bar');
    const slot = document.getElementById('doc-viewer-find-slot');
    const mdToolbar = document.getElementById('md-toolbar');
    const bodyWrap = document.getElementById('note-body-wrap');
    if (!bar || !bodyWrap || !slot) return;
    if (!slot.contains(bar)) return;
    if (mdToolbar) mdToolbar.insertAdjacentElement('afterend', bar);
    else bodyWrap.insertAdjacentElement('beforebegin', bar);
    if (ui.docViewer) ui.docViewer.style.paddingTop = '';
  }

  function syncFindBarChrome(open = findBarOpen()) {
    ui.editor?.classList.toggle('find-open', !!open);
    document.body.classList.toggle('find-bar-open', !!open);
    layoutFindBarOverDocViewer();
  }

  function hideFindBar() {
    const bar = document.getElementById('find-bar');
    if (bar) bar.hidden = true;
    restoreFindBarToEditor();
    findMatches = [];
    findIndex = 0;
    docSearchHitIndex = 0;
    findPaintNeedle = '';
    const status = document.getElementById('find-doc-status');
    if (status) {
      status.hidden = true;
      status.textContent = '';
    }
    syncFindBarChrome(false);
    if (isNotePreviewVisible()) refreshPreview();
    else syncFindHighlights('');
  }

  function findBarOpen() {
    return !document.getElementById('find-bar')?.hidden;
  }

  function currentFindQuery() {
    return String(document.getElementById('find-input')?.value || '').trim();
  }

  function isNotePreviewVisible() {
    return !!ui.preview && !ui.preview.hidden && !!ui.body?.hidden;
  }

  function findMatchOptions() {
    return { caseSensitive: !!findCaseSensitive };
  }

  function normalizeFindIndex() {
    if (!findMatches.length) {
      findIndex = 0;
      return;
    }
    if (findIndex >= findMatches.length) findIndex = 0;
    if (findIndex < 0) findIndex = findMatches.length - 1;
  }

  function bindPreviewTaskToggles() {
    if (!ui.preview || !currentId) return;
    const editor = NotesStore.get(currentId)?.content?.editor || ui.editorType.value || 'plain';
    ui.preview.querySelectorAll('.task-toggle').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        ui.body.value = togglePreviewTaskAt(ui.body.value, editor, idx);
        scheduleSave();
        refreshPreview();
      });
    });
  }

  function updatePreviewFindSelection(hits) {
    hits.forEach((el, i) => el.classList.toggle('search-hit-current', i === findIndex));
    const hit = hits[findIndex];
    if (hit && typeof hit.scrollIntoView === 'function') {
      hit.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    const counter = document.getElementById('find-count');
    if (counter) {
      counter.textContent = hits.length ? `${findIndex + 1}/${hits.length}` : '0/0';
    }
  }

  function refreshPreviewFindContent() {
    if (!currentId || !isNotePreviewVisible()) return [];
    const editor = NotesStore.get(currentId)?.content?.editor || ui.editorType.value || 'plain';
    const needle = currentFindQuery();
    if (editorMode === 'ocr' && noteHasDocs(currentId)) {
      const text = ocrMarkdown(currentId);
      ui.preview.innerHTML = text
        ? (needle
          ? `<p>${NotesSearch.highlightPlain(text.replace(/\n+/g, ' ').trim(), needle, findMatchOptions())}</p>`
          : `<p>${NotesSanitize.escapeHtml(text)}</p>`)
        : '<p class="muted">OCR is still running, or no text was found.</p>';
    } else {
      ui.preview.innerHTML = renderNoteBodyPreview(ui.body.value, editor);
      bindPreviewTaskToggles();
      if (needle) NotesSearch.applyHighlights(ui.preview, needle, findMatchOptions());
      else highlightPreview();
    }
    return [...ui.preview.querySelectorAll('mark.search-hit')];
  }

  function scrollEditFindMatch(match) {
    if (!match || !ui.body) return;
    syncFindHighlights(currentFindQuery());
    ui.body.focus();
    ui.body.setSelectionRange(match.start, match.end);
    const layer = document.getElementById('note-body-highlights');
    const hit = layer?.querySelector('mark.search-hit-current');
    if (hit && typeof hit.scrollIntoView === 'function') {
      hit.scrollIntoView({ block: 'center', inline: 'nearest' });
      syncFindHighlightScroll();
      return;
    }
    const before = ui.body.value.slice(0, match.start);
    const line = (before.match(/\n/g) || []).length;
    const lineHeight = parseFloat(getComputedStyle(ui.body).lineHeight) || 20;
    ui.body.scrollTop = Math.max(0, line * lineHeight - ui.body.clientHeight / 3);
  }

  function advanceFind(delta) {
    if (!currentFindQuery()) {
      runFind();
      return;
    }
    if (!findMatches.length) runFind();
    if (!findMatches.length) return;
    findIndex += delta;
    normalizeFindIndex();
    runFind({ navigate: true });
  }

  function syncFindHighlights(query) {
    const layer = document.getElementById('note-body-highlights');
    const wrap = document.getElementById('note-body-wrap');
    if (!layer || !wrap || !ui.body) return;
    const barOpen = !document.getElementById('find-bar')?.hidden;
    const show = barOpen && !ui.body.hidden && query;
    wrap.classList.toggle('find-active', !!show);
    if (!show) {
      layer.textContent = '';
      return;
    }
    const text = ui.body.value || '';
    const matches = NotesSearch.findMatches(text, query, findMatchOptions());
    if (!matches.length) {
      layer.innerHTML = NotesSanitize.escapeHtml(text);
      syncFindHighlightScroll();
      return;
    }
    let html = '';
    let last = 0;
    matches.forEach((match, index) => {
      html += NotesSanitize.escapeHtml(text.slice(last, match.start));
      const cls = index === findIndex ? 'search-hit search-hit-current' : 'search-hit';
      html += `<mark class="${cls}">${NotesSanitize.escapeHtml(text.slice(match.start, match.end))}</mark>`;
      last = match.end;
    });
    html += NotesSanitize.escapeHtml(text.slice(last));
    layer.innerHTML = html;
    syncFindHighlightScroll();
  }

  function syncFindHighlightScroll() {
    const layer = document.getElementById('note-body-highlights');
    if (!layer || !ui.body) return;
    layer.scrollTop = ui.body.scrollTop;
    layer.scrollLeft = ui.body.scrollLeft;
  }

  function highlightFindPreview() {
    const hits = refreshPreviewFindContent();
    findMatches = hits.map((_, index) => ({ index }));
    normalizeFindIndex();
    updatePreviewFindSelection(hits);
  }

  function scrollFindHit(stage, index) {
    if (!stage) return 0;
    const root = docFindSearchRoot(stage) || stage;
    const hits = NotesPreview.listSearchHits(root);
    if (!hits.length) return 0;
    let idx = index;
    if (idx >= hits.length) idx = 0;
    if (idx < 0) idx = hits.length - 1;
    NotesPreview.scrollHitIntoViewSettled(root, idx);
    updateDocHitNoteCount(stage, idx, hits.length);
    return hits.length;
  }

  async function ensureFindDocumentPainted(needle) {
    const stage = activeDocSearchStage();
    if (!stage) return null;
    const existing = NotesPreview.listSearchHits(stage);
    if (findPaintNeedle === needle && existing.length) return stage;
    if (ui.docViewer && !ui.docViewer.hidden && previewingId) {
      const ok = await paintFindOnOpenDocument(needle);
      return ok ? ui.docStage : null;
    }
    if (editorMode === 'preview' && ui.docInline && !ui.docInline.hidden) {
      const ok = await paintFindOnInlineDocument(currentId, needle);
      return ok ? ui.docInline.querySelector('.doc-inline-stage') : null;
    }
    return null;
  }

  async function paintFindOnOpenDocument(needle) {
    const attId = previewingId;
    if (!attId || ui.docViewer?.hidden || !ui.docStage) return false;
    try {
      const entry = await cachedPreview(attId);
      if (previewingId !== attId) return false;
      await paintDocumentSearch(attId, ui.docStage, entry, needle);
      findPaintNeedle = needle;
      finishDocPreviewFind(ui.docStage, needle, docSearchHitIndex);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function paintFindOnInlineDocument(noteId, needle) {
    const items = NotesStore.listAttachments(noteId);
    const attId = items[0]?.uuid;
    const stage = ui.docInline?.querySelector('.doc-inline-stage');
    if (!attId || !stage || ui.docInline?.hidden) return false;
    try {
      const entry = await cachedPreview(attId);
      if (currentId !== noteId) return false;
      await paintDocumentSearch(attId, stage, entry, needle);
      findPaintNeedle = needle;
      return true;
    } catch (err) {
      return false;
    }
  }

  function runFind({ navigate = false } = {}) {
    const query = document.getElementById('find-input').value;
    const needle = String(query || '').trim();
    const matchOpts = findMatchOptions();
    const counter = document.getElementById('find-count');
    if (!needle) {
      if (counter) counter.textContent = '0/0';
      findPaintNeedle = '';
      findMatches = [];
      findIndex = 0;
      if (isNotePreviewVisible()) refreshPreview();
      else syncFindHighlights('');
      return;
    }
    if (isNotePreviewVisible()) {
      if (editorMode === 'ocr' && noteHasDocs(currentId)) {
        highlightFindPreview();
        syncFindHighlights('');
        return;
      }
      if (navigate) {
        let hits = [...ui.preview.querySelectorAll('mark.search-hit')];
        if (!hits.length || findPaintNeedle !== needle) {
          hits = refreshPreviewFindContent();
          findPaintNeedle = needle;
        }
        findMatches = hits.map((_, index) => ({ index }));
        normalizeFindIndex();
        updatePreviewFindSelection(hits);
        return;
      }
      findPaintNeedle = needle;
      const hits = refreshPreviewFindContent();
      findMatches = hits.map((_, index) => ({ index }));
      normalizeFindIndex();
      updatePreviewFindSelection(hits);
      syncFindHighlights('');
      return;
    }
    if (noteHasDocs(currentId)) {
      const finishTextFind = () => {
        if (editorMode !== 'ocr') {
          editorMode = 'ocr';
          applyEditorMode();
        }
        highlightFindPreview();
        syncFindHighlights('');
      };
      const useDocPreview = (editorMode === 'preview' && ui.docInline && !ui.docInline.hidden)
        || (!ui.docViewer?.hidden && previewingId);
      if (!useDocPreview) {
        finishTextFind();
        return;
      }
      const applyDomHits = (stage) => {
        if (!stage) {
          finishTextFind();
          return;
        }
        finishDocPreviewFind(stage, needle, findIndex);
      };
      if (navigate && findPaintNeedle === needle) {
        const liveStage = activeDocSearchStage();
        const root = liveStage ? docFindSearchRoot(liveStage) : null;
        if (liveStage && NotesPreview.listSearchHits(root || liveStage).length) {
          syncDocFindCounter(liveStage, findIndex);
          applyDomHits(liveStage);
          return;
        }
      }
      if (findPaintNeedle === needle) {
        const liveStage = activeDocSearchStage();
        const root = liveStage ? docFindSearchRoot(liveStage) : null;
        if (liveStage && NotesPreview.listSearchHits(root || liveStage).length) {
          syncDocFindCounter(liveStage, findIndex);
          applyDomHits(liveStage);
          return;
        }
      }
      if (findPaintPromise) {
        findPaintPromise.then(() => applyDomHits(activeDocSearchStage()));
        return;
      }
      findPaintPromise = ensureFindDocumentPainted(needle)
        .then((stage) => {
          findPaintPromise = null;
          applyDomHits(stage);
        })
        .catch(() => {
          findPaintPromise = null;
          finishTextFind();
        });
      return;
    }
    findMatches = NotesSearch.findMatches(ui.body.value, query, matchOpts);
    if (!findMatches.length) {
      if (counter) counter.textContent = '0/0';
      syncFindHighlights(needle);
      return;
    }
    normalizeFindIndex();
    if (counter) counter.textContent = `${findIndex + 1}/${findMatches.length}`;
    scrollEditFindMatch(findMatches[findIndex]);
  }

  function showFindBar({ deferRunFind = false } = {}) {
    if (!currentId) {
      ui.search.focus();
      return;
    }
    document.getElementById('find-bar').hidden = false;
    syncFindBarChrome(true);
    const input = document.getElementById('find-input');
    const sidebarQ = currentSearchQuery();
    if (sidebarQ && !String(input.value || '').trim()) {
      input.value = sidebarQ;
    }
    const caseBtn = document.getElementById('find-case-toggle');
    if (caseBtn) {
      caseBtn.classList.toggle('active', findCaseSensitive);
      caseBtn.setAttribute('aria-pressed', findCaseSensitive ? 'true' : 'false');
    }
    input.focus();
    input.select();
    findIndex = docSearchHitIndex || 0;
    if (!deferRunFind) runFind();
    layoutFindBarOverDocViewer();
  }

  function wrapSelection(before, after = before, placeholder = 'text') {
    pushUndoSnapshot();
    const ta = ui.body;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end) || placeholder;
    ta.value = `${ta.value.slice(0, start)}${before}${selected}${after}${ta.value.slice(end)}`;
    ta.setSelectionRange(start + before.length, start + before.length + selected.length);
    ta.focus();
    scheduleSave();
  }

  function prefixLine(prefix) {
    pushUndoSnapshot();
    const ta = ui.body;
    const start = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    ta.value = `${ta.value.slice(0, lineStart)}${prefix}${ta.value.slice(lineStart)}`;
    const shift = prefix.length;
    ta.setSelectionRange(start + shift, ta.selectionEnd + shift);
    ta.focus();
    scheduleSave();
  }

  let editorKeyboardInsetCleanup = null;

  function applyEditorKeyboardInset() {
    const pane = document.getElementById('editor-pane');
    if (!pane || ui.editor?.hidden || !globalThis.visualViewport) return;
    const vv = globalThis.visualViewport;
    const gap = Math.max(0, (globalThis.innerHeight || 0) - vv.height - vv.offsetTop);
    pane.style.setProperty('--editor-kb-offset', `${Math.round(gap)}px`);
  }

  function bindEditorKeyboardInset() {
    if (editorKeyboardInsetCleanup || !IS_IOS) return;
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const onViewportChange = () => applyEditorKeyboardInset();
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
    editorKeyboardInsetCleanup = () => {
      vv.removeEventListener('resize', onViewportChange);
      vv.removeEventListener('scroll', onViewportChange);
      editorKeyboardInsetCleanup = null;
      document.getElementById('editor-pane')?.style.removeProperty('--editor-kb-offset');
    };
    applyEditorKeyboardInset();
  }

  function unbindEditorKeyboardInset() {
    if (editorKeyboardInsetCleanup) editorKeyboardInsetCleanup();
  }

  function closeEditor({ fromPopstate = false } = {}) {
    if (!currentId && ui.editor?.hidden) return;
    const closingId = currentId;
    if (ui.title) ui.title.readOnly = false;
    closeNoteOptions();
    flushSave();
    if (closingId) unlockedNotes.delete(closingId);
    hideFindBar();
    hideTagSuggest();
    if (typeof NotesAiChat !== 'undefined') {
      NotesAiChat.close();
      NotesAiChat.onNoteChanged(null);
    }
    NotesStore.flush().catch((err) => toast(err.message || String(err), true));
    docPaintToken += 1;
    if (ui.docInline) {
      ui.docInline.hidden = true;
      ui.docInline.innerHTML = '';
      inlineNoteId = null;
      inlineAttIds = '';
      inlineSearch = '';
    }
    syncEditorDocPreviewLayout();
    shrinkPreviewCacheForBackground();
    unbindEditorKeyboardInset();
    ui.shell.classList.remove('editor-open');
    currentId = null;
    deferredOpenNoteId = null;
    rememberOpen(null);
    ui.editor.hidden = true;
    updateEmptyStateVisibility();
    closeDocPreview();
    renderNotes();
    // Never history.back() here — on iOS that restores bfcache and fires pageshow,
    // which re-runs foreground sync and feels like a full app reload.
    if (!fromPopstate) {
      try {
        if (history.state && history.state.notesView === 'editor') {
          history.replaceState({ notesView: 'list' }, '', location.href);
        }
      } catch (err) {
        /* ignore */
      }
    }
  }

  window.addEventListener('popstate', () => {
    if (currentId || (ui.editor && !ui.editor.hidden)) {
      closeEditor({ fromPopstate: true });
    }
  });

  document.getElementById('btn-new').addEventListener('click', () => createNote());
  document.getElementById('btn-new-list')?.addEventListener('click', () => createNote());
  document.getElementById('btn-list-sort')?.addEventListener('click', () => {
    const idx = NOTE_SORT_ORDER.indexOf(prefs.sort);
    const next = NOTE_SORT_ORDER[(idx < 0 ? 0 : idx + 1) % NOTE_SORT_ORDER.length];
    setNoteSort(next, { toast: true });
  });
  document.getElementById('sort-select')?.addEventListener('change', (e) => {
    setNoteSort(e.target.value);
  });
  document.getElementById('sort-select-sidebar')?.addEventListener('change', (e) => {
    setNoteSort(e.target.value);
  });
  document.getElementById('btn-lock-nav')?.addEventListener('click', () => lockVault('Vault locked.'));
  document.getElementById('btn-account-info-nav')?.addEventListener('click', () => {
    document.getElementById('btn-account-info-head')?.click();
  });
  document.getElementById('fab-add')?.addEventListener('click', () => {
    if (currentAppTab() === '2fa') showTotpAddDialog();
    else createNote();
  });
  document.getElementById('fab-scan')?.addEventListener('click', pickScanFile);
  document.getElementById('btn-list-scan')?.addEventListener('click', pickScanFile);
  document.getElementById('hero-guide-close')?.addEventListener('click', closeHeroGuide);
  document.getElementById('hero-guide-backdrop')?.addEventListener('click', closeHeroGuide);
  document.getElementById('hero-guide-scan')?.addEventListener('click', () => {
    closeHeroGuide();
    pickScanFile();
  });
  document.getElementById('btn-open-admin')?.addEventListener('click', () => {
    window.location.href = '/admin';
  });
  document.getElementById('btn-empty-new').addEventListener('click', () => createNote());
  document.getElementById('btn-empty-dismiss')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissEmptyState();
  });
  document.getElementById('btn-empty-relock')?.addEventListener('click', () => {
    clearSavedUnlockSecrets();
    try {
    if (typeof NotesVaultSecrets !== 'undefined') {
      NotesVaultSecrets.clearSecrets();
    }
      localStorage.removeItem('notes_offline_unlock_verified');
    } catch (err) {
      /* ignore */
    }
    lockVault('Enter the vault password from your phone (may differ from the login password).');
  });
  function pickScanFile() {
    openScanComposer({ createIfNeeded: true });
  }
  document.getElementById('btn-empty-scan').addEventListener('click', pickScanFile);
  document.getElementById('scan-take-photo').addEventListener('click', () => {
    document.getElementById('scan-camera').click();
  });

  async function ingestPickedScanFiles(fileList, { createIfNeeded = true, sourceRemoval = null } = {}) {
    const files = toFileArray(fileList);
    if (!files.length) {
      if (pendingScan && !document.getElementById('scan-dialog')?.hidden) {
        setScanFeedback('No file was selected', { isError: true });
      }
      return;
    }
    if (!pendingScan) pendingScan = { file: null, pages: [], createIfNeeded, sourceRemoval: emptyUploadSource() };
    else if (createIfNeeded) pendingScan.createIfNeeded = true;
    if (sourceRemoval) {
      pendingScan.sourceRemoval = mergeUploadSource(pendingScan.sourceRemoval, sourceRemoval);
    }
    let added = 0;
    for (const file of files) {
      const copy = await snapshotPickedFile(file);
      if (copy && addScanFile(copy)) added += 1;
    }
    if (!added && pendingScan && !document.getElementById('scan-dialog')?.hidden) {
      setScanFeedback('Could not add that file', { isError: true });
    }
  }

  async function ingestDesktopScanFiles(fileList, { createIfNeeded = true, sourceRemoval = null } = {}) {
    try {
      await ingestPickedScanFiles(fileList, { createIfNeeded, sourceRemoval });
    } catch (err) {
      setScanFeedback(err.message || 'Could not add that file', { isError: true });
    }
  }

  document.getElementById('scan-choose-file').addEventListener('click', (event) => {
    if (useNativeFileInput()) return;
    event.preventDefault();
    void (async () => {
      try {
        const picked = await pickDeviceFiles({ multiple: true });
        if (!picked?.files?.length) return;
        if (!pendingScan) pendingScan = { file: null, pages: [], createIfNeeded: true, sourceRemoval: emptyUploadSource() };
        pendingScan.sourceRemoval = mergeUploadSource(pendingScan.sourceRemoval, {
          handles: picked.handles,
          label: sourceLabelFromFiles(picked.files),
          fromDevice: true,
        });
        await ingestDesktopScanFiles(picked.files, { createIfNeeded: pendingScan?.createIfNeeded ?? true });
      } catch (err) {
        setScanFeedback(err.message || 'Could not open file picker', { isError: true });
      }
    })();
  });
  document.getElementById('scan-camera').addEventListener('change', async (event) => {
    try {
      await ingestPickedScanFiles(event.target.files, {
        createIfNeeded: pendingScan?.createIfNeeded ?? true,
        sourceRemoval: {
          fromDevice: true,
          fromCamera: true,
          label: sourceLabelFromFiles(event.target.files),
        },
      });
    } catch (err) {
      setScanFeedback(err.message || 'Could not add photo', { isError: true });
    }
    event.target.value = '';
  });
  document.getElementById('scan-input').addEventListener('change', async (event) => {
    try {
      await ingestPickedScanFiles(event.target.files, {
        createIfNeeded: pendingScan?.createIfNeeded ?? true,
        sourceRemoval: {
          fromDevice: true,
          label: sourceLabelFromFiles(event.target.files),
        },
      });
    } catch (err) {
      setScanFeedback(err.message || 'Could not add file', { isError: true });
    }
    event.target.value = '';
  });
  document.getElementById('doc-close').addEventListener('click', closeDocPreview);
  document.getElementById('doc-immersive-close')?.addEventListener('click', closeDocPreview);
  document.getElementById('doc-immersive-share')?.addEventListener('click', () => {
    if (!previewingId) return;
    shareAttachment(previewingId).catch((err) => toast(err.message || 'Share failed', true));
  });
  document.getElementById('doc-backdrop').addEventListener('click', closeDocPreview);
  bindInlinePreviewGestures();
  bindPreviewExternalLinks();
  bindEditLinkOverlays();
  document.getElementById('btn-undo')?.addEventListener('click', () => undoEdit());
  document.getElementById('btn-redo')?.addEventListener('click', () => redoEdit());
  document.getElementById('tag-bar-toggle')?.addEventListener('click', () => {
    const note = currentId ? NotesStore.get(currentId) : null;
    if (!tagBarExpanded) {
      tagBarExpanded = true;
      tagBarShowAll = true;
      if (note) renderTagBar(note);
      else syncTagBarShell(null);
    } else {
      tagBarExpanded = false;
      syncTagBarShell(note);
    }
  });
  document.getElementById('doc-gallery-prev')?.addEventListener('click', () => {
    jumpDocGallery(-1).catch((err) => toast(err.message || 'Preview failed', true));
  });
  document.getElementById('doc-gallery-next')?.addEventListener('click', () => {
    jumpDocGallery(1).catch((err) => toast(err.message || 'Preview failed', true));
  });
  let docSwipeX = null;
  let docSwipeY = null;
  document.getElementById('doc-stage')?.addEventListener('touchstart', (event) => {
    const stage = ui.docStage;
    if (!docGallery || docGallery.ids.length <= 1 || event.touches.length !== 1) return;
    if (stage?.classList.contains('is-pinching') || stage?.classList.contains('is-zoomed')) return;
    const scale = stage?._docZoom?.getScale?.() || 1;
    if (scale > 1.02) return;
    docSwipeX = event.touches[0].clientX;
    docSwipeY = event.touches[0].clientY;
  }, { passive: true });
  document.getElementById('doc-stage')?.addEventListener('touchend', (event) => {
    const stage = ui.docStage;
    if (docSwipeX == null || docSwipeY == null || !docGallery || docGallery.ids.length <= 1) return;
    const dx = event.changedTouches[0].clientX - docSwipeX;
    const dy = event.changedTouches[0].clientY - docSwipeY;
    docSwipeX = null;
    docSwipeY = null;
    if (stage?.classList.contains('is-pinching') || stage?.classList.contains('is-zoomed')) return;
    const scale = stage?._docZoom?.getScale?.() || 1;
    if (scale > 1.02) return;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
    jumpDocGallery(dx < 0 ? 1 : -1).catch((err) => toast(err.message || 'Preview failed', true));
  }, { passive: true });
  document.addEventListener('click', (event) => {
    if (event.target?.closest?.('[data-doc-hit-nav]')) return;
    const hitNote = event.target?.closest?.('#doc-inline .doc-hit-note');
    if (hitNote && !event.target?.closest?.('[data-doc-hit-nav]')) {
      const stage = ui.docInline?.querySelector('.doc-inline-stage');
      const attId = stage?.dataset?.stage;
      if (attId) {
        event.preventDefault();
        openDocPreviewFromSearch(attId, { hitIndex: docSearchHitIndex })
          .catch((err) => toast(err.message || 'Preview failed', true));
        return;
      }
    }
    const previewOpen = event.target?.closest?.('[data-doc-preview-open]');
    if (!previewOpen?.dataset?.docPreviewOpen) return;
    event.preventDefault();
    openDocPreviewFromSearch(previewOpen.dataset.docPreviewOpen, {
      noteId: currentId,
      hitIndex: docSearchHitIndex,
    }).catch((err) => toast(err.message || 'Preview failed', true));
  });
  function updateDocZoomLabel() {
    const label = document.getElementById('doc-zoom-reset');
    const scale = ui.docStage?._docZoom?.getScale?.() || 1;
    if (label) label.textContent = `${Math.round(scale * 100)}%`;
  }
  document.getElementById('doc-zoom-in').addEventListener('click', () => {
    ui.docStage?._docZoom?.zoomIn?.();
    updateDocZoomLabel();
    maybeUpgradePreviewQuality();
  });
  document.getElementById('doc-zoom-out').addEventListener('click', () => {
    ui.docStage?._docZoom?.zoomOut?.();
    updateDocZoomLabel();
  });
  document.getElementById('doc-zoom-reset').addEventListener('click', () => {
    ui.docStage?._docZoom?.reset?.();
    updateDocZoomLabel();
  });
  document.getElementById('doc-share').addEventListener('click', () => {
    if (!previewingId) return;
    shareAttachment(previewingId).catch((err) => toast(err.message || 'Share failed', true));
  });
  document.getElementById('doc-download').addEventListener('click', () => {
    if (!previewingId) return;
    downloadAttachment(previewingId).catch((err) => toast(err.message || 'Download failed', true));
  });
  document.getElementById('scan-cancel').addEventListener('click', hideScanDialog);
  document.getElementById('scan-backdrop').addEventListener('click', hideScanDialog);
  document.getElementById('scan-confirm').addEventListener('click', confirmScanDialog);
  document.getElementById('scan-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmScanDialog();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      hideScanDialog();
    }
  });
  document.getElementById('scan-name').addEventListener('focus', () => {
    requestAnimationFrame(() => {
      document.getElementById('scan-name')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      applyScanKeyboardInset();
    });
  });
  document.getElementById('tag-suggest-dismiss').addEventListener('click', hideTagSuggest);
  document.getElementById('tag-suggest-apply').addEventListener('click', () => {
    if (!pendingSuggest) return;
    const { existing, tagId, title, noteId } = pendingSuggest;
    if (existing && tagId) {
      const note = NotesStore.get(noteId);
      if (note) {
        const tags = new Set(note.content.tags || []);
        tags.add(tagId);
        NotesStore.upsert(noteId, { ...note.content, tags: [...tags] });
        if (currentId === noteId) renderTagBar(NotesStore.get(noteId));
        renderTags();
        renderNotes();
        toast('Tag applied');
      }
    } else {
      createTag(title, { assignToCurrent: true });
    }
    hideTagSuggest();
  });
  document.getElementById('btn-new-tag').addEventListener('click', () => {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const composer = document.getElementById('tag-composer');
    composer.hidden = false;
    const input = document.getElementById('tag-name-input');
    input.focus();
  });
  const tagSection = document.getElementById('tag-section');
  if (tagSection) {
    tagSection.addEventListener('toggle', () => {
      prefs.tagsCollapsed = !tagSection.open;
      localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
    });
  }
  const filterSection = document.getElementById('filter-section');
  if (filterSection) {
    filterSection.addEventListener('toggle', () => {
      if (!isDesktopLayout()) return;
      prefs.viewsCollapsed = !filterSection.open;
      localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
    });
  }
  window.addEventListener('resize', () => {
    applyTagSection();
    applyFilterSection();
    if (currentId) syncTagBarShell(NotesStore.get(currentId));
    layoutFindBarOverDocViewer();
  });
  document.getElementById('tag-create-confirm').addEventListener('click', () => {
    createTag(document.getElementById('tag-name-input').value);
  });
  document.getElementById('tag-create-cancel').addEventListener('click', hideTagComposer);
  document.getElementById('tag-name-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createTag(event.target.value);
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      hideTagComposer();
    }
  });

  document.getElementById('btn-back').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeEditor();
  });

  function updateSearchClear() {
    const clear = document.getElementById('search-clear');
    if (clear) clear.hidden = !ui.search.value;
  }

  function clearSearch() {
    ui.search.value = '';
    updateSearchClear();
    renderNotes();
    if (currentId) applyEditorMode();
    ui.search.blur();
  }

  function repairSearchIndexesForQuery() {
    if (!ui.search?.value?.trim()) return false;
    if (!countStaleNoteSearchIndexes()) return false;
    refreshAllNoteSearchIndexes();
    return true;
  }

  let searchDebounceTimer = null;
  let searchRepairTimer = null;
  function applySearchFilter() {
    updateSearchClear();
    // Filter the list only — do not rebuild OCR search indexes on every keystroke.
    // That used to mark many notes dirty, kick sync, and feel like a full app reload.
    renderNotes();
    syncEditorModeForSearch();
    if (currentId) applyEditorMode();
    clearTimeout(searchRepairTimer);
    if (!ui.search?.value?.trim()) return;
    searchRepairTimer = setTimeout(() => {
      if (!countStaleNoteSearchIndexes()) return;
      repairSearchIndexesForQuery();
      renderNotes();
      if (currentId) applyEditorMode();
    }, 1200);
  }
  ui.search.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(applySearchFilter, 150);
  });
  // iOS Safari "Search" on type=search otherwise navigates / reloads the page.
  // Search field is type=text; still block Enter just in case.
  ui.search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(searchDebounceTimer);
    applySearchFilter();
    ui.search.blur();
  });
  ui.search.addEventListener('search', (event) => {
    event.preventDefault();
    clearTimeout(searchDebounceTimer);
    applySearchFilter();
  });
  const findInput = document.getElementById('find-input');
  if (findInput) {
    findInput.addEventListener('search', (event) => {
      event.preventDefault();
    });
  }
  const searchClear = document.getElementById('search-clear');
  if (searchClear) searchClear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearSearch();
  });
  updateSearchClear();

  ui.filters.querySelectorAll('.filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      setFilter(btn.dataset.filter);
      renderTags();
      renderNotes();
    });
  });
  const filterSelect = document.getElementById('filter-select');
  if (filterSelect) {
    filterSelect.value = currentFilter;
    filterSelect.addEventListener('change', () => {
      setFilter(filterSelect.value);
      renderTags();
      renderNotes();
    });
  }

  ui.title.addEventListener('beforeinput', () => {
    if (noteEditingLocked()) return;
    pushUndoSnapshot();
  });
  ui.body.addEventListener('beforeinput', (event) => {
    if (noteEditingLocked()) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') return;
    pushUndoSnapshot();
  });
  ui.title.addEventListener('keydown', handleEditorUndoShortcut);
  ui.body.addEventListener('keydown', handleEditorUndoShortcut);
  ui.title.addEventListener('input', () => {
    const note = NotesStore.get(currentId);
    if (note?.content?.prevent_edit) return;
    if (note?.content?.locked && !unlockedNotes.has(currentId)) return;
    scheduleSave();
  });
  ui.body.addEventListener('input', () => {
    const note = NotesStore.get(currentId);
    if (note?.content?.prevent_edit) return;
    if (note?.content?.locked && !unlockedNotes.has(currentId)) return;
    scheduleSave();
    syncEditLinkOverlay();
    syncUndoButtons();
    if (!document.getElementById('find-bar')?.hidden) {
      const query = document.getElementById('find-input')?.value?.trim() || '';
      if (query) syncFindHighlights(query);
    }
  });
  ui.body.addEventListener('scroll', () => {
    syncFindHighlightScroll();
    syncEditLinkScroll();
  });

  document.getElementById('note-body-wrap')?.addEventListener('click', (event) => {
    if (noteEditingLocked()) return;
    if (event.target?.closest?.('a[href]')) return;
    if (ui.body?.hidden) {
      if (!ui.preview?.hidden && !noteHasDocs(currentId)) {
        editorMode = 'edit';
        applyEditorMode();
      }
    }
    if (!ui.body?.hidden && event.target !== ui.body) {
      ui.body.focus();
    }
  });

  document.getElementById('btn-ocr-text').addEventListener('click', () => {
    if (noteHasDocs(currentId)) {
      editorMode = editorMode === 'ocr' ? 'edit' : 'ocr';
    } else {
      editorMode = editorMode === 'ocr' ? 'preview' : 'ocr';
    }
    applyEditorMode();
  });
  document.getElementById('btn-preview').addEventListener('click', () => {
    if (noteEditingLocked()) {
      toast('Editing is locked — tap the lock icon to unlock', true);
      return;
    }
    if (noteHasDocs(currentId)) {
      if (editorMode === 'edit') editorMode = 'preview';
      else if (editorMode === 'ocr') editorMode = 'preview';
      else editorMode = 'edit';
    } else {
      editorMode = editorMode === 'edit' ? 'preview' : 'edit';
    }
    applyEditorMode();
  });

  const btnFind = document.getElementById('btn-find');
  if (btnFind) btnFind.addEventListener('click', () => showFindBar());

  document.getElementById('md-toolbar').addEventListener('click', (event) => {
    const action = event.target.closest('[data-md]')?.dataset.md;
    if (!action || !currentId) return;
    if (noteEditingLocked()) {
      toast('Editing is locked — tap the lock icon to unlock', true);
      return;
    }
    if (editorMode !== 'edit') {
      editorMode = 'edit';
      applyEditorMode();
    }
    if (action === 'bold') wrapSelection('**', '**');
    if (action === 'italic') wrapSelection('*', '*');
    if (action === 'code') wrapSelection('`', '`', 'code');
    if (action === 'link') wrapSelection('[', '](https://)', 'link text');
    if (action === 'sup') wrapSelection('^', '^', 'text');
    if (action === 'heading') prefixLine('## ');
    if (action === 'check') prefixLine('- [ ] ');
  });

  document.getElementById('find-input').addEventListener('input', () => {
    findIndex = 0;
    runFind();
  });
  document.getElementById('find-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      advanceFind(event.shiftKey ? -1 : 1);
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      hideFindBar();
      if (!ui.body.hidden) ui.body.focus();
      else if (!ui.preview.hidden) ui.preview.focus();
    }
  });
  document.getElementById('find-next').addEventListener('click', () => advanceFind(1));
  document.getElementById('find-prev').addEventListener('click', () => advanceFind(-1));
  document.getElementById('find-close').addEventListener('click', hideFindBar);

  document.getElementById('find-case-toggle')?.addEventListener('click', () => {
    findCaseSensitive = !findCaseSensitive;
    const btn = document.getElementById('find-case-toggle');
    if (btn) {
      btn.classList.toggle('active', findCaseSensitive);
      btn.setAttribute('aria-pressed', findCaseSensitive ? 'true' : 'false');
    }
    findIndex = 0;
    runFind();
  });

  document.getElementById('search-filter-toggle')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const panel = document.getElementById('search-filter-panel');
    setSearchFilterPanelOpen(!!panel?.hidden);
  });
  document.getElementById('search-filter-close')?.addEventListener('click', () => {
    readSearchFilterPanel();
    setSearchFilterPanelOpen(false);
    renderNotes();
    if (currentId) applyEditorMode();
  });
  document.getElementById('search-filter-apply')?.addEventListener('click', () => {
    readSearchFilterPanel();
    setSearchFilterPanelOpen(false);
    renderNotes();
    if (currentId) applyEditorMode();
  });
  document.getElementById('search-filter-clear')?.addEventListener('click', clearSearchFilters);
  document.getElementById('search-filter-backdrop')?.addEventListener('click', () => {
    readSearchFilterPanel();
    setSearchFilterPanelOpen(false);
    renderNotes();
    if (currentId) applyEditorMode();
  });
  ['search-titles-only', 'search-include-protected', 'search-include-archived', 'search-include-trashed'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      readSearchFilterPanel();
      renderNotes();
      if (currentId) applyEditorMode();
    });
  });
  document.addEventListener('click', (event) => {
    const panel = document.getElementById('search-filter-panel');
    const toggle = document.getElementById('search-filter-toggle');
    if (!panel || panel.hidden) return;
    if (panel.contains(event.target) || toggle?.contains(event.target)) return;
    if (window.matchMedia && window.matchMedia('(min-width: 901px)').matches) {
      readSearchFilterPanel();
      setSearchFilterPanelOpen(false);
      renderNotes();
      if (currentId) applyEditorMode();
    }
  });
  updateSearchFilterBadge();

  document.addEventListener('click', (event) => {
    const nav = event.target?.closest?.('[data-doc-hit-nav]');
    if (!nav) return;
    event.preventDefault();
    jumpDocSearchHit(nav.dataset.docHitNav === 'prev' ? -1 : 1);
  });
  document.addEventListener('keydown', (event) => {
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const stage = activeDocSearchStage();
    if (!stage || !NotesPreview.listSearchHits(stage).length) return;
    if (event.key === 'F3' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g')) {
      event.preventDefault();
      jumpDocSearchHit(event.shiftKey ? -1 : 1);
    }
  });

  document.getElementById('note-lock-unlock').addEventListener('click', async () => {
    const guess = document.getElementById('note-lock-password').value;
    const ok = await NotesStore.verifyVaultPassword(guess);
    if (!ok) {
      document.getElementById('note-lock-error').hidden = false;
      return;
    }
    if (typeof NotesVaultSecrets !== 'undefined' && guess) {
      NotesVaultSecrets.setVaultPassword(String(guess).trim());
    }
    if (currentId) unlockedNotes.add(currentId);
    openNote(currentId, { skipGate: true });
  });
  document.getElementById('note-lock-password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      document.getElementById('note-lock-unlock').click();
    }
  });

  document.getElementById('btn-pin').addEventListener('click', () => {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    note.content.pinned = !note.content.pinned;
    NotesStore.upsert(currentId, { ...note.content });
    updateActionButtons(NotesStore.get(currentId));
    renderNotes();
    toast(note.content.pinned ? 'Pinned' : 'Unpinned');
  });

  document.getElementById('btn-star').addEventListener('click', () => {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    note.content.starred = !note.content.starred;
    NotesStore.upsert(currentId, { ...note.content });
    updateActionButtons(NotesStore.get(currentId));
    renderNotes();
    toast(note.content.starred ? 'Starred' : 'Unstarred');
  });

  document.getElementById('note-info-protect')?.addEventListener('click', toggleNoteProtection);
  document.getElementById('note-warn-save')?.addEventListener('click', () => {
    saveNoteWarning().catch(() => {});
  });
  document.getElementById('note-warn-clear')?.addEventListener('click', () => {
    saveNoteWarning({ clear: true }).catch(() => {});
  });
  // iOS shows an empty datetime-local as a blank pill; keep our own placeholder in sync.
  {
    const warnInput = document.getElementById('note-warn-at');
    for (const evt of ['input', 'change', 'blur']) {
      warnInput?.addEventListener(evt, () => syncWarnFieldState(warnInput));
    }
    // While the native picker is open the field is being edited: hide the hint.
    warnInput?.addEventListener('focus', () => {
      document.getElementById('note-warn-field')?.classList.remove('is-empty');
    });
  }

  document.getElementById('btn-duplicate').addEventListener('click', async () => {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    const copyId = NotesStore.newUuid();
    const copy = {
      ...NotesStore.defaultNote(),
      ...note.content,
      locked: false,
      prevent_edit: false,
      attachments: [],
      title: `${note.content.title || 'Untitled'} copy`,
      created_at: new Date().toISOString(),
    };
    delete copy.ocr_text;
    NotesStore.upsert(copyId, copy);
    try {
      for (const attId of note.content.attachments || []) {
        const att = NotesStore.get(attId);
        if (!att) continue;
        const bytes = await NotesStore.getAttachmentBytes(attId);
        const name = att.content.filename || 'file';
        const file = new File([bytes], name, {
          type: att.content.mime || 'application/octet-stream',
        });
        const newId = await NotesStore.addAttachment(copyId, file, {
          displayName: att.content.display_name,
        });
        if (att.content.ocr_text || att.content.ocr_method) {
          NotesStore.setAttachmentOcr(
            newId,
            att.content.ocr_text || '',
            att.content.ocr_method || '',
            Array.isArray(att.content.ocr_boxes) ? att.content.ocr_boxes : [],
          );
        }
      }
      NotesStore.refreshNoteSearchText(copyId);
      renderNotes();
      openNote(copyId);
      toast('Note duplicated');
    } catch (err) {
      NotesStore.remove(copyId);
      toast(err.message || 'Could not duplicate note', true);
    }
  });

  function applyEditorTypeChange(nextEditor) {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note || note.content.prevent_edit) {
      const current = note?.content?.editor || 'plain';
      ui.editorType.value = current;
      return;
    }
    const prevEditor = note.content.editor || 'plain';
    if (nextEditor === prevEditor) return;
    if (window.NotesSuperscript) {
      if (nextEditor === 'superscript') {
        const converted = NotesSuperscript.convertTo(ui.body.value, prevEditor);
        ui.body.value = converted;
        note.content.content = converted;
      } else if (prevEditor === 'superscript' && nextEditor === 'plain') {
        const stripped = NotesSuperscript.convertFrom(ui.body.value);
        ui.body.value = stripped;
        note.content.content = stripped;
      }
    }
    note.content.editor = nextEditor;
    NotesStore.upsert(currentId, { ...note.content });
    ui.editorType.value = nextEditor;
    ui.body.classList.toggle('mono', note.content.editor === 'code' || prefs.monospace);
    document.getElementById('note-body-wrap')?.classList.toggle('mono', note.content.editor === 'code' || prefs.monospace);
    applyEditorMode();
  }

  ui.editorType.addEventListener('change', () => {
    applyEditorTypeChange(ui.editorType.value);
  });

  const noteInfoBtn = document.getElementById('btn-note-info');
  if (noteInfoBtn) noteInfoBtn.addEventListener('click', openNoteOptions);
  document.getElementById('note-info-star')?.addEventListener('click', () => {
    document.getElementById('btn-star')?.click();
    if (currentId) updateNoteInfoPanel(NotesStore.get(currentId));
  });
  document.getElementById('note-info-pin')?.addEventListener('click', () => {
    document.getElementById('btn-pin')?.click();
    if (currentId) updateNoteInfoPanel(NotesStore.get(currentId));
  });
  document.getElementById('note-info-share')?.addEventListener('click', () => {
    shareNote(currentId).catch((err) => toast(err.message || 'Share failed', true));
  });
  document.getElementById('note-info-share-bottom')?.addEventListener('click', () => {
    shareNote(currentId).catch((err) => toast(err.message || 'Share failed', true));
  });
  document.getElementById('note-info-archive')?.addEventListener('click', () => {
    document.getElementById('btn-archive')?.click();
    if (currentId) updateNoteInfoPanel(NotesStore.get(currentId));
  });
  document.getElementById('note-info-duplicate')?.addEventListener('click', () => {
    document.getElementById('btn-duplicate')?.click();
  });
  document.getElementById('note-info-trash')?.addEventListener('click', () => {
    const note = currentId ? NotesStore.get(currentId) : null;
    if (note && !note.content?.trashed && isNoteProtected(note)) {
      toast('This note is protected', true);
      return;
    }
    document.getElementById('btn-trash')?.click();
  });
  const preventEditBtn = document.getElementById('btn-prevent-edit');
  if (preventEditBtn) preventEditBtn.addEventListener('click', togglePreventEdit);
  const noteOptionsClose = document.getElementById('note-options-close');
  if (noteOptionsClose) noteOptionsClose.addEventListener('click', closeNoteOptions);
  const noteOptionsBackdrop = document.getElementById('note-options-backdrop');
  if (noteOptionsBackdrop) noteOptionsBackdrop.addEventListener('click', closeNoteOptions);

  document.addEventListener('pointerdown', (event) => {
    if (!ui.search || document.activeElement !== ui.search) return;
    if (event.target.closest('.search-wrap')) return;
    ui.search.blur();
  }, true);

  document.getElementById('btn-share')?.addEventListener('click', () => {
    shareNote(currentId).catch((err) => toast(err.message || 'Share failed', true));
  });
  document.getElementById('btn-archive').addEventListener('click', () => {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    note.content.archived = !note.content.archived;
    NotesStore.upsert(currentId, { ...note.content });
    updateActionButtons(NotesStore.get(currentId));
    renderNotes();
    toast(note.content.archived ? 'Archived' : 'Moved back to All notes');
  });

  function trashNote(id) {
    const note = NotesStore.get(id);
    if (!note || note.content.trashed) return;
    if (isNoteProtected(note)) {
      toast('This note is protected', true);
      return;
    }
    if (id === currentId) flushSave();
    NotesStore.upsert(id, { ...note.content, trashed: true });
    cancelNoteReminder(id);
    if (id === currentId) closeEditor();
    else renderNotes();
    toast('Moved to trash');
  }

  function restoreNote(id) {
    const note = NotesStore.get(id);
    if (!note || !note.content.trashed) return;
    NotesStore.upsert(id, { ...note.content, trashed: false });
    restoreNoteReminder(NotesStore.get(id));
    renderNotes();
    if (id === currentId) updateActionButtons(NotesStore.get(id));
    toast('Restored');
  }

  async function deleteNoteForever(id) {
    const note = NotesStore.get(id);
    if (!note?.content?.trashed) return;
    if (isNoteProtected(note)) {
      toast('This note is protected', true);
      return;
    }
    if (!(await confirmAction('Permanently delete this note?', {
      title: 'Delete forever',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    if (id === currentId) {
      currentId = null;
      ui.shell.classList.remove('editor-open');
      ui.editor.hidden = true;
      updateEmptyStateVisibility();
    }
    if (id === listSelectionId) listSelectionId = null;
    cancelNoteReminder(id);
    NotesStore.remove(id);
    if (sessionStorage.getItem('notes_open_id') === id) rememberOpen(null);
    renderNotes();
    renderTags();
    toast('Deleted');
  }

  function deleteFromList(id) {
    const note = NotesStore.get(id);
    if (!note) return;
    if (isNoteProtected(note)) {
      toast('This note is protected', true);
      return;
    }
    if (note.content.trashed) deleteNoteForever(id);
    else trashNote(id);
  }

  function bindNoteList() {
    const list = ui.noteList;
    const width = () => (window.NotesSwipe && NotesSwipe.ACTION_WIDTH) || 88;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let base = 0;
    let row = null;
    let axis = null;
    let dragging = false;
    let opened = null;
    let suppressClick = false;

    function itemOf(el) {
      return el ? el.querySelector('.note-item') : null;
    }

    function closeOpened() {
      if (!opened) return;
      opened.classList.remove('open', 'swiping');
      const item = itemOf(opened);
      if (item) item.style.transform = '';
      opened = null;
    }

    list.addEventListener('pointerdown', (event) => {
      if (event.button && event.button !== 0) return;
      if (event.target.closest('.note-swipe-delete, .note-row-delete')) return;
      if (opened && !opened.isConnected) opened = null;
      const next = event.target.closest('.note-row');
      if (!next) return;
      if (opened && opened !== next) closeOpened();
      row = next;
      startX = lastX = event.clientX;
      startY = event.clientY;
      base = row.classList.contains('open') ? -width() : 0;
      axis = null;
      dragging = true;
      suppressClick = false;
      row.classList.add('swiping');
    });

    list.addEventListener('pointermove', (event) => {
      if (!dragging || !row) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!axis) {
        axis = NotesSwipe.axisLock(dx, dy);
        if (axis === 'h') {
          try { row.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
          row.style.touchAction = 'none';
        }
      }
      if (axis !== 'h') return;
      event.preventDefault();
      lastX = event.clientX;
      const offset = NotesSwipe.clampOffset(base + dx, width());
      const item = itemOf(row);
      if (item) item.style.transform = `translateX(${offset}px)`;
      if (Math.abs(dx) > 8) suppressClick = true;
    }, { passive: false });

    function finish() {
      if (!dragging) return;
      const current = row;
      const dx = lastX - startX;
      const offset = NotesSwipe.clampOffset(base + dx, width());
      const decision = axis === 'h' ? NotesSwipe.decide(offset) : (base < 0 ? 'open' : 'close');
      dragging = false;
      if (current) {
        current.classList.remove('swiping');
        current.style.touchAction = '';
        const item = itemOf(current);
        if (item) item.style.transform = '';
        if (decision === 'commit') {
          current.classList.remove('open');
          opened = null;
          deleteFromList(current.dataset.id);
        } else if (decision === 'open') {
          current.classList.add('open');
          opened = current;
        } else {
          current.classList.remove('open');
          if (opened === current) opened = null;
        }
      }
      row = null;
      axis = null;
    }

    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
    list.addEventListener('click', (event) => {
      const del = event.target.closest('.note-swipe-delete, .note-row-delete');
      if (del) {
        event.preventDefault();
        deleteFromList(del.dataset.id);
        return;
      }
      const next = event.target.closest('.note-row');
      if (!next) return;
      if (suppressClick) {
        event.preventDefault();
        suppressClick = false;
        return;
      }
      if (next.classList.contains('open')) {
        event.preventDefault();
        closeOpened();
        return;
      }
      if (next.dataset.id) openNote(next.dataset.id);
    });
  }

  bindNoteList();

  document.getElementById('btn-trash').addEventListener('click', () => {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content.trashed) {
      restoreNote(currentId);
    } else {
      if (isNoteProtected(note)) {
        toast('This note is protected', true);
        return;
      }
      trashNote(currentId);
    }
  });

  document.getElementById('btn-delete-forever').addEventListener('click', () => {
    if (!currentId) return;
    const note = NotesStore.get(currentId);
    if (note && isNoteProtected(note)) {
      toast('This note is protected', true);
      return;
    }
    deleteNoteForever(currentId);
  });

  document.getElementById('btn-clear-checked')?.addEventListener('click', () => {
    if (!currentId || !window.NotesChecklist) return;
    const note = NotesStore.get(currentId);
    if (!note || note.content?.prevent_edit) return;
    const type = note.content?.editor || ui.editorType?.value || 'plain';
    if (!isChecklistEditor(type)) return;
    const nested = type === 'super';
    const rows = NotesChecklist.parse(note.content?.content || ui.body?.value || '', { nested });
    if (!rows.some((row) => row.done)) return;
    pushUndoSnapshot();
    writeChecklist(NotesChecklist.removeDone(rows), nested);
  });

  async function ingestAttachmentFiles(files, { sourceRemoval = null } = {}) {
    const list = toFileArray(files);
    if (!list.length) return;
    if (!currentId) {
      toast('Open a note first', true);
      return;
    }
    if (list.length === 1) {
      const copy = await snapshotPickedFile(list[0]);
      if (!copy) return;
      const note = NotesStore.get(currentId);
      const title = String(note?.content?.title || '').trim() || fileStem(copy.name) || 'Document';
      try {
        await ingestDocument(copy, {
          createIfNeeded: false,
          title,
          displayName: copy.name,
          sourceRemoval,
        });
      } catch (err) {
        if (isDuplicateUploadError(err.message)) {
          await showDuplicateDialog(null, copy, currentId, err.message);
        } else {
          toast(err.message || 'Could not attach file', true);
        }
      }
      return;
    }
    pendingScan = {
      file: null,
      pages: [],
      createIfNeeded: false,
      sourceRemoval: mergeUploadSource(emptyUploadSource(), sourceRemoval),
    };
    for (const file of list) {
      const copy = await snapshotPickedFile(file);
      if (copy) addScanFile(copy);
    }
  }

  document.getElementById('attachment-add-label')?.addEventListener('click', (event) => {
    if (useNativeFileInput()) return;
    event.preventDefault();
    void (async () => {
      try {
        const picked = await pickDeviceFiles({ multiple: true });
        if (picked === null) {
          ui.attachmentInput?.click();
          return;
        }
        if (!picked.files.length) return;
        await ingestAttachmentFiles(picked.files, {
          sourceRemoval: {
            handles: picked.handles,
            label: sourceLabelFromFiles(picked.files),
            fromDevice: true,
          },
        });
      } catch (err) {
        toast(err.message || 'Could not attach file', true);
      }
    })();
  });

  ui.attachmentInput.addEventListener('change', async (e) => {
    const files = toFileArray(e.target.files);
    e.target.value = '';
    try {
      await ingestAttachmentFiles(files, {
        sourceRemoval: files.length
          ? { fromDevice: true, label: sourceLabelFromFiles(files) }
          : null,
      });
    } catch (err) {
      toast(err.message || 'Could not attach file', true);
    }
  });

  const SETTINGS_FLUSH_TIMEOUT_MS = 4000;

  async function flushForSettings() {
    try {
      await Promise.race([
        NotesStore.flush(),
        new Promise((resolve) => setTimeout(resolve, SETTINGS_FLUSH_TIMEOUT_MS)),
      ]);
    } catch (_) {
      /* settings must open even when sync/save is stuck */
    }
  }

  async function showSettings() {
    openSettings();
    flushForSettings()
      .then(() => initSettings())
      .catch(() => initSettings().catch(() => {}));
  }
  window.notesShowSettings = () => {
    showSettings().catch(() => openSettings());
  };
  function bindSettingsOpen(el) {
    if (!el) return;
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showSettings().catch(() => openSettings());
    });
  }
  bindSettingsOpen(document.getElementById('btn-settings-head'));
  bindSettingsOpen(document.getElementById('btn-settings-nav'));
  bindSettingsOpen(document.getElementById('btn-editor-settings'));
  document.getElementById('settings-close').addEventListener('click', (event) => {
    event.stopPropagation();
    closeSettings(true);
  });
  ui.settingsBackdrop.addEventListener('click', (event) => {
    event.stopPropagation();
    closeSettings();
  });
  document.querySelectorAll('[data-theme-opt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      prefs.theme = btn.dataset.themeOpt;
      document.querySelectorAll('[data-theme-opt]').forEach((other) => {
        other.classList.toggle('active', other === btn);
      });
      savePrefs();
    });
  });
  const syncBtn = document.getElementById('sync-indicator');
  if (syncBtn) {
    syncBtn.addEventListener('click', (event) => {
      requestManualSync(event);
    });
  }
  document.getElementById('btn-sync-now')?.addEventListener('click', (event) => {
    requestManualSync(event);
  });
  document.getElementById('btn-account-info-head')?.addEventListener('click', () => {
    showAccountInfo().catch(() => {});
  });
  document.getElementById('account-info-close')?.addEventListener('click', closeAccountInfoDialog);
  document.getElementById('account-info-backdrop')?.addEventListener('click', closeAccountInfoDialog);
  document.addEventListener('keydown', (event) => {
    const dialog = document.getElementById('account-info-dialog');
    if (dialog?.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAccountInfoDialog();
    }
  });
  document.getElementById('btn-empty-sync')?.addEventListener('click', () => {
    if (!NotesStore.isUnlocked()) {
      syncNow({ full: true }).catch((err) => {
        toast(err?.message || 'Could not check synchronization status', true);
      });
      return;
    }
    const emptySyncBtn = document.getElementById('btn-empty-sync');
    if (emptySyncBtn) {
      emptySyncBtn.disabled = true;
      emptySyncBtn.textContent = 'Syncing…';
    }
    toast('Downloading all notes…');
    syncNow({ full: true }).catch((err) => {
      toast(err?.message || 'Sync failed', true);
    });
  });
  document.getElementById('pref-compact').addEventListener('change', (e) => {
    prefs.compactList = e.target.checked;
    savePrefs();
  });
  document.getElementById('pref-hide-previews').addEventListener('change', (e) => {
    prefs.hidePreviews = e.target.checked;
    savePrefs();
  });
  document.getElementById('pref-light-vault')?.addEventListener('change', (e) => {
    prefs.lightVault = !!e.target.checked;
    NotesStore.setLightVault?.(prefs.lightVault);
    savePrefs();
    refreshLocalFilesSummary().catch(() => {});
    toast(prefs.lightVault
      ? 'Files now download only when you open their note'
      : 'All files will download on the next sync');
    if (!prefs.lightVault) syncNow({ quiet: true, full: true }).catch(() => {});
  });
  function initAiChatSettings() {
    const keyEl = document.getElementById('ai-chat-key');
    if (!keyEl) return;
    const cfg = typeof NotesAiChat !== 'undefined' ? NotesAiChat.normalizeSettings(prefs.aiChat) : null;
    if (!cfg) return;
    keyEl.value = cfg.apiKey;
    const hostEl = document.getElementById('ai-chat-host');
    if (hostEl) hostEl.value = NotesAiChat.isCloudHost(cfg.host) && !prefs.aiChat?.host ? '' : cfg.host;
    const storedModel = String(prefs.aiChat?.model || '');
    document.getElementById('ai-chat-model').value = storedModel.includes('/') ? '' : storedModel;
    document.getElementById('ai-chat-include-ocr').checked = cfg.includeOcr;
    const status = document.getElementById('ai-chat-status');
    if (status) {
      status.hidden = !cfg.apiKey;
      status.classList.remove('error');
      status.textContent = cfg.apiKey ? `Key saved in your encrypted vault · model ${cfg.model}` : '';
    }
    document.getElementById('ai-chat-remove').hidden = !cfg.apiKey;
  }

  function openAiChat() {
    if (typeof NotesAiChat === 'undefined') return;
    if (!currentId) {
      toast('Open a note first', true);
      return;
    }
    const note = NotesStore.get(currentId);
    if (note?.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    closeNoteOptions();
    NotesAiChat.onNoteChanged(currentId);
    NotesAiChat.open();
  }

  if (typeof NotesAiChat !== 'undefined') {
    NotesAiChat.init({
      getNote: (id) => (id ? NotesStore.get(id) : null),
      getAttachments: (id) => (id ? NotesStore.listAttachments(id) : []),
      getSettings: () => prefs.aiChat,
      getCsrf: () => resolveDeviceReportCsrf(),
      openSettings: () => {
        openSettings();
        initSettings().catch(() => {});
      },
      toast,
    });
  }
  document.getElementById('btn-ai-chat')?.addEventListener('click', openAiChat);
  document.getElementById('ai-chat-save')?.addEventListener('click', () => {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const apiKey = String(document.getElementById('ai-chat-key').value || '').trim();
    if (/^sk-or-/.test(apiKey)) {
      toast('That is an OpenRouter key. Chat now uses Ollama; create a key at ollama.com/settings/keys', true);
      return;
    }
    const host = String(document.getElementById('ai-chat-host')?.value || '').trim();
    if (host && !/^https?:\/\//i.test(host) && !/^[\w.-]+(:\d+)?(\/.*)?$/.test(host)) {
      toast('Enter the Ollama server as a URL, e.g. https://ollama.example.com', true);
      return;
    }
    prefs.aiChat = {
      host,
      apiKey,
      model: String(document.getElementById('ai-chat-model').value || '').trim(),
      includeOcr: document.getElementById('ai-chat-include-ocr').checked,
    };
    savePrefs();
    initAiChatSettings();
    if (typeof NotesAiChat !== 'undefined' && NotesAiChat.isOpen()) NotesAiChat.refresh();
    toast(apiKey ? 'AI chat settings saved to your encrypted vault' : 'AI chat settings saved');
    if (typeof NotesAiChat !== 'undefined' && NotesAiChat.isConfigured(prefs.aiChat)) testAiChatKey();
  });
  function draftAiChatSettings() {
    return {
      host: String(document.getElementById('ai-chat-host')?.value || '').trim(),
      apiKey: String(document.getElementById('ai-chat-key')?.value || '').trim(),
      model: String(document.getElementById('ai-chat-model')?.value || '').trim(),
    };
  }
  async function testAiChatKey() {
    const status = document.getElementById('ai-chat-status');
    if (!status || typeof NotesAiChat === 'undefined') return;
    const draft = draftAiChatSettings();
    status.hidden = false;
    status.classList.remove('error');
    if (!NotesAiChat.isConfigured(draft)) {
      status.textContent = 'Enter an Ollama API key first.';
      status.classList.add('error');
      return;
    }
    status.textContent = NotesAiChat.isCloudHost(draft.host) ? 'Checking key with Ollama Cloud…' : 'Checking the Ollama server…';
    try {
      const csrf = NotesAiChat.isCloudHost(draft.host) ? await resolveDeviceReportCsrf() : '';
      const info = await NotesAiChat.checkKey(draft, { csrf });
      status.textContent = NotesAiChat.describeKeyCheck(info);
      if (info.modelAvailable === false) status.classList.add('error');
    } catch (err) {
      status.textContent = err?.message || 'Key check failed';
      status.classList.add('error');
    }
  }
  document.getElementById('ai-chat-test')?.addEventListener('click', () => testAiChatKey());
  document.getElementById('ai-chat-remove')?.addEventListener('click', () => {
    prefs.aiChat = { ...(prefs.aiChat || {}), apiKey: '' };
    savePrefs();
    initAiChatSettings();
    if (typeof NotesAiChat !== 'undefined') NotesAiChat.reset();
    toast('Ollama key removed from your vault');
  });
  document.getElementById('btn-purge-local-files')?.addEventListener('click', async () => {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const ok = await confirmAction(
      'Remove downloaded files from this device? Notes, scanned text and thumbnails stay. Files download again when you open their note (needs a connection).',
      { confirmLabel: 'Remove files', danger: true },
    );
    if (!ok) return;
    try {
      await NotesStore.flush();
      const removed = await NotesStore.purgeLocalAttachmentBytes({ keepNoteIds: currentId ? [currentId] : [] });
      clearPreviewCache();
      clearListThumbCache();
      lastNotesRenderKey = '';
      renderNotes();
      toast(removed ? `Removed ${removed} file${removed === 1 ? '' : 's'} from this device` : 'No downloaded files to remove');
    } catch (err) {
      toast(err?.message || 'Could not remove files', true);
    }
    refreshLocalFilesSummary().catch(() => {});
  });
  document.getElementById('pref-font-size').addEventListener('input', (e) => {
    prefs.fontSize = Number(e.target.value);
    savePrefs();
  });
  document.getElementById('pref-mono').addEventListener('change', (e) => {
    prefs.monospace = e.target.checked;
    savePrefs();
  });
  document.getElementById('pref-spellcheck').addEventListener('change', (e) => {
    prefs.spellcheck = e.target.checked;
    savePrefs();
  });
  document.getElementById('pref-auto-preview').addEventListener('change', (e) => {
    prefs.autoPreview = e.target.checked;
    savePrefs();
    if (currentId) applyEditorMode();
  });
  document.getElementById('pref-auto-lock').addEventListener('change', (e) => {
    prefs.autoLockMin = Number(e.target.value) || 0;
    savePrefs();
  });
  document.getElementById('pref-lock-on-unfocus')?.addEventListener('change', (e) => {
    const next = String(e.target.value || 'never');
    prefs.lockOnUnfocus = (next === 'immediate' || next === '1min') ? next : 'never';
    savePrefs();
  });
  const rememberDevicePref = document.getElementById('pref-remember-device');
  if (rememberDevicePref) {
    rememberDevicePref.addEventListener('change', (e) => {
      prefs.rememberDevice = !!e.target.checked;
      if (!prefs.rememberDevice) {
        persistDevicePassword('');
        savePrefs();
        refreshSettingsDiagnostics().catch(() => {});
        updateOfflineSetupBanner();
        try {
          localStorage.setItem('notes_remember_device_declined', '1');
        } catch (err) {
          /* ignore quota */
        }
        toast('Device password cleared');
        return;
      }
      enableRememberDevice();
    });
  }
  document.getElementById('btn-show-vault-password')?.addEventListener('click', async () => {
    const saved = savedVaultPasswordForReveal();
    if (!saved) {
      toast('No saved vault password on this device', true);
      updateVaultPasswordReveal();
      return;
    }
    const ok = await confirmAction(
      'Anyone with access to this phone can read it. Show the vault password saved on this device?',
      { title: 'Show saved password', confirmLabel: 'Show password' },
    );
    if (!ok) return;
    const reveal = document.getElementById('vault-password-reveal');
    if (reveal) {
      reveal.textContent = `Saved vault password: ${saved}`;
      reveal.hidden = false;
    }
    try {
      await navigator.clipboard.writeText(saved);
      toast('Password shown below and copied');
    } catch (err) {
      toast('Password shown below');
    }
  });
  const noteInfoCopy = document.getElementById('note-info-copy');
  if (noteInfoCopy) {
    noteInfoCopy.addEventListener('click', async () => {
      const note = NotesStore.get(currentId);
      if (!note) return;
      try {
        await navigator.clipboard.writeText(note.uuid);
        toast('Note ID copied');
      } catch (err) {
        toast('Could not copy ID', true);
      }
    });
  }
  document.getElementById('btn-lock-now').addEventListener('click', () => {
    closeSettings(true);
    lockVault('Vault locked.');
  });
  document.getElementById('btn-lock-head')?.addEventListener('click', () => {
    lockVault('Vault locked.');
  });
  document.querySelectorAll('.app-tab').forEach((btn) => {
    btn.addEventListener('click', () => setAppTab(btn.dataset.appTab));
  });
  totpUi.search?.addEventListener('input', () => {
    if (currentAppTab() === '2fa') renderTotpList();
  });
  totpUi.list?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-totp-id]');
    if (!row) return;
    if (event.target.closest('[data-totp-remove]')) {
      removeTotpEntry(row.dataset.totpId);
      return;
    }
    copyTotpEntry(row.dataset.totpId);
  });
  totpUi.add?.addEventListener('click', () => showTotpAddDialog());
  totpUi.backdrop?.addEventListener('click', () => hideTotpAddDialog());
  document.getElementById('totp-add-cancel')?.addEventListener('click', () => hideTotpAddDialog());
  document.getElementById('totp-add-save')?.addEventListener('click', () => {
    saveTotpAddDialog().catch((err) => toast(err.message || 'Could not add account', true));
  });
  document.getElementById('btn-totp-scan-qr')?.addEventListener('click', () => {
    startTotpQrScan().catch((err) => setTotpAddError(err.message || 'Camera unavailable'));
  });
  document.getElementById('btn-totp-pick-qr')?.addEventListener('click', () => totpUi.qrInput?.click());
  totpUi.qrInput?.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    importTotpQrFile(file).catch((err) => setTotpAddError(err.message || 'Could not read that photo.'));
  });
  totpUi.secret?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveTotpAddDialog().catch((err) => toast(err.message || 'Could not add account', true));
    }
  });
  document.getElementById('btn-totp-lock')?.addEventListener('click', () => {
    lockVault('Vault locked.');
  });
  document.getElementById('btn-totp-settings')?.addEventListener('click', (event) => {
    if (typeof window.__notesOpenSettings === 'function') window.__notesOpenSettings(event);
  });
  document.getElementById('btn-reindex-docs')?.addEventListener('click', () => {
    closeSettings(true);
    reindexAllDocuments().catch((err) => toast(err.message || 'Reindex failed', true));
  });
  document.getElementById('btn-refresh-app')?.addEventListener('click', () => {
    const VL = window.NotesVaultLock;
    if (VL && !VL.mayStartAppUpdate({ locked: VL.vaultIsLocked(document.body) })) return;
    forceRefreshApp().catch((err) => {
      if (typeof window.__notesShowUpdateProgress === 'function') {
        window.__notesShowUpdateProgress(false);
      }
      toast(err.message || 'Refresh failed', true);
    });
  });
  document.getElementById('btn-reload-notes')?.addEventListener('click', async () => {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    try {
      closeSettings(true);
      toast('Downloading notes…');
      try {
        await NotesStore.clearUnreadableLocal();
      } catch (err) {
        await NotesStore.rememberLastSync(0);
      }
      await NotesStore.sync({ full: true });
      renderTags();
      renderNotes();
      renderVaultStats();
      updateEmptyStateVisibility();
      const count = NotesStore.listNotes().filter((n) => !n.content.trashed).length;
      toast(count ? `Loaded ${count} note${count === 1 ? '' : 's'}` : 'Server returned no notes for this password');
    } catch (err) {
      if (err?.code === 'DECRYPT_FAILED' || err?.code === 'DECRYPT_PARTIAL') handleVaultDecryptFailure(err, { relock: false });
      else toast(err.message || 'Reload failed', true);
    }
  });
  document.getElementById('btn-copy-diagnostics')?.addEventListener('click', () => {
    copyDiagnostics().catch((err) => toast(err.message || 'Copy failed', true));
  });
  document.getElementById('btn-send-checklist')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.notesSendChecklist(event);
  });
  const offlineSetupBtn = document.getElementById('btn-offline-setup');
  if (offlineSetupBtn) {
    offlineSetupBtn.addEventListener('click', () => openOfflineSecuritySettings());
  }
  const offlineSetupDismiss = document.getElementById('btn-offline-setup-dismiss');
  if (offlineSetupDismiss) {
    offlineSetupDismiss.addEventListener('click', () => {
      try {
        localStorage.setItem('notes_offline_setup_dismissed', '1');
      } catch (err) {
        /* ignore quota */
      }
      updateOfflineSetupBanner();
    });
  }
  const appUpdateBtn = document.getElementById('btn-app-update');
  if (appUpdateBtn) {
    // Capture-phase shell handler owns Update taps (avoids double hard refresh).
    appUpdateBtn.dataset.bound = '1';
  }
  const sidebarUpdateBtn = document.getElementById('btn-sidebar-update');
  if (sidebarUpdateBtn) {
    sidebarUpdateBtn.dataset.bound = '1';
  }
  const appUpdateDismiss = document.getElementById('btn-app-update-dismiss');
  if (appUpdateDismiss && !appUpdateDismiss.dataset.bound) {
    appUpdateDismiss.dataset.bound = '1';
    appUpdateDismiss.addEventListener('click', async (e) => {
      try { e.stopPropagation(); } catch (err) { /* ignore */ }
      let serverBuild = '';
      try {
        const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        serverBuild = String(data.build || '');
      } catch (err) {
        /* ignore */
      }
      if (serverBuild) {
        try {
          sessionStorage.setItem('notes_update_dismissed_build', serverBuild);
        } catch (err) {
          /* ignore quota */
        }
      }
      updateAppUpdateBanner(serverBuild);
    });
  }
  document.getElementById('btn-empty-trash')?.addEventListener('click', () => {
    emptyTrash().catch(() => {});
  });
  document.getElementById('btn-empty-trash-list')?.addEventListener('click', () => {
    emptyTrash().catch(() => {});
  });
  document.getElementById('btn-export-note').addEventListener('click', () => {
    if (!currentId) {
      toast('Open a note first', true);
      return;
    }
    const note = NotesStore.get(currentId);
    const blob = new Blob([`# ${note.content.title || 'Untitled'}\n\n${note.content.content || ''}`], {
      type: 'text/markdown',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(note.content.title || 'note').replace(/[^\w-]+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Note exported');
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    requestSignOut().catch((err) => toast(err.message || 'Could not sign out', true));
  });

  document.getElementById('btn-setup-totp').addEventListener('click', async () => {
    try {
      const data = await NotesStore.api('/api/totp/setup', { method: 'POST', body: '{}' });
      document.getElementById('totp-qr').src = data.qr;
      document.getElementById('totp-setup').hidden = false;
    } catch (err) {
      toast(err.message || 'Could not start 2FA setup', true);
    }
  });

  document.getElementById('btn-enable-totp').addEventListener('click', async () => {
    const code = document.getElementById('totp-enable-code').value;
    try {
      await NotesStore.api('/api/totp/enable', { method: 'POST', body: JSON.stringify({ code }) });
      await initSettings();
      document.getElementById('totp-setup').hidden = true;
      toast('2FA enabled');
    } catch (err) {
      toast(err.message || 'Could not enable 2FA', true);
    }
  });

  document.getElementById('btn-disable-totp').addEventListener('click', () => {
    const box = document.getElementById('totp-disable');
    box.hidden = !box.hidden;
  });
  document.getElementById('btn-add-passkey')?.addEventListener('click', async () => {
    const passkeyWrap = document.getElementById('passkey-settings');
    const passkeyUrl = passkeyWrap?.dataset.passkeyUrl || 'https://www.deeperguard.com/';
    const mode = document.getElementById('btn-add-passkey')?.dataset.passkeyMode;
    if (mode === 'open') {
      location.href = passkeyUrl;
      return;
    }
    try {
      await NotesPasskeys.registerPasskey(passkeyUrl);
      toast('Passkey added');
      await initSettings();
    } catch (err) {
      toast(err.message || 'Could not add passkey', true);
    }
  });
  document.getElementById('btn-confirm-disable-totp').addEventListener('click', async () => {
    const password = document.getElementById('totp-disable-password').value;
    const code = document.getElementById('totp-disable-code').value;
    const body = { code };
    if (password) body.password = password;
    try {
      await NotesStore.api('/api/totp/disable', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      document.getElementById('totp-disable').hidden = true;
      await initSettings();
      toast('2FA disabled');
    } catch (err) {
      toast(err.message || 'Could not disable 2FA', true);
    }
  });

  let passwordChangeResetTimer = null;

  function setPasswordChangeButtonState(state) {
    const btn = document.getElementById('btn-change-password');
    if (!btn) return;
    clearTimeout(passwordChangeResetTimer);
    btn.classList.remove('primary', 'danger', 'success');
    if (state === 'working') {
      btn.disabled = true;
      btn.textContent = 'Re-encrypting…';
      btn.classList.add('primary', 'danger');
      return;
    }
    if (state === 'done') {
      btn.disabled = true;
      btn.textContent = 'Re-encrypting done';
      btn.classList.add('primary', 'success');
      passwordChangeResetTimer = setTimeout(() => setPasswordChangeButtonState('idle'), 4000);
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Change vault password';
    btn.classList.add('primary');
  }

  function bindPasswordToggles(root) {
    const scope = root || document.getElementById('password-change');
    if (!scope) return;
    scope.querySelectorAll('.password-toggle').forEach((toggle) => {
      if (toggle.dataset.bound === '1') return;
      toggle.dataset.bound = '1';
      toggle.addEventListener('click', () => {
        const input = document.getElementById(toggle.dataset.target || '');
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.textContent = show ? 'Hide' : 'Show';
        toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    });
  }

  document.getElementById('btn-change-password').addEventListener('click', async () => {
    const errEl = document.getElementById('password-change-error');
    const currentEl = document.getElementById('password-change-current');
    const newEl = document.getElementById('password-change-new');
    const confirmEl = document.getElementById('password-change-confirm');
    const btn = document.getElementById('btn-change-password');
    const current = currentEl?.value || '';
    const next = newEl?.value || '';
    const confirm = confirmEl?.value || '';
    errEl.hidden = true;
    if (!next || next !== confirm) {
      errEl.textContent = 'New passwords do not match.';
      errEl.hidden = false;
      return;
    }
    btn.disabled = true;
    setPasswordChangeButtonState('working');
    try {
      const result = await NotesStore.changePassword(current, next);
      persistDevicePassword(next);
      if (skipLogin) {
        try {
          localStorage.setItem('notes_test_password', next);
        } catch (e) {
          /* ignore quota */
        }
      }
      if (prefs.rememberDevice) enableRememberDevice({ auto: true });
      if (currentEl) currentEl.value = '';
      if (newEl) newEl.value = '';
      if (confirmEl) confirmEl.value = '';
      vaultSyncError = '';
      refreshAllNoteSearchIndexes();
      renderTags();
      renderNotes();
      updateVaultPasswordReveal();
      updateVaultPasswordReveal();
      setPasswordChangeButtonState('done');
      toast(`Password updated — ${result.reencrypted} item${result.reencrypted === 1 ? '' : 's'} re-encrypted`);
    } catch (err) {
      errEl.textContent = err.status === 401
        ? 'Current password is wrong.'
        : (err.message || 'Could not change password.');
      errEl.hidden = false;
      setPasswordChangeButtonState('idle');
    }
  });

  bindPasswordToggles();

  document.getElementById('btn-repair-attachments')?.addEventListener('click', async () => {
    const errEl = document.getElementById('attachment-repair-error');
    const pwEl = document.getElementById('attachment-repair-password');
    const btn = document.getElementById('btn-repair-attachments');
    const previous = pwEl?.value || '';
    if (errEl) errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Repairing…';
    try {
      const result = await NotesStore.repairAttachmentsWithPreviousPassword(previous);
      clearPreviewCache();
      if (currentId) {
        invalidateInlinePreview();
        renderDocInline(currentId);
        renderAttachments(currentId);
      }
      if (pwEl) pwEl.value = '';
      toast(result.repaired
        ? `Repaired ${result.repaired} document${result.repaired === 1 ? '' : 's'}${result.failed ? ` (${result.failed} failed)` : ''}`
        : (result.failed ? 'No documents could be repaired' : 'All documents already decrypt correctly'));
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'Repair failed';
        errEl.hidden = false;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Repair documents';
    }
  });

  document.getElementById('btn-save-backup').addEventListener('click', async () => {
    const email = document.getElementById('backup-email').value;
    const enabled = document.getElementById('backup-enabled').checked;
    try {
      await NotesStore.api('/api/backup/settings', {
        method: 'POST',
        body: JSON.stringify({ email, enabled }),
      });
      toast('Backup settings saved');
    } catch (err) {
      toast(err.message || 'Could not save backup settings', true);
    }
  });

  document.getElementById('btn-backup-now').addEventListener('click', async () => {
    try {
      await NotesStore.flush();
      const email = document.getElementById('backup-email').value;
      await NotesStore.api('/api/backup/email', { method: 'POST', body: JSON.stringify({ email }) });
      toast('Encrypted backup emailed');
    } catch (err) {
      toast(err.message || 'Email backup failed', true);
    }
  });

  document.getElementById('btn-save-pcloud').addEventListener('click', async () => {
    const username = document.getElementById('pcloud-username').value.trim();
    const password = document.getElementById('pcloud-password').value;
    const rclone_token = document.getElementById('pcloud-rclone-token').value.trim();
    const remote_path = document.getElementById('pcloud-remote-path').value.trim() || 'Deeperguard/backups';
    const region = document.getElementById('pcloud-region').value || 'eu';
    const enabled = document.getElementById('pcloud-enabled').checked;
    const body = { username, remote_path, region, enabled };
    if (password) body.password = password;
    if (rclone_token) body.rclone_token = rclone_token;
    try {
      await NotesStore.api('/api/backup/pcloud/settings', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      document.getElementById('pcloud-password').value = '';
      document.getElementById('pcloud-rclone-token').value = '';
      toast('pCloud settings saved');
      showSettings().catch(() => {});
    } catch (err) {
      toast(err.message || 'Could not save pCloud settings', true);
    }
  });

  document.getElementById('btn-pcloud-sync').addEventListener('click', async () => {
    const btn = document.getElementById('btn-pcloud-sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      await NotesStore.flush();
      const meta = await NotesStore.api('/api/backup/pcloud/sync', {
        method: 'POST',
        body: '{}',
        timeoutMs: 600000,
      });
      toast(`Synced ${meta.item_count || 0} items to pCloud`);
      showSettings().catch(() => {});
    } catch (err) {
      toast(err.message || 'pCloud sync failed', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sync to pCloud now';
    }
  });

  document.getElementById('btn-download-backup').addEventListener('click', async () => {
    try {
      await NotesStore.flush();
      const backup = await buildLocalBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'deeperguard-backup.enc.json';
      a.click();
      URL.revokeObjectURL(url);
      toast('Encrypted vault downloaded');
    } catch (err) {
      toast(err.message || 'Download failed', true);
    }
  });

  function importResultToast(result) {
    const notes = result && result.imported != null ? result.imported : 0;
    const tags = result && result.tags ? result.tags : 0;
    const files = result && result.files ? result.files : 0;
    const missing = result && result.filesMissing ? result.filesMissing : 0;
    const parts = [];
    if (tags) parts.push(`${notes} notes and ${tags} tags`);
    else if (notes) parts.push(`${notes} item${notes === 1 ? '' : 's'}`);
    if (files) parts.push(`${files} file${files === 1 ? '' : 's'} attached`);
    if (missing) parts.push(`${missing} file${missing === 1 ? '' : 's'} still missing — add the originals on those notes`);
    if (!parts.length) return files || missing ? '' : `Imported ${notes} item${notes === 1 ? '' : 's'}`;
    return `Imported ${parts.join(', ')}`;
  }

  async function enqueueImportedAttachmentOcr(ids) {
    for (const attId of ids || []) {
      try {
        const att = NotesStore.get(attId);
        if (!att) continue;
        const bytes = await NotesStore.getAttachmentBytes(attId);
        if (!bytes?.length) continue;
        const file = new File([bytes], att.content.filename || 'document', {
          type: att.content.mime || 'application/octet-stream',
        });
        enqueueOcrJob({ attId, noteId: att.content.note_id, file });
      } catch (err) {
        console.warn('imported OCR skipped', attId, err);
      }
    }
  }

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('Importing…');
      const opened = await NotesSnImport.openBackupFile(file);
      let result;
      if (opened.kind === 'files-only') {
        result = await NotesStore.importLooseSnFiles(opened.blobs);
        result.imported = 0;
        result.tags = 0;
      } else {
        result = await NotesStore.importBackup(opened.text, true, { blobs: opened.blobs });
      }
      renderTags();
      renderNotes();
      if (currentId) {
        renderAttachments(currentId);
        applyEditorMode();
      }
      await enqueueImportedAttachmentOcr(result.attachmentIds);
      toast(importResultToast(result));
    } catch (err) {
      toast(err.message || 'Import failed', true);
    }
  });

  async function buildLocalBackup() {
    const account = await NotesStore.loadAccount();
    const rows = [];
    const all = [...NotesStore.state.items.values()].filter((i) => !i.deleted);
    for (const item of all) {
      const wrapped = await NotesCrypto.encryptObject(NotesStore.state.cryptoKey, item.content);
      const ciphertext = JSON.stringify(wrapped);
      rows.push({
        item_uuid: item.uuid,
        content_version: 1,
        ciphertext,
        content_hash: await NotesCrypto.hashText(ciphertext),
        deleted: false,
        updated_at: item.updated_at,
      });
    }
    return {
      format: 'deeperguard-backup-v1',
      user_email: account.email,
      kdf_salt: account.kdf_salt,
      exported_at: new Date().toISOString(),
      items: rows,
    };
  }

  window.addEventListener('beforeunload', () => {
    NotesStore.flush();
  });

  async function reconcileServiceWorkerBuild() {
    if (!notesBuild || !navigator.serviceWorker) return;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const worker = navigator.serviceWorker.controller || reg?.active;
    if (!worker) return;
    const cacheName = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(''), 800);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve((event.data && event.data.cache) || '');
      };
      try {
        worker.postMessage({ type: 'notes-build-ping' }, [channel.port2]);
      } catch (err) {
        clearTimeout(timer);
        resolve('');
      }
    });
    if (!cacheName) return;
    const expected = `deeperguard-offline-v${notesBuild}`;
    // Unversioned cache name is intentional — SW file stays byte-stable.
    if (cacheName === expected || cacheName === 'deeperguard-offline') return;
    // Never auto-reload on SW/page skew. Only advertise an update when the SW
    // cache is clearly newer than this page — never claim an older SW is "server".
    const match = /deeperguard-offline-v(.+)$/.exec(cacheName);
    const swBuild = match && match[1];
    if (!swBuild || swBuild === notesBuild) return;
    const swNum = Number(swBuild);
    const pageNum = Number(notesBuild);
    if (Number.isFinite(swNum) && Number.isFinite(pageNum)) {
      if (swNum > pageNum) applyServerBuildStatus(String(swBuild));
      return;
    }
    if (String(swBuild) > String(notesBuild)) applyServerBuildStatus(String(swBuild));
  }

  // Browser extensions (HARPA AI, Grammarly, password managers…) inject custom
  // elements into the live DOM. Names like <__hrp__> are not valid HTML tags, so
  // re-parsing a serialized shell turns them into visible text. Never cache them.
  const KNOWN_EXTENSION_IDS = {
    eanggfilgoajaocelnaflolkadkeghjp: 'HARPA AI',
  };
  const NATIVE_TAG = /^[a-z][a-z0-9]*$/i;

  function isForeignElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('data-ext-id')) return true;
    if (!NATIVE_TAG.test(el.tagName)) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    return /(^|\s)hrp[-_]/.test(cls) || /^hrp[-_]/.test(el.id || '');
  }

  function stripForeignNodes(root) {
    let removed = 0;
    for (const el of [...root.querySelectorAll('*')]) {
      if (!isForeignElement(el)) continue;
      el.remove();
      removed += 1;
    }
    for (const parent of [root, root.querySelector('body')].filter(Boolean)) {
      for (const node of [...parent.childNodes]) {
        if (node.nodeType === 3 && /<__[a-z0-9_]+__/i.test(node.textContent || '')) {
          node.remove();
          removed += 1;
        }
      }
    }
    return removed;
  }

  function detectedExtensionNames() {
    const names = new Set();
    for (const el of document.querySelectorAll('[data-ext-id]')) {
      const id = el.getAttribute('data-ext-id') || '';
      names.add(KNOWN_EXTENSION_IDS[id] || `extension ${id.slice(0, 8)}…`);
    }
    if (!names.size) {
      for (const el of document.body.children) {
        if (isForeignElement(el)) names.add('a browser extension');
      }
    }
    return [...names];
  }

  function warnAboutExtensionInjection() {
    if (IS_IOS) return;
    let shown = false;
    try { shown = sessionStorage.getItem('notes_ext_warned') === '1'; } catch (err) { /* ignore */ }
    if (shown) return;
    const names = detectedExtensionNames();
    if (!names.length) return;
    try { sessionStorage.setItem('notes_ext_warned', '1'); } catch (err) { /* ignore */ }
    toast(`${names.join(', ')} is injecting into this page and can read your decrypted notes. Disable it for this site.`, true);
  }

  function lockedShellHtml() {
    const live = document.documentElement.cloneNode(true);
    stripForeignNodes(live);
    const doc = new DOMParser().parseFromString(live.outerHTML, 'text/html');
    stripForeignNodes(doc.documentElement);
    doc.body.classList.remove('unlocked');
    doc.body.classList.add('locked');
    const app = doc.getElementById('app');
    if (app) {
      app.hidden = true;
      app.dataset.csrf = '';
    }
    const unlock = doc.getElementById('unlock-screen');
    if (unlock) unlock.hidden = false;
    const unlockSubmit = doc.getElementById('unlock-submit');
    if (unlockSubmit) {
      unlockSubmit.disabled = false;
      unlockSubmit.textContent = 'Unlock';
    }
    const unlockEmail = doc.getElementById('unlock-email');
    if (unlockEmail) {
      try {
        const saved = localStorage.getItem('notes_email');
        if (saved) unlockEmail.textContent = saved;
      } catch (err) {
        /* ignore */
      }
    }
    const unlockPw = doc.getElementById('unlock-password');
    if (unlockPw) unlockPw.value = '';
    const unlockErr = doc.getElementById('unlock-error');
    if (unlockErr) unlockErr.hidden = true;
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  }

  // Every URL the notes shell can be launched from. Never write the app HTML
  // under "/" — that path is the public marketing site.
  function shellCacheKeys() {
    const keys = new Set(['/app']);
    const path = location.pathname || '/app';
    if (path && path !== '/app' && path !== '/') keys.add(path);
    const out = [];
    keys.forEach((key) => {
      out.push(key);
      out.push(new Request(`${location.origin}${key}`));
    });
    return out;
  }

  async function writeShellCache(html, { build = '', cacheControl = 'no-cache' } = {}) {
    if (typeof caches === 'undefined' || !html) return false;
    const shell = await caches.open('deeperguard-shell');
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl };
    if (build) headers['X-Notes-Build'] = build;
    const keys = shellCacheKeys();
    await Promise.all(keys.map((key) => {
      const body = new Blob([html], { type: 'text/html; charset=utf-8' });
      return shell.put(key, new Response(body, { status: 200, headers }));
    }));
    return true;
  }

  function buildFromHtml(html) {
    const match = /name="notes-build"\s+content="([^"]+)"/.exec(html)
      || /notes-build" content="([^"]+)"/.exec(html);
    return match ? match[1] : '';
  }

  // Download the shell from /api/app-shell: the service worker ignores /api/
  // paths, so this can never be answered from the (stale) shell cache the way
  // a fetch of /app itself is when the network is slow.
  async function fetchLatestShellHtml({ timeoutMs = 20000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const fresh = await fetch(`/api/app-shell?t=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
      if (!fresh.ok) throw new Error(`HTTP ${fresh.status}`);
      return await fresh.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async function prefetchShellAssets(html) {
    const assetUrls = new Set();
    const assetRe = /(?:href|src)="(\/static\/[^"]+\?v=[^"]+)"/g;
    let assetMatch;
    while ((assetMatch = assetRe.exec(html))) {
      assetUrls.add(assetMatch[1]);
    }
    await Promise.all([...assetUrls].map(async (path) => {
      try {
        await fetch(path, { cache: 'reload', credentials: 'same-origin' });
      } catch (err) {
        /* non-fatal — shell HTML is enough to boot */
      }
    }));
  }

  let shellPreseedInFlight = null;

  // Newer build on the server: put its shell + assets into the caches now so
  // the next launch (any entry URL) boots the new build, without reloading
  // the page the user is looking at.
  function preseedLatestShell(serverBuild) {
    const target = String(serverBuild || '');
    const current = document.querySelector('meta[name="notes-build"]')?.content || '';
    if (!target || !current || target === current) return Promise.resolve(false);
    if (!window.isSecureContext || typeof caches === 'undefined') return Promise.resolve(false);
    let done = '';
    try { done = sessionStorage.getItem('notes_preseeded_build') || ''; } catch (err) { done = ''; }
    if (done === target) return Promise.resolve(false);
    if (shellPreseedInFlight) return shellPreseedInFlight;
    shellPreseedInFlight = (async () => {
      try {
        const html = await fetchLatestShellHtml();
        if (buildFromHtml(html) !== target) return false;
        await prefetchShellAssets(html);
        await writeShellCache(html, { build: target });
        try { sessionStorage.setItem('notes_preseeded_build', target); } catch (err) { /* ignore */ }
        return true;
      } catch (err) {
        return false;
      } finally {
        shellPreseedInFlight = null;
      }
    })();
    return shellPreseedInFlight;
  }

  async function persistAppShell() {
    if (!window.isSecureContext || typeof caches === 'undefined') return;
    const build = document.querySelector('meta[name="notes-build"]')?.content || '';
    try {
      const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (data.build && build && String(data.build) !== build) {
        preseedLatestShell(String(data.build)).catch(() => {});
        return;
      }
    } catch (err) {
      /* offline — cache the shell we have for unlock */
    }
    await writeShellCache(lockedShellHtml(), {
      build,
      cacheControl: 'public, max-age=0, stale-if-error=604800',
    });
  }

  async function clearAppCaches({ keepShellHtml = null } = {}) {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    // Re-seed the shell so a failed network reload still has something to show.
    if (keepShellHtml && typeof caches !== 'undefined') {
      try {
        await writeShellCache(keepShellHtml, { build: buildFromHtml(keepShellHtml) });
      } catch (err) {
        /* best effort */
      }
    }
    sessionStorage.removeItem('notes_sw_reloaded');
    sessionStorage.removeItem('notes_reloaded_build');
    sessionStorage.removeItem('notes_pending_update_build');
  }

  async function seedShellHtml(html) {
    if (typeof caches === 'undefined' || !html) return;
    try {
      await writeShellCache(html, { build: buildFromHtml(html) });
    } catch (err) {
      /* best effort */
    }
  }

  async function forceRefreshApp() {
    const VL = window.NotesVaultLock;
    if (VL && !VL.mayStartAppUpdate({ locked: VL.vaultIsLocked(document.body) })) return;
    if (typeof window.__notesShowUpdateProgress === 'function') {
      window.__notesShowUpdateProgress(true);
    }
    toast('Checking notes server…');
    const ok = await probeNetwork({ syncOnRecovery: false });
    if (!ok) {
      const msg = `${OFFLINE_LAN_HINT} Update needs a live connection so the new app can download.`;
      toast(msg, true);
      if (typeof window.__notesShowUpdateProgress === 'function') window.__notesShowUpdateProgress(false);
      throw new Error(msg);
    }
    // Keep the service worker registered. Unregister+wipe left Safari with nothing
    // to serve when LAN was unreachable after navigation (crash loop).
    let html = '';
    // Land on the canonical app URL: "/" is a redirect for signed-in users and
    // the marketing page otherwise, so reloading there after Update could show
    // the wrong page.
    const appPath = location.pathname && location.pathname !== '/' ? location.pathname : '/app';
    const currentBuild = document.querySelector('meta[name="notes-build"]')?.content || '';
    let serverBuild = '';
    try {
      const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      serverBuild = data && data.build ? String(data.build) : '';
    } catch (err) {
      serverBuild = '';
    }
    try {
      html = await fetchLatestShellHtml();
    } catch (err) {
      const msg = `${OFFLINE_LAN_HINT} Could not download the update — your current app was kept.`;
      toast(msg, true);
      if (typeof window.__notesShowUpdateProgress === 'function') window.__notesShowUpdateProgress(false);
      throw new Error(msg);
    }
    const downloadedBuild = buildFromHtml(html);
    if (!downloadedBuild) {
      toast('Update download looked invalid — current app kept.', true);
      if (typeof window.__notesShowUpdateProgress === 'function') window.__notesShowUpdateProgress(false);
      throw new Error('invalid update html');
    }
    if (serverBuild && downloadedBuild !== serverBuild && downloadedBuild === currentBuild) {
      const msg = `Update did not download the new build (got v${downloadedBuild}, server has v${serverBuild}). Check your connection and try again.`;
      toast(msg, true);
      if (typeof window.__notesShowUpdateProgress === 'function') window.__notesShowUpdateProgress(false);
      throw new Error(msg);
    }
    await prefetchShellAssets(html);
    await seedShellHtml(html);
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration('/');
        if (reg) {
          try {
            await fetch('/sw.js', { cache: 'reload', credentials: 'same-origin' });
          } catch (err) {
            /* still try update() */
          }
          await reg.update().catch(() => {});
          // Activate the waiting worker only when the user asked to Update.
          const waiting = reg.waiting;
          if (waiting) {
            waiting.postMessage({ type: 'SKIP_WAITING' });
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 1200);
              navigator.serviceWorker.addEventListener('controllerchange', () => {
                clearTimeout(timer);
                resolve();
              }, { once: true });
            });
          }
        }
      }
    } catch (err) {
      /* ignore */
    }
    try {
      sessionStorage.setItem('notes_user_requested_update', '1');
      // Always re-lock after Update — do not carry an unlocked session across reload.
      markUnlockAfterUpdate();
      sessionStorage.removeItem('notes_unlocked');
    if (typeof NotesVaultSecrets !== 'undefined') {
      NotesVaultSecrets.clearSecrets();
    }
      if (typeof NotesStore.lock === 'function') NotesStore.lock();
      // Avoid controllerchange → location.reload loops after this replace.
      sessionStorage.setItem('notes_sw_reloaded', downloadedBuild);
    } catch (err) {
      /* ignore */
    }
    // Soft reload — keep SW + caches; never use the hard refresh flag.
    location.replace(`${appPath}?t=${Date.now()}&nosync=1`);
  }

  window.notesForceRefreshApp = () => {
    const VL = window.NotesVaultLock;
    if (VL && !VL.mayStartAppUpdate({ locked: VL.vaultIsLocked(document.body) })) return;
    forceRefreshApp().catch((err) => {
      if (typeof window.__notesShowUpdateProgress === 'function') {
        window.__notesShowUpdateProgress(false);
      }
      toast(err.message || 'Update failed', true);
    });
  };

  async function checkAppUpdate() {
    const current = document.querySelector('meta[name="notes-build"]');
    const localBuild = current && current.getAttribute('content');
    try {
      const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!data.build || !localBuild) return false;
      // Never auto-reload. Notify via banner/sidebar chip; user taps Update.
      applyServerBuildStatus(String(data.build));
      return false;
    } catch (err) {
      /* stay on the cached shell */
    }
    return false;
  }

  function isVersionLaunch() {
    try {
      return new URLSearchParams(location.search).get('nosync') === '1';
    } catch (err) {
      return false;
    }
  }

  let vaultReady = false;
  let ignoreNextForeground = isVersionLaunch();
  let syncInFlight = null;
  function promptVaultUnlock(message) {
    if (NotesStore.isUnlocked()) {
      repairUnlockShellState();
      return message || '';
    }
    markRememberedShell(false);
    document.body.classList.add('locked');
    document.body.classList.remove('unlocked');
    showUnlock(NotesStore.cachedAccount().email || '');
    if (unlockError) {
      if (message) {
        unlockError.hidden = false;
        unlockError.textContent = message;
      } else {
        unlockError.hidden = true;
        unlockError.textContent = '';
      }
    }
    unlockPassword?.focus();
    return message || '';
  }

  async function handleLockedManualSync() {
    try {
      await NotesStore.api('/api/account', { timeoutMs: 4000 });
    } catch (err) {
      if (isSessionRevokedError(err)) {
        await wipeAfterRemoteSignOut();
        return;
      }
      if (err && [401, 403, 404].includes(err.status)) {
        NotesStore.emitSync('pending', 'Sign in to sync');
        promptVaultUnlock('Your session expired. Unlock with your vault password to sign in and sync.');
        return;
      }
    }
    promptVaultUnlock('Unlock your vault to display your notes and synchronize.');
  }

  function syncNow({ quiet = false, full = false, force = false } = {}) {
    repairUnlockShellState();
    if (!NotesStore.isUnlocked()) {
      if (!quiet) return handleLockedManualSync();
      return syncWhileVaultLocked({ quiet: true, force }).catch(() => false);
    }
    // Unlock screen visible but crypto still up — allow quiet background sync.
    if (!isVaultReadyForSync()) {
      if (!quiet) return handleLockedManualSync();
    }
    vaultReady = true;
    if (NotesStore.passwordChangeInFlight && NotesStore.passwordChangeInFlight()) {
      if (!quiet) toast('Password change is still saving…', true);
      return Promise.resolve();
    }
    const start = async () => {
      if (!NotesStore.isUnlocked()) return;
      if (!quiet && !isVaultReadyForSync()) return;
      if (typeof NotesStore.finishLoadLocal === 'function') {
        await NotesStore.finishLoadLocal();
      }
      if (!NotesStore.isUnlocked()) return;
      if (!quiet && !isVaultReadyForSync()) return;
      const syncBtn = document.getElementById('btn-sync-now');
      const emptySyncBtn = document.getElementById('btn-empty-sync');
      const setBusy = (busy) => {
        if (quiet) return;
        const ready = isVaultReadyForSync();
        if (syncBtn) {
          syncBtn.disabled = !!busy && ready;
          if (busy && ready) {
            syncBtn.dataset.state = 'syncing';
            syncBtn.setAttribute('data-state', 'syncing');
            syncBtn.classList.add('is-syncing');
            syncBtn.textContent = 'Syncing…';
          } else if (!busy) {
            const curPhase = displaySyncPhase(document.getElementById('sync-indicator')?.dataset.state || 'idle');
            syncBtn.dataset.state = curPhase;
            syncBtn.setAttribute('data-state', curPhase);
            syncBtn.classList.toggle('is-syncing', curPhase === 'syncing');
            syncBtn.textContent = curPhase === 'ok' ? 'Synced' : 'Sync';
          }
        }
        if (emptySyncBtn) {
          emptySyncBtn.disabled = !!busy && ready;
          emptySyncBtn.textContent = (busy && ready) ? 'Syncing…' : 'Sync notes';
        }
      };
      if (syncInFlight) {
        if (!quiet && isVaultReadyForSync()) {
          setBusy(true);
          toast(full ? 'Downloading all notes…' : 'Syncing…');
        }
        return syncInFlight.finally(() => { if (!quiet) setBusy(false); });
      }
      if (!networkReachable) {
        if (!quiet && isVaultReadyForSync()) setBusy(true);
        const ok = await probeNetwork({ syncOnRecovery: false });
        if (!ok) {
          NotesStore.emitSync('offline', 'Offline');
          if (!quiet) {
            setBusy(false);
            toast(OFFLINE_LAN_HINT, true);
          }
          return;
        }
      }
      // Throttle on the local clock only. lastSync is a server cursor; comparing
      // it with Date.now() skipped every quiet sync on devices whose clock ran behind.
      const lastAt = Number(NotesStore.state.lastSyncAt) || 0;
      if (!force && quiet && !full && lastAt && Date.now() - lastAt < 90000) {
        NotesStore.logSync?.('sync-skip', {
          quiet: true,
          reason: 'recent',
          lastSync: Number(NotesStore.state.lastSync) || 0,
          ageSec: Math.round((Date.now() - lastAt) / 1000),
        });
        return;
      }
      if (isVaultReadyForSync()) setBusy(true);
      if (!quiet && isVaultReadyForSync()) toast(full ? 'Downloading all notes…' : 'Syncing…');
      syncInFlight = NotesStore.loadAccount()
        .then(async (account) => {
          if (account && typeof account === 'object') renderPlanUi(account);
          if (await checkRemoteVaultPasswordChange(account)) return false;
          return account;
        })
        .catch((err) => {
          if (err && (err.status === 401 || err.status === 403) && !skipLogin) {
            // Account session expired: do not sync until signed in again.
            return ensureServerSession()
              .then((ok) => {
                if (ok) return NotesStore.cachedAccount();
                NotesStore.emitSync('pending', 'Sign in to sync');
                if (!quiet) toast('Signed out — sign in again to sync', true);
                return false;
              })
              .catch(() => false);
          }
          throw err;
        })
        .then(async (account) => {
          if (account === false) return false;
          return NotesStore.sync({ quiet, full });
        })
        .then((synced) => {
          if (synced === false) return;
          markNetworkReachable();
          pullGlobalPrefs();
          const noteCount = NotesStore.listNotes().filter((n) => !n.content?.trashed).length;
          if (noteCount > 0) clearVaultSyncError();
          if (!quiet) {
            refreshAllNoteSearchIndexes();
            renderTags();
            renderNotes();
            renderVaultStats();
            updateEmptyStateVisibility();
            toast(noteCount ? `Synced · ${noteCount} note${noteCount === 1 ? '' : 's'}` : 'Synced · server returned no notes for this password');
          } else if (noteCount > 0) {
            lastNotesRenderKey = '';
            renderNotes();
            updateEmptyStateVisibility();
          }
          refreshTotpVault({ migrate: true });
          if (!currentId) openPendingDeepLink({ final: true });
          reconcileReminderSideEffects();
        })
        .catch((err) => {
          if (err?.code === 'VAULT_LOCKED') {
            NotesStore.logSync?.('sync-aborted', { reason: 'locked', quiet: !!quiet });
            return;
          }
          console.warn('sync failed', err);
          const partialNotes = NotesStore.listNotes().filter((n) => !n.content?.trashed).length;
          if (partialNotes > 0) {
            clearVaultSyncError();
            renderNotes();
            updateEmptyStateVisibility();
          }
          if (err?.code === 'DECRYPT_FAILED' || (err?.code === 'DECRYPT_PARTIAL' && partialNotes === 0)) {
            handleVaultDecryptFailure(err, { relock: partialNotes === 0 });
          } else if (NotesStore.isProbablyOffline?.(err)) {
            networkReachable = false;
            NotesStore.emitSync('offline', 'Offline');
            if (!quiet) toast(OFFLINE_LAN_HINT, true);
          } else if (!quiet) {
            toast(err?.message || 'Sync failed', true);
          }
        })
        .finally(() => {
          syncInFlight = null;
          setBusy(false);
          endVaultPull();
          if (NotesStore.listNotes().length > 0 && !vaultSyncError) clearVaultSyncError();
          updateEmptyStateVisibility();
          uploadSyncDiagnostics().catch(() => {});
        });
      return syncInFlight;
    };
    return start();
  }

  function requestManualSync(event) {
    const full = !!(event && (event.shiftKey || event.altKey || event.metaKey));
    return syncNow({ full }).catch(() => {});
  }

  let changePollInFlight = false;

  // Ask the server for its sync watermark (a few bytes) and only run a real
  // pull when another device pushed something — keeps devices side by side in
  // step within ~CHANGE_POLL_MS without re-sending known hashes every time.
  async function pollRemoteChanges() {
    if (changePollInFlight) return;
    if (!NotesStore.isUnlocked()) {
      changePollInFlight = true;
      try {
        await syncWhileVaultLocked({ quiet: true, force: true });
      } finally {
        changePollInFlight = false;
      }
      return;
    }
    if (!vaultReady && !NotesStore.isUnlocked()) return;
    if (!isVaultReadyForSync() && !quiet) return;
    if (syncInFlight || vaultPullActive || !networkReachable) return;
    if (iosTune()?.isTypingInField?.()) return;
    if (typeof NotesStore.hasRemoteChanges !== 'function') return;
    changePollInFlight = true;
    try {
      const changed = await NotesStore.hasRemoteChanges();
      if (changed && NotesStore.isUnlocked()) {
        NotesStore.logSync?.('change-poll', { changed: true });
        await syncNow({ quiet: true, force: true });
      }
    } catch (err) {
      /* offline or session expired — the regular sync path reports that */
    } finally {
      changePollInFlight = false;
    }
  }

  function scheduleChangePoll({ background = false } = {}) {
    const nextBackground = !!background;
    const ms = nextBackground ? BACKGROUND_CHANGE_POLL_MS : CHANGE_POLL_MS;
    if (changePollTimer && changePollBackground === nextBackground) return;
    changePollBackground = nextBackground;
    clearInterval(changePollTimer);
    changePollTimer = setInterval(() => {
      pollRemoteChanges().catch(() => {});
    }, ms);
  }

  function stopChangePoll() {
    clearInterval(changePollTimer);
    changePollTimer = null;
  }

  let lastForegroundAt = 0;
  function onAppForeground(reason = '') {
    const now = Date.now();
    // iOS fires visibility/pageshow when the keyboard opens for Search — that used
    // to kick a full sync/reindex and look like the app reloaded mid-typing.
    if (reason !== 'online' && now - lastForegroundAt < 2000) return;
    lastForegroundAt = now;
    checkAppUpdate().catch(() => {});
    probeNetwork({ syncOnRecovery: true }).catch(() => {});
    scheduleNetworkProbe();
    if (!vaultReady || ignoreNextForeground) return;
    if (NotesStore.isUnlocked()) {
      NotesStore.loadAccount()
        .then((account) => checkRemoteVaultPasswordChange(account))
        .catch(() => {});
    }
    // Skip heavy work while the user is typing in search or any field.
    if (iosTune()?.isTypingInField?.()) {
      probeNetwork({ syncOnRecovery: false }).catch(() => {});
      return;
    }
    // Coming back to the app must always check the server — the "synced
    // recently" throttle made the iOS PWA show stale notes after switching devices.
    syncNow({ quiet: true, force: true });
    scheduleChangePoll();
    ensureServerSession()
      .then(() => {
        if (IS_IOS) runPostUnlockHeavyWork();
        else resumePendingOcr();
      })
      .catch(() => {
        if (IS_IOS) runPostUnlockHeavyWork();
        else resumePendingOcr();
      });
    if (currentId) pullNoteOcrFromServer(currentId).catch(() => {});
  }

  document.addEventListener('click', (event) => {
    const el = event.target;
    if (el && el.matches && el.matches('input[type="file"]')) {
      beginNotesPicker();
      watchPickerCancel(el);
    }
  }, true);
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (el && el.matches && el.matches('input[type="file"]')) {
      setTimeout(() => endNotesPicker(), 400);
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      scheduleChangePoll({ background: true });
      NotesStore.flush();
      // Release preview blobs in the background — lowers the odds iOS
      // jetsams the tab and forces a reload when you come back.
      teardownForBackground();
      onAppBackground();
      return;
    }
    if (notesPickerDepth > 0) {
      setTimeout(() => {
        if (document.visibilityState === 'visible') notesPickerDepth = 0;
      }, 800);
    }
    settleUnfocusLockOnForeground();
    onAppForeground('visibility');
  });
  window.addEventListener('pagehide', () => {
    if (document.visibilityState !== 'hidden') return;
    NotesStore.flush();
    teardownForBackground();
    onAppBackground();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      probeNetwork({ syncOnRecovery: true }).catch(() => {});
      const action = window.NotesVaultLock?.pageshowAction
        ? NotesVaultLock.pageshowAction({
          unlocked: NotesStore.isUnlocked(),
          transient: isTransientUnfocus(),
          requireTyped: requireTypedUnlock(),
          requireUpdate: requireUnlockAfterUpdate(),
          mode: lockOnUnfocusMode(),
          hiddenAt: readUnfocusedAt(),
          now: Date.now(),
        })
        : (NotesStore.isUnlocked() ? 'stay-app' : 'continue-boot');
      if (action === 'ignore') return;
      if (action === 'lock') {
        suppressUnlockScreen = false;
        markRememberedShell(false);
        if (NotesStore.isUnlocked()) lockVaultAfterUnfocus('Vault locked.');
        else showUnlock();
        return;
      }
      if (action === 'unlock-screen') {
        suppressUnlockScreen = false;
        markRememberedShell(false);
        showUnlock();
        return;
      }
      if (action === 'stay-app') {
        settleUnfocusLockOnForeground();
        onAppForeground('pageshow');
        return;
      }
      const cached = NotesStore.cachedAccount();
      const bootSalt = cached.kdf_salt
        || localStorage.getItem('notes_kdf_salt')
        || sessionStorage.getItem('notes_kdf_salt')
        || '';
      const savedPassword = savedUnlockPassword();
      if (skipLogin || savedPassword && bootSalt) {
        suppressUnlockScreen = true;
        markRememberedShell(true);
        ensureUnlocked().catch(() => {});
      }
      return;
    }
    onAppForeground('pageshow');
  });
  window.addEventListener('online', () => onAppForeground('online'));
  window.addEventListener('offline', () => {
    probeNetwork().then((ok) => {
      if (!ok) {
        networkReachable = false;
        NotesStore.emitSync('offline', 'Offline');
        updateNetworkStatusBanner();
      }
    }).catch(() => {
      networkReachable = false;
      NotesStore.emitSync('offline', 'Offline');
      updateNetworkStatusBanner();
    });
  });
  // Block accidental native form submits (iOS autofill / password managers).
  // preventDefault only — do not stopPropagation or unlock/login handlers never run.
  document.addEventListener('submit', (event) => {
    event.preventDefault();
  }, true);

  async function boot() {
    updateSecureContextHint();
    if (typeof NotesStore.setSessionRevokedHandler === 'function') {
      NotesStore.setSessionRevokedHandler(() => { wipeAfterRemoteSignOut(); });
    }
    startRemoteRevokeWatch();
    if (await checkAppUpdate()) return;
    try {
      const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (data.build) applyServerBuildStatus(String(data.build));
    } catch (err) {
      /* offline — banner stays hidden */
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      }).then((reg) => {
        if (reg && typeof reg.update === 'function') {
          reg.update().catch(() => {});
        }
        if (reg && reg.periodicSync) {
          reg.periodicSync.register('notes-sync', { minInterval: 12 * 60 * 60 * 1000 }).catch(() => {});
        }
      }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notes-periodic-sync') {
          if (vaultReady && NotesStore.isUnlocked()) {
            syncNow({ quiet: true, force: true }).catch(() => {});
          } else {
            syncWhileVaultLocked({ quiet: true }).catch(() => {});
          }
        }
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Never reload here. A leftover notes_user_requested_update flag plus a
        // new SW claim used to call location.reload() while browsing, which then
        // locked the vault (v197+). Update already navigates via location.replace.
        try {
          sessionStorage.removeItem('notes_user_requested_update');
        } catch (err) {
          /* ignore */
        }
        checkAppUpdate().catch(() => {});
      });
      reconcileServiceWorkerBuild().catch(() => {});
    }
    // pdf.js loads lazily when a document is opened — never at boot (iOS memory).
    if (!(await ensureUnlocked())) return;
    if (!NotesStore.isUnlocked()) {
      showUnlock(NotesStore.cachedAccount().email || '');
      return;
    }
    if (!document.body.classList.contains('unlocked')) showApp();
    if (isStandalonePwa()) markPwaStandaloneVerified();
    persistAppShell().catch(() => {});
    setTimeout(warnAboutExtensionInjection, 2500);
    if (!vaultHydrated) {
      try {
        await NotesStore.loadLocal();
      } catch (err) {
        console.warn('local vault load failed', err);
      }
      refreshSyncMeta();
      renderTags();
      renderNotes();
      applyPrefs();
      updateEmptyStateVisibility();
      renderVaultStats();
      vaultHydrated = true;
      // Overview first after unlock; user picks a note from the list.
    }
    if (IS_IOS) {
      scheduleIdleHeavyWork(() => refreshAllNoteSearchIndexes());
    } else {
      refreshAllNoteSearchIndexes();
    }
    vaultReady = true;
    initPullToSync();
    initEditorEdgeSwipeBack();
    document.getElementById('btn-network-retry')?.addEventListener('click', () => {
      probeNetwork({ syncOnRecovery: true })
        .then((ok) => {
          if (ok) syncNow({ quiet: false }).catch(() => {});
          else toast(OFFLINE_LAN_HINT, true);
        })
        .catch(() => toast(OFFLINE_LAN_HINT, true));
    });
    document.addEventListener('focusin', () => scrollFocusedFieldIntoView(), true);
    try {
      consumeNoteDeepLink();
      if (!currentId) openRememberedNote();
    } catch (err) {
      /* stay on the list */
    }
    updateOfflineSetupBanner();
    updateNetworkStatusBanner();
    setTimeout(() => flushPendingUpdatePrompt(), 1200);
    maybeAutoEnableRememberDevice();
    await probeNetwork().catch(() => {});
    refreshSettingsDiagnostics().catch(() => {});
    setTimeout(() => {
      maybePromptOfflineSetup().catch(() => {});
    }, 600);
    scheduleNetworkProbe();
    NotesStore.loadAccount()
      .then((account) => renderPlanUi(account))
      .catch(() => ensureServerSession().catch(() => {}));
    deferredUnlockSync?.catch(() => {});
    const needsNotes = NotesStore.listNotes().length === 0;
    if (needsNotes && NotesStore.isUnlocked()) {
      ignoreNextForeground = false;
      unlockDidSync = false;
      syncNow({ full: true, quiet: false, force: true })
        .then(() => ensureServerSession())
        .then(() => runPostUnlockHeavyWork())
        .catch((err) => {
          if (err?.code === 'DECRYPT_FAILED' || err?.code === 'DECRYPT_PARTIAL') {
            handleVaultDecryptFailure(err, { relock: NotesStore.listNotes().length === 0 });
          }
          runPostUnlockHeavyWork();
        })
        .finally(() => {
          renderVaultStats();
          renderNotes();
          updateEmptyStateVisibility();
          if (NotesStore.listNotes().length === 0) {
            toast('No notes downloaded — tap Sync or re-enter your vault password', true);
          }
        });
    } else if ((ignoreNextForeground || unlockDidSync) && !needsNotes) {
      unlockDidSync = false;
      ensureServerSession().then(() => runPostUnlockHeavyWork()).catch(() => runPostUnlockHeavyWork());
      setTimeout(() => {
        ignoreNextForeground = false;
      }, 3000);
    } else if (!needsNotes && !NotesStore.needsSyncOnOpen()) {
      ignoreNextForeground = false;
      ensureServerSession().then(() => runPostUnlockHeavyWork()).catch(() => runPostUnlockHeavyWork());
    } else {
      ignoreNextForeground = false;
      unlockDidSync = false;
      syncNow({ quiet: !needsNotes })
        .then(() => ensureServerSession())
        .then(() => runPostUnlockHeavyWork())
        .catch(() => runPostUnlockHeavyWork())
        .finally(() => {
          renderVaultStats();
          renderNotes();
          updateEmptyStateVisibility();
          if (NotesStore.listNotes().length === 0) {
            toast('No notes on this device yet — pull to sync or check vault password', true);
          }
        });
    }
    handleLaunchAction();
    iosTune()?.warnStorageIfLow?.().then((low) => {
      if (low) toast('Storage almost full — delete old attachments or clear browser data', true);
    }).catch(() => {});
    const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    ['pointerdown', 'keydown', 'touchstart'].forEach((name) => {
      document.addEventListener(name, bumpIdle, { passive: true });
    });
    document.addEventListener('keydown', (e) => {
      if (
        e.key === 'Backspace'
        && !typing(e.target)
        && document.body.classList.contains('unlocked')
      ) {
        e.preventDefault();
        if (currentId || (ui.editor && !ui.editor.hidden)) {
          closeEditor();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault();
        createNote();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (currentId) showFindBar();
        else ui.search.focus();
      }
      if (!typing(e.target) && (e.key === 'j' || e.key === 'k')) {
        e.preventDefault();
        const items = [...ui.noteList.querySelectorAll('.note-item')];
        if (!items.length) return;
        const at = items.findIndex((btn) => btn.dataset.id === currentId);
        const next = e.key === 'j' ? Math.min(items.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1);
        openNote(items[next].dataset.id);
      }
      if (e.key === 'Escape') {
        if (ui.docViewer && !ui.docViewer.hidden) {
          closeDocPreview();
          return;
        }
        if (ui.empty && !ui.empty.hidden && !currentId && !vaultSyncError) {
          dismissEmptyState();
          return;
        }
        if (!document.getElementById('scan-dialog').hidden) {
          hideScanDialog();
          return;
        }
        if (!document.getElementById('find-bar').hidden) {
          hideFindBar();
          return;
        }
        if (!ui.settings.hidden) {
          closeSettings(true);
          return;
        }
        const noteOptions = document.getElementById('note-options');
        if (noteOptions && !noteOptions.hidden) {
          closeNoteOptions();
          return;
        }
        if (!document.getElementById('tag-composer').hidden) {
          hideTagComposer();
          return;
        }
        const openRow = ui.noteList.querySelector('.note-row.open');
        if (openRow) {
          openRow.classList.remove('open');
          return;
        }
        if (currentId) closeEditor();
      }
    });
    setInterval(() => runBackgroundSync(), 120000);
    scheduleChangePoll({ background: document.visibilityState === 'hidden' });
    setInterval(() => {
      checkAppUpdate().catch(() => {});
    }, 60000);
  }

  window.notesRunPhotoSearchSelfTest = runPhotoSearchSelfTest;
  window.notesRunAllDeviceTests = runAllDeviceTests;
  window.notesClearAppCaches = clearAppCaches;

  boot();
})();
