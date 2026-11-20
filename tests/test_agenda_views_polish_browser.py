"""Real-app Chromium test: agenda month/week/day/list views.

Seeds overlapping and long-titled events, renders each view at 390px and
1280px in light and dark theme and checks: event boxes in one column, in one
month cell and in one list day do not overlap, nothing overflows horizontally,
header cells line up with the grid columns, truncated titles keep a
title/aria-label and text keeps its contrast.
Skips without Chromium.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sync_api = pytest.importorskip("playwright.sync_api")
from run_agenda_editor_browser import free_port, start_server  # noqa: E402
from e2e_recovery_key_step import complete_recovery_key_step  # noqa: E402

PASSWORD = "ViewsPass1!abc"
UTILS = (Path(__file__).parent / "agenda_contrast_utils.js").read_text(encoding="utf-8")
UTILS = UTILS[: UTILS.index("if (typeof module")]
LONG = "Quarterly planning workshop with the extended international steering committee"

SEED = """async (long) => {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const at = (h, m) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
  const add = (title, s, e, extra) => NotesStore.upsertAgendaEvent(NotesStore.newUuid(),
    Object.assign({ title, start: s.toISOString(), end: e.toISOString(), all_day: false }, extra || {}));
  add('Overlap A', at(9, 0), at(11, 0));
  add('Overlap B', at(10, 0), at(12, 0));
  add('Overlap C', at(10, 30), at(11, 30));
  add(long, at(13, 0), at(14, 0));
  add('Short', at(15, 0), at(15, 20));
  add('All day long title that keeps going on and on', d, new Date(d.getTime() + 86400000), { all_day: true });
  await NotesStore.flush();
}"""

VIEW_BTN = {"month": "month", "week": "week", "day": "day", "list": "agenda"}

OVERFLOW = """() => {
  const root = document.getElementById('agenda-root');
  const vw = document.documentElement.clientWidth;
  const bad = [];
  if (document.documentElement.scrollWidth > vw + 1) bad.push('document scrolls horizontally');
  const rr = root.getBoundingClientRect();
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > rr.right + 1 || r.left < rr.left - 1 || r.right > vw + 1) {
      bad.push((el.className || el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    }
  }
  for (const el of root.querySelectorAll('.agenda-scroll-wrap, .agenda-body, .agenda-month-grid, .agenda-list-view')) {
    if (el.scrollWidth > el.clientWidth + 1) bad.push('scrollWidth ' + el.className);
  }
  return bad.slice(0, 8);
}"""

COLUMN_OVERLAP = """() => {
  const out = [];
  for (const col of document.querySelectorAll('.agenda-day-col')) {
    const chips = [...col.querySelectorAll('.agenda-event-chip')].filter(c => c.getBoundingClientRect().width);
    for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) {
      const a = chips[i].getBoundingClientRect(), b = chips[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) out.push(chips[i].textContent.trim().slice(0, 20) + ' x ' + chips[j].textContent.trim().slice(0, 20));
    }
  }
  return out;
}"""

GROUP_OVERLAP = """() => {
  const groups = [
    ...[...document.querySelectorAll('.agenda-month-cell')].map(c => [...c.querySelectorAll('.agenda-month-ev, .agenda-month-dot')]),
    ...[...document.querySelectorAll('.agenda-list-day')].map(d => [...d.querySelectorAll('.agenda-list-item')]),
  ];
  const out = [];
  let measured = 0;
  for (const group of groups) {
    const items = group.filter(el => el.getBoundingClientRect().width);
    measured += items.length;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) out.push(items[i].textContent.trim().slice(0, 20) + ' x ' + items[j].textContent.trim().slice(0, 20));
    }
  }
  return { overlaps: out, measured };
}"""

HEADER_ALIGN = """() => {
  const pairs = (heads, cols) => {
    if (!heads.length || heads.length !== cols.length) return ['count ' + heads.length + ' vs ' + cols.length];
    const bad = [];
    heads.forEach((h, i) => {
      const a = h.getBoundingClientRect(), b = cols[i].getBoundingClientRect();
      if (Math.abs(a.left - b.left) > 1.5 || Math.abs(a.width - b.width) > 1.5) {
        bad.push(i + ': head ' + a.left.toFixed(1) + '/' + a.width.toFixed(1) + ' col ' + b.left.toFixed(1) + '/' + b.width.toFixed(1));
      }
    });
    return bad;
  };
  if (document.querySelector('.agenda-month-grid')) {
    const heads = [...document.querySelectorAll('.agenda-month-dow')];
    const firstRow = document.querySelector('.agenda-month-row');
    return pairs(heads, [...firstRow.querySelectorAll('.agenda-month-cell')]);
  }
  const heads = [...document.querySelectorAll('.agenda-col-head-cell')];
  if (!heads.length) return [];
  return pairs(heads, [...document.querySelectorAll('.agenda-day-col')]);
}"""

TITLES = """() => [...document.querySelectorAll('#agenda-root [data-agenda-id]')].map(el => {
  const t = el.querySelector('.agenda-chip-title, .agenda-month-ev-title, .agenda-list-title') || el;
  const label = (el.getAttribute('title') || '') + (t.getAttribute('title') || '') + (el.getAttribute('aria-label') || '');
  return { text: t.textContent.trim(), truncated: t.scrollWidth > t.clientWidth + 1, label,
           visible: !!el.getBoundingClientRect().width };
}).filter(x => x.visible)"""

CONTRAST = "() => {" + UTILS + """
  const out = [];
  const sel = '.agenda-chip-title, .agenda-month-ev-title, .agenda-list-title, .agenda-month-dow, .agenda-col-head-cell';
  for (const el of document.querySelectorAll('#agenda-root ' + sel.split(', ').join(', #agenda-root '))) {
    if (!el.getBoundingClientRect().width) continue;
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parseCssColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
    }
    let base = layers.pop() || { r: 0, g: 0, b: 0, a: 1 };
    while (layers.length) base = compositeOver(layers.pop(), base);
    const fg = compositeOver(parseCssColor(getComputedStyle(el).color), base);
    out.push({ cls: String(el.className), ratio: contrastRatio(fg, base) });
  }
  return out;
}"""


MONTH_WEEKS = "() => {" + UTILS + """
  const rows = [...document.querySelectorAll('#agenda-root .agenda-month-row')];
  return rows.map(row => {
    const wk = row.querySelectorAll('.agenda-month-week');
    const cell = row.querySelector('.agenda-month-cell');
    const out = { count: wk.length, firstDay: Number(cell.dataset.agendaMonthDay) };
    if (!wk.length) return out;
    const el = wk[0], r = el.getBoundingClientRect(), c = cell.getBoundingClientRect();
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const bg = parseCssColor(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 0.999) break; }
    }
    let base = layers.pop() || { r: 0, g: 0, b: 0, a: 1 };
    while (layers.length) base = compositeOver(layers.pop(), base);
    const own = parseCssColor(getComputedStyle(el).backgroundColor);
    return Object.assign(out, {
      text: el.textContent.trim(), hidden: el.getAttribute('aria-hidden'), tag: el.tagName,
      width: r.width, leftOfCell: r.right <= c.left + 0.5, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
      boxed: !!(own && own.a > 0),
      ratio: contrastRatio(compositeOver(parseCssColor(getComputedStyle(el).color), base), base),
    });
  });
}"""


@pytest.fixture(scope="module")
def session():
    data = Path(tempfile.mkdtemp(prefix="dg-views-polish-"))
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
            page.fill('input[name="email"]', "views@e2e.invalid")
            page.fill("#register-password", PASSWORD)
            page.fill("#register-password2", PASSWORD)
            page.check("#register-terms")
            page.check("#register-recover-ack")
            page.click("#register-submit")
            page.wait_for_function(
                "() => typeof NotesStore !== 'undefined' && NotesStore.isUnlocked()", timeout=120_000)
            complete_recovery_key_step(page)
            page.evaluate("() => NotesStore.markKeyVerified?.()")
            page.evaluate(SEED, LONG)
            page.click("#app-tab-agenda")
            page.wait_for_selector("#agenda-root [data-agenda-id]", timeout=30_000)
            yield page
            browser.close()
    finally:
        proc.terminate()
        shutil.rmtree(data, ignore_errors=True)


def _show(page, view, width, theme):
    page.set_viewport_size({"width": width, "height": 800 if width > 500 else 844})
    # Crossing the 768px breakpoint re-renders the agenda; wait until the header shows the new layout.
    page.wait_for_function(
        "(phone) => { const b = document.getElementById('agenda-phone-more');"
        " return (!!b && b.getClientRects().length > 0) === phone; }",
        arg=width <= 768,
    )
    page.evaluate("(t) => { document.documentElement.dataset.theme = t; document.body.dataset.theme = t; }", theme)
    toggle = page.locator(f'[data-agenda-view="{VIEW_BTN[view]}"]').locator("visible=true")
    if not toggle.count():  # phone layout keeps the view switch inside the "⋯" menu
        page.click("#agenda-phone-more")
        page.wait_for_selector("#agenda-phone-menu", state="visible")
    toggle.first.click()
    page.wait_for_selector(f"#agenda-root .agenda-body.agenda-view-{VIEW_BTN[view]} [data-agenda-id]")
    assert page.locator("#agenda-root [data-agenda-id]").count() > 0, "events must render"


@pytest.mark.parametrize("view", ["month", "week", "day", "list"])
@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_view_layout(session, view, width, theme):
    page = session
    _show(page, view, width, theme)
    assert page.evaluate(OVERFLOW) == []
    assert page.evaluate(COLUMN_OVERLAP) == []
    grouped = page.evaluate(GROUP_OVERLAP)
    assert grouped["overlaps"] == []
    if view in ("month", "list"):
        assert grouped["measured"] > 0, f"no month-cell or list items measured in {view}"
    assert page.evaluate(HEADER_ALIGN) == []
    for t in page.evaluate(TITLES):
        if t["truncated"]:
            assert t["label"], f"truncated title without title/aria-label: {t['text']}"


@pytest.mark.parametrize("view", ["month", "week", "day", "list"])
@pytest.mark.parametrize("width", [390, 1280])
def test_dark_text_contrast(session, view, width):
    page = session
    _show(page, view, width, "dark")
    ratios = page.evaluate(CONTRAST)
    assert ratios, "no text measured"
    low = [r for r in ratios if r["ratio"] is not None and r["ratio"] < 4.5]
    assert low == []


@pytest.mark.parametrize("theme", ["light", "dark"])
@pytest.mark.parametrize("width", [390, 1280])
def test_month_week_numbers(session, width, theme):
    page = session
    _show(page, "month", width, theme)
    rows = page.evaluate(MONTH_WEEKS)
    assert len(rows) >= 4, "month grid rows must render"
    if width > 768:
        assert all(r["count"] == 0 for r in rows), "desktop month grid has no week column"
        return
    for r in rows:
        monday = datetime.fromtimestamp(r["firstDay"] / 1000)
        assert monday.weekday() == 0, "rows start on Monday"
        assert r["count"] == 1, "one week number per row"
        assert r["text"] == str(monday.isocalendar()[1]), f"row of {monday:%Y-%m-%d}: {r['text']}"
        assert r["tag"] == "SPAN" and r["hidden"] == "true", "week number is decorative, not a day button"
        assert r["width"] > 0 and r["leftOfCell"], "week number sits left of the row's first day"
        assert r["boxed"] and r["radius"] > 0, "week number is a rounded tinted box"
        assert r["ratio"] >= 4.5, f"week number contrast {r['ratio']:.2f} in {theme}"
