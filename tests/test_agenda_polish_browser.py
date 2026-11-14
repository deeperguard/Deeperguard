"""Agenda event dialog and subscription form: labels, hints and layout.

Static checks on app.html plus a Chromium render of the real editor markup with
the real app.css at 390px and 1280px, light and dark. Skips without Playwright.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_HTML = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
APP_CSS = ROOT / "app/static/css/app.css"


def _editor_markup() -> str:
    start = APP_HTML.index('<div id="agenda-editor" ')
    end = APP_HTML.index('<div id="hero-guide-backdrop"')
    return APP_HTML[start:end]


def test_editor_fields_have_labels_and_hints():
    html = _editor_markup()
    assert 'aria-describedby="agenda-edit-datetime-hint"' in html
    assert 'id="agenda-edit-datetime-hint"' in html
    assert 'aria-describedby="agenda-edit-webcall-hint"' in html
    assert 'id="agenda-edit-webcall-hint"' in html
    # every text-like control sits inside a <label>
    for m in re.finditer(r'<(input|select|textarea) id="(agenda-edit-[a-z-]+)"', html):
        before = html[: m.start()]
        assert before.rfind("<label") > before.rfind("</label>"), m.group(2)


def test_subscribe_form_labels_and_status():
    for fid in ("agenda-subscribe-url", "agenda-subscribe-name"):
        assert f'for="{fid}"' in APP_HTML
    tag = re.search(r'<div id="agenda-subscribe-preview"[^>]*>', APP_HTML).group(0)
    assert 'role="status"' in tag


sync_api = pytest.importorskip("playwright.sync_api")


@pytest.fixture(scope="module")
def browser():
    try:
        with sync_api.sync_playwright() as pw:
            try:
                b = pw.chromium.launch()
            except Exception as exc:
                pytest.skip(f"Chromium not available: {exc}")
            yield b
            b.close()
    except Exception as exc:
        if isinstance(exc, pytest.skip.Exception):
            raise
        pytest.skip(f"Playwright not usable: {exc}")


MEASURE = """() => {
  const ed = document.getElementById('agenda-editor');
  const over = [];
  ed.querySelectorAll('label, legend, p, button, input, select, h2').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > innerWidth + 1 || r.left < -1)) over.push(el.id || el.textContent.trim().slice(0, 30));
  });
  const btn = [...ed.querySelectorAll('.agenda-editor-actions .btn')].filter((b) => !b.hidden)
    .map((b) => b.getBoundingClientRect().height);
  return { over, minBtn: Math.min(...btn), hscroll: document.documentElement.scrollWidth > innerWidth };
}"""


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_editor_layout(browser, width, theme):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce")
    page = ctx.new_page()
    body = _editor_markup().replace(' hidden role="dialog"', ' role="dialog"', 1)
    page.set_content(f'<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"></head><body>{body}</body></html>')
    page.add_style_tag(path=str(APP_CSS))
    page.wait_for_timeout(300)
    res = page.evaluate(MEASURE)
    ctx.close()
    assert res["over"] == []
    assert res["minBtn"] >= 40
    assert not res["hscroll"]
