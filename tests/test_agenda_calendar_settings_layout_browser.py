"""Real-app Chromium test: the Calendar settings panel has one left edge and aligned subscription rows.

Starts the real Flask app, registers, adds three subscriptions (direct, via server, failing) and
measures the panel at 1280px and 390px: left edges, button sizes, section gaps, that every action
still works, and keyboard order/focus. Skips without Chromium.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402

PASSWORD = "CalPickerPass1!abc"
PANEL = "#agenda-calendar-settings"
SIZES = [(1280, 800), (390, 800)]

SEED = """() => {
  const S = NotesStore;
  S.addAgendaSubscription({ name: 'Tempo J1', url: 'https://example.invalid/a.ics' });
  const b = S.addAgendaSubscription({ name: 'KLM', url: 'https://example.invalid/b.ics' });
  S.updateAgendaSubscription(b.id, { mode: 'relay', relay_consent: true });
  const c = S.addAgendaSubscription({ name: 'A very long subscription name that keeps going and going', url: 'https://example.invalid/c.ics' });
  S.updateAgendaSubscription(c.id, { last_error_code: 'E_NETWORK_OR_CORS' });
}"""

MEASURE = """(sel) => {
  const root = document.querySelector(sel);
  const body = root.querySelector('.agenda-calendar-settings-body');
  const rect = (e) => e.getBoundingClientRect();
  const left = (e) => rect(e).left;
  const ids = '#agenda-calendars-heading, #agenda-subscriptions-heading, #agenda-subscribe-heading, #agenda-help-heading';
  const heads = [...root.querySelectorAll(ids)];
  const fields = [...root.querySelectorAll('#agenda-subscribe-form > label, #agenda-subscribe-form > input')];
  const rows = [...root.querySelectorAll('.agenda-subscription-row')];
  const sections = heads.map((h) => h.closest('section'));
  const gaps = sections.slice(1).map((s, i) => rect(s).top - rect(sections[i]).bottom);
  const rowInfo = rows.map((r) => {
    const btns = [...r.querySelectorAll('.agenda-subscription-actions .btn')];
    return {
      labels: btns.map((b) => b.textContent.trim()),
      heights: btns.map((b) => Math.round(rect(b).height * 10) / 10),
      tops: btns.map((b) => Math.round(rect(b).top)),
      overflow: r.scrollWidth > r.clientWidth + 1,
      right: rect(r).right,
      titleBottom: rect(r.querySelector('.agenda-subscription-head')).bottom,
      statusTop: rect(r.querySelector('.agenda-subscription-status')).top,
      statusBottom: rect(r.querySelector('.agenda-subscription-status')).bottom,
      actionsTop: rect(r.querySelector('.agenda-subscription-actions')).top,
    };
  });
  return {
    base: left(body) + parseFloat(getComputedStyle(body).paddingLeft),
    heads: heads.map(left), fields: fields.map(left), rows: rows.map(left), rowInfo,
    order: heads.map((h) => h.textContent), gaps,
    bodyRight: rect(body).right, noSideScroll: body.scrollWidth <= body.clientWidth + 1,
    sectionGap: parseFloat(getComputedStyle(body).rowGap),
  };
}"""

FOCUS = """(sel) => {
  const e = document.activeElement;
  if (!e || !e.closest(sel)) return null;
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
  const body = e.closest('.agenda-calendar-settings-body');
  return { id: e.id || e.textContent.trim().slice(0, 20), top: r.top + (body ? body.scrollTop : 0), ring };
}"""


@pytest.fixture(scope="module")
def ctx():
    data = Path(tempfile.mkdtemp(prefix="dg-cal-layout-"))
    port = free_port()
    proc = start_server(data, port)
    try:
        with sync_api.sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(f"http://127.0.0.1:{port}/register", wait_until="domcontentloaded")
            page.fill('input[name="email"]', "calayout@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            page.click("#app-tab-agenda")
            page.wait_for_selector("#agenda-add-event", timeout=30_000)
            page.evaluate(SEED)
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _open(page, width, height=800, theme="light"):
    page.set_viewport_size({"width": width, "height": height})
    page.evaluate("t => document.querySelector(`[data-theme-opt=\"${t}\"]`).click()", theme)  # the app's own theme switch
    page.wait_for_function("t => document.documentElement.dataset.theme === t", arg=theme)
    page.evaluate("() => NotesAgendaSubs.renderList()")
    if page.locator(f"{PANEL}:not([hidden])").count():
        return
    if not page.locator("#agenda-calendar-settings-btn:visible").count():
        page.evaluate("() => document.getElementById('agenda-phone-more').click()")
    page.locator("#agenda-calendar-settings-btn:visible").first.click()
    page.wait_for_selector(f"{PANEL}:not([hidden])")


def _close(page):
    page.click("#agenda-calendar-settings-close")
    page.wait_for_selector(f"{PANEL}", state="hidden")


@pytest.mark.parametrize("width,height", SIZES)
def test_one_left_edge_and_aligned_rows(ctx, width, height):
    page = ctx
    _open(page, width, height)
    m = page.evaluate(MEASURE, PANEL)
    assert m["order"] == ["Calendars", "Subscribed calendars", "Add a subscription", "Help"]
    assert len(m["rows"]) == 3 and len(m["fields"]) == 4
    for x in m["heads"] + m["fields"] + m["rows"]:
        assert abs(x - m["base"]) <= 1, (x, m["base"])
    assert m["noSideScroll"], "panel scrolls sideways"
    assert m["sectionGap"] >= 20
    for g in m["gaps"]:
        assert g >= m["sectionGap"] - 1, m["gaps"]
    all_heights = []
    for r in m["rowInfo"]:
        assert not r["overflow"] and r["right"] <= m["bodyRight"] + 1
        assert max(r["heights"]) - min(r["heights"]) <= 0.5, r
        all_heights += r["heights"]
        assert r["statusTop"] >= r["titleBottom"] - 1 and r["actionsTop"] >= r["statusBottom"] + 4, r
        if width >= 1280:
            assert len(set(r["tops"])) == 1, f"actions share one line at desktop width: {r}"
        else:
            assert len(set(r["tops"])) <= 2, r
    assert max(all_heights) - min(all_heights) <= 0.5
    assert [r["labels"][-1] for r in m["rowInfo"]] == ["Delete"] * 3
    _close(page)


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_row_text_contrast_both_themes(ctx, theme):
    page = ctx
    _open(page, 390, 800, theme)
    colors = page.evaluate("""() => {
      const q = (s) => getComputedStyle(document.querySelector(s));
      return { status: q('.agenda-subscription-status').color, bg: q('#agenda-calendar-settings').backgroundColor,
               del: q('.agenda-subscription-actions .btn.danger').color };
    }""")

    def rgb(c):
        nums = c[c.index("(") + 1:c.index(")")].replace("/", " ").replace(",", " ").split()
        return [float(v) for v in nums[:3]]

    def lum(c):
        ch = []
        for v in rgb(c):
            v /= 255
            ch.append(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]

    for fg in (colors["status"], colors["del"]):
        hi, lo = sorted([lum(fg), lum(colors["bg"])], reverse=True)
        assert (hi + 0.05) / (lo + 0.05) >= 4.5, (theme, colors)
    _close(page)
    page.evaluate("() => document.querySelector('[data-theme-opt=\"light\"]').click()")


def test_actions_still_work(ctx):
    page = ctx
    _open(page, 390)

    def row(name):
        return page.locator(".agenda-subscription-row", has=page.locator("strong", has_text=name))

    page.once("dialog", lambda d: d.accept("Tempo J1b"))
    row("Tempo J1").get_by_role("button", name="Rename").click()
    assert row("Tempo J1b").count() == 1

    row("Tempo J1b").get_by_role("button", name="Refresh").click()
    page.wait_for_selector(".agenda-subscription-row:has-text('Tempo J1b') [role=alert]", timeout=30_000)

    assert row("KLM").locator(".agenda-subscription-via").count() == 1
    row("KLM").get_by_role("button", name="Switch to direct").click()
    assert row("KLM").locator(".agenda-subscription-via").count() == 0

    row("A very long").get_by_role("button", name="Fetch via server…").click()
    page.get_by_role("button", name="No, keep direct").click()

    page.fill("#agenda-subscribe-url", "https://example.invalid/new.ics")
    page.click("#agenda-subscribe-form button[type=submit]")
    page.wait_for_selector("#agenda-subscribe-preview:not([hidden]) [role=alert]", timeout=30_000)

    page.once("dialog", lambda d: d.accept())
    row("KLM").get_by_role("button", name="Delete").click()
    assert row("KLM").count() == 0
    assert page.locator(".agenda-subscription-row").count() == 2
    _close(page)


@pytest.mark.parametrize("width,height", SIZES)
def test_keyboard_order_and_visible_focus(ctx, width, height):
    page = ctx
    _open(page, width, height)
    page.focus("#agenda-calendar-settings-close")
    seen = []
    for _ in range(80):
        page.keyboard.press("Tab")
        info = page.evaluate(FOCUS, PANEL)
        if info is None or info["id"] == "agenda-calendar-settings-close":
            break
        seen.append(info)
    assert len(seen) > 10
    assert all(i["ring"] for i in seen), [i for i in seen if not i["ring"]]
    for a, b in zip(seen, seen[1:]):
        # items on one visual line are centred differently, so allow a small upward step
        assert b["top"] >= a["top"] - 16, (a, b)
    ids = [i["id"] for i in seen]
    assert ids.index("Rename") < ids.index("agenda-subscribe-url") < ids.index("agenda-subscribe-name")
    _close(page)
