"""Real-app Chromium test: agenda selects/toggles look the same, the empty list
view shows its message, and saving and deleting an event give announced feedback.
Runs at 390px and 1280px in light and dark. Skips without Chromium."""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402

PASSWORD = "ControlsPass1!abc"

STYLE = """(sel) => [...document.querySelectorAll(sel)].map(el => {
  const c = getComputedStyle(el);
  return { id: el.id || el.name || el.className, h: c.height, bw: c.borderTopWidth,
           bs: c.borderTopStyle, br: c.borderTopLeftRadius, bc: c.borderTopColor };
})"""

FOCUS = """(sel) => [...document.querySelectorAll(sel)].map(el => {
  el.focus({ focusVisible: true });
  const c = getComputedStyle(el);
  return { id: el.id || el.name, ow: c.outlineWidth, os: c.outlineStyle, oc: c.outlineColor,
           active: document.activeElement === el };
})"""

# The colour the --focus-ring token resolves to, as the browser computes it.
FOCUS_TOKEN = """() => { const p = document.createElement('span');
  p.style.color = 'var(--focus-ring)'; document.body.appendChild(p);
  const c = getComputedStyle(p).color; p.remove(); return c; }"""


@pytest.fixture(scope="module")
def page():
    data = Path(tempfile.mkdtemp(prefix="dg-controls-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            pg = browser.new_page(viewport={"width": 1280, "height": 800})
            pg.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            pg.fill('input[name="email"]', "controls@e2e.invalid")
            pg.fill("#register-password", PASSWORD)
            pg.fill("#register-password2", PASSWORD)
            pg.check("#register-terms")
            pg.check("#register-recover-ack")
            pg.click("#register-submit")
            pg.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            pg.evaluate("() => NotesStore.markKeyVerified?.()")
            pg.click("#app-tab-agenda")
            pg.wait_for_selector("#agenda-root", timeout=30_000)
            yield pg
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _setup(pg, width, theme):
    pg.set_viewport_size({"width": width, "height": 800 if width > 500 else 844})
    pg.evaluate("(t) => { document.documentElement.dataset.theme = t; }", theme)


def _list_view(pg):
    btn = pg.locator('[data-agenda-view="agenda"]').locator("visible=true")
    if not btn.count():
        pg.click("#agenda-phone-more")
        pg.wait_for_timeout(200)
    btn.first.click()
    pg.wait_for_timeout(400)


def _add_event(pg):
    pg.locator("#agenda-add-event:visible, #agenda-fab-add:visible").first.click()
    pg.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_empty_list_save_delete_and_controls(page, width, theme):
    _setup(page, width, theme)
    _list_view(page)
    empty = page.locator(".agenda-list-empty")
    assert empty.is_visible()
    assert "add one" in empty.inner_text()
    st = page.evaluate("""() => { const e = document.querySelector('.agenda-list-empty'),
      c = getComputedStyle(e); return { ta: c.textAlign, w: e.getBoundingClientRect().width,
      vw: document.documentElement.clientWidth, bs: c.borderTopStyle }; }""")
    assert st["ta"] == "center" and st["bs"] == "dashed" and st["w"] <= st["vw"]

    # Editor: selects and the all-day toggle.
    _add_event(page)
    sel = page.evaluate(STYLE, "#agenda-editor select")
    assert len(sel) >= 2
    for s in sel:
        assert s["h"] == "44px" and s["bw"] == "1px" and s["bs"] == "solid", s
        assert s["br"] == sel[0]["br"] and s["bc"] == sel[0]["bc"]
    token = page.evaluate(FOCUS_TOKEN)
    for f in page.evaluate(FOCUS, "#agenda-editor select"):
        assert f["active"] and f["ow"] == "2px" and f["os"] == "solid", f
        assert f["oc"] == token, f
    chk = page.evaluate(STYLE, "#agenda-editor input[type=checkbox]")
    assert chk and all(c["h"] == "20px" and c["bw"] == chk[0]["bw"] for c in chk)

    page.fill("#agenda-edit-title", f"Feedback {width} {theme}")
    page.click("#agenda-edit-save")
    toast = page.locator("#toast")
    toast.wait_for(state="visible", timeout=5000)
    assert toast.get_attribute("role") == "status" and toast.get_attribute("aria-live") == "polite"
    assert toast.inner_text() == "Event saved"
    page.wait_for_selector("#agenda-root [data-agenda-id]", timeout=10_000)
    assert page.locator(".agenda-list-empty").count() == 0

    page.locator("#agenda-root [data-agenda-id]").first.click()
    page.wait_for_timeout(200)
    if page.locator("#agenda-detail-card:not([hidden])").count():
        page.click("#agenda-detail-edit")
    if page.locator("#agenda-scope-chooser:not([hidden])").count():
        page.click('[data-agenda-edit-scope="series"]')
    page.wait_for_selector("#agenda-editor:not([hidden])", timeout=10_000)
    page.click("#agenda-edit-delete")
    if page.locator("#confirm-ok:visible").count():
        page.click("#confirm-ok")
    page.wait_for_function(
        "() => /deleted/.test(document.getElementById('toast').textContent)", timeout=5000)
    assert page.locator("#toast").is_visible()
    page.wait_for_selector(".agenda-list-empty", timeout=5000)

    # Calendar settings: toggles share the same size and border.
    if not page.locator("#agenda-calendar-settings-btn:visible").count():
        page.click("#agenda-phone-more")
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector("#agenda-calendar-settings:not([hidden])")
    chk = page.evaluate(STYLE, "#agenda-calendar-settings input[type=checkbox]")
    assert len(chk) >= 3
    for c in chk:
        assert c["h"] == "20px" and c["bw"] == chk[0]["bw"] and c["bs"] == chk[0]["bs"], c
    token = page.evaluate(FOCUS_TOKEN)
    for f in page.evaluate(FOCUS, "#agenda-calendar-settings input[type=checkbox]"):
        if f["active"]:
            assert f["ow"] == "2px" and f["os"] == "solid", f
            assert f["oc"] == token, f
    page.click("#agenda-calendar-settings-close")
    page.wait_for_selector("#agenda-calendar-settings", state="hidden", timeout=5000)
