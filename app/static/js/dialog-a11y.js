/* Shared accessible-dialog behaviour (docs/UI_POLISH.md 4.3).
 *
 * Applies to every modal in the page: any element with role="dialog" or
 * role="alertdialog" plus aria-modal="true". A MutationObserver notices when
 * such an element (or an ancestor) is shown or hidden via the hidden or
 * aria-hidden attribute,
 * so the existing open/close code of each dialog keeps working unchanged:
 *   - remembers the element that opened the dialog and gives focus back to it
 *     when the dialog closes (unless the dialog's own close code already moved
 *     focus somewhere else);
 *   - moves focus into the dialog if its own code did not, never onto a
 *     destructive (.danger) button;
 *   - keeps Tab / Shift+Tab inside the top-most open dialog.
 * DialogA11y.confirm() is the shared confirmation flow used by app.js
 * confirmAction(): Escape, the close button and the backdrop always run the
 * cancel path (resolve false), never the confirm path, and are ignored while
 * the dialog reports a running action via aria-busy="true".
 */
(function (global) {
  'use strict';

  const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const openers = new WeakMap();
  let stack = [];
  let lastOutsideFocus = null;
  let observer = null;

  function doc() { return global.document; }

  // Cheap check (no layout): used on every observed mutation.
  function isOpen(el) {
    if (!el || !el.isConnected || el.hidden || el.closest('[hidden]')) return false;
    return el.getAttribute('aria-hidden') !== 'true';
  }

  function isShown(el) {
    return isOpen(el) && el.getClientRects().length > 0;
  }

  function insideAnyDialog(el) {
    return !!(el && el.closest && el.closest(DIALOG_SELECTOR));
  }

  function focusables(dialog) {
    return Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((el) => {
      if (el.closest('[inert]')) return false;
      return isShown(el);
    });
  }

  function isDestructive(el) {
    return !!(el && el.matches && el.matches('.danger, [data-destructive]'));
  }

  function isBusy(dialog) {
    if (!dialog) return false;
    if (dialog.getAttribute?.('aria-busy') === 'true') return true;
    return !!dialog.querySelector?.('[aria-busy="true"]');
  }

  function setBusy(dialog, busy) {
    if (!dialog) return;
    if (busy) dialog.setAttribute('aria-busy', 'true');
    else dialog.removeAttribute('aria-busy');
  }

  function topDialog() {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (isShown(stack[i])) return stack[i];
    }
    return null;
  }

  function focusInitial(dialog) {
    const active = doc().activeElement;
    if (active && dialog.contains(active) && !isDestructive(active)) return;
    const items = focusables(dialog);
    const preferred = items.find((el) => el.hasAttribute('autofocus'))
      || items.find((el) => el.matches('input, select, textarea') && !isDestructive(el))
      || items.find((el) => !isDestructive(el) && !el.matches('[data-dialog-close]'))
      || items.find((el) => !isDestructive(el));
    if (preferred) {
      preferred.focus();
      return;
    }
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    dialog.focus();
  }

  function onOpen(dialog) {
    const active = doc().activeElement;
    let opener = null;
    if (active && active !== doc().body && !dialog.contains(active)) opener = active;
    else if (lastOutsideFocus && !dialog.contains(lastOutsideFocus)) opener = lastOutsideFocus;
    openers.set(dialog, opener);
    stack = stack.filter((d) => d !== dialog);
    stack.push(dialog);
    // Run after the dialog's own open code (which often focuses in a 0ms timer).
    global.setTimeout(() => {
      if (isShown(dialog) && topDialog() === dialog) focusInitial(dialog);
    }, 0);
  }

  function onClose(dialog) {
    stack = stack.filter((d) => d !== dialog);
    const opener = openers.get(dialog);
    openers.delete(dialog);
    const active = doc().activeElement;
    const focusLost = !active || active === doc().body || dialog.contains(active);
    if (!focusLost) return;
    const below = topDialog();
    if (opener && isShown(opener) && (!below || below.contains(opener))) {
      opener.focus();
    } else if (below) {
      focusInitial(below);
    }
  }

  function sync() {
    const shown = new Set(Array.from(doc().querySelectorAll(DIALOG_SELECTOR)).filter(isOpen));
    stack.slice().forEach((d) => { if (!shown.has(d)) onClose(d); });
    shown.forEach((d) => { if (!stack.includes(d)) onOpen(d); });
  }

  function onKeydown(event) {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const dialog = topDialog();
    // Ignore modals hidden only by CSS (not rendered): never trap into them.
    if (!dialog || !isShown(dialog)) return;
    const items = focusables(dialog);
    if (!items.length) {
      event.preventDefault();
      focusInitial(dialog);
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc().activeElement;
    if (!dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onFocusIn(event) {
    const target = event.target;
    if (target && target !== doc().body && !insideAnyDialog(target)) lastOutsideFocus = target;
  }

  function init() {
    const d = doc();
    if (!d || observer || !global.MutationObserver || !d.documentElement) return;
    d.addEventListener('keydown', onKeydown, true);
    d.addEventListener('focusin', onFocusIn, true);
    observer = new global.MutationObserver(sync);
    observer.observe(d.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden'],
    });
    sync();
  }

  /* Shared confirm flow. Resolves true (confirm), false (cancel: cancel button,
   * close button, Escape, backdrop) or 'extra'. Returns null when the markup
   * is missing so the caller can fall back. */
  function confirm(message, {
    title = 'Confirm',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    extraLabel = '',
    danger = false,
  } = {}) {
    const d = doc();
    const backdrop = d.getElementById('confirm-backdrop');
    const dialog = d.getElementById('confirm-dialog');
    const titleEl = d.getElementById('confirm-title');
    const messageEl = d.getElementById('confirm-message');
    const okBtn = d.getElementById('confirm-ok');
    const cancelBtn = d.getElementById('confirm-cancel');
    const closeBtn = d.getElementById('confirm-close');
    const extraBtn = d.getElementById('confirm-extra');
    if (!backdrop || !dialog || !titleEl || !messageEl || !okBtn || !cancelBtn) return null;
    return new Promise((resolve) => {
      cancelBtn.hidden = false;
      if (extraBtn) {
        extraBtn.hidden = !extraLabel;
        extraBtn.textContent = extraLabel || 'Attach anyway';
      }
      titleEl.id = 'confirm-title';
      titleEl.textContent = title;
      titleEl.removeAttribute('aria-hidden');
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      dialog.setAttribute('aria-describedby', 'confirm-message');
      messageEl.textContent = message;
      okBtn.textContent = confirmLabel;
      cancelBtn.textContent = cancelLabel;
      okBtn.classList.toggle('danger', !!danger);
      setBusy(dialog, false);
      backdrop.hidden = false;
      dialog.hidden = false;
      const unlock = d.getElementById('unlock-screen');
      d.body.classList.add('confirm-open');
      d.body.classList.toggle('confirm-over-unlock', !!(unlock && !unlock.hidden));
      dialog.setAttribute('tabindex', '-1');
      let done = false;
      const cleanup = (value) => {
        if (done) return;
        done = true;
        backdrop.hidden = true;
        dialog.hidden = true;
        d.body.classList.remove('confirm-open', 'confirm-over-unlock');
        if (extraBtn) {
          extraBtn.hidden = true;
          extraBtn.removeEventListener('click', onExtra);
        }
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (closeBtn) closeBtn.removeEventListener('click', onDismiss);
        backdrop.removeEventListener('click', onDismiss);
        d.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onExtra = () => cleanup('extra');
      // Escape, close button and backdrop: cancel path only, never while busy.
      const onDismiss = () => { if (!isBusy(dialog)) onCancel(); };
      const onKey = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (closeBtn) closeBtn.addEventListener('click', onDismiss);
      if (extraBtn && extraLabel) extraBtn.addEventListener('click', onExtra);
      backdrop.addEventListener('click', onDismiss);
      d.addEventListener('keydown', onKey, true);
      global.setTimeout(() => {
        if (!dialog.hidden) cancelBtn.focus();
      }, 0);
    });
  }

  global.DialogA11y = { init, confirm, isBusy, setBusy, focusables, sync };
  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
