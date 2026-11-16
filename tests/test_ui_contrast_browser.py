"""WCAG AA contrast audit of every app screen in light and dark theme.

Renders the real templates (app, sign-in, registration, 2FA at sign-in and
receive) with Jinja, loads the real app.css into Chromium via Playwright at
390px and 1280px, reveals every `hidden` region (dialogs, panels, empty states,
error messages, toasts) and measures the contrast of every visible text node
and form control against its composited background. Normal text needs 4.5:1,
large text (>= 24px, or >= 18.66px bold) and
aria-hidden icon glyphs 3:1. Disabled controls are exempt
(WCAG 1.4.3). Also checks that the single toast element keeps one style and a
live-region role in its normal and error state.

Run as a script to print every failing element:
    python3 tests/test_ui_contrast_browser.py
Skips without Playwright/Chromium.
"""
from __future__ import annotations

import sys
from pathlib import Path

import jinja2
import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_CSS = ROOT / "app/static/css/app.css"
SCREENS = ["app.html", "login.html", "register.html", "totp.html", "receive.html"]
THEMES = ["light", "dark"]
APP_JS = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
# The real role switch of #toast, taken from app.js.
SET_TOAST_ROLE = "function setToastRole(" + APP_JS.split("function setToastRole(", 1)[1].split("\n  }\n", 1)[0] + "\n}"
# Button variants that app.js adds at runtime (not all are in the static markup).
BUTTON_VARIANTS = """<div id="contrast-button-variants">
<button class="btn">Plain</button><button class="btn primary">Primary</button>
<button class="btn secondary">Secondary</button><button class="btn ghost">Ghost</button>
<button class="btn subtle">Subtle</button><button class="btn danger">Danger</button>
<button class="btn primary danger">Delete note</button><button class="btn primary success">Done</button>
<button class="btn link">Link</button><button class="btn sm">Small</button></div>"""
WIDTHS = [390, 1280]


class _Lenient(jinja2.ChainableUndefined):
    def __call__(self, *args, **kwargs):
        return _Lenient()


def render(name: str) -> str:
    env = jinja2.Environment(loader=jinja2.FileSystemLoader(str(ROOT / "app/templates")), undefined=_Lenient)
    env.policies["json.dumps_kwargs"] = {"default": lambda _o: ""}
    html = env.get_template(name).render()
    # No network and no app scripts: only the markup and the real stylesheet.
    import re
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", html, flags=re.S | re.I)
    return re.sub(r"<link\b[^>]*>", "", html, flags=re.I)


AUDIT_JS = r"""(unlockedPass) => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
    let bg = [255, 255, 255, 1];
    let image = false;
    for (const n of chain) {
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { bg = over(c, bg); image = false; }
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName)) image = true;
    }
    return { bg, image };
  };
  const disabled = (el) => !!el.closest(':disabled, [aria-disabled="true"], .is-disabled');
  const out = [];
  const seen = new Set();
  const check = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (!el.getClientRects().length || disabled(el)) return;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') return;
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
    if (op === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const { bg, image } = bgOf(el);
    if (image) return;
    const fg = parse(cs.color);
    if (!fg) return;
    const col = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    // aria-hidden glyphs (chevrons, marks) are icons: 3:1 (WCAG 1.4.11).
    const need = large || el.closest('[aria-hidden="true"]') ? 3 : 4.5;
    const got = ratio(col, bg);
    if (got + 0.005 < need) {
      const name = el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      out.push({ el: name, text: (el.value || el.textContent || '').trim().slice(0, 40), ratio: Math.round(got * 100) / 100, need, fg: cs.color, bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')' });
    }
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.nodeValue.trim()) continue;
    const el = t.parentElement;
    if (!el || el.closest('script, style, template, noscript, svg, .sr-only, .visually-hidden')) continue;
    check(el);
  }
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]), select, textarea')) {
    if (el.closest('.sr-only, .hp-field')) continue;
    check(el);
  }
  return out;
}"""

REVEAL_JS = r"""(unlocked) => {
  // The inline gate in app.html hides #app and #unlock-screen until a session exists.
  document.documentElement.dataset.notesSession = '1';
  // app.js drops aria-hidden from the shown screen; icons keep theirs.
  for (const id of ['app', 'unlock-screen']) document.getElementById(id)?.removeAttribute('aria-hidden');
  for (const el of document.querySelectorAll('[hidden]')) el.hidden = false;
  if (unlocked) document.body.classList.remove('locked');
  const t = document.getElementById('toast');
  if (t) t.textContent = 'Note saved';
}"""

TOAST_JS = r"""(isError) => {
  const t = document.getElementById('toast');
  t.hidden = false;
  t.textContent = isError ? 'Could not save note' : 'Note saved';
  t.classList.toggle('error', isError);
  setToastRole(t, isError);
  const cs = getComputedStyle(t);
  const r = t.getBoundingClientRect();
  return { role: t.getAttribute('role'), live: t.getAttribute('aria-live'), position: cs.position,
           radius: cs.borderRadius, padding: cs.padding, font: cs.fontSize, bottom: innerHeight - r.bottom,
           centre: Math.round(r.left + r.width / 2), width: innerWidth };
}"""


def audit(page, name: str, theme: str) -> list[dict]:
    # Reduced motion: dialogs appear at full opacity without a fade.
    page.set_content(render(name).replace("<html", f'<html data-theme="{theme}"', 1))
    page.add_style_tag(path=str(APP_CSS))
    # app.js sets the theme on <html> and <body>; the auth pages only on <html>.
    if name == "app.html":
        page.evaluate("(t) => { document.body.dataset.theme = t; }", theme)
    if name == "app.html":
        page.evaluate("(h) => document.body.insertAdjacentHTML('beforeend', h)", BUTTON_VARIANTS)
    results = []
    passes = [False, True] if name == "app.html" else [False]
    for unlocked in passes:
        page.evaluate(REVEAL_JS, unlocked)
        results += page.evaluate(AUDIT_JS, unlocked)
        if name == "app.html":
            page.evaluate("() => document.getElementById('toast').classList.add('error')")
            results += page.evaluate(AUDIT_JS, unlocked)
    uniq = {(r["el"], r["text"], r["fg"], r["bg"]): r for r in results}
    return list(uniq.values())


def _launch(pw):
    return pw.chromium.launch()


@pytest.fixture(scope="module")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    try:
        with sync_api.sync_playwright() as pw:
            try:
                b = _launch(pw)
            except Exception as exc:  # Chromium not installed
                pytest.skip(f"Chromium not available: {exc}")
            yield b
            b.close()
    except Exception as exc:
        if isinstance(exc, pytest.skip.Exception):
            raise
        pytest.skip(f"Playwright not usable: {exc}")


@pytest.mark.parametrize("width", WIDTHS)
@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("name", SCREENS)
def test_text_and_buttons_meet_wcag_aa(browser, name, theme, width):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce")
    page = ctx.new_page()
    try:
        fails = audit(page, name, theme)
    finally:
        ctx.close()
    assert not fails, f"{len(fails)} contrast failures in {name} ({theme}, {width}px): {fails[:15]}"


@pytest.mark.parametrize("width", WIDTHS)
@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("tab", ["notes", "2fa"])
def test_toast_has_one_style_and_live_role(browser, theme, width, tab):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce")
    page = ctx.new_page()
    try:
        page.set_content(render("app.html").replace("<html", f'<html data-theme="{theme}"', 1))
        page.add_style_tag(path=str(APP_CSS))
        page.evaluate("(t) => { document.body.dataset.theme = t; document.body.classList.remove('locked'); }", theme)
        if tab == "2fa":
            page.evaluate("() => document.documentElement.classList.add('totp-toast-open')")
        page.add_script_tag(content=SET_TOAST_ROLE)
        ok = page.evaluate(TOAST_JS, False)
        err = page.evaluate(TOAST_JS, True)
    finally:
        ctx.close()
    assert (ok["role"], ok["live"]) == ("status", "polite")
    assert (err["role"], err["live"]) == ("alert", "assertive")
    for state in (ok, err):
        assert state["position"] == "fixed"
        assert abs(state["centre"] - width / 2) <= 1, state
    keys = ("position", "radius", "padding", "font", "bottom")
    assert {k: ok[k] for k in keys} == {k: err[k] for k in keys}
    # Same style on every tab: compare with the notes tab values.
    assert ok["radius"] == "12px" and ok["font"] == "15px", ok


FOCUS_JS = r"""(sel) => {
  const el = document.querySelector(sel);
  el.focus();
  const ring = el.closest('.search-wrap') || el;
  const cs = getComputedStyle(ring);
  return { focused: document.activeElement === el, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor };
}"""


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("sel", ["#search", "#unlock-password", "#password-change-new", "#totp-search"])
def test_text_fields_show_focus_ring(browser, theme, sel):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
    page = ctx.new_page()
    try:
        page.set_content(render("app.html").replace("<html", f'<html data-theme="{theme}"', 1))
        page.add_style_tag(path=str(APP_CSS))
        page.evaluate(REVEAL_JS, sel != "#unlock-password")
        page.evaluate("(t) => { document.body.dataset.theme = t; }", theme)
        ring = page.evaluate("() => getComputedStyle(document.body).getPropertyValue('--focus-ring').trim()")
        got = page.evaluate(FOCUS_JS, sel)
    finally:
        ctx.close()
    assert got["focused"], got
    assert got["style"] == "solid" and got["width"] >= 2, got
    hexes = tuple(int(ring[i:i + 2], 16) for i in (1, 3, 5))
    assert got["color"] == "rgb(%d, %d, %d)" % hexes, (got, ring)


if __name__ == "__main__":
    from playwright.sync_api import sync_playwright

    total = 0
    with sync_playwright() as pw:
        b = _launch(pw)
        for name in SCREENS:
            for theme in THEMES:
                for width in WIDTHS:
                    ctx = b.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce")
                    fails = audit(ctx.new_page(), name, theme)
                    ctx.close()
                    total += len(fails)
                    for f in fails:
                        print(f"{name} {theme} {width}: {f}")
        b.close()
    print(f"{total} failures")
    sys.exit(1 if total else 0)
