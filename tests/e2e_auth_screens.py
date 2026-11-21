"""E2E (Playwright, Chromium): sign-in, registration, recovery and unlock polish.

Runs the real Flask app and checks, at 390px and 1280px in light and dark:
- protected fields keep their id/name/type/autocomplete (docs/UI_POLISH.md 5);
- no aria-invalid until a field has an error, errors are linked with
  aria-describedby and readable (>= 4.5:1 against the card);
- nothing overflows or is clipped horizontally at 390px;
then the smoke flow, filling fields through their autocomplete tokens the way
browser autofill does: register, wrong password, lock + unlock, sign in again.

    python tests/e2e_auth_screens.py
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2e_signup_autounlock import PASSWORD, free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

WRONG = "definitely-not-the-password-1"

# selector -> expected (id, name, type, autocomplete); None = attribute absent.
PROTECTED = {
    "/login": {
        'form#login-form input[name="email"]': (None, "email", "email", "username"),
        "#login-password": ("login-password", None, "password", "current-password"),
        "#login-recovery-code": ("login-recovery-code", None, "text", "off"),
    },
    "/register": {
        "#register-email": ("register-email", "email", "email", "email"),
        "#register-password": ("register-password", None, "password", "new-password"),
        "#register-password2": ("register-password2", None, "password", "new-password"),
        "#register-terms": ("register-terms", "terms", "checkbox", None),
        "#register-recover-ack": ("register-recover-ack", "recover_ack", "checkbox", None),
        "#register-company": ("register-company", "company", "text", "off"),
    },
}

ATTRS_JS = """(sel) => { const el = document.querySelector(sel); if (!el) return null;
  return ['id','name','type','autocomplete'].map((a) => el.getAttribute(a)); }"""

# Horizontal overflow / clipping of anything visible inside the auth card.
OVERFLOW_JS = """() => {
  const bad = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) bad.push('page scrollWidth ' + doc.scrollWidth);
  const card = [...document.querySelectorAll('.auth-card')].find((c) => c.offsetParent !== null);
  if (!card) return ['no visible auth card'];
  const cr = card.getBoundingClientRect();
  if (cr.left < -1 || cr.right > doc.clientWidth + 1) bad.push('card outside viewport');
  for (const el of card.querySelectorAll('*')) {
    if (el.closest('.hp-field') || el.closest('[hidden]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > cr.right + 1 || r.left < cr.left - 1) bad.push('outside card: ' + el.outerHTML.slice(0, 80));
    if (['hidden', 'clip'].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 1
        && el.tagName !== 'INPUT') bad.push('clipped: ' + el.outerHTML.slice(0, 80));
  }
  return bad;
}"""

# Contrast of an element's text colour against the (opaque) card background.
CONTRAST_JS = """(id) => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return m.slice(0, 3); };
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const el = document.getElementById(id);
  const card = el.closest('.auth-card');
  const a = lum(parse(getComputedStyle(el).color));
  const b = lum(parse(getComputedStyle(card).backgroundColor));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}"""

DESCRIBED_JS = """(id) => { const el = document.getElementById(id);
  return { invalid: el.getAttribute('aria-invalid'),
           describedby: (el.getAttribute('aria-describedby') || '').split(/\\s+/) }; }"""


SETTLE_JS = """async () => { await document.fonts.ready;
  const finite = document.getAnimations().filter(
    (a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity);
  await Promise.race([
    Promise.all(finite.map((a) => a.finished.catch(() => null))),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]); }"""


def _settle(page):
    """Web fonts loaded and finite CSS animations/transitions finished (infinite spinners
    are ignored, and the wait is capped), so layout and colours are final."""
    page.evaluate(SETTLE_JS)


def _wait_attr_absent(page, sel, attr, timeout=5000):
    """Wait until the attribute is gone; return False if it never went away."""
    try:
        page.wait_for_function("([s, a]) => !document.querySelector(s).hasAttribute(a)",
                               arg=[sel, attr], timeout=timeout)
        return True
    except Exception:
        return False


# /register loads Cloudflare's Turnstile api.js. Fetched for real, the page "load"
# event, the widget's size and the moment its token appears depended on the network
# and on Cloudflare's challenge scripts, which made the run flaky on a busy build host.
# The stub renders a box of the real widget's normal size (300x65) and sets the token
# the way the widget does once its check passes.
TURNSTILE_SCRIPT = "challenges.cloudflare.com/turnstile/v0/api.js"
TURNSTILE_STUB_JS = """(function () {
  function fill(el) {
    if (!el.querySelector('.e2e-turnstile-box')) {
      const box = document.createElement('div');
      box.className = 'e2e-turnstile-box';
      box.style.cssText = 'width:300px;height:65px';
      el.appendChild(box);
    }
    let input = el.querySelector('input[name="cf-turnstile-response"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      el.appendChild(input);
    }
    input.value = 'e2e-stub-turnstile-token';
  }
  window.turnstile = {
    render: function (el) { fill(typeof el === 'string' ? document.querySelector(el) : el); return 'stub'; },
    reset: function () { document.querySelectorAll('.cf-turnstile').forEach(fill); },
    getResponse: function () { return 'e2e-stub-turnstile-token'; },
  };
  document.querySelectorAll('.cf-turnstile').forEach(fill);
})();"""


def _ctx(browser, base, width, theme):
    ctx = browser.new_context(viewport={"width": width, "height": 900})

    def route(r):
        # Only the test server is reached over the wire.
        url = r.request.url
        if url == base or url.startswith(base + "/"):
            r.continue_()
        elif TURNSTILE_SCRIPT in url:
            r.fulfill(status=200, content_type="text/javascript", body=TURNSTILE_STUB_JS)
        else:
            r.abort("failed")

    ctx.route("**/*", route)
    ctx.add_init_script(
        "try { localStorage.setItem('deeperguard-prefs', JSON.stringify({theme: '%s'})); } catch (e) {}"
        % theme)
    return ctx


def check_pages(browser, base, failures):
    for width in (390, 1280):
        for theme in ("light", "dark"):
            tag = f"{width}px/{theme}"
            ctx = _ctx(browser, base, width, theme)
            page = ctx.new_page()
            for path, fields in PROTECTED.items():
                page.goto(base + path, wait_until="load")
                _settle(page)
                assert page.evaluate("document.documentElement.dataset.theme") == theme, tag
                for sel, want in fields.items():
                    got = page.evaluate(ATTRS_JS, sel)
                    if got is None or tuple(got) != want:
                        failures.append(f"{tag} {path} {sel}: {got} != {want}")
                if page.evaluate("document.querySelectorAll('[aria-invalid]').length"):
                    failures.append(f"{tag} {path}: aria-invalid present before any error")
                bad = page.evaluate(OVERFLOW_JS)
                if bad:
                    failures.append(f"{tag} {path} overflow: {bad[:3]}")

            # Register: submit empty -> each field error is linked and readable.
            page.goto(base + "/register", wait_until="load")
            page.click("#register-submit")
            page.wait_for_selector("#register-email-error", state="visible")
            _settle(page)
            pairs = [("register-email", "register-email-error"),
                     ("register-password", "register-password-error"),
                     ("register-terms", "register-terms-error"),
                     ("register-recover-ack", "register-recover-error")]
            for field, err in pairs:
                info = page.evaluate(DESCRIBED_JS, field)
                if info["invalid"] != "true" or err not in info["describedby"]:
                    failures.append(f"{tag} {field}: {info}")
                if not page.is_visible("#" + err) or not page.inner_text("#" + err).strip():
                    failures.append(f"{tag} {err} not visible")
                ratio = page.evaluate(CONTRAST_JS, err)
                if ratio < 4.5:
                    failures.append(f"{tag} {err} contrast {ratio:.2f}")
            _settle(page)
            bad = page.evaluate(OVERFLOW_JS)
            if bad:
                failures.append(f"{tag} /register with errors overflow: {bad[:3]}")
            # Fixing a field removes aria-invalid instead of leaving "false".
            page.fill('input[autocomplete="email"]', "fixed@home.local")
            page.check("#register-terms")
            if not _wait_attr_absent(page, "#register-email", "aria-invalid"):
                failures.append(f"{tag} register-email keeps aria-invalid after fix")
            if not _wait_attr_absent(page, "#register-terms", "aria-invalid"):
                failures.append(f"{tag} register-terms keeps aria-invalid after fix")

            # Login: empty submit -> error linked to the email and password fields.
            page.goto(base + "/login", wait_until="load")
            page.click("#login-submit")
            page.wait_for_selector("#login-error:not([hidden])")
            _settle(page)
            for sel in ('input[name="email"]', "#login-password", "#login-recovery-code"):
                ids = (page.get_attribute(sel, "aria-describedby") or "").split()
                if "login-error" not in ids:
                    failures.append(f"{tag} {sel} not described by login-error")
            ratio = page.evaluate(CONTRAST_JS, "login-error")
            if ratio < 4.5:
                failures.append(f"{tag} login-error contrast {ratio:.2f}")
            if page.get_attribute("#login-status", "role") != "status":
                failures.append(f"{tag} login-status is not a status region")
            ctx.close()


def _wait_unlocked(page):
    page.wait_for_function(
        """() => location.pathname === '/app' && window.NotesStore && NotesStore.isUnlocked()
             && document.body.classList.contains('unlocked')""",
        timeout=120000)


def smoke(browser, base, failures, width, theme):
    tag = f"smoke {width}px/{theme}"
    ctx = _ctx(browser, base, width, theme)
    page = ctx.new_page()
    email = f"auth-polish-{width}-{theme}-{int(time.time())}@home.local"

    # 1. Register, filling by autocomplete token like autofill does.
    page.goto(base + "/register", wait_until="load")
    page.fill('#register-form input[autocomplete="email"]', email)
    for el in page.query_selector_all('#register-form input[autocomplete="new-password"]'):
        el.fill(PASSWORD)
    page.check("#register-terms")
    page.check("#register-recover-ack")
    page.evaluate("""() => {
      document.querySelectorAll('.cf-turnstile').forEach((el) => el.remove());
      let input = document.querySelector('input[name="cf-turnstile-response"]');
      if (!input) { input = document.createElement('input'); input.type = 'hidden';
        input.name = 'cf-turnstile-response'; document.getElementById('register-form').appendChild(input); }
      input.value = 'e2e-dummy-turnstile-token';
    }""")
    # Visible loading state while the key is derived: disabled + spinner. A
    # MutationObserver records the spinner the moment the button turns disabled,
    # so a fast derivation cannot slip between the click and the check.
    # The observation is kept in Python, not on window: a fast redirect to /app
    # replaces window and would otherwise drop it before the check runs.
    busy_spinners = []
    page.expose_function("reportBusySpinner", lambda spinner: busy_spinners.append(spinner))
    page.evaluate("""() => { const b = document.getElementById('register-submit');
      const snap = () => { if (b.disabled)
        window.reportBusySpinner(getComputedStyle(b, '::before').content); };
      new MutationObserver(snap).observe(b, { attributes: true });
      snap(); }""")
    page.click("#register-submit")
    page.wait_for_function("""() => location.pathname === '/app'
        || !!document.getElementById('register-submit')?.disabled""", timeout=120000)
    if not busy_spinners:
        failures.append(f"{tag} register busy state never observed")
    elif busy_spinners[0] in ("none", "normal"):
        failures.append(f"{tag} register busy button has no spinner")
    _wait_unlocked(page)
    complete_recovery_key_step(page)

    # 2. Lock, then a wrong vault password, then the right one.
    page.evaluate("""() => { const b = [...document.querySelectorAll('.vault-lock-btn')]
      .find((x) => x.offsetParent !== null); b.click(); }""")
    page.wait_for_selector("#unlock-screen", state="visible")
    _settle(page)
    if "unlock-error" not in (page.get_attribute("#unlock-password", "aria-describedby") or "").split():
        failures.append(f"{tag} unlock-password not described by unlock-error")
    bad = page.evaluate(OVERFLOW_JS)
    if bad:
        failures.append(f"{tag} unlock overflow: {bad[:3]}")
    page.fill('#unlock-form input[autocomplete="current-password"]', WRONG)
    page.click("#unlock-submit")
    page.wait_for_selector("#unlock-error:not([hidden])", timeout=120000)
    _settle(page)
    if not page.inner_text("#unlock-error").strip():
        failures.append(f"{tag} empty unlock error")
    ratio = page.evaluate(CONTRAST_JS, "unlock-error")
    if ratio < 4.5:
        failures.append(f"{tag} unlock-error contrast {ratio:.2f}")
    page.wait_for_function("document.getElementById('unlock-submit').textContent.trim() === 'Unlock'",
                           timeout=120000)
    page.fill('#unlock-form input[autocomplete="current-password"]', PASSWORD)
    page.click("#unlock-submit")
    _wait_unlocked(page)

    # 3. Sign in again in a fresh context: wrong password first, then the right one.
    ctx.close()
    ctx = _ctx(browser, base, width, theme)
    page = ctx.new_page()
    page.goto(base + "/login", wait_until="load")
    page.fill('#login-form input[autocomplete="username"]', email)
    page.fill('#login-form input[autocomplete="current-password"]', WRONG)
    page.click("#login-submit")
    page.wait_for_selector("#login-error:not([hidden])", timeout=120000)
    if "incorrect" not in page.inner_text("#login-error"):
        failures.append(f"{tag} wrong-password login error: {page.inner_text('#login-error')!r}")
    page.wait_for_function("!document.getElementById('login-submit').disabled", timeout=120000)
    page.fill('#login-form input[autocomplete="current-password"]', PASSWORD)
    page.click("#login-submit")
    _wait_unlocked(page)
    ctx.close()


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("skip: playwright not installed")
        return 0
    root = Path(tempfile.mkdtemp(prefix="e2e-auth-screens-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(root, port)
    failures: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            check_pages(browser, base, failures)
            smoke(browser, base, failures, 390, "dark")
            smoke(browser, base, failures, 1280, "light")
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)
    for f in failures:
        print("FAIL:", f)
    if failures:
        return 1
    print("e2e_auth_screens ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
