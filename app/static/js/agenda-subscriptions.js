/*
 * Agenda feed subscriptions, direct fetch only (docs/ICS_SUBSCRIBE_SPEC.md).
 * - The feed link is kept only in the encrypted agenda pack (NotesStore). It is never
 *   logged, put in an error/toast text, a page URL, localStorage or sessionStorage.
 * - Fetching runs in js/ics-fetch-worker.js (own narrow CSP); parsing reuses
 *   NotesAgendaIcs.parseIcsFile, dedupe reuses the store's UID + RECURRENCE-ID merge.
 * - Automatic refresh only while the vault is open, at most every 30 minutes;
 *   stopAll() (called from NotesStore.lock) clears timers, aborts fetches, drops late results.
 * Feed content is rendered with textContent only.
 */
(function (global) {
  'use strict';

  const AUTO_REFRESH_MS = 30 * 60 * 1000;
  const TICK_MS = 5 * 60 * 1000;
  const MAX_URL = 2048;

  const ERROR_TEXT = {
    E_URL: 'This is not a valid https calendar link. Use a webcal:// or https:// link; http is not accepted.',
    E_NETWORK_OR_CORS: 'The calendar provider blocks fetching the feed directly from the browser (CORS), or the network failed. Fetching through Deeperguard is not available yet.',
    E_TIMEOUT: 'The calendar provider did not answer within 10 seconds.',
    E_TOO_LARGE: 'The feed is larger than 2 MB.',
    E_NOT_ICS: 'The link did not return a calendar (.ics) feed.',
    E_PARSE: 'The feed could not be read (too many events or invalid data).',
    E_UPSTREAM: 'The calendar provider returned an error.',
    E_BLOCKED: 'This address is not allowed.',
    E_REDIRECT: 'The feed redirected to an address that is not allowed.',
    E_RATE: 'Too many refreshes. Try again later.',
    E_AUTH: 'Sign in again to refresh.',
    E_SHRINK: 'Refresh skipped: it would remove most events of this calendar. Refresh by hand to confirm.',
    E_LOCKED: 'Unlock your vault to refresh.',
  };

  function codeError(code) {
    const err = new Error(ERROR_TEXT[code] || ERROR_TEXT.E_NETWORK_OR_CORS);
    err.code = code;
    return err;
  }

  /** webcal(s):// → https://; http and userinfo refused. Throws codeError('E_URL') (message has no URL). */
  function normalizeFeedUrl(raw) {
    let s = String(raw || '').trim();
    if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
    if (!s || s.length > MAX_URL || !/^https:\/\//i.test(s)) throw codeError('E_URL');
    let u;
    try {
      u = new URL(s);
    } catch (e) {
      throw codeError('E_URL');
    }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) throw codeError('E_URL');
    if (u.port && u.port !== '443') throw codeError('E_URL');
    return u.href;
  }

  function errorText(code) {
    return ERROR_TEXT[code] || ERROR_TEXT.E_NETWORK_OR_CORS;
  }

  let storeOverride = null;
  let fetcherOverride = null;
  let epoch = 0;
  let tickTimer = null;
  const inflight = new Map();
  const lastAttempt = new Map();
  const liveWorkers = new Set();
  let workerSeq = 0;

  function store() {
    return storeOverride || global.NotesStore || null;
  }

  function unlocked() {
    const S = store();
    return !!(S && typeof S.isUnlocked === 'function' && S.isUnlocked());
  }

  function workerUrl() {
    const meta = typeof document !== 'undefined'
      ? document.querySelector('meta[name="notes-ics-fetch-worker"]')
      : null;
    return (meta && meta.getAttribute('content')) || '/static/js/ics-fetch-worker.js';
  }

  /** Created per fetch, terminated when it answers or on stopAll(). */
  function workerFetch(url) {
    return new Promise((resolve) => {
      let w;
      try {
        w = new Worker(workerUrl());
      } catch (e) {
        resolve({ ok: false, code: 'E_NETWORK_OR_CORS' });
        return;
      }
      const id = ++workerSeq;
      const entry = { w, done: null };
      const done = (msg) => {
        if (!liveWorkers.has(entry)) return;
        liveWorkers.delete(entry);
        try { w.terminate(); } catch (e) { /* ignore */ }
        resolve(msg);
      };
      entry.done = done;
      liveWorkers.add(entry);
      w.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.id !== id) return;
        done(d.ok ? { ok: true, text: String(d.text || '') } : { ok: false, code: String(d.code || '') });
      };
      w.onerror = (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        done({ ok: false, code: 'E_NETWORK_OR_CORS' });
      };
      w.postMessage({ id, url });
    });
  }

  function fetchText(url) {
    return (fetcherOverride || workerFetch)(url);
  }

  /** Fetch result → parsed events via the existing .ics parser. Returns {ok, events} or {ok:false, code}. */
  function parseFeed(res) {
    if (!res || !res.ok) return { ok: false, code: (res && res.code) || 'E_NETWORK_OR_CORS' };
    const Ics = global.NotesAgendaIcs;
    const text = String(res.text || '');
    if (!Ics || Ics.looksBinary(text) || !/BEGIN:VCALENDAR/i.test(text)) return { ok: false, code: 'E_NOT_ICS' };
    try {
      const parsed = Ics.parseIcsFile(text);
      return { ok: true, events: parsed.events, warnings: parsed.warnings };
    } catch (e) {
      return { ok: false, code: 'E_PARSE' };
    }
  }

  /** Fetch + parse without saving (preview before subscribing). */
  async function previewUrl(url) {
    const myEpoch = epoch;
    const out = parseFeed(await fetchText(url));
    if (myEpoch !== epoch) return { ok: false, code: 'E_LOCKED' };
    return out;
  }

  /**
   * Refresh one subscription. opts.auto: automatic (shrink brake aborts with E_SHRINK);
   * opts.confirmShrink(n): manual refresh asks before removing most events.
   */
  function refresh(subId, opts = {}) {
    if (inflight.has(subId)) return inflight.get(subId);
    const run = (async () => {
      const S = store();
      if (!unlocked()) return { ok: false, code: 'E_LOCKED' };
      const sub = S.getAgendaSubscription(subId);
      if (!sub) return { ok: false, code: 'E_URL' };
      const myEpoch = epoch;
      lastAttempt.set(subId, Date.now());
      const out = parseFeed(await fetchText(sub.url));
      // Late response after lock (or a lock/unlock cycle): drop it.
      if (myEpoch !== epoch || !unlocked()) return { ok: false, code: 'E_LOCKED' };
      if (!out.ok) {
        S.updateAgendaSubscription(subId, { last_error_code: out.code });
        return { ok: false, code: out.code };
      }
      let res = S.refreshAgendaSubscriptionRows(subId, out.events, {});
      if (res && res.shrink) {
        const allow = !opts.auto && typeof opts.confirmShrink === 'function'
          && await opts.confirmShrink(res.removed);
        if (myEpoch !== epoch || !unlocked()) return { ok: false, code: 'E_LOCKED' };
        if (!allow) {
          S.updateAgendaSubscription(subId, { last_error_code: 'E_SHRINK' });
          return { ok: false, code: 'E_SHRINK' };
        }
        res = S.refreshAgendaSubscriptionRows(subId, out.events, { allowShrink: true });
      }
      if (!res || !res.content) return { ok: false, code: 'E_PARSE' };
      cancelReminders(res.removedEvents);
      return { ok: true, added: res.added, changed: res.changed, removed: res.removed, unchanged: res.unchanged };
    })().finally(() => inflight.delete(subId));
    inflight.set(subId, run);
    return run;
  }

  function cancelReminders(removed) {
    const R = global.NotesAgendaReminders;
    if (!R || typeof R.cancelEventReminders !== 'function') return;
    (removed || []).forEach(({ id, row }) => {
      Promise.resolve(R.cancelEventReminders(id, row)).catch(() => {});
    });
  }

  function isDue(sub, nowMs) {
    const last = Math.max(Date.parse(sub.last_refresh || '') || 0, lastAttempt.get(sub.id) || 0);
    return nowMs - last >= AUTO_REFRESH_MS;
  }

  /** One automatic pass: only with an open vault, only subscriptions not refreshed for 30 minutes. */
  async function tick(nowMs = Date.now()) {
    if (!unlocked()) return [];
    const S = store();
    const due = S.listAgendaSubscriptions().filter((s) => isDue(s, nowMs));
    const results = [];
    for (const sub of due) {
      if (!unlocked()) break;
      results.push(await refresh(sub.id, { auto: true }));
    }
    if (results.length && typeof onChange === 'function') onChange();
    return results;
  }

  let onChange = null;

  /** Start automatic refresh (Agenda shown, vault open). Safe to call repeatedly. */
  function start(changed) {
    if (changed) onChange = changed;
    if (!unlocked()) return;
    if (!tickTimer) {
      tickTimer = setInterval(() => {
        if (!unlocked()) {
          stopAll();
          return;
        }
        tick().catch(() => {});
      }, TICK_MS);
    }
    tick().catch(() => {});
  }

  /** On lock/logout: clear timers, abort fetches (terminate workers), drop late responses. */
  function stopAll() {
    epoch += 1;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    for (const entry of [...liveWorkers]) entry.done({ ok: false, code: 'E_LOCKED' });
    lastAttempt.clear();
  }

  /* ---------------- UI (inside the Agenda calendar settings panel) ---------------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function toast(msg, isErr) {
    if (typeof global.notesAgendaToast === 'function') global.notesAgendaToast(msg, !!isErr);
  }

  function statusText(sub) {
    if (sub.last_error_code) return `Error: ${errorText(sub.last_error_code)}`;
    if (sub.last_refresh) return `Last refreshed ${new Date(sub.last_refresh).toLocaleString()}`;
    return 'Not refreshed yet';
  }

  function rerenderAgenda() {
    if (global.NotesAgenda && typeof global.NotesAgenda.render === 'function') global.NotesAgenda.render();
  }

  function renderList() {
    const list = typeof document !== 'undefined' && document.getElementById('agenda-subscriptions-list');
    if (!list) return;
    list.textContent = '';
    if (!unlocked()) return;
    const S = store();
    const subs = S.listAgendaSubscriptions();
    if (!subs.length) {
      list.appendChild(el('p', 'settings-hint muted', 'No subscribed calendars.'));
      return;
    }
    subs.forEach((sub) => {
      const row = el('div', 'agenda-subscription-row');
      row.appendChild(el('strong', '', sub.name));
      const status = el('p', 'settings-hint' + (sub.last_error_code ? ' agenda-subscription-error' : ''), statusText(sub));
      if (sub.last_error_code) status.setAttribute('role', 'alert');
      row.appendChild(status);
      const actions = el('div', 'agenda-subscription-actions');
      const btn = (label, fn) => {
        const b = el('button', 'btn sm', label);
        b.type = 'button';
        b.addEventListener('click', fn);
        actions.appendChild(b);
        return b;
      };
      btn('Rename', () => {
        const next = global.prompt ? global.prompt('Calendar name', sub.name) : null;
        if (next && next.trim()) {
          S.updateAgendaSubscription(sub.id, { name: next });
          renderList();
        }
      });
      const refreshBtn = btn('Refresh', async () => {
        refreshBtn.disabled = true;
        const res = await refresh(sub.id, {
          confirmShrink: async (n) => !!(global.confirm && global.confirm(`This refresh removes ${n} events of "${sub.name}". Continue?`)),
        });
        refreshBtn.disabled = false;
        if (res.ok) toast(`Refreshed: ${res.added} new, ${res.changed} changed, ${res.removed} removed`);
        else toast(errorText(res.code), true);
        renderList();
        rerenderAgenda();
      });
      btn('Delete', () => {
        const ok = global.confirm && global.confirm(`Delete the subscription "${sub.name}" and all of its events?`);
        if (!ok) return;
        const res = S.removeAgendaSubscription(sub.id);
        cancelReminders(res.removedEvents);
        const n = res.removedEvents.length;
        toast(`Subscription deleted with ${n} event${n === 1 ? '' : 's'}`);
        renderList();
        rerenderAgenda();
      });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function wireUiOnce() {
    if (typeof document === 'undefined') return;
    const form = document.getElementById('agenda-subscribe-form');
    if (!form || form.dataset.wired) return;
    form.dataset.wired = '1';
    const urlInput = document.getElementById('agenda-subscribe-url');
    const nameInput = document.getElementById('agenda-subscribe-name');
    const preview = document.getElementById('agenda-subscribe-preview');
    const showError = (code) => {
      preview.textContent = '';
      const p = el('p', 'settings-hint agenda-subscription-error', errorText(code));
      p.setAttribute('role', 'alert');
      preview.appendChild(p);
      preview.hidden = false;
    };
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!unlocked()) {
        showError('E_LOCKED');
        return;
      }
      let url;
      try {
        url = normalizeFeedUrl(urlInput.value);
      } catch (err) {
        showError('E_URL');
        return;
      }
      preview.hidden = false;
      preview.textContent = 'Fetching preview…';
      const out = await previewUrl(url);
      if (!out.ok) {
        showError(out.code);
        return;
      }
      preview.textContent = '';
      preview.appendChild(el('p', 'agenda-import-counts', `${out.events.length} event${out.events.length === 1 ? '' : 's'} in this feed`));
      const ul = el('ul', 'agenda-subscribe-sample');
      out.events.slice(0, 5).forEach((e) => ul.appendChild(el('li', '', `${e.title || 'Untitled'} · ${e.start || ''}`)));
      preview.appendChild(ul);
      preview.appendChild(el('p', 'settings-hint muted', 'Events from a subscription are replaced at every refresh; local edits to them are lost.'));
      const ok = el('button', 'btn primary', 'Subscribe');
      ok.type = 'button';
      ok.addEventListener('click', () => {
        if (!unlocked()) {
          showError('E_LOCKED');
          return;
        }
        const S = store();
        const sub = S.addAgendaSubscription({ name: nameInput.value, url });
        S.refreshAgendaSubscriptionRows(sub.id, out.events, { allowShrink: true });
        urlInput.value = '';
        nameInput.value = '';
        preview.hidden = true;
        preview.textContent = '';
        toast(`Subscribed to ${sub.name}`);
        renderList();
        rerenderAgenda();
      });
      preview.appendChild(ok);
    });
  }

  /** Called when the Agenda is shown. */
  function onAgendaShown() {
    wireUiOnce();
    renderList();
    start(() => {
      renderList();
      rerenderAgenda();
    });
  }

  global.NotesAgendaSubs = {
    AUTO_REFRESH_MS,
    normalizeFeedUrl,
    errorText,
    previewUrl,
    refresh,
    tick,
    start,
    stopAll,
    onAgendaShown,
    renderList,
    _setStore(s) { storeOverride = s; },
    _setFetcher(f) { fetcherOverride = f; },
    _timerActive: () => !!tickTimer,
  };
}(typeof window !== 'undefined' ? window : globalThis));
