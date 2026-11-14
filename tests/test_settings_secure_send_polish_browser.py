"""Browser checks for the settings, signed-in devices and Secure Send polish.

Loads the real settings and Secure Send markup from app/templates/app.html,
the real app.css, dialog-a11y.js and confirmAction() into Chromium via
Playwright at 390px and 1280px in light and dark theme. Checks shared tokens,
no clipped text, the device sign-out confirm (focus on Cancel, Escape
cancels) and visible Secure Send feedback. Skips without Playwright/Chromium.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_HTML = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
APP_JS = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
APP_CSS = ROOT / "app/static/css/app.css"
DIALOG_JS = ROOT / "app/static/js/dialog-a11y.js"

sync_api = pytest.importorskip("playwright.sync_api")


def _between(text: str, start: str, end: str) -> str:
    i = text.index(start)
    return text[i:text.index(end, i)]


def _strip_jinja(markup: str) -> str:
    markup = re.sub(r"\{%.*?%\}", "", markup, flags=re.S)
    return re.sub(r"\{\{.*?\}\}", "", markup, flags=re.S)


PANELS = _strip_jinja(_between(APP_HTML, '<aside id="settings-panel"', '<div id="ai-chat-backdrop"'))
CONFIRM = _between(APP_HTML, '<div id="confirm-dialog"', '<div id="ai-outbound-backdrop"')
TOAST = '<div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true" hidden></div>'
CONFIRM_SRC = "function confirmAction(" + APP_JS.split("function confirmAction(", 1)[1].split(
    "NotesStore.setCsrf(", 1)[0]
SIGN_OUT_MSG = re.search(r"`(Sign out “\$\{item\.device[^`]*)`", APP_JS).group(1)

PAGE = """<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"></head>
<body><div id="confirm-backdrop" class="settings-backdrop" hidden></div>{panels}{confirm}{toast}</body></html>"""


@pytest.fixture(scope="module")
def browser():
    try:
        with sync_api.sync_playwright() as pw:
            try:
                b = pw.chromium.launch()
            except Exception as exc:  # Chromium not installed
                pytest.skip(f"Chromium not available: {exc}")
            yield b
            b.close()
    except Exception as exc:
        if isinstance(exc, pytest.skip.Exception):
            raise
        pytest.skip(f"Playwright not usable: {exc}")


def _open(browser, width, theme, panel):
    ctx = browser.new_context(viewport={"width": width, "height": 900})
    page = ctx.new_page()
    page.set_content(PAGE.format(theme=theme, panels=PANELS, confirm=CONFIRM, toast=TOAST))
    page.add_style_tag(path=str(APP_CSS))
    page.add_script_tag(path=str(DIALOG_JS))
    page.add_script_tag(content="window.confirmAction = " + CONFIRM_SRC.strip())
    page.evaluate("(id) => { document.getElementById(id).hidden = false; }", panel)
    return ctx, page


CLIPPED_JS = """(id) => {
  const panel = document.getElementById(id);
  const out = [];
  for (const el of panel.querySelectorAll('h2, h3, p, label, li, button, .device-row-name')) {
    if (!el.getClientRects().length || el.closest('.sr-only')) continue;
    const r = el.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(el.id || el.textContent.slice(0, 40));
    if (r.right > p.right + 1 || r.left < p.left - 1) out.push('outside:' + (el.id || el.textContent.slice(0, 40)));
  }
  return out;
}"""


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_settings_panel_tokens_and_no_clipping(browser, width, theme):
    ctx, page = _open(browser, width, theme, "settings-panel")
    try:
        page.evaluate("""() => {
          const list = document.getElementById('signed-in-devices');
          list.innerHTML = '<div class="device-row" role="listitem"><div class="device-row-head">'
            + '<span class="device-row-name">Chrome on a very long named Windows workstation in the office</span>'
            + '<span class="device-pending">New sign-in</span></div>'
            + '<p class="device-meta">Last active 2 minutes ago · 203.0.113.42 · Amsterdam, Netherlands</p>'
            + '<div class="device-row-actions"><button class="btn primary sm">Approve</button>'
            + '<button class="btn ghost sm">Deny</button></div></div>';
        }""")
        assert page.evaluate(CLIPPED_JS, "settings-panel") == []
        h3 = page.evaluate("""() => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--text)';
          document.body.append(probe);
          const s = getComputedStyle(document.querySelector('#settings-panel .settings-group > h3'));
          return [s.fontSize, s.color === getComputedStyle(probe).color];
        }""")
        assert h3 == ["13px", True]
        radius = page.evaluate("getComputedStyle(document.querySelector('#settings-panel .settings-card')).borderTopLeftRadius")
        assert radius == "12px"
        # Toggles share one right edge; selects are touch height.
        edges = page.evaluate("""() => [...document.querySelectorAll('#settings-panel .settings-card > .settings-row.checkbox > input')]
          .filter((el) => el.getClientRects().length).map((el) => Math.round(el.getBoundingClientRect().right))""")
        assert len(set(edges)) == 1, edges
        sel_h = page.evaluate("document.getElementById('pref-auto-lock').getBoundingClientRect().height")
        assert sel_h >= 44
    finally:
        ctx.close()


def test_password_change_fields_unchanged():
    block = _between(APP_HTML, '<div id="password-change"', 'id="btn-change-password"')
    assert '<input id="password-change-current" type="password" autocomplete="off" required aria-required="true" readonly>' in block
    assert '<input id="password-change-new" type="password" autocomplete="new-password">' in block
    assert '<input id="password-change-confirm" type="password" autocomplete="new-password">' in block


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_device_sign_out_confirm_focuses_cancel_and_escape_cancels(browser, width, theme):
    ctx, page = _open(browser, width, theme, "settings-panel")
    try:
        page.evaluate("""(msg) => {
          window.__result = 'pending';
          const text = msg.replace('${item.device || \\'this device\\'}', 'Laptop');
          confirmAction(text, { title: 'Sign out other device?', confirmLabel: 'Sign out',
            cancelLabel: 'Cancel', danger: true }).then((v) => { window.__result = v; });
        }""", SIGN_OUT_MSG)
        page.wait_for_function("document.activeElement && document.activeElement.id === 'confirm-cancel'")
        msg = page.inner_text("#confirm-message")
        assert "This device stays signed in." in msg
        assert page.evaluate(CLIPPED_JS, "confirm-dialog") == []
        page.keyboard.press("Escape")
        page.wait_for_function("window.__result !== 'pending'")
        assert page.evaluate("window.__result") is False
        page.wait_for_selector("#confirm-dialog", state="hidden")
    finally:
        ctx.close()


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_secure_send_steps_and_visible_feedback(browser, width, theme):
    ctx, page = _open(browser, width, theme, "secure-send-panel")
    try:
        steps = page.locator("#secure-send-panel .secure-send-steps li")
        assert steps.count() == 5
        assert "If you set a passphrase" in steps.nth(1).inner_text()
        assert "I understand that sharing by link weakens" in steps.nth(3).inner_text()
        # Same updates the create/copy handlers make in app.js.
        page.evaluate("""() => {
          const s = document.getElementById('secure-send-status');
          s.textContent = 'Link ready. Anyone with the full link can open it.';
          s.hidden = false;
          document.getElementById('secure-send-link-wrap').hidden = false;
          document.getElementById('secure-send-link').value = 'https://example.test/receive/abc#k=' + 'x'.repeat(80);
          const t = document.getElementById('toast');
          t.textContent = 'Link copied';
          t.hidden = false;
        }""")
        status = page.locator("#secure-send-status")
        assert status.is_visible()
        assert status.get_attribute("role") == "status"
        assert page.evaluate("getComputedStyle(document.getElementById('secure-send-status')).borderLeftWidth") == "4px"
        assert page.evaluate(CLIPPED_JS, "secure-send-panel") == []
        # The "Link copied" toast paints above the panel.
        on_top = page.evaluate("""() => {
          const r = document.getElementById('toast').getBoundingClientRect();
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!el && !!el.closest('#toast');
        }""")
        assert on_top
    finally:
        ctx.close()
