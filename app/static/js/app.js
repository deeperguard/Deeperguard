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
  function attachmentKindName(content) {
    if (!content) return '';
    return [content.filename, content.original_filename].filter(Boolean).join(' ');
  }
  function attachmentKind(att) {
    if (!att?.content) return 'other';
    return NotesPreview.kindFromMeta(att.content.mime, attachmentKindName(att.content));
  }
  function attachmentThumbLabel(kind) {
    if (kind === 'pdf') return 'PDF';
    if (kind === 'image') return 'IMG';
    return 'FILE';
  }
  function attachmentBadgeHtml(label) {
    return `<span class="att-kind-badge" aria-hidden="true">${escapeHtml(label || 'FILE')}</span>`;
  }
  function thumbPaintRoot(stage) {
    if (!stage) return stage;
    return stage.querySelector(':scope > .thumb-paint') || stage;
  }
  function paintThumbImage(stage, src, label) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    const paint = thumbPaintRoot(stage);
    const show = () => {
      if (!stage.isConnected || !img.naturalWidth) return;
      const fitted = fitThumbCanvas(img);
      paint.replaceChildren(fitted || img);
    };
    img.addEventListener('load', show);
    img.addEventListener('error', () => {
      if (!stage.isConnected) return;
      paint.textContent = label || 'FILE';
    });
    img.src = src;
    if (img.complete) {
      if (img.naturalWidth) show();
      else paint.textContent = label || 'FILE';
    }
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
    const paint = thumbPaintRoot(stage);
    if (stage.matches('button')) {
      paint.innerHTML = `<span class="ios-pdf-label">${escapeHtml(label)}</span>`;
      stage.removeAttribute('data-lazy-thumb');
      return;
    }
    paint.innerHTML = `<span class="ios-pdf-label${compact ? ' compact' : ''}">${escapeHtml(label)}</span>`;
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
    compactList: true,
    sort: 'updated',
    autoPreview: false,
    // Opt-out: new and existing clients auto-open empty single-PDF notes in inline preview.
    autoOpenPdfOnly: true,
    autoLockMin: 15,
    lockOnUnfocus: '1min',
    rememberDevice: false,
    lightVault: false,
    navPinned: false,
    aiChat: null,
    googleOauthClientId: '',
    dropboxAppKey: '',
    dropboxRefreshToken: '',
    dropboxAccessToken: '',
    dropboxTokenExpiresAt: 0,
    dropboxConnected: false,
    tagsCollapsed: false,
    foldersCollapsed: false,
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
  // One-time denser phone list chrome (collapse tags/folders; more note rows visible).
  if (prefs.listChromeDense !== 3) {
    prefs.listChromeDense = 3;
    prefs.tagsCollapsed = true;
    prefs.foldersCollapsed = true;
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
  // Tags start expanded. Older builds forced them shut on every launch.
  if (prefs.tagsExpandedDefault !== 1) {
    prefs.tagsExpandedDefault = 1;
    prefs.tagsCollapsed = false;
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore quota */ }
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
    'sort', 'autoPreview', 'autoOpenPdfOnly', 'autoLockMin', 'lockOnUnfocus', 'aiChat',
    'googleOauthClientId', 'dropboxAppKey',
    'dropboxRefreshToken', 'dropboxAccessToken', 'dropboxTokenExpiresAt', 'dropboxConnected',
  ];
  // Vault-only prefs never touch localStorage (API keys / OAuth tokens / app IDs).
  const VAULT_ONLY_PREF_KEYS = [
    'aiChat', 'googleOauthClientId', 'dropboxAppKey',
    'dropboxRefreshToken', 'dropboxAccessToken', 'dropboxTokenExpiresAt',
  ];
  // Device-only prefs (storage/offline behaviour differs per device).
  const DEVICE_PREF_KEYS = ['rememberDevice', 'lightVault', 'tagsCollapsed', 'foldersCollapsed', 'viewsCollapsed', 'searchFilters', 'listPaneWidth'];
  let globalPrefsAppliedAt = 0;
  // Do not push device/local defaults into the vault until we have pulled the
  // account settings item (or confirmed the vault has none). Round 55: a race
  // after sign-in could overwrite lockOnUnfocus / autoLockMin with Never.
  let globalPrefsHydrated = false;

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
    if (!globalPrefsHydrated) {
      const remote = NotesStore.getGlobalSettings?.();
      if (remote?.prefs) {
        // Settings exist — apply them first; never clobber with local defaults.
        pullGlobalPrefs({ render: false });
        if (!globalPrefsHydrated) return false;
      } else if (!unlockDidSync) {
        return false;
      } else {
        // Synced vault has no settings item yet; this device may seed once.
        globalPrefsHydrated = true;
      }
    }
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
    if (!remote || !remote.prefs) {
      if (unlockDidSync) globalPrefsHydrated = true;
      return false;
    }
    if (remote.updatedAt <= globalPrefsAppliedAt && globalPrefsHydrated) return false;
    globalPrefsAppliedAt = remote.updatedAt;
    const incoming = pickGlobalPrefs(remote.prefs);
    const changed = Object.keys(incoming).some((key) => JSON.stringify(prefs[key]) !== JSON.stringify(incoming[key]));
    if (changed) {
      Object.assign(prefs, incoming);
      if (!(prefs.lockOnUnfocus === 'immediate' || prefs.lockOnUnfocus === '1min' || prefs.lockOnUnfocus === 'never')) {
        prefs.lockOnUnfocus = '1min';
      }
      if (typeof prefs.autoLockMin !== 'number' || !Number.isFinite(prefs.autoLockMin) || prefs.autoLockMin < 0) {
        prefs.autoLockMin = 15;
      }
      try { localStorage.setItem('deeperguard-prefs', localPrefsJson()); } catch (err) { /* ignore quota */ }
      applyPrefs();
      try { syncCloudProviderKeysFromPrefs(); } catch (err) { /* ignore */ }
      if (render) {
        renderNotes();
        if (!ui.settings?.hidden) initSettings().catch(() => {});
        if (currentId) applyEditorMode();
      }
    }
    globalPrefsHydrated = true;
    return changed;
  }

  const NOTE_SORT_ORDER = ['updated', 'created', 'title'];

  function sortModeLabel(mode) {
    if (mode === 'created') return 'Date created';
    if (mode === 'title') return 'Title';
    return 'Recent';
  }

  function syncSortControls() {
    const mode = NOTE_SORT_ORDER.includes(prefs.sort) ? prefs.sort : 'updated';
    if (prefs.sort !== mode) prefs.sort = mode;
    ['sort-select', 'sort-select-sidebar'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value !== mode) el.value = mode;
    });
    const cycleBtn = document.getElementById('btn-list-sort');
    const sortLabel = sortModeLabel(mode);
    if (cycleBtn) {
      const sortName = `Sort: ${sortLabel}. Tap to change.`;
      cycleBtn.title = sortName;
      cycleBtn.setAttribute('aria-label', sortName);
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

  const LIST_PANE_MIN = 200;
  const LIST_PANE_DEFAULT = 280;
  const LIST_PANE_ABS_MAX = 720;
  const EDITOR_PANE_MIN = 320;
  let paneSplitDragging = false;

  function cssViewportWidth() {
    const layout = document.documentElement?.clientWidth || window.innerWidth || 0;
    const visual = window.visualViewport && window.visualViewport.width;
    if (visual && visual > 0 && layout > 0) return Math.min(layout, visual);
    return layout || visual || 0;
  }

  function compactLayoutActive() {
    try {
      if (document.documentElement.classList.contains('layout-compact')) return true;
    } catch (err) { /* ignore */ }
    const width = cssViewportWidth();
    if (width > 0 && width < 1000) return true;
    return !!(window.matchMedia && window.matchMedia('(max-width: 999px)').matches);
  }

  function splitLayoutActive() {
    return !compactLayoutActive();
  }

  function readStoredListWidth() {
    const n = Number(prefs.listPaneWidth);
    if (!Number.isFinite(n)) return LIST_PANE_DEFAULT;
    return Math.round(Math.min(LIST_PANE_ABS_MAX, Math.max(LIST_PANE_MIN, n)));
  }

  function listPaneLimits() {
    const shell = ui.shell?.getBoundingClientRect();
    const nav = document.querySelector('.sidebar-nav')?.getBoundingClientRect();
    const shellWidth = shell?.width || 0;
    const navWidth = nav?.width || 0;
    if (!splitLayoutActive() || shellWidth < 100) {
      return {
        min: LIST_PANE_MIN,
        max: LIST_PANE_ABS_MAX,
        shellLeft: shell?.left || 0,
        navWidth,
      };
    }
    const max = Math.max(
      LIST_PANE_MIN,
      Math.min(LIST_PANE_ABS_MAX, Math.floor(shellWidth - navWidth - EDITOR_PANE_MIN)),
    );
    return { min: LIST_PANE_MIN, max, shellLeft: shell?.left || 0, navWidth };
  }

  function clampListPaneWidth(px) {
    const limits = listPaneLimits();
    const n = Number(px);
    const base = Number.isFinite(n) ? n : LIST_PANE_DEFAULT;
    return Math.round(Math.min(limits.max, Math.max(limits.min, base)));
  }

  function applyListPaneWidth(px, { persist = false } = {}) {
    const width = clampListPaneWidth(px);
    document.documentElement.style.setProperty('--sn-list-width', `${width}px`);
    const splitter = document.getElementById('pane-splitter');
    if (splitter) {
      const limits = listPaneLimits();
      splitter.setAttribute('aria-valuemin', String(limits.min));
      splitter.setAttribute('aria-valuemax', String(limits.max));
      splitter.setAttribute('aria-valuenow', String(width));
      splitter.setAttribute('aria-valuetext', `${width} pixels`);
    }
    if (persist) {
      prefs.listPaneWidth = width;
      try { localStorage.setItem('deeperguard-prefs', localPrefsJson()); } catch (err) { /* ignore quota */ }
    }
    return width;
  }

  function initPaneSplitter() {
    const splitter = document.getElementById('pane-splitter');
    if (!splitter || splitter.dataset.splitBound === '1') {
      applyListPaneWidth(readStoredListWidth(), { persist: false });
      return;
    }
    splitter.dataset.splitBound = '1';
    applyListPaneWidth(readStoredListWidth(), { persist: false });

    const finishDrag = (event) => {
      if (!paneSplitDragging) return;
      paneSplitDragging = false;
      document.body.classList.remove('pane-resizing');
      const current = Number(splitter.getAttribute('aria-valuenow'));
      applyListPaneWidth(current, { persist: true });
      if (event && splitter.hasPointerCapture?.(event.pointerId)) {
        try { splitter.releasePointerCapture(event.pointerId); } catch (err) { /* already released */ }
      }
    };

    splitter.addEventListener('pointerdown', (event) => {
      if (!splitLayoutActive()) return;
      if (event.button != null && event.button !== 0) return;
      paneSplitDragging = true;
      document.body.classList.add('pane-resizing');
      try { splitter.setPointerCapture(event.pointerId); } catch (err) { /* pointer already gone */ }
      event.preventDefault();
    });
    splitter.addEventListener('pointermove', (event) => {
      if (!paneSplitDragging) return;
      const limits = listPaneLimits();
      applyListPaneWidth(event.clientX - limits.shellLeft - limits.navWidth, { persist: false });
    });
    splitter.addEventListener('pointerup', finishDrag);
    splitter.addEventListener('pointercancel', finishDrag);
    window.addEventListener('blur', () => {
      if (!paneSplitDragging) return;
      finishDrag(null);
    });
    splitter.addEventListener('keydown', (event) => {
      if (!splitLayoutActive()) return;
      const current = Number(splitter.getAttribute('aria-valuenow')) || readStoredListWidth();
      const limits = listPaneLimits();
      const step = event.shiftKey ? 48 : 16;
      let next = null;
      if (event.key === 'ArrowLeft') next = current - step;
      else if (event.key === 'ArrowRight') next = current + step;
      else if (event.key === 'Home') next = limits.min;
      else if (event.key === 'End') next = limits.max;
      else return;
      event.preventDefault();
      applyListPaneWidth(next, { persist: true });
    });

    const syncToViewport = () => {
      if (paneSplitDragging) return;
      applyListPaneWidth(readStoredListWidth(), { persist: false });
    };
    window.addEventListener('resize', syncToViewport);
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(syncToViewport);
      if (ui.shell) observer.observe(ui.shell);
      const nav = document.querySelector('.sidebar-nav');
      if (nav) observer.observe(nav);
    }
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

  // Phone chip overlays are ephemeral — never share state with desktop sidebar
  // collapse prefs (tagsCollapsed / foldersCollapsed).
  let phoneBrowseOpen = null; // null | 'tags' | 'folders'
  let lastCompactLayout = compactLayoutActive();

  function applyTagSection() {
    collapseMobileNavOnce();
    const section = document.getElementById('tag-section');
    if (!section) return;
    if (compactLayoutActive()) {
      section.open = phoneBrowseOpen === 'tags';
      return;
    }
    section.open = !prefs.tagsCollapsed;
  }

  function applyFolderSection() {
    collapseMobileNavOnce();
    const section = document.getElementById('folder-section');
    if (!section) return;
    if (compactLayoutActive()) {
      section.open = phoneBrowseOpen === 'folders';
      return;
    }
    section.open = !prefs.foldersCollapsed;
  }

  function closePhoneBrowseOverlay({ focusChip = false } = {}) {
    if (!compactLayoutActive()) return false;
    const which = phoneBrowseOpen;
    if (!which) {
      const tagOpen = document.getElementById('tag-section')?.open;
      const folderOpen = document.getElementById('folder-section')?.open;
      if (!tagOpen && !folderOpen) return false;
    }
    phoneBrowseOpen = null;
    const tagSection = document.getElementById('tag-section');
    const folderSection = document.getElementById('folder-section');
    if (tagSection) tagSection.open = false;
    if (folderSection) folderSection.open = false;
    if (focusChip) {
      const chip = (which === 'folders' ? folderSection : tagSection)?.querySelector('summary');
      try { chip?.focus?.({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
    return true;
  }

  function collapseMobileNavOnce() {
    if (!compactLayoutActive()) return;
    if (prefs.mobileNavCollapsed === 1) return;
    prefs.mobileNavCollapsed = 1;
    // Close phone overlays only — do not overwrite desktop collapse prefs.
    phoneBrowseOpen = null;
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore quota */ }
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
    autosizeNoteBody();
    ui.body.classList.toggle('mono', !!prefs.monospace);
    document.getElementById('note-body-highlights')?.classList.toggle('mono', !!prefs.monospace);
    document.getElementById('note-body-wrap')?.classList.toggle('mono', !!prefs.monospace);
    ui.body.spellcheck = !!prefs.spellcheck && !ui.editor?.classList.contains('code-note');
    ui.noteList.classList.toggle('compact', noteListDensity() === 'compact');
    ui.noteList.classList.toggle('comfortable', noteListDensity() === 'comfortable');
    ui.noteList.classList.toggle('hide-previews', !!prefs.hidePreviews);
    applyTagSection();
    applyFolderSection();
    applyFilterSection();
    applyNavRail();
    syncSortControls();
    bumpIdle();
  }

  function setNavViewsOpen(open) {
    document.body.classList.toggle('nav-views-open', !!open);
    const backdrop = document.getElementById('sidebar-nav-backdrop');
    if (backdrop) backdrop.hidden = !open;
  }

  function applyNavRail() {
    document.body.classList.toggle('nav-pinned', !!prefs.navPinned);
    const pin = document.getElementById('btn-nav-pin');
    if (pin) {
      pin.setAttribute('aria-pressed', prefs.navPinned ? 'true' : 'false');
      pin.title = prefs.navPinned ? 'Collapse sidebar' : 'Pin sidebar';
    }
    if (prefs.navPinned) setNavViewsOpen(false);
  }
  applyTheme();
  collapseMobileNavOnce();
  applyTagSection();
  applyFolderSection();
  syncSortControls();
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
    if (n <= 0) return '0 KB';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;
    const gb = n / (1024 * 1024 * 1024);
    return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(2)} GB`;
  }

  function accountStorageParts(account) {
    const used = Number(account?.storage_used_bytes) || 0;
    const quota = account?.storage_quota_effective;
    const quotaText = quota ? formatPlanBytes(quota) : 'Unlimited';
    return { used, quota, usedText: formatPlanBytes(used), quotaText };
  }

  function vaultActiveNoteCount() {
    // Match the note-list header (exclude empty never-saved stubs). Round 55.
    return listedActiveNoteCount();
  }

  function vaultTrashedNoteCount() {
    return NotesStore.listNotes().filter((n) => !n.deleted && n.content?.trashed).length;
  }

  function updatePlanBadge(badge, account) {
    if (!badge) return;
    const plan = String(account?.plan || 'pro').toLowerCase();
    const label = account?.plan_label
      || (plan === 'pro' ? 'Pro' : (plan === 'basic' ? 'Basic' : 'Free'));
    badge.textContent = label;
    badge.hidden = false;
    badge.classList.toggle('plan-badge-pro', plan === 'pro');
    badge.classList.toggle('plan-badge-basic', plan === 'basic');
    badge.classList.toggle('plan-badge-free', plan === 'free');
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
    updatePlanBadge(badge, account);
    const pricing = account.plan_pricing || {};
    if (pricing.billing_active) {
      price.textContent = pricing.price_eur_month > 0
        ? `€${pricing.price_eur_month.toFixed(2)}/month`
        : 'Included';
    } else {
      price.textContent = pricing.billing_note
        || (plan === 'free' ? 'Free forever' : 'Free during public beta');
    }
    if (tagline) tagline.textContent = account.plan_tagline || '';
    if (storage) {
      const { usedText, quotaText } = accountStorageParts(account);
      storage.textContent = `Encrypted storage: ${usedText} used of ${quotaText}`;
    }
    if (compareBody && account.plan_catalog) {
      const rows = [];
      Object.entries(account.plan_catalog).forEach(([key, meta]) => {
        const suggested = Number(meta.suggested_price_eur_month) || 0;
        const priceLine = suggested > 0
          ? `<span class="plan-compare-free">Free during public beta</span> · suggested €${suggested.toFixed(2)}/mo`
          : '<span class="plan-compare-free">Free</span>';
        rows.push(`<div class="plan-compare-card${key === plan ? ' is-current' : ''}">
          <h4>${escapeHtml(meta.label)}</h4>
          <p class="plan-compare-price">${priceLine}</p>
          <p class="muted">${escapeHtml(formatPlanBytes((Number(meta.storage_quota_mb) || 0) * 1024 * 1024))} storage</p>
          <ul>${(meta.features || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
        </div>`);
      });
      compareBody.innerHTML = rows.join('');
    }
    if (pricingNote && account.plan_catalog) {
      const free = account.plan_catalog.free;
      const basic = account.plan_catalog.basic;
      const pro = account.plan_catalog.pro;
      if (free && basic && pro) {
        pricingNote.textContent = `Suggested pricing when billing launches: Free ${free.storage_quota_mb} MB, Basic €${basic.suggested_price_eur_month.toFixed(2)}/month (€${basic.suggested_price_eur_year.toFixed(0)}/year), Pro €${pro.suggested_price_eur_month.toFixed(2)}/month (€${pro.suggested_price_eur_year.toFixed(0)}/year). Free during public beta.`;
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
    // Scan tips wait until a note has been saved with body text.
  }

  function noteHasScanOrAttachment(note) {
    if (!note?.uuid) return false;
    const atts = NotesStore.listAttachments(note.uuid);
    return atts.some((att) => {
      const content = att?.content || {};
      if (String(content.ocr_text || '').trim()) return true;
      if (content.file_enc || content.file_enc_stored || content.preview_enc) return true;
      const name = String(content.filename || content.original_filename || '');
      return !!name;
    });
  }

  function attachmentAlreadySearchable(att) {
    const content = att?.content || {};
    if (String(content.ocr_text || '').trim()) return true;
    if (content.ocr_method === 'text') return true;
    if (content.ocr_method === 'pending') return false;
    const method = content.ocr_method || '';
    if (!att?.uuid || method === 'none' || method === 'failed' || method === 'pending' || !method) return false;
    try {
      return !!NotesStore.searchIndexCovers?.(att.uuid);
    } catch (err) {
      return false;
    }
  }

  function noteUploadsSearchable(note) {
    if (!note?.uuid) return false;
    const atts = NotesStore.listAttachments(note.uuid);
    if (!atts.length) return false;
    return atts.every(attachmentAlreadySearchable);
  }

  function syncWritingTip(note) {
    const tip = document.getElementById('writing-tip');
    if (!tip) return;
    const show = !heroGuideDismissed() && noteHasScanOrAttachment(note) && !noteUploadsSearchable(note);
    tip.hidden = !show;
  }

  function maybeOfferWritingTip() {
    syncWritingTip(currentId ? NotesStore.get(currentId) : null);
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
    return '<span class="note-indexing" title="Indexing" aria-label="Indexing"><span class="note-indexing-spinner" aria-hidden="true"></span></span>';
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
          const planLabel = account?.plan_label || String(account?.plan || 'Free');
          lock.textContent = `Included with Pro. You are on ${planLabel} — contact support to upgrade when billing launches.`;
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
  const TAG_COLOR_NAMES = {
    '#4f8cff': 'blue',
    '#7c5cff': 'purple',
    '#2ec4b6': 'teal',
    '#ff9f1c': 'orange',
    '#e71d36': 'red',
    '#8b98a5': 'gray',
    '#f4d35e': 'yellow',
    '#ee964b': 'amber',
  };

  function tagColorName(color) {
    return TAG_COLOR_NAMES[String(color || '').toLowerCase()] || 'custom';
  }

  let currentId = null;
  let listSelectionId = null;
  let currentFilter = 'all';
  let filterBeforeFiles = 'all';
  let currentTag = null;
  let currentFolder = null;
  let folderCreateForNote = '';
  let previewOn = true;
  let editorMode = 'preview';
  const ocrQueue = [];
  const ocrQueued = new Set();
  const ocrInFlight = new Map();
  const ocrDeferred = new Map();
  const ocrWaitingServer = new Set();
  const serverOcrKnown = new Set();
  const serverOcrInFlight = new Map();
  const rescanOcrIds = new Set();
  let rescanOcrBusy = false;
  let ocrBusy = false;
  let ocrUiTimer = null;
  let ocrProgressToastAt = 0;
  let ocrDeferToastAt = 0;
  let ocrRetryTimer = null;
  let saveDebounce = null;
  let applyingDerivedTitle = false;
  // Title/body the editor last loaded from (or saved to) the store. When the
  // store copy no longer matches it, another device changed the open note and
  // the editor buffer must not be written back over that change.
  let editorBaseline = null;

  function captureEditorBaseline(note, gated = false) {
    if (!note || !currentId) {
      editorBaseline = null;
      return;
    }
    editorBaseline = {
      id: currentId,
      title: String(note.content?.title || ''),
      content: String(note.content?.content || ''),
      gated: !!gated,
    };
  }

  function storeChangedUnderEditor(note) {
    if (!editorBaseline || !note || editorBaseline.id !== currentId || editorBaseline.gated) return false;
    return String(note.content?.title || '') !== editorBaseline.title
      || String(note.content?.content || '') !== editorBaseline.content;
  }

  function editorHasUnsavedTyping(note) {
    if (!editorBaseline || editorBaseline.id !== currentId) return false;
    if (String(ui.body?.value || '') !== editorBaseline.content) return true;
    if (!titleLockedByUser(note)) return false;
    return String(ui.title?.value || '').trim() !== editorBaseline.title.trim();
  }

  function reloadOpenNoteFromStore(note) {
    ui.title.value = NotesSearch.effectiveNoteTitle(note);
    ui.title.removeAttribute('title');
    ui.title.setAttribute('aria-label', 'Title');
    ui.body.value = note.content.content || '';
    captureEditorBaseline(note, false);
    resetNoteUndoStack(currentId);
    if (ui.editorType) ui.editorType.value = note.content.editor || 'plain';
    try {
      applyEditorMode();
      renderHistory(note);
      updateNoteMeta(note);
      updateActionButtons(note);
    } catch (err) {
      /* chrome refresh is best effort */
    }
    if (ui.saveStatus) {
      ui.saveStatus.textContent = 'Updated from another device';
      ui.saveStatus.classList.remove('error');
    }
  }

  // Another device changed the note that is open here. With nothing unsaved in
  // the editor, show the new text. With unsaved typing, keep both: the remote
  // text becomes a conflict copy and the editor's text stays the live note.
  function reconcileOpenNoteWithStore(id) {
    if (!id || id !== currentId) return 'none';
    const note = NotesStore.get(id);
    if (!note || note.deleted || note.content?.type !== 'note') return 'none';
    if (note.content.locked && !unlockedNotes.has(id)) return 'none';
    if (!storeChangedUnderEditor(note)) return 'none';
    if (!editorHasUnsavedTyping(note)) {
      reloadOpenNoteFromStore(note);
      return 'reloaded';
    }
    NotesStore.keepConflictCopy(id, note.content, {
      source: 'editor',
      winnerContent: { title: String(ui.title?.value || ''), content: String(ui.body?.value || '') },
    });
    // The editor's text now wins; rebase so flushSave writes it as a normal edit.
    captureEditorBaseline(note, false);
    return 'conflict';
  }

  function titleLockedByUser(note) {
    if (!note?.content) return false;
    if (note.content.title_manual) return true;
    const stored = String(note.content.title || '').trim();
    if (!stored || stored === 'Untitled') return false;
    return stored !== NotesSearch.derivedTitleFromBody(note.content.content || '');
  }
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

  const OCR_PENDING_STALE_MS = 20 * 60 * 1000;

  function ocrPendingStale(att) {
    const ms = Date.parse(att?.content?.updated_at || '');
    if (!Number.isFinite(ms)) return false;
    return Date.now() - ms > OCR_PENDING_STALE_MS;
  }

  function heavyPreviewDeferred(attId) {
    if (!attId || (!IS_IOS && !isStandalonePwa())) return false;
    return ocrQueued.has(attId) || ocrInFlight.has(attId);
  }

  function attachmentOcrBusy(att) {
    const attId = att?.uuid;
    if (!attId) return false;
    if (rescanOcrIds.has(attId) || ocrWaitingServer.has(attId) || ocrInFlight.has(attId) || ocrQueued.has(attId)) return true;
    const method = att.content?.ocr_method || '';
    if (method === 'pending') return !ocrPendingStale(att);
    return false;
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
        syncWritingTip(NotesStore.get(attachmentNoteId));
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
    if (sec < 60) return 'just now';
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

  function listTimeAbsolute(isoOrMs) {
    const at = typeof isoOrMs === 'number' ? isoOrMs : parseTimestampMs(isoOrMs);
    if (!Number.isFinite(at) || at <= 0) return '';
    return new Date(at).toLocaleString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function listTimeLabel(isoOrMs) {
    const rel = relativeTime(isoOrMs);
    return rel || formatModified(isoOrMs).replace(/^Modified\s+/, '') || '';
  }

  function refreshRelativeTimes() {
    document.querySelectorAll('.note-modified[data-edited]').forEach((el) => {
      const ms = Number(el.dataset.edited);
      if (!ms) return;
      const next = listTimeLabel(ms);
      if (next && el.textContent !== next) el.textContent = next;
    });
    if (currentId && NotesStore.isUnlocked()) {
      const open = NotesStore.get(currentId);
      if (open) updateNoteMeta(open);
    }
  }
  setInterval(refreshRelativeTimes, 30000);

  function noteListDensity() {
    return prefs.compactList ? 'compact' : 'comfortable';
  }

  function noteSpreadsheetSource(note) {
    if (!note?.content) return '';
    const body = String(note.content.content || '').trim();
    const title = String(note.content.title || '').trim();
    if (window.NotesSpreadsheet?.isPayload?.(body)) return body;
    if (window.NotesSpreadsheet?.isPayload?.(title)) return title;
    return '';
  }

  function noteTitleFingerprint(note) {
    const title = String(note?.content?.title || '');
    if (!title) return '';
    if (title.length > 96 || (NotesSearch.looksLikeSpreadsheetPayload && NotesSearch.looksLikeSpreadsheetPayload(title))) {
      return `len:${title.length}`;
    }
    return title;
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

  function colorCodeKeywords(html) {
    return String(html || '').replace(
      /\b(const|let|var|function|return|if|else|for|while|class|import|from|def|async|await|True|False|None)\b/g,
      '<span class="tok-kw">$1</span>',
    );
  }

  function highlightCode(text) {
    const stringRe = /("[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g;
    return String(text || '').split('\n').map((line) => {
      let commentStart = -1;
      let quote = '';
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === '\\') { i += 1; continue; }
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          continue;
        }
        if (ch === '#' || (ch === '/' && line[i + 1] === '/')) {
          commentStart = i;
          break;
        }
      }
      const code = commentStart >= 0 ? line.slice(0, commentStart) : line;
      const comment = commentStart >= 0 ? line.slice(commentStart) : '';
      const parts = [];
      let last = 0;
      stringRe.lastIndex = 0;
      let match = stringRe.exec(code);
      while (match) {
        parts.push(colorCodeKeywords(escapeHtml(code.slice(last, match.index))));
        parts.push(`<span class="tok-str">${escapeHtml(match[0])}</span>`);
        last = match.index + match[0].length;
        match = stringRe.exec(code);
      }
      parts.push(colorCodeKeywords(escapeHtml(code.slice(last))));
      if (comment) parts.push(`<span class="tok-comment">${escapeHtml(comment)}</span>`);
      return parts.join('');
    }).join('\n');
  }
  if (typeof window !== 'undefined') window.NotesMarkdownHighlight = highlightCode;

  function noteUsesRenderedBody(type) {
    return type === 'plain' || type === 'markdown' || type === 'superscript';
  }

  function htmlWithoutInlineHandlers(html) {
    return String(html || '').replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }

  function renderNoteBodyPreview(text, editor) {
    let html;
    if (window.NotesSpreadsheet?.isPayload?.(text)) {
      html = NotesSpreadsheet.renderPreview(text);
    } else if (editor === 'code') {
      html = `<pre class="code-preview"><code>${highlightCode(text)}</code></pre>`;
    } else if (editor === 'markdown' && window.NotesMarkdown) {
      html = NotesMarkdown.render(text);
    } else if (window.NotesSuperscript && (editor === 'superscript' || editor === 'markdown' || editor === 'plain')) {
      html = NotesSuperscript.render(text);
    } else {
      html = NotesMarkdown.render(text);
    }
    if (window.NotesInDocNav?.annotateHeadingHtml) {
      html = NotesInDocNav.annotateHeadingHtml(html);
    }
    return htmlWithoutInlineHandlers(html);
  }

  function scrollEditorToLine(lineIndex) {
    if (!ui.body || lineIndex < 0) return false;
    const text = ui.body.value || '';
    const lines = text.split('\n');
    const line = Math.min(lineIndex, lines.length - 1);
    let pos = 0;
    for (let i = 0; i < line; i += 1) pos += lines[i].length + 1;
    const lineEnd = pos + (lines[line]?.length || 0);
    ui.body.focus();
    ui.body.setSelectionRange(pos, lineEnd);
    const lineHeight = parseFloat(getComputedStyle(ui.body).lineHeight) || 20;
    ui.body.scrollTop = Math.max(0, line * lineHeight - ui.body.clientHeight / 3);
    return true;
  }

  function followInDocLink(href) {
    const nav = window.NotesInDocNav;
    if (!nav) return false;
    const raw = String(href || '').trim();
    if (!raw || nav.isExternalHref(raw)) return false;
    const bodyText = ui.body?.value || '';
    const target = nav.resolveHeadingTarget(bodyText, raw);
    if (!ui.preview?.hidden) {
      const id = target?.id || nav.slugify(raw.replace(/^#/, ''));
      const el = ui.preview.querySelector(`#${CSS.escape(id)}`)
        || [...ui.preview.querySelectorAll('h1,h2,h3')].find((node) => nav.slugify(node.textContent || '') === id);
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return true;
      }
    }
    if (target && target.line >= 0) return scrollEditorToLine(target.line);
    return false;
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
    if (undoBtn) undoBtn.hidden = locked;
    if (redoBtn) redoBtn.hidden = locked;
  }

  function setEditorToolbarMenuOpen(open) {
    const on = !!open;
    document.body.classList.toggle('editor-toolbar-menu-open', on);
    document.querySelectorAll('.editor-toolbar-overflow-toggle').forEach((btn) => {
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    const backdrop = document.getElementById('editor-toolbar-menu-backdrop');
    if (backdrop) backdrop.hidden = !on;
    const panel = document.getElementById('editor-actions-overflow-panel');
    const inner = panel?.querySelector('.editor-toolbar-menu-panel');
    const narrow = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 999px)').matches;
    if (panel) {
      if (on && narrow) {
        panel.setAttribute('role', 'menu');
        panel.setAttribute('aria-label', 'Note actions');
        if (inner) inner.setAttribute('role', 'presentation');
      } else {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-label');
        if (inner) inner.setAttribute('role', 'menu');
      }
    }
    ['btn-ai-chat', 'btn-note-type-menu'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (on && narrow) el.setAttribute('role', 'menuitem');
      else el.removeAttribute('role');
    });
    if (!on) suppressToolbarTips();
  }
  function toolbarTipButtons() {
    return [
      ...document.querySelectorAll('.editor-toolbar-overflow-toggle'),
      ...document.querySelectorAll('.find-btn'),
    ];
  }

  function toolbarTipStillHot() {
    return toolbarTipButtons().some((btn) => {
      if (document.activeElement === btn) btn.blur();
      return btn.matches(':hover') || document.activeElement === btn;
    });
  }

  function suppressToolbarTips() {
    document.body.classList.add('editor-toolbar-tip-suppress');
    toolbarTipButtons().forEach((btn) => btn.blur());
    releaseToolbarTipWhenPointerLeaves();
  }
  let toolbarTipReleaseBound = false;
  function releaseToolbarTipWhenPointerLeaves() {
    const tick = () => {
      if (!document.body.classList.contains('editor-toolbar-tip-suppress')) return;
      if (toolbarTipStillHot()) return;
      document.body.classList.remove('editor-toolbar-tip-suppress');
    };
    requestAnimationFrame(tick);
    setTimeout(tick, 0);
    if (toolbarTipReleaseBound) return;
    toolbarTipReleaseBound = true;
    document.addEventListener('pointermove', tick, true);
  }

  function closeEditorToolbarMenu() {
    setEditorToolbarMenuOpen(false);
  }

  function toggleEditorToolbarMenu() {
    setEditorToolbarMenuOpen(!document.body.classList.contains('editor-toolbar-menu-open'));
  }

  function noteShouldList(note) {
    if (!note) return false;
    if (note.uuid === currentId) return true;
    if (NotesStore.listAttachments(note.uuid).length) return true;
    // Ever-saved notes stay listed even when the body is cleared to whitespace.
    if (NotesSearch.noteHasBeenSaved?.(note)) return true;
    return !(NotesSearch.noteIsEmptyStub?.(note));
  }

  function discardEmptyDraftNote(noteId) {
    const id = noteId || currentId;
    if (!id) return false;
    const note = NotesStore.get(id);
    if (!note || note.deleted) return false;
    if (NotesStore.listAttachments(id).length) return false;
    // Only drafts that never had user content may be auto-removed.
    if (!NotesSearch.noteMayHardDiscard?.(note)) return false;
    // Never synced → wipe locally. Already pushed → tombstone on the server.
    if (!(Number(note.rev) > 0) && typeof NotesStore.forgetLocal === 'function') {
      NotesStore.forgetLocal(id);
    } else {
      NotesStore.remove(id, { force: true });
    }
    if (currentId === id) currentId = null;
    if (listSelectionId === id) listSelectionId = null;
    return true;
  }

  function abandonEmptyUploadDraft(noteId) {
    if (!discardEmptyDraftNote(noteId)) return false;
    if (!currentId) {
      ui.shell?.classList.remove('editor-open');
      if (ui.editor) ui.editor.hidden = true;
      updateEmptyStateVisibility();
    }
    renderNotes();
    renderFolders();
    return true;
  }

  function listedActiveNoteCount() {
    return NotesStore.listNotes().filter((note) => {
      const content = note?.content || {};
      if (content.trashed || content.archived) return false;
      return noteShouldList(note);
    }).length;
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

  function syncCodeHighlight() {
    const wrap = document.getElementById('note-body-wrap');
    const layer = document.getElementById('note-body-highlights');
    const note = currentId ? NotesStore.get(currentId) : null;
    const type = note?.content?.editor || ui.editorType?.value || 'plain';
    const findOpen = document.getElementById('find-bar') && !document.getElementById('find-bar').hidden;
    const on = type === 'code' && ui.body && !ui.body.hidden && !findOpen;
    wrap?.classList.toggle('code-highlight-live', !!on);
    if (!layer || !on) {
      if (layer && !findOpen && layer.querySelector('.tok-kw, .tok-str, .tok-comment')) layer.innerHTML = '';
      return;
    }
    layer.innerHTML = highlightCode(ui.body.value || '');
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
      const anchor = event.target?.closest?.('a.edit-link[href], a.in-doc-link[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (followInDocLink(href)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!anchor.classList.contains('edit-link')) return;
      event.preventDefault();
      event.stopPropagation();
      openExternalLink(href);
    });
    ui.preview?.addEventListener('click', (event) => {
      const anchor = event.target?.closest?.('a.in-doc-link[href], a[href^="#"]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!followInDocLink(href)) return;
      event.preventDefault();
      event.stopPropagation();
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
    updateDevicePhrasePrompt();
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

  // Round 75: one-time in-app device-phrase prompt (never on login/unlock).
  function updateDevicePhrasePrompt() {
    try {
      if (!window.NotesDevicePhrase) return;
      const unlocked = !!(vaultReady && !document.body.classList.contains('locked'));
      NotesDevicePhrase.renderPromptCard(
        document.getElementById('device-phrase-prompt'),
        { unlocked },
      );
    } catch (err) {
      /* ignore */
    }
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
    text.innerHTML = offlineBannerHtml();
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

  function fetchHealthJson({ force = false, timeoutMs = 1500 } = {}) {
    // Single owner lives on window.__notesFetchHealth (app.html). All callers
    // share one in-flight promise and a global 2s→5s→10s failure backoff.
    if (typeof window.__notesFetchHealth === 'function') {
      return window.__notesFetchHealth(force, timeoutMs);
    }
    // Fallback when the boot helper is missing — still share + back off.
    if (fetchHealthJson._inflight) return fetchHealthJson._inflight;
    const now = Date.now();
    if (!force && fetchHealthJson._nextAt && now < fetchHealthJson._nextAt) {
      return Promise.resolve(null);
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (err) { /* ignore */ } }, timeoutMs) : 0;
    const inflight = fetch('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl?.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.ok) {
          fetchHealthJson._backoff = 0;
          fetchHealthJson._nextAt = 0;
          return data;
        }
        const prev = fetchHealthJson._backoff || 0;
        fetchHealthJson._backoff = prev < 2000 ? 2000 : (prev < 5000 ? 5000 : 10000);
        fetchHealthJson._nextAt = Date.now() + fetchHealthJson._backoff;
        return null;
      })
      .catch(() => {
        const prev = fetchHealthJson._backoff || 0;
        fetchHealthJson._backoff = prev < 2000 ? 2000 : (prev < 5000 ? 5000 : 10000);
        fetchHealthJson._nextAt = Date.now() + fetchHealthJson._backoff;
        return null;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (fetchHealthJson._inflight === inflight) fetchHealthJson._inflight = null;
      });
    fetchHealthJson._inflight = inflight;
    return inflight;
  }

  function flushPendingUpdatePrompt() {
    // /api/health via the shared boot cache, not a second request.
    fetchHealthJson()
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
    updateDevicePhrasePrompt();
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

  async function serverUnreachableNow({ force = false } = {}) {
    // Round 72: unlock passes force:true so a health backoff null or a stale
    // networkReachable=false cannot short-circuit before bootstrap/pull.
    if (!force && typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (!force && typeof window.notesNetworkReachable === 'function' && !window.notesNetworkReachable()) {
      return true;
    }
    // Share the page-load /api/health read. A second probe here used to fan out
    // before the user had even typed a password.
    try {
      const data = await fetchHealthJson({
        force,
        timeoutMs: force ? 3000 : 1500,
      });
      return !(data && data.ok);
    } catch (err) {
      return true;
    }
  }

  function isRealNetworkFailure(err) {
    if (!err) return true;
    if (err.code === 'aborted' || err.code === 'EMPTY_DEVICE_FETCH_PENDING') return true;
    if (typeof NotesStore !== 'undefined' && NotesStore.isProbablyOffline?.(err)) return true;
    const status = Number(err.status) || 0;
    if (!status && err.code !== 'DECRYPT_FAILED' && err.code !== 'PROBE_NO_SAMPLE') return true;
    return false;
  }

  // Empty-device unlock: first online pull retries at 0/1/2/4/8s, then fallback UI.
  const EMPTY_DEVICE_RETRY_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
  // After the fast window, only probe reachability (no vault key / no Argon2).
  const EMPTY_DEVICE_BG_PROBE_MS = CHANGE_POLL_MS;
  let emptyDeviceBgRetryTimer = 0;
  let emptyDeviceFetchGeneration = 0;

  function clearEmptyDeviceBgRetry() {
    if (emptyDeviceBgRetryTimer) {
      clearTimeout(emptyDeviceBgRetryTimer);
      emptyDeviceBgRetryTimer = 0;
    }
  }

  /** Stop background probes and invalidate any in-flight empty-device fetch. */
  function stopEmptyDeviceBackgroundRetry() {
    emptyDeviceFetchGeneration += 1;
    clearEmptyDeviceBgRetry();
  }

  function setEmptyDeviceUnlockUi(mode) {
    const status = document.getElementById('unlock-status');
    const progress = document.getElementById('unlock-progress');
    const retryBtn = document.getElementById('unlock-empty-retry');
    if (mode === 'fetching') {
      if (status) {
        status.hidden = false;
        status.classList.add('is-fetching');
        status.classList.remove('is-fallback');
        status.textContent = 'Getting your notes from the server…';
      }
      if (progress) {
        progress.hidden = false;
        progress.classList.add('is-indeterminate');
        progress.removeAttribute('aria-valuenow');
        progress.setAttribute('aria-busy', 'true');
      }
      if (retryBtn) retryBtn.hidden = true;
      return;
    }
    if (mode === 'fallback') {
      if (status) {
        status.hidden = false;
        status.classList.remove('is-fetching');
        status.classList.add('is-fallback');
        status.textContent = "Can't reach the server right now. We'll keep trying in the background.";
      }
      if (progress) {
        progress.hidden = true;
        progress.classList.remove('is-indeterminate');
        progress.removeAttribute('aria-busy');
      }
      if (retryBtn) retryBtn.hidden = false;
      return;
    }
    if (status) {
      status.hidden = true;
      status.classList.remove('is-fetching', 'is-fallback');
      status.textContent = '';
    }
    if (progress) {
      progress.hidden = true;
      progress.classList.remove('is-indeterminate');
      progress.removeAttribute('aria-busy');
    }
    if (retryBtn) retryBtn.hidden = true;
  }

  function emptyDeviceFetchPendingError() {
    const err = new Error(
      "Can't reach the server right now. We'll keep trying in the background.",
    );
    err.code = 'EMPTY_DEVICE_FETCH_PENDING';
    return err;
  }

  async function probeEmptyDeviceServerReachable() {
    // Reachability only — never derive a vault key or start an unlock attempt.
    try {
      const data = await fetchHealthJson({ force: true, timeoutMs: 3000 });
      if (data && data.ok) return true;
    } catch (err) { /* try account next */ }
    try {
      await NotesStore.loadAccount();
      return true;
    } catch (err) {
      // Server answered (session expired / auth) — still reachable.
      if (isLoginRequiredError(err) || Number(err?.status) > 0) return true;
      return !isRealNetworkFailure(err);
    }
  }

  function scheduleEmptyDeviceBackgroundRetry() {
    clearEmptyDeviceBgRetry();
    const gen = emptyDeviceFetchGeneration;
    emptyDeviceBgRetryTimer = setTimeout(() => {
      emptyDeviceBgRetryTimer = 0;
      if (gen !== emptyDeviceFetchGeneration) return;
      if (NotesStore.isUnlocked() && vaultKeyProven()) {
        setEmptyDeviceUnlockUi('clear');
        return;
      }
      const status = document.getElementById('unlock-status');
      if (!status?.classList.contains('is-fallback')) return;
      probeEmptyDeviceServerReachable().then((reachable) => {
        if (gen !== emptyDeviceFetchGeneration) return;
        if (reachable) {
          // Server is back. Clear the fallback so the unlock form is ready;
          // typed Unlock (or the existing post-login silent boot path) continues.
          setEmptyDeviceUnlockUi('clear');
          return;
        }
        scheduleEmptyDeviceBackgroundRetry();
      }).catch(() => {
        if (gen !== emptyDeviceFetchGeneration) return;
        scheduleEmptyDeviceBackgroundRetry();
      });
    }, EMPTY_DEVICE_BG_PROBE_MS);
  }

  async function fetchEmptyDeviceProofWithRetry(cached, { silent = false } = {}) {
    emptyDeviceFetchGeneration += 1;
    const gen = emptyDeviceFetchGeneration;
    clearEmptyDeviceBgRetry();
    setEmptyDeviceUnlockUi('fetching');
    let lastErr = null;
    for (let i = 0; i < EMPTY_DEVICE_RETRY_DELAYS_MS.length; i += 1) {
      if (gen !== emptyDeviceFetchGeneration) throw emptyDeviceFetchPendingError();
      const wait = EMPTY_DEVICE_RETRY_DELAYS_MS[i];
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (gen !== emptyDeviceFetchGeneration) throw emptyDeviceFetchPendingError();
      try {
        // Re-bootstrap when health/reachability was flaky on the first pass.
        try {
          await bootstrapServerSession(cached, {
            retryOnLoginRequired: !!(silent && isPostLoginBootUnlock()),
          });
        } catch (bootErr) {
          if (isLoginRequiredError(bootErr)) throw sessionExpiredError();
          if (!isRealNetworkFailure(bootErr)) throw bootErr;
          lastErr = bootErr;
          continue;
        }
        const proof = await assertVaultKeyVerified();
        setEmptyDeviceUnlockUi('clear');
        return { ok: true, proof };
      } catch (err) {
        if (isLoginRequiredError(err)) throw sessionExpiredError();
        if (err?.code === 'EMPTY_DEVICE_FETCH_PENDING') throw err;
        if (err?.code === 'PROBE_NO_SAMPLE' || isRealNetworkFailure(err)) {
          lastErr = err;
          setEmptyDeviceUnlockUi('fetching');
          continue;
        }
        setEmptyDeviceUnlockUi('clear');
        throw err;
      }
    }
    setEmptyDeviceUnlockUi('fallback');
    scheduleEmptyDeviceBackgroundRetry();
    if (silent) deferAutoUnlock();
    const pending = emptyDeviceFetchPendingError();
    if (lastErr) pending.cause = lastErr;
    throw pending;
  }

  // Round 72 helpers — empty-device unlock health + fetch retry UI.
  // Kept next to the Part A helpers (not beside NotesPostLoginUnlock) so the
  // Round 70 vm slice of POST_LOGIN_* helpers does not reference these consts.
  window.NotesEmptyDeviceUnlock = {
    EMPTY_DEVICE_RETRY_DELAYS_MS,
    EMPTY_DEVICE_BG_PROBE_MS,
    serverUnreachableNow,
    isRealNetworkFailure,
    setEmptyDeviceUnlockUi,
    emptyDeviceFetchPendingError,
    scheduleEmptyDeviceBackgroundRetry,
    clearEmptyDeviceBgRetry,
    stopEmptyDeviceBackgroundRetry,
    probeEmptyDeviceServerReachable,
  };

  let sessionExpiredAlertShown = false;
  let sessionExpiredHold = false;

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
    if (hint) {
      hint.textContent = 'Your sign-in expired. Enter your vault password to continue and resume sync.';
      hint.hidden = false;
    }
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
        sessionExpiredHold = false;
        return true;
      } catch (err) {
        if (isSessionRevokedError(err)) {
          await wipeAfterRemoteSignOut();
          return false;
        }
        if (isLoginRequiredError(err)) {
          showExpiredSessionBanner();
          return false;
        }
        if (isTotpRequiredError(err)) totpPending = true;
        else if (err && ![401, 403, 404].includes(err.status)) throw err;
        else authenticationExpired = true;
        NotesStore.setCsrf('');
      }
    }
    try {
      // Session refresh is GET /api/account. /api/account/unlock requires a
      // password proof and must not be called with an empty body.
      const data = await NotesStore.loadAccount();
      NotesStore.cacheAccount({
        email: data.email,
        kdf_salt: data.kdf_salt,
        vault_kdf_version: data.vault_kdf_version,
        csrf: data.csrf,
      });
      sessionExpiredAlertShown = false;
      sessionExpiredHold = false;
      return true;
    } catch (err) {
      if (isSessionRevokedError(err)) {
        await wipeAfterRemoteSignOut();
        return false;
      }
      if (isLoginRequiredError(err)) {
        showExpiredSessionBanner();
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

  function kindIconHtml(kind, badgeLabel) {
    const tone = kind.tone || 'note';
    const inner = kind.svg || escapeHtml(kind.icon || '');
    const icon = `<span class="note-kind-icon note-kind-icon--${escapeAttr(tone)}" aria-hidden="true">${inner}</span>`;
    if (!badgeLabel) return icon;
    return `<span class="note-kind-slot">${icon}${attachmentBadgeHtml(badgeLabel)}</span>`;
  }

  function listThumbPlaceholderHtml(kind) {
    const tone = kind.tone || 'note';
    const inner = kind.svg || escapeHtml(kind.icon || '');
    return `<span class="note-kind-icon note-kind-icon--${escapeAttr(tone)} note-list-thumb-fallback" aria-hidden="true">${inner}</span>`;
  }

  function listThumbHtml(att, noteId, kind, badgeLabel) {
    const label = badgeLabel || (kind && /^(PDF|IMG|FILE)$/.test(kind.label) ? kind.label : 'FILE');
    return `<div class="note-list-thumb" data-thumb-id="${escapeAttr(att.uuid)}" data-note-id="${escapeAttr(noteId)}" aria-hidden="true"><span class="thumb-paint">${listThumbPlaceholderHtml(kind)}</span>${attachmentBadgeHtml(label)}</div>`;
  }

  function paintListThumbFallback(stage, kind) {
    if (!stage) return;
    stage.classList.remove('ios-pdf-deferred', 'ios-pdf-loading');
    const meta = kind && (kind.svg || kind.icon) ? kind : { icon: '📄', tone: 'note', svg: kindIconSvg('note') };
    thumbPaintRoot(stage).innerHTML = listThumbPlaceholderHtml(meta);
  }

  function listThumbKindMeta(note, att) {
    if (note) return noteKindMeta(note);
    const name = att?.content?.filename || att?.content?.original_filename || '';
    const fileKind = NotesPreview.kindFromMeta(att?.content?.mime, name);
    if (fileKind === 'image') return { icon: '🖼', label: 'IMG', tone: 'note' };
    if (fileKind === 'pdf') return { icon: '📄', label: 'PDF', tone: 'note', svg: kindIconSvg('note') };
    return { icon: '📄', label: 'FILE', tone: 'note', svg: kindIconSvg('note') };
  }

  function attachListThumbErrorHandler(img, stage, noteId, attId) {
    img.addEventListener('error', () => {
      // Only revoke URLs this cache owns; makeListThumbUrl can hand back the
      // full-size previewCache URL, which the inline viewer still needs.
      if (listThumbCache.get(attId) === img.src) {
        try { URL.revokeObjectURL(img.src); } catch (err) { /* ignore */ }
        listThumbCache.delete(attId);
      }
      const note = NotesStore.get(noteId);
      const att = NotesStore.get(attId);
      paintListThumbFallback(stage, listThumbKindMeta(note, att));
    });
  }

  function highlightListText(text, query) {
    const source = String(text || '');
    const needle = String(query || '').trim();
    if (needle && typeof NotesSearch !== 'undefined' && NotesSearch.highlightPlain) {
      return NotesSearch.highlightPlain(source, needle);
    }
    return escapeHtml(source);
  }

  function checklistPreviewRows(items, query) {
    const open = items.filter((row) => !row.done);
    const needle = String(query || '').trim();
    if (!needle || typeof NotesSearch === 'undefined' || !NotesSearch.highlightPlain) {
      return open.slice(0, 2);
    }
    const hits = items.filter((row) => NotesSearch.highlightPlain(row.text, needle).includes('search-hit'));
    const openHits = hits.filter((row) => !row.done);
    const preferred = openHits.length ? openHits : (hits.length ? hits : open);
    return preferred.slice(0, 2);
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
      const shown = checklistPreviewRows(items, query);
      const bullets = shown.map((row) => (
        row.done
          ? `<span class="note-preview-checked">${highlightListText(`☑ ${row.text}`, query)}</span>`
          : highlightListText(`• ${row.text}`, query)
      )).join('\n');
      const more = Math.max(0, open.length - shown.filter((row) => !row.done).length);
      return `<p class="note-preview"><strong>${done}/${items.length}</strong> tasks completed</p>
        <span class="note-progress" aria-hidden="true"><span style="width:${pct}%"></span></span>
        ${bullets ? `<p class="note-preview-bullets">${bullets}</p>` : ''}
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
      const kind = NotesPreview.kindFromMeta(first.mime, attachmentKindName(first));
      if (kind === 'pdf') return { icon: '📄', label: 'PDF', tone: 'note', svg: kindIconSvg('note') };
      if (kind === 'image') return { icon: '🖼', label: 'IMG', tone: 'note' };
      return { icon: '📎', label: 'FILE', tone: 'note', svg: kindIconSvg('note') };
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

  // Session-only: after dismissing PDF-only auto-preview back to edit, skip
  // auto-open for that note id for the rest of this page session (survive
  // leave/reopen). Cleared only on full reload.
  const pdfOnlyAutoOpenSuppressedIds = new Set();

  function noteBodyIsBlank(note) {
    return !String(note?.content?.content || '').trim();
  }

  function noteSinglePdfAttachment(noteId) {
    const atts = NotesStore.listAttachments(noteId);
    if (atts.length !== 1) return null;
    const att = atts[0];
    return attachmentKind(att) === 'pdf' ? att : null;
  }

  function pdfAttachmentReadyForAutoOpen(att) {
    if (!att?.content) return false;
    // Prefer in-memory ciphertext. Light-vault rows that only mark
    // file_enc_stored are still downloading — stay in edit until reopen.
    if (att.content.file_enc || att.content.data_b64) return true;
    if (att.content.file_enc_stored && NotesStore.lightVaultEnabled?.()) return false;
    return !NotesStore.lightVaultEnabled?.();
  }

  function shouldAutoOpenPdfOnlyNote(noteId) {
    // Opt-out: missing/undefined (older localStorage) stays on.
    if (prefs.autoOpenPdfOnly === false) return false;
    if (!noteId || pdfOnlyAutoOpenSuppressedIds.has(noteId)) return false;
    const note = NotesStore.get(noteId);
    if (!note || !noteBodyIsBlank(note)) return false;
    const att = noteSinglePdfAttachment(noteId);
    if (!att) return false;
    if (heavyPreviewDeferred(att.uuid)) return false;
    if (!pdfAttachmentReadyForAutoOpen(att)) return false;
    return true;
  }

  function initialEditorMode(noteId) {
    const note = NotesStore.get(noteId);
    if (!note) return 'edit';
    if (noteSpreadsheetSource(note)) return 'preview';
    // Empty single-PDF notes: inline #doc-inline preview (not full-screen gallery).
    if (shouldAutoOpenPdfOnlyNote(noteId)) return 'preview';
    if (noteHasVisualDocs(noteId) || noteHasDocs(noteId)) {
      return prefs.autoPreview ? 'preview' : 'edit';
    }
    const type = note.content.editor || 'plain';
    if (isChecklistEditor(type)) return 'edit';
    if (note.content.prevent_edit) return 'preview';
    if (type === 'markdown' && prefs.autoPreview) return 'preview';
    return 'edit';
  }

  let renderNotesFrame = 0;
  let lastNotesRenderKey = '';
  let lastListContextKey = '';
  let networkReachable = typeof navigator === 'undefined' || navigator.onLine !== false;
  let networkProbeTimer = null;
  let onlineRecoveryTimer = null;

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
    const kind = attachmentKind(att);
    const visual = kind === 'image' || kind === 'pdf';
    // Photos and PDFs paint immediately. List rows used to wait for an
    // intersection callback, which left a grey tile when the row was already
    // on screen. The decode queue stays serial.
    if (!thumbObserver || visual) {
      hydrateThumb(noteId, attId, stage, { forList });
      return;
    }
    stage.dataset.lazyThumb = attId;
    stage.dataset.noteId = noteId;
    if (forList) stage.dataset.listThumb = '1';
    thumbObserver.observe(stage);
    if (visual) {
      requestAnimationFrame(() => {
        if (!stage.isConnected) return;
        const rect = stage.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        if (rect.height > 1 && rect.bottom > -40 && rect.top < vh + 40) {
          thumbObserver.unobserve(stage);
          hydrateThumb(noteId, attId, stage, { forList });
        }
      });
    }
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
      onScroll: () => {
        if (stage._docZoomKind === 'pdf' && NotesPreview.schedulePdfViewportTiles) {
          NotesPreview.schedulePdfViewportTiles(stage);
        }
      },
      onDoubleTap: () => {
        clearTimeout(docChromeTapTimer);
        docChromeTapTimer = null;
      },
    });
    if (stage._previewResize) stage._previewResize.disconnect();
    if (typeof ResizeObserver === 'function') {
      let lastWidth = stage.clientWidth || 0;
      stage._previewResize = new ResizeObserver(() => {
        const width = stage.clientWidth || 0;
        if (!width || Math.abs(width - lastWidth) < 48) return;
        lastWidth = width;
        if (stage._docZoomKind === 'pdf') {
          NotesPreview.upgradePdfQuality(stage, stage._docZoom?.getScale?.() || 1).catch(() => {});
        }
      });
      stage._previewResize.observe(stage);
    }
    updateDocZoomLabel();
    applyDocViewEnhance();
  }

  const docViewEnhance = { contrast: 1, sharpen: false, whiteBorders: false };
  const docEnhanceOriginals = new WeakMap();

  function docEnhanceLayer() {
    return ui.docStage?.querySelector('.doc-zoom-layer') || ui.docStage;
  }

  function syncDocEnhanceControls() {
    const contrast = document.getElementById('doc-contrast');
    const value = document.getElementById('doc-contrast-value');
    const percent = Math.round(docViewEnhance.contrast * 100);
    if (contrast) {
      contrast.value = String(percent);
      contrast.setAttribute('aria-valuenow', String(percent));
    }
    if (value) value.textContent = `${percent}%`;
    document.getElementById('doc-sharpen')?.setAttribute('aria-pressed', docViewEnhance.sharpen ? 'true' : 'false');
    document.getElementById('doc-white-borders')?.setAttribute('aria-pressed', docViewEnhance.whiteBorders ? 'true' : 'false');
  }

  function applyDocViewFilters() {
    const layer = docEnhanceLayer();
    if (!layer?.style) return;
    const parts = [];
    if (Math.abs(docViewEnhance.contrast - 1) > 0.01) parts.push(`contrast(${docViewEnhance.contrast})`);
    if (docViewEnhance.sharpen) parts.push('url(#doc-sharpen-filter)');
    layer.style.filter = parts.join(' ');
  }

  function releaseDocEnhanceObjects(root) {
    root?.querySelectorAll?.('img[data-doc-enhance-url]').forEach((img) => {
      try { URL.revokeObjectURL(img.dataset.docEnhanceUrl); } catch (err) { /* ignore */ }
    });
  }

  function restoreDocMedia(el) {
    if (!el) return;
    if (el.tagName === 'CANVAS') {
      const backup = docEnhanceOriginals.get(el);
      if (backup && el.width && el.height && backup.length === el.width * el.height * 4) {
        const ctx = el.getContext('2d');
        if (ctx) {
          const image = ctx.createImageData(el.width, el.height);
          image.data.set(backup);
          ctx.putImageData(image, 0, 0);
        }
      }
      docEnhanceOriginals.delete(el);
    } else if (el.tagName === 'IMG') {
      if (el.dataset.docOriginalSrc) el.src = el.dataset.docOriginalSrc;
      if (el.dataset.docEnhanceUrl) {
        try { URL.revokeObjectURL(el.dataset.docEnhanceUrl); } catch (err) { /* ignore */ }
        delete el.dataset.docEnhanceUrl;
      }
      delete el.dataset.docOriginalSrc;
    }
    delete el.dataset.docWhitened;
  }

  function whitenDocCanvas(canvas) {
    if (!canvas || canvas.dataset.docWhitened === '1' || canvas.classList.contains('doc-hit-canvas')) return;
    const ctx = canvas.getContext('2d') || canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width < 8 || canvas.height < 8) return;
    let full;
    try {
      full = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      return;
    }
    const backup = new Uint8ClampedArray(full.data);
    let changed = false;
    if (canvas.width * canvas.height <= 3500000) {
      changed = NotesPreview.whitenDocumentBorders(full);
      if (changed) ctx.putImageData(full, 0, 0);
    } else {
      changed = whitenLargeDocCanvas(canvas, ctx, full);
    }
    if (changed) docEnhanceOriginals.set(canvas, backup);
    canvas.dataset.docWhitened = '1';
  }

  function whitenLargeDocCanvas(canvas, ctx, full) {
    const maxEdge = 1000;
    const scale = maxEdge / Math.max(canvas.width, canvas.height);
    const w = Math.max(8, Math.round(canvas.width * scale));
    const h = Math.max(8, Math.round(canvas.height * scale));
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const smallCtx = small.getContext('2d');
    if (!smallCtx) return false;
    smallCtx.drawImage(canvas, 0, 0, w, h);
    const data = smallCtx.getImageData(0, 0, w, h);
    const before = new Uint8ClampedArray(data.data);
    if (!NotesPreview.whitenDocumentBorders(data)) return false;
    const src = full.data;
    for (let y = 0; y < canvas.height; y += 1) {
      const sy = Math.min(h - 1, Math.floor(y * h / canvas.height));
      for (let x = 0; x < canvas.width; x += 1) {
        const sx = Math.min(w - 1, Math.floor(x * w / canvas.width));
        const sample = (sy * w + sx) * 4;
        if (before[sample] === data.data[sample] && before[sample + 1] === data.data[sample + 1]) continue;
        const offset = (y * canvas.width + x) * 4;
        src[offset] = 255;
        src[offset + 1] = 255;
        src[offset + 2] = 255;
      }
    }
    ctx.putImageData(full, 0, 0);
    return true;
  }

  function whitenDocImage(img) {
    if (!img || img.dataset.docWhitened === '1') return;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
      img.addEventListener('load', () => {
        if (docViewEnhance.whiteBorders) whitenDocImage(img);
      }, { once: true });
      return;
    }
    if (!img.dataset.docOriginalSrc) img.dataset.docOriginalSrc = img.currentSrc || img.src;
    const maxEdge = 1800;
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
    let pixels;
    try {
      pixels = ctx.getImageData(0, 0, w, h);
    } catch (err) {
      return;
    }
    const changed = NotesPreview.whitenDocumentBorders(pixels);
    img.dataset.docWhitened = '1';
    if (!changed) return;
    ctx.putImageData(pixels, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob || !docViewEnhance.whiteBorders || !img.isConnected) return;
      if (img.dataset.docEnhanceUrl) {
        try { URL.revokeObjectURL(img.dataset.docEnhanceUrl); } catch (err) { /* ignore */ }
      }
      const url = URL.createObjectURL(blob);
      img.dataset.docEnhanceUrl = url;
      img.src = url;
    }, 'image/jpeg', 0.92);
  }

  function applyDocWhiteBorders() {
    const stage = ui.docStage;
    if (!stage) return;
    const media = [...stage.querySelectorAll('canvas, img')].filter((el) => (
      !el.classList.contains('doc-hit-canvas') && !el.classList.contains('doc-page-tile')
    ));
    media.forEach((el) => {
      if (docViewEnhance.whiteBorders) {
        if (el.tagName === 'CANVAS') whitenDocCanvas(el);
        else whitenDocImage(el);
      } else if (el.dataset.docWhitened === '1' || el.dataset.docOriginalSrc) {
        restoreDocMedia(el);
      }
    });
  }

  function applyDocViewEnhance() {
    syncDocEnhanceControls();
    applyDocViewFilters();
    applyDocWhiteBorders();
  }

  function setDocEnhance(next) {
    Object.assign(docViewEnhance, next);
    applyDocViewEnhance();
  }

  function maybeUpgradePreviewQuality() {
    const stage = ui.docStage;
    if (!stage?._docZoom) return;
    const kind = stage._docZoomKind;
    const scale = stage._docZoom.getScale();
    // PDF re-renders at the zoomed CSS size × dpr after the new canvas is ready,
    // so the page on screen is not cleared first. Images stay the decrypted original.
    const work = kind === 'pdf'
      ? NotesPreview.upgradePdfQuality(stage, scale)
      : kind === 'image'
        ? NotesPreview.upgradeImageQuality(stage, scale)
        : Promise.resolve(false);
    Promise.resolve(work).then(() => stage._docZoom?.refresh?.()).catch(() => {});
  }

  function readingTime(text) {
    return NotesSearch.readingStats(text);
  }

  function noteReadableText(note) {
    return String(note?.content?.content || '').trim();
  }

  function scannedTextWordCount(note) {
    if (!note?.uuid || note.content?.locked) return 0;
    const text = NotesStore.listAttachments(note.uuid)
      .map((item) => String(item.content?.ocr_text || '').trim())
      .filter(Boolean)
      .join('\n');
    return readingTime(text).words;
  }

  function logLockReason(reason, detail = {}) {
    try {
      console.info('[notes-lock] reason', reason, {
        ...detail,
        visibility: typeof document !== 'undefined' ? document.visibilityState : '',
        unlocked: !!(typeof document !== 'undefined' && document.body?.classList?.contains('unlocked')),
        keyVerified: !!(typeof NotesStore !== 'undefined' && NotesStore.state?.keyVerified),
        lockOnUnfocus: lockOnUnfocusMode(),
        autoLockMin: Number(prefs.autoLockMin) || 0,
        unfocusedAt: readUnfocusedAt() || 0,
        build: document.querySelector?.('meta[name="notes-build"]')?.content || '',
      });
    } catch (err) { /* ignore */ }
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
      lockVault('Locked after idle.', { reason: `idle-${minutes}min` });
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
    const awayMs = readUnfocusedAt() ? (Date.now() - readUnfocusedAt()) : 0;
    Promise.resolve(lockVault(message, {
      reason: lockOnUnfocusMode() === 'immediate' ? 'unfocus-immediate' : 'unfocus-1min',
      detail: { awayMs, visibility: document.visibilityState },
    })).finally(() => {
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
      if (isLoginRequiredError(err)) {
        showExpiredSessionBanner();
        return false;
      }
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
    if (sessionExpiredHold) return;
    if (NotesStore.isUnlocked()) {
      syncNow({ quiet: true, force: true }).catch(() => {});
      return;
    }
    syncWhileVaultLocked({ quiet: true, force: true }).catch(() => {});
  }

  function kickBackgroundSync() {
    if (sessionExpiredHold) return;
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

  let settingsKeySaveDepth = 0;

  function isTransientUnfocus() {
    const VL = window.NotesVaultLock;
    const scanEl = document.getElementById('scan-dialog');
    const scanOpen = document.body.classList.contains('scan-dialog-open')
      || !!(scanEl && !scanEl.hidden);
    const updating = document.body.classList.contains('app-updating');
    const settingsKeySave = settingsKeySaveDepth > 0;
    if (VL?.isTransientUnfocus) {
      return VL.isTransientUnfocus({
        scanOpen,
        pickerOpen: notesPickerDepth > 0 || settingsKeySave,
        updating,
      });
    }
    return scanOpen || notesPickerDepth > 0 || settingsKeySave || updating;
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

  async function lockVault(message, { skipSync = false, reason = '', detail = null } = {}) {
    if (unlockInFlight) {
      setTimeout(() => {
        lockVault(message, { skipSync, reason, detail }).catch(() => {});
      }, 400);
      return;
    }
    const updating = window.NotesVaultLock?.isAppUpdating
      ? NotesVaultLock.isAppUpdating(document.body, window.__notesUpdateInFlight)
      : !!(document.body.classList.contains('app-updating') || window.__notesUpdateInFlight);
    if (window.NotesVaultLock?.mayLockVault && !NotesVaultLock.mayLockVault({ updating })) return;
    // Round 72: never leave empty-device reachability probes running after lock.
    stopEmptyDeviceBackgroundRetry();
    setEmptyDeviceUnlockUi('clear');
    const lockReason = reason
      || (message === 'Vault locked.' ? 'manual'
        : (/^Locked after idle/.test(String(message || '')) ? 'idle'
          : (/^Locked after 1 minute away/.test(String(message || '')) ? 'unfocus-1min'
            : (String(message || '').includes('changed on another device') ? 'password-changed-remote'
              : (message ? 'message' : 'unspecified')))));
    logLockReason(lockReason, {
      message: String(message || ''),
      skipSync: !!skipSync,
      ...(detail && typeof detail === 'object' ? detail : {}),
    });
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
    prefs.googleOauthClientId = '';
    prefs.dropboxAppKey = '';
    prefs.dropboxRefreshToken = '';
    prefs.dropboxAccessToken = '';
    prefs.dropboxTokenExpiresAt = 0;
    prefs.dropboxConnected = false;
    try { window.NotesCloudBackup?.clearPlaintextDropboxTokensFromLocal?.(); } catch (err) { /* ignore */ }
    globalPrefsAppliedAt = 0;
    globalPrefsHydrated = false;
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
    closeSecureSendPanel(true);
    stopTotpClock();
    const cached = NotesStore.cachedAccount?.() || {};
    showUnlock(cached.email || undefined);
    clearUnlockPasswordField({ force: true });
    if (message) {
      const neutralLock = message === 'Vault locked.' || /^Locked after\b/.test(message);
      if (unlockError) {
        unlockError.textContent = message;
        unlockError.hidden = false;
        unlockError.classList.toggle('error', !neutralLock);
        unlockError.classList.toggle('unlock-notice', neutralLock);
      }
      toast(message, !neutralLock);
    }
  }

  function rememberOpen(id) {
    if (id) sessionStorage.setItem('notes_open_id', id);
    else sessionStorage.removeItem('notes_open_id');
  }

  function dialogBlocksToastFooter() {
    const open = (id) => {
      const el = document.getElementById(id);
      return !!(el && !el.hidden);
    };
    return open('tag-manage-dialog')
      || open('confirm-dialog')
      || open('account-info-dialog')
      || open('folder-prompt')
      || open('totp-add-dialog')
      || open('scan-dialog');
  }

  function syncToastDialogLift() {
    const el = document.getElementById('toast');
    const lift = !!(el && !el.hidden && dialogBlocksToastFooter());
    document.documentElement.classList.toggle('toast-above-dialog', lift);
  }

  function toastWithUndo(message, onUndo) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.classList.remove('error');
    el.replaceChildren();
    const label = document.createElement('span');
    label.textContent = message;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'btn ghost sm toast-undo';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => {
      el.hidden = true;
      syncToastDialogLift();
      if (typeof onUndo === 'function') onUndo();
    });
    el.append(label, undo);
    el.hidden = false;
    syncToastDialogLift();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
      syncToastDialogLift();
    }, 6000);
  }

  function toast(message, isError = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    const on2fa = currentAppTab() === '2fa';
    const syncStatus = window.NotesVaultLock?.isBackgroundSyncToast?.(message);
    if (on2fa && syncStatus) {
      el.hidden = true;
      el.textContent = '';
      document.documentElement.classList.remove('totp-toast-open');
      syncToastDialogLift();
      return;
    }
    const locked = document.body.classList.contains('locked') || isUnlockScreenVisible();
    const VL = window.NotesVaultLock;
    const allow = VL?.shouldShowLockScreenToast
      ? VL.shouldShowLockScreenToast({ locked, isError, message })
      : (!locked || !!isError);
    if (!allow) {
      if (!isError || VL?.isBackgroundSyncToast?.(message)) {
        el.hidden = true;
        el.textContent = '';
        document.documentElement.classList.remove('totp-toast-open');
        syncToastDialogLift();
      }
      return;
    }
    el.replaceChildren();
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    document.documentElement.classList.toggle('totp-toast-open', on2fa);
    syncToastDialogLift();
    clearTimeout(toastTimer);
    const linger = message === 'New note' ? 1400 : 3200;
    toastTimer = setTimeout(() => {
      el.hidden = true;
      document.documentElement.classList.remove('totp-toast-open');
      syncToastDialogLift();
    }, linger);
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
  let totpEditingId = '';
  let totpDialogTrigger = null;
  let totpClock = 0;
  let totpQrTimer = 0;
  let totpQrStream = null;
  let totpRenderToken = 0;

  function normalizeAppTab(name) {
    if (name === 'files') return 'notes';
    if (name === '2fa') return name;
    return 'notes';
  }

  function currentAppTab() {
    return normalizeAppTab(appTab);
  }

  function syncAppTabButtons(tab) {
    const shown = normalizeAppTab(tab);
    document.querySelectorAll('.app-tab').forEach((btn) => {
      const on = btn.dataset.appTab === shown;
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
    if (appTab === '2fa') {
      const toastEl = document.getElementById('toast');
      if (toastEl && window.NotesVaultLock?.isBackgroundSyncToast?.(toastEl.textContent)) {
        toastEl.hidden = true;
        toastEl.textContent = '';
        document.documentElement.classList.remove('totp-toast-open');
      } else if (toastEl && !toastEl.hidden) {
        document.documentElement.classList.add('totp-toast-open');
      }
    } else {
      document.documentElement.classList.remove('totp-toast-open');
    }
    if (persist) {
      try { sessionStorage.setItem('notes_app_tab', appTab); } catch (err) { /* ignore */ }
    }
    if (appTab === '2fa') {
      resetNoteTransientChrome();
      closeDocPreview();
      refreshTotpVault({ migrate: true });
      startTotpClock();
    } else {
      stopTotpClock();
      if (appTab === 'files') {
        resetNoteTransientChrome();
        closeDocPreview();
        if (currentId && NotesStore.get(currentId)) updateActionButtons(NotesStore.get(currentId));
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
      return true;
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
        // Re-read only after a resync actually ran. The resolved-null path
        // (already resynced this session) used to schedule this same
        // function again from a microtask, which never yielded to the page.
        ensureTotpAccountsFromServer().then((resynced) => {
          if (resynced) refreshTotpVault({ migrate: true });
        });
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
    const token = ++totpRenderToken;
    const rows = filteredTotpEntries();
    if (!rows.length) {
      if (token !== totpRenderToken) return;
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
    if (token !== totpRenderToken) return;
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
        <button type="button" class="totp-item-edit" data-totp-edit aria-label="Edit ${escapeAttr(label)}">Edit</button>
        <button type="button" class="totp-item-server-copy" data-server-copy="${escapeAttr(item.uuid)}" aria-label="View server copy for ${escapeAttr(label)}">Server copy</button>
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
    totpEntries = totpEntries.filter((entry) => entry.id !== id);
    toast('Removed account');
    if (totpUi.meta) {
      totpUi.meta.textContent = totpEntries.length
        ? `${totpEntries.length} account${totpEntries.length === 1 ? '' : 's'} in the vault`
        : 'Add an account with a QR code or secret';
    }
    await renderTotpList();
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

  function syncTotpDialogMode() {
    const editing = !!totpEditingId;
    const title = document.getElementById('totp-add-title');
    const save = document.getElementById('totp-add-save');
    const secret = totpUi.secret;
    if (title) title.textContent = editing ? 'Edit 2FA account' : 'Add 2FA account';
    if (save) save.textContent = editing ? 'Save' : 'Add';
    if (secret) {
      secret.readOnly = editing;
      secret.required = !editing;
      secret.placeholder = editing
        ? 'Secret stays in the vault'
        : 'JBSW Y3DP EHPK 3PXP';
      if (editing) secret.value = '';
    }
    document.querySelectorAll('#totp-add-dialog .scan-add-actions, #totp-add-dialog .scan-dialog-lead').forEach((el) => {
      el.hidden = editing;
    });
  }

  function hideTotpAddDialog() {
    const returnTo = totpEditingId ? totpDialogTrigger : totpUi.add;
    stopTotpQrScan();
    totpEditingId = '';
    if (totpUi.dialog) totpUi.dialog.hidden = true;
    if (totpUi.backdrop) totpUi.backdrop.hidden = true;
    document.body.classList.remove('scan-dialog-open');
    if (totpUi.issuer) totpUi.issuer.value = '';
    if (totpUi.account) totpUi.account.value = '';
    if (totpUi.secret) {
      totpUi.secret.value = '';
      totpUi.secret.readOnly = false;
    }
    syncTotpDialogMode();
    setTotpAddError('');
    totpDialogTrigger = null;
    const focusReturn = () => {
      const target = (returnTo && document.contains(returnTo)) ? returnTo : totpUi.add;
      if (target && document.contains(target)) target.focus();
    };
    focusReturn();
    requestAnimationFrame(focusReturn);
  }

  function showTotpAddDialog() {
    totpEditingId = '';
    totpDialogTrigger = totpUi.add;
    closeSettings(true);
    hideScanDialog();
    if (totpUi.issuer) totpUi.issuer.value = '';
    if (totpUi.account) totpUi.account.value = '';
    if (totpUi.secret) totpUi.secret.value = '';
    syncTotpDialogMode();
    setTotpAddError('');
    if (totpUi.backdrop) totpUi.backdrop.hidden = false;
    if (totpUi.dialog) totpUi.dialog.hidden = false;
    document.body.classList.add('scan-dialog-open');
    totpUi.issuer?.focus();
  }

  function showTotpEditDialog(id) {
    const item = totpEntries.find((entry) => entry.id === id);
    if (!item) return;
    totpEditingId = id;
    totpDialogTrigger = document.querySelector(`[data-totp-id="${CSS.escape(id)}"] [data-totp-edit]`);
    closeSettings(true);
    hideScanDialog();
    if (totpUi.issuer) totpUi.issuer.value = item.issuer || '';
    if (totpUi.account) totpUi.account.value = item.account || '';
    syncTotpDialogMode();
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
      openHiddenFileInput(totpUi.qrInput);
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
      openHiddenFileInput(totpUi.qrInput);
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
    if (totpEditingId) {
      const issuer = String(totpUi.issuer?.value || '').trim();
      const account = String(totpUi.account?.value || '').trim();
      if (!issuer && !account) {
        setTotpAddError('Enter an issuer or account name.');
        totpUi.issuer?.focus();
        return;
      }
      const saved = NotesStore.updateTotpAccount(totpEditingId, { issuer, account });
      if (!saved) {
        setTotpAddError('That account is no longer in the vault.');
        return;
      }
      hideTotpAddDialog();
      refreshTotpVault();
      toast('Account updated');
      return;
    }
    const entry = NotesTotp.entryFromFields({
      issuer: totpUi.issuer?.value || '',
      account: totpUi.account?.value || '',
      secret: totpUi.secret?.value || '',
    });
    if (!entry) {
      setTotpAddError('Enter a valid authenticator secret or otpauth URL. Use Base32 letters A–Z and digits 2–7. Spaces are OK.');
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
      titleEl.id = 'confirm-title';
      titleEl.textContent = title;
      titleEl.removeAttribute('aria-hidden');
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      messageEl.textContent = message;
      okBtn.textContent = okLabel;
      okBtn.classList.remove('danger');
      cancelBtn.hidden = true;
      const extraBtn = document.getElementById('confirm-extra');
      if (extraBtn) extraBtn.hidden = true;
      backdrop.hidden = false;
      dialog.hidden = false;
      const cleanup = () => {
        backdrop.hidden = true;
        dialog.hidden = true;
        cancelBtn.hidden = false;
        if (extraBtn) extraBtn.hidden = true;
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
      confirmLabel: info.noteId ? 'Open note' : 'OK',
      extraLabel: 'Attach anyway',
      cancelLabel: 'Cancel',
    }).then((choice) => {
      if (choice === 'extra') return 'keep';
      if (choice === true && info.noteId) {
        if (info.trashed) setFilter('trash');
        else if (info.archived) setFilter('archived');
        else setFilter('all');
        renderNotes();
        openNote(info.noteId);
        return 'open';
      }
      return 'cancel';
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
    // Prefer the full in-memory account (quota/usage) over the slim salt cache.
    const full = (NotesStore.state?.account && NotesStore.state.account.email)
      ? { ...NotesStore.state.account, ...account }
      : account;
    const plan = String(full.plan || 'pro').toLowerCase();
    const label = full.plan_label || (plan === 'pro' ? 'Pro' : 'Basic');
    setAccountInfoRow('account-info-email', full.email || '—');
    setAccountInfoRow('account-info-plan', label);
    const { usedText, quotaText } = accountStorageParts(full);
    setAccountInfoRow('account-info-storage', `${usedText} of ${quotaText}`);
    setAccountInfoRow('account-info-2fa', full.totp_enabled ? 'Enabled' : 'Off');
    setAccountInfoRow('account-info-passkeys', full.webauthn_enabled ? 'Registered' : 'None');
    if (NotesStore.isUnlocked()) {
      setAccountInfoRow('account-info-notes', String(vaultActiveNoteCount()));
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
    extraLabel = '',
    danger = false,
  } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById('confirm-backdrop');
      const dialog = document.getElementById('confirm-dialog');
      const titleEl = document.getElementById('confirm-title');
      const messageEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok');
      const cancelBtn = document.getElementById('confirm-cancel');
      const extraBtn = document.getElementById('confirm-extra');
      if (!backdrop || !dialog || !titleEl || !messageEl || !okBtn || !cancelBtn) {
        resolve(window.confirm(String(message || title)));
        return;
      }
      cancelBtn.hidden = false;
      if (extraBtn) {
        extraBtn.hidden = !extraLabel;
        extraBtn.textContent = extraLabel || 'Attach anyway';
      }
      titleEl.id = 'confirm-title';
      titleEl.textContent = title;
      titleEl.removeAttribute('aria-hidden');
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      messageEl.textContent = message;
      okBtn.textContent = confirmLabel;
      cancelBtn.textContent = cancelLabel;
      okBtn.classList.toggle('danger', !!danger);
      backdrop.hidden = false;
      dialog.hidden = false;
      const unlockVisible = !!(document.getElementById('unlock-screen') && !document.getElementById('unlock-screen').hidden);
      document.body.classList.add('confirm-open');
      document.body.classList.toggle('confirm-over-unlock', unlockVisible);
      dialog.setAttribute('tabindex', '-1');
      const cleanup = (value) => {
        backdrop.hidden = true;
        dialog.hidden = true;
        document.body.classList.remove('confirm-open', 'confirm-over-unlock');
        if (extraBtn) {
          extraBtn.hidden = true;
          extraBtn.removeEventListener('click', onExtra);
        }
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onExtra = () => cleanup('extra');
      const onKey = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (extraBtn && extraLabel) extraBtn.addEventListener('click', onExtra);
      backdrop.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, true);
      window.setTimeout(() => {
        if (!dialog.hidden) cancelBtn.focus();
      }, 0);
    });
  }

  NotesStore.setCsrf(ui.csrf || NotesStore.csrf());
  window.notesNetworkReachable = () => networkReachable;
  NotesStore.setSaveStatusCallback((text, isError) => {
    const raw = String(text || '');
    const sessionGone = /login required|sign in required/i.test(raw);
    ui.saveStatus.textContent = sessionGone ? 'Not synced — sign in again' : raw;
    ui.saveStatus.classList.toggle('error', !!isError && !sessionGone);
  });
  function isPhoneShell() {
    return compactLayoutActive();
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
    const raw = phase || 'idle';
    const dirty = NotesStore.state?.dirty?.size || 0;
    if (dirty > 0 && raw !== 'syncing' && raw !== 'offline' && raw !== 'error' && raw !== 'session-expired') {
      return 'pending';
    }
    const last = Number(NotesStore.state.lastSync) || 0;
    if ((raw === 'idle' || !raw) && last > 0) return 'ok';
    return raw;
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
      const banner = document.getElementById('sync-status-banner');
      const bannerDownloading = banner && !banner.hidden && banner.dataset.mode === 'downloading';
      const parsed = NotesVaultSyncProgress.parseVaultSyncProgressMessage(message);
      const progressPct = parsed.pct ?? (pctMatch ? pct : null);
      if (bannerDownloading || vaultPullActive) {
        const fallback = document.getElementById('sync-status-text')?.textContent || 'Downloading notes…';
        const labelText = NotesVaultSyncProgress.syncBannerProgressText(message, fallback);
        setSyncBannerProgress({
          text: labelText,
          pct: progressPct,
          indeterminate: progressPct == null,
          visible: true,
        });
      }
      if (isPhoneShell()) {
        meta.textContent = when ? `Synced ${when}` : '';
      } else {
        const displayMessage = /Downloading/i.test(String(message || ''))
          ? NotesVaultSyncProgress.syncBannerProgressText(message, 'Downloading…')
          : (message || (pctMatch ? `Downloading… ${pct}%` : 'Syncing…'));
        meta.textContent = displayMessage;
      }
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
      meta.textContent = sessionExpiredHold
        ? 'Not syncing — sign in again'
        : (when ? `Waiting · last ${when}` : 'Waiting to sync');
      return;
    }
    if (phase === 'ok') endVaultPull();
    meta.textContent = when ? `Synced ${when}` : 'Not synced yet';
  }

  function setSyncIndicator({ state, message } = {}) {
    if (state === 'session-expired') {
      showExpiredSessionBanner();
      return;
    }
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
    const captions = {
      idle: 'Sync',
      syncing: 'Syncing',
      ok: 'Synced',
      pending: 'Waiting',
      offline: 'Offline',
      error: 'Failed',
    };
    const caption = document.getElementById('sync-caption');
    if (caption) caption.textContent = captions[phase] || 'Sync';
    if (phase === 'offline' && ui.saveStatus) {
      const cur = ui.saveStatus.textContent || '';
      if (!/will sync when online|Not synced|sign in again/i.test(cur)) {
        ui.saveStatus.textContent = 'Saved on this device · will sync when online';
        ui.saveStatus.classList.remove('error');
      }
    }
    if (phase === 'ok' && ui.saveStatus && !(NotesStore.state?.dirty?.size)
      && /will sync when online/.test(ui.saveStatus.textContent || '')) {
      ui.saveStatus.textContent = 'Saved';
      ui.saveStatus.classList.remove('error');
    }
    refreshSyncMeta({ state: phase, message });
  }
  NotesStore.setSyncStatusCallback(setSyncIndicator);
  NotesStore.emitSync('idle');
  let vaultPullActive = false;
  let vaultPullExpected = 0;
  let vaultPullRenderTimer = 0;
  let deferredOpenNoteId = null;
  let vaultDownloadStalled = false;
  let vaultDownloadTimer = 0;
  const UNLOCK_DOWNLOAD_TIMEOUT_MS = 20000;
  // Routine "Checking for changes…" stays header-only. Show a compact overlay
  // only after a real download has been running longer than this delay.
  const SYNC_PROGRESS_BANNER_DELAY_MS = 2000;
  let syncProgressBannerTimer = 0;
  let syncProgressBannerPending = null;
  let syncProgressStartedAt = 0;

  function cancelDelayedSyncProgressBanner() {
    clearTimeout(syncProgressBannerTimer);
    syncProgressBannerTimer = 0;
    syncProgressBannerPending = null;
  }

  function resetSyncProgressBannerState() {
    cancelDelayedSyncProgressBanner();
    syncProgressStartedAt = 0;
  }

  function revealSyncProgressBanner(text, message) {
    const label = text || 'Downloading notes…';
    showSyncBanner('downloading', label, { message: message || label });
  }

  function flushDelayedSyncProgressBanner() {
    if (!syncProgressBannerPending) return;
    if (!syncInFlight && !vaultPullActive) {
      resetSyncProgressBannerState();
      return;
    }
    const pending = syncProgressBannerPending;
    syncProgressBannerPending = null;
    clearTimeout(syncProgressBannerTimer);
    syncProgressBannerTimer = 0;
    revealSyncProgressBanner(pending.text, pending.message);
  }

  function armDelayedSyncProgressBanner({ text, message } = {}) {
    if (!syncProgressStartedAt) syncProgressStartedAt = Date.now();
    syncProgressBannerPending = {
      text: text || 'Downloading notes…',
      message: message || text || 'Downloading notes…',
    };
    const elapsed = Date.now() - syncProgressStartedAt;
    const wait = Math.max(0, SYNC_PROGRESS_BANNER_DELAY_MS - elapsed);
    if (syncProgressBannerTimer) return;
    if (wait === 0) {
      flushDelayedSyncProgressBanner();
      return;
    }
    syncProgressBannerTimer = setTimeout(() => {
      syncProgressBannerTimer = 0;
      flushDelayedSyncProgressBanner();
    }, wait);
  }

  function setSyncBannerProgress({ text, pct = null, indeterminate = false, visible = true } = {}) {
    const wrap = document.getElementById('sync-status-progress');
    const track = document.getElementById('sync-status-progress-track');
    const bar = document.getElementById('sync-status-progress-bar');
    const label = document.getElementById('sync-status-text');
    if (label && text) label.textContent = text;
    if (!wrap || !bar) return;
    if (!visible) {
      wrap.hidden = true;
      bar.style.width = '0%';
      bar.classList.remove('is-indeterminate');
      if (track) track.removeAttribute('aria-valuenow');
      return;
    }
    wrap.hidden = false;
    if (indeterminate || pct == null) {
      bar.classList.add('is-indeterminate');
      bar.style.width = '';
      if (track) track.removeAttribute('aria-valuenow');
      return;
    }
    bar.classList.remove('is-indeterminate');
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = `${clamped > 0 ? Math.max(2, clamped) : 0}%`;
    if (track) track.setAttribute('aria-valuenow', String(clamped));
  }

  let fileDownloadTaskActive = false;
  let fileDownloadCompleteTimer = 0;
  let fileDownloadFocusRestore = null;
  let fileDownloadKeydownHandler = null;
  const FILE_DOWNLOAD_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function fileDownloadFocusableNodes(root) {
    if (!root) return [];
    return [...root.querySelectorAll(FILE_DOWNLOAD_FOCUSABLE)].filter((node) => {
      if (node.hasAttribute('disabled') || node.getAttribute('aria-hidden') === 'true') return false;
      return node.getClientRects().length > 0;
    });
  }

  function openFileDownloadOverlayA11y(overlay) {
    if (!overlay || overlay.dataset.a11yOpen === '1') return;
    overlay.dataset.a11yOpen = '1';
    fileDownloadFocusRestore = document.activeElement;
    const app = document.getElementById('app');
    if (app) app.inert = true;
    const card = overlay.querySelector('.file-download-progress-card');
    const nodes = fileDownloadFocusableNodes(card);
    (nodes[0] || card)?.focus({ preventScroll: true });
    fileDownloadKeydownHandler = (event) => {
      if (event.key !== 'Tab' || overlay.hidden) return;
      const trapRoot = overlay.querySelector('.file-download-progress-card');
      if (!trapRoot) return;
      const focusables = fileDownloadFocusableNodes(trapRoot);
      if (!focusables.length) {
        event.preventDefault();
        trapRoot.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first || !trapRoot.contains(document.activeElement)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', fileDownloadKeydownHandler, true);
  }

  function closeFileDownloadOverlayA11y(overlay) {
    if (!overlay || overlay.dataset.a11yOpen !== '1') return;
    overlay.dataset.a11yOpen = '0';
    const app = document.getElementById('app');
    if (app) app.inert = false;
    if (fileDownloadKeydownHandler) {
      document.removeEventListener('keydown', fileDownloadKeydownHandler, true);
      fileDownloadKeydownHandler = null;
    }
    const restore = fileDownloadFocusRestore;
    fileDownloadFocusRestore = null;
    if (restore && typeof restore.focus === 'function') {
      try {
        restore.focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  function setFileDownloadProgress({ title, status, pct = null, indeterminate = true, visible = true } = {}) {
    const overlay = document.getElementById('file-download-progress');
    const titleEl = document.getElementById('file-download-progress-title');
    const statusEl = document.getElementById('file-download-progress-status');
    const track = document.getElementById('file-download-progress-track');
    const bar = document.getElementById('file-download-progress-bar');
    if (!overlay || !bar) return;
    if (!visible) {
      overlay.hidden = true;
      overlay.setAttribute('aria-busy', 'false');
      closeFileDownloadOverlayA11y(overlay);
      bar.style.width = '0%';
      bar.classList.remove('is-indeterminate');
      if (track) track.removeAttribute('aria-valuenow');
      return;
    }
    overlay.hidden = false;
    openFileDownloadOverlayA11y(overlay);
    overlay.setAttribute('aria-busy', 'true');
    if (titleEl && title) titleEl.textContent = title;
    if (statusEl) statusEl.textContent = status || 'Preparing…';
    if (indeterminate || pct == null) {
      bar.classList.add('is-indeterminate');
      bar.style.width = '';
      if (track) track.removeAttribute('aria-valuenow');
      return;
    }
    bar.classList.remove('is-indeterminate');
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = `${clamped > 0 ? Math.max(2, clamped) : 0}%`;
    if (track) track.setAttribute('aria-valuenow', String(clamped));
  }

  async function flashFileDownloadComplete() {
    setFileDownloadProgress({ pct: 100, indeterminate: false, status: 'Done' });
    await new Promise((resolve) => {
      clearTimeout(fileDownloadCompleteTimer);
      fileDownloadCompleteTimer = setTimeout(resolve, 320);
    });
    setFileDownloadProgress({ visible: false });
  }

  async function runFileDownloadTask({ title, prepareLabel, run }) {
    if (fileDownloadTaskActive) {
      toast('Download already in progress', true);
      return null;
    }
    fileDownloadTaskActive = true;
    setFileDownloadProgress({
      title: title || 'Downloading…',
      status: prepareLabel || 'Preparing…',
      indeterminate: true,
      visible: true,
    });
    const report = (patch = {}) => {
      setFileDownloadProgress({
        title: patch.title || title || 'Downloading…',
        status: patch.status,
        pct: patch.pct,
        indeterminate: patch.indeterminate ?? (patch.pct == null),
        visible: true,
      });
    };
    try {
      const result = await run(report);
      await flashFileDownloadComplete();
      return result;
    } catch (err) {
      setFileDownloadProgress({ visible: false });
      throw err;
    } finally {
      fileDownloadTaskActive = false;
    }
  }

  function showSyncBanner(mode, text, { message } = {}) {
    const banner = document.getElementById('sync-status-banner');
    const label = document.getElementById('sync-status-text');
    const retry = document.getElementById('sync-status-retry');
    const relock = document.getElementById('sync-status-relock');
    const signin = document.getElementById('sync-status-signin');
    if (!banner) return;
    if ((!mode || mode === 'ready') && sessionExpiredHold) {
      mode = 'session';
      text = 'Not syncing — sign in again';
    }
    if (!mode || mode === 'ready') {
      resetSyncProgressBannerState();
      banner.hidden = true;
      banner.dataset.mode = 'ready';
      if (signin) signin.hidden = true;
      setSyncBannerProgress({ visible: false });
      mirrorEditorSessionBanner(false);
      return;
    }
    if (mode === 'session') {
      resetSyncProgressBannerState();
      banner.hidden = false;
      banner.dataset.mode = 'session';
      if (label) label.textContent = text || 'Not syncing — sign in again';
      if (retry) retry.hidden = true;
      if (relock) relock.hidden = true;
      if (signin) signin.hidden = false;
      setSyncBannerProgress({ visible: false });
      mirrorEditorSessionBanner(true, text || 'Not syncing — sign in again');
      return;
    }
    if (mode === 'error' || mode === 'timeout') {
      resetSyncProgressBannerState();
    }
    mirrorEditorSessionBanner(false);
    banner.hidden = false;
    banner.dataset.mode = mode;
    const labelText = mode === 'downloading'
      ? NotesVaultSyncProgress.syncBannerProgressText(message, text)
      : (text || '');
    if (label) label.textContent = labelText;
    if (mode === 'downloading') {
      const parsed = NotesVaultSyncProgress.parseVaultSyncProgressMessage(message || text);
      setSyncBannerProgress({
        text: labelText,
        pct: parsed.pct,
        indeterminate: parsed.pct == null,
        visible: true,
      });
    } else {
      setSyncBannerProgress({ visible: false });
    }
    const actionable = mode === 'error' || mode === 'timeout';
    if (retry) retry.hidden = !actionable;
    if (relock) relock.hidden = !actionable;
    if (signin) signin.hidden = true;
  }

  function mirrorEditorSessionBanner(show, text) {
    const banner = document.getElementById('editor-sync-banner');
    if (!banner) return;
    const label = document.getElementById('editor-sync-status-text');
    const signin = document.getElementById('editor-sync-status-signin');
    banner.hidden = !show;
    banner.dataset.mode = show ? 'session' : 'ready';
    if (label) label.textContent = show ? (text || 'Not syncing — sign in again') : '';
    if (signin) signin.hidden = !show;
  }

  function clearVaultDownloadTimeout() {
    clearTimeout(vaultDownloadTimer);
    vaultDownloadTimer = 0;
  }

  function releaseVaultPullChrome() {
    if (!vaultPullActive) return;
    vaultPullActive = false;
    vaultPullExpected = 0;
    document.body.classList.remove('vault-pulling');
    clearTimeout(vaultPullRenderTimer);
    vaultPullRenderTimer = 0;
    lastNotesRenderKey = '';
    renderNotes();
    updateEmptyStateVisibility();
  }

  function armVaultDownloadTimeout() {
    if (vaultDownloadTimer) return;
    vaultDownloadTimer = setTimeout(() => {
      vaultDownloadTimer = 0;
      if (!NotesStore.isUnlocked()) return;
      if (!syncInFlight && !vaultPullActive) return;
      vaultDownloadStalled = true;
      releaseVaultPullChrome();
      const ready = NotesStore.listNotes().filter((note) => !note.content?.trashed).length;
      showSyncBanner(
        'timeout',
        ready
          ? `Still downloading. ${ready} note${ready === 1 ? '' : 's'} ready to edit.`
          : 'Download is taking too long.',
      );
      refreshEmptyStateCopy();
      updateEmptyStateVisibility();
    }, UNLOCK_DOWNLOAD_TIMEOUT_MS);
  }

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
    armVaultDownloadTimeout();
    vaultPullActive = true;
    vaultPullExpected = Math.max(vaultPullExpected, Number(expectedTotal) || 0);
    document.body.classList.add('vault-pulling');
    // Compact overlay only after ~2s (or immediately if already past the delay).
    armDelayedSyncProgressBanner({
      text: 'Downloading notes…',
      message: 'Downloading notes…',
    });
    if (ui.empty && NotesStore.listNotes().length > 0) ui.empty.hidden = true;
    lastNotesRenderKey = '';
    scheduleVaultPullRender(true);
  }

  function endVaultPull() {
    if (!vaultPullActive && !vaultDownloadStalled) {
      clearVaultDownloadTimeout();
      showSyncBanner('ready');
    }
    if (!vaultPullActive) return;
    const stalled = vaultDownloadStalled;
    vaultPullActive = false;
    vaultPullExpected = 0;
    document.body.classList.remove('vault-pulling');
    clearVaultDownloadTimeout();
    if (!stalled) {
      setSyncBannerProgress({ pct: 100, indeterminate: false, text: 'Download complete' });
      window.setTimeout(() => {
        if (!vaultPullActive && !vaultDownloadStalled) showSyncBanner('ready');
      }, 280);
    }
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
    page: (meta) => {
      scheduleVaultPullRender(false);
      if (!meta) return;
      const total = Number(meta.expectedTotal) || vaultPullExpected || 0;
      const processed = Number(meta.processed) || 0;
      if (total > 0 && processed >= 0) {
        const pct = Math.max(1, Math.min(99, Math.round((processed / total) * 100)));
        const notes = Number(meta.notes) || 0;
        const progressText = NotesVaultSyncProgress.formatVaultSyncDownloadProgress({
          processed,
          total,
          notes,
        });
        // Keep the delayed overlay armed with live copy; flush if due.
        armDelayedSyncProgressBanner({ text: progressText, message: progressText });
        const banner = document.getElementById('sync-status-banner');
        if (banner && !banner.hidden && banner.dataset.mode === 'downloading') {
          setSyncBannerProgress({
            text: progressText,
            pct,
            indeterminate: false,
            visible: true,
          });
        }
      }
    },
    end: () => endVaultPull(),
  });
  NotesStore.setConflictCopyCallback(({ title }) => {
    toast(`“${title || 'Note'}” was changed on another device too — kept both; see “${title || 'Note'} (conflict copy)”`);
    lastNotesRenderKey = '';
    renderNotes();
  });
  NotesStore.setNoteIngestedCallback((uuid, meta) => {
    // Throttled list paint during vault pull — never call renderNotes() per note on iOS.
    scheduleVaultPullRender();
    if (!uuid || vaultPullActive) return;
    if (uuid === currentId && meta?.bodyChanged) {
      const outcome = reconcileOpenNoteWithStore(uuid);
      if (outcome === 'conflict') flushSave();
      if (outcome !== 'none') {
        lastNotesRenderKey = '';
        renderNotes();
      }
    }
    if (!meta?.protectionMerged) return;
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
    timer: 0,
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
    if (phase === 'kdf' && loginProgress.displayed >= 8) return 'Checking password';
    return (UNLOCK_PHASE_WEIGHT[phase] || UNLOCK_PHASE_WEIGHT.decrypt).label;
  }

  function phaseCeiling(phase) {
    const spec = UNLOCK_PHASE_WEIGHT[phase] || UNLOCK_PHASE_WEIGHT.decrypt;
    return spec.start + spec.size - 1;
  }

  async function yieldToPaint() {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      // Background tabs freeze requestAnimationFrame, which stalled unlock
      // after the vault key had already been derived.
      const hidden = typeof document !== 'undefined' && document.hidden;
      const timer = setTimeout(finish, hidden ? 0 : 48);
      if (!hidden && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timer);
          finish();
        }));
      }
    });
  }

  function loginProgressTracks() {
    return [
      document.querySelector('#login-progress-overlay .login-progress-track'),
      document.getElementById('unlock-progress'),
      document.querySelector('.app-login-progress-track'),
    ].filter(Boolean);
  }

  function renderLoginProgressFrame() {
    const indeterminate = loginProgress.phase === 'kdf';
    const pct = loginProgress.displayed;
    const text = indeterminate
      ? 'Checking password…'
      : `${unlockProgressLabel(loginProgress.phase)}… ${pct}%`;
    const overlay = document.getElementById('login-progress-overlay');
    const overlayStatus = document.getElementById('login-progress-status');
    const overlayBar = document.getElementById('login-progress-bar');
    const overlayTrack = overlay?.querySelector('.login-progress-track');
    if (overlay) overlay.hidden = false;
    if (overlayStatus) overlayStatus.textContent = text;
    if (overlayBar) overlayBar.style.width = indeterminate ? '' : `${Math.max(2, pct)}%`;
    if (overlayTrack) {
      if (indeterminate) overlayTrack.removeAttribute('aria-valuenow');
      else overlayTrack.setAttribute('aria-valuenow', String(pct));
    }
    for (const track of loginProgressTracks()) {
      track.classList.toggle('is-indeterminate', indeterminate);
      if (indeterminate) track.setAttribute('aria-busy', 'true');
      else track.removeAttribute('aria-busy');
    }
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
      if (barEl) barEl.style.width = indeterminate ? '' : `${Math.max(2, pct)}%`;
      if (wrapEl) {
        wrapEl.hidden = false;
        if (indeterminate) wrapEl.removeAttribute('aria-valuenow');
        else wrapEl.setAttribute('aria-valuenow', String(pct));
      }
    }
    if (unlockSubmit && loginProgressActive) {
      // Stay on Checking… for the whole attempt. A percent label (or a
      // mid-flight reset to Unlock) reads as the button flickering.
      unlockSubmit.textContent = 'Checking…';
      unlockSubmit.disabled = true;
      unlockSubmit.setAttribute('aria-busy', 'true');
      unlockSubmit.classList.add('is-checking');
    }
  }

  function ensureLoginProgressAnimation() {
    if (loginProgress.raf || loginProgress.timer) return;
    const step = () => {
      loginProgress.raf = 0;
      loginProgress.timer = 0;
      if (!loginProgressActive) return;
      if (loginProgress.displayed < loginProgress.target) {
        const gap = loginProgress.target - loginProgress.displayed;
        const inc = gap > 24 ? Math.ceil(gap / 5) : Math.max(1, Math.ceil(gap / 2));
        loginProgress.displayed = Math.min(loginProgress.target, loginProgress.displayed + inc);
        renderLoginProgressFrame();
      }
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (hidden) loginProgress.timer = setTimeout(step, 200);
      else loginProgress.raf = requestAnimationFrame(step);
    };
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) loginProgress.timer = setTimeout(step, 200);
    else loginProgress.raf = requestAnimationFrame(step);
  }

  function stopLoginCreep() {
    if (loginProgress.creep) {
      clearInterval(loginProgress.creep);
      loginProgress.creep = 0;
    }
  }

  function startLoginCreep(phase, ceiling) {
    stopLoginCreep();
    const kdf = phase === 'kdf';
    const cap = kdf ? 64 : (ceiling ?? phaseCeiling(phase));
    loginProgress.creep = window.setInterval(() => {
      if (!loginProgressActive) return;
      if (loginProgress.displayed >= cap) return;
      loginProgress.displayed = Math.min(cap, loginProgress.displayed + 1);
      loginProgress.target = Math.max(loginProgress.target, loginProgress.displayed);
      renderLoginProgressFrame();
    }, kdf ? 450 : ((typeof document !== 'undefined' && document.hidden) ? 250 : 100));
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

  window.__notesKdfProgress = () => {
    if (!loginProgressActive || loginProgress.phase !== 'kdf' || loginProgress.creep) return;
    const cap = 64;
    if (loginProgress.displayed >= cap) return;
    const next = loginProgress.displayed + 1;
    loginProgress.displayed = next;
    loginProgress.target = Math.max(loginProgress.target, next);
    renderLoginProgressFrame();
  };

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
    if (loginProgress.timer) {
      clearTimeout(loginProgress.timer);
      loginProgress.timer = 0;
    }
    loginProgressActive = false;
    loginProgressTracks().forEach((track) => {
      track.classList.remove('is-indeterminate');
      track.removeAttribute('aria-busy');
    });
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
      unlockSubmit.removeAttribute('aria-busy');
      unlockSubmit.classList.remove('is-checking');
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
    const title = unlocked ? 'Vault unlocked. Tap to lock.' : 'Vault locked. Tap after you unlock.';
    const label = title;
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

  function clearUnlockPasswordField({ force = false } = {}) {
    if (!unlockPassword) return;
    // Boot may call showUnlock after awaits; do not wipe keystrokes the user
    // already typed on the lock screen while auto-unlock was still running.
    if (!force && String(unlockPassword.value || '')) return;
    unlockPassword.value = '';
  }

  function showUnlock(email) {
    if (NotesStore.isUnlocked()) return;
    if (unlockInFlight || loginProgressActive) return;
    if (suppressUnlockScreen) return;
    syncVaultLockUi(false);
    markVaultShellLocked();
    markRememberedShell(false);
    document.body.classList.add('locked');
    document.body.classList.remove('unlocked');
    unlockScreen.hidden = false;
    appShell.hidden = true;
    appShell.setAttribute('aria-hidden', 'true');
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
    refreshDevicePasswordCache().then(() => refreshClearSavedButton()).catch(() => refreshClearSavedButton());
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
    clearUnlockPasswordField();
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
    appShell.removeAttribute('aria-hidden');
    markVaultShellUnlocked();
    endVaultPull();
    syncVaultLockUi(true);
    scheduleChangePoll();
    closeSettings(true);
    restoreAppTab();
    dismissLoginProgress();
    resetUnlockCardStatus();
    primeUploadPickerStartIn().catch(() => {});
    try {
      if (sessionStorage.getItem('notes_just_registered') === '1') {
        clearEmptyStateDismissed();
        sessionStorage.removeItem('notes_just_registered');
      }
    } catch (err) { /* ignore */ }
    try {
      if (sessionStorage.getItem('notes_verify_email_hint') === '1') {
        sessionStorage.removeItem('notes_verify_email_hint');
        toast('We emailed a verification code. Enter it in Settings → Account when you want backups to use this address.');
      }
    } catch (err) { /* ignore */ }
    updateEmptyStateVisibility();
    requestAnimationFrame(() => {
      if (!paneSplitDragging) applyListPaneWidth(readStoredListWidth(), { persist: false });
    });
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
    if (typeof NotesStore.finishUnlockMaintenance === 'function') {
      await NotesStore.finishUnlockMaintenance();
    }
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

  function resetUnlockCardStatus() {
    hideUnlockSessionHint();
    const hint = document.getElementById('unlock-session-hint');
    if (hint) hint.textContent = '';
    const signIn = document.getElementById('unlock-session-signin');
    if (signIn) signIn.hidden = true;
    if (unlockError) {
      unlockError.textContent = '';
      unlockError.hidden = true;
    }
    const recovery = document.getElementById('unlock-recovery-hint');
    if (recovery) recovery.hidden = true;
    for (const id of ['unlock-status', 'login-progress-status', 'app-login-status']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = '';
      el.hidden = true;
    }
    const progress = document.getElementById('unlock-progress');
    if (progress) {
      progress.hidden = true;
      const bar = document.getElementById('unlock-progress-bar');
      if (bar) bar.style.width = '';
    }
    const overlay = document.getElementById('login-progress-overlay');
    if (overlay) overlay.hidden = true;
    const overlayBar = document.getElementById('login-progress-bar');
    if (overlayBar) overlayBar.style.width = '';
  }

  function vaultKeyProven() {
    if (!NotesStore.isUnlocked()) return false;
    if (typeof NotesStore.isKeyVerified !== 'function') return true;
    return NotesStore.isKeyVerified();
  }

  function rejectWrongUnlockPassword() {
    clearSavedUnlockSecrets();
    NotesStore.lock();
    const wrong = new Error('Wrong password.');
    wrong.status = 401;
    wrong.code = 'DECRYPT_FAILED';
    throw wrong;
  }

  /** Soft fail for post-login auto-unlock — never looks like a wrong password. */
  function deferAutoUnlock(reason = 'auto-unlock deferred') {
    // A slower silent attempt must not tear down a vault that already proved
    // its key (Round 53: late defer after a successful auto-unlock).
    if (vaultKeyProven() && NotesStore.isUnlocked()) {
      logLockReason('auto-unlock-defer-skipped', { deferReason: reason, alreadyProven: true });
      const err = new Error(reason);
      err.code = 'AUTO_UNLOCK_DEFER';
      err.skipped = true;
      throw err;
    }
    logLockReason('auto-unlock-defer', { deferReason: reason });
    try { NotesStore.lock(); } catch (err) { /* ignore */ }
    const err = new Error(reason);
    err.code = 'AUTO_UNLOCK_DEFER';
    throw err;
  }

  /** Password just typed on login/register — empty vault may hit /account/unlock. */
  function mayProveEmptyVaultOnSilentBoot() {
    try {
      return sessionStorage.getItem('notes_post_login_unlock') === '1'
        || sessionStorage.getItem('notes_just_registered') === '1';
    } catch (err) {
      return false;
    }
  }

  async function assertVaultKeyVerified() {
    // Do not return early just because keyVerified is already set. An empty
    // vault used to take that shortcut and skip the password proof.
    if (typeof NotesStore.probeServerKey !== 'function') {
      const missing = new Error('Wrong password.');
      missing.status = 401;
      missing.code = 'DECRYPT_FAILED';
      throw missing;
    }
    let probe;
    try {
      probe = await NotesStore.probeServerKey();
    } catch (err) {
      if (isLoginRequiredError(err)) throw sessionExpiredError();
      throw err;
    }
    if (probe?.ok && Number(probe.opened) > 0 && vaultKeyProven()) {
      return { via: 'decrypt', opened: Number(probe.opened) };
    }
    if (probe?.already && vaultKeyProven()) return { via: 'decrypt', already: true, opened: 0 };
    // Nothing on the server to decrypt. The caller must prove the account
    // password before markKeyVerified — an empty pull is not a key.
    if (probe?.empty) return { via: 'empty' };
    if (probe?.noSample) {
      const pending = new Error('Still downloading encrypted notes. Try unlock again in a moment.');
      pending.code = 'PROBE_NO_SAMPLE';
      throw pending;
    }
    const wrong = new Error('Wrong password.');
    wrong.status = 401;
    wrong.code = 'DECRYPT_FAILED';
    throw wrong;
  }

  async function proveEmptyVaultWithAccountPassword(email, password) {
    const normalized = String(email || '').trim().toLowerCase();
    const method = String(NotesStore.cachedAccount()?.auth_method || '');
    let data;
    try {
      if (method && method !== 'srp') {
        data = await NotesStore.api('/api/account/unlock', {
          method: 'POST',
          body: JSON.stringify({ current_password: password }),
          timeoutMs: 20000,
        });
      } else if (window.NotesSrpAuth?.accountUnlock) {
        data = await NotesSrpAuth.accountUnlock(normalized, password);
      } else {
        const missing = new Error('Wrong password.');
        missing.status = 401;
        throw missing;
      }
    } catch (err) {
      if (isLoginRequiredError(err)) throw sessionExpiredError();
      if (err?.status === 429) {
        NotesStore.lock();
        throw new Error('Too many unlock attempts. Wait a few minutes and try again.');
      }
      // Any 401 in this chain is a failed unlock, including a proof-less body.
      // "login required" is a dead session, handled above — not a wrong password.
      if (err?.status === 401 || err?.status === 400) rejectWrongUnlockPassword();
      NotesStore.lock();
      throw new Error('Could not reach the notes server. Connect to home Wi‑Fi or WireGuard and try again.');
    }
    if (!data || data.ok === false) rejectWrongUnlockPassword();
    NotesStore.cacheAccount(data);
    if (data.password_changed_at) NotesStore.ackPasswordChanged(data.password_changed_at);
    if (typeof NotesStore.markKeyVerified === 'function') NotesStore.markKeyVerified();
    return true;
  }

  function revealAppShell() {
    if (!vaultKeyProven()) return;
    if (!document.body.classList.contains('unlocked')) {
      const indicator = document.getElementById('sync-indicator');
      if (indicator && indicator.dataset.state === 'error') {
        NotesStore.emitSync('idle', '');
      }
      consumeUnlockGates();
      showApp();
      updateOfflineSetupBanner();
      updateDevicePhrasePrompt();
    }
    dismissLoginProgress();
    vaultReady = true;
  }

  async function revealPrimaryUnlock() {
    if (unlockPrimaryRevealed) return;
    if (!vaultKeyProven()) return;
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
    if (typeof NotesStore.finishUnlockMaintenance === 'function') {
      await NotesStore.finishUnlockMaintenance();
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
    if (!vaultKeyProven()) return;
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
    clearUnlockPasswordField({ force: true });
    try { sessionStorage.removeItem('notes_post_login_unlock'); } catch (err) { /* ignore */ }
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
            await assertVaultKeyVerified();
            revealAppShell();
          } else {
            await paintUnlockUi();
          }
        } else {
          await hydrateVaultUi({ loadLocal: !NotesStore.state.localReady });
          await assertVaultKeyVerified();
          revealAppShell();
        }
        setTimeout(() => flushPendingUpdatePrompt(), 1200);
        markJustUnlocked();
        await ensureServerSession({ prompt: false }).catch(() => false);
        schedulePostUnlockSync(needsReload);
      } catch (err) {
        if (!vaultKeyProven() || unlockErrorShouldRelock(err)) throw err;
        revealAppShell();
        setTimeout(() => flushPendingUpdatePrompt(), 1200);
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
    devicePasswordCache = '';
    if (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.clearDevicePassword) {
      try { NotesVaultSecrets.clearDevicePassword(); } catch (err) { /* ignore */ }
    }
    refreshClearSavedButton();
  }

  const SESSION_EXPIRED_MESSAGE = 'Your session expired — please sign in again';

  function isLoginRequiredError(err) {
    if (!err || err.code === 'session_revoked') return false;
    if (err.code === 'SESSION_EXPIRED') return true;
    const status = Number(err.status);
    if (status !== 401 && status !== 403) return false;
    return /login required|sign in required/i.test(String(err.message || ''));
  }

  function sessionExpiredError() {
    const err = new Error(SESSION_EXPIRED_MESSAGE);
    err.status = 401;
    err.code = 'SESSION_EXPIRED';
    return err;
  }

  function expiredSessionEmail() {
    const cached = String(NotesStore.cachedAccount()?.email || '').trim();
    if (cached) return cached;
    try {
      return String(localStorage.getItem('notes_email') || '').trim();
    } catch (err) {
      return '';
    }
  }

  function armExpiredLoginLinks() {
    const email = expiredSessionEmail();
    const params = new URLSearchParams();
    if (email) params.set('email', email);
    params.set('reason', 'session-expired');
    try {
      const note = noteIdFromUrl();
      if (note) params.set('note', note);
    } catch (err) { /* keep the sign-in url */ }
    const href = `/login?${params.toString()}`;
    for (const id of ['unlock-session-signin', 'sync-status-signin', 'editor-sync-status-signin']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.href = href;
      el.hidden = false;
    }
    return href;
  }

  function showExpiredSessionBanner() {
    sessionExpiredHold = true;
    stopChangePoll();
    armExpiredLoginLinks();
    showSyncBanner('session', 'Not syncing — sign in again');
    NotesStore.emitSync('pending', 'Not syncing — sign in again');
  }

  function redirectToExpiredLogin() {
    const email = expiredSessionEmail();
    const params = new URLSearchParams();
    if (email) params.set('email', email);
    params.set('reason', 'session-expired');
    try {
      const note = noteIdFromUrl();
      if (note) params.set('note', note);
    } catch (err) { /* keep the sign-in url */ }
    armExpiredLoginLinks();
    location.assign(`/login?${params.toString()}`);
  }

  function unlockErrorShouldRelock(err) {
    return err?.status === 401
      || err?.code === 'LOCAL_DECRYPT_FAILED'
      || err?.code === 'DECRYPT_FAILED'
      || /wrong (vault )?password|unreadable/i.test(String(err?.message || ''));
  }

  function repairUnlockShellState() {
    const unlocked = vaultKeyProven();
    if (unlocked && !isVaultReadyForSync()) {
      showApp();
    }
    return unlocked;
  }

  const POST_LOGIN_ACCOUNT_RETRY_MS = 400;

  function isPostLoginBootUnlock() {
    try {
      return sessionStorage.getItem('notes_post_login_unlock') === '1'
        || sessionStorage.getItem('notes_allow_boot_unlock') === '1';
    } catch (err) {
      return false;
    }
  }

  /** Non-silent unlocks always redirect. Silent post-login boot must not. */
  function shouldRedirectOnUnlockSessionExpired({ silent = false } = {}) {
    if (!silent) return true;
    return !isPostLoginBootUnlock();
  }

  /**
   * After SRP login, the first /api/account can briefly 401 before the session
   * cookie is visible. Retry once; callers decide whether to redirect.
   */
  async function loadAccountWithPostLoginRetry(loadAccount, {
    enabled = false,
    delayMs = POST_LOGIN_ACCOUNT_RETRY_MS,
    ensureSession = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isLoginRequired = isLoginRequiredError,
  } = {}) {
    try {
      return await loadAccount();
    } catch (err) {
      if (!enabled || !isLoginRequired(err)) throw err;
      await sleep(delayMs);
      if (typeof ensureSession === 'function') {
        try { await ensureSession(); } catch (ensureErr) { /* ignore */ }
      }
      return loadAccount();
    }
  }

  // Round 70 helpers — exposed for unit tests (no behavior change by itself).
  window.NotesPostLoginUnlock = {
    POST_LOGIN_ACCOUNT_RETRY_MS,
    isPostLoginBootUnlock,
    shouldRedirectOnUnlockSessionExpired,
    loadAccountWithPostLoginRetry,
  };

  function abortUnlockAttempt(err, { silent = false } = {}) {
    if (isLoginRequiredError(err)) {
      // Round 70: silent post-login auto-unlock must not bounce to
      // /login?reason=session-expired — fall through to typed unlock instead.
      if (!shouldRedirectOnUnlockSessionExpired({ silent })) {
        resetLoginProgress();
        logLockReason('post-login-session-pending', { message: String(err?.message || '') });
        try { NotesStore.lock(); } catch (lockErr) { /* ignore */ }
        markVaultShellLocked();
        throw err;
      }
      sessionExpiredHold = true;
      stopChangePoll();
      resetLoginProgress();
      logLockReason('session-expired', { message: String(err?.message || '') });
      try { NotesStore.lock(); } catch (lockErr) { /* ignore */ }
      if (!silent) showUnlockError(SESSION_EXPIRED_MESSAGE);
      redirectToExpiredLogin();
      throw err.code === 'SESSION_EXPIRED' ? err : sessionExpiredError();
    }
    // Round 72: empty-device fetch fallback owns the unlock status line —
    // do not replace it with a generic error or leave Checking… spinning.
    if (err?.code === 'EMPTY_DEVICE_FETCH_PENDING') {
      resetLoginProgress();
      logLockReason('empty-device-fetch-pending', { message: String(err?.message || '') });
      try { NotesStore.lock(); } catch (lockErr) { /* ignore */ }
      markVaultShellLocked();
      if (unlockSubmit) {
        unlockSubmit.disabled = false;
        unlockSubmit.textContent = 'Unlock';
        unlockSubmit.removeAttribute('aria-busy');
        unlockSubmit.classList.remove('is-checking');
      }
      if (!document.getElementById('unlock-status')?.classList.contains('is-fallback')) {
        setEmptyDeviceUnlockUi('fallback');
      }
      throw err;
    }
    resetLoginProgress();
    if (silent || err?.code === 'AUTO_UNLOCK_DEFER') {
      // Post-login auto-unlock: fall back to the typed unlock prompt without a
      // false "Wrong password." flash and without burning unlock rate limits.
      // Never relock an already-open, key-proven vault (Round 53).
      if (err?.skipped || (vaultKeyProven() && NotesStore.isUnlocked()
        && document.body.classList.contains('unlocked'))) {
        logLockReason('auto-unlock-abort-skipped', {
          code: err?.code || '',
          message: String(err?.message || ''),
        });
        throw err;
      }
      logLockReason('auto-unlock-abort', {
        code: err?.code || '',
        message: String(err?.message || ''),
      });
      try { NotesStore.lock(); } catch (lockErr) { /* ignore */ }
      markVaultShellLocked();
      throw err;
    }
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
      if (unlockError && msg) showUnlockError(msg);
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
    const tips = document.getElementById('empty-state-tips');
    if (tips) tips.hidden = true;
    const syncing = document.getElementById('sync-indicator')?.dataset?.state === 'syncing';
    if (vaultDownloadStalled && NotesStore.listNotes().length === 0 && !vaultSyncError) {
      title.textContent = 'Download paused';
      message.textContent = 'Notes did not finish downloading. Retry, or unlock again.';
      if (newBtn) newBtn.hidden = false;
      if (scanBtn) scanBtn.hidden = true;
      if (syncBtn) {
        syncBtn.hidden = false;
        syncBtn.textContent = 'Retry';
      }
      if (dismissBtn) dismissBtn.hidden = true;
      if (relockBtn) {
        relockBtn.hidden = false;
        relockBtn.textContent = 'Unlock again';
      }
      return;
    }
    if (syncing && NotesStore.listNotes().length === 0 && !vaultSyncError) {
      title.textContent = 'Downloading your notes';
      message.textContent = 'Notes appear in the list as they arrive. Watch the progress bar above the list for download status.';
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
    const vaultEmpty = NotesStore.listNotes().length === 0;
    if (vaultEmpty) {
      title.textContent = 'Welcome to Deeperguard';
      message.textContent = 'Your vault is empty. Notes stay encrypted on this device.';
      if (tips) tips.hidden = false;
      if (newBtn) {
        newBtn.hidden = false;
        newBtn.textContent = 'New note';
        newBtn.classList.add('primary');
      }
      if (scanBtn) scanBtn.hidden = true;
      if (syncBtn) syncBtn.hidden = true;
      if (dismissBtn) {
        dismissBtn.hidden = false;
        dismissBtn.textContent = 'Dismiss';
      }
      if (relockBtn) relockBtn.hidden = true;
      return;
    }
    if (tips) tips.hidden = true;
    title.textContent = 'Start writing';
    message.textContent = 'Notes stay encrypted on this device. Start with a blank note.';
    if (newBtn) {
      newBtn.hidden = false;
      newBtn.textContent = 'New note';
      newBtn.classList.remove('primary');
    }
    if (scanBtn) scanBtn.hidden = true;
    if (syncBtn) syncBtn.hidden = true;
    if (dismissBtn) dismissBtn.hidden = true;
    if (relockBtn) relockBtn.hidden = true;
    if (NotesStore.listNotes().length > 0 && !vaultSyncError && !currentId) {
      title.textContent = 'Select a note';
      message.textContent = 'Pick a note from the list or start a new one. Everything stays encrypted on this device.';
      if (newBtn) {
        newBtn.textContent = 'Create a note';
        newBtn.classList.add('primary');
      }
    }
  }

  function emptyStateDismissKey() {
    const email = String(NotesStore.cachedAccount()?.email || '').trim().toLowerCase();
    return email ? `notes_empty_state_dismissed:${email}` : 'notes_empty_state_dismissed';
  }

  function emptyStateDismissed() {
    try {
      const key = emptyStateDismissKey();
      if (localStorage.getItem(key) === '1' || sessionStorage.getItem(key) === '1') return true;
      // Legacy unscoped key leaked across accounts — only honor it before we know the email.
      if (key === 'notes_empty_state_dismissed') {
        return localStorage.getItem('notes_empty_state_dismissed') === '1'
          || sessionStorage.getItem('notes_empty_state_dismissed') === '1';
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  function clearEmptyStateDismissed() {
    try {
      const key = emptyStateDismissKey();
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
      localStorage.removeItem('notes_empty_state_dismissed');
      sessionStorage.removeItem('notes_empty_state_dismissed');
    } catch (err) {
      /* ignore */
    }
  }

  function dismissEmptyState() {
    try {
      const key = emptyStateDismissKey();
      localStorage.setItem(key, '1');
      sessionStorage.setItem(key, '1');
    } catch (err) {
      /* ignore quota */
    }
    clearVaultSyncError();
    if (ui.empty) ui.empty.hidden = true;
    updateEmptyStateVisibility();
  }

  function updateEmptyStateVisibility() {
    if (!ui.empty) return;
    try {
      if (sessionStorage.getItem('notes_just_registered') === '1') {
        clearEmptyStateDismissed();
      }
    } catch (err) {
      /* ignore */
    }
    if (vaultPullActive && NotesStore.listNotes().length > 0) {
      ui.empty.hidden = true;
      return;
    }
    if (currentId) {
      ui.empty.hidden = true;
      return;
    }
    // If notes already synced in, never trap the user behind the error card.
    if (NotesStore.listNotes().length > 0 && !vaultSyncError) {
      if (!currentId && ui.editor?.hidden) {
        ui.empty.hidden = false;
        refreshEmptyStateCopy();
        return;
      }
      ui.empty.hidden = true;
      return;
    }
    if (vaultSyncError) {
      ui.empty.hidden = false;
      refreshEmptyStateCopy();
      return;
    }
    // Brand-new empty vault: always show the welcome card unless the user dismissed it.
    if (NotesStore.listNotes().length === 0 && emptyStateDismissed()) {
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

  async function bootstrapServerSession(cached, { retryOnLoginRequired = false } = {}) {
    const load = async () => {
      const data = await NotesStore.loadAccount();
      NotesStore.cacheAccount({
        email: data.email || cached?.email,
        kdf_salt: data.kdf_salt,
        vault_kdf_version: data.vault_kdf_version,
        csrf: data.csrf,
      });
      if (data.password_changed_at) NotesStore.ackPasswordChanged(data.password_changed_at);
      return data;
    };
    return loadAccountWithPostLoginRetry(load, {
      enabled: !!retryOnLoginRequired,
      ensureSession: () => ensureServerSession({ prompt: false }),
    });
  }

  async function checkRemoteVaultPasswordChange(account) {
    if (!account) return false;
    // Fresh sign-in just proved the account password. Ack any server timestamp
    // so a false password_changed_at bump from the Round 49 SRP KDF upgrade
    // cannot clear the boot password or block auto-unlock.
    let postLoginUnlock = false;
    try { postLoginUnlock = sessionStorage.getItem('notes_post_login_unlock') === '1'; } catch (err) { /* ignore */ }
    if (postLoginUnlock) {
      if (account.password_changed_at) NotesStore.ackPasswordChanged?.(account.password_changed_at);
      return false;
    }
    if (!NotesStore.remotePasswordChanged?.(account)) return false;
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
      await lockVault(msg, { skipSync: true, reason: 'password-changed-remote' });
      return true;
    }
    logLockReason('password-changed-remote', { locked: false, message: msg });
    // Caller must clear suppressUnlockScreen before showUnlock (boot path).
    suppressUnlockScreen = false;
    markRememberedShell(false);
    showUnlock(account.email || NotesStore.cachedAccount().email);
    if (unlockError) {
      unlockError.hidden = false;
      unlockError.textContent = msg;
      unlockError.classList.add('error');
      unlockError.classList.remove('unlock-notice');
    }
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
    // A derived key or a live session is not proof. Only a decrypt may skip
    // the typed-password check. An empty vault still has to match the account password.
    if (typeof NotesStore.isKeyVerified === 'function' && NotesStore.isKeyVerified()) {
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

    const stashPendingAuthWrites = async (data) => {
      try {
        if (data.srp_kdf_upgrade) sessionStorage.setItem('notes_srp_kdf_upgrade', '1');
        if (data.auth_method && data.auth_method !== 'srp') {
          sessionStorage.setItem('notes_srp_legacy_upgrade', '1');
        }
        sessionStorage.setItem('notes_vault_recovery', '1');
      } catch (flagErr) { /* ignore */ }
      if (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.stashBootPassword) {
        await NotesVaultSecrets.stashBootPassword(password);
      }
    };

    // vault-recovery writes salt/verifier and now needs a totp_ok session (L-22).
    // Missing session / TOTP-pending must fall through to repair-login, then
    // finish recovery after TOTP (or immediately when 2FA is off).
    if (window.NotesSrpAuth?.vaultRecovery) {
      try {
        const data = await NotesSrpAuth.vaultRecovery(normalized, password);
        NotesStore.cacheAccount(data);
        if (data.password_changed_at) NotesStore.ackPasswordChanged(data.password_changed_at);
        return { ok: true, via: 'vault', totpRequired: !!data.totp_required };
      } catch (err) {
        if (err?.status === 429) return { ok: false, rateLimited: true };
        if (isLoginRequiredError(err) || isTotpRequiredError(err)) {
          /* no session or TOTP still pending — prove via repair-login */
        } else if (err?.status === 401) {
          return { ok: false, wrongPassword: true };
        }
      }
    }
    if (window.NotesSrpAuth?.passwordSignIn) {
      try {
        const data = await NotesSrpAuth.passwordSignIn(normalized, password);
        NotesStore.cacheAccount(data);
        if (data.password_changed_at) NotesStore.ackPasswordChanged(data.password_changed_at);
        if (data.totp_required) {
          await stashPendingAuthWrites(data);
          const via = data.login_repaired ? 'login' : 'srp';
          return { ok: true, via, totpRequired: true };
        }
        if (window.NotesSrpAuth?.vaultRecovery) {
          try {
            const recovered = await NotesSrpAuth.vaultRecovery(normalized, password);
            NotesStore.cacheAccount(recovered);
            if (recovered.password_changed_at) NotesStore.ackPasswordChanged(recovered.password_changed_at);
            return { ok: true, via: 'vault', totpRequired: false };
          } catch (recoverErr) {
            // Session is live; verifier realign can retry on the next unlock.
          }
        }
        const via = data.login_repaired ? 'login' : 'srp';
        return { ok: true, via, totpRequired: false };
      } catch (err) {
        if (isLoginRequiredError(err)) return { ok: false, sessionExpired: true };
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

  async function verifyAndUnlock(password, { silent = false } = {}) {
    if (NotesStore.isUnlocked() && vaultKeyProven()) {
      await ensureServerSession().catch(() => false);
      await finishUnlocked();
      return;
    }
    if (unlockInFlight) return unlockInFlight;
    unlockPrimaryRevealed = false;
    beginLoginProgress();
    if (unlockSubmit && !silent) {
      unlockSubmit.disabled = true;
      unlockSubmit.textContent = 'Checking…';
      unlockSubmit.setAttribute('aria-busy', 'true');
      unlockSubmit.classList.add('is-checking');
    }
    // Argon2 blocks the main thread. Paint Checking… before the first derive
    // or the button stays on Unlock until the rejection is already done.
    await yieldToPaint();
    unlockInFlight = (async () => {
      const clean = String(password || '').trim();
      if (!clean) throw new Error('Enter your password');
      try {
        const build = document.querySelector('meta[name="notes-build"]')?.content || '';
        const swUrl = (navigator.serviceWorker && navigator.serviceWorker.controller
          && navigator.serviceWorker.controller.scriptURL) || '';
        console.info('[notes-unlock] build', build, 'sw', swUrl || 'none', 'silent', !!silent);
      } catch (logErr) { /* ignore */ }
      // Fresh unlock must not inherit a pre-login away timer.
      try { clearUnfocusedAt(); } catch (clearErr) { /* ignore */ }
      // Prefer a claimed SW before empty-device probe/unlock so a stale /app
      // shell cannot run Round-51 probe logic against a newer server.
      try {
        if ('serviceWorker' in navigator) {
          const ready = navigator.serviceWorker.ready;
          if (ready && typeof ready.then === 'function') {
            await Promise.race([
              ready,
              new Promise((resolve) => setTimeout(resolve, 1500)),
            ]);
          }
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg && typeof reg.update === 'function') {
            reg.update().catch(() => {});
          }
        }
      } catch (swErr) { /* ignore */ }
      const cached = NotesStore.cachedAccount();
      const salt = cached.kdf_salt;
        if (salt) {
        await NotesStore.unlock(clean, salt);
        if (NotesStore.state.kdfFastReject) {
          clearSavedUnlockSecrets();
          NotesStore.lock();
          if (silent) deferAutoUnlock();
          const wrong = new Error('Wrong password.');
          wrong.status = 401;
          throw wrong;
        }
        stopLoginCreep();
        startLoginCreep('decrypt', phaseCeiling('decrypt'));
        setLoginProgressTarget('decrypt', 0, 1);
        await yieldToPaint();
        const retryOnLoginRequired = !!(silent && isPostLoginBootUnlock());
        const serverCheck = (async () => {
          // Round 72: force health. Backoff null / stale networkReachable must
          // not skip bootstrap — only a real /api/account failure is offline.
          await serverUnreachableNow({ force: true });
          try {
            await bootstrapServerSession(cached, { retryOnLoginRequired });
            return { ok: true };
          } catch (err) {
            if (isRealNetworkFailure(err)) return { offline: true, err };
            return { err };
          }
        })();
        const loadVaultLocal = async () => {
          try {
            const result = await NotesStore.loadLocal({
              onPrimaryReady: async () => {
                const server = await serverCheck;
                if (server?.err && isLoginRequiredError(server.err)) return;
                await revealPrimaryUnlock();
              },
            });
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
        if (localAllFailed && !NotesStore.state.kdfVersionsMissed) {
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
          if (isLoginRequiredError(serverResult.err)) {
            NotesStore.lock();
            throw sessionExpiredError();
          }
          if (silent) {
            // Post-login: try a server decrypt (both vault KDFs) before giving up.
            // Never treat this as a wrong-password failure or hit rate limits.
            let localProof = null;
            try {
              localProof = await assertVaultKeyVerified();
            } catch (probeErr) {
              if (isLoginRequiredError(probeErr)) throw sessionExpiredError();
              deferAutoUnlock();
            }
            if (localProof?.via !== 'decrypt' || !(Number(localProof.opened) > 0)) {
              deferAutoUnlock();
            }
            await clearUnreadableLocalCache();
            opened = { opened: 0, failed: 0, cipherOpened: 0 };
            localAllFailed = false;
            vaultRepairedOnline = true;
          } else {
            let sessionValid = !!serverResult.ok || await serverSessionLooksValid();
            if (!sessionValid) {
              const repaired = await repairUnlockWithPassword(cached.email, clean);
              if (repaired.sessionExpired) {
                NotesStore.lock();
                throw sessionExpiredError();
              }
              if (repaired.wrongPassword) rejectWrongUnlockPassword();
              if (repaired.rateLimited) {
                NotesStore.lock();
                throw new Error('Too many unlock attempts. Wait a few minutes and try again.');
              }
              if (!repaired.ok) {
                NotesStore.lock();
                throw new Error('Could not reach the notes server. Connect to home Wi‑Fi or WireGuard and try again.');
              }
              sessionValid = true;
              serverResult = { ok: true };
              const nextSalt = NotesStore.cachedAccount().kdf_salt || salt;
              await NotesStore.unlock(clean, nextSalt);
            }
            // Local ciphertext failed. Continue only when a server row decrypts.
            // An empty server vault must not wipe the local rows or open the shell.
            const localProof = await assertVaultKeyVerified();
            if (localProof?.via !== 'decrypt') rejectWrongUnlockPassword();
            if (!(Number(localProof.opened) > 0)) rejectWrongUnlockPassword();
            await clearUnreadableLocalCache();
            opened = { opened: 0, failed: 0, cipherOpened: 0 };
            localAllFailed = false;
            vaultRepairedOnline = true;
          }
        }
        const hasLocalVault = (opened.cipherOpened || 0) > 0;
        const emptyLocal = opened.opened === 0;
        vaultSyncError = '';
        let passwordProven = hasLocalVault || vaultRepairedOnline;
        // No local ciphertext and no repaired server row: a session cookie is
        // not a key. Prove the typed password, or a server row must decrypt.
        if (!hasLocalVault && !vaultRepairedOnline) {
          // Round 72: retry pull/bootstrap with UI; offline only after real
          // /api/account or /api/sync/pull failures exhaust the backoff.
          let freshProof = null;
          try {
            const fetched = await fetchEmptyDeviceProofWithRetry(cached, { silent });
            freshProof = fetched?.proof || null;
          } catch (probeErr) {
            if (isLoginRequiredError(probeErr)) throw sessionExpiredError();
            if (probeErr?.code === 'EMPTY_DEVICE_FETCH_PENDING') {
              NotesStore.lock();
              throw probeErr;
            }
            if (silent) deferAutoUnlock();
            throw probeErr;
          }
          if (!(freshProof?.via === 'decrypt' && Number(freshProof.opened) > 0)) {
            // Remembered-password boot unlock must not hit rate-limited prove
            // endpoints. A password just typed on login/register may prove an
            // empty vault (post-signup / empty-account sign-in).
            if (silent && !mayProveEmptyVaultOnSilentBoot()) deferAutoUnlock();
            await proveEmptyVaultWithAccountPassword(cached.email, clean);
          }
          passwordProven = vaultKeyProven();
          if (passwordProven) serverResult = { ok: true };
        }
        if (serverResult.offline) {
          if (emptyLocal && !hasLocalVault && !passwordProven) {
            // Empty-device path above already retried pull/bootstrap.
            if (silent) deferAutoUnlock();
            NotesStore.lock();
            setEmptyDeviceUnlockUi('fallback');
            scheduleEmptyDeviceBackgroundRetry();
            throw emptyDeviceFetchPendingError();
          }
          markOfflineUnlockVerified();
        } else if (serverResult.ok) {
          // Session is live. Do not store this password or write until the
          // vault key is proven below.
        } else {
          const err = serverResult.err || new Error('Could not verify password');
          if (isLoginRequiredError(err)) throw sessionExpiredError();
          if (err.status === 401 && (await serverSessionLooksValid())) {
            // Already signed in with the login password. Unlock password may
            // be the older phone vault password — allow crypto unlock + sync.
            // Do not persist to device until sync decrypts at least one item.
            vaultSyncError = '';
          } else if (err.status === 401) {
            if (silent) {
              if (hasLocalVault || opened.cipherOpened > 0) {
                vaultSyncError = 'Vault unlocked on this device. Sign in with your account password to sync.';
                passwordProven = true;
                serverResult = { ok: true };
                NotesStore.emitSync('pending', 'Sign in to sync');
              } else {
                deferAutoUnlock();
              }
            } else {
              // Server session expired. Attempt to re-authenticate with the entered password.
              const relogin = await repairUnlockWithPassword(cached.email, clean);
              if (relogin.ok) {
                // Account password matched. That does not prove the vault key.
                serverResult = { ok: true };
                vaultSyncError = '';
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
                if (isLoginRequiredError(err)) throw sessionExpiredError();
                throw err;
              } else {
                vaultSyncError = 'Unlocked on this device. Sign in again or open Settings → Change vault password if sync stays stuck.';
                passwordProven = true;
              }
            }
          } else if (!hasLocalVault) {
            NotesStore.lock();
            throw err;
          } else {
            vaultSyncError = 'Unlocked on this device. Sign in again or open Settings → Change vault password if sync stays stuck.';
            passwordProven = true;
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
          if ((openedNow > 0 || unlockDidSync) && vaultKeyProven()) {
            passwordProven = true;
          } else if (canProveViaSync) {
            // Fresh device: decrypt server ciphertext, or prove the account
            // password when the server vault is empty. Never treat empty as a key.
            let proof = null;
            try {
              proof = await assertVaultKeyVerified();
            } catch (probeErr) {
              if (isLoginRequiredError(probeErr)) throw sessionExpiredError();
              if (silent) deferAutoUnlock();
              throw probeErr;
            }
            if (proof?.via === 'empty') {
              if (silent && !mayProveEmptyVaultOnSilentBoot()) deferAutoUnlock();
              await proveEmptyVaultWithAccountPassword(cached.email, clean);
            }
            passwordProven = vaultKeyProven();
          } else {
            if (silent) deferAutoUnlock();
            const repaired = await repairUnlockWithPassword(cached.email, clean);
            if (repaired.ok) {
              const proof = await assertVaultKeyVerified();
              if (proof?.via === 'decrypt') {
                passwordProven = true;
                vaultRepairedOnline = true;
                serverResult = { ok: true };
                await clearUnreadableLocalCache();
              } else if (proof?.via === 'empty' && !hadStaleLocalCipher) {
                await proveEmptyVaultWithAccountPassword(cached.email, clean);
                passwordProven = vaultKeyProven();
                serverResult = { ok: passwordProven };
              } else {
                rejectWrongUnlockPassword();
              }
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
        if (!vaultKeyProven()) {
          if (silent) deferAutoUnlock();
          rejectWrongUnlockPassword();
        }
        if (skipLogin) {
          try {
            localStorage.setItem('notes_test_password', clean);
          } catch (e) {
            /* ignore quota */
          }
        }
        try {
          if (typeof NotesVaultSecrets !== 'undefined') {
            NotesVaultSecrets.setAccountPassword(clean);
          }
        } catch (err) {
          /* ignore */
        }
        sessionExpiredHold = false;
        await establishServerSessionAfterVaultUnlock(clean);
        await finishUnlocked({ skipReveal: unlockPrimaryRevealed });
        if (passwordProven) persistDevicePassword(clean);
        return;
      }
      const data = await bootstrapServerSession(cached, {
        retryOnLoginRequired: !!(silent && isPostLoginBootUnlock()),
      });
      await NotesStore.unlock(clean, data.kdf_salt);
      if (NotesStore.state.kdfFastReject) {
        if (silent) deferAutoUnlock();
        rejectWrongUnlockPassword();
      }
      let loaded = { cipherOpened: 0, opened: 0 };
      try {
        loaded = await NotesStore.loadLocal();
      } catch (err) {
        loaded = { cipherOpened: 0, opened: 0, failed: 1 };
      }
      if ((loaded.cipherOpened || 0) > 0) {
        /* local ciphertext proved the key */
      } else {
        const proof = await assertVaultKeyVerified();
        if (proof?.via === 'decrypt' && Number(proof.opened) > 0) {
          /* a server row decrypted */
        } else {
          await proveEmptyVaultWithAccountPassword(cached.email || data.email, clean);
        }
      }
      if (!vaultKeyProven()) rejectWrongUnlockPassword();
      stopLoginCreep();
      startLoginCreep('decrypt', phaseCeiling('decrypt'));
      setLoginProgressTarget('decrypt', 0, 1);
      await yieldToPaint();
      try {
        if (typeof NotesVaultSecrets !== 'undefined') {
          NotesVaultSecrets.setAccountPassword(clean);
        }
      } catch (err) {
        /* ignore */
      }
      persistDevicePassword(clean);
      if (skipLogin) {
        try {
          localStorage.setItem('notes_test_password', clean);
        } catch (e) {
          /* ignore quota */
        }
      }
      sessionExpiredHold = false;
      await establishServerSessionAfterVaultUnlock(clean);
      await finishUnlocked();
    })();
    try {
      await unlockInFlight;
    } catch (err) {
      abortUnlockAttempt(err, { silent });
    } finally {
      unlockInFlight = null;
    }
  }

  let unlockErrorAnnounce = 0;

  function showUnlockError(message) {
    if (!unlockError) return;
    const text = String(message || '');
    const token = ++unlockErrorAnnounce;
    unlockError.classList.add('error');
    unlockError.classList.remove('unlock-notice');
    unlockError.setAttribute('role', 'alert');
    unlockError.setAttribute('aria-live', 'assertive');
    unlockError.setAttribute('aria-atomic', 'true');
    // Hide and clear so a second "Wrong password." is announced, not ignored.
    unlockError.hidden = true;
    unlockError.textContent = '';
    if (!text) return;
    window.setTimeout(() => {
      if (token !== unlockErrorAnnounce || !unlockError) return;
      unlockError.textContent = text;
      unlockError.hidden = false;
    }, 20);
  }

  async function submitUnlockForm() {
    const typed = String(unlockPassword?.value || '').trim();
    if (!typed) {
      if (unlockSubmit) {
        unlockSubmit.disabled = false;
        unlockSubmit.textContent = 'Unlock';
        unlockSubmit.removeAttribute('aria-busy');
        unlockSubmit.classList.remove('is-checking');
      }
      showUnlockError('Enter your password');
      try { unlockPassword?.focus(); } catch (err) { /* ignore */ }
      return;
    }
    showUnlockError('');
    unlockSubmit.disabled = true;
    unlockSubmit.textContent = 'Checking…';
    unlockSubmit.setAttribute('aria-busy', 'true');
    unlockSubmit.classList.add('is-checking');
    try {
      await verifyAndUnlock(typed);
      stopEmptyDeviceBackgroundRetry();
      setEmptyDeviceUnlockUi('clear');
      repairUnlockShellState();
      if (vaultKeyProven() && !isVaultReadyForSync()) showApp();
    } catch (err) {
      if (isLoginRequiredError(err)) {
        showUnlockError(SESSION_EXPIRED_MESSAGE);
        unlockSubmit.disabled = false;
        unlockSubmit.textContent = 'Unlock';
        unlockSubmit.removeAttribute('aria-busy');
        unlockSubmit.classList.remove('is-checking');
        return;
      }
      if (err?.code === 'EMPTY_DEVICE_FETCH_PENDING') {
        unlockSubmit.disabled = false;
        unlockSubmit.textContent = 'Unlock';
        unlockSubmit.removeAttribute('aria-busy');
        unlockSubmit.classList.remove('is-checking');
        return;
      }
      showUnlockError(
        err.status === 401
          ? (err.message || 'Wrong password.')
          : err.message || 'Could not unlock.',
      );
      const recovery = document.getElementById('unlock-recovery-hint');
      if (recovery) recovery.hidden = false;
      unlockSubmit.disabled = false;
      unlockSubmit.textContent = 'Unlock';
      unlockSubmit.removeAttribute('aria-busy');
      unlockSubmit.classList.remove('is-checking');
    }
  }

  unlockForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopPropagation();
    submitUnlockForm().catch(() => {});
  });

  document.getElementById('unlock-empty-retry')?.addEventListener('click', () => {
    stopEmptyDeviceBackgroundRetry();
    setEmptyDeviceUnlockUi('clear');
    showUnlockError('');
    submitUnlockForm().catch(() => {});
  });

  const SIGN_OUT_WARNING = (
    'All notes, attachments, and vault data on this device will be deleted. '
    + 'Your encrypted data stays on the Deeperguard server and will download again when you sign back in.'
  );

  async function clearLocalVaultAndLeave(next = '/login') {
    stopEmptyDeviceBackgroundRetry();
    setEmptyDeviceUnlockUi('clear');
    clearUnlockPasswordField({ force: true });
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

  async function refreshCsrfFromAccount() {
    let account = null;
    try {
      if (window.__notesAccountPromise) account = await window.__notesAccountPromise;
    } catch (err) {
      account = null;
    }
    if (!account?.csrf && window.__notesCsrf) {
      NotesStore.setCsrf(window.__notesCsrf);
      return window.__notesCsrf;
    }
    if (!account?.csrf) {
      try {
        const res = await fetch('/api/account', { cache: 'no-store', credentials: 'same-origin' });
        if (res.ok) account = await res.json();
      } catch (err) {
        account = null;
      }
    }
    if (account?.csrf) {
      window.__notesCsrf = account.csrf;
      NotesStore.setCsrf(account.csrf);
      return account.csrf;
    }
    return NotesStore.csrf() || '';
  }

  async function signOutCompletely() {
    stopOnlineRecovery('sign-out');
    try {
      await NotesStore.flush();
    } catch (err) {
      /* still leave */
    }
    // /app is a cacheable shell with an empty CSRF attribute. A locked reload
    // still has the session cookie, so logout must use the token from /api/account.
    await refreshCsrfFromAccount();
    let loggedOut = false;
    for (let attempt = 0; attempt < 2 && !loggedOut; attempt += 1) {
      try {
        await NotesStore.api('/api/auth/logout', { method: 'POST', body: '{}' });
        loggedOut = true;
      } catch (err) {
        if (attempt === 0 && err && (err.status === 400 || err.status === 403)) {
          try { NotesStore.setCsrf(''); } catch (e) { /* ignore */ }
          window.__notesCsrf = '';
          await refreshCsrfFromAccount();
          continue;
        }
        break;
      }
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
    logLockReason('session-revoked', {});
    try { NotesStore.setCsrf(''); } catch (err) { /* ignore */ }
    if (typeof NotesVaultSecrets !== 'undefined') {
      try { NotesVaultSecrets.clearSecrets(); } catch (err) { /* ignore */ }
      try { NotesVaultSecrets.clearDevicePassword(); } catch (err) { /* ignore */ }
    }
    remoteWipePromise = clearLocalVaultAndLeave('/login?reason=signed-out');
    return remoteWipePromise;
  }

  function stopRemoteRevokeWatch() {
    if (!remoteRevokeTimer) return;
    clearInterval(remoteRevokeTimer);
    remoteRevokeTimer = 0;
  }

  async function checkRemoteRevocation() {
    if (remoteWipeStarted) return;
    if (window.__notesAccountPromise) {
      try { await window.__notesAccountPromise; } catch (err) { /* boot probe owns the first account read */ }
    }
    if (window.__notesSessionRevoked) {
      await wipeAfterRemoteSignOut();
      return;
    }
    if (window.__notesSignedOut) return;
    try {
      await NotesStore.api('/api/account', { timeoutMs: 4000 });
    } catch (err) {
      if (isSessionRevokedError(err)) {
        await wipeAfterRemoteSignOut();
        return;
      }
      // Timeouts / offline must not sign the user out or lock the vault (Round 55).
      if (NotesStore.isProbablyOffline?.(err) || err?.code === 'aborted'
        || /timed out|Failed to fetch|NetworkError/i.test(String(err?.message || ''))) {
        return;
      }
      if (err && (err.status === 401 || err.status === 403)) {
        window.__notesSignedOut = true;
        stopRemoteRevokeWatch();
      }
    }
  }

  function startRemoteRevokeWatch() {
    if (window.__notesSignedOut) return;
    if (remoteRevokeTimer) return;
    checkRemoteRevocation().catch(() => {});
    remoteRevokeTimer = window.setInterval(() => {
      if (window.__notesSignedOut) {
        stopRemoteRevokeWatch();
        return;
      }
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
    unlockError.classList.add('error');
    unlockError.classList.remove('unlock-notice');
    refreshUnlockEmail().catch(() => {});
    unlockPassword.focus();
  });

  function refreshClearSavedButton() {
    const btn = document.getElementById('unlock-clear-saved');
    const hint = document.getElementById('unlock-saved-hint');
    const saved = !!(prefs.rememberDevice && savedDevicePassword());
    if (btn) btn.hidden = !saved;
    if (hint) hint.hidden = !saved;
  }

  async function ensureUnlocked() {
    // Vault password stays in memory only; same-tab refetch uses boot unlock flag.
    bootUnlockPending = true;
    let bootSuppress = false;
    try {
      let allowBootUnlock = false;
      let freshLogin = false;
      let justRegistered = false;
      try {
        freshLogin = sessionStorage.getItem('notes_allow_boot_unlock') === '1';
        justRegistered = sessionStorage.getItem('notes_just_registered') === '1';
        allowBootUnlock = freshLogin;
        // Hide the lock screen before the first await so registration does not
        // flash "Unlock your vault" while the boot password is unwrapped.
        if (freshLogin || justRegistered) {
          bootSuppress = true;
          suppressUnlockScreen = true;
          markRememberedShell(true);
        }
        if (freshLogin) sessionStorage.removeItem('notes_allow_boot_unlock');
        if (!freshLogin) sessionStorage.removeItem('notes_user_requested_update');
      } catch (err) {
        allowBootUnlock = false;
        freshLogin = false;
      }
      // Update / leave-app lock must stay on the vault lock screen — remembered
      // password / skip-login must not auto-unlock across a version refresh.
      // A password just typed on the login form is different: when the vault
      // password still equals the account password, unlock immediately.
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
      if (forceLockAfterUpdate && !freshLogin) {
        allowBootUnlock = false;
        markTypedUnlockRequired();
      }
      if ((allowBootUnlock || freshLogin) && typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.consumeBootPassword) {
        await NotesVaultSecrets.consumeBootPassword();
      }
      try { sessionStorage.removeItem('notes_boot_password_ready'); } catch (err) { /* ignore */ }
      await refreshDevicePasswordCache();
      let sessionPassword = '';
      try {
        sessionPassword = (forceLockAfterUpdate && !freshLogin) ? '' : ((typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.getVaultPassword()) || '');
      } catch (err) {
        sessionPassword = '';
      }
      const bootDerived = (typeof NotesVaultSecrets !== 'undefined' && NotesVaultSecrets.takeBootDerivedKey)
        ? NotesVaultSecrets.takeBootDerivedKey()
        : null;
      if (bootDerived && sessionPassword && typeof NotesStore.adoptDerivedVaultKey === 'function') {
        NotesStore.adoptDerivedVaultKey(sessionPassword, bootDerived);
      }
      const cached = NotesStore.cachedAccount();
      const bootSalt = cached.kdf_salt
        || localStorage.getItem('notes_kdf_salt')
        || sessionStorage.getItem('notes_kdf_salt')
        || '';
      const savedPassword = (forceLockAfterUpdate && !freshLogin) ? '' : savedUnlockPassword();
      const autoUnlockPassword = sessionPassword || savedPassword;
      const mayAutoUnlock = (freshLogin || !forceLockAfterUpdate) && !!(autoUnlockPassword && bootSalt);
      if (mayAutoUnlock) {
        bootSuppress = true;
        suppressUnlockScreen = true;
        markRememberedShell(true);
      } else {
        bootSuppress = false;
        suppressUnlockScreen = false;
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
          await verifyAndUnlock(autoUnlockPassword, { silent: true });
          return true;
        } catch (err) {
          bootSuppress = false;
          suppressUnlockScreen = false;
          markRememberedShell(false);
          // Clear any false unlock error from a prior attempt; user must type.
          if (unlockError) {
            unlockError.hidden = true;
            unlockError.textContent = '';
          }
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
        unlockError.textContent = 'Sign in once while you are online. This device can unlock offline after that.';
        unlockError.classList.add('error');
        unlockError.classList.remove('unlock-notice');
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

  function folderMap() {
    const folders = NotesStore.listFolders?.() || [];
    const key = folders.map((f) => `${f.uuid}:${f.content?.updated_at || ''}:${f.content?.title || ''}`).join('|');
    if (folderMap._cache && folderMap._cache.key === key) return folderMap._cache.map;
    const map = new Map(folders.map((f) => [f.uuid, f]));
    folderMap._cache = { key, map };
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
          return `<button type="button" class="tag-color ${on}" data-tag-color="${color}" style="background:${color}" aria-label="Set ${tagColorName(color)} color"></button>`;
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
          </div>
        </div>`;
      })
      .join('');
    ui.tagList.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentTag = currentTag === btn.dataset.tag ? null : btn.dataset.tag;
        if (currentTag) currentFolder = null;
        if (currentTag && (currentFilter === 'untagged' || currentFilter === 'trash')) {
          setFilter('all');
        }
        applyTagSection();
        renderTags();
        renderNotes();
        closeEditorIfNoteLeftView();
        if (document.body.classList.contains('nav-drawer-open')) setNavDrawer(false);
      });
      bindTagLongPress(btn, btn.dataset.tag);
    });
    renderTagColorBar();
    renderSearchFilterTags();
    renderFolders();
    renderTagManageList();
    document.getElementById('tag-section')?.classList.toggle('is-empty', tags.length === 0);
  }

  function tagManageOpen() {
    const dialog = document.getElementById('tag-manage-dialog');
    return Boolean(dialog && !dialog.hidden);
  }

  function renderTagManageList() {
    const list = document.getElementById('tag-manage-list');
    if (!list || !tagManageOpen()) return;
    const tags = NotesStore.listTags();
    if (!tags.length) {
      list.innerHTML = '<p class="muted">No tags yet.</p>';
      return;
    }
    list.innerHTML = tags.map((tag) => {
      const color = safeColor(tag.content.color);
      const count = NotesStore.noteCountForTag(tag.uuid);
      const swatches = TAG_COLORS.map((swatch) => {
        const on = color === swatch ? 'active' : '';
        return `<button type="button" class="tag-color ${on}" data-manage-color="${swatch}" style="background:${swatch}" aria-label="Set ${tagColorName(swatch)} color"></button>`;
      }).join('');
      return `<div class="tag-manage-row" data-manage-tag="${escapeAttr(tag.uuid)}">
        <div class="tag-manage-main">
          <span class="tag-dot" style="background:${color}"></span>
          <span class="tag-manage-name">${escapeHtml(tag.content.title || 'Tag')}</span>
          <span class="tag-count">${count}</span>
          <button type="button" class="btn ghost sm" data-manage-rename aria-label="Rename tag ${escapeAttr(tag.content.title || 'Tag')}">Rename</button>
          <button type="button" class="btn ghost sm" data-server-copy="${escapeAttr(tag.uuid)}" aria-label="View server copy for tag ${escapeAttr(tag.content.title || 'Tag')}">Server copy</button>
          <button type="button" class="btn ghost sm" data-manage-delete aria-label="Delete tag ${escapeAttr(tag.content.title || 'Tag')}">Delete</button>
        </div>
        <div class="tag-colors">${swatches}</div>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-manage-tag]').forEach((row) => {
      const uuid = row.dataset.manageTag;
      row.querySelector('[data-manage-rename]')?.addEventListener('click', () => beginManageRename(row, uuid));
      row.querySelector('[data-manage-delete]')?.addEventListener('click', () => deleteCurrentTag(uuid));
      row.querySelector('[data-server-copy]')?.addEventListener('click', () => {
        openServerCopyView(uuid).catch((err) => toast(err.message || 'Could not load server copy', true));
      });
      row.querySelectorAll('[data-manage-color]').forEach((swatch) => {
        swatch.addEventListener('click', () => {
          NotesStore.setTagColor(uuid, swatch.dataset.manageColor);
          invalidateTagMap();
          renderTags();
          if (currentId) renderTagBar(NotesStore.get(currentId));
        });
      });
    });
  }

  function beginManageRename(row, uuid) {
    const tag = NotesStore.get(uuid);
    const name = row.querySelector('.tag-manage-name');
    if (!tag || !name) return;
    const input = document.createElement('input');
    input.className = 'tag-manage-rename';
    input.value = tag.content.title || '';
    input.maxLength = 80;
    input.setAttribute('aria-label', 'Rename tag');
    input.addEventListener('input', () => syncTagLimitHint(input));
    name.replaceWith(input);
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
        renderTagManageList();
      }
    });
    input.addEventListener('blur', commit);
  }

  function openTagManage() {
    const dialog = document.getElementById('tag-manage-dialog');
    const backdrop = document.getElementById('tag-manage-backdrop');
    if (!dialog) return;
    dialog.hidden = false;
    if (backdrop) backdrop.hidden = false;
    renderTagManageList();
    syncToastDialogLift();
  }

  function closeTagManage() {
    const dialog = document.getElementById('tag-manage-dialog');
    const backdrop = document.getElementById('tag-manage-backdrop');
    if (dialog) dialog.hidden = true;
    if (backdrop) backdrop.hidden = true;
    syncToastDialogLift();
  }

  function folderOpenMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem('notes_folder_open') || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function setFolderOpen(folderId, open) {
    const map = folderOpenMap();
    map[folderId] = !!open;
    try { localStorage.setItem('notes_folder_open', JSON.stringify(map)); } catch (err) { /* ignore */ }
  }

  function syncTagLimitHint(input) {
    if (!input) return;
    const max = input.maxLength > 0 ? input.maxLength : 80;
    const anchor = input.closest('form') || input;
    const host = anchor.parentElement;
    if (!host) return;
    let hint = host.querySelector(':scope > .tag-limit-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'tag-limit-hint';
      hint.hidden = true;
      anchor.insertAdjacentElement('afterend', hint);
    }
    const len = String(input.value || '').length;
    if (len >= max) {
      hint.hidden = false;
      hint.textContent = `${len}/${max} — names stop at ${max} characters`;
    } else if (len >= max - 12) {
      hint.hidden = false;
      hint.textContent = `${len}/${max}`;
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
  }

  function beginRenameFolder(uuid) {
    const block = document.querySelector(`#folder-list [data-folder="${CSS.escape(uuid)}"]`);
    const folder = NotesStore.get(uuid);
    const select = block?.querySelector('[data-folder-select]');
    if (!block || !folder || !select || block.querySelector('.folder-rename-input')) return;
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.value = folder.content.title || '';
    input.maxLength = 80;
    input.setAttribute('aria-label', 'Rename folder');
    select.replaceWith(input);
    syncTagLimitHint(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      const currentName = String(folder.content.title || '').trim();
      let renamedTo = null;
      if (!title) {
        toast('Enter a folder name', true);
      } else if (title.toLowerCase() !== currentName.toLowerCase()) {
        const taken = NotesStore.listFolders().some((item) => (
          item.uuid !== uuid
          && String(item.content?.title || '').trim().toLowerCase() === title.toLowerCase()
        ));
        if (taken) toast('A folder with that name already exists', true);
        else if (NotesStore.renameFolder(uuid, title)) renamedTo = title;
      } else if (title !== currentName) {
        if (NotesStore.renameFolder(uuid, title)) renamedTo = title;
      }
      // Phone list header must update immediately — don't wait on rAF renderNotes.
      if (renamedTo && currentFolder === uuid) {
        const listTitle = document.getElementById('note-list-title');
        if (listTitle) listTitle.textContent = renamedTo;
      }
      renderFolders();
      renderNotes();
      syncFilterSelect();
      if (currentId) syncNoteFolderControl(NotesStore.get(currentId));
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
        renderFolders();
      }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('input', () => syncTagLimitHint(input));
  }

  function renderFolders() {
    const host = document.getElementById('folder-list');
    if (!host || !NotesStore.listFolders) return;
    const folders = NotesStore.listFolders();
    document.getElementById('folder-section')?.classList.toggle('is-empty', folders.length === 0);
    const openMap = folderOpenMap();
    host.innerHTML = folders.map((folder) => {
      const notes = NotesStore.notesInFolder(folder.uuid);
      const open = !!openMap[folder.uuid];
      const active = currentFolder === folder.uuid ? ' active' : '';
      const kids = notes.map((note) => {
        const noteOpen = editorNoteOpen() && currentId === note.uuid;
        const inThisView = currentFolder === folder.uuid;
        const on = (noteOpen && inThisView) ? ' active' : '';
        // All Notes stays the active view. The folder only gets a quiet marker.
        const current = (noteOpen && !inThisView) ? ' is-current' : '';
        return `<button type="button" class="folder-note${on}${current}" data-folder-note="${escapeAttr(note.uuid)}">${escapeHtml(NotesSearch.effectiveNoteTitle(note) || 'Untitled')}</button>`;
      }).join('');
      const holdsOpen = notes.some((note) => editorNoteOpen() && currentId === note.uuid && currentFolder !== folder.uuid);
      return `<div class="folder-block${active}${open ? ' is-open' : ''}${holdsOpen ? ' has-open-note' : ''}" data-folder="${escapeAttr(folder.uuid)}">
        <div class="folder-head">
          <button type="button" class="folder-toggle" data-folder-toggle="${escapeAttr(folder.uuid)}" aria-expanded="${open ? 'true' : 'false'}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeAttr(folder.content.title || 'Folder')}">${open ? '▾' : '▸'}</button>
          <button type="button" class="folder-select" data-folder-select="${escapeAttr(folder.uuid)}">${escapeHtml(folder.content.title || 'Folder')}</button>
          <span class="tag-count">${notes.length}</span>
          <button type="button" class="folder-rename" data-folder-rename="${escapeAttr(folder.uuid)}" aria-label="Rename folder ${escapeAttr(folder.content.title || 'Folder')}">✎</button>
          <button type="button" class="folder-server-copy" data-server-copy="${escapeAttr(folder.uuid)}" aria-label="View server copy for folder ${escapeAttr(folder.content.title || 'Folder')}" title="View server copy">ⓘ</button>
          <button type="button" class="tag-remove folder-remove" data-folder-remove="${escapeAttr(folder.uuid)}" aria-label="Delete folder ${escapeAttr(folder.content.title || 'Folder')}">×</button>
        </div>
        <div class="folder-notes"${open ? '' : ' hidden'}>${kids || '<p class="folder-empty muted">Empty</p>'}</div>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-folder-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.folderToggle;
        const block = host.querySelector(`[data-folder="${id}"]`);
        const next = !block?.classList.contains('is-open');
        setFolderOpen(id, next);
        renderFolders();
      });
    });
    host.querySelectorAll('[data-folder-select]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        if (event.detail > 1) return;
        const id = btn.dataset.folderSelect;
        currentFolder = currentFolder === id ? null : id;
        if (currentFolder) {
          currentTag = null;
          if (currentFilter === 'trash' || currentFilter === 'untagged') setFilter('all');
        }
        renderTags();
        renderNotes();
        syncFilterSelect();
        closeEditorIfNoteLeftView();
        if (document.body.classList.contains('nav-drawer-open')) setNavDrawer(false);
      });
      btn.addEventListener('dblclick', (event) => {
        event.preventDefault();
        beginRenameFolder(btn.dataset.folderSelect);
      });
    });
    host.querySelectorAll('[data-folder]').forEach((block) => {
      block.addEventListener('contextmenu', (event) => {
        if (event.target.closest('[data-folder-note], [data-folder-remove], .folder-rename-input')) return;
        event.preventDefault();
        beginRenameFolder(block.dataset.folder);
      });
    });
    host.querySelectorAll('[data-folder-rename]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        beginRenameFolder(btn.dataset.folderRename);
      });
    });
    host.querySelectorAll('[data-server-copy]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openServerCopyView(btn.dataset.serverCopy).catch((err) => toast(err.message || 'Could not load server copy', true));
      });
    });
    host.querySelectorAll('[data-folder-note]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        if (typeof shouldSwallowNoteOpen === 'function' && shouldSwallowNoteOpen()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const folderId = btn.closest('[data-folder]')?.dataset.folder || '';
        if (folderId) currentFolder = folderId;
        openNote(btn.dataset.folderNote);
        if (document.body.classList.contains('nav-drawer-open')) setNavDrawer(false);
      });
    });
    host.querySelectorAll('[data-folder-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.folderRemove;
        const folder = NotesStore.get(id);
        if (!folder) return;
        const name = folder?.content?.title || 'this folder';
        confirmAction(`Remove “${name}”? Notes in it stay in your list.`, {
          title: 'Remove folder',
          confirmLabel: 'Remove',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          const snapshot = {
            uuid: id,
            content: { ...folder.content },
            noteIds: NotesStore.listNotes()
              .filter((n) => n.content?.folder_id === id)
              .map((n) => n.uuid),
            wasCurrent: currentFolder === id,
          };
          if (currentFolder === id) currentFolder = null;
          NotesStore.deleteFolder(id);
          renderFolders();
          renderNotes();
          toastWithUndo('Folder removed', () => {
            NotesStore.upsert(snapshot.uuid, { ...snapshot.content });
            snapshot.noteIds.forEach((noteId) => {
              const note = NotesStore.get(noteId);
              if (!note || note.deleted) return;
              NotesStore.upsert(noteId, { ...note.content, folder_id: snapshot.uuid }, {
                touchUpdatedAt: false,
                touchSyncOnly: true,
              });
            });
            if (snapshot.wasCurrent) currentFolder = snapshot.uuid;
            renderFolders();
            renderNotes();
            toast('Folder restored');
          });
        });
      });
    });
    syncNavFilterActive();
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

  function emptyNotesCopy() {
    if (currentTag) {
      const tag = NotesStore.get(currentTag);
      const name = String(tag?.content?.title || 'this tag').trim() || 'this tag';
      return {
        title: `No notes in ${name} yet`,
        body: `Add this tag to a note.`,
      };
    }
    if (currentFolder) {
      const folder = NotesStore.get(currentFolder);
      const name = String(folder?.content?.title || 'this folder').trim() || 'this folder';
      return {
        title: `No notes in ${name} yet`,
        body: 'Move a note into this folder, or create a new note.',
      };
    }
    if (currentFilter === 'pinned') {
      return {
        title: 'No starred notes yet',
        body: 'Tap ☆ on a note to star it.',
      };
    }
    if (currentFilter === 'archived') {
      return {
        title: 'No archived notes yet',
        body: 'Archive a note and it will show up here.',
      };
    }
    return {
      title: 'No notes here yet',
      body: 'Create a note or scan a document, or pull down to sync from your other devices.',
    };
  }

  function emptyListActionsHtml() {
    if (currentFilter === 'pinned' || currentFilter === 'archived') return '';
    // Tag/folder filters: never imply a sync problem for a brand-new empty view.
    if (currentTag || currentFolder) {
      return `<div class="note-list-empty-actions">
                <button type="button" class="btn primary sm" data-empty-new>New note</button>
              </div>`;
    }
    const vaultEmpty = !NotesStore.listNotes().some((n) => !n.content?.trashed && !n.deleted);
    if (vaultEmpty) {
      return `<div class="note-list-empty-actions">
                <button type="button" class="btn primary sm" data-empty-new>New note</button>
                <button type="button" class="btn sm" data-empty-scan>Scan document</button>
                <button type="button" class="btn sm" data-empty-sync>Sync notes</button>
              </div>`;
    }
    return `<div class="note-list-empty-actions">
                <button type="button" class="btn primary sm" data-empty-sync>Sync notes</button>
                <button type="button" class="btn sm" data-empty-new>New note</button>
                <button type="button" class="btn sm" data-empty-scan>Scan document</button>
              </div>`;
  }

  function updateTrashToolbar(count = null) {
    const total = typeof count === 'number' ? count : trashedNotes().length;
    const settingsBtn = document.getElementById('btn-empty-trash');
    const dangerSection = document.getElementById('settings-danger-zone');
    const dangerHint = document.getElementById('settings-danger-hint');
    if (settingsBtn) {
      settingsBtn.hidden = false;
      settingsBtn.disabled = total === 0;
      settingsBtn.textContent = total === 0 ? 'Empty trash' : 'Empty trash';
      settingsBtn.title = total === 0 ? 'Trash is empty' : 'Permanently delete notes in trash';
    }
    if (dangerHint) {
      dangerHint.hidden = total > 0;
      dangerHint.textContent = 'Trash is empty';
    }
    if (dangerSection) {
      // Keep the section visible with a disabled Empty trash + hint when empty.
      dangerSection.hidden = false;
    }
    const bar = document.getElementById('trash-toolbar');
    const meta = document.getElementById('trash-toolbar-meta');
    const btn = document.getElementById('btn-empty-trash-list');
    if (!bar || !meta || !btn) return;
    const show = currentFilter === 'trash';
    bar.hidden = !show;
    if (!show) return;
    meta.textContent = total
      ? `${total} note${total === 1 ? '' : 's'} in trash`
      : '';
    bar.hidden = !show || total === 0;
    btn.hidden = total === 0;
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
    renderTags();
    if (protectedCount > 0) {
      toast('Protected notes were not deleted', true);
    } else {
      toast('Trash emptied');
    }
  }

  function syncNavFilterActive() {
    if (!ui.filters) return;
    ui.filters.querySelectorAll('.filter').forEach((btn) => {
      const name = btn.dataset.filter;
      const on = name === currentFilter && !(name === 'all' && (currentTag || currentFolder));
      btn.classList.toggle('active', on);
    });
  }

  function syncFilterSelect() {
    const select = document.getElementById('filter-select');
    if (!select) return;
    let extra = select.querySelector('option[data-folder-option]');
    if (currentFolder) {
      const folder = NotesStore.get(currentFolder);
      const title = folder?.content?.title || 'Folder';
      if (!extra) {
        extra = document.createElement('option');
        extra.dataset.folderOption = '1';
        extra.value = 'folder';
        select.appendChild(extra);
      }
      extra.textContent = title;
      if (select.value !== 'folder') select.value = 'folder';
      return;
    }
    if (extra) extra.remove();
    if (select.value !== currentFilter) select.value = currentFilter;
  }

  function closeEditorIfNoteLeftView() {
    if (!currentId || typeof NotesSearch === 'undefined') return;
    const note = NotesStore.get(currentId);
    if (!note) {
      closeEditor();
      return;
    }
    const matched = NotesSearch.filterNotes([note], {
      query: '',
      filter: currentFilter,
      tagId: currentTag,
      folderId: currentFolder,
      tagMap: tagMap(),
      folderMap: folderMap(),
      sort: prefs.sort,
    });
    if (!matched.some((item) => item.uuid === currentId)) closeEditor();
  }

  function setFilter(name) {
    if (name === 'documents' && currentFilter !== 'documents') {
      filterBeforeFiles = currentFilter || 'all';
    }
    currentFilter = name;
    syncNavFilterActive();
    syncFilterSelect();
    if (name === 'untagged' || name === 'trash' || name === 'archived') {
      currentTag = null;
      applyTagSection();
    }
    updateTrashToolbar();
    closeEditorIfNoteLeftView();
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
    input.addEventListener('input', () => syncTagLimitHint(input));
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
      const snapshot = {
        uuid,
        content: { ...tag.content },
        noteIds: NotesStore.listNotes()
          .filter((n) => (n.content?.tags || []).includes(uuid))
          .map((n) => n.uuid),
        wasCurrent: currentTag === uuid,
      };
      NotesStore.deleteTag(uuid);
      invalidateTagMap();
      if (currentTag === uuid) currentTag = null;
      renderTags();
      renderNotes();
      if (currentId) renderTagBar(NotesStore.get(currentId));
      toastWithUndo('Tag deleted', () => {
        NotesStore.upsert(snapshot.uuid, { ...snapshot.content });
        snapshot.noteIds.forEach((noteId) => {
          const note = NotesStore.get(noteId);
          if (!note || note.deleted) return;
          const tags = new Set(note.content.tags || []);
          tags.add(snapshot.uuid);
          NotesStore.upsert(noteId, { ...note.content, tags: [...tags] });
        });
        invalidateTagMap();
        if (snapshot.wasCurrent) currentTag = snapshot.uuid;
        renderTags();
        renderNotes();
        if (currentId) renderTagBar(NotesStore.get(currentId));
        toast('Tag restored');
      });
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
    document.body.classList.toggle('search-filters-open', !!open);
    if (open) {
      syncSearchFilterControls();
      document.getElementById('search-titles-only')?.focus();
    }
  }

  function notesRenderKey(notes, query) {
    const sf = searchFilterOptions();
    const sfKey = `${sf.titlesOnly ? 1 : 0}:${sf.includeArchived ? 1 : 0}:${sf.includeTrashed ? 1 : 0}:${sf.includeProtected ? 1 : 0}:${sf.tagIds.join(',')}`;
    const ids = notes.map((n) => `${n.uuid}:${n.content.updated_at || ''}:${(n.content.ocr_text || '').length}:${noteTitleFingerprint(n)}:${n.content.pinned ? 1 : 0}:${n.content.starred ? 1 : 0}:${n.content.warn_at || ''}:${n.content.locked ? 1 : 0}:${n.content.prevent_edit ? 1 : 0}`).join('|');
    return `${currentFilter}:${currentTag || ''}:${currentFolder || ''}:${query}:${sfKey}:${prefs.sort}:${activeListNoteId()}:${ids}`;
  }

  function editorNoteOpen() {
    return !!(currentId && ui.editor && !ui.editor.hidden);
  }

  function activeListNoteId() {
    // Highlight only the note that is actually open. A folder click or a
    // closed editor must not leave a stale row selected in another view.
    return editorNoteOpen() ? currentId : '';
  }

  function markActiveNoteRow() {
    const selected = activeListNoteId();
    const list = ui.noteList;
    if (!list) return;
    list.querySelectorAll('.note-row').forEach((row) => {
      const on = !!selected && row.dataset.id === selected;
      row.classList.toggle('active', on);
      row.querySelector('.note-item')?.classList.toggle('active', on);
    });
  }

  let onlineRecoveryActive = false;
  let offlineWatchTickActive = false;

  async function probeNetwork({ syncOnRecovery = false, forceHealth = false } = {}) {
    // iOS LAN-only Wi‑Fi may report navigator.onLine=false while homelab is reachable.
    // Cellular without WireGuard cannot reach 192.168.x — expect failures there.
    try {
      const data = await fetchHealthJson({ force: forceHealth, timeoutMs: 1500 });
      if (!data || !data.ok) throw new Error('health failed');
      if (data.build) applyServerBuildStatus(data.build);
      const wasOffline = !networkReachable;
      networkReachable = true;
      stopOfflineWatch();
      updateNetworkStatusBanner();
      if (wasOffline) {
        NotesStore.emitSync('idle', '');
        // Round 72: quiet recovery sync gates on unlocked, not only vaultReady.
        // Round 72.1: when online-recovery owns the wave, do not start a parallel
        // syncNow here — abortInflightApi('online-recovery') would race it.
        if (syncOnRecovery && NotesStore.isUnlocked() && !onlineRecoveryActive) {
          const pending = NotesStore.state?.dirty?.size || 0;
          try {
            console.debug('[notes-sync]', new Date().toISOString(), 'sync-start', {
              reason: 'online-recovery',
              pending,
            });
          } catch (err) { /* ignore */ }
          // Always force after offline so a dirty note is not skipped by the
          // "synced recently" throttle. syncInFlight coalesces with recovery.
          syncNow({ quiet: true, force: true });
        }
        if (NotesStore.isUnlocked()) {
          resumePendingOcr().catch(() => {});
          listPreviewBackfillFailed.clear();
          resumePendingListPreviews().catch(() => {});
          uploadPendingDeviceReport({ quiet: true }).catch(() => {});
        }
        if (ocrDeferred.size) scheduleDeferredOcrRetry();
      }
      return true;
    } catch (err) {
      const wasReachable = networkReachable;
      if (networkReachable) {
        networkReachable = false;
        NotesStore.emitSync('offline', 'Offline');
      }
      updateNetworkStatusBanner();
      // Never start a second watch from inside an offline-watch tick — that
      // reset the 2s delay and stacked timers (health every 2–3s).
      if (!onlineRecoveryActive && !offlineWatchTickActive) {
        if (wasReachable || !offlineWatchTimer) startOfflineWatch();
      }
      return false;
    }
  }

  function markNetworkReachable() {
    const wasOffline = !networkReachable;
    networkReachable = true;
    if (wasOffline) NotesStore.emitSync('idle', '');
    updateNetworkStatusBanner();
  }
  window.notesMarkNetworkReachable = markNetworkReachable;

  function selfHostNotes() {
    return document.getElementById('app')?.dataset.selfHost === '1';
  }

  function offlineStatusCopy() {
    if (selfHostNotes()) return 'Can\'t reach the notes server. Join home Wi‑Fi or WireGuard, then try again.';
    return 'You\'re offline. Changes are saved on this device and will sync when you\'re back online.';
  }

  function offlineBannerHtml() {
    if (selfHostNotes()) return `<strong>Offline</strong> — ${escapeHtml(offlineStatusCopy())}`;
    return escapeHtml(offlineStatusCopy());
  }

  const OFFLINE_LAN_HINT = offlineStatusCopy();

  function scheduleNetworkProbe() {
    clearTimeout(networkProbeTimer);
    networkProbeTimer = setTimeout(() => {
      probeNetwork({ syncOnRecovery: true }).catch(() => {});
    }, 30000);
  }

  let offlineWatchTimer = 0;
  let onlineRecoveryGeneration = 0;

  let offlineWatchDelayMs = 2000;

  function stopOfflineWatch() {
    if (offlineWatchTimer) {
      clearTimeout(offlineWatchTimer);
      offlineWatchTimer = 0;
    }
  }

  function nextOfflineWatchDelay(current) {
    // Back off while offline: 2s → 5s → 10s (cap). Avoid ~1/s /api/health spam.
    if (current < 5000) return 5000;
    return 10000;
  }

  function startOfflineWatch() {
    if (offlineWatchTimer || onlineRecoveryActive) return;
    // Keep the current backoff delay when already offline; only the offline
    // event resets it to 2s. Restarting at 2s on every failed probe caused a
    // /api/health hit every 2–3s.
    if (!offlineWatchDelayMs || offlineWatchDelayMs < 2000) offlineWatchDelayMs = 2000;
    const tick = () => {
      offlineWatchTimer = 0;
      if (networkReachable || onlineRecoveryActive) {
        offlineWatchDelayMs = 2000;
        return;
      }
      const finish = (ok) => {
        offlineWatchTickActive = false;
        if (ok) {
          offlineWatchDelayMs = 2000;
          // Round 72.1: probe success must restart recovery (force-pull while
          // unlocked), not only leave networkReachable=true.
          scheduleOnlineRecovery(0);
          return;
        }
        offlineWatchDelayMs = nextOfflineWatchDelay(offlineWatchDelayMs);
        offlineWatchTimer = setTimeout(tick, offlineWatchDelayMs);
      };
      // DevTools Offline often leaves navigator.onLine true while fetch fails.
      // Quiet probe through the shared gate (no reset) — only escalate to
      // recovery on success. Handing off to recovery here reopened the gate
      // every 0.5–4s and caused ~18 health GETs / 30s.
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        offlineWatchTickActive = true;
        probeNetwork({ syncOnRecovery: false, forceHealth: false }).then((ok) => {
          finish(ok);
        }).catch(() => finish(false));
        return;
      }
      // Still offline — no /api/health call; just wait out the backoff window.
      finish(false);
    };
    offlineWatchTimer = setTimeout(tick, offlineWatchDelayMs);
  }

  let lastRecoveryAbortAt = 0;

  const ONLINE_RECOVERY_DELAYS_MS = [0, 1000, 2000, 4000, 8000];

  function clearOnlineRecoveryCaption() {
    try {
      if (
        ui.saveStatus
        && !(NotesStore.state?.dirty?.size)
        && /will sync when online/.test(ui.saveStatus.textContent || '')
      ) {
        ui.saveStatus.textContent = 'Saved';
        ui.saveStatus.classList.remove('error');
      }
    } catch (err) { /* ignore */ }
  }

  function recoveryMayContinue() {
    if (!NotesStore.isUnlocked()) return false;
    // Keep slow-tailing while the page is visible or the browser reports online.
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    return visible || online;
  }

  function stopOnlineRecovery(_reason) {
    clearTimeout(onlineRecoveryTimer);
    onlineRecoveryTimer = null;
    if (!onlineRecoveryActive) return;
    onlineRecoveryActive = false;
    onlineRecoveryGeneration += 1;
  }

  function scheduleOnlineRecovery(attempt = 0) {
    clearTimeout(onlineRecoveryTimer);
    // Round 72: probe immediately, then force-pull retries at 1/2/4/8s.
    // Round 72.1: after the fast window, keep recovery ownership and continue
    // force-pulling every CHANGE_POLL_MS until syncNow returns true (no faster).
    // Health probes still share one in-flight request and global backoff — never
    // abort-storm (R39). Aborted pulls (including abortInflightApi at wave start)
    // are covered by later attempts so no pull is lost.
    const delays = ONLINE_RECOVERY_DELAYS_MS;
    if (attempt === 0) {
      stopOfflineWatch();
      onlineRecoveryActive = true;
      onlineRecoveryGeneration += 1;
      // One abort+health-reset per recovery wave. Re-entrant online events
      // within 500ms only reopen the backoff gate (no second abort).
      const now = Date.now();
      if (now - lastRecoveryAbortAt > 500) {
        lastRecoveryAbortAt = now;
        try { window.__notesResetHealthBackoff?.(); } catch (err) { /* ignore */ }
        NotesStore.abortInflightApi?.('online-recovery');
      } else {
        try { window.__notesResetHealthBackoff?.({ abort: false }); } catch (err) { /* ignore */ }
      }
    }
    const generation = onlineRecoveryGeneration;
    if (!NotesStore.isUnlocked()) {
      onlineRecoveryActive = false;
      return;
    }
    if (attempt > 0 && !recoveryMayContinue()) {
      onlineRecoveryActive = false;
      if (!networkReachable || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        offlineWatchDelayMs = 2000;
        startOfflineWatch();
      }
      return;
    }
    const inSlowTail = attempt >= delays.length;
    const baseDelay = inSlowTail ? CHANGE_POLL_MS : delays[attempt];
    // Wait out the shared health backoff instead of clearing it on every
    // attempt (clearing caused an offline health storm when onLine flickered).
    const gateWait = Math.max(0, (Number(window.__notesHealthNextAt) || 0) - Date.now());
    const wait = Math.max(baseDelay, gateWait);
    onlineRecoveryTimer = setTimeout(() => {
      if (generation !== onlineRecoveryGeneration) return;
      if (!NotesStore.isUnlocked()) {
        onlineRecoveryActive = false;
        return;
      }
      // Always probe — even when dirty is empty — so the Offline caption clears.
      // Recovery owns the force-pull — probe without a parallel syncNow.
      probeNetwork({ syncOnRecovery: false, forceHealth: true }).then(async (ok) => {
        if (generation !== onlineRecoveryGeneration) return { probeOk: false };
        if (!ok) {
          if (!networkReachable) {
            onlineRecoveryActive = false;
            offlineWatchDelayMs = 2000;
            startOfflineWatch();
            return { probeOk: false, offline: true };
          }
          return { probeOk: false };
        }
        // Quiet recovery: gate on unlocked (not only vaultReady) so a shell
        // that is crypto-ready still force-pulls remote edits (pending:0 too).
        if (!NotesStore.isUnlocked()) {
          return { probeOk: true, synced: false, locked: true };
        }
        try {
          console.debug('[notes-sync]', new Date().toISOString(), 'sync-start', {
            reason: 'online-recovery',
            attempt,
            slowTail: inSlowTail,
            pending: NotesStore.state?.dirty?.size || 0,
          });
        } catch (err) { /* ignore */ }
        const synced = await syncNow({ quiet: true, force: true });
        if (!NotesStore.isUnlocked()) {
          return { probeOk: true, synced: false, locked: true };
        }
        return { probeOk: true, synced: synced === true };
      }).then((result) => {
        if (generation !== onlineRecoveryGeneration) return;
        if (result?.offline) return;
        if (result?.synced) {
          onlineRecoveryActive = false;
          stopOfflineWatch();
          clearOnlineRecoveryCaption();
          if (!sessionExpiredHold) scheduleChangePoll();
          return;
        }
        if (result?.locked) {
          onlineRecoveryActive = false;
          stopOfflineWatch();
          return;
        }
        // Probe failed, or pull aborted/failed — retry (fast window, then slow tail).
        scheduleOnlineRecovery(attempt + 1);
      }).catch(() => {
        if (generation !== onlineRecoveryGeneration) return;
        scheduleOnlineRecovery(attempt + 1);
      });
    }, wait);
  }

  function listStoredFiles({ query = '', tagId = null, folderId = null, titlesOnly = false, includeProtected = false } = {}) {
    const files = [];
    const attachments = typeof NotesStore.listVisibleAttachments === 'function'
      ? NotesStore.listVisibleAttachments()
      : NotesStore.listAttachments();
    for (const att of attachments) {
      const note = NotesStore.get(att.content.note_id);
      if (!note || note.deleted || note.content?.trashed || note.content?.archived) continue;
      if (tagId && !(note.content.tags || []).includes(tagId)) continue;
      if (folderId && note.content.folder_id !== folderId) continue;
      if (!NotesSearch.fileRowMatches(att, note, query, { titlesOnly, includeProtected })) continue;
      files.push({ att, note });
    }
    const sort = NOTE_SORT_ORDER.includes(prefs.sort) ? prefs.sort : 'updated';
    files.sort((a, b) => {
      if (sort === 'title') {
        const na = String(a.att.content.filename || a.att.content.original_filename || a.note.content.title || '');
        const nb = String(b.att.content.filename || b.att.content.original_filename || b.note.content.title || '');
        return na.localeCompare(nb);
      }
      const fileMs = (file, useCreated) => (
        useCreated ? noteCreatedAtMs(file.note) : noteEditedAtMs(file.note)
      );
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
    const assigned = [...new Set(note?.content?.tags || [])]
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

  function noteRowActionTitle(note) {
    return String(NotesSearch.effectiveNoteTitle?.(note) || '').trim() || 'Untitled';
  }

  function syncNoteRowActionLabels(noteId, displayTitle) {
    if (!ui.noteList || !noteId) return;
    const row = ui.noteList.querySelector(`.note-row[data-id="${CSS.escape(noteId)}"]`);
    if (!row) return;
    const note = NotesStore.get(noteId);
    const title = String(displayTitle || noteRowActionTitle(note)).trim() || 'Untitled';
    row.querySelectorAll('.note-swipe-delete, .note-row-delete, .note-row-restore').forEach((btn) => {
      let verb = noteRowDeleteLabel(note);
      if (btn.dataset.action === 'restore' || btn.classList.contains('note-row-restore')) verb = 'Restore';
      else if (btn.dataset.action === 'trash') verb = 'Trash';
      btn.setAttribute('aria-label', `${verb} note ${title}`);
    });
  }

  function noteRowSwipeDeleteHtml(note) {
    const trashed = !!note?.content?.trashed;
    const label = trashed ? 'Restore' : noteRowDeleteLabel(note);
    const id = escapeAttr(note.uuid);
    const action = trashed ? 'restore' : 'trash';
    const tone = trashed ? ' is-restore' : '';
    const title = escapeAttr(noteRowActionTitle(note));
    return `<button type="button" class="note-swipe-delete${tone}" data-id="${id}" data-action="${action}" aria-label="${label} note ${title}">${label}</button>`;
  }

  function noteRowRestoreBtnHtml(note) {
    if (!note?.content?.trashed) return '';
    const id = escapeAttr(note.uuid);
    const title = escapeAttr(noteRowActionTitle(note));
    return `<button type="button" class="note-row-restore" data-id="${id}" data-action="restore" aria-label="Restore note ${title}" title="Restore">Restore</button>`;
  }

  function noteRowDeleteBtnHtml(note) {
    const label = noteRowDeleteLabel(note);
    const id = escapeAttr(note.uuid);
    const title = escapeAttr(noteRowActionTitle(note));
    return `<button type="button" class="note-row-delete" data-id="${id}" aria-label="${label} note ${title}" title="${label}">×</button>`;
  }

  function noteRowMoreBtnHtml(note) {
    if (note?.deleted || note?.content?.trashed) return '';
    if (note?.content?.locked && !unlockedNotes.has(note.uuid)) return '';
    const id = escapeAttr(note.uuid);
    const title = escapeAttr(noteRowActionTitle(note));
    return `<button type="button" class="note-row-more" data-id="${id}" aria-label="More actions for ${title}" title="More actions" aria-haspopup="menu">⋯</button>`;
  }

  function noteRowStatusGlyphs(note) {
    if (!note?.content) return '';
    const parts = [];
    const hidePin = currentFilter === 'trash' || currentFilter === 'archived';
    if (!hidePin && note.content.starred) {
      parts.push('<span class="note-glyph note-glyph-star" title="Starred" aria-label="Starred">★</span>');
    } else if (!hidePin && note.content.pinned) {
      parts.push('<span class="note-glyph note-glyph-pin" title="Pinned" aria-label="Pinned">📌</span>');
    }
    if (note.content.locked) {
      parts.push('<span class="note-glyph note-glyph-lock" title="Protected" aria-label="Protected">🔒</span>');
    } else if (note.content.prevent_edit) {
      parts.push('<span class="note-glyph note-glyph-lock" title="Read only" aria-label="Read only">🔒</span>');
    }
    return parts.join('');
  }

  function noteRowSecondaryLine(note, query) {
    const tags = noteTagChipsHtml(note);
    const kind = noteKindMeta(note).label;
    const bits = [tags, kind ? `<span class="note-kind-label">${escapeHtml(kind)}</span>` : ''].filter(Boolean);
    if (!bits.length) return '';
    return `<span class="note-item-secondary">${bits.join('')}</span>`;
  }

  function noteLockBadgeHtml(note) {
    if (!note?.content) return '';
    if (noteListDensity() === 'compact') return '';
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
    const kind = NotesPreview.kindFromMeta(att.content.mime, attachmentKindName(att.content) || name);
    const showThumb = !isLocked && (kind === 'image' || kind === 'pdf') && !prefs.hidePreviews;
    const noteTitle = note.content.title || 'Untitled';
    const kindLabel = attachmentThumbLabel(kind);
    const snippet = isLocked ? '' : (noteTitle && noteTitle !== name ? noteTitle : kindLabel);
    const titleHtml = query ? NotesSearch.highlightPlain(name, query) : escapeHtml(name);
    const snippetHtml = isLocked
      ? '<span class="note-preview-locked"><svg class="preview-lock-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Protected document</span>'
      : (query ? NotesSearch.highlightPlain(snippet, query) : escapeHtml(snippet));
    const sortMode = NOTE_SORT_ORDER.includes(prefs.sort) ? prefs.sort : 'updated';
    const editedMs = noteListSectionMs(note, sortMode);
    const timeTitle = listTimeAbsolute(editedMs);
    const timeLabel = listTimeLabel(editedMs);
    const compact = noteListDensity() === 'compact';
    const icon = kind === 'image'
      ? { icon: '🖼', tone: 'note' }
      : kind === 'pdf'
        ? { icon: '📄', tone: 'note', svg: kindIconSvg('note') }
        : { icon: '📎', tone: 'note', svg: kindIconSvg('note') };
    return `<div class="note-row ${active} ${protectedClass}" data-id="${escapeAttr(note.uuid)}">
      ${noteRowSwipeDeleteHtml(note)}
      ${noteRowRestoreBtnHtml(note)}
      ${noteRowMoreBtnHtml(note)}
      ${noteRowDeleteBtnHtml(note)}
      <button type="button" class="note-item ${active}" data-id="${escapeAttr(note.uuid)}">
        ${showThumb
    ? listThumbHtml(att, note.uuid, icon, kindLabel)
    : kindIconHtml(icon, kindLabel)}
        <span class="note-item-body">
          <span class="note-title-row">
            <h3>${titleHtml}</h3>
            <span class="note-row-trailing">${noteRowStatusGlyphs(note)}<span class="note-modified" data-edited="${editedMs || ''}" title="${escapeAttr(timeTitle)}">${escapeHtml(timeLabel)}</span></span>
          </span>
          ${lockBadgeHtml ? `<span class="note-item-lock-row">${lockBadgeHtml}</span>` : ''}
          ${compact ? '' : noteRowSecondaryLine(note, query)}
          ${(prefs.hidePreviews || compact) ? '' : `<p class="note-preview">${snippetHtml}</p>`}
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
    const match = query && !isLocked ? NotesSearch.describeMatch(n, query, tagMap(), { folderMap: folderMap() }) : null;
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
    const displayTitle = NotesSearch.effectiveNoteTitle(n);
    const displaySnippet = String(snippet).slice(0, 120);
    const titleAttr = displayTitle ? ` title="${escapeAttr(displayTitle)}"` : '';
    const titleHtml = displayTitle
      ? (query ? NotesSearch.highlightPlain(displayTitle, query) : escapeHtml(displayTitle))
      : '<span class="note-title-placeholder">Untitled</span>';
    const editedMs = noteEditedAtMs(n);
    const timeTitle = listTimeAbsolute(editedMs);
    const timeLabel = listTimeLabel(editedMs);
    const compact = noteListDensity() === 'compact';
    const kind = noteKindMeta(n);
    const firstAtt = atts[0];
    const thumbKind = firstAtt
      ? NotesPreview.kindFromMeta(firstAtt.content.mime, attachmentKindName(firstAtt.content))
      : null;
    const showListThumb = !isLocked
      && firstAtt
      && (thumbKind === 'image' || thumbKind === 'pdf')
      && !prefs.hidePreviews;
    const titleMarked = query && displayTitle
      ? NotesSearch.highlightPlain(displayTitle, query).includes('search-hit')
      : false;
    const fileMatch = !!(match && match.field && match.field !== 'title' && displaySnippet);
    const previewHtml = isLocked
      ? ((prefs.hidePreviews || compact)
        ? ''
        : '<p class="note-preview note-preview-locked"><svg class="preview-lock-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Protected note</p>')
      : ((prefs.hidePreviews || compact) && !(fileMatch && !titleMarked)
        ? ''
        : noteListPreview(n, displaySnippet, query));
    const glyphs = noteRowStatusGlyphs(n);
    const where = match
      ? `<span class="note-modified note-match-label">${escapeHtml(match.label)}</span>`
      : `<span class="note-modified" data-edited="${editedMs || ''}" title="${escapeAttr(timeTitle)}">${escapeHtml(timeLabel)}</span>`;
    const trailing = `<span class="note-row-trailing">${glyphs}${where}</span>`;
    const secondary = compact ? '' : noteRowSecondaryLine(n, query);
    return `<div class="note-row ${active} ${protectedClass}" data-id="${escapeAttr(n.uuid)}">
      ${noteRowSwipeDeleteHtml(n)}
      ${noteRowRestoreBtnHtml(n)}
      ${noteRowMoreBtnHtml(n)}
      ${noteRowDeleteBtnHtml(n)}
      <button type="button" class="note-item ${active}" data-id="${escapeAttr(n.uuid)}">
        ${showListThumb
    ? listThumbHtml(firstAtt, n.uuid, kind, firstAtt ? attachmentThumbLabel(thumbKind) : '')
    : kindIconHtml(kind, firstAtt ? attachmentThumbLabel(thumbKind) : '')}
        <span class="note-item-body">
          <span class="note-title-row">
            <h3${titleAttr}>${titleHtml}</h3>${noteIndexingBadge(n.uuid)}
            ${trailing}
          </span>
          ${lockBadgeHtml ? `<span class="note-item-lock-row">${lockBadgeHtml}</span>` : ''}
          ${secondary}
          ${previewHtml}
        </span>
      </button>
    </div>`;
  }

  const NOTE_LIST_VIRTUAL_THRESHOLD = 120;
  const NOTE_ROW_ESTIMATE = 48;

  // Real rows are taller than the initial guess once tags/"Modified" lines show,
  // so the estimate is re-measured from rendered rows after every paint.
  let noteRowEstimate = NOTE_ROW_ESTIMATE;
  let lastVirtualWindow = null;
  let virtualSettleDepth = 0;

  function virtualListWindow(total, scrollTop, viewHeight, rowHeight = noteRowEstimate) {
    const virtualThreshold = NOTE_LIST_VIRTUAL_THRESHOLD;
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
    const virtualThreshold = NOTE_LIST_VIRTUAL_THRESHOLD;
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
    const listContextKey = `${currentFilter}:${currentTag || ''}:${currentFolder || ''}:${query}:${prefs.sort}`;
    if (listContextKey !== lastListContextKey) {
      lastListContextKey = listContextKey;
      ui.noteList.scrollTop = 0;
    }
    const searchOptions = searchFilterOptions();
    const listingFiles = currentFilter === 'documents';
    const filtered = listingFiles ? [] : NotesSearch.filterNotes(NotesStore.listNotes(), {
      query: ui.search.value,
      filter: currentFilter,
      tagId: currentTag,
      folderId: currentFolder,
      tagMap: tagMap(),
      folderMap: folderMap(),
      sort: prefs.sort,
      searchOptions,
    });
    const titlesOnlyFallback = !!filtered.titlesOnlyFallback;
    const notes = filtered.filter((note) => noteShouldList(note));
    const files = listingFiles ? listStoredFiles({
      query,
      tagId: currentTag,
      folderId: currentFolder,
      titlesOnly: searchOptions.titlesOnly,
      includeProtected: searchOptions.includeProtected,
    }) : [];
    const listed = listingFiles ? files : notes;
    const listedCount = listed.length;
    const meta = document.getElementById('search-meta');
    const listHead = document.getElementById('note-list-head');
    const listTitle = document.getElementById('note-list-title');
    const listCount = document.getElementById('note-list-count');
    const context = NotesSearch.searchContextActive(query, searchOptions);
    document.body.classList.toggle('list-search-active', !!query);
    const countLabel = NotesSearch.listCountLabel(listedCount, { files: listingFiles });
    if (query || context) {
      const summary = listedCount
        ? countLabel
        : (query ? (listingFiles ? 'No files match that search' : 'No notes match that search') : 'No notes match these filters');
      if (meta) {
        if (titlesOnlyFallback) {
          // The vault was too large to search note text; say so instead of
          // quietly listing titles only.
          meta.textContent = `${summary} · titles only, note text and scans were skipped`;
          meta.hidden = false;
        } else {
          meta.textContent = summary;
          meta.hidden = !!query;
        }
      }
    } else if (meta) {
      meta.hidden = true;
    }
    if (listHead && listTitle && listCount) {
      const tag = currentTag ? tagMap().get(currentTag) : null;
      const folder = currentFolder ? NotesStore.get(currentFolder) : null;
      listHead.hidden = false;
      listTitle.textContent = folder
        ? (folder.content.title || 'Folder')
        : (tag ? tag.content.title || 'Tag' : (FILTER_TITLES[currentFilter] || 'Notes'));
      // Note-list count only. PDF highlight totals stay on the document banner.
      listCount.textContent = countLabel;
      listCount.title = countLabel;
      syncFilterSelect();
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
              <div class="note-list-download-progress sync-status-progress-track" role="progressbar" aria-label="Notes download progress" aria-busy="true">
                <span class="is-indeterminate"></span>
              </div>
            </div>`;
          updateVaultPullHead();
          renderVaultStats();
          return;
        }
      }
      ui.noteList.innerHTML = query
        ? `<div class="note-list-empty"><p class="note-list-empty-title">No ${listingFiles ? 'files' : 'notes'} match “${escapeHtml(query)}”</p><p class="muted">${listingFiles ? 'Try a filename or the note the file is attached to.' : 'Clear the search or filters to see every note.'}</p></div>`
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
              <p class="note-list-empty-title">${escapeHtml(emptyNotesCopy().title)}</p>
              <p class="muted">${escapeHtml(emptyNotesCopy().body)}</p>
              ${emptyListActionsHtml()}
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
          let at = noteListSectionMs(file.note, sortMode);
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
      const hoistPinned = currentFilter !== 'pinned'
        && currentFilter !== 'trash'
        && currentFilter !== 'archived';
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
    const sectionCount = sections.reduce((count, section) => count + section.items.length, 0);
    if (!listingFiles && sectionCount < notes.length) {
      const seen = new Set(sections.flatMap((section) => section.items.map((note) => note.uuid)));
      const missing = notes.filter((note) => !seen.has(note.uuid));
      if (missing.length) sections.push({ label: '', items: missing });
    }
    ui.noteList.innerHTML = buildNoteListSectionsHtml(sections, query);
    if (listedCount > 0 && !ui.noteList.querySelector('.note-row')) {
      ui.noteList.scrollTop = 0;
      const flat = listingFiles
        ? files.map((file) => renderFileRow(file, query)).join('')
        : notes.map((note) => renderNoteRow(note, query)).join('');
      ui.noteList.innerHTML = `<div class="note-section" data-virtual="0">${flat}</div>`;
    }
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
    return compactLayoutActive();
  }

  function isDesktopLayout() {
    return !compactLayoutActive();
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
        toast('Tag already exists');
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
        return `<button type="button" class="tag-chip ${on}" data-toggle-tag="${escapeAttr(t.uuid)}" aria-pressed="${on ? 'true' : 'false'}" title="${escapeAttr(t.content.title || '')}" style="--tag-color:${safeColor(color)}">
          <span class="tag-dot"></span><span class="tag-chip-label">${escapeHtml(t.content.title)}</span>
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
      tagInput.addEventListener('input', () => syncTagLimitHint(tagInput));
      syncTagLimitHint(tagInput);
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

  function formatAttachmentSize(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) {
      const kb = n / 1024;
      return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderAttachments(noteId) {
    if (noteId == null || noteId === '') {
      if (ui.attachmentList) ui.attachmentList.innerHTML = '';
      if (ui.docInline) {
        ui.docInline.hidden = true;
        ui.docInline.innerHTML = '';
      }
      return;
    }
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
    const items = NotesStore.listAttachments(noteId).filter((a) => a.content?.note_id === noteId);
    const attLabel = document.querySelector('.attachments .section-label');
    if (attLabel) {
      if (items.length > 1) {
        attLabel.innerHTML = `<button type="button" class="section-label-btn" id="attachment-gallery-open" aria-label="Open attachment gallery">${items.length} items</button>`;
      } else {
        attLabel.textContent = 'Attachments';
      }
    }
    const ownedIds = Array.isArray(note?.content?.attachments) ? note.content.attachments : [];
    const pendingFiles = Array.isArray(note?.content?.sn_pending_files) ? note.content.sn_pending_files : [];
    const pending = pendingFiles.filter((item) => !ownedIds.includes(item.uuid));
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
    const rowQuery = activeFindNeedle();
    ui.attachmentList.innerHTML = items
      .map((a) => {
        const sizeLabel = formatAttachmentSize(a.content.size || 0);
        const { html: status } = attachmentOcrStatus(a);
        const busy = attachmentOcrBusy(a);
        const spinner = busy ? attachmentOcrSpinnerHtml() : '';
        const succeeded = attachmentOcrSucceeded(a);
        const retryBtn = !succeeded && attachmentOcrRetryable(a)
          ? `<button type="button" class="btn ghost sm ocr-retry" data-retry-ocr="${escapeAttr(a.uuid)}">Retry OCR</button>`
          : '';
        const serverCopyBtn = `<button type="button" class="btn ghost sm" data-server-copy="${escapeAttr(a.uuid)}">Server copy</button>`;
        const rerunBtn = succeeded
          ? `<details class="attachment-overflow"><summary class="btn ghost sm" aria-label="More file actions">⋯</summary><div class="attachment-overflow-menu"><button type="button" class="btn ghost sm ocr-retry" data-retry-ocr="${escapeAttr(a.uuid)}">Re-run OCR</button>${serverCopyBtn}</div></details>`
          : `<details class="attachment-overflow"><summary class="btn ghost sm" aria-label="More file actions">⋯</summary><div class="attachment-overflow-menu">${serverCopyBtn}</div></details>`;
        const hideAttShare = isPhoneShell() && mobileDocToolbarActive();
        const shareBtn = !hideAttShare && attachmentCanWebShare()
          ? `<button type="button" class="btn ghost sm" data-share="${escapeAttr(a.uuid)}">Share</button>`
          : '';
        const hitCount = rowQuery ? NotesSearch.attachmentHitCount(a, rowQuery) : 0;
        const nameHit = rowQuery ? NotesSearch.highlightPlain(a.content.filename || '', rowQuery) : '';
        const fileHit = !!(rowQuery && (hitCount || (nameHit && nameHit.includes('search-hit'))));
        const hitLabel = NotesSearch.attachmentHighlightLabel(hitCount);
        const hitBadge = hitLabel
          ? `<span class="attachment-hit-badge" data-att-hits="${hitCount}">${escapeHtml(hitLabel)}</span>`
          : '';
        const rowClass = `attachment-item${busy ? ' is-ocr-busy' : ''}${fileHit ? ' is-search-hit' : ''}`;
        const thumbKind = attachmentKind(a);
        const thumbLabel = attachmentThumbLabel(thumbKind);
        return `<div class="${rowClass}" data-att="${escapeAttr(a.uuid)}">
          <button type="button" class="attachment-thumb" data-preview="${escapeAttr(a.uuid)}" aria-label="Preview ${escapeAttr(a.content.filename || 'document')}"><span class="thumb-paint">${escapeHtml(thumbLabel)}</span>${attachmentBadgeHtml(thumbLabel)}</button>
          <div class="attachment-main">
            <strong class="attachment-filename">${rowQuery ? nameHit : escapeHtml(a.content.filename)}</strong>${spinner}
            <span class="muted"> (${sizeLabel})</span>
            ${hitBadge}
            ${status}
          </div>
          <div class="attachment-item-actions">
            ${retryBtn}${rerunBtn}
            <button type="button" class="btn ghost sm" data-preview="${escapeAttr(a.uuid)}">Preview</button>
            ${shareBtn}
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
        const attId = btn.dataset.rm;
        const existing = NotesStore.get(attId);
        const snapshot = existing?.content ? { ...existing.content } : null;
        const note = NotesStore.get(noteId);
        const previousIds = Array.isArray(note?.content?.attachments) ? [...note.content.attachments] : [];
        forgetPreview(attId);
        purgeServerOcr(attId);
        NotesStore.remove(attId);
        if (note) {
          const ids = previousIds.filter((id) => id !== attId);
          NotesStore.upsert(noteId, { ...note.content, attachments: ids });
        }
        NotesStore.refreshNoteSearchText(noteId);
        renderAttachments(noteId);
        renderNotes();
        if (!snapshot) return;
        toastWithUndo('Attachment removed', () => {
          const restored = { ...snapshot };
          delete restored.deleted;
          NotesStore.upsert(attId, restored, { touchUpdatedAt: false });
          const live = NotesStore.get(noteId);
          if (live) {
            const ids = Array.isArray(live.content.attachments) ? [...live.content.attachments] : [];
            if (!ids.includes(attId)) ids.push(attId);
            NotesStore.upsert(noteId, { ...live.content, attachments: ids });
          }
          if (typeof NotesStore.refreshNoteSearchText === 'function') NotesStore.refreshNoteSearchText(noteId);
          renderAttachments(noteId);
          renderNotes();
        });
      });
    });
    ui.attachmentList.querySelectorAll('[data-retry-ocr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        retryAttachmentOcr(btn.dataset.retryOcr).catch((err) => toast(err.message || 'OCR retry failed', true));
      });
    });
    ui.attachmentList.querySelectorAll('[data-server-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openServerCopyView(btn.dataset.serverCopy).catch((err) => toast(err.message || 'Could not load server copy', true));
      });
    });
    ui.attachmentList.querySelectorAll('[data-pending-add]').forEach((btn) => {
      btn.addEventListener('click', () => openHiddenFileInput(ui.attachmentInput));
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
    syncDownloadNoteButton();
    syncRescanOcrButton();
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
    if (typeof NotesStore.repairStoredAttachmentCopies === 'function') {
      NotesStore.repairStoredAttachmentCopies();
    }
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

  function attachmentOcrSucceeded(att) {
    const method = String(att?.content?.ocr_method || '');
    if (!method || method === 'failed' || method === 'none' || method === 'pending' || method === 'unsupported') return false;
    return !!String(att?.content?.ocr_text || '').trim();
  }

  function attachmentOcrRetryable(att) {
    if (!attachmentIsPdfOrPhoto(att)) return false;
    if (!canOcrAttachment(att)) return false;
    const attId = att?.uuid;
    if (attId && (rescanOcrIds.has(attId) || ocrWaitingServer.has(attId) || ocrInFlight.has(attId) || ocrQueued.has(attId))) {
      return false;
    }
    const method = att?.content?.ocr_method || '';
    if (method === 'pending' && !ocrPendingStale(att)) return false;
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
    if (attId && (rescanOcrIds.has(attId) || ocrInFlight.has(attId) || ocrQueued.has(attId))) {
      return {
        html: '<p class="ocr-text">Reading text on this device…</p>',
        retry: false,
      };
    }
    const method = att?.content?.ocr_method || '';
    if (method === 'pending' && !ocrPendingStale(att)) {
      return {
        html: '<p class="ocr-text">Indexing…</p>',
        retry: false,
      };
    }
    if (!method || method === 'unsupported') {
      if (!attachmentIsIndexable(att) || method === 'unsupported') {
        return {
          html: '<p class="ocr-text">This file type is not indexed.</p>',
          retry: false,
        };
      }
      return {
        html: '<p class="ocr-text">Reading text on this device…</p>',
        retry: false,
      };
    }
    if (method === 'failed') {
      const retry = attachmentIsPdfOrPhoto(att);
      return {
        html: retry
          ? '<p class="ocr-text ocr-failed">Could not read text. Tap Retry OCR to try again.</p>'
          : '<p class="ocr-text ocr-failed">Could not read text from this file.</p>',
        retry,
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
    const plainText = method === 'text'
      || method === 'pdftext'
      || window.NotesOcrQuality?.isPlainTextAttachment?.(att.content?.mime, att.content?.filename);
    if (text && !plainText && ocrResultWeak(text, boxes, att.content?.mime, att.content?.filename)) {
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
      const query = String(ui.search?.value || '').trim();
      const snippetHtml = query ? NotesSearch.highlightPlain(snippet, query) : escapeHtml(snippet);
      return {
        html: `<p class="ocr-text ocr-ready">Searchable · ${snippetHtml}</p>`,
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

  function attachmentIsPdfOrPhoto(item) {
    const mime = String(item?.content?.mime || '');
    const name = String(item?.content?.filename || '');
    return mime.startsWith('image/')
      || mime === 'application/pdf'
      || /\.(pdf|png|jpe?g|webp|gif|bmp|hei[cf])$/i.test(name);
  }

  function notePdfOrPhotoAttachments(noteId) {
    const id = noteId || currentId;
    if (!id) return [];
    return NotesStore.listAttachments(id).filter(attachmentIsPdfOrPhoto);
  }

  function syncRescanOcrButton() {
    const btn = document.getElementById('btn-rescan-ocr');
    if (!btn) return;
    const note = currentId ? NotesStore.get(currentId) : null;
    const gated = !!(note?.content?.locked && !unlockedNotes.has(currentId));
    const show = !!currentId && !gated && notePdfOrPhotoAttachments(currentId).length > 0;
    btn.hidden = !show;
    btn.disabled = !!rescanOcrBusy;
    if (!rescanOcrBusy) setEditorMenuLabel(btn, 'Rescan with OCR');
  }

  async function rescanOpenNoteOcr() {
    if (!currentId) return;
    if (rescanOcrBusy) {
      toast('Rescan already running');
      return;
    }
    const noteId = currentId;
    const targets = notePdfOrPhotoAttachments(noteId);
    if (!targets.length) return;
    rescanOcrBusy = true;
    targets.forEach((att) => rescanOcrIds.add(att.uuid));
    const btn = document.getElementById('btn-rescan-ocr');
    if (btn) setEditorMenuLabel(btn, 'Rescanning…');
    syncRescanOcrButton();
    scheduleOcrUiRefresh([noteId]);
    let failed = 0;
    let updated = 0;
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const att = targets[i];
        const name = att.content?.filename || 'document';
        toast(`Rescanning ${name} (${i + 1} of ${targets.length})…`);
        try {
          const bytes = await NotesStore.getAttachmentBytes(att.uuid);
          if (!bytes) throw new Error('File is not on this device');
          const mime = att.content?.mime || 'application/octet-stream';
          const file = new File([bytes], name, { type: mime });
          if (!window.NotesOcr?.extractFromFile) throw new Error('OCR is not available on this device');
          const ocr = await NotesOcr.extractFromFile(file, (msg) => {
            if (!msg || typeof msg.progress !== 'number') return;
            const now = Date.now();
            if (now - ocrProgressToastAt < 1200) return;
            ocrProgressToastAt = now;
            toast(`Rescanning ${name} ${Math.round(msg.progress * 100)}%`);
          }, att.uuid);
          const live = NotesStore.get(att.uuid);
          if (!live || live.content?.type !== 'attachment') throw new Error('Attachment disappeared');
          const stored = normalizeOcrStorage(
            String(ocr?.text || '').trim(),
            Array.isArray(ocr?.boxes) ? ocr.boxes : [],
            live.content.mime,
            live.content.filename,
            ocr?.ocr_quality,
            ocr?.method || 'client',
          );
          NotesStore.setAttachmentOcr(
            att.uuid,
            stored.text,
            stored.method,
            Array.isArray(ocr?.boxes) ? ocr.boxes : [],
          );
          if (ocr?.preview_jpeg?.length) {
            await NotesStore.setAttachmentPreview(att.uuid, ocr.preview_jpeg);
          }
          NotesStore.refreshNoteSearchText(noteId);
          updated += 1;
          const snippet = String(stored.text || '').trim();
          const short = snippet.length > 48 ? `${snippet.slice(0, 48)}…` : snippet;
          if (targets.length === 1) {
            toast(short ? `Searchable · ${short}` : 'OCR finished — no text found', !short);
          }
        } catch (err) {
          failed += 1;
          toast(`Could not rescan ${name}: ${err.message || 'OCR failed'}`, true);
        } finally {
          rescanOcrIds.delete(att.uuid);
          scheduleOcrUiRefresh([noteId]);
        }
      }
      if (updated > 1 && !failed) toast(`Rescanned ${updated} files`);
      else if (failed && updated) toast(`Rescan finished with ${failed} failure${failed === 1 ? '' : 's'}`, true);
    } finally {
      targets.forEach((att) => rescanOcrIds.delete(att.uuid));
      rescanOcrBusy = false;
      syncRescanOcrButton();
      scheduleOcrUiRefresh([noteId]);
    }
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
  let docViewerReturnFocus = null;
  let docGallery = null;

  function attachmentIdsForNote(noteId) {
    if (typeof NotesStore.visibleAttachmentIds === 'function') {
      return NotesStore.visibleAttachmentIds(noteId);
    }
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
  const listThumbPx = new Map(); // attId -> pixel size that URL was built at
  const LIST_THUMB_PX = 112;
  const THUMB_CSS_PX = 72;
  let thumbQueue = Promise.resolve();
  const listPreviewBackfill = new Set();
  const listPreviewBackfillFailed = new Set();
  let listPreviewBackfillQueue = Promise.resolve();

  function queueListPreviewBackfill(attId, { force = false } = {}) {
    if (!attId || listPreviewBackfill.has(attId)) return;
    if (heavyPreviewDeferred(attId)) return;
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

  function takeListThumb(id) {
    const url = listThumbCache.get(id);
    if (!url) return '';
    if (listThumbPx.get(id) !== thumbOutputPx()) {
      try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ }
      listThumbCache.delete(id);
      listThumbPx.delete(id);
      return '';
    }
    return url;
  }

  function putListThumb(id, url) {
    listThumbCache.set(id, url);
    listThumbPx.set(id, thumbOutputPx());
  }

  async function paintListThumbFromPreviewEnc(id, stage) {
    const bytes = await NotesStore.getAttachmentPreviewBytes(id);
    if (!bytes?.length) return false;
    let url = takeListThumb(id);
    if (!url) {
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      putListThumb(id, url);
    }
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    const noteId = stage.dataset.noteId || '';
    const paint = thumbPaintRoot(stage);
    attachListThumbErrorHandler(img, stage, noteId, id);
    const show = () => {
      if (!stage.isConnected || !img.naturalWidth) return;
      const fitted = fitThumbCanvas(img);
      paint.replaceChildren(fitted || img);
    };
    img.addEventListener('load', show);
    img.src = url;
    if (img.complete && img.naturalWidth) show();
    return true;
  }

  function clearListThumbCache() {
    for (const url of listThumbCache.values()) {
      try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ }
    }
    listThumbCache.clear();
    listThumbPx.clear();
  }

  function thumbInkBox(source) {
    const sw = source.naturalWidth || source.width || 0;
    const sh = source.naturalHeight || source.height || 0;
    if (!sw || !sh) return null;
    const maxScan = 160;
    const scale = Math.min(1, maxScan / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const scan = document.createElement('canvas');
    scan.width = w;
    scan.height = h;
    const ctx = scan.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    try {
      ctx.drawImage(source, 0, 0, w, h);
    } catch (err) {
      return null;
    }
    let pixels;
    try {
      pixels = ctx.getImageData(0, 0, w, h).data;
    } catch (err) {
      return null;
    }
    const step = Math.max(1, Math.floor(Math.min(w, h) / 80));
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        if (a < 20) continue;
        if (r > 244 && g > 244 && b > 244) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return { scan, full: true, x: 0, y: 0, w, h };
    const pad = step;
    const x = Math.max(0, minX - pad);
    const y = Math.max(0, minY - pad);
    const bw = Math.min(w - x, (maxX - minX + 1) + pad * 2);
    const bh = Math.min(h - y, (maxY - minY + 1) + pad * 2);
    const coverage = (bw * bh) / (w * h);
    return { scan, full: coverage > 0.72, x, y, w: bw, h: bh };
  }

  function thumbOutputPx() {
    const dpr = Math.min(3, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const scale = Math.min(3, Math.max(2, dpr));
    return Math.max(LIST_THUMB_PX, Math.round(LIST_THUMB_PX * dpr), Math.round(THUMB_CSS_PX * scale));
  }

  function fitThumbCanvas(source, { cropInk = false } = {}) {
    const box = thumbInkBox(source);
    if (!box) return null;
    const srcW = source.naturalWidth || source.videoWidth || source.width || box.scan.width;
    const srcH = source.naturalHeight || source.videoHeight || source.height || box.scan.height;
    const side = thumbOutputPx();
    const out = document.createElement('canvas');
    out.width = side;
    out.height = side;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, side, side);
    let sx = 0;
    let sy = 0;
    let sw = Math.max(1, srcW);
    let sh = Math.max(1, srcH);
    // PDF list thumbs contain the ink of page 1 so a letter page is not a
    // blank tile. Images stay whole-frame. Never cover-crop a short strip.
    if (cropInk && !box.full && box.scan && box.scan.width && box.scan.height) {
      const scaleX = srcW / box.scan.width;
      const scaleY = srcH / box.scan.height;
      sx = Math.max(0, Math.floor(box.x * scaleX));
      sy = Math.max(0, Math.floor(box.y * scaleY));
      sw = Math.max(1, Math.min(srcW - sx, Math.ceil(box.w * scaleX)));
      sh = Math.max(1, Math.min(srcH - sy, Math.ceil(box.h * scaleY)));
    }
    const fit = Math.min(side / sw, side / sh);
    // A stored preview smaller than the tile must not be blown up in software.
    if (fit >= 1) {
      out.width = Math.max(1, Math.round(sw));
      out.height = Math.max(1, Math.round(sh));
      const nativeCtx = out.getContext('2d');
      if (!nativeCtx) return null;
      nativeCtx.imageSmoothingEnabled = true;
      nativeCtx.imageSmoothingQuality = 'high';
      nativeCtx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
      return out;
    }
    const dw = Math.max(1, Math.round(sw * fit));
    const dh = Math.max(1, Math.round(sh * fit));
    const dx = Math.round((side - dw) / 2);
    const dy = Math.round((side - dh) / 2);
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    return out;
  }

  function paintFittedThumb(node) {
    const canvas = node?.tagName === 'CANVAS' ? node : node?.querySelector?.('canvas');
    if (!canvas || !canvas.width) return;
    const fitted = fitThumbCanvas(canvas);
    if (!fitted) return;
    fitted.className = canvas.className || '';
    canvas.replaceWith(fitted);
  }

  function thumbLooksTexty(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width < 8 || canvas.height < 8) return false;
    let pixels;
    try {
      pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (err) {
      return false;
    }
    const step = Math.max(1, Math.floor((canvas.width * canvas.height) / 2500));
    let paper = 0;
    let ink = 0;
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4 * step) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      n += 1;
      if (min > 220 && max > 230) paper += 1;
      else if (max < 90) ink += 1;
    }
    return n > 0 && paper / n > 0.45 && ink / n > 0.02;
  }

  async function makeListThumbUrl(id, entry) {
    const cached = takeListThumb(id);
    if (cached) return cached;
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.addEventListener('load', () => resolve());
      img.addEventListener('error', () => reject(new Error('image decode failed')));
      img.src = entry.url;
    });
    const fitted = fitThumbCanvas(img);
    const canvas = fitted || document.createElement('canvas');
    if (!fitted) {
      const side = Math.max(img.naturalWidth, img.naturalHeight) || 1;
      const scale = Math.min(1, thumbOutputPx() / side);
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    img.src = '';
    const scan = thumbLooksTexty(canvas);
    const blob = await new Promise((resolve) => {
      if (scan) canvas.toBlob(resolve, 'image/png');
      else canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
    const url = blob ? URL.createObjectURL(blob) : entry.url;
    putListThumb(id, url);
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
      const paint = thumbPaintRoot(stage);
      const cachedThumb = forList ? takeListThumb(id) : '';
      if (cachedThumb) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = cachedThumb;
        attachListThumbErrorHandler(img, stage, noteId, id);
        paint.replaceChildren(img);
        return;
      }
      // iOS keeps the small stored preview to avoid decoding every PDF.
      // Other devices render the original so receipt text stays legible.
      if (forList && IS_IOS && await paintListThumbFromPreviewEnc(id, stage)) {
        return;
      }
      if (heavyPreviewDeferred(id) && attachmentKind(NotesStore.get(id)) === 'pdf') {
        paintIosPdfPlaceholder(stage, NotesStore.get(id)?.content?.filename, { compact: !!forList, state: 'loading' });
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
        const label = attachmentThumbLabel('image');
        if (forList) {
          const img = document.createElement('img');
          img.alt = entry.filename || '';
          img.decoding = 'async';
          attachListThumbErrorHandler(img, stage, noteId, id);
          const show = () => {
            if (!stage.isConnected || !img.naturalWidth) return;
            paint.replaceChildren(img);
          };
          img.addEventListener('load', show);
          img.src = await makeListThumbUrl(id, entry);
          if (img.complete && img.naturalWidth) show();
          else if (img.complete && !img.naturalWidth) paint.textContent = label;
          // Drop the full-size bytes + blob URL right away on the overview.
          if (previewingId !== id) forgetPreview(id);
        } else {
          paintThumbImage(stage, entry.url, label);
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
        const stageWidth = Math.round(stage.clientWidth || stage.parentElement?.clientWidth || 0);
        // List thumbs render wide, then contain the ink of page 1. The CSS
        // tile is small; a full letter page at that size reads as a blank box.
        const width = forList
          ? Math.max(720, thumbOutputPx() * 2)
          : Math.max(thumbOutputPx(), stageWidth || THUMB_CSS_PX);
        const page = await NotesPreview.renderPdfPage(doc, 1, width);
        if (forList) {
          const canvas = page?.tagName === 'CANVAS' ? page : page?.querySelector?.('canvas');
          const fitted = canvas ? fitThumbCanvas(canvas, { cropInk: true }) : null;
          if (fitted) {
            fitted.className = 'doc-page';
            paint.replaceChildren(fitted);
          } else {
            paint.replaceChildren(page);
          }
        } else {
          paintFittedThumb(page);
          paint.replaceChildren(page);
        }
        if (forList && previewingId !== id) forgetPreview(id);
        return;
      }
      if (entry.kind === 'text') {
        clearDocStageLoading(stage);
        const query = forList ? '' : activeFindNeedle();
        NotesPreview.renderTextPreview(paint, entry.bytes, query);
        if (forList && previewingId !== id) forgetPreview(id);
        return;
      }
      paint.textContent = 'FILE';
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
      thumbPaintRoot(stage).textContent = 'Preview';
    }
  }

  function inlineStagePainted(stage) {
    return !!stage?.querySelector('img, canvas, pre, .doc-page-wrap, .error, .muted, .doc-ocr-wait');
  }

  async function hydrateInlineDoc(noteId, id, stage) {
    if (!stage) return;
    if (heavyPreviewDeferred(id)) {
      clearDocStageLoading(stage);
      stage.innerHTML = '<p class="doc-ocr-wait">Indexing… preview opens when reading finishes.</p>';
      return;
    }
    showDocStageLoading(stage);
    try {
      await waitForStageLayout(stage);
      if (currentId !== noteId || !stage.isConnected) return;
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
        markDocStagePainted(stage);
        return;
      }
      clearDocStageLoading(stage);
      stage.innerHTML = '<p class="muted">This file type cannot be previewed. Download it instead.</p>';
      markDocStagePainted(stage);
    } catch (err) {
      clearDocStageLoading(stage);
      const msg = String(err.message || '');
      const friendly = /ghash tag|decrypt|Missing encryption key/i.test(msg)
        ? 'This document could not be decrypted — use Settings → Security → Repair documents.'
        : (/not on this device yet|missing encrypted data/i.test(msg)
          ? msg
          : (msg || 'Preview unavailable offline'));
      stage.innerHTML = `<p class="error">${escapeHtml(friendly)}</p>`;
      markDocStagePainted(stage);
    }
  }

  let inlineDocLayoutWatch = null;

  function stopInlineDocLayoutWatch() {
    if (!inlineDocLayoutWatch) return;
    inlineDocLayoutWatch.disconnect();
    inlineDocLayoutWatch = null;
  }

  function ensureInlineDocLayoutWatch() {
    if (!ui.docInline || ui.docInline.hidden || !isMobileLayout()) return;
    const stage = ui.docInline.querySelector('.doc-inline-stage');
    const attId = stage?.dataset?.stage;
    if (!stage || !attId || inlineStagePainted(stage)) {
      stopInlineDocLayoutWatch();
      return;
    }
    if (inlineDocLayoutWatch) return;
    if (typeof ResizeObserver !== 'function') return;
    inlineDocLayoutWatch = new ResizeObserver(() => {
      if (!stage.isConnected || ui.docInline.hidden || inlineStagePainted(stage)) {
        stopInlineDocLayoutWatch();
        return;
      }
      if (stage.clientWidth > 120 && stage.classList.contains('is-loading')) {
        hydrateInlineDoc(currentId, attId, stage).catch(() => {});
        stopInlineDocLayoutWatch();
      }
    });
    inlineDocLayoutWatch.observe(stage);
    if (ui.docInline) inlineDocLayoutWatch.observe(ui.docInline);
  }

  function currentSearchQuery() {
    return (ui.search && ui.search.value ? ui.search.value : '').trim();
  }

  function activeFindNeedle() {
    const findQ = currentFindQuery();
    if (findBarOpen() && findQ) return findQ;
    const sidebarQ = currentSearchQuery();
    // Compare against the dismissed query directly. docHitNoteSuppressed()
    // resolves the needle through this function, so calling it here recursed
    // until the stack overflowed whenever the search box had text.
    if (sidebarQ && docHitNoteDismissedFor === sidebarQ) return '';
    if (sidebarQ) return sidebarQ;
    return findQ;
  }

  function attachmentSearchText(id) {
    const item = NotesStore.get(id);
    const own = String(item?.content?.ocr_text || '');
    // A file with its own scanned text is highlighted from that text only.
    // Falling through to the note's copied text would paint hits from a
    // sibling file onto this one. The note copy remains the fallback for
    // files that were indexed before per-file text was stored.
    if (own.trim()) return own;
    const noteId = item?.content?.note_id || currentId;
    const note = noteId ? NotesStore.get(noteId) : null;
    if (!note?.content?.ocr_text) return '';
    // The copy is unambiguous only when this is the note's single file.
    const siblings = NotesStore.listAttachments(noteId);
    if (siblings.length > 1 && siblings.some((a) => a.uuid !== id && String(a.content?.ocr_text || '').trim())) return '';
    return String(note.content.ocr_text || '');
  }

  function attachmentSearchBoxes(id) {
    const item = NotesStore.get(id);
    return Array.isArray(item?.content?.ocr_boxes) ? item.content.ocr_boxes : [];
  }

  function attachmentOcrSettled(item) {
    const method = item?.content?.ocr_method || '';
    if (!method || method === 'pending') return false;
    const current = Number(NotesStore.OCR_INDEX || 0);
    if (!current || Number(item.content.ocr_index) !== current) return false;
    if (method === 'text' || method === 'failed' || method === 'none' || method === 'unsupported') return true;
    // Text synced from the device that indexed the file is enough. Missing
    // highlight boxes must not make every other device read the file again.
    return !!String(item.content.ocr_text || '').trim() || Array.isArray(item.content.ocr_boxes);
  }

  const boxFetch = new Set();
  let docPaintToken = 0;

  function docLoadingHtml() {
    return '<div class="doc-stage-loading" role="status" aria-live="polite"><span class="doc-stage-loading-spinner" aria-hidden="true"></span><span>Loading preview…</span></div>';
  }

  function showDocStageLoading(stage) {
    if (!stage) return;
    stage.classList.remove('is-painted');
    stage.classList.add('is-loading');
    stage.innerHTML = docLoadingHtml();
  }

  function clearDocStageLoading(stage) {
    if (!stage) return;
    stage.classList.remove('is-loading');
  }

  function markDocStagePainted(stage) {
    if (!stage) return;
    stage.classList.remove('is-loading');
    if (!inlineStagePainted(stage)) return;
    stage.classList.add('is-painted');
    syncEditorDocPreviewLayout();
  }

  function previewHasHits(stage) {
    return !!stage?.querySelector('.doc-search-hit, pre mark.search-hit');
  }

  function previewHasExcerpt(stage) {
    return !!stage?.querySelector('.doc-ocr-hits');
  }

  function ensureAttachmentOcr(attId, file, onProgress, { force = false } = {}) {
    if (!force) NotesStore.applySearchIndexEntry?.(attId);
    const item = NotesStore.get(attId);
    if (!force && item && (attachmentOcrSettled(item) || NotesStore.searchIndexCovers?.(attId))) {
      return Promise.resolve({
        text: String(item.content.ocr_text || ''),
        method: item.content.ocr_method,
        boxes: attachmentSearchBoxes(attId),
      });
    }
    const pending = ocrInFlight.get(attId);
    if (pending) return pending;
    const work = (async () => {
      if (!force) NotesStore.applySearchIndexEntry?.(attId);
      const already = NotesStore.get(attId);
      if (!force && already && (attachmentOcrSettled(already) || NotesStore.searchIndexCovers?.(attId))) {
        return {
          text: String(already.content.ocr_text || ''),
          method: already.content.ocr_method,
          boxes: attachmentSearchBoxes(attId),
        };
      }
      const OCR_JOB_TIMEOUT_MS = 90000;
      const ocr = await Promise.race([
        NotesOcr.extractFromFile(file, onProgress, attId),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Reading this file took too long')), OCR_JOB_TIMEOUT_MS);
        }),
      ]);
      const live = NotesStore.get(attId);
      if (!force && attachmentOcrSettled(live)) {
        return {
          text: String(live.content.ocr_text || ''),
          method: live.content.ocr_method,
          boxes: attachmentSearchBoxes(attId),
        };
      }
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
    if (NotesStore.searchIndexCovers?.(attId) || attachmentOcrSettled(item)) return attachmentSearchBoxes(attId);
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
    if (heavyPreviewDeferred(attId)) {
      clearDocStageLoading(stage);
      stage.innerHTML = '<p class="doc-ocr-wait">Indexing… preview opens when reading finishes.</p>';
      markDocStagePainted(stage);
      return;
    }
    clearDocStageLoading(stage);
    const paintToken = ++docPaintToken;
    const needle = String(query || '').trim();
    if (isMobileLayout() && stage.clientWidth <= 120) {
      await waitForStageLayout(stage);
      if (!stage.isConnected) return;
    }
    const maxWidth = previewStageWidth(stage);

    if (entry.kind === 'pdf') {
      if (!needle) {
        await NotesPreview.renderPdfDocument(entry.bytes, stage, {
          maxWidth,
          query: '',
          showExcerpt: false,
        });
        markDocStagePainted(stage);
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
      markDocStagePainted(stage);
      return;
    }
    if (entry.kind === 'image') {
      if (!needle) {
        const img = document.createElement('img');
        img.src = entry.url;
        img.alt = entry.filename;
        img.decoding = 'async';
        img.dataset.fullResolution = '1';
        stage.replaceChildren(img);
        markDocStagePainted(stage);
        return;
      }
      await ensureOpenedAttachmentIndexed(attId, entry);
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      let ocrText = attachmentSearchText(attId);
      let boxes = attachmentSearchBoxes(attId);
      const img = document.createElement('img');
      img.src = entry.url;
      img.alt = entry.filename;
      img.decoding = 'async';
      img.dataset.fullResolution = '1';
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
      markDocStagePainted(stage);
      return;
    }
    if (entry.kind === 'text') {
      if (paintToken !== docPaintToken || !stage.isConnected) return;
      NotesPreview.renderTextPreview(stage, entry.bytes, needle);
      if (needle) revealSearchHits(stage, needle);
      markDocStagePainted(stage);
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
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn icon doc-hit-note-dismiss';
    dismiss.dataset.docHitDismiss = '1';
    dismiss.setAttribute('aria-label', 'Dismiss matches bar');
    dismiss.title = 'Dismiss';
    dismiss.textContent = '×';
    note.appendChild(dismiss);
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
  let docHitNoteDismissedFor = '';
  let findPaintNeedle = '';
  let findPaintPromise = null;

  function activeDocHitNeedle() {
    return String(activeFindNeedle() || '').trim();
  }

  function docHitNoteSuppressed() {
    const needle = activeDocHitNeedle();
    return needle && docHitNoteDismissedFor === needle;
  }

  function clearDocHitNavigation(stage) {
    docSearchHitIndex = 0;
    findIndex = 0;
    if (!stage) return;
    const root = docFindSearchRoot(stage) || stage;
    NotesPreview.listSearchHits(root).forEach((el) => {
      el.classList.remove('doc-search-hit-current', 'search-hit-current');
    });
  }

  function dismissDocHitNote() {
    const needle = activeDocHitNeedle();
    if (needle) docHitNoteDismissedFor = needle;
    clearDocumentSearchHighlights();
    const stage = activeDocSearchStage();
    if (stage) {
      showHitNote(stage, '');
      clearDocHitNavigation(stage);
    } else {
      document.querySelectorAll('.doc-hit-note').forEach((el) => el.remove());
      docSearchHitIndex = 0;
      findIndex = 0;
    }
  }

  async function clearDocumentSearchHighlights() {
    const stages = new Set();
    const live = activeDocSearchStage();
    if (live) stages.add(live);
    if (ui.docStage) stages.add(ui.docStage);
    ui.docInline?.querySelectorAll('.doc-inline-stage, .doc-thumb-stage').forEach((el) => stages.add(el));
    stages.forEach((stage) => NotesPreview.clearSearchHighlights(stage));
    document.querySelectorAll('.doc-hit-note').forEach((el) => el.remove());
    const repaintNeedle = findBarOpen() && currentFindQuery() ? currentFindQuery() : '';
    for (const stage of stages) {
      const attId = stage?.dataset?.stage;
      if (!attId || !stage.isConnected) continue;
      try {
        const entry = await cachedPreview(attId);
        if (!stage.isConnected) continue;
        await paintDocumentSearch(attId, stage, entry, repaintNeedle);
      } catch (_) { /* offline preview */ }
    }
    if (isNotePreviewVisible()) {
      if (findBarOpen() && currentFindQuery()) highlightFindPreview();
      else refreshPreview();
    } else {
      syncFindHighlights(repaintNeedle);
      syncChecklistFindHighlights(repaintNeedle);
    }
  }

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
      label.textContent = NotesSearch.documentHighlightLabel(summary.count, {
        page,
        pages: summary.pages,
      });
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
        status.textContent = NotesSearch.documentHighlightLabel(0);
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
    const highlightLabel = NotesSearch.documentHighlightLabel(hits.length, {
      page,
      pages: summary.pages,
    });
    counter.setAttribute('aria-label', highlightLabel);
    if (status && findBarInDocViewer()) {
      status.textContent = highlightLabel;
      status.classList.remove('is-empty');
      status.hidden = false;
    } else if (status) {
      status.hidden = true;
      status.textContent = '';
      status.classList.remove('is-empty');
    }
  }

  function jumpDocSearchHit(delta = 1) {
    if (docHitNoteSuppressed()) return;
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
    if (docHitNoteSuppressed()) {
      showHitNote(stage, '');
      return;
    }
    const highlightLabel = NotesSearch.documentHighlightLabel(summary.count, {
      page: summary.page,
      pages: summary.pages,
    });
    showHitNote(stage, highlightLabel, { index: 0, count: summary.count });
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

  function ensureInlineDocThumbs(noteId, items) {
    if (!ui.docInline || editorMode !== 'preview' || !items?.length) return;
    items.forEach((a) => {
      const stage = ui.docInline.querySelector(`.doc-thumb-stage[data-stage="${a.uuid}"]`);
      if (!stage || stage.querySelector('img, canvas, pre, .doc-page-wrap')) return;
      observeThumb(noteId, a.uuid, stage);
    });
  }

  function renderDocInline(noteId) {
    const listed = NotesStore.listAttachments(noteId);
    if (!ui.docInline) return;
    if (!listed.length) {
      ui.docInline.hidden = true;
      ui.docInline.innerHTML = '';
      inlineNoteId = null;
      inlineAttIds = '';
      inlineSearch = '';
      syncEditorDocPreviewLayout();
      syncEditorMobileDocActions();
      return;
    }
    const query = activeFindNeedle();
    const show = editorMode === 'preview';
    ui.docInline.hidden = !show;
    // With a query, the file that contains it takes the main stage so the
    // note opens on the matched document, not on whichever file was stored first.
    const items = query ? NotesSearch.orderAttachmentsForQuery(listed, query) : listed;
    const ids = items.map((a) => a.uuid).join(',');
    const [first, ...rest] = items;
    const stage = ui.docInline.querySelector('.doc-inline-stage');
    const hydrated = stage && stage.querySelector('img, canvas, pre, .doc-page-wrap');
    if (inlineNoteId === noteId && inlineAttIds === ids && hydrated && inlineSearch !== query) {
      inlineSearch = query;
      if (show) repaintInlineSearch(noteId, first.uuid, stage);
      ensureInlineDocThumbs(noteId, rest);
      return;
    }
    if (inlineNoteId === noteId && inlineAttIds === ids && inlineSearch === query && hydrated) {
      if (query && stage && !previewHasHits(stage) && !previewHasExcerpt(stage)) {
        repaintInlineSearch(noteId, first.uuid, stage);
      }
      ensureInlineDocThumbs(noteId, rest);
      return;
    }
    inlineNoteId = noteId;
    inlineAttIds = ids;
    inlineSearch = query;
    const galleryIndex = Math.max(0, listed.findIndex((a) => a.uuid === first.uuid));
    const thumbMeta = (a) => {
      const label = query ? NotesSearch.attachmentHighlightLabel(NotesSearch.attachmentHitCount(a, query)) : '';
      const badge = label ? `<span class="attachment-hit-badge">${escapeHtml(label)}</span>` : '';
      return `<span>${escapeHtml(a.content.filename || 'Document')}</span>${badge}`;
    };
    const countBtn = items.length > 1
      ? `<button type="button" class="doc-inline-count" data-doc-gallery-open data-note-id="${escapeAttr(noteId)}" data-index="${galleryIndex}" aria-label="Open item ${galleryIndex + 1} of ${items.length}">${galleryIndex + 1} / ${items.length}</button>`
      : '';
    const desktop = isDesktopLayout();
    const mainInner = `<div class="doc-inline-stage is-loading" data-stage="${escapeAttr(first.uuid)}">${docLoadingHtml()}</div>
          ${desktop ? '' : `<div class="doc-thumb-meta">${thumbMeta(first)}</div>`}`;
    /* iOS Safari will not reliably paint PDF canvases inside <button> — use a div shell like desktop. */
    const mainBlock = desktop
      ? `<div class="doc-inline-main doc-inline-main-scroll">${mainInner}</div>`
      : `<div class="doc-inline-main doc-inline-main-scroll" data-preview="${escapeAttr(first.uuid)}" role="button" tabindex="0" aria-label="Open ${escapeAttr(first.content.filename || 'document')}">
          ${mainInner}
        </div>`;
    ui.docInline.innerHTML = `<div class="doc-inline-card">
        ${countBtn}
        ${mainBlock}
      </div>${items.length > 1 ? `<div class="doc-inline-thumbs">${rest.map((a) => `<button type="button" class="doc-thumb" data-preview="${escapeAttr(a.uuid)}">
        <div class="doc-thumb-stage" data-stage="${escapeAttr(a.uuid)}"></div>
        <div class="doc-thumb-meta">${thumbMeta(a)}</div>
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
    if (!show) {
      syncEditorMobileDocActions();
      return;
    }
    hydrateInlineDoc(noteId, first.uuid, ui.docInline.querySelector(`[data-stage="${first.uuid}"]`));
    ensureInlineDocThumbs(noteId, rest);
    syncEditorDocPreviewLayout();
    ensureInlineDocLayoutWatch();
    syncEditorMobileDocActions();
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
      const highlightLabel = NotesSearch.documentHighlightLabel(hits.length, {
        page,
        pages: summary.pages,
      });
      const inDocViewer = stage.closest('#doc-stage');
      if (!(inDocViewer && findBarInDocViewer()) && !docHitNoteSuppressed()) {
        showHitNote(stage, highlightLabel, { index: idx, count: hits.length });
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
    syncDocEnhance(null);
    docViewerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ui.docTitle.textContent = item.content.filename || 'Document';
    if (docGallery && refreshDocGalleryIds() && docGallery.ids.length > 1) {
      ui.docTitle.textContent = `${item.content.filename || 'Document'} (${docGallery.index + 1}/${docGallery.ids.length})`;
    }
    releaseDocEnhanceObjects(ui.docStage);
    showDocStageLoading(ui.docStage);
    if (ui.docStage._docZoom) ui.docStage._docZoom.destroy();
    ui.docViewer.hidden = false;
    document.body.classList.add('doc-preview-open');
    const docCloseBtn = document.getElementById('doc-close');
    if (docCloseBtn) docCloseBtn.focus();
    setDocImmersive(!isDesktopLayout());
    if (!isDesktopLayout() && ui.docViewer) {
      ui.docViewer.style.visibility = 'visible';
    }
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
        syncDocEnhance('image');
        await paintDocumentSearch(id, ui.docStage, entry, query);
        attachDocZoom(ui.docStage, 'image');
        const host = ui.docStage.closest?.('.doc-zoom-host') || ui.docStage;
        const img = host.querySelector('img');
        if (img && NotesPreview.rememberImagePaint) NotesPreview.rememberImagePaint(host, img);
        if (query) finishDocPreviewFind(ui.docStage, query, hitIndex);
        return;
      }
      if (entry.kind === 'pdf') {
        syncDocEnhance('pdf');
        if (previewingId !== id) return;
        await NotesPreview.ensurePdf();
        await paintDocumentSearch(id, ui.docStage, entry, query);
        attachDocZoom(ui.docStage, 'pdf');
        maybeUpgradePreviewQuality();
        if (query) finishDocPreviewFind(ui.docStage, query, hitIndex);
        return;
      }
      if (entry.kind === 'text') {
        syncDocEnhance('text');
        clearDocStageLoading(ui.docStage);
        NotesPreview.renderTextPreview(ui.docStage, entry.bytes, query);
        attachDocZoom(ui.docStage, 'text');
        if (query) finishDocPreviewFind(ui.docStage, query, hitIndex);
        return;
      }
      syncDocEnhance(entry.kind);
      clearDocStageLoading(ui.docStage);
      ui.docStage.innerHTML = '<p class="muted">This file type cannot be previewed. Download it instead.</p>';
    } catch (err) {
      clearDocStageLoading(ui.docStage);
      ui.docStage.innerHTML = `<p class="error">${escapeHtml(err.message || 'Preview failed')}</p>`;
    }
  }

  function docViewerFocusables() {
    if (!ui.docViewer) return [];
    return [...ui.docViewer.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hidden && !el.closest('[hidden]') && !el.disabled);
  }

  function syncDocEnhance(kind) {
    const toggle = document.getElementById('doc-enhance-toggle');
    const panel = document.getElementById('doc-enhance-panel');
    const image = kind === 'image';
    if (toggle) {
      toggle.hidden = !image;
      if (!image) toggle.setAttribute('aria-expanded', 'false');
    }
    if (panel && !image) panel.hidden = true;
  }

  function closeDocPreview() {
    previewingId = null;
    docGallery = null;
    restoreFindBarToEditor();
    const returnFocus = docViewerReturnFocus;
    docViewerReturnFocus = null;
    if (!ui.docViewer) return;
    releaseDocEnhanceObjects(ui.docStage);
    if (ui.docStage._docZoom) ui.docStage._docZoom.destroy();
    updateDocZoomLabel();
    setDocImmersive(false);
    document.body.classList.remove('doc-preview-open');
    if (ui.docViewer) ui.docViewer.style.visibility = '';
    if (ui.docViewer) ui.docViewer.style.paddingTop = '';
    ui.docViewer.hidden = true;
    syncDocEnhance(null);
    ui.docBackdrop.hidden = true;
    ui.docStage.replaceChildren();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }

  function setEditorMenuLabel(btn, text) {
    if (!btn || text == null) return;
    const label = btn.querySelector('.editor-menu-label, .share-label');
    if (label) label.textContent = text;
    else btn.textContent = text;
    btn.setAttribute('aria-label', text);
    if (btn.hasAttribute('title')) btn.title = text;
  }

  function openNoteFileAttachment(noteId) {
    const id = noteId || currentId;
    if (!id || typeof NotesStore === 'undefined' || typeof NotesStore.listAttachments !== 'function') return null;
    const atts = NotesStore.listAttachments(id).filter((item) => {
      const owner = item?.content?.note_id;
      return !owner || owner === id;
    });
    if (!atts.length) return null;
    const shown = typeof inlineDocPreviewAttId === 'function' ? inlineDocPreviewAttId() : null;
    if (shown) {
      const match = atts.find((item) => item.uuid === shown);
      if (match) return match;
    }
    if (previewingId) {
      const match = atts.find((item) => item.uuid === previewingId);
      if (match) return match;
    }
    return atts[0];
  }

  function syncDownloadNoteButton() {
    const btn = document.getElementById('btn-download-note');
    if (!btn) return;
    const note = currentId ? NotesStore.get(currentId) : null;
    const locked = !!(note?.content?.locked && currentId && !unlockedNotes.has(currentId));
    const viewingFile = !locked && editorMode === 'preview' && !!inlineDocPreviewAttId();
    const file = viewingFile && currentId ? openNoteFileAttachment(currentId) : null;
    const label = file ? 'Download file' : 'Download note';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    document.querySelectorAll('[data-editor-proxy="btn-download-note"]').forEach((proxy) => {
      proxy.title = label;
      proxy.setAttribute('aria-label', label);
    });
  }

  function downloadNoteMarkdown(note, toastMessage = 'Note downloaded') {
    const title = note?.content?.title || 'Untitled';
    const blob = new Blob([`# ${title}\n\n${note?.content?.content || ''}`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(note?.content?.title || 'note').replace(/[^\w-]+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
    if (toastMessage) toast(toastMessage);
  }

  async function downloadOpenNote() {
    if (!currentId) {
      toast('Open a note first', true);
      return;
    }
    const note = NotesStore.get(currentId);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(currentId)) {
      toast('Unlock this protected note first', true);
      return;
    }
    if (editorMode === 'preview') {
      const file = openNoteFileAttachment(currentId);
      if (file) {
        await downloadAttachment(file.uuid);
        return;
      }
    }
    downloadNoteMarkdown(note);
  }

  async function downloadAttachment(id) {
    if (noteProtectionBlocks(id)) {
      toast('Unlock this protected note first', true);
      return;
    }
    const item = NotesStore.get(id);
    if (!item) return;
    const filename = item.content.filename || 'attachment';
    await runFileDownloadTask({
      title: filename,
      prepareLabel: 'Preparing download…',
      run: async (report) => {
        report({ status: 'Fetching file…', indeterminate: true });
        const bytes = await NotesStore.getAttachmentBytes(id);
        report({ status: 'Starting download…', pct: 92, indeterminate: false });
        const blob = new Blob([bytes], { type: NotesPreview.mimeFromMeta(item.content.mime, item.content.filename) });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        report({ status: 'Download started', pct: 100, indeterminate: false });
      },
    });
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
        return;
      } catch (err) {
        if (err && (err.name === 'AbortError' || /cancel/i.test(err.message || ''))) return;
      }
    }
    await downloadAttachment(id);
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
    const title = NotesSearch.effectiveNoteTitle(note) || 'Note';
    const body = note.content.content || '';
    const text = `# ${title}\n\n${body}`.trim();
    const filename = `${title.replace(/[^\w-]+/g, '-') || 'note'}.md`;

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

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Note copied');
        return;
      }
    } catch (_) { /* clipboard blocked */ }
    toast('Sharing unavailable', true);
  }

  function deviceCanShare() {
    return typeof navigator.share === 'function';
  }

  function attachmentCanWebShare() {
    if (typeof navigator.share !== 'function') return false;
    try {
      const probe = new File(['x'], 'share-probe.txt', { type: 'text/plain' });
      return !navigator.canShare || navigator.canShare({ files: [probe] });
    } catch (_) {
      return false;
    }
  }

  function syncShareLabels() {
    const noteShare = deviceCanShare();
    const fileShare = attachmentCanWebShare();
    const noteLabel = noteShare ? 'Share' : 'Copy';
    const noteTitle = noteShare ? 'Share note' : 'Copy note';
    ['btn-share', 'note-info-share', 'note-info-share-bottom'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (id === 'btn-share') {
        btn.title = noteTitle;
        btn.setAttribute('aria-label', noteTitle);
        return;
      }
      btn.title = noteTitle;
      btn.setAttribute('aria-label', noteTitle);
      btn.textContent = id === 'note-info-share-bottom' ? `${noteLabel} note` : noteLabel;
    });
    const shareBtn = document.getElementById('btn-share');
    if (shareBtn) {
      const label = shareBtn.querySelector('.share-label');
      if (label) label.textContent = noteLabel;
    }
    const fileShareBtn = document.getElementById('btn-mobile-doc-attachment-share');
    if (fileShareBtn && !isPhoneShell()) {
      const showFileShare = fileShare && mobileDocToolbarActive();
      fileShareBtn.hidden = !showFileShare;
      fileShareBtn.title = 'Share file';
      fileShareBtn.setAttribute('aria-label', 'Share file');
      setEditorMenuLabel(fileShareBtn, 'Share file');
    }
    const docShare = document.getElementById('doc-share');
    if (docShare) {
      docShare.hidden = !fileShare;
      docShare.title = 'Share';
      docShare.setAttribute('aria-label', 'Share');
      docShare.textContent = 'Share';
    }
    const docDownload = document.getElementById('doc-download');
    if (docDownload) {
      docDownload.hidden = fileShare;
      docDownload.title = 'Download';
      docDownload.setAttribute('aria-label', 'Download');
      docDownload.textContent = 'Download';
    }
    const immersive = document.getElementById('doc-immersive-share');
    if (immersive) {
      immersive.hidden = !fileShare;
      immersive.title = fileShare ? 'Share' : 'Download';
      immersive.setAttribute('aria-label', fileShare ? 'Share' : 'Download');
    }
  }

  function renderHistory(note) {
    if (!ui.historyList) return;
    try {
      const revisions = typeof NotesHistory !== 'undefined'
        ? NotesHistory.revisionRows(note)
        : [];
      if (!revisions.length) {
        ui.historyList.innerHTML = '<p class="muted">No previous versions yet.</p>';
        return;
      }
      ui.historyList.innerHTML = revisions
        .map((rev, idx) => {
          const label = typeof NotesHistory !== 'undefined' && NotesHistory.revisionLabel
            ? NotesHistory.revisionLabel(rev, note)
            : (rev.title || 'Untitled version');
          // Newest first: Version N … Version 1
          const version = `Version ${revisions.length - idx}`;
          const whenMs = typeof NotesHistory !== 'undefined' && NotesHistory.revisionTimestamp
            ? NotesHistory.revisionTimestamp(rev)
            : 0;
          const when = whenMs
            ? new Date(whenMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
            : '';
          const preview = String(rev.content || '').trim().split('\n').find((line) => line.trim()) || '';
          const previewBit = preview && preview !== label ? ` · ${preview.slice(0, 48)}` : '';
          const whenBit = when ? ` · ${when}` : '';
          return `<div class="history-item">
          <span><strong>${escapeHtml(version)}</strong> · ${escapeHtml(label)}${escapeHtml(whenBit)}${escapeHtml(previewBit)}</span>
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
          // Save the open editor first so that text is the history snapshot.
          // Opening afterward must not flush it back over the restored version.
          flushSave();
          NotesStore.restoreRevision(currentId, rev);
          openNote(currentId, { skipFlush: true });
        });
      });
    } catch (err) {
      console.warn('history render failed', err);
      ui.historyList.innerHTML = '<p class="muted">No previous versions yet.</p>';
    }
  }

  function noteHasDocs(noteId) {
    return NotesStore.listAttachments(noteId || currentId).length > 0;
  }

  function noteHasVisualDocs(noteId) {
    return NotesStore.listAttachments(noteId || currentId).some((att) => {
      const kind = attachmentKind(att);
      return kind === 'image' || kind === 'pdf';
    });
  }

  function ocrMarkdown(noteId) {
    const atts = NotesStore.listAttachments(noteId || currentId);
    const parts = atts.map((item) => String(item.content.ocr_text || '').trim()).filter(Boolean);
    if (parts.length) return parts.join('\n\n');
    if (atts.some((item) => !item.content.ocr_method)) return '';
    return '';
  }

  function docSearchActive() {
    return editorMode === 'preview' && !!currentId && noteHasDocs(currentId) && !!activeFindNeedle();
  }

  function syncEditorModeForSearch() {
    /* inline PDF search highlights use docSearchActive() — no mode switch needed */
  }

  function resetNoteTransientChrome({ clearSurfaces = false } = {}) {
    hideFindBar();
    const findInput = document.getElementById('find-input');
    if (findInput) findInput.value = '';
    docHitNoteDismissedFor = '';
    closeNoteOptions();
    closeEditorToolbarMenu();
    document.querySelectorAll('.doc-hit-note').forEach((el) => el.remove());
    document.getElementById('btn-delete-forever')?.toggleAttribute('hidden', true);
    document.getElementById('btn-clear-checked')?.toggleAttribute('hidden', true);
    document.body.classList.remove('editor-tools-open');
    setNoteTypeMenuOpen(false);
    if (!clearSurfaces) return;
    if (ui.checklist) {
      ui.checklist.hidden = true;
      ui.checklist.innerHTML = '';
    }
    if (ui.docInline) {
      ui.docInline.hidden = true;
      ui.docInline.innerHTML = '';
    }
    if (ui.attachmentList) ui.attachmentList.innerHTML = '';
    inlineNoteId = null;
    inlineAttIds = '';
    inlineSearch = '';
    stopInlineDocLayoutWatch();
    syncEditorMobileDocActions();
    ui.editor?.classList.remove('doc-preview-active');
    document.body.classList.remove('editor-doc-preview');
    document.body.classList.remove('editor-mobile-doc-preview');
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
    document.body.classList.toggle('editor-mobile-doc-preview', active && isPhoneShell());
    if (active && isMobileLayout()) ensureInlineDocLayoutWatch();
    else stopInlineDocLayoutWatch();
    syncEditorMobileDocActions();
  }

  function inlineDocPreviewAttId() {
    if (!ui.docInline || ui.docInline.hidden) return null;
    const stage = ui.docInline.querySelector('.doc-inline-stage');
    return stage?.dataset?.stage || null;
  }

  function mobileDocToolbarActive() {
    if (!currentId || !noteHasDocs(currentId)) return false;
    if (editorMode !== 'preview') return false;
    if (!inlineDocPreviewAttId()) return false;
    return true;
  }

  function applyEditorMode() {
    syncRescanOcrButton();
    const ocrBtn = document.getElementById('btn-ocr-text');
    const previewBtn = document.getElementById('btn-preview');
    const toolbar = document.getElementById('md-toolbar');
    const hasDocs = noteHasDocs(currentId);
    if (ocrBtn) ocrBtn.hidden = !hasDocs;
    if (!currentId) {
      if (previewBtn) previewBtn.hidden = true;
      if (ui.checklist) {
        ui.checklist.hidden = true;
        ui.checklist.innerHTML = '';
      }
      return;
    }
    const note = NotesStore.get(currentId);
    if (ui.body) {
      const editorKind = note?.content?.editor || '';
      ui.body.spellcheck = editorKind === 'code' ? false : !!prefs.spellcheck;
    }
    const gated = !!note?.content?.locked && !unlockedNotes.has(currentId);
    if (gated) {
      if (ui.checklist) {
        ui.checklist.hidden = true;
        ui.checklist.innerHTML = '';
      }
      if (ui.docInline) {
        ui.docInline.hidden = true;
        ui.docInline.innerHTML = '';
      }
      ui.preview.hidden = true;
      syncEditorDocPreviewLayout();
      syncEditorMobileDocActions();
      return;
    }
    if (hasDocs && editorMode === 'preview') {
      ui.body.hidden = true;
      ui.preview.hidden = true;
      if (toolbar) toolbar.hidden = true;
      if (ui.checklist) {
        ui.checklist.hidden = true;
        ui.checklist.innerHTML = '';
      }
      if (ui.docInline) ui.docInline.hidden = false;
      if (previewBtn) setEditorMenuLabel(previewBtn, 'Edit');
      if (ocrBtn) setEditorMenuLabel(ocrBtn, 'OCR text');
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
      if (ui.checklist) {
        ui.checklist.hidden = true;
        ui.checklist.innerHTML = '';
      }
      if (ui.docInline) {
        ui.docInline.hidden = true;
        ui.docInline.innerHTML = '';
      }
      const text = ocrMarkdown(currentId);
      ui.preview.innerHTML = text
        ? NotesMarkdown.render(text)
        : '<p class="muted">OCR is still running, or no text was found. Stay on the document preview in the meantime.</p>';
      markAutoDir(ui.preview);
      highlightPreview();
      if (previewBtn) setEditorMenuLabel(previewBtn, 'Document');
      if (ocrBtn) setEditorMenuLabel(ocrBtn, 'Edit');
      previewOn = false;
      syncEditorBodyWrap();
      syncEditorDocPreviewLayout();
      if (previewBtn) previewBtn.hidden = false;
      if (note) syncTagBarShell(note);
      return;
    }
    const type = note?.content?.editor || ui.editorType.value || 'plain';
    const checklistOn = isChecklistEditor(type);
    const markdownNote = type === 'markdown';
    const codeNote = type === 'code';
    const editingLocked = !!note?.content?.prevent_edit;
    if (editingLocked) editorMode = 'preview';
    ui.editor?.classList.remove('rich-live-edit');
    ui.editor?.classList.toggle('code-note', codeNote);
    if (ui.body) ui.body.spellcheck = codeNote ? false : !!prefs.spellcheck;
    previewOn = editingLocked || editorMode !== 'edit';
    ui.preview.hidden = !previewOn || checklistOn;
    ui.body.hidden = previewOn || checklistOn;
    if (previewOn && !checklistOn) refreshPreview();
    syncEditorBodyWrap();
    syncEditLinkOverlay();
    if (ui.checklist) {
      ui.checklist.hidden = !checklistOn;
      if (!checklistOn) ui.checklist.innerHTML = '';
    }
    if (ui.docInline) {
      ui.docInline.hidden = true;
      if (!docSearchActive()) ui.docInline.innerHTML = '';
    }
    if (toolbar) toolbar.hidden = checklistOn || (!markdownNote && !codeNote && type !== 'superscript') || (previewOn && !markdownNote && !codeNote);
    if (toolbar) {
      toolbar.querySelectorAll('[data-md]').forEach((btn) => {
        btn.hidden = codeNote || (btn.dataset.md === 'sup' && type !== 'superscript');
      });
      toolbar.querySelectorAll('[data-code]').forEach((btn) => {
        btn.hidden = !codeNote;
      });
      const modeBtn = document.getElementById('btn-md-mode');
      if (modeBtn) {
        modeBtn.hidden = !(markdownNote || codeNote);
        modeBtn.textContent = editorMode === 'edit' ? 'Preview' : 'Edit';
        modeBtn.setAttribute('aria-pressed', editorMode === 'edit' ? 'false' : 'true');
      }
    }
    if (previewBtn) {
      previewBtn.hidden = checklistOn || (!hasDocs && !markdownNote);
      if (markdownNote && !hasDocs) setEditorMenuLabel(previewBtn, editorMode === 'edit' ? 'Preview' : 'Edit');
      else if (hasDocs && editorMode === 'edit') setEditorMenuLabel(previewBtn, 'Document');
      else if (hasDocs) setEditorMenuLabel(previewBtn, 'Edit');
      previewBtn.disabled = false;
    }
    if (ocrBtn) setEditorMenuLabel(ocrBtn, 'OCR text');
    if (checklistOn) renderChecklist(note);
    syncCodeHighlight();
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
    autosizeNoteBody();
  }

  function applyReadOnly(on) {
    const banner = document.getElementById('note-readonly-banner');
    if (banner) {
      banner.hidden = !on;
      banner.textContent = on
        ? 'Read only — tap the lock icon to edit.'
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
        <button type="button" class="check-box" role="checkbox" data-check-toggle="${escapeAttr(row.id)}" aria-checked="${row.done ? 'true' : 'false'}" aria-label="${escapeAttr(String(row.text || '').trim() || 'List item')}">${row.done ? '☑' : '☐'}</button>
        <div class="check-text-wrap">
          <div class="check-text-links" aria-hidden="true"></div>
          <textarea class="check-text" data-check-text="${escapeAttr(row.id)}" rows="1" placeholder="List item" ${note.content.prevent_edit ? 'readonly' : ''}>${escapeHtml(row.text)}</textarea>
        </div>
        ${nested ? `<button type="button" class="btn ghost sm check-indent" data-check-indent="${escapeAttr(row.id)}" aria-label="Indent">⇥</button>` : ''}
      </div>`).join('') + (note.content.prevent_edit ? '' : `
      <div class="checklist-foot">
        <button type="button" class="btn ghost sm check-add" id="check-add">Add item</button>
        <button type="button" class="btn ghost sm check-clear-checked" id="btn-clear-checked-list" hidden>Clear checked</button>
      </div>`);
    ui.checklist.querySelectorAll('.check-row').forEach((row) => {
      const box = row.querySelector('[data-check-toggle]');
      const text = row.querySelector('.check-text');
      if (box && text && !String(text.value || '').trim()) box.setAttribute('aria-label', 'New list item');
    });
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
        autosizeCheckText(input);
        const box = input.closest('.check-row')?.querySelector('[data-check-toggle]');
        if (box) box.setAttribute('aria-label', String(input.value || '').trim() || 'New list item');
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
    ui.checklist.querySelectorAll('.check-text').forEach((el) => autosizeCheckText(el));
    syncChecklistSearchHighlights();
  }

  function autosizeCheckText(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function autosizeNoteBody() {
    const el = ui.body;
    if (!el || el.hidden) return;
    el.style.height = 'auto';
    const minPx = parseFloat(getComputedStyle(el).minHeight) || 0;
    el.style.height = `${Math.max(minPx, el.scrollHeight)}px`;
  }

  function syncClearCheckedButton(note) {
    let visible = false;
    if (note) {
      const type = note.content?.editor || ui.editorType?.value || 'plain';
      if (isChecklistEditor(type) && !note.content?.prevent_edit) {
        const nested = type === 'super';
        const rows = window.NotesChecklist?.parse(note.content?.content || ui.body?.value || '', { nested }) || [];
        visible = rows.some((row) => row.done);
      }
    }
    ['btn-clear-checked', 'btn-clear-checked-list'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.hidden = !visible;
    });
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
    document.getElementById('btn-note-type-menu')?.toggleAttribute('hidden', !!gated);
    ['btn-share', 'btn-note-info', 'btn-trash', 'btn-undo', 'btn-redo', 'btn-prevent-edit', 'btn-ai-chat', 'btn-star', 'btn-pin', 'btn-archive', 'btn-duplicate', 'btn-note-secure-send', 'btn-download-note'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = !!gated;
    });
    document.getElementById('btn-delete-forever')?.toggleAttribute('hidden', true);
    document.getElementById('btn-clear-checked')?.toggleAttribute('hidden', true);
    if (gated) {
      toolbar.hidden = true;
      ui.body.hidden = true;
      ui.preview.hidden = true;
      if (ui.title) ui.title.readOnly = true;
      ui.body.value = '';
      closeNoteOptions();
    closeEditorToolbarMenu();
      syncEditorBodyWrap();
      if (ui.docInline) {
        ui.docInline.hidden = true;
        ui.docInline.innerHTML = '';
      }
      const ocrBtn = document.getElementById('btn-ocr-text');
      if (ocrBtn) ocrBtn.hidden = true;
      syncRescanOcrButton();
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

  function syncChecklistSearchHighlights() {
    if (!ui.checklist || ui.checklist.hidden) return;
    if (typeof findBarOpen === 'function' && findBarOpen() && currentFindQuery()) {
      syncChecklistFindHighlights(currentFindQuery());
      return;
    }
    const query = String(ui.search?.value || '').trim();
    if (!query || typeof NotesSearch === 'undefined' || !NotesSearch.highlightPlain) {
      ui.checklist.querySelectorAll('.check-find-highlights').forEach((el) => el.remove());
      return;
    }
    ui.checklist.querySelectorAll('.check-row').forEach((row) => {
      const input = row.querySelector('.check-text');
      const wrap = row.querySelector('.check-text-wrap');
      if (!input || !wrap) return;
      const html = NotesSearch.highlightPlain(input.value || '', query);
      let layer = wrap.querySelector('.check-find-highlights');
      if (!html.includes('search-hit')) {
        layer?.remove();
        return;
      }
      if (!layer) {
        layer = document.createElement('pre');
        layer.className = 'check-find-highlights';
        layer.setAttribute('aria-hidden', 'true');
        wrap.insertBefore(layer, wrap.firstChild);
      }
      layer.innerHTML = html;
    });
  }

  function markAutoDir(root) {
    if (!root) return;
    root.setAttribute('dir', 'auto');
    root.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, pre, td, th').forEach((el) => {
      el.setAttribute('dir', 'auto');
    });
  }

  function highlightPreview() {
    syncChecklistSearchHighlights();
    if (!ui.preview) return;
    if (docHitNoteSuppressed()) return;
    const query = ui.search.value.trim();
    if (!query) return;
    NotesSearch.applyHighlights(ui.preview, query);
    const first = ui.preview.querySelector('mark.search-hit');
    if (first && first.getClientRects().length && typeof first.scrollIntoView === 'function') {
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
    markAutoDir(ui.preview);
    highlightPreview();
    bindPreviewTaskToggles();
  }

  function openNote(id, { skipGate = false, skipFlush = false } = {}) {
    const note = NotesStore.get(id);
    if (!note) return;
    const previousId = currentId && currentId !== id ? currentId : null;
    if (previousId) {
      unlockedNotes.delete(previousId);
    }
    const gated = !!note.content.locked && !unlockedNotes.has(id) && !skipGate;
    const alreadyEditing = !!currentId && ui.editor && !ui.editor.hidden;
    const syncing = vaultPullActive;
    const flushFirst = typeof NotesHistory !== 'undefined'
      ? NotesHistory.shouldFlushOnOpen(skipFlush)
      : !skipFlush;
    if (flushFirst) flushSave();
    else {
      clearTimeout(saveDebounce);
      saveDebounce = null;
    }
    // Switching notes must drop brand-new empty drafts (closeEditor already does).
    if (previousId) discardEmptyDraftNote(previousId);
    const switchingNote = currentId !== id;
    if (switchingNote) hideTagSuggest();
    currentId = id;
    listSelectionId = id;
    if (switchingNote) resetNoteTransientChrome({ clearSurfaces: true });
    // Paint the row while the list is still on screen. On iPhone the list
    // slides away with editor-open, and iOS keeps that layer's old highlight.
    markActiveNoteRow();
    rememberOpen(id);
    ui.empty.hidden = true;
    ui.editor.hidden = false;
    ui.shell.classList.add('editor-open');
    ui.title.value = NotesSearch.effectiveNoteTitle(note);
    ui.title.removeAttribute('title');
    ui.title.setAttribute('aria-label', 'Title');
    let body = note.content.content || '';
    if (!gated && (note.content.editor || '') === 'superscript' && window.NotesSuperscript) {
      body = NotesSuperscript.normalizeContent(body);
      if (body !== (note.content.content || '')) {
        note.content.content = body;
        NotesStore.upsert(id, { ...note.content });
      }
    }
    ui.body.value = gated ? '' : body;
    captureEditorBaseline(note, gated);
    // Footer comes from this note. Later attachment rendering must not be able
    // to leave the previous note's word count on screen.
    updateNoteMeta(note);
    resetNoteUndoStack(id);
    ui.editorType.value = note.content.editor || 'plain';
    syncNoteTypeMenuSelection();
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
      // Critical path: paint title/body chrome + tag bar + editor mode first so
      // the click handler stays short (avoid 183–434ms Violation warnings).
      renderTagBar(note);
      syncWritingTip(note);
      applyEditorMode();
      const deferHeavy = () => {
        if (currentId !== id) return;
        renderAttachments(id);
        renderHistory(note);
        if (typeof NotesAiChat !== 'undefined') NotesAiChat.onNoteChanged(id);
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(deferHeavy, { timeout: 120 });
      } else {
        requestAnimationFrame(deferHeavy);
      }
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
    markActiveNoteRow();
    if (syncing) {
      deferOpenNoteHeavyWork(id);
    } else {
      // Defer list rebuild — the active row marker already painted.
      requestAnimationFrame(() => {
        if (currentId !== id) return;
        renderNotes();
        if (!gated) pullNoteOcrFromServer(id).catch(() => {});
      });
    }
    updateActionButtons(note);
    updateNoteMeta(note);
    bindEditorKeyboardInset();
    requestAnimationFrame(() => {
      if (currentId !== id) return;
      renderFolders();
    });
    scrollOpenNoteToTop();
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

  function scrollOpenNoteToTop() {
    const scroller = ui.editor?.querySelector('.editor-scroll');
    if (scroller) scroller.scrollTop = 0;
    if (ui.checklist) ui.checklist.scrollTop = 0;
    if (ui.body) ui.body.scrollTop = 0;
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = 0;
    });
  }

  function syncEditorMobileProxies() {
    const lock = document.getElementById('btn-prevent-edit');
    document.querySelectorAll('.editor-mobile-proxy[data-editor-proxy="btn-prevent-edit"]').forEach((proxy) => {
      const locked = !!lock?.classList.contains('is-locked');
      proxy.classList.toggle('is-locked', locked);
      proxy.classList.toggle('is-unlocked', !locked);
      proxy.classList.toggle('active', locked);
      proxy.title = lock?.title || 'Lock editing';
      proxy.setAttribute('aria-label', proxy.title);
      proxy.querySelector('.edit-lock-open')?.toggleAttribute('hidden', locked);
      proxy.querySelector('.edit-lock-closed')?.toggleAttribute('hidden', !locked);
    });
    const starBtn = document.getElementById('btn-star');
    document.querySelectorAll('.editor-mobile-proxy[data-editor-proxy="btn-star"]').forEach((proxy) => {
      const starred = !!starBtn?.classList.contains('active');
      proxy.classList.toggle('active', starred);
      proxy.title = starBtn?.title || 'Star';
      proxy.setAttribute('aria-label', proxy.title);
      const open = proxy.querySelector('.icon-star-outline');
      const closed = proxy.querySelector('.icon-star-filled');
      if (open && closed) {
        open.hidden = starred;
        closed.hidden = !starred;
      }
    });
    const pinBtn = document.getElementById('btn-pin');
    document.querySelectorAll('.editor-mobile-proxy[data-editor-proxy="btn-pin"]').forEach((proxy) => {
      const pinned = !!pinBtn?.classList.contains('active');
      proxy.classList.toggle('active', pinned);
      proxy.title = pinBtn?.title || 'Pin';
      proxy.setAttribute('aria-label', proxy.title);
      const open = proxy.querySelector('.icon-pin-outline');
      const closed = proxy.querySelector('.icon-pin-filled');
      if (open && closed) {
        open.hidden = pinned;
        closed.hidden = !pinned;
      }
    });
    const shareBtn = document.getElementById('btn-share');
    document.querySelectorAll('.editor-mobile-proxy[data-editor-proxy="btn-share"]').forEach((proxy) => {
      const title = shareBtn?.getAttribute('aria-label')
        || shareBtn?.title
        || 'Share note';
      proxy.title = title;
      proxy.setAttribute('aria-label', title);
    });
  }

  function syncNoteTypeMenuSelection() {
    const select = ui.editorType;
    const menu = document.getElementById('note-type-menu');
    if (!select || !menu) return;
    const value = select.value || 'plain';
    menu.querySelectorAll('.note-type-menu-item').forEach((item) => {
      const match = item.getAttribute('data-note-type') === value;
      item.setAttribute('aria-checked', match ? 'true' : 'false');
    });
  }

  function setNoteTypeMenuOpen(open) {
    const menu = document.getElementById('note-type-menu');
    const trigger = document.getElementById('btn-note-type-menu');
    if (!menu || !trigger) return;
    const on = !!open;
    menu.hidden = !on;
    trigger.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function syncEditorMobileDocActions() {
    const fsBtn = document.getElementById('btn-mobile-doc-fullscreen');
    const closeBtn = document.getElementById('btn-mobile-doc-close');
    const shareBtn = document.getElementById('btn-mobile-doc-attachment-share');
    const desktopFsBtn = document.getElementById('btn-desktop-doc-fullscreen');
    const show = mobileDocToolbarActive();
    if (desktopFsBtn) desktopFsBtn.hidden = !show || !isDesktopLayout();
    if (!fsBtn || !shareBtn) return;
    if (!isPhoneShell()) {
      fsBtn.hidden = true;
      if (closeBtn) closeBtn.hidden = true;
      shareBtn.hidden = true;
      syncShareLabels();
      return;
    }
    fsBtn.hidden = !show;
    if (closeBtn) closeBtn.hidden = !show;
    /* Primary row Share is always shown on phone; route attachment share through it. */
    shareBtn.hidden = true;
    shareBtn.title = 'Share attachment';
    shareBtn.setAttribute('aria-label', 'Share attachment');
    syncShareLabels();
  }

  function updateActionButtons(note) {
    const starBtn = document.getElementById('btn-star');
    const pinBtn = document.getElementById('btn-pin');
    if (pinBtn) {
      pinBtn.title = note.content.pinned ? 'Unpin' : 'Pin';
      pinBtn.setAttribute('aria-label', pinBtn.title);
      setEditorMenuLabel(pinBtn, pinBtn.title);
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
      setEditorMenuLabel(starBtn, starBtn.title);
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
      setEditorMenuLabel(archiveBtn, archiveBtn.title);
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
      setEditorMenuLabel(trashBtn, trashBtn.title);
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
    syncEditorMobileDocActions();
    syncEditorMobileProxies();
    if (note && note.content?.locked && !unlockedNotes.has(note.uuid)) {
      ['btn-share', 'btn-note-info', 'btn-note-type-menu', 'btn-trash', 'btn-delete-forever', 'btn-clear-checked', 'btn-undo', 'btn-redo', 'btn-prevent-edit', 'btn-ai-chat', 'btn-star', 'btn-pin', 'btn-archive', 'btn-duplicate', 'btn-note-secure-send', 'btn-download-note', 'note-folder-control'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
    }
    syncUndoButtons();
    syncNoteFolderControl(note);
    syncNoteInfoActions(note);
    syncDownloadNoteButton();
    syncRescanOcrButton();
  }

  function syncNoteFolderControl(note) {
    const select = document.getElementById('note-folder-select');
    const wrap = document.getElementById('note-folder-control');
    if (!select) return;
    const locked = !!(note?.content?.locked && !unlockedNotes.has(note?.uuid));
    if (wrap) wrap.hidden = locked;
    const folders = NotesStore.listFolders?.() || [];
    const current = note?.content?.folder_id || '';
    const options = ['<option value="">No folder</option>']
      .concat(folders.map((folder) => (
        `<option value="${escapeAttr(folder.uuid)}">${escapeHtml(folder.content?.title || 'Folder')}</option>`
      )))
      .concat(['<option value="__new__">New folder…</option>']);
    select.innerHTML = options.join('');
    select.value = folders.some((folder) => folder.uuid === current) ? current : '';
  }

  function assignCurrentNoteFolder(folderId) {
    if (!currentId || !vaultKeyProven()) return;
    const note = NotesStore.get(currentId);
    if (!note || note.content?.type !== 'note') return;
    const next = String(folderId || '');
    if ((note.content.folder_id || '') === next) return;
    // Folder membership is not an edit. Keep content.updated_at so the list
    // and the editor keep showing the same relative time.
    NotesStore.upsert(currentId, { ...note.content, folder_id: next }, {
      touchUpdatedAt: false,
      touchSyncOnly: true,
    });
    renderFolders();
    renderNotes();
    updateNoteMeta(NotesStore.get(currentId));
    toast(next ? 'Moved to folder' : 'Removed from folder');
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
    if (!ui.noteMeta) return;
    if (note.content?.locked && !unlockedNotes.has(note.uuid)) {
      ui.noteMeta.textContent = 'Protected note';
      return;
    }
    const { words, minutes } = displayedReading(note);
    const updated = relativeTime(noteEditedAtMs(note));
    const primary = document.createElement('span');
    const wordLabel = `${words} ${words === 1 ? 'word' : 'words'}`;
    primary.textContent = words
      ? (minutes ? `${wordLabel} · ${minutes} min read · ${updated}` : `${wordLabel} · ${updated}`)
      : `0 words · ${updated}`;
    ui.noteMeta.replaceChildren(primary);
    const scannedWords = scannedTextWordCount(note);
    if (scannedWords > 0) {
      const scan = document.createElement('span');
      scan.className = 'note-meta-scan';
      scan.textContent = `Scanned text: ${scannedWords} ${scannedWords === 1 ? 'word' : 'words'}`;
      ui.noteMeta.append(scan);
    }
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
    // A pull replaced the open note's text: never write the stale editor
    // buffer back over it (this also covers the flush on lock).
    if (storeChangedUnderEditor(note) && reconcileOpenNoteWithStore(currentId) !== 'conflict') return;
    const live = NotesStore.listAttachments(currentId).map((item) => item.uuid);
    const next = {
      ...note.content,
      prevent_edit: !!note.content.prevent_edit,
      attachments: [...new Set([...(note.content.attachments || []), ...live])],
    };
    if (!note.content.prevent_edit) {
      const manual = titleLockedByUser(note);
      const body = ui.body.value || '';
      next.title_manual = manual;
      next.title = manual
        ? (String(ui.title.value || '').trim() || '')
        : (NotesSearch.derivedTitleFromBody(body) || '');
      if (NotesSearch.isPlaceholderTitle?.(next.title)) {
        next.title = '';
        next.title_manual = false;
      }
      next.content = body;
      next.editor = ui.editorType.value || 'plain';
    }
    const existing = NotesStore.get(currentId);
    const discardProbe = {
      ...existing,
      uuid: currentId,
      rev: existing?.rev,
      content: {
        ...next,
        revisions: existing?.content?.revisions || next.revisions || [],
        tags: next.tags || existing?.content?.tags || [],
        folder_id: next.folder_id || existing?.content?.folder_id || '',
        attachments: next.attachments || [],
      },
    };
    // Empty drafts with no user content are removed. Ever-saved notes must
    // persist as empty Untitled when the user clears title+body — never discard
    // and never skip the write (sameNoteContent maps '' ↔ 'Untitled').
    const everSaved = !!NotesSearch.noteHasBeenSaved?.(existing);
    if (!live.length && !everSaved && NotesSearch.noteMayHardDiscard?.(discardProbe)) {
      discardEmptyDraftNote(currentId);
      return;
    }
    const hasUserText = !!(
      String(next.content || '').trim()
      || (String(next.title || '').trim() && !NotesSearch.isPlaceholderTitle?.(next.title))
    );
    if (hasUserText || everSaved) next.user_edited = true;
    if (everSaved && !live.length
      && !String(next.content || '').trim()
      && NotesSearch.isPlaceholderTitle?.(next.title || '')) {
      next.title = '';
      next.title_manual = false;
      next.user_edited = true;
      const prevBody = String(note.content?.content || '');
      const prevTitle = String(note.content?.title || '').trim();
      if (prevBody || (prevTitle && !NotesSearch.isPlaceholderTitle?.(prevTitle))
        || note.content?.user_edited) {
        NotesStore.upsert(currentId, next, { recordRevision: true });
        ackLocalSaveStatus();
        const savedNote = NotesStore.get(currentId);
        captureEditorBaseline(savedNote, false);
        updateNoteMeta(savedNote);
        renderHistory(savedNote);
        const row = ui.noteList?.querySelector(`.note-row[data-id="${CSS.escape(currentId)}"]`);
        const rowTitle = row?.querySelector('h3');
        if (rowTitle) {
          rowTitle.textContent = 'Untitled';
          rowTitle.classList.add('note-title-placeholder');
        }
        return;
      }
    }
    if (NotesSearch.sameNoteContent(note.content, next)) {
      updateNoteMeta(note);
      return;
    }
    NotesStore.upsert(currentId, next, { recordRevision: true });
    ackLocalSaveStatus();
    const savedNote = NotesStore.get(currentId);
    captureEditorBaseline(savedNote, false);
    updateNoteMeta(savedNote);
    renderHistory(savedNote);
    const displayTitle = NotesSearch.effectiveNoteTitle(NotesStore.get(currentId));
    const row = ui.noteList?.querySelector(`.note-row[data-id="${CSS.escape(currentId)}"]`);
    const rowTitle = row?.querySelector('h3');
    if (rowTitle) {
      rowTitle.textContent = displayTitle || 'Untitled';
      rowTitle.classList.toggle('note-title-placeholder', !displayTitle);
    }
    syncNoteRowActionLabels(currentId, displayTitle || 'Untitled');
    const rowTime = row?.querySelector('.note-modified[data-edited], .note-modified');
    if (rowTime && savedNote) {
      const editedMs = noteEditedAtMs(savedNote);
      rowTime.dataset.edited = String(editedMs || '');
      rowTime.title = listTimeAbsolute(editedMs);
      rowTime.textContent = listTimeLabel(editedMs);
    }
    if (String(next.content || '').trim()) maybeOfferWritingTip();
  }

  function ackLocalSaveStatus() {
    if (!ui.saveStatus) return;
    // Local upsert already landed — don't leave "Saving…" until a push finishes
    // (that hung ~6s when a false-online probe blocked behind a request timeout).
    ui.saveStatus.textContent = networkReachable
      ? 'Saved'
      : 'Saved on this device · will sync when online';
    ui.saveStatus.classList.remove('error');
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

  function editorReadingText() {
    if (ui.checklist && !ui.checklist.hidden) {
      return [...ui.checklist.querySelectorAll('.check-text')]
        .map((el) => String(el.value || '').trim())
        .filter(Boolean)
        .join('\n');
    }
    return String(ui.body?.value || '');
  }

  function displayedReading(note) {
    if (note && note.uuid === currentId && ui.body && !(note.content?.locked && !unlockedNotes.has(note.uuid))) {
      return NotesSearch.readingStats(editorReadingText());
    }
    return NotesSearch.noteBodyReading(note);
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

  function formatDeviceRowName(item) {
    const base = item?.device || 'Unknown device';
    const suffix = String(item?.device_id_suffix || '').trim();
    return suffix ? `${base} · ${suffix}` : base;
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
      if (item.inactive) row.classList.add('device-row-inactive');
      row.setAttribute('role', 'listitem');
      const head = document.createElement('div');
      head.className = 'device-row-head';
      const name = document.createElement('span');
      name.className = 'device-row-name';
      name.textContent = formatDeviceRowName(item);
      head.appendChild(name);
      if (item.current) {
        const badge = document.createElement('span');
        badge.className = 'device-current';
        badge.textContent = 'This device';
        head.appendChild(badge);
      }
      if (item.inactive) {
        const inactive = document.createElement('span');
        inactive.className = 'device-inactive';
        inactive.textContent = 'Inactive';
        head.appendChild(inactive);
      }
      const meta = document.createElement('p');
      meta.className = 'device-meta';
      const parts = [
        `Last seen ${formatDeviceLogin(item.last_seen_at || item.last_login_at)}`,
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
    renderVaultFreshnessPanel();
    signedInDevicesTimer = window.setInterval(() => {
      if (!document.body.classList.contains('settings-open')) {
        stopSignedInDevicesRefresh();
        return;
      }
      loadSignedInDevices().catch(() => {});
      renderVaultFreshnessPanel();
    }, 10000);
  }

  let deviceStartScanTimer = 0;
  let deviceStartScanStream = null;

  function stopDeviceStartQrScan() {
    if (deviceStartScanTimer) {
      clearTimeout(deviceStartScanTimer);
      deviceStartScanTimer = 0;
    }
    if (deviceStartScanStream) {
      try {
        deviceStartScanStream.getTracks().forEach((t) => t.stop());
      } catch (err) { /* ignore */ }
      deviceStartScanStream = null;
    }
    const video = document.getElementById('device-start-qr-video');
    if (video) {
      try { video.srcObject = null; } catch (err) { /* ignore */ }
      video.hidden = true;
    }
  }

  function renderDeviceStartBanner() {
    const banner = document.getElementById('device-start-banner');
    if (!banner || typeof NotesFreshness === 'undefined') return;
    if (!NotesStore.isUnlocked?.()) {
      banner.hidden = true;
      return;
    }
    const snap = NotesFreshness.getPublicSnapshot();
    banner.hidden = !snap.needsStartConfirm;
  }

  function renderAboutDeviceStartStatus() {
    const el = document.getElementById('about-device-start-status');
    if (!el || typeof NotesFreshness === 'undefined') return;
    if (!NotesStore.isUnlocked?.()) {
      el.hidden = true;
      return;
    }
    const snap = NotesFreshness.getPublicSnapshot();
    if (snap.showUnverifiedLabel || snap.startStatus === 'anchored_backup') {
      el.hidden = false;
      el.textContent = snap.startLabel || 'Unverified start';
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function deviceStartExplainer(snap) {
    if (snap.startVerified) {
      if (snap.startStatus === 'anchored_backup') {
        return 'This device’s start is anchored to a backup. You can still show a code so another device can verify against this tip.';
      }
      return 'This device’s start is verified. Show a code so a new device can confirm it has the same vault tip.';
    }
    if (snap.tip) {
      return 'This device is labeled Unverified start until you confirm it against a trusted device (or tap Later). Enter a code from a trusted device, scan its QR, or match the fingerprint by eye.';
    }
    return 'Sync to adopt a vault tip. Until you confirm against a trusted device, this device stays labeled Unverified start.';
  }

  function renderVaultFreshnessPanel() {
    const panel = document.getElementById('vault-freshness-panel');
    const summary = document.getElementById('vault-freshness-summary');
    if (!panel || !summary || typeof NotesFreshness === 'undefined') return;
    if (!NotesStore.isUnlocked?.()) {
      panel.hidden = true;
      renderDeviceStartBanner();
      renderAboutDeviceStartStatus();
      return;
    }
    const snap = NotesFreshness.getPublicSnapshot();
    panel.hidden = false;
    const counter = snap.counter || 0;
    const fp = snap.fingerprint || '—';
    summary.textContent = snap.tip
      ? `Vault head on this device: counter ${counter} · fingerprint ${fp}`
      : 'Vault head on this device: none yet (sync to adopt a tip).';
    const chip = document.getElementById('vault-freshness-chip');
    if (chip) {
      if (snap.startVerified) {
        chip.hidden = false;
        chip.textContent = 'Verified';
        chip.classList.add('is-verified');
        chip.classList.remove('is-unverified');
      } else if (snap.tip || snap.showUnverifiedLabel) {
        chip.hidden = false;
        chip.textContent = 'Not verified yet';
        chip.classList.add('is-unverified');
        chip.classList.remove('is-verified');
      } else {
        chip.hidden = true;
        chip.textContent = '';
        chip.classList.remove('is-verified', 'is-unverified');
      }
    }
    const startLabel = document.getElementById('vault-freshness-start-label');
    if (startLabel) {
      // Keep the exact phrase "Unverified start" visible for unverified devices.
      if (snap.showUnverifiedLabel) {
        startLabel.hidden = false;
        startLabel.textContent = 'Unverified start';
      } else if (snap.startStatus === 'anchored_backup' && snap.startLabel) {
        startLabel.hidden = false;
        startLabel.textContent = snap.startLabel;
      } else {
        startLabel.hidden = true;
        startLabel.textContent = '';
      }
    }
    const explainer = document.getElementById('vault-freshness-explainer');
    if (explainer) explainer.textContent = deviceStartExplainer(snap);
    const approveBtn = document.getElementById('btn-approve-new-device');
    if (approveBtn) approveBtn.hidden = !snap.canApproveDevice;
    const verifyBtn = document.getElementById('btn-verify-device-start');
    if (verifyBtn) verifyBtn.hidden = !(snap.showUnverifiedLabel);
    if (snap.startVerified) {
      const verifyPanel = document.getElementById('verify-device-start-panel');
      if (verifyPanel) verifyPanel.hidden = true;
      const codeForm = document.getElementById('device-start-code-form');
      if (codeForm) codeForm.hidden = true;
      stopDeviceStartQrScan();
    }
    renderDeviceStartBanner();
    renderAboutDeviceStartStatus();
  }

  function showApproveNewDevicePanel() {
    const panel = document.getElementById('approve-new-device-panel');
    const img = document.getElementById('approve-new-device-qr');
    const meta = document.getElementById('approve-new-device-meta');
    const codeEl = document.getElementById('approve-new-device-code');
    if (typeof NotesFreshness === 'undefined') return;
    let payload;
    try {
      payload = NotesFreshness.buildApprovalPayload();
    } catch (err) {
      toast(err.message || 'Cannot build approval code', true);
      return;
    }
    if (panel) panel.hidden = false;
    if (meta) {
      meta.textContent = `Counter ${payload.counter} · fingerprint ${payload.fingerprint}`;
    }
    if (codeEl) codeEl.textContent = payload.code;
    if (img) {
      const url = NotesFreshness.renderApprovalQrDataUrl(payload);
      if (url) {
        img.src = url;
        img.hidden = false;
      } else {
        img.hidden = true;
      }
    }
  }

  function hideApproveNewDevicePanel() {
    const panel = document.getElementById('approve-new-device-panel');
    if (panel) panel.hidden = true;
  }

  async function copyApproveNewDeviceCode() {
    const codeEl = document.getElementById('approve-new-device-code');
    const text = String(codeEl?.textContent || '').trim();
    if (!text) {
      toast('No code to copy', true);
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('Code copied');
    } catch (err) {
      toast(err.message || 'Could not copy', true);
    }
  }

  function showVerifyDeviceStartPanel() {
    // Open Settings locally (no network). Banner used to click a missing
    // #btn-settings id, so Verify now did nothing offline.
    if (typeof openSettings === 'function') {
      openSettings();
    } else {
      const settings = document.getElementById('settings-panel');
      if (settings) {
        settings.hidden = false;
        settings.removeAttribute('hidden');
      }
      document.body.classList.add('settings-open');
    }
    if (typeof NotesFreshness !== 'undefined') {
      NotesFreshness.reopenStartVerification();
    }
    const panel = document.getElementById('verify-device-start-panel');
    if (panel) panel.hidden = false;
    renderVaultFreshnessPanel();
    try {
      document.getElementById('signed-in-devices-group')?.scrollIntoView?.({ block: 'nearest' });
      panel?.scrollIntoView?.({ block: 'nearest' });
    } catch (err) { /* ignore */ }
  }

  function setDeviceStartCodeError(message) {
    const errEl = document.getElementById('device-start-code-error');
    if (!errEl) return;
    if (message) {
      errEl.hidden = false;
      errEl.textContent = message;
    } else {
      errEl.hidden = true;
      errEl.textContent = '';
    }
  }

  function normalizeDeviceStartCode(raw) {
    return String(raw || '').replace(/[\s-]+/g, '').trim();
  }

  function applyDeviceStartVerifyResult(result, { fromCodeField = false } = {}) {
    const resultEl = document.getElementById('vault-freshness-verify-result');
    const fieldErrors = fromCodeField && (result.error === 'checksum' || result.error === 'version'
      || result.error === 'empty' || result.error === 'format' || result.error === 'truncated'
      || result.error === 'tip' || result.error === 'counter' || result.error === 'ts');
    if (fieldErrors) {
      setDeviceStartCodeError(result.message || 'That approval code could not be read.');
      if (resultEl) {
        resultEl.hidden = true;
        resultEl.textContent = '';
        resultEl.classList.remove('device-start-verify-ok');
      }
      return;
    }
    setDeviceStartCodeError('');
    let message = result.message || (result.ok ? 'Verified.' : 'Not verified.');
    if (result.rollback) {
      message = `${message}\nReconnect, then get a fresh code from your other device.`;
    }
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.textContent = '';
      resultEl.classList.toggle('device-start-verify-ok', !!result.ok);
      if (result.ok) {
        resultEl.textContent = `✓ ${message}`;
      } else {
        resultEl.textContent = message;
      }
    }
    // Success stays visible inline; toast only for failures so it never covers
    // the Signed-in devices list while Settings is open.
    if (!result.ok) {
      toast(result.message || 'Not verified', true);
    }
    renderVaultFreshnessPanel();
    if (result.ok) {
      stopDeviceStartQrScan();
      const panel = document.getElementById('verify-device-start-panel');
      if (panel) panel.hidden = true;
      const codeForm = document.getElementById('device-start-code-form');
      if (codeForm) codeForm.hidden = true;
    }
  }

  function showDeviceStartCodeForm() {
    const form = document.getElementById('device-start-code-form');
    const input = document.getElementById('device-start-code-input');
    if (form) form.hidden = false;
    setDeviceStartCodeError('');
    if (input) {
      input.value = '';
      try { input.focus(); } catch (err) { /* ignore */ }
    }
  }

  function submitDeviceStartCode() {
    if (typeof NotesFreshness === 'undefined') return;
    const input = document.getElementById('device-start-code-input');
    const raw = normalizeDeviceStartCode(input?.value || '');
    if (!raw) {
      setDeviceStartCodeError('Enter an approval code or scan a QR.');
      return;
    }
    applyDeviceStartVerifyResult(NotesFreshness.verifyAnchor(raw), { fromCodeField: true });
  }

  async function confirmDeviceStartByEye() {
    if (typeof NotesFreshness === 'undefined') return;
    const snap = NotesFreshness.getPublicSnapshot();
    const ok = await confirmAction(
      `On your other (trusted) device, open Settings → Signed-in devices → On a trusted device: Show a code and confirm it shows counter ${snap.counter} and fingerprint ${snap.fingerprint}.`,
      {
        title: 'Match by eye?',
        confirmLabel: 'They match',
        cancelLabel: 'Cancel',
      },
    );
    if (!ok) return;
    applyDeviceStartVerifyResult(NotesFreshness.confirmStartByEye());
  }

  function decodeDeviceStartQrFromVideo() {
    const video = document.getElementById('device-start-qr-video');
    const canvas = document.getElementById('device-start-qr-canvas');
    if (!video || !canvas || video.readyState < 2) return '';
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return '';
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '';
    ctx.drawImage(video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    if (typeof jsQR !== 'function') return '';
    const result = jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' });
    return result && result.data ? String(result.data) : '';
  }

  async function startDeviceStartQrScan() {
    const status = document.getElementById('device-start-qr-status');
    const video = document.getElementById('device-start-qr-video');
    stopDeviceStartQrScan();
    if (!navigator.mediaDevices?.getUserMedia || !video) {
      toast('Camera is not available on this device.', true);
      return;
    }
    try {
      deviceStartScanStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      video.srcObject = deviceStartScanStream;
      video.hidden = false;
      await video.play();
      if (status) {
        status.hidden = false;
        status.textContent = 'Point the camera at the approval QR.';
      }
      const tick = () => {
        const value = decodeDeviceStartQrFromVideo();
        if (value) {
          stopDeviceStartQrScan();
          if (status) {
            status.hidden = false;
            status.textContent = 'QR scanned.';
          }
          applyDeviceStartVerifyResult(NotesFreshness.verifyAnchor(value));
          return;
        }
        deviceStartScanTimer = setTimeout(tick, 250);
      };
      deviceStartScanTimer = setTimeout(tick, 250);
    } catch (err) {
      stopDeviceStartQrScan();
      toast(err.message || 'Could not open the camera.', true);
    }
  }

  async function compareVaultHeadWithPrompt() {
    const resultEl = document.getElementById('vault-freshness-compare-result');
    if (typeof NotesFreshness === 'undefined') return;
    const snap = NotesFreshness.getPublicSnapshot();
    const other = window.prompt(
      'Enter the other device’s vault fingerprint (and optional counter), e.g. “ab12cd…ef34” or “12 ab12cd…ef34”.',
      '',
    );
    if (other == null) return;
    const raw = String(other).trim().toLowerCase();
    if (!raw) return;
    const parts = raw.split(/\s+/);
    let otherCounter = null;
    let otherFp = raw;
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      otherCounter = Number(parts[0]);
      otherFp = parts.slice(1).join('');
    }
    const localFp = String(snap.fingerprint || '').toLowerCase();
    const tip = String(snap.tip || '').toLowerCase();
    const fpMatch = otherFp && (
      localFp === otherFp
      || tip.startsWith(otherFp.replace(/…/g, '').slice(0, 6))
      || (otherFp.includes('…') && localFp === otherFp)
    );
    const counterMatch = otherCounter == null || otherCounter === Number(snap.counter);
    let message;
    if (fpMatch && counterMatch) {
      message = 'Match — both devices report the same vault tip.';
    } else if (fpMatch && !counterMatch) {
      message = 'Fingerprint matches but counters differ — sync both devices and compare again.';
    } else {
      message = 'No match — sync both devices, then compare again. Persistent mismatch can mean a freeze or fork.';
    }
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.textContent = message;
    }
    toast(message, !(fpMatch && counterMatch));
  }

  let freshnessToastAt = 0;
  function wireFreshnessWarnings() {
    if (typeof NotesFreshness === 'undefined' || NotesFreshness.__uiWired) return;
    NotesFreshness.__uiWired = true;
    NotesFreshness.onChange((snap) => {
      renderVaultFreshnessPanel();
      const latest = snap?.warnings?.[0];
      if (!latest || !latest.message) return;
      if (latest.at && latest.at <= freshnessToastAt) return;
      freshnessToastAt = latest.at || Date.now();
      toast(latest.message, true);
    });
  }
  wireFreshnessWarnings();
  document.getElementById('btn-compare-vault-head')?.addEventListener('click', () => {
    compareVaultHeadWithPrompt().catch((err) => toast(err.message || 'Compare failed', true));
  });
  document.getElementById('btn-approve-new-device')?.addEventListener('click', () => {
    showApproveNewDevicePanel();
  });
  document.getElementById('btn-approve-new-device-hide')?.addEventListener('click', () => {
    hideApproveNewDevicePanel();
  });
  document.getElementById('btn-approve-new-device-copy')?.addEventListener('click', () => {
    copyApproveNewDeviceCode().catch((err) => toast(err.message || 'Copy failed', true));
  });
  document.getElementById('btn-verify-device-start')?.addEventListener('click', () => {
    showVerifyDeviceStartPanel();
  });
  document.getElementById('btn-device-start-verify')?.addEventListener('click', () => {
    showVerifyDeviceStartPanel();
  });
  document.getElementById('btn-device-start-skip')?.addEventListener('click', () => {
    if (typeof NotesFreshness === 'undefined') return;
    NotesFreshness.skipStartVerification();
    toast('Later — this device stays labeled Unverified start.');
    renderVaultFreshnessPanel();
  });
  document.getElementById('btn-device-start-scan-qr')?.addEventListener('click', () => {
    startDeviceStartQrScan().catch((err) => toast(err.message || 'Scan failed', true));
  });
  document.getElementById('btn-device-start-enter-code')?.addEventListener('click', () => {
    showDeviceStartCodeForm();
  });
  document.getElementById('btn-device-start-code-submit')?.addEventListener('click', () => {
    submitDeviceStartCode();
  });
  document.getElementById('device-start-code-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitDeviceStartCode();
    }
  });
  document.getElementById('btn-device-start-confirm-eye')?.addEventListener('click', () => {
    confirmDeviceStartByEye().catch((err) => toast(err.message || 'Confirm failed', true));
  });

  async function loadSignedInDevices() {
    const el = document.getElementById('signed-in-devices');
    if (!el) return;
    try {
      const data = await NotesStore.api('/api/sessions');
      renderSignedInDevices(data.sessions || []);
      renderVaultFreshnessPanel();
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
      const remotePath = String(account.pcloud_remote_path || '').trim();
      const legacyDefault = remotePath === 'HomelabNotes/backups' || remotePath === 'Deeperguard/backups';
      document.getElementById('pcloud-remote-path').value = (!account.pcloud_enabled && legacyDefault) ? '' : remotePath;
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
      const on = btn.dataset.themeOpt === prefs.theme;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.getElementById('pref-compact').checked = !!prefs.compactList;
    document.getElementById('pref-hide-previews').checked = !!prefs.hidePreviews;
    document.getElementById('pref-font-size').value = String(prefs.fontSize);
    document.getElementById('pref-mono').checked = !!prefs.monospace;
    document.getElementById('pref-spellcheck').checked = !!prefs.spellcheck;
    document.getElementById('pref-auto-preview').checked = !!prefs.autoPreview;
    const autoOpenPdf = document.getElementById('pref-auto-open-pdf-only');
    if (autoOpenPdf) autoOpenPdf.checked = prefs.autoOpenPdfOnly !== false;
    document.getElementById('pref-auto-lock').value = String(prefs.autoLockMin || 0);
    const lockUnfocus = document.getElementById('pref-lock-on-unfocus');
    if (lockUnfocus) lockUnfocus.value = lockOnUnfocusMode();
    const rememberDevice = document.getElementById('pref-remember-device');
    if (rememberDevice) rememberDevice.checked = !!prefs.rememberDevice;
    const lightVaultPref = document.getElementById('pref-light-vault');
    if (lightVaultPref) lightVaultPref.checked = !!prefs.lightVault;
    refreshLocalFilesSummary().catch(() => {});
    initAiChatSettings();
    armCurrentVaultPasswordField();
    renderEmailVerification(account);
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
        intentionalCopy: true,
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
        folderMap: folderMap(),
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

  function serverReachableCopy() {
    return selfHostNotes() ? 'Server reachable on LAN' : 'Server reachable';
  }

  function serverUnreachableCopy() {
    return selfHostNotes()
      ? 'Server unreachable — join home Wi‑Fi or WireGuard'
      : 'Server unreachable';
  }

  async function refreshSettingsDiagnostics() {
    const el = document.getElementById('privacy-status');
    if (!el) return;
    let serverLabel = 'Checking server…';
    let serverBuild = '';
    try {
      const data = await fetchHealthJson();
      if (data?.ok) {
        serverBuild = String(data.build || '');
        serverLabel = serverReachableCopy();
      }
    } catch (err) {
      /* fall through to OCR probe */
    }
    if (serverLabel === 'Checking server…') {
      if (window.NotesOcr && typeof NotesOcr.serverReachable === 'function') {
        serverLabel = (await NotesOcr.serverReachable())
          ? serverReachableCopy()
          : serverUnreachableCopy();
      } else if (!networkReachable) {
        serverLabel = serverUnreachableCopy();
      } else {
        serverLabel = serverReachableCopy();
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
      escapeHtml(zkLine),
      escapeHtml(vaultLine),
      escapeHtml(hostLine),
    ];
    const technical = [
      buildStale
        ? `<strong class="ocr-stale">App v${escapeHtml(build)} · server v${escapeHtml(serverBuild)} — refresh app cache on Wi‑Fi</strong>`
        : `<strong>Deeperguard v${escapeHtml(build)}</strong>`,
      escapeHtml(serverLabel),
    ];
    const technicalEl = document.getElementById('privacy-technical');
    if (technicalEl) technicalEl.innerHTML = technical.join('<br>');
    if (stale) {
      lines.push(`<span class="ocr-stale">${stale} note${stale === 1 ? '' : 's'} need search index repair (Advanced)</span>`);
    }
    el.innerHTML = lines.join('<br>');
    lastDiagnosticsText = lines.concat(technical).map((line) => line.replace(/<[^>]+>/g, '')).join('\n');
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
        const data = await fetchHealthJson();
        if (data?.ok) {
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

  const SECURE_SEND_NO_VAULT_RECORD_MSG =
    'This send was created before multi-device Sent — open it on the device that made the link, or create a new send.';

  function secureSendLinkCanWebShare() {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
    if (typeof globalThis.isSecureContext === 'boolean' && !globalThis.isSecureContext) return false;
    try {
      const probe = { url: 'https://example.com/receive/test#v1.probe' };
      return !navigator.canShare || navigator.canShare(probe);
    } catch (_) {
      return false;
    }
  }

  function syncSecureSendShareButtons() {
    const show = secureSendLinkCanWebShare();
    for (const id of ['btn-secure-send-share', 'btn-secure-send-detail-share']) {
      const btn = document.getElementById(id);
      if (btn) btn.hidden = !show;
    }
  }

  async function shareSecureSendLink(url, { title } = {}) {
    const link = String(url || '').trim();
    if (!link || !secureSendLinkCanWebShare()) return;
    const payload = { url: link };
    const label = String(title || '').trim();
    if (label) {
      payload.title = label;
      payload.text = label;
    }
    try {
      if (navigator.canShare && !navigator.canShare(payload)) {
        await navigator.share({ url: link });
      } else {
        await navigator.share(payload);
      }
    } catch (err) {
      if (err && (err.name === 'AbortError' || /cancel/i.test(String(err.message || '')))) return;
      throw err;
    }
  }

  function secureSendStatusLabel(item) {
    return item?.status_label
      || ({ active: 'Waiting', used: 'Opened', expired: 'Expired', canceled: 'Revoked' }[item?.status]
        || item?.status
        || '?');
  }

  function secureSendSnapshotAttachmentNames() {
    const fromStaged = secureSendStagedEntries
      .map((row) => String(row.name || '').trim())
      .filter(Boolean);
    if (fromStaged.length) return fromStaged;
    if (secureSendPendingFile?.name) return [String(secureSendPendingFile.name)];
    return [];
  }

  let secureSendDetailServerItem = null;

  function closeSecureSendSentDetail() {
    secureSendDetailServerItem = null;
    const sheet = document.getElementById('secure-send-detail');
    const backdrop = document.getElementById('secure-send-detail-backdrop');
    if (sheet) sheet.hidden = true;
    if (backdrop) backdrop.hidden = true;
  }

  function openSecureSendSentDetail(item) {
    if (!item?.id) return;
    secureSendDetailServerItem = item;
    const local = NotesStore.getSecureSendSentRecord
      ? NotesStore.getSecureSendSentRecord(item.id)
      : null;
    const sheet = document.getElementById('secure-send-detail');
    const backdrop = document.getElementById('secure-send-detail-backdrop');
    const preview = document.getElementById('secure-send-detail-preview');
    const titleEl = document.getElementById('secure-send-detail-snapshot-title');
    const bodyEl = document.getElementById('secure-send-detail-snapshot-body');
    const attList = document.getElementById('secure-send-detail-attachments');
    const noLocal = document.getElementById('secure-send-detail-no-local');
    const statusEl = document.getElementById('secure-send-detail-status');
    const createdEl = document.getElementById('secure-send-detail-created');
    const expiresEl = document.getElementById('secure-send-detail-expires');
    const linkWrap = document.getElementById('secure-send-detail-link-wrap');
    const linkInput = document.getElementById('secure-send-detail-link');
    const copyHint = document.getElementById('secure-send-detail-copy-hint');
    const revokeBtn = document.getElementById('btn-secure-send-detail-revoke');

    const snap = local?.snapshot;
    const hasPreview = !!(snap && (snap.title || snap.body || (snap.attachment_names && snap.attachment_names.length)));
    if (preview) preview.hidden = !hasPreview;
    if (noLocal) noLocal.hidden = !!local;
    if (titleEl) {
      titleEl.textContent = snap?.title ? String(snap.title) : '';
      titleEl.hidden = !snap?.title;
    }
    if (bodyEl) {
      bodyEl.textContent = snap?.body ? String(snap.body) : '';
      bodyEl.hidden = !snap?.body;
    }
    if (attList) {
      attList.textContent = '';
      const names = Array.isArray(snap?.attachment_names) ? snap.attachment_names : [];
      if (names.length) {
        attList.hidden = false;
        for (const name of names) {
          const li = document.createElement('li');
          li.textContent = name;
          attList.appendChild(li);
        }
      } else {
        attList.hidden = true;
      }
    }
    if (statusEl) statusEl.textContent = secureSendStatusLabel(item);
    if (createdEl) {
      createdEl.textContent = item.created_at
        ? new Date(item.created_at * 1000).toLocaleString()
        : '—';
    }
    if (expiresEl) {
      expiresEl.textContent = item.expires_at
        ? new Date(item.expires_at * 1000).toLocaleString()
        : '—';
    }
    const shareUrl = local?.shareUrl ? String(local.shareUrl) : '';
    if (linkWrap) linkWrap.hidden = !shareUrl;
    if (linkInput) linkInput.value = shareUrl;
    if (copyHint) copyHint.hidden = !!shareUrl;
    syncSecureSendShareButtons();
    if (revokeBtn) {
      revokeBtn.hidden = item.status !== 'active';
      revokeBtn.disabled = item.status !== 'active';
    }
    if (sheet) {
      sheet.hidden = false;
      const body = sheet.querySelector('.secure-send-detail-body');
      if (body) body.scrollTop = 0;
    }
    if (backdrop) backdrop.hidden = false;
  }

  async function revokeSecureSendSentItem(item) {
    if (!item?.id || item.status !== 'active') return;
    const ok = await confirmAction(
      'Revoke this link? It will stop working for anyone who still has it.',
      { title: 'Revoke link?', confirmLabel: 'Revoke', cancelLabel: 'Keep' },
    );
    if (!ok) return;
    try {
      await NotesStore.api(`/api/secure-send/${encodeURIComponent(item.id)}/cancel`, {
        method: 'POST',
        body: '{}',
      });
      toast('Link revoked — it stops working now');
      closeSecureSendSentDetail();
      refreshSecureSendList();
    } catch (err) {
      toast(err?.message || 'Could not revoke', true);
    }
  }

  async function refreshSecureSendList() {
    const list = document.getElementById('secure-send-sent-list');
    if (!list || !window.NotesStore) return;
    try {
      const data = await NotesStore.api('/api/secure-send/sent');
      const items = Array.isArray(data?.items) ? data.items : [];
      list.textContent = '';
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'settings-hint';
        empty.textContent = 'No Secure Send links yet.';
        list.appendChild(empty);
        return;
      }
      for (const item of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'secure-send-sent-item';
        const local = NotesStore.getSecureSendSentRecord
          ? NotesStore.getSecureSendSentRecord(item.id)
          : null;
        const snapTitle = local?.snapshot?.title ? String(local.snapshot.title).trim() : '';
        if (snapTitle) {
          const title = document.createElement('div');
          title.className = 'secure-send-sent-title';
          title.textContent = snapTitle;
          row.appendChild(title);
        }
        const meta = document.createElement('div');
        meta.className = 'secure-send-sent-meta';
        const label = secureSendStatusLabel(item);
        const created = item.created_at ? new Date(item.created_at * 1000).toLocaleString() : '';
        const exp = item.expires_at ? new Date(item.expires_at * 1000).toLocaleString() : '';
        meta.textContent = `${label} · created ${created} · expires ${exp}`;
        row.appendChild(meta);
        row.addEventListener('click', () => {
          openSecureSendSentDetail(item);
        });
        list.appendChild(row);
      }
    } catch (err) {
      list.textContent = '';
      const p = document.createElement('p');
      p.className = 'settings-hint';
      p.textContent = 'Could not load sent links.';
      list.appendChild(p);
    }
  }

  function closeSecureSendPanel(force = false) {
    if (!force && Date.now() - (window.__notesSecureSendOpenedAt || 0) < 500) return;
    const panel = document.getElementById('secure-send-panel');
    const backdrop = document.getElementById('secure-send-backdrop');
    if (panel) panel.hidden = true;
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove('secure-send-open');
  }

  function openSecureSendPanel() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    closeSettings(true);
    closeNoteOptions();
    closeEditorToolbarMenu();
    closeNoteRowMenu();
    const panel = document.getElementById('secure-send-panel');
    const backdrop = document.getElementById('secure-send-backdrop');
    if (panel) {
      panel.hidden = false;
      panel.removeAttribute('hidden');
    }
    if (backdrop) {
      backdrop.hidden = false;
      backdrop.removeAttribute('hidden');
    }
    document.body.classList.add('secure-send-open');
    window.__notesSecureSendOpenedAt = Date.now();
    syncSecureSendShareButtons();
    try { refreshSecureSendList(); } catch (err) { /* ignore */ }
  }

  function openSettings() {
    closeSecureSendPanel(true);
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
    // Always paint saved prefs into the selects — HTML defaults are Never/Never
    // and must not be what the user sees when deeperguard-prefs has real values.
    initSettings().catch(() => {});
    refreshSettingsDiagnostics().catch(() => {});
    try { refreshDevicePhraseUi(); } catch (err) { /* ignore */ }
    try { refreshGoogleDriveBackupUi(); } catch (err) { /* ignore */ }
    try { refreshDropboxBackupUi(); } catch (err) { /* ignore */ }
    startSignedInDevicesRefresh();
    try {
      if (globalThis.NotesReleaseIntegrity) {
        const last = NotesReleaseIntegrity.getResult();
        NotesReleaseIntegrity.paintAll(last);
        // Retry when prior check hung/timed out/unavailable (clears stuck inflight).
        const force = !last
          || last.status === 'pending'
          || last.status === 'unavailable';
        NotesReleaseIntegrity.ensureChecked({ force }).catch(() => {});
      }
      if (globalThis.NotesVerifyAskAiPin) {
        NotesVerifyAskAiPin.paintSettingsNotice();
      }
    } catch (err) { /* ignore */ }
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
    const notes = vaultActiveNoteCount();
    const trashed = vaultTrashedNoteCount();
    const docs = NotesStore.listAttachments().filter((att) => {
      const parent = NotesStore.get(att.content.note_id);
      return parent && !parent.deleted && !parent.content?.trashed && !parent.content?.archived;
    }).length;
    const tags = NotesStore.listTags().length;
    const notesLabel = trashed > 0
      ? `${notes} note${notes === 1 ? '' : 's'} (${trashed} in trash)`
      : `${notes} note${notes === 1 ? '' : 's'}`;
    const statsText = `${notesLabel} · ${docs} document${docs === 1 ? '' : 's'} · ${tags} tag${tags === 1 ? '' : 's'}`;
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
    const { words: wordCount, minutes } = displayedReading(note);
    const attCount = NotesStore.listAttachments(note.uuid).length;
    const tagNames = (note.content.tags || [])
      .map((id) => tagMap().get(id))
      .filter(Boolean)
      .map((t) => t.content.title)
      .join(', ');
    created.textContent = formatDateTime(note.content.created_at);
    updated.textContent = formatDateTime(noteEditedAtMs(note));
    words.textContent = wordCount
      ? (minutes ? `${wordCount} · ${minutes} min read` : `${wordCount} ${wordCount === 1 ? 'word' : 'words'}`)
      : '0 words';
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
    closeEditorToolbarMenu();
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
    NotesStore.upsert(currentId, { ...note.content }, { touchUpdatedAt: false });
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

  function fileTitleWithExt(name) {
    const base = String(name || '').split(/[/\\]/).pop().trim();
    return base || 'Document';
  }

  function noteHasUsableTitle(note) {
    if (!note?.content) return false;
    const stored = String(note.content.title || '').trim();
    if (stored && !NotesSearch.isPlaceholderTitle?.(stored)) return true;
    const effective = String(NotesSearch.effectiveNoteTitle?.(note) || '').trim();
    if (effective && !NotesSearch.isPlaceholderTitle?.(effective)) return true;
    if (currentId === note.uuid) {
      const typed = String(ui.title?.value || '').trim();
      if (typed && !NotesSearch.isPlaceholderTitle?.(typed)) return true;
    }
    return false;
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

  function openHiddenFileInput(input) {
    if (!input || typeof input.click !== 'function') return;
    const x = window.scrollX || window.pageXOffset || 0;
    const y = window.scrollY || window.pageYOffset || 0;
    const restore = () => {
      try { window.scrollTo(x, y); } catch (err) { /* ignore */ }
    };
    try {
      input.click();
    } finally {
      restore();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    }
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
  /** Remembered folder for showOpenFilePicker — must be ready before click (no await before picker). */
  let uploadPickerStartInCache;

  async function loadUploadPickerStartIn() {
    if (typeof NotesIDB?.getMeta !== 'function') return undefined;
    try {
      const dir = await NotesIDB.getMeta(UPLOAD_DIR_META_KEY);
      return dir && typeof dir === 'object' ? dir : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function primeUploadPickerStartIn() {
    const dir = await loadUploadPickerStartIn();
    if (!dir) {
      uploadPickerStartInCache = undefined;
      return;
    }
    try {
      if (typeof dir.queryPermission === 'function') {
        const state = await dir.queryPermission({ mode: 'read' });
        if (state !== 'granted') {
          uploadPickerStartInCache = undefined;
          return;
        }
      }
    } catch (_) {
      uploadPickerStartInCache = undefined;
      return;
    }
    uploadPickerStartInCache = dir;
  }

  async function rememberUploadPickerDirectory(handles) {
    const list = Array.isArray(handles) ? handles : [];
    const fileHandle = list.find((h) => h && typeof h.getParent === 'function');
    if (!fileHandle || typeof NotesIDB?.putMeta !== 'function') return;
    try {
      const dir = await fileHandle.getParent();
      if (dir) {
        uploadPickerStartInCache = dir;
        await NotesIDB.putMeta(UPLOAD_DIR_META_KEY, dir);
      }
    } catch (_) {
      /* picker still works without a remembered folder */
    }
  }

  function openDeviceFilePickerSync({ multiple = false } = {}) {
    const options = {
      multiple,
      types: DEVICE_PICK_TYPES,
      id: UPLOAD_PICKER_ID,
    };
    // A remembered folder without read permission throws before the dialog opens.
    // Drop it and try again in this same click, or the browser will block a later fallback.
    if (uploadPickerStartInCache) {
      try {
        return window.showOpenFilePicker({ ...options, startIn: uploadPickerStartInCache });
      } catch (err) {
        uploadPickerStartInCache = undefined;
        if (err && err.name === 'AbortError') throw err;
      }
    }
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

  async function finishDeviceFilePick(handlesPromise) {
    try {
      const handles = await handlesPromise;
      const list = Array.isArray(handles) ? handles : [handles];
      await rememberUploadPickerDirectory(list);
      const files = await Promise.all(list.map((handle) => handle.getFile()));
      return { files, handles: list };
    } catch (err) {
      if (err && err.name === 'AbortError') return { files: [], handles: [] };
      uploadPickerStartInCache = undefined;
      throw err;
    } finally {
      endNotesPicker();
    }
  }

  async function pickDeviceFiles({ multiple = false } = {}) {
    if (typeof window.showOpenFilePicker !== 'function') return null;
    let handlesPromise;
    try {
      // showOpenFilePicker must run in the same turn as the click — awaiting IndexedDB first
      // drops user activation and breaks uploads (hang / silent failure on desktop).
      beginNotesPicker();
      handlesPromise = openDeviceFilePickerSync({ multiple });
    } catch (err) {
      endNotesPicker();
      if (err && err.name === 'AbortError') return { files: [], handles: [] };
      return null;
    }
    try {
      return await finishDeviceFilePick(handlesPromise);
    } catch (err) {
      return null;
    }
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
      const first = pendingScan?.pages?.[0] || pendingScan?.file || pendingScan?.batchFiles?.[0];
      name.value = first ? fileStem(first.name) : '';
    }
    if (wasHidden && !('ontouchstart' in globalThis)) {
      name.focus();
      name.select();
    }
    syncScanSaveMode();
  }

  function scanSaveAsFolder() {
    return document.querySelector('input[name="scan-save-as"]:checked')?.value === 'folder';
  }

  function syncScanSaveMode() {
    const box = document.getElementById('scan-save-as');
    const label = document.getElementById('scan-name-label');
    const name = document.getElementById('scan-name');
    const show = !!pendingScan?.createIfNeeded;
    if (box) box.hidden = !show;
    const asFolder = show && scanSaveAsFolder();
    if (label) label.textContent = asFolder ? 'Folder name' : 'Document name';
    if (name) {
      name.placeholder = asFolder ? 'e.g. Receipts, Trip photos' : 'e.g. Passport, June invoice';
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
      syncScanSaveMode();
      return;
    }
    const batch = pendingScan?.batchFiles || [];
    if (batch.length) {
      host.hidden = true;
      if (empty) empty.hidden = true;
      if (label) {
        label.hidden = false;
        label.textContent = `${batch.length} file${batch.length === 1 ? '' : 's'} selected`;
      }
      if (add) add.hidden = true;
      applyScanKeyboardInset();
      syncScanSaveMode();
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
    if (pending.batchFiles?.length) {
      const asFolder = !!pending.createIfNeeded && scanSaveAsFolder();
      const batch = pending.batchFiles.slice();
      hideScanDialog();
      if (asFolder) await ingestFilesAsFolder(batch, name);
      else await ingestDocumentBatch(batch, { createIfNeeded: true, title: name });
      return;
    }
    if (!file) {
      toast('Take a photo or choose a file first', true);
      return;
    }
    const asFolder = !!pending.createIfNeeded && scanSaveAsFolder();
    hideScanDialog();
    const sourceRemoval = sourceRemovalFromPending(pending);
    if (asFolder) {
      await ingestFilesAsFolder([file], name);
      return;
    }
    await ingestDocument(file, {
      createIfNeeded: pending.createIfNeeded,
      title: name,
      displayName: namedDocument(name, file.name),
      sourceRemoval,
    });
  }

  async function ingestDocument(file, { createIfNeeded = false, title, displayName, quiet = false, noteId = '', preserveEditor = false, allowDuplicate = false } = {}) {
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
    const originalName = localFile.name;
    const originalSize = localFile.size;
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
    if (!allowDuplicate) {
      const duplicate = await NotesStore.findDuplicateAttachment({
        contentSha256,
        sourceSha256,
      });
        if (duplicate) {
        const targetNoteId = (!createIfNeeded && currentId) ? currentId : null;
        const choice = await showDuplicateDialog(duplicate, storeFile, targetNoteId);
        if (choice !== 'keep') {
          if (choice !== 'open') abandonEmptyUploadDraft(targetNoteId);
          return;
        }
        allowDuplicate = true;
      }
    }
    let created = false;
    let id = noteId || currentId;
    if (!id || (createIfNeeded && !noteId)) {
      if (ui.search && ui.search.value) {
        ui.search.value = '';
        ui.search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (currentFilter !== 'all' && currentFilter !== 'documents' && currentFilter !== 'untagged') {
        setFilter('all');
      }
      id = createNote({ silent: true, title: docName });
      if (!id) return;
      created = true;
    } else {
      const note = NotesStore.get(id);
      // Keep an existing title (including body-derived ones). Only auto-title
      // a truly untitled note, and prefer the filename with its extension.
      if (note && !noteHasUsableTitle(note)) {
        const autoTitle = fileTitleWithExt(originalName || displayName || docName);
        if (currentId === id && ui.title) {
          ui.title.value = autoTitle;
          note.content.title_manual = true;
          flushSave();
        } else {
          NotesStore.upsert(id, { ...note.content, title: autoTitle, title_manual: true });
        }
      }
    }
    toast('Saving document…');
    ingestBusy = true;
    let attId;
    try {
      const uploadMeta = { content: { mime: storeFile.type, filename: storeFile.name } };
      const indexable = attachmentIsIndexable(uploadMeta);
      attId = await NotesStore.addAttachment(id, storeFile, {
        displayName: displayName || namedDocument(docName, originalName),
        originalFilename: originalName,
        originalSize,
        sourceSha256,
        ocrPending: indexable,
        intentionalCopy: !!allowDuplicate,
      });
      if (indexable) {
        // Queue before the preview paints so a phone does not decode the PDF twice.
        enqueueOcrJob({ attId, noteId: id, file: storeFile, suggestTags: true });
      } else if (attId) {
        NotesStore.setAttachmentOcr(attId, '', 'unsupported', []);
      }
      const uploadedKind = (typeof NotesPreview !== 'undefined' && NotesPreview.kindFromMeta)
        ? NotesPreview.kindFromMeta(storeFile.type, storeFile.name)
        : '';
      if (preserveEditor) editorMode = 'edit';
      else if (uploadedKind === 'pdf' || uploadedKind === 'image') editorMode = 'preview';
      else editorMode = 'edit';
      if (currentId === id) {
        renderAttachments(id);
        applyEditorMode();
        updateNoteMeta(NotesStore.get(id));
      }
      renderNotes();
    } catch (err) {
      let duplicateChoice = '';
      if (isDuplicateUploadError(err.message) && !allowDuplicate) {
        duplicateChoice = await showDuplicateDialog(null, storeFile, id, err.message);
        if (duplicateChoice === 'keep') {
          const retry = await ingestDocument(storeFile, {
            createIfNeeded: false,
            title: docName,
            displayName,
            quiet,
            noteId: id,
            preserveEditor,
            allowDuplicate: true,
          });
          if (retry) return true;
        }
      } else if (!isDuplicateUploadError(err.message)) {
        toast(err.message || 'Upload failed', true);
      }
      if (created && id && !NotesStore.listAttachments(id).length) {
        NotesStore.remove(id);
        if (currentId === id) closeEditor();
        else renderNotes();
      } else if (duplicateChoice && duplicateChoice !== 'keep' && duplicateChoice !== 'open') {
        abandonEmptyUploadDraft(id);
      }
      return;
    } finally {
      ingestBusy = false;
    }
    if (!quiet) toast('Document saved — reading text in the background');
    return true;
  }

  async function ingestDocumentBatch(files, { createIfNeeded = false, title = '', preserveEditor = false } = {}) {
    const list = [];
    for (const file of toFileArray(files)) {
      const copy = await snapshotPickedFile(file);
      if (copy) list.push(copy);
    }
    if (!list.length) return 0;
    const typedName = String(title || document.getElementById('scan-name')?.value || '').trim();
    hideScanDialog();
    let noteId = (!createIfNeeded && currentId) ? currentId : '';
    if (!noteId) {
      const title = typedName || fileStem(list[0].name);
      noteId = createNote({ silent: true, title });
      if (!noteId) return 0;
    }
    const noteTitle = String(NotesStore.get(noteId)?.content?.title || '').trim() || fileStem(list[0].name);
    let saved = 0;
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      if (list.length > 1) toast(`Saving ${i + 1} of ${list.length}…`);
      const ok = await ingestDocument(file, {
        noteId,
        createIfNeeded: false,
        title: noteTitle,
        displayName: file.name,
        quiet: list.length > 1,
        preserveEditor,
      });
      if (ok) saved += 1;
    }
    if (noteId && !NotesStore.listAttachments(noteId).length && createIfNeeded) {
      NotesStore.remove(noteId);
      if (currentId === noteId) closeEditor();
      else renderNotes();
    } else if (noteId && !NotesStore.listAttachments(noteId).length) {
      abandonEmptyUploadDraft(noteId);
    }
    if (list.length > 1) {
      toast(saved ? `Saved ${saved} file${saved === 1 ? '' : 's'} on one note` : 'No documents saved', !saved);
    }
    return saved;
  }

  async function ingestFilesAsFolder(files, title) {
    const list = [];
    for (const file of toFileArray(files)) {
      const copy = await snapshotPickedFile(file);
      if (copy) list.push(copy);
    }
    if (!list.length) return 0;
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return 0;
    }
    const name = String(title || '').trim() || fileStem(list[0].name) || 'Folder';
    hideScanDialog();
    const folderId = NotesStore.createFolder(name);
    if (!folderId) return 0;
    setFolderOpen(folderId, true);
    prefs.foldersCollapsed = false;
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (err) { /* ignore */ }
    applyFolderSection();
    let saved = 0;
    let firstNote = '';
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      if (list.length > 1) toast(`Saving ${i + 1} of ${list.length}…`);
      const noteTitle = fileStem(file.name) || name;
      const noteId = createNote({ silent: true, title: noteTitle, folderId, open: false });
      if (!noteId) continue;
      if (!firstNote) firstNote = noteId;
      const ok = await ingestDocument(file, {
        noteId,
        createIfNeeded: false,
        title: noteTitle,
        displayName: file.name,
        quiet: true,
      });
      if (ok) saved += 1;
      else if (!NotesStore.listAttachments(noteId).length) NotesStore.remove(noteId);
    }
    if (!saved) {
      NotesStore.deleteFolder(folderId);
      renderFolders();
      renderNotes();
      toast('No documents saved', true);
      return 0;
    }
    currentFolder = folderId;
    currentTag = null;
    renderTags();
    renderNotes();
    if (firstNote) openNote(firstNote);
    toast(`Saved ${saved} file${saved === 1 ? '' : 's'} in ${name}`);
    return saved;
  }

  function attachmentFileMeta(item) {
    const mime = String(item?.content?.mime || item?.type || '').toLowerCase();
    const name = String(item?.content?.filename || item?.name || '').toLowerCase();
    return { mime, name };
  }

  function attachmentIsArchive(item) {
    const { mime, name } = attachmentFileMeta(item);
    return /\.zip$/.test(name) || mime === 'application/zip' || mime === 'application/x-zip-compressed';
  }

  function attachmentIsIndexable(item) {
    if (attachmentIsArchive(item)) return false;
    return canOcrAttachment(item);
  }

  function canOcrAttachment(item) {
    const { mime, name } = attachmentFileMeta(item);
    return mime.startsWith('text/')
      || mime.startsWith('image/')
      || mime === 'application/pdf'
      || mime === 'application/json'
      || mime === 'application/xml'
      || mime === 'application/yaml'
      || mime === 'application/x-yaml'
      || mime.endsWith('+json')
      || mime.endsWith('+xml')
      || mime.includes('wordprocessingml')
      || /\.(txt|md|csv|json|log|xml|yaml|yml|docx|pdf|png|jpe?g|webp|gif|bmp|hei[cf])$/i.test(name);
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
    if (!atts.length) {
      el.textContent = prefs.lightVault
        ? 'Files download when you open their note.'
        : 'No files yet.';
    } else if (local >= atts.length) {
      el.textContent = `${atts.length} file${atts.length === 1 ? '' : 's'} stored on this device. All files are kept on this device.`;
    } else if (prefs.lightVault) {
      el.textContent = `${local} of ${atts.length} file${atts.length === 1 ? '' : 's'} stored on this device. Remaining files download when you open their note.`;
    } else {
      el.textContent = `${local} of ${atts.length} file${atts.length === 1 ? '' : 's'} stored on this device. Missing files download when you open their note.`;
    }
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

  function attachmentNeedsOcrRetry(att) {
    if (!att || !canOcrAttachment(att)) return false;
    if (NotesStore.searchIndexCovers?.(att.uuid)) return false;
    if (NotesStore.applySearchIndexEntry?.(att.uuid) && attachmentOcrSettled(NotesStore.get(att.uuid))) return false;
    if (attachmentOcrSettled(att)) return false;
    const method = att.content?.ocr_method || '';
    if (method !== 'pending') return false;
    const owner = att.content.ocr_owner || '';
    return !!owner && owner === NotesStore.deviceId();
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

  async function queueLocalOcrForAttachments(atts, { force = true, reindex = false } = {}) {
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
          reindex: !!reindex,
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
    const needsServer = atts.filter((att) => attachmentNeedsOcrRetry(att));
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
    if (NotesStore.applySearchIndexEntry?.(attId) || NotesStore.searchIndexCovers?.(attId)) {
      serverOcrKnown.add(attId);
      return true;
    }
    const item = NotesStore.get(attId);
    const owner = item?.content?.ocr_owner || '';
    const method = item?.content?.ocr_method || '';
    const ownedPending = method === 'pending' && owner && owner === NotesStore.deviceId();
    if (!ownedPending || attachmentOcrSettled(item)) {
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
    const queued = await queueLocalOcrForAttachments(atts, { force: true, reindex: true });
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
      const refresh = !!existing?.content?.ocr_method && existing.content.ocr_method !== 'pending';
      if (existing && !job.reindex && (attachmentOcrSettled(existing) || NotesStore.searchIndexCovers?.(existing.uuid))) {
        NotesStore.applySearchIndexEntry?.(existing.uuid);
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

  function createNote({ silent = false, title, folderId = '', open = true } = {}) {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    try {
      flushSave();
      const id = NotesStore.newUuid();
      const payload = NotesStore.defaultNote();
      if (title) payload.title = title;
      if (folderId) payload.folder_id = folderId;
      if (currentTag) payload.tags = [currentTag];
      // Empty New-note drafts stay local until the user enters content so a
      // 3s wait + switch cannot leave a synced Untitled shell behind.
      const seeded = !!(
        String(payload.title || '').trim()
        || payload.folder_id
        || (payload.tags && payload.tags.length)
      );
      NotesStore.upsert(id, payload, { skipDirty: !seeded });
      renderNotes();
      renderTags();
      if (open) openNote(id);
      if (!silent && open) {
        ui.title.focus();
        ui.title.select();
        toast('New note');
      }
      return id;
    } catch (err) {
      toast(err.message || String(err), true);
    }
  }

  function createTag(title, { assignToCurrent = false, navigate = true } = {}) {
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
      } else if (!assignToCurrent && navigate) {
        setFilter('all');
        currentTag = id;
        closeEditorIfNoteLeftView();
      }
      hideTagComposer();
      renderTags();
      renderNotes();
      if (currentId) renderTagBar(NotesStore.get(currentId));
      if (existing) toast('Tag already exists');
      else toast('Tag created');
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
    else {
      syncFindHighlights('');
      syncChecklistFindHighlights('');
      syncChecklistSearchHighlights();
    }
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
    // The editor's find/replace matches the typed text exactly; only the
    // search box uses word and phrase rules.
    return { caseSensitive: !!findCaseSensitive, literal: true };
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
      markAutoDir(ui.preview);
    } else {
      ui.preview.innerHTML = renderNoteBodyPreview(ui.body.value, editor);
    markAutoDir(ui.preview);
      bindPreviewTaskToggles();
      if (needle) NotesSearch.applyHighlights(ui.preview, needle, findMatchOptions());
      else highlightPreview();
    }
    return [...ui.preview.querySelectorAll('mark.search-hit')];
  }

  function scrollChecklistFindMatch(match) {
    if (!match || !ui.checklist || ui.checklist.hidden) return;
    const full = ui.body?.value || '';
    const line = (full.slice(0, match.start).match(/\n/g) || []).length;
    const inputs = ui.checklist.querySelectorAll('.check-text');
    const target = inputs[line];
    if (!target) return;
    const lines = full.split('\n');
    let lineStart = 0;
    for (let i = 0; i < line; i += 1) lineStart += lines[i].length + 1;
    const prefix = lines[line]?.match(/^(\s*[-*] \[[ xX]\] )/)?.[1]?.length || 0;
    const start = Math.max(0, match.start - lineStart - prefix);
    const end = Math.max(start, match.end - lineStart - prefix);
    target.focus();
    target.setSelectionRange(start, end);
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    syncChecklistFindHighlights(currentFindQuery());
  }

  function scrollEditFindMatch(match) {
    if (!match || !ui.body) return;
    const type = currentId ? (NotesStore.get(currentId)?.content?.editor || ui.editorType.value || 'plain') : 'plain';
    if (isChecklistEditor(type) && ui.checklist && !ui.checklist.hidden) {
      scrollChecklistFindMatch(match);
      return;
    }
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
      syncChecklistFindHighlights('');
      return;
    }
    syncChecklistFindHighlights(query);
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
    ui.checklist?.querySelectorAll('.check-find-highlights').forEach((rowLayer) => {
      const input = rowLayer.parentElement?.querySelector('.check-text');
      if (input) rowLayer.scrollTop = input.scrollTop;
    });
  }

  function buildFindHighlightHtml(text, query, currentIndex) {
    const matches = NotesSearch.findMatches(text, query, findMatchOptions());
    if (!matches.length) return NotesSanitize.escapeHtml(text);
    let html = '';
    let last = 0;
    matches.forEach((match, index) => {
      html += NotesSanitize.escapeHtml(text.slice(last, match.start));
      const cls = currentIndex >= 0 && index === currentIndex ? 'search-hit search-hit-current' : 'search-hit';
      html += `<mark class="${cls}">${NotesSanitize.escapeHtml(text.slice(match.start, match.end))}</mark>`;
      last = match.end;
    });
    html += NotesSanitize.escapeHtml(text.slice(last));
    return html;
  }

  function syncChecklistFindHighlights(query) {
    if (!ui.checklist || ui.checklist.hidden) return;
    const barOpen = findBarOpen();
    const needle = String(query || '').trim();
    const show = barOpen && needle;
    ui.checklist.classList.toggle('find-active', !!show);
    if (!show) {
      ui.checklist.querySelectorAll('.check-find-highlights').forEach((el) => el.remove());
      return;
    }
    let matchOffset = 0;
    const globalIndex = findIndex;
    ui.checklist.querySelectorAll('.check-row').forEach((row) => {
      const input = row.querySelector('.check-text');
      const wrap = row.querySelector('.check-text-wrap');
      if (!input || !wrap) return;
      let layer = wrap.querySelector('.check-find-highlights');
      if (!layer) {
        layer = document.createElement('pre');
        layer.className = 'check-find-highlights';
        layer.setAttribute('aria-hidden', 'true');
        wrap.insertBefore(layer, wrap.firstChild);
      }
      const text = input.value || '';
      const matches = NotesSearch.findMatches(text, needle, findMatchOptions());
      let localCurrent = -1;
      if (matches.length && globalIndex >= matchOffset && globalIndex < matchOffset + matches.length) {
        localCurrent = globalIndex - matchOffset;
      }
      layer.innerHTML = buildFindHighlightHtml(text, needle, localCurrent);
      matchOffset += matches.length;
      layer.scrollTop = input.scrollTop;
    });
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

  function indentSelection(dir) {
    pushUndoSnapshot();
    const ta = ui.body;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const lineStart = ta.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const blockEnd = end;
    const block = ta.value.slice(lineStart, blockEnd);
    const next = block.split('\n').map((line) => {
      if (dir > 0) return `  ${line}`;
      return line.replace(/^( {1,2}|\t)/, '');
    }).join('\n');
    ta.value = `${ta.value.slice(0, lineStart)}${next}${ta.value.slice(blockEnd)}`;
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
    closeEditorToolbarMenu();
    flushSave();
    if (closingId) discardEmptyDraftNote(closingId);
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
    listSelectionId = null;
    deferredOpenNoteId = null;
    rememberOpen(null);
    ui.editor.hidden = true;
    updateEmptyStateVisibility();
    closeDocPreview();
    markActiveNoteRow();
    renderNotes();
    renderFolders();
    requestAnimationFrame(() => markActiveNoteRow());
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

  let trackedDevicePixelRatio = window.devicePixelRatio || 1;
  let zoomPopstateGuardUntil = 0;
  let popstateClosedAt = 0;
  function noteBrowserZoom() {
    const dpr = window.devicePixelRatio || 1;
    if (Math.abs(dpr - trackedDevicePixelRatio) > 0.001) {
      zoomPopstateGuardUntil = Date.now() + 800;
      trackedDevicePixelRatio = dpr;
      return true;
    }
    return Date.now() < zoomPopstateGuardUntil;
  }
  function restoreEditorAfterZoom(noteId) {
    const keepId = noteId || currentId || listSelectionId;
    if (!keepId || !NotesStore.get(keepId)) return;
    const needsOpen = currentId !== keepId || ui.editor?.hidden;
    if (needsOpen) openNote(keepId, { skipFlush: true });
    else if (history.state?.notesView !== 'editor' || history.state?.noteId !== keepId) {
      try {
        history.pushState({ notesView: 'editor', noteId: keepId }, '', location.href);
      } catch (err) {
        /* ignore */
      }
    }
  }
  window.addEventListener('popstate', () => {
    const editorWasOpen = !!(currentId || (ui.editor && !ui.editor.hidden));
    const idAtPop = currentId || listSelectionId;
    if (!editorWasOpen) return;
    if (Date.now() < zoomPopstateGuardUntil) {
      restoreEditorAfterZoom(idAtPop);
      return;
    }
    requestAnimationFrame(() => {
      if (noteBrowserZoom() || Date.now() < zoomPopstateGuardUntil) {
        restoreEditorAfterZoom(idAtPop);
        return;
      }
      if (currentId || (ui.editor && !ui.editor.hidden)) {
        popstateClosedAt = Date.now();
        closeEditor({ fromPopstate: true });
      }
    });
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
    openHiddenFileInput(document.getElementById('scan-camera'));
  });

  async function ingestPickedScanFiles(fileList, { createIfNeeded = true, sourceRemoval = null } = {}) {
    const files = toFileArray(fileList);
    if (!files.length) {
      if (pendingScan && !document.getElementById('scan-dialog')?.hidden) {
        setScanFeedback('No file was selected', { isError: true });
      }
      return;
    }
    if (files.length > 1 && (pendingScan?.createIfNeeded ?? createIfNeeded)) {
      const copies = [];
      for (const file of files) {
        const copy = await snapshotPickedFile(file);
        if (copy) copies.push(copy);
      }
      if (!copies.length) {
        setScanFeedback('No file was selected', { isError: true });
        return;
      }
      pendingScan = {
        file: null,
        pages: [],
        batchFiles: copies,
        createIfNeeded: true,
        sourceRemoval: mergeUploadSource(pendingScan?.sourceRemoval || sourceRemoval || emptyUploadSource(), {
          label: sourceLabelFromFiles(copies),
        }),
      };
      const name = document.getElementById('scan-name');
      if (name && !name.value) name.value = fileStem(copies[0].name);
      showScanDialog();
      return;
    }
    if (files.length > 1) {
      await ingestDocumentBatch(files, { createIfNeeded: pendingScan?.createIfNeeded ?? createIfNeeded });
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
    let handlesPromise;
    try {
      beginNotesPicker();
      handlesPromise = openDeviceFilePickerSync({ multiple: true });
    } catch (err) {
      endNotesPicker();
      if (err && err.name === 'AbortError') return;
      openHiddenFileInput(document.getElementById('scan-input'));
      return;
    }
    void (async () => {
      try {
        const picked = await finishDeviceFilePick(handlesPromise);
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
    if (event.target?.closest?.('[data-doc-hit-dismiss]')) return;
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
  document.getElementById('doc-enhance-toggle')?.addEventListener('click', () => {
    const panel = document.getElementById('doc-enhance-panel');
    const toggle = document.getElementById('doc-enhance-toggle');
    if (!panel || !toggle) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
  });
  document.getElementById('doc-contrast')?.addEventListener('input', (event) => {
    const percent = Number(event.target.value) || 100;
    setDocEnhance({ contrast: percent / 100 });
  });
  document.getElementById('doc-sharpen')?.addEventListener('click', () => {
    setDocEnhance({ sharpen: !docViewEnhance.sharpen });
  });
  document.getElementById('doc-white-borders')?.addEventListener('click', () => {
    setDocEnhance({ whiteBorders: !docViewEnhance.whiteBorders });
  });
  document.getElementById('doc-enhance-auto')?.addEventListener('click', () => {
    setDocEnhance({ contrast: 1.4, sharpen: true, whiteBorders: true });
  });
  document.getElementById('doc-enhance-reset')?.addEventListener('click', () => {
    setDocEnhance({ contrast: 1, sharpen: false, whiteBorders: false });
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
  document.querySelectorAll('input[name="scan-save-as"]').forEach((input) => {
    input.addEventListener('change', () => syncScanSaveMode());
  });
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
  document.getElementById('btn-manage-tags')?.addEventListener('click', () => {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    openTagManage();
  });
  function createTagFromManage() {
    const input = document.getElementById('tag-manage-name');
    const name = String(input?.value || '').trim();
    if (!name) {
      input?.focus();
      return;
    }
    createTag(name, { navigate: false });
    if (input) input.value = '';
    renderTagManageList();
    input?.focus();
  }
  document.getElementById('tag-manage-add')?.addEventListener('click', createTagFromManage);
  document.getElementById('tag-manage-name')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createTagFromManage();
    }
  });
  document.getElementById('tag-manage-create')?.addEventListener('submit', (event) => {
    event.preventDefault();
    createTagFromManage();
  });
  document.getElementById('tag-manage-close')?.addEventListener('click', closeTagManage);
  document.getElementById('tag-manage-backdrop')?.addEventListener('click', closeTagManage);
  document.getElementById('tag-manage-dialog')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeTagManage();
    }
  });
  document.getElementById('btn-new-tag').addEventListener('click', () => {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const section = document.getElementById('tag-section');
    if (section) section.open = true;
    const composer = document.getElementById('tag-composer');
    composer.hidden = false;
    const input = document.getElementById('tag-name-input');
    if (input && !input.dataset.limitBound) {
      input.dataset.limitBound = '1';
      input.addEventListener('input', () => syncTagLimitHint(input));
    }
    syncTagLimitHint(input);
    input.focus();
  });
  const tagSection = document.getElementById('tag-section');
  const folderSection = document.getElementById('folder-section');
  if (tagSection) {
    tagSection.addEventListener('toggle', () => {
      if (!isDesktopLayout()) {
        // Phone overlays are ephemeral — never write desktop collapse prefs.
        if (tagSection.open) {
          phoneBrowseOpen = 'tags';
          if (folderSection?.open) folderSection.open = false;
        } else if (phoneBrowseOpen === 'tags') {
          phoneBrowseOpen = null;
        }
        return;
      }
      prefs.tagsCollapsed = !tagSection.open;
      localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs));
    });
  }
  if (folderSection) {
    folderSection.addEventListener('toggle', () => {
      if (!isDesktopLayout()) {
        if (folderSection.open) {
          phoneBrowseOpen = 'folders';
          if (tagSection?.open) tagSection.open = false;
        } else if (phoneBrowseOpen === 'folders') {
          phoneBrowseOpen = null;
        }
        return;
      }
      prefs.foldersCollapsed = !folderSection.open;
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
    const zoomed = noteBrowserZoom();
    const compact = compactLayoutActive();
    if (compact !== lastCompactLayout) {
      // Layout switch: phone overlays always start closed; desktop prefs untouched.
      phoneBrowseOpen = null;
      lastCompactLayout = compact;
    }
    applyTagSection();
    applyFolderSection();
    applyFilterSection();
    syncSortControls();
    if (
      zoomed
      && popstateClosedAt
      && Date.now() - popstateClosedAt < 800
      && !currentId
      && listSelectionId
      && NotesStore.get(listSelectionId)
    ) {
      popstateClosedAt = 0;
      openNote(listSelectionId, { skipFlush: true });
    }
    if (currentId) syncTagBarShell(NotesStore.get(currentId));
    layoutFindBarOverDocViewer();
  });
  // Swallow the click that follows an outside-tap close so a note row under
  // the finger does not open on the same gesture.
  let swallowNoteOpenUntil = 0;
  function swallowOverlayOutsideTap(event) {
    swallowNoteOpenUntil = Date.now() + 450;
    try {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    } catch (err) { /* ignore */ }
  }
  function shouldSwallowNoteOpen() {
    return Date.now() < swallowNoteOpenUntil;
  }
  // Phone Tags/Folders overlay: tap/click outside closes and returns focus to the chip.
  document.addEventListener('pointerdown', (event) => {
    if (!compactLayoutActive() || document.body.classList.contains('nav-drawer-open')) return;
    const which = phoneBrowseOpen
      || (tagSection?.open ? 'tags' : null)
      || (folderSection?.open ? 'folders' : null);
    if (!which) return;
    const section = which === 'tags' ? tagSection : folderSection;
    if (!section?.open) return;
    const target = event.target;
    if (section.contains(target)) return;
    if (target?.closest?.('#toast, #tag-manage-dialog, #tag-manage-backdrop, #confirm-dialog, #confirm-backdrop, #folder-prompt, #account-info-dialog, .scan-dialog, #totp-add-dialog')) {
      return;
    }
    closePhoneBrowseOverlay({ focusChip: true });
    // Outside tap only dismisses — do not open the note under the finger.
    swallowOverlayOutsideTap(event);
  }, true);
  document.addEventListener('click', (event) => {
    if (!shouldSwallowNoteOpen()) return;
    if (!event.target?.closest?.('.note-row, .note-item, [data-folder-note]')) return;
    try {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    } catch (err) { /* ignore */ }
  }, true);
  function hideFolderComposer() {
    const composer = document.getElementById('folder-composer');
    const input = document.getElementById('folder-name-input');
    if (composer) composer.hidden = true;
    if (input) input.value = '';
  }

  function createFolderFromComposer() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const input = document.getElementById('folder-name-input');
    const name = String(input?.value || '').trim();
    if (!name) {
      toast('Enter a folder name', true);
      input?.focus();
      return;
    }
    const folderId = NotesStore.createFolder(name);
    hideFolderComposer();
    if (!folderId) return;
    const assignTo = folderCreateForNote;
    folderCreateForNote = '';
    setFolderOpen(folderId, true);
    currentFolder = folderId;
    prefs.foldersCollapsed = false;
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (err) { /* ignore */ }
    applyFolderSection();
    renderFolders();
    renderNotes();
    if (assignTo && currentId === assignTo) assignCurrentNoteFolder(folderId);
    if (currentId) syncNoteFolderControl(NotesStore.get(currentId));
    toast('Folder created');
  }

  function closeFolderPrompt() {
    const dialog = document.getElementById('folder-prompt');
    const input = document.getElementById('folder-prompt-input');
    if (dialog) dialog.hidden = true;
    if (input) input.value = '';
  }

  function openFolderPrompt() {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    folderCreateForNote = currentId || '';
    const dialog = document.getElementById('folder-prompt');
    const input = document.getElementById('folder-prompt-input');
    if (!dialog || !input) {
      document.getElementById('btn-new-folder')?.click();
      return;
    }
    dialog.hidden = false;
    dialog.removeAttribute('aria-hidden');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'folder-prompt-title');
    input.value = '';
    input.focus();
  }

  function confirmFolderPrompt() {
    const input = document.getElementById('folder-prompt-input');
    const name = String(input?.value || '').trim();
    if (!name) {
      toast('Enter a folder name', true);
      input?.focus();
      return;
    }
    const folderId = NotesStore.createFolder(name);
    const assignTo = folderCreateForNote;
    folderCreateForNote = '';
    closeFolderPrompt();
    if (!folderId) return;
    setFolderOpen(folderId, true);
    currentFolder = folderId;
    prefs.foldersCollapsed = false;
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (err) { /* ignore */ }
    applyFolderSection();
    renderFolders();
    renderNotes();
    if (assignTo && currentId === assignTo) assignCurrentNoteFolder(folderId);
    if (currentId) syncNoteFolderControl(NotesStore.get(currentId));
    toast('Folder created');
  }

  document.getElementById('note-folder-select')?.addEventListener('change', (event) => {
    const select = event.currentTarget;
    if (select.value === '__new__') {
      select.value = NotesStore.get(currentId)?.content?.folder_id || '';
      openFolderPrompt();
      return;
    }
    assignCurrentNoteFolder(select.value);
  });
  document.getElementById('folder-prompt-ok')?.addEventListener('click', confirmFolderPrompt);
  document.getElementById('folder-prompt-cancel')?.addEventListener('click', closeFolderPrompt);
  document.getElementById('folder-prompt-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmFolderPrompt();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFolderPrompt();
    }
  });
  document.getElementById('btn-new-folder')?.addEventListener('click', () => {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const section = document.getElementById('folder-section');
    if (section) section.open = true;
    const composer = document.getElementById('folder-composer');
    if (composer) composer.hidden = false;
    document.getElementById('folder-name-input')?.focus();
  });
  document.getElementById('folder-create-confirm')?.addEventListener('click', createFolderFromComposer);
  document.getElementById('folder-create-cancel')?.addEventListener('click', hideFolderComposer);
  document.getElementById('folder-name-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createFolderFromComposer();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      hideFolderComposer();
    }
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

  let navDrawerScrollY = 0;

  function reserveDrawerFlow(panel) {
    let spacer = document.getElementById('nav-drawer-spacer');
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.id = 'nav-drawer-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.order = '8';
      spacer.style.flex = '0 0 auto';
      spacer.style.width = '100%';
      panel.insertAdjacentElement('afterend', spacer);
    }
    const kids = [...panel.children].filter((el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!kids.length) {
      spacer.style.height = '0px';
      return;
    }
    const top = kids[0].getBoundingClientRect().top;
    const bottom = kids[kids.length - 1].getBoundingClientRect().bottom;
    spacer.style.height = `${Math.max(0, Math.round(bottom - top))}px`;
  }

  function releaseDrawerFlow() {
    const spacer = document.getElementById('nav-drawer-spacer');
    if (spacer) spacer.style.height = '0px';
  }

  function lockDrawerScroll() {
    navDrawerScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${navDrawerScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
  }

  function unlockDrawerScroll() {
    const y = navDrawerScrollY;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, y);
  }

  function drawerPanelPlacement(menuBox, sideBox, transformed, viewportHeight) {
    const gap = 8;
    const spaceBelow = viewportHeight - menuBox.bottom - gap;
    const spaceAbove = menuBox.top - gap;
    const belowTop = transformed
      ? Math.max(0, Math.round(menuBox.bottom - sideBox.top + gap))
      : Math.max(0, Math.round(menuBox.bottom + gap));
    // A low menu (zoomed desktop) leaves only a sliver under the button.
    // Fill from the top of the shell down to just above it. A menu near
    // the top (phone) still opens underneath so Notes does not cover it.
    if (spaceAbove > 160 && spaceAbove > spaceBelow) {
      const bottom = transformed
        ? Math.max(gap, Math.round(sideBox.bottom - menuBox.top + gap))
        : Math.max(gap, Math.round(viewportHeight - menuBox.top + gap));
      return { top: 0, bottom, paddingTop: 8 };
    }
    return { top: belowTop, bottom: 0, paddingTop: 8 };
  }

  function setNavDrawer(open) {
    const pinned = window.matchMedia('(min-width: 1000px)').matches
      && !document.documentElement.classList.contains('layout-compact');
    const show = !!open && !pinned;
    const wasOpen = document.body.classList.contains('nav-drawer-open');
    const flowPanel = document.getElementById('sidebar-scroll');
    if (show && !wasOpen && flowPanel) reserveDrawerFlow(flowPanel);
    if (show && !wasOpen) lockDrawerScroll();
    document.body.classList.toggle('nav-drawer-open', show);
    if (!show && wasOpen) {
      releaseDrawerFlow();
      unlockDrawerScroll();
    }
    const backdrop = document.getElementById('sidebar-nav-backdrop');
    if (backdrop) {
      backdrop.hidden = !show;
      backdrop.setAttribute('aria-hidden', show ? 'false' : 'true');
    }
    for (const id of ['btn-list-menu', 'btn-nav-menu']) {
      const btn = document.getElementById(id);
      if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    }
    for (const id of ['filter-section', 'tag-section', 'folder-section']) {
      const section = document.getElementById(id);
      if (!section) continue;
      if (show) {
        if (section.dataset.drawerWasOpen == null) {
          section.dataset.drawerWasOpen = section.open ? '1' : '0';
        }
        section.open = true;
      } else if (section.dataset.drawerWasOpen != null) {
        section.open = section.dataset.drawerWasOpen === '1';
        delete section.dataset.drawerWasOpen;
      }
    }
    const panel = document.getElementById('sidebar-scroll');
    if (panel) {
      if (!show) {
        panel.style.top = '';
        panel.style.bottom = '';
        panel.style.paddingTop = '';
        document.body.classList.remove('drawer-over-menu');
      } else {
        const menu = document.getElementById('btn-list-menu');
        const sidebar = document.getElementById('sidebar');
        const menuShown = menu && getComputedStyle(menu).display !== 'none';
        if (menuShown && sidebar) {
          const menuBox = menu.getBoundingClientRect();
          const sideBox = sidebar.getBoundingClientRect();
          const transformed = getComputedStyle(sidebar).transform !== 'none';
          const place = drawerPanelPlacement(menuBox, sideBox, transformed, window.innerHeight || 0);
          panel.style.top = `${place.top}px`;
          panel.style.bottom = `${place.bottom}px`;
          panel.style.paddingTop = '8px';
          document.body.classList.toggle('drawer-over-menu', place.top === 0);
        } else {
          document.body.classList.remove('drawer-over-menu');
        }
      }
    }
  }

  document.getElementById('btn-back').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setNavDrawer(false);
    closeEditor();
  });
  document.getElementById('btn-nav-menu')?.addEventListener('click', (event) => {
    event.stopPropagation();
    closeEditor();
    setNavDrawer(true);
  });
  document.getElementById('btn-drawer-close')?.addEventListener('click', () => setNavDrawer(false));
  document.getElementById('btn-list-menu')?.addEventListener('click', (event) => {
    event.stopPropagation();
    setNavDrawer(!document.body.classList.contains('nav-drawer-open'));
  });
  document.getElementById('sidebar-nav-backdrop')?.addEventListener('click', () => {
    setNavDrawer(false);
  });
  window.matchMedia('(min-width: 1000px)').addEventListener('change', () => {
    if (document.body.classList.contains('nav-drawer-open')) setNavDrawer(true);
  });
  document.addEventListener('click', (event) => {
    if (!document.body.classList.contains('nav-drawer-open')) return;
    const panel = document.getElementById('sidebar-scroll');
    if (panel && (event.target === panel || panel.contains(event.target))) return;
    if (event.target.closest && event.target.closest('#btn-list-menu, #btn-nav-menu')) return;
    setNavDrawer(false);
  });

  function updateSearchClear() {
    const clear = document.getElementById('search-clear');
    if (clear) clear.hidden = !ui.search.value;
  }

  function clearSearch({ blur = true } = {}) {
    ui.search.value = '';
    updateSearchClear();
    renderNotes();
    if (currentId) applyEditorMode();
    if (blur) ui.search.blur();
  }

  function repairSearchIndexesForQuery() {
    if (!ui.search?.value?.trim()) return false;
    if (!countStaleNoteSearchIndexes()) return false;
    refreshAllNoteSearchIndexes();
    return true;
  }

  let searchDebounceTimer = null;
  let searchFilterEpoch = 0;
  async function applySearchFilter() {
    const epoch = ++searchFilterEpoch;
    docHitNoteDismissedFor = '';
    updateSearchClear();
    // Wait for unlock cleanup so the first search does not use a copied scan.
    // Do not rebuild the duplicate plan on each keystroke.
    if (typeof NotesStore.finishUnlockMaintenance === 'function') {
      try {
        await NotesStore.finishUnlockMaintenance();
      } catch (err) {
        console.warn('search waited on unlock cleanup', err);
      }
    }
    if (epoch !== searchFilterEpoch) return;
    try {
      renderNotes();
    } catch (err) {
      console.error('Search failed', err);
      const meta = document.getElementById('search-meta');
      if (meta) {
        meta.hidden = false;
        meta.textContent = 'Search failed — try again or clear filters';
      }
    }
    syncEditorModeForSearch();
    if (currentId) applyEditorMode();
  }
  function queueSearchAsYouType() {
    clearTimeout(searchDebounceTimer);
    updateSearchClear();
    // Results update while typing. Enter still runs the same search immediately.
    searchDebounceTimer = setTimeout(() => {
      try {
        renderNotes();
      } catch (err) {
        console.error('Search failed', err);
      }
      applySearchFilter();
    }, 180);
  }
  ui.search.addEventListener('input', queueSearchAsYouType);
  ui.search.addEventListener('compositionend', queueSearchAsYouType);
  // iOS Safari "Search" on type=search otherwise navigates / reloads the page.
  // Search field is type=text; still block Enter just in case.
  ui.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (String(ui.search.value || '')) {
        clearSearch({ blur: false });
        return;
      }
      ui.search.blur();
      return;
    }
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
      currentFolder = null;
      if (btn.dataset.filter === 'all') currentTag = null;
      setFilter(btn.dataset.filter);
      renderTags();
      renderFolders();
      renderNotes();
      if (document.body.classList.contains('nav-drawer-open')) setNavDrawer(false);
    });
  });
  const filterSelect = document.getElementById('filter-select');
  if (filterSelect) {
    filterSelect.value = currentFilter;
    filterSelect.addEventListener('change', () => {
      if (filterSelect.value === 'folder') return;
      currentFolder = null;
      if (filterSelect.value === 'all') currentTag = null;
      setFilter(filterSelect.value);
      renderTags();
      renderFolders();
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
    if (!applyingDerivedTitle && note?.content) note.content.title_manual = true;
    // Keep the list row in sync while typing (don't leave a stale derived title).
    if (currentId && ui.noteList) {
      const typed = String(ui.title.value || '').trim();
      const display = typed || NotesSearch.derivedTitleFromBody?.(ui.body?.value) || 'Untitled';
      const rowTitle = ui.noteList.querySelector(`.note-row[data-id="${CSS.escape(currentId)}"] h3`);
      if (rowTitle) {
        rowTitle.textContent = display;
        rowTitle.classList.toggle('note-title-placeholder', !typed && display === 'Untitled');
      }
      syncNoteRowActionLabels(currentId, display);
    }
    scheduleSave();
  });
  ui.body.addEventListener('input', () => {
    const note = NotesStore.get(currentId);
    if (note?.content?.prevent_edit) return;
    if (note?.content?.locked && !unlockedNotes.has(currentId)) return;
    if (note && !titleLockedByUser(note)) {
      applyingDerivedTitle = true;
      ui.title.value = NotesSearch.derivedTitleFromBody(ui.body.value);
      ui.title.removeAttribute('title');
      ui.title.setAttribute('aria-label', 'Title');
      applyingDerivedTitle = false;
    }
    scheduleSave();
    autosizeNoteBody();
    syncEditLinkOverlay();
    syncCodeHighlight();
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

  document.getElementById('btn-rescan-ocr')?.addEventListener('click', () => {
    rescanOpenNoteOcr().catch((err) => toast(err.message || 'Rescan failed', true));
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
      else {
        // Dismissing inline PDF auto-preview: stay in edit for this note id
        // for the rest of the page session (including leave/reopen).
        if (currentId && noteSinglePdfAttachment(currentId) && noteBodyIsBlank(NotesStore.get(currentId))) {
          pdfOnlyAutoOpenSuppressedIds.add(currentId);
        }
        editorMode = 'edit';
      }
    } else {
      editorMode = editorMode === 'edit' ? 'preview' : 'edit';
    }
    applyEditorMode();
  });

  const btnFind = document.getElementById('btn-find');
  if (btnFind) btnFind.addEventListener('click', () => showFindBar());
  const btnFindDesktop = document.getElementById('btn-find-desktop');
  if (btnFindDesktop) btnFindDesktop.addEventListener('click', () => showFindBar());

  document.querySelectorAll('.editor-toolbar-overflow-toggle').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleEditorToolbarMenu();
    });
  });
  document.querySelector('.editor-toolbar-menu-panel')?.addEventListener('click', (event) => {
    if (!event.target.closest('.editor-toolbar-menu-item')) return;
    closeEditorToolbarMenu();
  });
  document.getElementById('editor-toolbar-menu-backdrop')?.addEventListener('click', () => closeEditorToolbarMenu());
  document.addEventListener('click', (event) => {
    if (!document.body.classList.contains('editor-toolbar-menu-open')) return;
    if (event.target.closest('.editor-toolbar-overflow-toggle')) return;
    if (event.target.closest('.editor-actions-overflow-panel')) return;
    closeEditorToolbarMenu();
  });

  document.getElementById('btn-md-mode')?.addEventListener('click', () => {
    if (!currentId) return;
    if (noteEditingLocked()) {
      toast('Editing is locked — tap the lock icon to unlock', true);
      return;
    }
    editorMode = editorMode === 'edit' ? 'preview' : 'edit';
    applyEditorMode();
  });
  document.getElementById('md-toolbar').addEventListener('click', (event) => {
    const codeAction = event.target.closest('[data-code]')?.dataset.code;
    if (codeAction && currentId) {
      if (noteEditingLocked()) return;
      if (editorMode !== 'edit') {
        editorMode = 'edit';
        applyEditorMode();
      }
      if (codeAction === 'comment') prefixLine('// ');
      else if (codeAction === 'indent') indentSelection(1);
      else if (codeAction === 'outdent') indentSelection(-1);
      return;
    }
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
    const dismiss = event.target?.closest?.('[data-doc-hit-dismiss]');
    if (dismiss) {
      event.preventDefault();
      dismissDocHitNote();
      return;
    }
    const nav = event.target?.closest?.('[data-doc-hit-nav]');
    if (!nav) return;
    event.preventDefault();
    jumpDocSearchHit(nav.dataset.docHitNav === 'prev' ? -1 : 1);
  });
  document.addEventListener('keydown', (event) => {
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const stage = activeDocSearchStage();
    if (!stage || docHitNoteSuppressed() || !NotesPreview.listSearchHits(stage).length) return;
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
  document.getElementById('note-info-server-copy')?.addEventListener('click', () => {
    if (!currentId) {
      toast('Open a note first', true);
      return;
    }
    openServerCopyView(currentId).catch((err) => toast(err.message || 'Could not load server copy', true));
  });
  document.getElementById('server-copy-close')?.addEventListener('click', hideServerCopyDialog);
  document.getElementById('server-copy-backdrop')?.addEventListener('click', hideServerCopyDialog);

  const SERVER_COPY_META_FIELDS = [
    { key: 'item_uuid', label: 'item_uuid — plaintext metadata (ID)' },
    { key: 'content_version', label: 'content_version — plaintext metadata' },
    { key: 'content_hash', label: 'content_hash — plaintext metadata (hash of ciphertext string)' },
    { key: 'deleted', label: 'deleted — plaintext metadata' },
    { key: 'updated_at', label: 'updated_at — plaintext metadata (timestamp)' },
    { key: 'synced_at', label: 'synced_at — plaintext metadata (timestamp)' },
    { key: 'rev', label: 'rev — plaintext metadata (server revision)' },
    { key: 'needs_blob', label: 'needs_blob — plaintext metadata' },
    { key: 'ciphertext', label: 'ciphertext — encrypted AES-GCM envelope (v, iv, data)' },
    { key: 'blob_ciphertext', label: 'blob_ciphertext — encrypted file envelope (attachments)' },
  ];

  function hideServerCopyDialog() {
    const dialog = document.getElementById('server-copy-dialog');
    const backdrop = document.getElementById('server-copy-backdrop');
    if (dialog) dialog.hidden = true;
    if (backdrop) backdrop.hidden = true;
    if (!document.getElementById('scan-dialog') || document.getElementById('scan-dialog').hidden) {
      if (!document.querySelector('.scan-dialog:not([hidden])')) {
        document.body.classList.remove('scan-dialog-open');
      }
    }
  }

  function prettyServerJson(value) {
    try {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}'))
          || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          return JSON.stringify(JSON.parse(trimmed), null, 2);
        }
      }
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return String(value ?? '');
    }
  }

  function localPlaintextForServerCopy(uuid) {
    const item = NotesStore.get(uuid);
    if (!item) return { missing: true, note: 'No decrypted copy on this device.' };
    const content = item.content ? { ...item.content } : {};
    // Never dump binary attachment bytes into the panel.
    if (content.type === 'attachment') {
      const hasEnc = !!(content.file_enc || content.file_enc_stored);
      delete content.file_enc;
      delete content.data_b64;
      content.file_enc_present_locally = hasEnc;
      content.file_bytes_note = 'Raw file bytes stay in the encrypted blob; not shown here.';
    }
    if (content.type === 'totp' && content.secret) {
      const secret = String(content.secret);
      content.secret = secret.length <= 4
        ? '••••'
        : `${secret.slice(0, 2)}…${secret.slice(-2)} (${secret.length} chars, redacted in UI)`;
    }
    return {
      uuid: item.uuid || uuid,
      updated_at: item.updated_at,
      deleted: !!item.deleted,
      rev: item.rev,
      content,
    };
  }

  async function openServerCopyView(uuid) {
    const id = String(uuid || '').trim();
    if (!id) throw new Error('Missing item id');
    if (!NotesStore.isUnlocked?.()) throw new Error('Unlock the vault first');
    const dialog = document.getElementById('server-copy-dialog');
    const backdrop = document.getElementById('server-copy-backdrop');
    const status = document.getElementById('server-copy-status');
    const meta = document.getElementById('server-copy-meta');
    const panels = document.getElementById('server-copy-panels');
    const rawPre = document.getElementById('server-copy-raw');
    const plainPre = document.getElementById('server-copy-plain');
    if (!dialog || !backdrop || !status || !meta || !panels || !rawPre || !plainPre) {
      throw new Error('Server copy dialog missing');
    }
    dialog.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('scan-dialog-open');
    status.hidden = false;
    status.textContent = 'Fetching raw server row…';
    status.classList.remove('error');
    meta.hidden = true;
    panels.hidden = true;
    rawPre.textContent = '';
    plainPre.textContent = '';

    let serverItem = null;
    try {
      if (typeof NotesStore.fetchServerItem !== 'function') {
        throw new Error('Server copy fetch is unavailable');
      }
      serverItem = await NotesStore.fetchServerItem(id, { includeBlobs: true });
    } catch (err) {
      if (err?.status === 404) {
        status.textContent = 'No server copy yet — sync this item while online, then try again.';
        plainPre.textContent = prettyServerJson(localPlaintextForServerCopy(id));
        panels.hidden = false;
        return;
      }
      status.textContent = err?.message || 'Could not fetch server copy';
      status.classList.add('error');
      throw err;
    }

    // Lead copy lives in the dialog markup — status is only for loading/errors.
    status.hidden = true;
    status.textContent = '';
    const fieldHelp = SERVER_COPY_META_FIELDS
      .filter((row) => Object.prototype.hasOwnProperty.call(serverItem, row.key)
        && serverItem[row.key] !== ''
        && serverItem[row.key] != null)
      .map((row) => `<div><strong>${escapeHtml(row.key)}</strong> — ${escapeHtml(row.label.split('—')[1]?.trim() || row.label)}</div>`)
      .join('');
    meta.innerHTML = `<div><strong>Field guide</strong> (honest labels)</div>${fieldHelp}`;
    meta.hidden = false;

    // Show the API object as returned — parse nested ciphertext JSON for readability
    // without re-encrypting or inventing fields.
    const display = { ...serverItem };
    ['ciphertext', 'blob_ciphertext'].forEach((key) => {
      const raw = display[key];
      if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try { display[key] = JSON.parse(raw); } catch (err) { /* keep string */ }
      }
    });
    rawPre.textContent = prettyServerJson(display);
    plainPre.textContent = prettyServerJson(localPlaintextForServerCopy(id));
    panels.hidden = false;
  }
  try { window.__notesOpenServerCopy = openServerCopyView; } catch (err) { /* ignore */ }

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
          intentionalCopy: true,
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
    syncNoteTypeMenuSelection();
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
  const openSecureSendFromCurrentNote = () => {
    openSecureSendForNote(currentId).catch((err) => toast(err?.message || 'Secure Send failed', true));
  };
  document.getElementById('btn-note-secure-send')?.addEventListener('click', () => {
    openSecureSendFromCurrentNote();
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
  document.getElementById('btn-download-note')?.addEventListener('click', () => {
    downloadOpenNote().catch((err) => toast(err.message || 'Download failed', true));
  });
  document.getElementById('btn-desktop-doc-fullscreen')?.addEventListener('click', (event) => {
    event.preventDefault();
    const attId = inlineDocPreviewAttId();
    if (!attId) return;
    openInlineDocFullscreen(attId, event);
  });
  syncShareLabels();
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
    // Tag counts exclude trashed notes — refresh chips immediately.
    renderTags();
    toastWithUndo('Moved to trash', () => restoreNote(id));
  }

  function restoreNote(id) {
    const note = NotesStore.get(id);
    if (!note || !note.content.trashed) return;
    NotesStore.upsert(id, { ...note.content, trashed: false });
    const live = NotesStore.get(id);
    restoreNoteReminder(live);
    currentTag = null;
    currentFolder = null;
    setFilter(live.content.archived ? 'archived' : 'all');
    listSelectionId = id;
    renderNotes();
    renderTags();
    if (id === currentId) updateActionButtons(live);
    else openNote(id);
    toast('Restored to notes');
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

  let noteRowMenuNoteId = '';
  const NOTE_ROW_LONG_PRESS_MS = 520;

  function closeNoteRowMenu() {
    const menu = document.getElementById('note-row-menu');
    const backdrop = document.getElementById('note-row-menu-backdrop');
    if (menu) menu.hidden = true;
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.setAttribute('aria-hidden', 'true');
    }
    noteRowMenuNoteId = '';
    document.body.classList.remove('note-row-menu-open');
  }

  function openNoteRowMenu(noteId, anchorEl) {
    const menu = document.getElementById('note-row-menu');
    const backdrop = document.getElementById('note-row-menu-backdrop');
    const id = String(noteId || '').trim();
    if (!menu || !backdrop || !id) return;
    noteRowMenuNoteId = id;
    const anchor = anchorEl
      || ui.noteList?.querySelector(`.note-row[data-id="${CSS.escape(id)}"] .note-row-more`);
    const rect = anchor?.getBoundingClientRect();
    if (rect) {
      const top = Math.min(rect.bottom + 4, window.innerHeight - 72);
      const left = Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184));
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
    }
    menu.hidden = false;
    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');
    document.body.classList.add('note-row-menu-open');
    try { document.getElementById('note-row-menu-secure-send')?.focus(); } catch (err) { /* ignore */ }
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
    let longPressTimer = 0;
    let longPressFired = false;

    function clearLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
    }

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
      if (event.target.closest('.note-swipe-delete, .note-row-delete, .note-row-restore, .note-row-more')) return;
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
      longPressFired = false;
      clearLongPress();
      const longPressRow = next;
      longPressTimer = window.setTimeout(() => {
        if (row !== longPressRow || axis === 'h') return;
        longPressFired = true;
        suppressClick = true;
        clearLongPress();
        closeOpened();
        dragging = false;
        longPressRow.classList.remove('swiping', 'open');
        const item = itemOf(longPressRow);
        if (item) item.style.transform = '';
        openNoteRowMenu(longPressRow.dataset.id, longPressRow.querySelector('.note-row-more'));
        try { navigator.vibrate?.(12); } catch (err) { /* ignore */ }
      }, NOTE_ROW_LONG_PRESS_MS);
      row.classList.add('swiping');
    });

    list.addEventListener('pointermove', (event) => {
      if (!dragging || !row) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearLongPress();
      if (!axis) {
        axis = NotesSwipe.axisLock(dx, dy);
        if (axis === 'h') {
          clearLongPress();
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
      clearLongPress();
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
          const swipe = current.querySelector('.note-swipe-delete');
          if (swipe?.dataset.action === 'restore') restoreNote(current.dataset.id);
          else deleteFromList(current.dataset.id);
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
      if (longPressFired) {
        event.preventDefault();
        longPressFired = false;
        return;
      }
      const moreBtn = event.target.closest('.note-row-more');
      if (moreBtn?.dataset?.id) {
        event.preventDefault();
        event.stopPropagation();
        const id = moreBtn.dataset.id;
        const menu = document.getElementById('note-row-menu');
        if (!menu?.hidden && noteRowMenuNoteId === id) closeNoteRowMenu();
        else openNoteRowMenu(id, moreBtn);
        return;
      }
      const del = event.target.closest('.note-swipe-delete, .note-row-delete, .note-row-restore');
      if (del) {
        event.preventDefault();
        if (del.dataset.action === 'restore') restoreNote(del.dataset.id);
        else deleteFromList(del.dataset.id);
        return;
      }
      const next = event.target.closest('.note-row');
      if (!next) return;
      if (suppressClick) {
        event.preventDefault();
        suppressClick = false;
        return;
      }
      if (typeof shouldSwallowNoteOpen === 'function' && shouldSwallowNoteOpen()) {
        event.preventDefault();
        return;
      }
      if (next.classList.contains('open')) {
        event.preventDefault();
        closeOpened();
        return;
      }
      if (next.dataset.id) {
        listSelectionId = next.dataset.id;
        markActiveNoteRow();
        openNote(next.dataset.id);
      }
    });
  }

  bindNoteList();
  document.getElementById('note-row-menu-backdrop')?.addEventListener('click', closeNoteRowMenu);
  document.getElementById('note-row-menu-secure-send')?.addEventListener('click', () => {
    const id = noteRowMenuNoteId;
    closeNoteRowMenu();
    if (id) {
      openSecureSendForNote(id).catch((err) => toast(err?.message || 'Secure Send failed', true));
    }
  });
  ui.noteList?.addEventListener('scroll', closeNoteRowMenu, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !document.body.classList.contains('note-row-menu-open')) return;
    event.preventDefault();
    closeNoteRowMenu();
  }, true);

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

  function clearCheckedChecklistItems() {
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
  }
  document.getElementById('btn-clear-checked')?.addEventListener('click', clearCheckedChecklistItems);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('#btn-clear-checked-list') : null;
    if (target) clearCheckedChecklistItems();
  });

  async function ingestAttachmentFiles(files) {
    const list = toFileArray(files);
    if (!list.length) return;
    if (!currentId) {
      toast('Open a note first', true);
      return;
    }
    if (list.length > 1) {
      await ingestDocumentBatch(list, { createIfNeeded: false, preserveEditor: true });
      return;
    }
    const copy = await snapshotPickedFile(list[0]);
    if (!copy) return;
    const note = NotesStore.get(currentId);
    // Pass a stable title so ingestDocument does not open the scan dialog.
    // Prefer the note's existing title; only fall back to the filename.
    const title = noteHasUsableTitle(note)
      ? (String(note.content.title || '').trim()
        || NotesSearch.effectiveNoteTitle(note)
        || String(ui.title?.value || '').trim())
      : fileTitleWithExt(copy.name);
    try {
      await ingestDocument(copy, {
        createIfNeeded: false,
        title,
        displayName: copy.name,
        preserveEditor: true,
      });
    } catch (err) {
      if (isDuplicateUploadError(err.message)) {
        await showDuplicateDialog(null, copy, currentId, err.message);
      } else {
        toast(err.message || 'Could not attach file', true);
      }
    }
  }

  document.getElementById('attachment-add-label')?.addEventListener('click', (event) => {
    if (useNativeFileInput()) return;
    event.preventDefault();
    let handlesPromise;
    try {
      beginNotesPicker();
      handlesPromise = openDeviceFilePickerSync({ multiple: true });
    } catch (err) {
      endNotesPicker();
      if (err && err.name === 'AbortError') return;
      openHiddenFileInput(ui.attachmentInput);
      return;
    }
    void (async () => {
      try {
        const picked = await finishDeviceFilePick(handlesPromise);
        if (!picked?.files?.length) return;
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
  function bindSecureSendOpen(el) {
    if (!el) return;
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSecureSendPanel();
      scrollSecureSendComposeIntoView();
    });
  }
  bindSecureSendOpen(document.getElementById('btn-secure-send-head'));
  bindSecureSendOpen(document.getElementById('btn-secure-send-nav'));
  document.getElementById('btn-settings-open-secure-send')?.addEventListener('click', () => {
    closeSettings(true);
    openSecureSendPanel();
    scrollSecureSendComposeIntoView();
  });
  document.getElementById('secure-send-close')?.addEventListener('click', (event) => {
    event.stopPropagation();
    closeSecureSendPanel(true);
  });
  document.getElementById('secure-send-backdrop')?.addEventListener('click', (event) => {
    event.stopPropagation();
    closeSecureSendPanel();
  });
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
        const on = other === btn;
        other.classList.toggle('active', on);
        other.setAttribute('aria-pressed', on ? 'true' : 'false');
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
  document.getElementById('sync-status-retry')?.addEventListener('click', () => {
    vaultDownloadStalled = false;
    syncNow({ full: true, force: true }).catch((err) => {
      showSyncBanner('error', err?.message || 'Sync failed');
    });
  });
  document.getElementById('sync-status-relock')?.addEventListener('click', () => {
    lockVault();
  });
  const sidebarNav = document.querySelector('.sidebar-nav');
  const sidebarNavBackdrop = document.getElementById('sidebar-nav-backdrop');
  function navViewsShouldDrawer() {
    return window.matchMedia && window.matchMedia('(min-width: 1000px) and (max-width: 1099px)').matches && !prefs.navPinned;
  }
  sidebarNav?.addEventListener('pointerenter', () => {
    if (!navViewsShouldDrawer()) return;
    setNavViewsOpen(true);
  });
  sidebarNav?.addEventListener('focusin', () => {
    if (!navViewsShouldDrawer()) return;
    setNavViewsOpen(true);
  });
  sidebarNav?.addEventListener('pointerleave', (event) => {
    if (!navViewsShouldDrawer()) return;
    if (sidebarNav.contains(event.relatedTarget)) return;
    setNavViewsOpen(false);
  });
  sidebarNav?.addEventListener('focusout', (event) => {
    if (!navViewsShouldDrawer()) return;
    if (sidebarNav.contains(event.relatedTarget)) return;
    setNavViewsOpen(false);
  });
  sidebarNavBackdrop?.addEventListener('click', () => setNavViewsOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('nav-views-open')) {
      setNavViewsOpen(false);
    }
  });
  document.getElementById('btn-nav-pin')?.addEventListener('click', () => {
    prefs.navPinned = !prefs.navPinned;
    savePrefs();
    applyNavRail();
  });
  document.getElementById('writing-tip-dismiss')?.addEventListener('click', () => {
    try { localStorage.setItem('notes_hero_guide_dismissed', '1'); } catch (_) { /* ignore */ }
    const tip = document.getElementById('writing-tip');
    if (tip) tip.hidden = true;
  });
  document.querySelectorAll('.editor-mobile-proxy').forEach((proxy) => {
    proxy.addEventListener('click', (event) => {
      event.preventDefault();
      const id = proxy.getAttribute('data-editor-proxy');
      if (!id) return;
      document.getElementById(id)?.click();
    });
  });
  document.getElementById('btn-note-type-menu')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const menu = document.getElementById('note-type-menu');
    if (!menu) return;
    setNoteTypeMenuOpen(menu.hidden);
    if (!menu.hidden) syncNoteTypeMenuSelection();
  });
  document.getElementById('note-type-menu')?.addEventListener('click', (event) => {
    const item = event.target.closest('.note-type-menu-item');
    if (!item) return;
    const nextType = item.getAttribute('data-note-type');
    if (!nextType || !ui.editorType) return;
    ui.editorType.value = nextType;
    ui.editorType.dispatchEvent(new Event('change', { bubbles: true }));
    setNoteTypeMenuOpen(false);
  });
  document.addEventListener('click', (event) => {
    const menu = document.getElementById('note-type-menu');
    const trigger = document.getElementById('btn-note-type-menu');
    if (!menu || menu.hidden) return;
    if (event.target === trigger || trigger?.contains(event.target) || menu.contains(event.target)) return;
    setNoteTypeMenuOpen(false);
  });
  document.getElementById('btn-mobile-doc-fullscreen')?.addEventListener('click', (event) => {
    event.preventDefault();
    const attId = inlineDocPreviewAttId();
    if (!attId) return;
    openInlineDocFullscreen(attId, event);
  });
  // Close → same path as ⋯ → Edit (btn-preview), so PDF-only session suppress applies.
  document.getElementById('btn-mobile-doc-close')?.addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('btn-preview')?.click();
  });
  document.getElementById('btn-mobile-doc-attachment-share')?.addEventListener('click', (event) => {
    event.preventDefault();
    const attId = inlineDocPreviewAttId();
    if (!attId) return;
    shareAttachment(attId).catch((err) => toast(err.message || 'Share failed', true));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const menu = document.getElementById('note-type-menu');
    if (!menu || menu.hidden) return;
    event.preventDefault();
    setNoteTypeMenuOpen(false);
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
    syncProgressStartedAt = Date.now();
    armDelayedSyncProgressBanner({
      text: 'Downloading notes…',
      message: 'Downloading notes…',
    });
    armVaultDownloadTimeout();
    syncNow({ full: true }).catch((err) => {
      toast(err?.message || 'Sync failed', true);
    });
  });
  document.getElementById('btn-list-density')?.addEventListener('click', () => {
    prefs.compactList = !prefs.compactList;
    document.getElementById('pref-compact').checked = !!prefs.compactList;
    savePrefs();
    applyPrefs();
    lastNotesRenderKey = '';
    renderNotes();
    toast(prefs.compactList ? 'Compact list' : 'Comfortable list');
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
    closeEditorToolbarMenu();
    NotesAiChat.onNoteChanged(currentId);
    NotesAiChat.open();
  }

  if (typeof NotesAiChat !== 'undefined') {
    NotesAiChat.init({
      getNote: (id) => (id ? NotesStore.get(id) : null),
      getAttachments: (id) => (id ? NotesStore.listAttachments(id) : []),
      getSettings: () => prefs.aiChat,
      getCsrf: () => resolveDeviceReportCsrf(),
      confirm: (message, options) => confirmAction(message, options),
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
  document.getElementById('pref-auto-open-pdf-only')?.addEventListener('change', (e) => {
    prefs.autoOpenPdfOnly = !!e.target.checked;
    savePrefs();
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
        updateDevicePhrasePrompt();
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

  // Round 74: user-chosen anti-phishing phrase (localStorage only; survives sign-out).
  function refreshDevicePhraseUi() {
    try {
      if (!window.NotesDevicePhrase) return;
      NotesDevicePhrase.renderDisplay(document.getElementById('device-phrase-display'));
      const input = document.getElementById('device-phrase-input');
      if (input) input.value = NotesDevicePhrase.getPhrase();
    } catch (err) {
      /* ignore */
    }
  }
  function setDevicePhraseStatus(message) {
    const el = document.getElementById('device-phrase-settings-status');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }
  refreshDevicePhraseUi();
  document.getElementById('btn-device-phrase-save')?.addEventListener('click', () => {
    if (!window.NotesDevicePhrase) return;
    const input = document.getElementById('device-phrase-input');
    const saved = NotesDevicePhrase.setPhrase(input?.value || '');
    if (input) input.value = saved;
    refreshDevicePhraseUi();
    updateDevicePhrasePrompt();
    setDevicePhraseStatus(saved ? 'Saved on this device.' : 'Cleared — no phrase on this device.');
    toast(saved ? 'Device phrase saved' : 'Device phrase cleared');
  });
  document.getElementById('btn-device-phrase-clear')?.addEventListener('click', () => {
    if (!window.NotesDevicePhrase) return;
    NotesDevicePhrase.clearPhrase();
    const input = document.getElementById('device-phrase-input');
    if (input) input.value = '';
    refreshDevicePhraseUi();
    updateDevicePhrasePrompt();
    setDevicePhraseStatus('Cleared — no phrase on this device.');
    toast('Device phrase cleared');
  });
  document.getElementById('btn-device-phrase-prompt-set')?.addEventListener('click', () => {
    try {
      if (window.NotesDevicePhrase) NotesDevicePhrase.dismissPrompt();
    } catch (err) { /* ignore */ }
    updateDevicePhrasePrompt();
    try { openSettings(); } catch (err) { /* ignore */ }
    const input = document.getElementById('device-phrase-input');
    if (input) {
      try { input.focus(); } catch (err) { /* ignore */ }
      try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { /* ignore */ }
    }
  });
  document.getElementById('btn-device-phrase-prompt-dismiss')?.addEventListener('click', () => {
    try {
      if (window.NotesDevicePhrase) NotesDevicePhrase.dismissPrompt();
    } catch (err) { /* ignore */ }
    updateDevicePhrasePrompt();
  });

  // D2 Secure Send — compose + Sent list (ciphertext only; key in fragment).
  let secureSendPendingFile = null;
  let secureSendInclusionFromNote = false;
  /** @type {Array<{name: string, bytes: Uint8Array, mime?: string}>} */
  let secureSendStagedEntries = [];
  let secureSendZipNoteTitle = '';

  function setSecureSendStatus(message) {
    const el = document.getElementById('secure-send-status');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function scrollSecureSendComposeIntoView() {
    const section = document.getElementById('secure-send-compose');
    const body = document.querySelector('#secure-send-panel .settings-body');
    if (body) {
      try { body.scrollTop = 0; } catch (err) { /* ignore */ }
    }
    if (!section) return;
    try {
      section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (err) {
      try { section.scrollIntoView(true); } catch (e) { /* ignore */ }
    }
  }

  function updateSecureSendFilePickerUi() {
    const pickerWrap = document.getElementById('secure-send-file-picker-wrap');
    const inclusionWrap = document.getElementById('secure-send-file-inclusion');
    const hasStaged = inclusionWrap && !inclusionWrap.hidden;
    if (pickerWrap) pickerWrap.hidden = hasStaged;
  }

  function paintSecureSendFileInclusion(includedNames, zipNote) {
    const wrap = document.getElementById('secure-send-file-inclusion');
    const headingEl = document.getElementById('secure-send-file-inclusion-heading');
    const list = document.getElementById('secure-send-file-inclusion-list');
    const noteEl = document.getElementById('secure-send-file-inclusion-note');
    const names = Array.isArray(includedNames)
      ? includedNames.map((n) => String(n || '').trim()).filter(Boolean)
      : [];
    if (!wrap || !list) return;
    list.replaceChildren();
    if (!names.length) {
      wrap.hidden = true;
      if (headingEl) headingEl.textContent = 'Including:';
      if (noteEl) {
        noteEl.textContent = '';
        noteEl.hidden = true;
      }
      updateSecureSendFilePickerUi();
      return;
    }
    const note = String(zipNote || '').trim();
    if (headingEl) {
      if (note) {
        headingEl.textContent = 'Including (as zip):';
      } else if (secureSendInclusionFromNote) {
        headingEl.textContent = 'From this note';
      } else {
        headingEl.textContent = 'Including:';
      }
    }
    names.forEach((name, index) => {
      const li = document.createElement('li');
      li.className = 'secure-send-file-inclusion-item';
      const label = document.createElement('span');
      label.className = 'secure-send-file-inclusion-name';
      label.textContent = name;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn icon sm secure-send-file-remove';
      removeBtn.setAttribute('aria-label', `Remove ${name}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        removeSecureSendStagedFile(index);
      });
      li.appendChild(label);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
    if (noteEl) {
      noteEl.textContent = note;
      noteEl.hidden = !note;
    }
    wrap.hidden = false;
    updateSecureSendFilePickerUi();
  }

  function clearSecureSendStagedFiles() {
    secureSendPendingFile = null;
    secureSendStagedEntries = [];
    secureSendInclusionFromNote = false;
    secureSendZipNoteTitle = '';
    const fileInput = document.getElementById('secure-send-file');
    if (fileInput) fileInput.value = '';
    const addInput = document.getElementById('secure-send-file-add');
    if (addInput) addInput.value = '';
    paintSecureSendFileInclusion([], '');
  }

  async function restageSecureSendFromEntries() {
    const stage = window.NotesSecureSendNoteAttachments;
    if (!stage?.stageSecureSendEntries) {
      throw new Error('Could not prepare files on this build.');
    }
    const maxFileBytes = Number(NotesSecureSend?.MAX_FILE_BYTES) || 50 * 1024 * 1024;
    const { file, includedNames, zipNote } = stage.stageSecureSendEntries(secureSendStagedEntries, {
      noteTitle: secureSendZipNoteTitle,
      maxFileBytes,
    });
    secureSendPendingFile = file;
    paintSecureSendFileInclusion(includedNames, zipNote);
  }

  async function setSecureSendStagedEntries(entries, options) {
    secureSendStagedEntries = (entries || []).map((row) => ({
      name: String(row?.name || 'file').trim() || 'file',
      bytes: row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes || []),
      mime: row.mime || 'application/octet-stream',
    }));
    if (options && typeof options.fromNote === 'boolean') {
      secureSendInclusionFromNote = options.fromNote;
    }
    if (options && options.noteTitle != null) {
      secureSendZipNoteTitle = String(options.noteTitle || '');
    }
    if (!secureSendStagedEntries.length) {
      clearSecureSendStagedFiles();
      return;
    }
    await restageSecureSendFromEntries();
  }

  async function removeSecureSendStagedFile(index) {
    const i = Number(index);
    if (!Number.isFinite(i) || i < 0 || i >= secureSendStagedEntries.length) return;
    secureSendStagedEntries.splice(i, 1);
    if (!secureSendStagedEntries.length) {
      clearSecureSendStagedFiles();
      return;
    }
    try {
      await restageSecureSendFromEntries();
    } catch (err) {
      const msg = err?.message || 'Could not update files.';
      setSecureSendStatus(msg);
      toast(msg, true);
    }
  }

  async function mergeSecureSendPickedFiles(fileList, options) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    const stage = window.NotesSecureSendNoteAttachments;
    const disambiguate = stage?.disambiguateZipName;
    const used = new Set(
      secureSendStagedEntries.map((row) => String(row.name || '').toLowerCase()),
    );
    const merged = secureSendStagedEntries.slice();
    for (const picked of files) {
      let name = String(picked.name || 'file').trim() || 'file';
      if (typeof disambiguate === 'function') {
        name = disambiguate(name, used);
      }
      used.add(name.toLowerCase());
      const buf = await picked.arrayBuffer();
      merged.push({
        name,
        bytes: new Uint8Array(buf),
        mime: picked.type || 'application/octet-stream',
      });
    }
    if (options?.fromNote !== true) {
      secureSendInclusionFromNote = false;
    }
    await setSecureSendStagedEntries(merged, {
      fromNote: secureSendInclusionFromNote,
      noteTitle: secureSendZipNoteTitle,
    });
  }

  function prefillSecureSendFromNote(note) {
    const titleEl = document.getElementById('secure-send-title');
    const bodyEl = document.getElementById('secure-send-body');
    const fileInput = document.getElementById('secure-send-file');
    const passEl = document.getElementById('secure-send-passphrase');
    const viewsEl = document.getElementById('secure-send-views');
    const daysEl = document.getElementById('secure-send-days');
    const wrap = document.getElementById('secure-send-link-wrap');
    const linkInput = document.getElementById('secure-send-link');
    secureSendPendingFile = null;
    secureSendInclusionFromNote = false;
    secureSendStagedEntries = [];
    secureSendZipNoteTitle = '';
    if (titleEl) titleEl.value = NotesSearch.effectiveNoteTitle(note) || '';
    if (bodyEl) bodyEl.value = String(note.content?.content || '');
    if (fileInput) fileInput.value = '';
    if (passEl) passEl.value = '';
    if (viewsEl && window.NotesSecureSend) {
      viewsEl.value = String(NotesSecureSend.DEFAULT_MAX_VIEWS || 1);
    }
    if (daysEl) daysEl.value = '7';
    if (wrap) wrap.hidden = true;
    if (linkInput) linkInput.value = '';
    setSecureSendStatus('');
    clearSecureSendStagedFiles();
    updateSecureSendFilePickerUi();
  }

  async function openSecureSendForNote(noteId) {
    if (!NotesStore.isUnlocked()) {
      toast('Unlock the vault first', true);
      return;
    }
    const id = String(noteId || '').trim();
    if (!id) return;
    const note = NotesStore.get(id);
    if (!note) return;
    if (note.content?.locked && !unlockedNotes.has(id)) {
      toast('Unlock this protected note first', true);
      return;
    }
    closeNoteOptions();
    closeEditorToolbarMenu();
    closeNoteRowMenu();
    prefillSecureSendFromNote(note);
    openSecureSendPanel();
    scrollSecureSendComposeIntoView();
    try { document.getElementById('secure-send-title')?.focus(); } catch (err) { /* ignore */ }
    const atts = NotesStore.listAttachments(id).filter((att) => !att.deleted);
    if (!atts.length) return;
    const stage = window.NotesSecureSendNoteAttachments;
    if (!stage?.stageSecureSendNoteAttachments) {
      setSecureSendStatus('Could not include attachments on this build.');
      return;
    }
    setSecureSendStatus(
      atts.length === 1 ? 'Loading attachment…' : `Preparing ${atts.length} files…`,
    );
    try {
      const maxFileBytes = Number(NotesSecureSend?.MAX_FILE_BYTES) || 50 * 1024 * 1024;
      const noteTitle = NotesSearch.effectiveNoteTitle(note);
      const { entries } = await stage.stageSecureSendNoteAttachments({
        attachments: atts,
        noteTitle,
        maxFileBytes,
        loadBytes: (att) => NotesStore.getAttachmentBytes(att.uuid),
      });
      setSecureSendStatus('');
      await setSecureSendStagedEntries(entries, { fromNote: true, noteTitle });
    } catch (err) {
      clearSecureSendStagedFiles();
      const msg = err?.message || 'Could not prepare attachments.';
      setSecureSendStatus(msg);
      toast(msg, true);
    }
  }
  try { window.__notesOpenSecureSendForNote = openSecureSendForNote; } catch (err) { /* ignore */ }

  document.getElementById('btn-secure-send-add-files')?.addEventListener('click', () => {
    try { document.getElementById('secure-send-file-add')?.click(); } catch (err) { /* ignore */ }
  });
  document.getElementById('secure-send-file-add')?.addEventListener('change', async () => {
    const addInput = document.getElementById('secure-send-file-add');
    const files = addInput?.files;
    if (!files?.length) return;
    try {
      setSecureSendStatus('Adding files…');
      await mergeSecureSendPickedFiles(files);
      setSecureSendStatus('');
    } catch (err) {
      const msg = err?.message || 'Could not add files.';
      setSecureSendStatus(msg);
      toast(msg, true);
    } finally {
      if (addInput) addInput.value = '';
    }
  });
  document.getElementById('secure-send-file')?.addEventListener('change', async () => {
    const fileInput = document.getElementById('secure-send-file');
    const picked = fileInput?.files?.[0];
    if (!picked) return;
    try {
      setSecureSendStatus('Loading file…');
      secureSendInclusionFromNote = false;
      secureSendZipNoteTitle = '';
      await mergeSecureSendPickedFiles([picked], { fromNote: false });
      setSecureSendStatus('');
    } catch (err) {
      const msg = err?.message || 'Could not load file.';
      setSecureSendStatus(msg);
      toast(msg, true);
    } finally {
      if (fileInput) fileInput.value = '';
    }
  });
  document.getElementById('btn-secure-send-refresh')?.addEventListener('click', () => {
    refreshSecureSendList();
  });
  document.getElementById('secure-send-detail-close')?.addEventListener('click', closeSecureSendSentDetail);
  document.getElementById('secure-send-detail-backdrop')?.addEventListener('click', closeSecureSendSentDetail);
  document.getElementById('btn-secure-send-detail-revoke')?.addEventListener('click', () => {
    if (secureSendDetailServerItem) {
      revokeSecureSendSentItem(secureSendDetailServerItem);
    }
  });
  document.getElementById('btn-secure-send-detail-copy')?.addEventListener('click', async () => {
    const linkInput = document.getElementById('secure-send-detail-link');
    const url = linkInput ? String(linkInput.value || '') : '';
    if (!url) {
      toast(SECURE_SEND_NO_VAULT_RECORD_MSG, true);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (err) {
      try {
        linkInput.focus();
        linkInput.select();
      } catch (e) { /* ignore */ }
      toast('Select the link and copy it', true);
    }
  });
  document.getElementById('btn-secure-send-detail-share')?.addEventListener('click', async () => {
    const linkInput = document.getElementById('secure-send-detail-link');
    const url = linkInput ? String(linkInput.value || '') : '';
    if (!url) {
      toast(SECURE_SEND_NO_VAULT_RECORD_MSG, true);
      return;
    }
    const local = secureSendDetailServerItem?.id && NotesStore.getSecureSendSentRecord
      ? NotesStore.getSecureSendSentRecord(secureSendDetailServerItem.id)
      : null;
    const title = local?.snapshot?.title ? String(local.snapshot.title).trim() : '';
    try {
      await shareSecureSendLink(url, { title });
    } catch (err) {
      toast(err?.message || 'Share failed', true);
    }
  });
  document.getElementById('btn-secure-send-create')?.addEventListener('click', async () => {
    if (!window.NotesSecureSend || !window.NotesStore || !window.NotesCrypto) {
      setSecureSendStatus('Secure Send is unavailable on this build.');
      return;
    }
    const title = document.getElementById('secure-send-title')?.value || '';
    const body = document.getElementById('secure-send-body')?.value || '';
    const fileInput = document.getElementById('secure-send-file');
    const file = secureSendPendingFile
      || (fileInput?.files && fileInput.files[0] ? fileInput.files[0] : null);
    const passphrase = document.getElementById('secure-send-passphrase')?.value || '';
    const maxViews = Number(NotesSecureSend.MAX_VIEWS_CAP) || 10;
    let views = Number(document.getElementById('secure-send-views')?.value || 1);
    let days = Number(document.getElementById('secure-send-days')?.value || 7);
    if (!Number.isFinite(views) || views < 1) views = 1;
    if (views > maxViews) views = maxViews;
    if (!Number.isFinite(days) || days < 1) days = 1;
    if (days > 7) days = 7;
    if (!title.trim() && !body.trim() && !file) {
      setSecureSendStatus('Add a title, note, or file.');
      return;
    }
    const btn = document.getElementById('btn-secure-send-create');
    if (btn) btn.disabled = true;
    setSecureSendStatus('Encrypting…');
    try {
      const sealed = await NotesSecureSend.sealPayload({
        title,
        body,
        file,
        passphrase,
      });
      const createBody = {
        ciphertext: sealed.ciphertext,
        expires_in: Math.round(days * 24 * 3600),
        max_views: views,
      };
      if (sealed.hasPassphrase && sealed.openVerifier) {
        createBody.open_verifier = sealed.openVerifier;
      }
      NotesSecureSend.assertNoFragmentLeak('/api/secure-send', createBody);
      const created = await NotesStore.api('/api/secure-send', {
        method: 'POST',
        body: JSON.stringify(createBody),
        timeoutMs: sealed.hasFile ? 120000 : 30000,
      });
      const url = NotesSecureSend.buildReceiveUrl(location.origin, created.id, sealed.fragment);
      const wrap = document.getElementById('secure-send-link-wrap');
      const linkInput = document.getElementById('secure-send-link');
      if (wrap) wrap.hidden = false;
      if (linkInput) {
        linkInput.value = url;
        try { linkInput.select(); } catch (err) { /* ignore */ }
      }
      syncSecureSendShareButtons();
      setSecureSendStatus(
        sealed.hasPassphrase
          ? 'Link ready. Share the passphrase separately — the link alone cannot open it. After the opens are used, the link stops working.'
          : 'Link ready. Anyone with the full link can open it. After the opens are used, the link stops working.',
      );
      toast('Secure Send link created');
      if (NotesStore.saveSecureSendSentRecord) {
        NotesStore.saveSecureSendSentRecord({
          sendId: created.id,
          shareUrl: url,
          snapshot: {
            title,
            body,
            attachment_names: secureSendSnapshotAttachmentNames(),
          },
        });
      }
      clearSecureSendStagedFiles();
      refreshSecureSendList();
    } catch (err) {
      setSecureSendStatus(err?.message || 'Could not create link');
      toast(err?.message || 'Secure Send failed', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById('btn-secure-send-copy')?.addEventListener('click', async () => {
    const linkInput = document.getElementById('secure-send-link');
    const url = linkInput ? String(linkInput.value || '') : '';
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (err) {
      try {
        linkInput.focus();
        linkInput.select();
      } catch (e) { /* ignore */ }
      toast('Select the link and copy it', true);
    }
  });
  document.getElementById('btn-secure-send-share')?.addEventListener('click', async () => {
    const linkInput = document.getElementById('secure-send-link');
    const url = linkInput ? String(linkInput.value || '') : '';
    if (!url) return;
    const titleInput = document.getElementById('secure-send-title');
    const title = titleInput ? String(titleInput.value || '').trim() : '';
    try {
      await shareSecureSendLink(url, { title });
    } catch (err) {
      toast(err?.message || 'Share failed', true);
    }
  });

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
    if (event.target.closest('[data-totp-edit]')) {
      showTotpEditDialog(row.dataset.totpId);
      return;
    }
    const serverBtn = event.target.closest('[data-server-copy]');
    if (serverBtn) {
      openServerCopyView(serverBtn.dataset.serverCopy || row.dataset.totpId)
        .catch((err) => toast(err.message || 'Could not load server copy', true));
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
  document.getElementById('btn-totp-pick-qr')?.addEventListener('click', () => openHiddenFileInput(totpUi.qrInput));
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
    const btn = document.getElementById('btn-reload-notes');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      closeSettings(true);
      vaultDownloadStalled = false;
      beginVaultPull(0);
      try {
        await NotesStore.clearUnreadableLocal();
      } catch (err) {
        await NotesStore.rememberLastSync(0);
      }
      await syncNow({ full: true, force: true });
      const count = NotesStore.listNotes().filter((n) => !n.content.trashed).length;
      toast(count ? `Loaded ${count} note${count === 1 ? '' : 's'}` : 'Server returned no notes for this password');
    } catch (err) {
      if (err?.code === 'DECRYPT_FAILED' || err?.code === 'DECRYPT_PARTIAL') handleVaultDecryptFailure(err, { relock: false });
      else toast(err.message || 'Reload failed', true);
    } finally {
      if (btn) btn.disabled = false;
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
      updateDevicePhrasePrompt();
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
        const data = await fetchHealthJson();
        serverBuild = String(data?.build || '');
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
    if (!note) return;
    downloadNoteMarkdown(note, 'Note exported');
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    requestSignOut().catch((err) => toast(err.message || 'Could not sign out', true));
  });

  function accountTotpCodeDigits(raw) {
    return String(raw || '').replace(/\D/g, '').slice(0, 6);
  }

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
    if (!box.hidden) {
      document.getElementById('totp-disable-code')?.focus();
    }
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
    const codeEl = document.getElementById('totp-disable-code');
    const code = accountTotpCodeDigits(codeEl?.value);
    if (code.length !== 6) {
      toast('Enter your current 6-digit authenticator code to disable 2FA.', true);
      codeEl?.focus();
      return;
    }
    const body = { code };
    // Round 73: never send plaintext password for SRP accounts (server ignores it anyway).
    const authMethod = String(
      NotesStore.cachedAccount?.()?.auth_method
      || NotesStore.state?.account?.auth_method
      || '',
    );
    if (password && authMethod !== 'srp') body.password = password;
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

  function armCurrentVaultPasswordField() {
    const input = document.getElementById('password-change-current');
    if (!input) return;
    if (input.dataset.userTyped !== '1') {
      input.value = '';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('readonly', 'readonly');
    }
    if (input.dataset.armBound === '1') return;
    input.dataset.armBound = '1';
    const arm = () => {
      input.removeAttribute('readonly');
      if (input.getAttribute('autocomplete') !== 'current-password') {
        input.setAttribute('autocomplete', 'current-password');
      }
    };
    input.addEventListener('focus', arm);
    input.addEventListener('pointerdown', arm);
    input.addEventListener('input', () => {
      input.dataset.userTyped = '1';
      arm();
    });
  }

  function sameVerificationRecipient(account) {
    const cached = account || NotesStore.cachedAccount?.() || {};
    const email = String(cached.email || document.getElementById('account-email')?.textContent || '').trim().toLowerCase();
    const typedBackup = String(document.getElementById('backup-email')?.value || '').trim().toLowerCase();
    const backup = typedBackup || String(cached.backup_email || '').trim().toLowerCase();
    return !!(email && backup && email === backup);
  }

  function armSiblingResendCooldown(buttonId, seconds, options) {
    if (!sameVerificationRecipient()) return;
    const other = buttonId === 'btn-account-verify-resend'
      ? 'btn-backup-verify-resend'
      : 'btn-account-verify-resend';
    const otherBtn = document.getElementById(other);
    const wrap = otherBtn?.closest('.settings-nested');
    if (!otherBtn || (wrap && wrap.hidden)) return;
    startResendCooldown(other, seconds, options);
  }

  function renderEmailVerification(account) {
    const status = document.getElementById('account-verify-status');
    const wrap = document.getElementById('account-verify-wrap');
    const shared = sameVerificationRecipient(account);
    const emailRetry = Number(account?.email_verify_retry_after) || 0;
    const backupRetry = Number(account?.backup_verify_retry_after) || 0;
    const accountWait = shared ? Math.max(emailRetry, backupRetry) : emailRetry;
    const backupWait = shared ? Math.max(emailRetry, backupRetry) : backupRetry;
    if (status && wrap) {
      const verified = account?.email_verified !== false;
      status.hidden = verified;
      wrap.hidden = verified;
      if (!verified) status.textContent = 'Email not verified. Enter the code we sent before backups can use this address.';
      if (!verified && accountWait > 0) {
        startResendCooldown('btn-account-verify-resend', accountWait, { waiting: true });
      }
    }
    const backupStatus = document.getElementById('backup-verify-status');
    const backupWrap = document.getElementById('backup-verify-wrap');
    if (backupStatus && backupWrap) {
      const ok = account?.backup_recipient_verified !== false;
      const accountUnverified = account?.email_verified === false;
      backupStatus.hidden = ok;
      backupWrap.hidden = ok || (shared && accountUnverified);
      if (!ok && shared && accountUnverified) {
        backupStatus.innerHTML = '<a href="#account-verify-wrap">Verify this address in Account</a>';
      } else if (!ok) backupStatus.textContent = 'This backup address is not verified yet. Enter the code from that inbox. Backups are not sent until then.';
      if (!ok && backupWait > 0) {
        startResendCooldown('btn-backup-verify-resend', backupWait, { waiting: true });
      }
      const hint = document.getElementById('backup-verified-hint');
      if (hint) hint.hidden = ok;
    }
  }

  async function verifyEmailCode(path, inputId) {
    const code = String(document.getElementById(inputId)?.value || '').replace(/\D/g, '');
    if (code.length !== 6) {
      toast('Enter the 6-digit code from your email', true);
      return;
    }
    try {
      await NotesStore.api(path, { method: 'POST', body: JSON.stringify({ code }) });
      toast('Email verified');
      await initSettings();
    } catch (err) {
      toast(err.message || 'Could not verify that code', true);
    }
  }

  const resendCooldownTimers = new Map();

  function startResendCooldown(buttonId, seconds, { waiting = false } = {}) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    const wait = Math.max(1, Math.ceil(Number(seconds) || 60));
    const until = Date.now() + wait * 1000;
    const prev = resendCooldownTimers.get(buttonId);
    if (prev) clearInterval(prev);
    if (!btn.dataset.resendLabel) btn.dataset.resendLabel = btn.textContent || 'Resend code';
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      const status = waiting ? resendStatusElement(buttonId) : null;
      if (left <= 0) {
        clearInterval(timer);
        resendCooldownTimers.delete(buttonId);
        btn.disabled = false;
        btn.textContent = btn.dataset.resendLabel || 'Resend code';
        if (status) {
          status.textContent = '';
          status.hidden = true;
          status.classList.remove('error');
        }
        return;
      }
      btn.disabled = true;
      btn.textContent = `Resend in ${left}s`;
      btn.removeAttribute('aria-busy');
      if (status) {
        status.hidden = false;
        status.classList.remove('error');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = `Please wait ${left} s before requesting another code`;
      }
    };
    const timer = setInterval(tick, 250);
    resendCooldownTimers.set(buttonId, timer);
    tick();
  }

  function resendStatusElement(buttonId) {
    const statusId = buttonId === 'btn-backup-verify-resend'
      ? 'backup-verify-resend-status'
      : 'account-verify-resend-status';
    return document.getElementById(statusId);
  }

  function showResendStatus(buttonId, message, isError) {
    const el = resendStatusElement(buttonId);
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
    el.classList.toggle('error', !!isError);
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  }

  async function resendVerificationCode(path, buttonId) {
    const btn = document.getElementById(buttonId);
    if (!btn || btn.disabled) return;
    if (!btn.dataset.resendLabel || btn.dataset.resendLabel === 'Sending…') {
      btn.dataset.resendLabel = 'Resend code';
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    btn.setAttribute('aria-busy', 'true');
    try {
      const data = await NotesStore.api(path, { method: 'POST', body: '{}' });
      const wait = Number(data && data.retry_after) || 60;
      const sent = 'Verification code sent';
      showResendStatus(buttonId, sent, false);
      toast(sent);
      startResendCooldown(buttonId, wait);
      armSiblingResendCooldown(buttonId, wait);
    } catch (err) {
      const wait = Number(err.retryAfter) || 0;
      if (err.status === 429 && wait > 0) {
        // Expected cooldown. The button and the inline sentence count down
        // together. Do not console.error — the next click is blocked until it ends.
        const msg = (err.message && /Please wait/i.test(err.message))
          ? err.message
          : `Please wait ${Math.ceil(wait)} s before requesting another code`;
        showResendStatus(buttonId, msg, false);
        toast(msg);
        startResendCooldown(buttonId, wait, { waiting: true });
        armSiblingResendCooldown(buttonId, wait, { waiting: true });
        return;
      }
      btn.disabled = false;
      btn.textContent = btn.dataset.resendLabel || 'Resend code';
      btn.removeAttribute('aria-busy');
      const msg = err.status === 429
        ? (err.message || 'Too many verification emails sent today. Try again tomorrow or use the code already emailed.')
        : (err.message || 'Could not send a code');
      showResendStatus(buttonId, msg, true);
      toast(msg, true);
    }
  }

  document.getElementById('btn-account-verify')?.addEventListener('click', () => {
    verifyEmailCode('/api/account/email/verify', 'account-verify-code');
  });
  document.getElementById('btn-account-verify-resend')?.addEventListener('click', () => {
    resendVerificationCode('/api/account/email/resend', 'btn-account-verify-resend');
  });
  document.getElementById('btn-backup-verify')?.addEventListener('click', () => {
    verifyEmailCode('/api/backup/email/verify', 'backup-verify-code');
  });
  document.getElementById('btn-backup-verify-resend')?.addEventListener('click', () => {
    resendVerificationCode('/api/backup/email/resend', 'btn-backup-verify-resend');
  });

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
    if (!String(current).trim()) {
      errEl.textContent = 'Enter your current vault password.';
      errEl.hidden = false;
      currentEl?.focus();
      return;
    }
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
      if (currentEl) {
        currentEl.value = '';
        delete currentEl.dataset.userTyped;
        currentEl.setAttribute('autocomplete', 'off');
        currentEl.setAttribute('readonly', 'readonly');
      }
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
  armCurrentVaultPasswordField();
  setTimeout(armCurrentVaultPasswordField, 300);

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

  let backupNowCooldownTimer = null;
  let backupNowCooldownUntil = 0;
  // Unverified backup path: a verification code was already emailed this cooldown.
  let backupVerifyCodePending = false;

  function backupNowCooldownLeft() {
    return Math.max(0, Math.ceil((backupNowCooldownUntil - Date.now()) / 1000));
  }

  function backupVerifyWaitFromAccount(account) {
    return Math.max(
      Number(account?.email_verify_retry_after) || 0,
      Number(account?.backup_verify_retry_after) || 0,
    );
  }

  function backupNeedsEmailVerify(account) {
    if (!account) return backupVerifyCodePending;
    if (account.email_verified === false) return true;
    if (account.backup_recipient_verified === false) return true;
    return backupVerifyCodePending;
  }

  function backupCooldownToast(seconds, { unverified = false } = {}) {
    const left = Math.max(1, Math.ceil(Number(seconds) || 1));
    if (unverified) {
      return `Verify this email first — a code was already sent. Resend in ${left}s.`;
    }
    return `Code already sent — resend in ${left}s`;
  }

  function armBackupNowCooldown(seconds) {
    const btn = document.getElementById('btn-backup-now');
    const wait = Math.max(1, Math.ceil(Number(seconds) || 60));
    backupNowCooldownUntil = Date.now() + wait * 1000;
    if (!btn) return;
    if (backupNowCooldownTimer) clearInterval(backupNowCooldownTimer);
    if (!btn.dataset.backupLabel) btn.dataset.backupLabel = btn.textContent || 'Email backup now';
    const tick = () => {
      const left = backupNowCooldownLeft();
      if (left <= 0) {
        clearInterval(backupNowCooldownTimer);
        backupNowCooldownTimer = null;
        backupNowCooldownUntil = 0;
        btn.disabled = false;
        btn.textContent = btn.dataset.backupLabel || 'Email backup now';
        return;
      }
      btn.disabled = true;
      btn.textContent = `Resend in ${left}s`;
    };
    tick();
    backupNowCooldownTimer = setInterval(tick, 1000);
  }

  document.getElementById('btn-backup-now').addEventListener('click', async () => {
    const btn = document.getElementById('btn-backup-now');
    const account = NotesStore.cachedAccount?.() || {};
    const unverified = backupNeedsEmailVerify(account);
    const accountWait = backupVerifyWaitFromAccount(account);
    const cooling = Math.max(backupNowCooldownLeft(), unverified ? accountWait : 0);
    // During cooldown never hit /api/backup/email again (avoids "We sent a code").
    if (cooling > 0 || btn?.disabled) {
      const left = cooling
        || Number((/Resend in (\d+)s/.exec(btn?.textContent || '') || [])[1])
        || accountWait
        || 0;
      if (left > 0) {
        if (unverified) backupVerifyCodePending = true;
        armBackupNowCooldown(left);
        toast(backupCooldownToast(left, { unverified }), true);
      }
      return;
    }
    try {
      await NotesStore.flush();
      const email = document.getElementById('backup-email').value;
      await NotesStore.api('/api/backup/email', { method: 'POST', body: JSON.stringify({ email }) });
      backupVerifyCodePending = false;
      toast('Encrypted backup emailed');
    } catch (err) {
      const wait = Number(err.retryAfter) || 0;
      const msg = String(err.message || '');
      if (err.status === 429 && /too many/i.test(msg)) {
        toast(msg, true);
        return;
      }
      if (err.status === 429 && wait > 0) {
        const needsVerify = unverified || backupVerifyCodePending || /verify|already sent/i.test(msg);
        if (needsVerify) backupVerifyCodePending = true;
        armBackupNowCooldown(wait);
        toast(backupCooldownToast(wait, { unverified: needsVerify }), true);
        return;
      }
      if (err.status === 403 && /verify|We sent a code/i.test(msg)) {
        const retry = Math.max(
          backupVerifyWaitFromAccount(NotesStore.cachedAccount?.() || {}),
          wait,
        );
        const justSent = /We sent a code/i.test(msg);
        backupVerifyCodePending = true;
        const secs = retry > 0 ? retry : 60;
        armBackupNowCooldown(secs);
        // First send: keep the server's "We sent a code" copy. Later clicks
        // are handled by the cooldown guard above and never re-call the API.
        if (retry > 0 && !justSent) {
          toast(backupCooldownToast(retry, { unverified: true }), true);
          return;
        }
        if (justSent) {
          toast(msg, true);
          return;
        }
        toast(backupCooldownToast(secs, { unverified: true }), true);
        return;
      }
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

  async function prepareEncryptedBackupBlob(report) {
    await NotesStore.flush();
    const backup = await buildLocalBackup(report);
    const Cloud = window.NotesCloudBackup;
    const filename = Cloud?.backupFilename?.() || `deeperguard-backup-${new Date().toISOString().slice(0, 10)}.dgbackup`;
    const blob = Cloud?.backupBlobFromObject
      ? Cloud.backupBlobFromObject(backup)
      : new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    return { backup, blob, filename };
  }

  async function saveEncryptedBackupFile() {
    await runFileDownloadTask({
      title: 'Encrypted vault backup',
      prepareLabel: 'Preparing backup…',
      run: async (report) => {
        const { blob, filename } = await prepareEncryptedBackupBlob(report);
        report({ status: 'Saving backup…', pct: 96, indeterminate: false });
        const Cloud = window.NotesCloudBackup;
        if (Cloud?.saveBackupFile) {
          const result = await Cloud.saveBackupFile(blob, { filename });
          if (result.method === 'share-cancelled') {
            report({ status: 'Cancelled', pct: 100, indeterminate: false });
            return { cancelled: true };
          }
          report({
            status: result.method === 'share' ? 'Shared — pick Save to Files' : 'Download started',
            pct: 100,
            indeterminate: false,
          });
          return result;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        report({ status: 'Download started', pct: 100, indeterminate: false });
        return { method: 'download', filename };
      },
    });
  }

  document.getElementById('btn-download-backup')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-download-backup');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await saveEncryptedBackupFile();
      toast('Encrypted vault saved');
    } catch (err) {
      toast(err.message || 'Download failed', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('btn-save-backup-file')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-backup-file');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const result = await saveEncryptedBackupFile();
      if (!result?.cancelled) toast('Encrypted backup ready');
    } catch (err) {
      toast(err.message || 'Could not save backup', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  function syncCloudProviderKeysFromPrefs() {
    const Cloud = window.NotesCloudBackup;
    if (!Cloud?.setUserProviderKeys) return;
    try {
      const account = NotesStore.cachedAccount?.() || {};
      Cloud.setAccountScope?.(account.email || '');
    } catch (err) { /* ignore */ }
    Cloud.setUserProviderKeys({
      googleClientId: String(prefs.googleOauthClientId || '').trim(),
      dropboxAppKey: String(prefs.dropboxAppKey || '').trim(),
    });
    if (Cloud.setVaultTokenBridge) {
      Cloud.setVaultTokenBridge({
        load: () => ({
          dropboxRefreshToken: String(prefs.dropboxRefreshToken || ''),
          dropboxAccessToken: String(prefs.dropboxAccessToken || ''),
          dropboxTokenExpiresAt: Number(prefs.dropboxTokenExpiresAt) || 0,
          dropboxConnected: !!prefs.dropboxConnected,
        }),
        save: (patch) => {
          if (!patch || typeof patch !== 'object') return;
          if (patch.dropboxRefreshToken != null) prefs.dropboxRefreshToken = String(patch.dropboxRefreshToken || '');
          if (patch.dropboxAccessToken != null) prefs.dropboxAccessToken = String(patch.dropboxAccessToken || '');
          if (patch.dropboxTokenExpiresAt != null) prefs.dropboxTokenExpiresAt = Number(patch.dropboxTokenExpiresAt) || 0;
          if (patch.dropboxConnected != null) prefs.dropboxConnected = !!patch.dropboxConnected;
          try { pushGlobalPrefs(); } catch (err) { /* ignore */ }
        },
        clear: () => {
          prefs.dropboxRefreshToken = '';
          prefs.dropboxAccessToken = '';
          prefs.dropboxTokenExpiresAt = 0;
          prefs.dropboxConnected = false;
          try { pushGlobalPrefs(); } catch (err) { /* ignore */ }
        },
      });
      try {
        if (Cloud.migratePlaintextDropboxTokens?.(prefs)) {
          pushGlobalPrefs();
        }
      } catch (err) { /* ignore */ }
    }
  }

  function isGoogleDriveConnected(Cloud = window.NotesCloudBackup) {
    try {
      return !!(Cloud?.readPrefs?.()?.driveConnected);
    } catch (err) {
      return false;
    }
  }

  function isDropboxConnected(Cloud = window.NotesCloudBackup) {
    try {
      return !!(Cloud?.readPrefs?.()?.dropboxConnected);
    } catch (err) {
      return false;
    }
  }

  function refreshGoogleDriveBackupUi() {
    const Cloud = window.NotesCloudBackup;
    syncCloudProviderKeysFromPrefs();
    const status = document.getElementById('google-drive-status');
    const controls = document.getElementById('google-drive-controls');
    const missing = document.getElementById('google-drive-not-configured');
    const driveBtn = document.getElementById('btn-backup-google-drive');
    const autoDaily = document.getElementById('backup-drive-auto-daily');
    const keyInput = document.getElementById('google-oauth-client-id-input');
    const keyStatus = document.getElementById('google-key-status');
    const keyConfigured = document.getElementById('google-key-configured');
    const keyRemove = document.getElementById('btn-google-key-remove');
    const configured = !!(Cloud && Cloud.isGoogleConfigured && Cloud.isGoogleConfigured());
    const connected = configured && isGoogleDriveConnected(Cloud);
    const source = Cloud?.googleKeySource?.() || '';
    const hasUserKey = !!String(prefs.googleOauthClientId || '').trim();
    if (keyInput && document.activeElement !== keyInput) {
      keyInput.value = String(prefs.googleOauthClientId || '');
    }
    if (keyConfigured) keyConfigured.hidden = !hasUserKey;
    if (keyRemove) keyRemove.hidden = !hasUserKey;
    if (keyStatus) {
      if (hasUserKey) {
        keyStatus.textContent = 'Using your Google Client ID (synced in your vault).';
      } else if (source === 'server') {
        keyStatus.textContent = 'Using this server’s Google Client ID. You can still add your own below.';
      } else {
        keyStatus.textContent = '';
      }
    }
    if (missing) {
      missing.hidden = configured;
      if (!configured) {
        missing.textContent = 'Google Drive: Not set up yet — add your own key';
      }
    }
    if (driveBtn) {
      driveBtn.disabled = !configured;
      driveBtn.title = configured ? '' : 'Not set up yet';
      driveBtn.textContent = connected ? 'Back up to Google Drive' : 'Connect Google Drive';
    }
    // Disconnect / list / auto-daily only after a successful OAuth token.
    if (controls) controls.hidden = !connected;
    if (!configured) {
      if (status) {
        status.hidden = true;
        status.textContent = '';
      }
      return;
    }
    if (!Cloud) return;
    const cloudPrefs = Cloud.readPrefs();
    if (autoDaily) autoDaily.checked = !!cloudPrefs.autoDailyDrive;
    if (status) {
      status.hidden = false;
      const account = cloudPrefs.driveAccountLabel ? `Connected as ${cloudPrefs.driveAccountLabel}. ` : '';
      if (!connected) {
        status.textContent = 'Google Drive uses a short-lived browser token (drive.file). Connect to authorize this browser.';
      } else if (cloudPrefs.lastDriveBackupAt) {
        const when = new Date(cloudPrefs.lastDriveBackupAt);
        status.textContent = `${account}Last Google Drive backup: ${Number.isNaN(when.getTime()) ? cloudPrefs.lastDriveBackupAt : when.toLocaleString()}`;
      } else {
        status.textContent = `${account}Google Drive connected — no backup uploaded yet.`;
      }
    }
  }

  function mapGoogleAuthError(err) {
    const raw = String(err?.message || err || '');
    if (/popup/i.test(raw) && /block|failed.?to.?open/i.test(raw)) {
      return 'Popup was blocked — allow popups for deeperguard.com.';
    }
    if (/popup.*closed|window closed/i.test(raw)) {
      return 'Google sign-in didn’t complete. Check your Client ID and try again.';
    }
    if (/invalid|unknown.?client|not configured/i.test(raw)) {
      return 'Google sign-in didn’t complete. Check your Client ID and try again.';
    }
    if (/didn’t complete|did not complete|sign-in/i.test(raw)) {
      return raw.includes('Client ID')
        ? raw
        : 'Google sign-in didn’t complete. Check your Client ID and try again.';
    }
    return raw || 'Google sign-in didn’t complete. Check your Client ID and try again.';
  }

  async function connectGoogleDrive() {
    const Cloud = window.NotesCloudBackup;
    syncCloudProviderKeysFromPrefs();
    if (!Cloud?.isGoogleConfigured?.()) {
      toast('Google Drive is not set up yet — add your own Client ID', true);
      return;
    }
    setGoogleKeyError('');
    try {
      await Cloud.requestAccessToken({ prompt: '' });
      refreshGoogleDriveBackupUi();
      toast('Google Drive connected');
    } catch (err) {
      try { await Cloud.disconnectGoogle?.(); } catch (e) { /* ignore */ }
      const msg = mapGoogleAuthError(err);
      setGoogleKeyError(msg);
      refreshGoogleDriveBackupUi();
      const wrapped = new Error(msg);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  async function runGoogleDriveBackup() {
    const Cloud = window.NotesCloudBackup;
    syncCloudProviderKeysFromPrefs();
    if (!Cloud?.isGoogleConfigured?.()) {
      toast('Google Drive is not set up yet — add your own Client ID', true);
      return;
    }
    if (!isGoogleDriveConnected(Cloud)) {
      await connectGoogleDrive();
      return;
    }
    await runFileDownloadTask({
      title: 'Google Drive backup',
      prepareLabel: 'Preparing encrypted backup…',
      run: async (report) => {
        const { blob, filename } = await prepareEncryptedBackupBlob(report);
        report({ status: 'Signing in to Google…', pct: 94, indeterminate: true });
        await Cloud.requestAccessToken({ prompt: '' });
        report({ status: 'Uploading encrypted backup…', pct: 96, indeterminate: true });
        const file = await Cloud.uploadBackupBlob(blob, { filename });
        report({ status: 'Uploaded', pct: 100, indeterminate: false });
        return file;
      },
    });
    refreshGoogleDriveBackupUi();
    toast('Encrypted backup uploaded to Google Drive');
  }

  document.getElementById('btn-backup-google-drive')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-backup-google-drive');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    setRestoreResultStatus('');
    try {
      if (!isGoogleDriveConnected()) await connectGoogleDrive();
      else await runGoogleDriveBackup();
    } catch (err) {
      const msg = mapGoogleAuthError(err);
      setGoogleKeyError(msg);
      toast(msg, true);
    } finally {
      if (btn) btn.disabled = !window.NotesCloudBackup?.isGoogleConfigured?.();
      refreshGoogleDriveBackupUi();
    }
  });

  function setGoogleKeyError(message) {
    const el = document.getElementById('google-key-error');
    if (!el) return;
    if (message) {
      el.hidden = false;
      el.textContent = message;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function setDropboxKeyError(message) {
    const el = document.getElementById('dropbox-key-error');
    if (!el) return;
    if (message) {
      el.hidden = false;
      el.textContent = message;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  document.getElementById('btn-google-key-save')?.addEventListener('click', async () => {
    const Cloud = window.NotesCloudBackup;
    const input = document.getElementById('google-oauth-client-id-input');
    const raw = String(input?.value || '').trim();
    setGoogleKeyError('');
    if (!Cloud?.isValidGoogleClientId) {
      const msg = 'Cloud backup module failed to load. Refresh the page and try again.';
      setGoogleKeyError(msg);
      toast(msg, true);
      return;
    }
    if (!Cloud.isValidGoogleClientId(raw)) {
      const msg = 'Google Client ID must end with .apps.googleusercontent.com';
      setGoogleKeyError(msg);
      toast(msg, true);
      return;
    }
    settingsKeySaveDepth += 1;
    try {
      const prev = String(prefs.googleOauthClientId || '').trim();
      if (raw !== prev) {
        // Clear local Drive tokens only — GIS revoke can steal focus and trip
        // lock-on-unfocus, which must never lock the vault while saving a key.
        try {
          Cloud.writePrefs?.({
            driveConnected: false,
            driveFolderId: '',
            lastDriveFileId: '',
            driveAccountLabel: '',
          });
        } catch (err) { /* ignore */ }
      }
      prefs.googleOauthClientId = raw;
      pushGlobalPrefs();
      syncCloudProviderKeysFromPrefs();
      refreshGoogleDriveBackupUi();
      toast('Google Client ID saved');
    } finally {
      settingsKeySaveDepth = Math.max(0, settingsKeySaveDepth - 1);
    }
  });

  document.getElementById('btn-google-key-remove')?.addEventListener('click', async () => {
    const Cloud = window.NotesCloudBackup;
    setGoogleKeyError('');
    settingsKeySaveDepth += 1;
    try {
      try {
        Cloud?.writePrefs?.({
          driveConnected: false,
          driveFolderId: '',
          lastDriveFileId: '',
          driveAccountLabel: '',
        });
      } catch (err) { /* ignore */ }
      prefs.googleOauthClientId = '';
      const input = document.getElementById('google-oauth-client-id-input');
      if (input) input.value = '';
      pushGlobalPrefs();
      syncCloudProviderKeysFromPrefs();
      refreshGoogleDriveBackupUi();
      toast('Google Client ID removed');
    } finally {
      settingsKeySaveDepth = Math.max(0, settingsKeySaveDepth - 1);
    }
  });

  document.getElementById('backup-drive-auto-daily')?.addEventListener('change', (event) => {
    window.NotesCloudBackup?.setAutoDailyDrive?.(!!event.target.checked);
    refreshGoogleDriveBackupUi();
  });

  document.getElementById('btn-drive-disconnect')?.addEventListener('click', async () => {
    try {
      await window.NotesCloudBackup?.disconnectGoogle?.();
      const list = document.getElementById('google-drive-backup-list');
      if (list) {
        list.hidden = true;
        list.innerHTML = '';
      }
      refreshGoogleDriveBackupUi();
      toast('Google Drive disconnected');
    } catch (err) {
      toast(err.message || 'Could not disconnect', true);
    }
  });

  document.getElementById('btn-drive-list')?.addEventListener('click', async () => {
    const list = document.getElementById('google-drive-backup-list');
    const Cloud = window.NotesCloudBackup;
    if (!list || !Cloud) return;
    try {
      list.hidden = false;
      list.innerHTML = '<li>Loading…</li>';
      await Cloud.requestAccessToken({ prompt: '' });
      const files = await Cloud.listDriveBackups({ limit: 8 });
      if (!files.length) {
        list.innerHTML = '<li>No backups in Deeperguard Backups yet.</li>';
        return;
      }
      list.innerHTML = '';
      for (const file of files) {
        const li = document.createElement('li');
        const when = file.modifiedTime || file.createdTime || '';
        li.textContent = `${file.name || 'backup'} · ${when ? new Date(when).toLocaleString() : ''}`;
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'btn ghost sm';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', async () => {
          try {
            const ok = await confirmRestoreBackupChoice();
            if (!ok) return;
            const resetFreshness = await confirmIntentionalFreshnessReset();
            if (!resetFreshness) return;
            setRestoreResultStatus('');
            toast('Downloading backup…');
            const text = await Cloud.downloadDriveBackup(file.id);
            const result = await NotesStore.importBackup(text, ok.merge, { resetFreshness: true });
            renderTags();
            renderNotes();
            showRestoreResult(result);
          } catch (err) {
            toast(err.message || 'Restore failed', true);
          }
        });
        li.appendChild(document.createTextNode(' '));
        li.appendChild(restoreBtn);
        list.appendChild(li);
      }
    } catch (err) {
      list.innerHTML = '';
      list.hidden = true;
      toast(err.message || 'Could not list Drive backups', true);
    }
  });

  function refreshDropboxBackupUi() {
    const Cloud = window.NotesCloudBackup;
    syncCloudProviderKeysFromPrefs();
    const status = document.getElementById('dropbox-status');
    const controls = document.getElementById('dropbox-controls');
    const missing = document.getElementById('dropbox-not-configured');
    const dropboxBtn = document.getElementById('btn-backup-dropbox');
    const autoDaily = document.getElementById('backup-dropbox-auto-daily');
    const keyInput = document.getElementById('dropbox-app-key-input');
    const keyStatus = document.getElementById('dropbox-key-status');
    const keyConfigured = document.getElementById('dropbox-key-configured');
    const keyRemove = document.getElementById('btn-dropbox-key-remove');
    const configured = !!(Cloud && Cloud.isDropboxConfigured && Cloud.isDropboxConfigured());
    const connected = configured && isDropboxConnected(Cloud);
    const source = Cloud?.dropboxKeySource?.() || '';
    const hasUserKey = !!String(prefs.dropboxAppKey || '').trim();
    if (keyInput && document.activeElement !== keyInput) {
      keyInput.value = String(prefs.dropboxAppKey || '');
    }
    if (keyConfigured) keyConfigured.hidden = !hasUserKey;
    if (keyRemove) keyRemove.hidden = !hasUserKey;
    if (keyStatus) {
      if (hasUserKey) {
        keyStatus.textContent = 'Using your Dropbox App key (synced in your vault).';
      } else if (source === 'server') {
        keyStatus.textContent = 'Using this server’s Dropbox App key. You can still add your own below.';
      } else {
        keyStatus.textContent = '';
      }
    }
    if (missing) {
      missing.hidden = configured;
      if (!configured) {
        missing.textContent = 'Dropbox: Not set up yet — add your own key';
      }
    }
    if (dropboxBtn) {
      dropboxBtn.disabled = !configured;
      dropboxBtn.title = configured ? '' : 'Not set up yet';
      dropboxBtn.textContent = connected ? 'Back up to Dropbox' : 'Connect Dropbox';
    }
    // Disconnect / list / auto-daily only after a successful OAuth token.
    if (controls) controls.hidden = !connected;
    if (!configured) {
      if (status) {
        status.hidden = true;
        status.textContent = '';
      }
      return;
    }
    if (!Cloud) return;
    const cloudPrefs = Cloud.readPrefs();
    if (autoDaily) autoDaily.checked = !!cloudPrefs.autoDailyDropbox;
    if (status) {
      status.hidden = false;
      const account = cloudPrefs.dropboxAccountLabel ? `Connected as ${cloudPrefs.dropboxAccountLabel}. ` : '';
      if (!connected) {
        status.textContent = 'Dropbox uses OAuth 2 PKCE in the browser (App folder). Connect to authorize this browser.';
      } else if (cloudPrefs.lastDropboxBackupAt) {
        const when = new Date(cloudPrefs.lastDropboxBackupAt);
        status.textContent = `${account}Last Dropbox backup: ${Number.isNaN(when.getTime()) ? cloudPrefs.lastDropboxBackupAt : when.toLocaleString()}`;
      } else {
        status.textContent = `${account}Dropbox connected — no backup uploaded yet.`;
      }
    }
  }

  function mapDropboxAuthError(err) {
    const raw = String(err?.message || err || '');
    if (/popup/i.test(raw) && /block/i.test(raw)) {
      return 'Popup was blocked — allow popups for deeperguard.com.';
    }
    if (/cancel/i.test(raw)) {
      return 'Dropbox sign-in didn’t complete. Check your App key and try again.';
    }
    if (/invalid|unknown.?client|not configured|10–25|10-25/i.test(raw)) {
      return 'Dropbox sign-in didn’t complete. Check your App key and try again.';
    }
    if (/didn’t complete|did not complete|sign-in/i.test(raw)) {
      return 'Dropbox sign-in didn’t complete. Check your App key and try again.';
    }
    return raw || 'Dropbox sign-in didn’t complete. Check your App key and try again.';
  }

  async function connectDropbox() {
    const Cloud = window.NotesCloudBackup;
    syncCloudProviderKeysFromPrefs();
    if (!Cloud?.isDropboxConfigured?.()) {
      toast('Dropbox is not set up yet — add your own App key', true);
      return;
    }
    setDropboxKeyError('');
    try {
      await Cloud.beginDropboxOAuth({ pending: 'connect' });
      const token = await Cloud.ensureDropboxToken({ interactive: false });
      if (!token) throw new Error('Dropbox sign-in did not complete');
      refreshDropboxBackupUi();
      toast('Dropbox connected');
    } catch (err) {
      try { await Cloud.disconnectDropbox?.(); } catch (e) { /* ignore */ }
      const msg = mapDropboxAuthError(err);
      setDropboxKeyError(msg);
      refreshDropboxBackupUi();
      const wrapped = new Error(msg);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  async function runDropboxBackup() {
    const Cloud = window.NotesCloudBackup;
    syncCloudProviderKeysFromPrefs();
    if (!Cloud?.isDropboxConfigured?.()) {
      toast('Dropbox is not set up yet — add your own App key', true);
      return;
    }
    if (!isDropboxConnected(Cloud)) {
      await connectDropbox();
      return;
    }
    let token = await Cloud.ensureDropboxToken({ interactive: false });
    if (!token) {
      // Token expired — re-auth via popup, then upload.
      await Cloud.beginDropboxOAuth({ pending: 'backup' });
      token = await Cloud.ensureDropboxToken({ interactive: false });
      if (!token) throw new Error('Dropbox sign-in did not complete');
    }
    await runFileDownloadTask({
      title: 'Dropbox backup',
      prepareLabel: 'Preparing encrypted backup…',
      run: async (report) => {
        const { blob, filename } = await prepareEncryptedBackupBlob(report);
        report({ status: 'Uploading encrypted backup…', pct: 96, indeterminate: true });
        const file = await Cloud.uploadDropboxBackupBlob(blob, { filename });
        report({ status: 'Uploaded', pct: 100, indeterminate: false });
        return file;
      },
    });
    refreshDropboxBackupUi();
    toast('Encrypted backup uploaded to Dropbox');
  }

  document.getElementById('btn-backup-dropbox')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-backup-dropbox');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    setRestoreResultStatus('');
    try {
      if (!isDropboxConnected()) await connectDropbox();
      else await runDropboxBackup();
    } catch (err) {
      const msg = mapDropboxAuthError(err);
      setDropboxKeyError(msg);
      toast(msg, true);
    } finally {
      if (btn) btn.disabled = !window.NotesCloudBackup?.isDropboxConfigured?.();
      refreshDropboxBackupUi();
    }
  });

  document.getElementById('btn-dropbox-key-save')?.addEventListener('click', async () => {
    const Cloud = window.NotesCloudBackup;
    const input = document.getElementById('dropbox-app-key-input');
    const raw = String(input?.value || '').trim();
    setDropboxKeyError('');
    if (!Cloud?.isValidDropboxAppKey) {
      const msg = 'Cloud backup module failed to load. Refresh the page and try again.';
      setDropboxKeyError(msg);
      toast(msg, true);
      return;
    }
    if (!Cloud.isValidDropboxAppKey(raw)) {
      const msg = 'Dropbox App key should be 10–25 letters or digits';
      setDropboxKeyError(msg);
      toast(msg, true);
      return;
    }
    const prev = String(prefs.dropboxAppKey || '').trim();
    if (raw !== prev) {
      try { await Cloud.disconnectDropbox?.(); } catch (err) { /* ignore */ }
    }
    prefs.dropboxAppKey = raw;
    pushGlobalPrefs();
    syncCloudProviderKeysFromPrefs();
    refreshDropboxBackupUi();
    toast('Dropbox App key saved');
  });

  document.getElementById('btn-dropbox-key-remove')?.addEventListener('click', async () => {
    const Cloud = window.NotesCloudBackup;
    setDropboxKeyError('');
    try { await Cloud.disconnectDropbox?.(); } catch (err) { /* ignore */ }
    prefs.dropboxAppKey = '';
    const input = document.getElementById('dropbox-app-key-input');
    if (input) input.value = '';
    pushGlobalPrefs();
    syncCloudProviderKeysFromPrefs();
    refreshDropboxBackupUi();
    toast('Dropbox App key removed');
  });

  document.getElementById('backup-dropbox-auto-daily')?.addEventListener('change', (event) => {
    window.NotesCloudBackup?.setAutoDailyDropbox?.(!!event.target.checked);
    refreshDropboxBackupUi();
  });

  document.getElementById('btn-dropbox-disconnect')?.addEventListener('click', async () => {
    try {
      await window.NotesCloudBackup?.disconnectDropbox?.();
      const list = document.getElementById('dropbox-backup-list');
      if (list) {
        list.hidden = true;
        list.innerHTML = '';
      }
      refreshDropboxBackupUi();
      toast('Dropbox disconnected');
    } catch (err) {
      toast(err.message || 'Could not disconnect', true);
    }
  });

  document.getElementById('btn-dropbox-list')?.addEventListener('click', async () => {
    const list = document.getElementById('dropbox-backup-list');
    const Cloud = window.NotesCloudBackup;
    if (!list || !Cloud) return;
    try {
      let token = await Cloud.ensureDropboxToken({ interactive: false });
      if (!token) {
        await Cloud.beginDropboxOAuth({ pending: 'list' });
        token = await Cloud.ensureDropboxToken({ interactive: false });
        if (!token) throw new Error('Dropbox sign-in did not complete');
      }
      list.hidden = false;
      list.innerHTML = '<li>Loading…</li>';
      const files = await Cloud.listDropboxBackups({ limit: 8 });
      if (!files.length) {
        list.innerHTML = '<li>No backups in Apps/Deeperguard yet.</li>';
        return;
      }
      list.innerHTML = '';
      for (const file of files) {
        const li = document.createElement('li');
        const when = file.server_modified || file.client_modified || '';
        li.textContent = `${file.name || 'backup'} · ${when ? new Date(when).toLocaleString() : ''}`;
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'btn ghost sm';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', async () => {
          try {
            const ok = await confirmRestoreBackupChoice();
            if (!ok) return;
            const resetFreshness = await confirmIntentionalFreshnessReset();
            if (!resetFreshness) return;
            setRestoreResultStatus('');
            toast('Downloading backup…');
            const path = file.path_display || file.path_lower || `/${file.name}`;
            const text = await Cloud.downloadDropboxBackup(path);
            const result = await NotesStore.importBackup(text, ok.merge, { resetFreshness: true });
            renderTags();
            renderNotes();
            showRestoreResult(result);
          } catch (err) {
            toast(err.message || 'Restore failed', true);
          }
        });
        li.appendChild(document.createTextNode(' '));
        li.appendChild(restoreBtn);
        list.appendChild(li);
      }
    } catch (err) {
      list.innerHTML = '';
      list.hidden = true;
      const msg = mapDropboxAuthError(err);
      setDropboxKeyError(msg);
      try { await Cloud.disconnectDropbox?.(); } catch (e) { /* ignore */ }
      refreshDropboxBackupUi();
      toast(msg, true);
    }
  });

  async function confirmRestoreBackupChoice() {
    const choice = await confirmAction(
      'Merge: add new items and update changed ones. Add missing only: only add items you don\'t have; never changes existing notes.',
      {
        title: 'Restore from backup',
        confirmLabel: 'Merge',
        extraLabel: 'Add missing only',
        cancelLabel: 'Cancel',
        danger: false,
      },
    );
    if (choice === true) return { merge: true };
    if (choice === 'extra') return { merge: false };
    return null;
  }

  async function confirmIntentionalFreshnessReset() {
    return confirmAction(
      'Restoring an older backup on purpose will reset this device’s sync high-water marks so older item versions are accepted. Continue only if you intend to roll the vault back.',
      {
        title: 'Reset sync freshness?',
        confirmLabel: 'Reset and restore',
        cancelLabel: 'Cancel',
        danger: true,
      },
    );
  }

  document.getElementById('restore-backup-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const choice = await confirmRestoreBackupChoice();
      if (!choice) return;
      const resetFreshness = await confirmIntentionalFreshnessReset();
      if (!resetFreshness) return;
      setRestoreResultStatus('');
      toast('Restoring…');
      const opened = await NotesSnImport.openBackupFile(file);
      let result;
      if (opened.kind === 'files-only') {
        result = await NotesStore.importLooseSnFiles(opened.blobs);
        result.imported = 0;
        result.tags = 0;
      } else {
        result = await NotesStore.importBackup(opened.text, choice.merge, {
          blobs: opened.blobs,
          resetFreshness: true,
        });
      }
      renderTags();
      renderNotes();
      if (currentId) {
        renderAttachments(currentId);
        applyEditorMode();
      }
      await enqueueImportedAttachmentOcr(result.attachmentIds);
      showRestoreResult(result);
    } catch (err) {
      toast(err.message || 'Restore failed', true);
    }
  });

  function maybeAutoGoogleDriveBackup() {
    const Cloud = window.NotesCloudBackup;
    if (!Cloud?.isGoogleConfigured?.() || !Cloud.dueForDailyDriveBackup?.()) return;
    if (!networkReachable || !NotesStore.isUnlocked?.()) return;
    runGoogleDriveBackup().catch((err) => {
      console.warn('auto Google Drive backup skipped', err);
    });
  }

  function maybeAutoDropboxBackup() {
    const Cloud = window.NotesCloudBackup;
    if (!Cloud?.isDropboxConfigured?.() || !Cloud.dueForDailyDropboxBackup?.()) return;
    if (!networkReachable || !NotesStore.isUnlocked?.()) return;
    runDropboxBackup().catch((err) => {
      console.warn('auto Dropbox backup skipped', err);
    });
  }

  async function finishDropboxOAuthIfPresent() {
    const Cloud = window.NotesCloudBackup;
    if (!Cloud?.consumeDropboxOAuthRedirect || !Cloud.peekDropboxOAuthParams?.()) return;
    try {
      const result = await Cloud.consumeDropboxOAuthRedirect();
      if (!result?.ok) return;
      refreshDropboxBackupUi();
      toast('Dropbox connected');
      if (result.pending === 'backup') {
        await runDropboxBackup();
      } else if (result.pending === 'list') {
        document.getElementById('btn-dropbox-list')?.click();
      }
    } catch (err) {
      toast(err.message || 'Dropbox sign-in failed', true);
      refreshDropboxBackupUi();
    }
  }

  function setRestoreResultStatus(message) {
    const el = document.getElementById('restore-result-status');
    if (!el) return;
    if (message) {
      el.hidden = false;
      el.textContent = message;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function showRestoreResult(result) {
    const msg = importResultToast(result, { restore: true }) || 'Restore complete';
    setRestoreResultStatus(msg);
    toast(msg);
    return msg;
  }

  function importResultToast(result, { restore = false } = {}) {
    if (restore && result && (result.created != null || result.updated != null || result.unchanged != null || result.keptNewer != null)) {
      const created = Number(result.created) || 0;
      const updated = Number(result.updated) || 0;
      const unchanged = Number(result.unchanged) || 0;
      const keptNewer = Number(result.keptNewer) || 0;
      let msg = `Restore complete: ${created} new, ${updated} updated, ${unchanged} already up to date`;
      if (keptNewer) msg += `, ${keptNewer} kept newer local`;
      return msg;
    }
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
      const resetFreshness = await confirmIntentionalFreshnessReset();
      if (!resetFreshness) return;
      setRestoreResultStatus('');
      toast('Importing…');
      const opened = await NotesSnImport.openBackupFile(file);
      let result;
      if (opened.kind === 'files-only') {
        result = await NotesStore.importLooseSnFiles(opened.blobs);
        result.imported = 0;
        result.tags = 0;
      } else {
        result = await NotesStore.importBackup(opened.text, true, {
          blobs: opened.blobs,
          resetFreshness: true,
        });
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

  async function buildLocalBackup(report) {
    const account = await NotesStore.loadAccount();
    const rows = [];
    const all = [...NotesStore.state.items.values()].filter((i) => !i.deleted);
    const total = all.length || 1;
    let done = 0;
    for (const item of all) {
      // Prefer the already-persisted ciphertext/hash so a round-trip restore
      // matches content_hash without treating identical items as updated.
      let ciphertext = '';
      let contentHash = '';
      try {
        const stored = typeof NotesIDB !== 'undefined' && NotesIDB.getItem
          ? await NotesIDB.getItem(item.uuid)
          : null;
        if (stored?.ciphertext && !stored.deleted) {
          ciphertext = stored.ciphertext;
          contentHash = stored.content_hash || await NotesCrypto.hashText(ciphertext);
        }
      } catch (err) { /* fall through to fresh encrypt */ }
      if (!ciphertext) {
        const wrapped = await NotesCrypto.encryptObject(NotesStore.state.cryptoKey, item.content);
        ciphertext = JSON.stringify(wrapped);
        contentHash = item.content_hash || await NotesCrypto.hashText(ciphertext);
      }
      rows.push({
        item_uuid: item.uuid,
        content_version: 1,
        ciphertext,
        content_hash: contentHash,
        deleted: false,
        updated_at: item.updated_at,
      });
      done += 1;
      if (report && (done === 1 || done === total || done % 3 === 0)) {
        const pct = Math.max(8, Math.min(92, Math.round((done / total) * 90)));
        report({
          status: `Encrypting item ${done} of ${total}…`,
          pct,
          indeterminate: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
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
    // Prefer content-hashed filenames; also accept legacy ?v= cache-busters.
    const assetRe = /(?:href|src)="(\/static\/[^"]+\.(?:css|js|mjs)(?:\?[^"]*)?)"/g;
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

  async function cachedShellBuild() {
    if (!window.isSecureContext || typeof caches === 'undefined') return '';
    try {
      const shell = await caches.open('deeperguard-shell');
      const cached = await shell.match('/app');
      if (!cached) return '';
      const header = cached.headers.get('X-Notes-Build');
      if (header) return String(header);
      return buildFromHtml(await cached.clone().text());
    } catch (err) {
      return '';
    }
  }

  async function persistAppShell() {
    if (!window.isSecureContext || typeof caches === 'undefined') return;
    const build = document.querySelector('meta[name="notes-build"]')?.content || '';
    try {
      const data = await fetchHealthJson();
      if (data?.build && build && String(data.build) !== build) {
        preseedLatestShell(String(data.build)).catch(() => {});
        return;
      }
    } catch (err) {
      /* offline — cache the shell we have for unlock */
    }
    // A background refresh may already have stored the next build. Writing this
    // page back would pin the bundle the phone is still running.
    const cachedBuild = await cachedShellBuild();
    if (cachedBuild && build && cachedBuild !== build) return;
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
      try { window.__notesResetHealthBackoff?.(); } catch (err) { /* ignore */ }
      const data = await fetchHealthJson({ force: true, timeoutMs: 3000 });
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
      const data = await fetchHealthJson() || {};
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
        const neutralLock = message === 'Vault locked.' || /^Locked after\b/.test(message);
        unlockError.classList.toggle('error', !neutralLock);
        unlockError.classList.toggle('unlock-notice', neutralLock);
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
    if (sessionExpiredHold) {
      showExpiredSessionBanner();
      return Promise.resolve(false);
    }
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
          // Header "Syncing…" only for routine checks; full/long pulls arm a compact overlay.
          if (full || vaultPullActive) {
            armDelayedSyncProgressBanner({
              text: 'Downloading notes…',
              message: 'Downloading notes…',
            });
          }
          armVaultDownloadTimeout();
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
      const dirtyCount = NotesStore.state?.dirty?.size || 0;
      if (!force && dirtyCount === 0 && quiet && !full && lastAt && Date.now() - lastAt < 90000) {
        NotesStore.logSync?.('sync-skip', {
          quiet: true,
          reason: 'recent',
          lastSync: Number(NotesStore.state.lastSync) || 0,
          ageSec: Math.round((Date.now() - lastAt) / 1000),
        });
        return;
      }
      if (isVaultReadyForSync()) setBusy(true);
      if (!quiet && isVaultReadyForSync()) {
        // Routine sync / "Checking for changes…" → header indicator only.
        // Initial/full downloads arm a delayed compact overlay (see beginVaultPull).
        syncProgressStartedAt = Date.now();
        if (full) {
          armDelayedSyncProgressBanner({
            text: 'Downloading notes…',
            message: 'Downloading notes…',
          });
        }
        armVaultDownloadTimeout();
      }
      syncInFlight = NotesStore.loadAccount()
        .then(async (account) => {
          if (account && typeof account === 'object') renderPlanUi(account);
          if (await checkRemoteVaultPasswordChange(account)) return false;
          return account;
        })
        .catch((err) => {
          if (isLoginRequiredError(err)) {
            showExpiredSessionBanner();
            return false;
          }
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
          if (synced === false) return false;
          markNetworkReachable();
          pullGlobalPrefs();
          const noteCount = listedActiveNoteCount();
          if (noteCount > 0) clearVaultSyncError();
          vaultDownloadStalled = false;
          showSyncBanner('ready');
          if (!quiet) {
            refreshAllNoteSearchIndexes();
            renderTags();
            renderNotes();
            renderVaultStats();
            updateEmptyStateVisibility();
            if (noteCount) {
              toast(`Synced · ${noteCount} active note${noteCount === 1 ? '' : 's'}`);
            } else if (vaultSyncError) {
              toast('Synced · server returned no notes for this password', true);
            }
          } else if (noteCount > 0) {
            lastNotesRenderKey = '';
            renderNotes();
            updateEmptyStateVisibility();
          }
          refreshTotpVault({ migrate: true });
          if (!currentId) openPendingDeepLink({ final: true });
          reconcileReminderSideEffects();
          // Round 72: resolve true so online-recovery can tell success from abort.
          return true;
        })
        .catch((err) => {
          if (err?.code === 'VAULT_LOCKED') {
            NotesStore.logSync?.('sync-aborted', { reason: 'locked', quiet: !!quiet });
            return false;
          }
          if (err?.code === 'aborted') {
            NotesStore.logSync?.('sync-aborted', { reason: err.reason || 'aborted', quiet: !!quiet });
            return false;
          }
          if (isLoginRequiredError(err)) {
            showExpiredSessionBanner();
            return false;
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
            updateNetworkStatusBanner();
            startOfflineWatch();
            if (!quiet) toast(OFFLINE_LAN_HINT, true);
          } else if (quiet) {
            // Background / online-recovery: never flash "Failed to fetch" mid-retry.
            console.warn('quiet sync failed', err);
          } else {
            vaultDownloadStalled = true;
            showSyncBanner('error', err?.message || 'Sync failed');
            toast(err?.message || 'Sync failed', true);
          }
          return false;
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
    if (sessionExpiredHold) return;
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
    if ((NotesStore.state?.dirty?.size || 0) > 0) {
      changePollInFlight = true;
      try {
        await syncNow({ quiet: true, force: true });
      } finally {
        changePollInFlight = false;
      }
      return;
    }
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
      if (isLoginRequiredError(err)) showExpiredSessionBanner();
    } finally {
      changePollInFlight = false;
    }
  }

  function scheduleChangePoll({ background = false } = {}) {
    if (sessionExpiredHold) {
      stopChangePoll();
      return;
    }
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
    // Online recovery owns health probes + sync. Foreground-on-online only does
    // session bookkeeping so we don't abort a fresh probe mid-flight.
    if (reason === 'online') {
      scheduleNetworkProbe();
      if (!vaultReady || ignoreNextForeground) return;
      if (NotesStore.isUnlocked()) {
        NotesStore.loadAccount()
          .then((account) => checkRemoteVaultPasswordChange(account))
          .catch((err) => {
            if (isLoginRequiredError(err)) showExpiredSessionBanner();
          });
        setTimeout(() => {
          maybeAutoGoogleDriveBackup();
          maybeAutoDropboxBackup();
        }, 4000);
      }
      if (!sessionExpiredHold) scheduleChangePoll();
      ensureServerSession().catch(() => {});
      return;
    }
    probeNetwork({ syncOnRecovery: true }).catch(() => {});
    scheduleNetworkProbe();
    if (!vaultReady || ignoreNextForeground) return;
    if (NotesStore.isUnlocked()) {
      NotesStore.loadAccount()
        .then((account) => checkRemoteVaultPasswordChange(account))
        .catch((err) => {
          if (isLoginRequiredError(err)) showExpiredSessionBanner();
        });
    }
    // Skip heavy work while the user is typing in search or any field.
    if (iosTune()?.isTypingInField?.()) {
      probeNetwork({ syncOnRecovery: false }).catch(() => {});
      return;
    }
    // Coming back to the app must always check the server — the "synced
    // recently" throttle made the iOS PWA show stale notes after switching devices.
    // Indexing waits until that sync lands so a file already read on another
    // device is not read again here (that second pass was crashing the PWA).
    const synced = syncNow({ quiet: true, force: true });
    if (!sessionExpiredHold) scheduleChangePoll();
    ensureServerSession().catch(() => {});
    Promise.resolve(synced).finally(() => {
      if (iosTune()?.isTypingInField?.()) return;
      if (IS_IOS) runPostUnlockHeavyWork();
      else resumePendingOcr();
      if (currentId) pullNoteOcrFromServer(currentId).catch(() => {});
    });
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
    stopOnlineRecovery('pagehide');
    stopEmptyDeviceBackgroundRetry();
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
  function onNetworkOnline(source = 'online') {
    try {
      console.debug('[notes-sync]', new Date().toISOString(), 'online-event', {
        source,
        navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : null,
      });
    } catch (err) { /* ignore */ }
    // Single recovery owner: reset backoff, probe, sync (Retry + online + watch).
    stopOfflineWatch();
    scheduleOnlineRecovery(0);
    onAppForeground('online');
  }
  window.addEventListener('online', () => onNetworkOnline('online'));
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && typeof conn.addEventListener === 'function') {
      conn.addEventListener('change', () => {
        // DevTools Offline toggles often fire connection 'change' with
        // navigator.onLine still true while going offline. Only recover after
        // a quick health probe succeeds — never sync on the offline transition.
        if (typeof navigator === 'undefined' || !navigator.onLine) return;
        if (networkReachable) return;
        // Respect the shared backoff gate — do not reset here (that caused
        // burst /api/health while DevTools Offline left onLine true).
        probeNetwork({ syncOnRecovery: false, forceHealth: true }).then((ok) => {
          if (!ok || !navigator.onLine) return;
          onNetworkOnline('connection-change');
        }).catch(() => {});
      });
    }
  } catch (err) { /* ignore */ }
  window.addEventListener('offline', () => {
    networkReachable = false;
    NotesStore.emitSync('offline', 'Offline');
    updateNetworkStatusBanner();
    // Round 72.1: hand recovery back to the offline watch.
    stopOnlineRecovery('offline');
    // Cancel hung API work so it does not sit for 8s → "Request timed out".
    // Do not start sync or force a health probe on the offline transition.
    NotesStore.abortInflightApi?.('offline');
    offlineWatchDelayMs = 2000;
    startOfflineWatch();
  });
  // Block accidental native form submits (iOS autofill / password managers).
  // preventDefault only — do not stopPropagation or unlock/login handlers never run.
  document.addEventListener('submit', (event) => {
    event.preventDefault();
  }, true);

  async function reloadIfShellStale() {
    // Never auto-reload while offline — that re-locked the vault mid-edit.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (!networkReachable) return false;
    const pageBuild = document.querySelector('meta[name="notes-build"]')?.content || '';
    if (!pageBuild) return false;
    let serverBuild = '';
    try {
      const data = await fetchHealthJson();
      serverBuild = data && data.build ? String(data.build) : '';
    } catch (err) {
      return false;
    }
    if (!serverBuild || serverBuild === pageBuild) return false;
    let already = '';
    try { already = sessionStorage.getItem('notes_reloaded_build') || ''; } catch (err) { already = ''; }
    if (already === serverBuild) {
      applyServerBuildStatus(serverBuild);
      return false;
    }
    try { sessionStorage.setItem('notes_reloaded_build', serverBuild); } catch (err) { /* ignore */ }
    const appPath = location.pathname && location.pathname !== '/' ? location.pathname : '/app';
    location.replace(`${appPath}?t=${Date.now()}&nosync=1`);
    return true;
  }

  async function boot() {
    if (await reloadIfShellStale()) return;
    try {
      if (globalThis.NotesVerifyAskAiPin) NotesVerifyAskAiPin.start();
    } catch (err) { /* ignore */ }
    updateSecureContextHint();
    if (typeof NotesStore.setSessionRevokedHandler === 'function') {
      NotesStore.setSessionRevokedHandler(() => { wipeAfterRemoteSignOut(); });
    }
    startRemoteRevokeWatch();
    if (await checkAppUpdate()) return;
    try {
      const data = await fetchHealthJson();
      if (data && data.build) applyServerBuildStatus(String(data.build));
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
      if (typeof NotesStore.finishUnlockMaintenance === 'function') {
        await NotesStore.finishUnlockMaintenance();
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
    vaultReady = true;
    try {
      // Release-hash check is independent of unlock, but re-kick after unlock in
      // case the idle callback was deferred behind vault work / hung earlier.
      if (globalThis.NotesReleaseIntegrity) {
        NotesReleaseIntegrity.start();
      }
      if (globalThis.NotesVerifyAskAiPin) {
        NotesVerifyAskAiPin.start();
      }
    } catch (err) { /* ignore */ }
    initPullToSync();
    initEditorEdgeSwipeBack();
    initPaneSplitter();
    try { refreshGoogleDriveBackupUi(); } catch (err) { /* ignore */ }
    try { refreshDropboxBackupUi(); } catch (err) { /* ignore */ }
    finishDropboxOAuthIfPresent().catch(() => {});
    document.getElementById('btn-network-retry')?.addEventListener('click', () => {
      // Same path as the online event — reset backoff, probe, sync. A bare
      // probeNetwork() used to no-op inside the failure backoff gate.
      onNetworkOnline('retry');
    });
    document.addEventListener('focusin', () => scrollFocusedFieldIntoView(), true);
    try {
      consumeNoteDeepLink();
      if (!currentId) openRememberedNote();
    } catch (err) {
      /* stay on the list */
    }
    updateOfflineSetupBanner();
    updateDevicePhrasePrompt();
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
          if (NotesStore.listNotes().length === 0 && vaultSyncError) {
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
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        if (!ui.docViewer || ui.docViewer.hidden) return;
        const items = docViewerFocusables();
        if (!items.length) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !ui.docViewer.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !ui.docViewer.contains(active))) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      suppressToolbarTips();
      const stop = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const folderPrompt = document.getElementById('folder-prompt');
      if (folderPrompt && !folderPrompt.hidden) {
        closeFolderPrompt();
        stop();
        return;
      }
      const confirmDialog = document.getElementById('confirm-dialog');
      if (confirmDialog && !confirmDialog.hidden) return;
      if (ui.settings && !ui.settings.hidden) {
        closeSettings(true);
        stop();
        return;
      }
      const accountDialog = document.getElementById('account-info-dialog');
      if (accountDialog && !accountDialog.hidden) {
        closeAccountInfoDialog();
        stop();
        return;
      }
      const tagManage = document.getElementById('tag-manage-dialog');
      if (tagManage && !tagManage.hidden) {
        closeTagManage();
        stop();
        return;
      }
      const totpDialog = document.getElementById('totp-add-dialog');
      if (totpDialog && !totpDialog.hidden) {
        hideTotpAddDialog();
        stop();
        return;
      }
      const attachmentMenu = document.querySelector('details.attachment-overflow[open]');
      if (attachmentMenu) {
        attachmentMenu.open = false;
        attachmentMenu.querySelector('summary')?.focus();
        stop();
        return;
      }
      const scanDialog = document.getElementById('scan-dialog');
      if (scanDialog && !scanDialog.hidden) {
        hideScanDialog();
        stop();
        return;
      }
      if (ui.docViewer && !ui.docViewer.hidden) {
        closeDocPreview();
        stop();
        return;
      }
      const noteTypeMenu = document.getElementById('note-type-menu');
      if (noteTypeMenu && !noteTypeMenu.hidden) {
        setNoteTypeMenuOpen(false);
        stop();
        return;
      }
      const menuOpen = document.body.classList.contains('editor-toolbar-menu-open')
        || document.querySelector('.editor-toolbar-overflow-toggle[aria-expanded="true"]');
      if (menuOpen) {
        closeEditorToolbarMenu();
        stop();
        return;
      }
      const noteOptions = document.getElementById('note-options');
      if (noteOptions && !noteOptions.hidden) {
        closeNoteOptions();
        stop();
        return;
      }
      if (document.body.classList.contains('search-filters-open')) {
        setSearchFilterPanelOpen(false);
        stop();
        return;
      }
      if (closePhoneBrowseOverlay({ focusChip: true })) {
        stop();
        return;
      }
      if (document.body.classList.contains('nav-drawer-open')) {
        setNavDrawer(false);
        stop();
        return;
      }
      if (document.body.classList.contains('nav-views-open')) {
        setNavViewsOpen(false);
        stop();
        return;
      }
      const findBar = document.getElementById('find-bar');
      if (findBar && !findBar.hidden) {
        hideFindBar();
        stop();
        return;
      }
      const tagComposer = document.getElementById('tag-composer');
      if (tagComposer && !tagComposer.hidden) {
        hideTagComposer();
        stop();
        return;
      }
      const folderComposer = document.getElementById('folder-composer');
      if (folderComposer && !folderComposer.hidden) {
        hideFolderComposer();
        stop();
        return;
      }
      const tagInput = document.getElementById('tag-bar-input');
      if (tagInput && (document.activeElement === tagInput || String(tagInput.value || '').trim())) {
        tagInput.value = '';
        tagInput.blur();
        stop();
        return;
      }
      const tagShell = document.getElementById('tag-bar-shell');
      if (tagBarExpanded && tagShell && !tagShell.classList.contains('is-collapsed')) {
        tagBarExpanded = false;
        syncTagBarShell(currentId ? NotesStore.get(currentId) : null);
        document.getElementById('tag-bar-toggle')?.focus({ preventScroll: true });
        stop();
        return;
      }
      if (ui.search && (event.target === ui.search || document.activeElement === ui.search)) {
        if (String(ui.search.value || '')) clearSearch({ blur: false });
        else ui.search.blur();
        stop();
        return;
      }
      const openRow = ui.noteList?.querySelector('.note-row.open');
      if (openRow) {
        openRow.classList.remove('open');
        stop();
        return;
      }
      const editorOpen = !!(currentId || (ui.editor && !ui.editor.hidden));
      const filterSection = document.getElementById('filter-section');
      if (!editorOpen && filterSection?.open) {
        filterSection.open = false;
        stop();
        return;
      }
      // Escape does not dismiss the welcome empty state — use Dismiss.
      // Escape never closes the open note. Back still does.
    }, true);
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
      if (!typing(e.target) && e.key === '/' && !(e.metaKey || e.ctrlKey || e.altKey)) {
        e.preventDefault();
        ui.search?.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        ui.search?.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNote();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
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

  initPaneSplitter();
  boot();
})();
