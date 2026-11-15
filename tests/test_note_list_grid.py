"""Note list rows on one grid (docs/UI_POLISH.md 7.3 / 7.4).

The real renderers from app.js (renderNoteRow, renderFileRow,
buildNoteListSectionsHtml, listTimeLabel) run in node via
tests/note_list_grid_harness.js with synthetic notes. Checks:
- no group header is emitted for a group without rows;
- list dates follow one notation: relative under 7 days, then one fixed
  locale date (no numeric dd/mm/yyyy);
- the lock / read-only state is a badge with an accessible name in the meta
  line (comfortable); compact density keeps hiding the meta line and keeps the
  small lock glyph;
- rows with a "…" menu carry their X action in that menu;
- in Chromium with the real app.css, titles of rows with and without a PDF
  badge/thumbnail start at the same x.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_CSS = ROOT / "app/static/css/app.css"
APP_HTML = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
APP_JS = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")

if not shutil.which("node"):
    pytest.skip("node is required to run the app.js row renderers", allow_module_level=True)

DATA = json.loads(subprocess.run(
    ["node", str(ROOT / "tests/note_list_grid_harness.js")],
    check=True, capture_output=True, text=True, timeout=60,
).stdout)
COMF = DATA["comfortable"]
COMPACT = DATA["compact"]


def test_no_header_for_empty_group():
    html = COMF["sections"]
    labels = re.findall(r'<h3 class="note-section-label">([^<]*)</h3>', html)
    assert labels == ["Today", "Older"]
    assert "Yesterday" not in html and "Files" not in html
    # Every rendered header is followed by a section with at least one row.
    for chunk in html.split('<h3 class="note-section-label">')[1:]:
        section = chunk.split('<div class="note-section"', 1)[1].split('<h3 class="note-section-label">', 1)[0]
        assert 'class="note-row' in section


def test_one_date_notation():
    labels = []
    for entry in COMF["dates"]:
        label, age = entry["label"], entry["ageSec"]
        labels.append(label)
        assert not re.search(r"\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}", label), label
        if age < 7 * 86400:
            assert re.fullmatch(r"just now|\d+m ago|\d+h ago|\d+d ago", label), label
        else:
            day = datetime.fromtimestamp(entry["ms"] / 1000, tz=timezone.utc).astimezone()
            # Fixed notation: day, short month name and full year.
            assert str(day.year) in label and re.search(r"[A-Za-z]{3}", label), label
            assert str(day.day) in label, label
    assert labels[4] == "2d ago"
    assert not any("ago" in lab for lab in labels[6:])


def test_lock_and_read_only_are_badges_in_meta_line():
    for key, name, text in (("locked", "Protected note", "Protected"), ("readonly", "Editing locked", "Read only")):
        row = COMF["rows"][key]
        meta = row.split('<span class="note-item-secondary">', 1)[1].split('<p class="note-preview', 1)[0]
        assert f'aria-label="{name}"' in meta and "note-lock-badge" in meta, key
        assert f'<span class="note-lock-text">{text}</span>' in meta
        # Type label comes first on the same meta line.
        assert meta.index("note-kind-label") < meta.index("note-lock-badge")
        trailing = re.search(r'<span class="note-row-trailing">(.*?)</span></span>', row, re.S).group(1)
        assert "note-glyph-lock" not in trailing, "no loose lock emoji next to the date"
    assert "note-item-lock-row" not in COMF["rows"]["locked"]


def test_type_and_tags_share_meta_line():
    row = COMF["rows"]["plain"]
    meta = row.split('<span class="note-item-secondary">', 1)[1]
    assert meta.index("note-kind-label") < meta.index("note-item-tags")
    assert ">PDF<" in COMF["rows"]["pdf"].split('<span class="note-item-secondary">', 1)[1]


def test_compact_density_unchanged():
    for key in ("locked", "readonly", "plain"):
        assert "note-item-secondary" not in COMPACT["rows"][key]
        assert "note-lock-badge" not in COMPACT["rows"][key]
    assert "note-glyph-lock" in COMPACT["rows"]["locked"]
    assert 'aria-label="Read only"' in COMPACT["rows"]["readonly"]


def test_x_action_reachable_from_row_menu():
    assert 'id="note-row-menu-trash"' in APP_HTML
    handler = APP_JS.split("getElementById('note-row-menu-trash')?.addEventListener('click'", 1)[1][:200]
    assert "deleteFromList(id)" in handler
    # Rows with a "…" menu mark their X as moved into the menu; rows without
    # the menu (locked) keep the visible X.
    plain = COMF["rows"]["plain"]
    assert "note-row-more" in plain and re.search(r'class="note-row-delete"[^>]*data-in-menu="1"', plain)
    locked = COMF["rows"]["locked"]
    assert "note-row-more" not in locked and "data-in-menu" not in locked
    assert ".note-row-delete[data-in-menu] { display: none !important; }" in APP_CSS.read_text(encoding="utf-8")


sync_api = pytest.importorskip(
    "playwright.sync_api", reason="Playwright not installed: title alignment check NOT run")


def _page_html() -> str:
    rows = COMF["rows"]
    body = "".join(rows[k] for k in ("plain", "pdf", "file", "locked", "readonly"))
    return (
        "<!doctype html><html data-theme='light'><head><meta charset='utf-8'>"
        f"<style>{APP_CSS.read_text(encoding='utf-8')}</style></head>"
        f"<body><div class='list-pane'><div id='note-list' class='note-list'>"
        f"<div class='note-section'>{body}</div></div></div></body></html>"
    )


@pytest.mark.parametrize("width", [390, 1280, 1920])
def test_titles_start_at_same_x(width):
    with sync_api.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:  # pragma: no cover - environment dependent
            pytest.skip(f"Chromium not available, title alignment check NOT run: {exc}")
        page = browser.new_page(viewport={"width": width, "height": 900})
        page.set_content(_page_html())
        xs = page.eval_on_selector_all(
            ".note-row .note-title-row h3",
            "els => els.map(e => [e.closest('.note-row').dataset.id, e.getBoundingClientRect().left])",
        )
        badge = page.eval_on_selector_all(".note-row .att-kind-badge", "els => els.length")
        browser.close()
    assert len(xs) == 5 and badge >= 1
    lefts = {round(x, 1) for _, x in xs}
    assert len(lefts) == 1, xs
