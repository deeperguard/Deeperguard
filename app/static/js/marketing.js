(function () {
  const navCheck = document.getElementById('mk-nav-check');
  const navToggle = document.querySelector('.mk-nav-toggle');

  function syncNavToggle() {
    if (navToggle && navCheck) navToggle.setAttribute('aria-expanded', navCheck.checked ? 'true' : 'false');
  }

  function closePublicNav({ restoreFocus = false } = {}) {
    if (!navCheck || !navCheck.checked) return false;
    navCheck.checked = false;
    syncNavToggle();
    if (restoreFocus && navToggle && typeof navToggle.focus === 'function') {
      try { navToggle.focus(); } catch (err) { /* ignore */ }
    }
    return true;
  }

  if (navToggle && navCheck) {
    navToggle.addEventListener('click', () => {
      navCheck.checked = !navCheck.checked;
      syncNavToggle();
    });
    navCheck.addEventListener('change', syncNavToggle);
    // The backdrop label can be confined to the header by backdrop-filter, so also close on any outside click.
    document.addEventListener('click', (event) => {
      if (!navCheck.checked) return;
      const t = event.target;
      if (t.closest && (t.closest('.mk-nav') || t.closest('.mk-nav-toggle') || t.closest('.mk-nav-backdrop'))) return;
      closePublicNav();
    });
  }

  // Collapse the desktop nav into the menu when its links do not fit on one line.
  const topbar = document.querySelector('.mk-topbar');
  const topbarInner = topbar && topbar.querySelector('.mk-topbar-inner');
  const navEl = topbar && topbar.querySelector('.mk-nav');
  const desktopNav = window.matchMedia ? window.matchMedia('(min-width: 768px)') : null;
  let lastNavWidth = -1;

  function measureNavFit() {
    if (!topbar || !topbarInner || !navEl) return;
    if (desktopNav && !desktopNav.matches) {
      topbar.classList.remove('nav-collapsed');
      return;
    }
    const wasCollapsed = topbar.classList.contains('nav-collapsed');
    // Measure the expanded single-line state synchronously, then apply the result before paint.
    topbar.classList.add('nav-measuring');
    topbar.classList.remove('nav-collapsed');
    const overflows = navEl.scrollWidth > navEl.clientWidth + 1
      || topbarInner.scrollWidth > topbarInner.clientWidth + 1;
    topbar.classList.remove('nav-measuring');
    topbar.classList.toggle('nav-collapsed', overflows);
    if (wasCollapsed && !overflows) closePublicNav();
  }

  if (topbar && topbarInner && navEl) {
    measureNavFit();
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver((entries) => {
        const width = Math.round(entries[entries.length - 1].contentRect.width);
        if (width === lastNavWidth) return;
        lastNavWidth = width;
        measureNavFit();
      }).observe(topbarInner);
    } else {
      window.addEventListener('resize', measureNavFit);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureNavFit);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (closePublicNav({ restoreFocus: true })) {
      event.preventDefault();
    }
  });

  function hashTarget() {
    const id = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    if (!id) return null;
    return document.getElementById(id);
  }

  function scrollHashIntoView() {
    const el = hashTarget();
    if (!el) return false;
    document.documentElement.classList.add('mk-hash-open');
    el.style.opacity = '1';
    el.style.visibility = 'visible';
    el.style.transform = 'none';
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    const top = el.getBoundingClientRect().top + window.scrollY - margin;
    const scroller = document.scrollingElement || document.documentElement;
    const next = Math.max(0, top);
    window.scrollTo(0, next);
    if (scroller && scroller !== document.documentElement) scroller.scrollTop = next;
    return true;
  }

  function settleHashScroll() {
    if (!location.hash) return;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    let lastTop = null;
    let stable = 0;
    let userMoved = false;
    const started = performance.now();
    function stopForUser() { userMoved = true; }
    window.addEventListener('wheel', stopForUser, { passive: true });
    window.addEventListener('touchstart', stopForUser, { passive: true });
    window.addEventListener('keydown', stopForUser);
    function tick() {
      if (userMoved) return;
      const el = hashTarget();
      scrollHashIntoView();
      const margin = el ? (parseFloat(getComputedStyle(el).scrollMarginTop) || 0) : 0;
      const top = el ? el.getBoundingClientRect().top : null;
      const aligned = top != null && Math.abs(top - margin) < 3;
      if (aligned && lastTop != null && Math.abs(top - lastTop) < 1) stable += 1;
      else stable = 0;
      lastTop = top;
      if (stable < 6 && performance.now() - started < 2500) requestAnimationFrame(tick);
    }
    tick();
    window.addEventListener('load', () => {
      if (userMoved) return;
      scrollHashIntoView();
      requestAnimationFrame(scrollHashIntoView);
    });
    window.addEventListener('pageshow', () => {
      if (!userMoved) scrollHashIntoView();
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!userMoved) scrollHashIntoView();
      });
    }
  }

  if (location.hash) {
    document.documentElement.classList.add('mk-hash-open');
    settleHashScroll();
  }

  const form = document.getElementById('contact-form');
  if (!form) return;
  const status = document.getElementById('contact-status');
  const submit = document.getElementById('contact-submit');

  function setStatus(message, isError) {
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('is-error', !!isError);
    status.classList.toggle('is-success', !!message && !isError);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('');
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') || '').trim(),
      email: String(data.get('email') || '').trim(),
      subject: String(data.get('subject') || '').trim(),
      message: String(data.get('message') || '').trim(),
      website: String(data.get('website') || '').trim(),
    };
    if (!payload.email) {
      setStatus('Please enter your email address.', true);
      return;
    }
    if (payload.message.length < 10) {
      setStatus('Please write at least 10 characters.', true);
      return;
    }
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Sending…';
    }
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(body.error || 'Could not send your message. Please try again.', true);
        return;
      }
      form.reset();
      setStatus('Thanks — your message was sent. We will reply by email.', false);
    } catch (err) {
      setStatus('Network error. Check your connection and try again.', true);
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Send message';
      }
    }
  });
})();
