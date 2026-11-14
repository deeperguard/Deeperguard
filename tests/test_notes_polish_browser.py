"""Visual checks for the notes list, attachments/OCR rows and toast.

Renders markup produced by app.js (empty state, note row, attachment rows with
OCR progress and failure, undo toast) with the real app.css in Chromium at
390px and 1280px, light and dark: nothing overflows, the empty state has one
primary action, OCR progress/error are visible pills and the toast message
stays on one line. Skips when Playwright/Chromium is missing.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "app/static/js/app.js").read_text(encoding="utf-8")
APP_HTML = (ROOT / "app/templates/app.html").read_text(encoding="utf-8")
APP_CSS = ROOT / "app/static/css/app.css"


def _empty_actions_blocks() -> list[str]:
    src = APP_JS.split("function emptyListActionsHtml()", 1)[1].split("function updateTrashToolbar", 1)[0]
    return re.findall(r'<div class="note-list-empty-actions">(.*?)</div>', src, re.S)


def test_empty_state_has_one_primary_action():
    blocks = _empty_actions_blocks()
    assert blocks
    for block in blocks:
        assert block.count("btn primary") == 1, block
        assert block.count("<button") - 1 == block.count("btn ghost sm"), block


def test_toast_is_announced():
    tag = re.search(r'<div id="toast"[^>]*>', APP_HTML).group(0)
    assert 'role="status"' in tag and 'aria-live="polite"' in tag


def test_ocr_progress_text_marked():
    src = APP_JS.split("function attachmentOcrStatus(att)", 1)[1][:1600]
    assert src.count("ocr-text ocr-progress") >= 3
    assert "ocr-text ocr-failed" in src


sync_api = pytest.importorskip("playwright.sync_api")

EMPTY = _empty_actions_blocks()[2]
BODY = f"""
<div class="list-pane"><div id="note-list" class="note-list">
<div class="note-list-empty"><p class="note-list-empty-title">No notes here yet</p>
<p class="muted">Create a note or scan a document, or pull down to sync from your other devices.</p>
<div class="note-list-empty-actions">{EMPTY}</div></div>
<div class="note-row"><button type="button" class="note-row-delete" aria-label="Delete note A" title="Delete">×</button>
<button type="button" class="note-item"><span class="note-item-body"><span class="note-title-row"><h3>A fairly long note title that wraps on phones</h3>
<span class="note-row-trailing"><span class="note-modified">12:30</span></span></span><p class="note-preview">Preview text of the note body</p></span></button></div>
</div></div>
<div id="attachment-list" class="attachments">
<div class="attachment-item is-ocr-busy"><button type="button" class="attachment-thumb" aria-label="Preview scan.pdf"><span class="thumb-paint">PDF</span></button>
<div class="attachment-main"><strong class="attachment-filename">scan-2026-11-14-receipt-with-a-long-name.pdf</strong><span class="muted"> (1.2 MB)</span>
<p class="ocr-text ocr-progress" id="ocr-busy">Reading text on this device…</p></div>
<div class="attachment-item-actions"><details class="attachment-overflow"><summary class="btn ghost sm" aria-label="More file actions">⋯</summary></details>
<button type="button" class="btn ghost sm">Preview</button><button type="button" class="btn ghost sm">Download</button><button type="button" class="btn ghost sm" data-rm>Remove</button></div></div>
<div class="attachment-item"><button type="button" class="attachment-thumb" aria-label="Preview photo.jpg"><span class="thumb-paint">IMG</span></button>
<div class="attachment-main"><strong class="attachment-filename">photo.jpg</strong><span class="muted"> (300 KB)</span>
<p class="ocr-text ocr-failed" id="ocr-failed">Could not read text. Tap Retry OCR to try again.</p></div>
<div class="attachment-item-actions"><button type="button" class="btn ghost sm ocr-retry">Retry OCR</button><button type="button" class="btn ghost sm" data-rm>Remove</button></div></div>
</div>
<div id="toast" class="toast" role="status" aria-live="polite"><span id="toast-label">Moved to trash</span><button type="button" class="btn ghost sm toast-undo">Undo</button></div>
"""

MEASURE = """() => {
  const over = [];
  document.querySelectorAll('button, summary, h3, .ocr-text, .note-list-empty-title').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth + 1 || r.right > innerWidth + 1) over.push(el.textContent.trim().slice(0, 30));
  });
  const iconOnly = [...document.querySelectorAll('button, summary')]
    .filter((el) => !/[a-z]/i.test(el.textContent) && !el.getAttribute('aria-label')).length;
  const label = document.getElementById('toast-label');
  const lh = parseFloat(getComputedStyle(label).lineHeight);
  const bg = (id) => getComputedStyle(document.getElementById(id)).backgroundColor;
  return { over, iconOnly, toastLines: Math.round(label.getBoundingClientRect().height / lh),
           busyBg: bg('ocr-busy'), failedBg: bg('ocr-failed') };
}"""


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


@pytest.mark.parametrize("width", [390, 1280])
@pytest.mark.parametrize("theme", ["light", "dark"])
def test_notes_area_layout(browser, width, theme):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, reduced_motion="reduce")
    page = ctx.new_page()
    page.set_content(f'<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8"></head><body>{BODY}</body></html>')
    page.add_style_tag(path=str(APP_CSS))
    page.wait_for_timeout(300)
    res = page.evaluate(MEASURE)
    ctx.close()
    assert res["over"] == []
    assert res["iconOnly"] == 0
    assert res["toastLines"] == 1
    assert res["busyBg"] != "rgba(0, 0, 0, 0)"
    assert res["failedBg"] != "rgba(0, 0, 0, 0)"
